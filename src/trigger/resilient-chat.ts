import { chat } from "@trigger.dev/sdk/ai";
import { streamText, generateText, stepCountIs, generateId, type ModelMessage } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";

/**
 * A chat.agent that can fall back from one LLM provider to another mid-conversation
 * WITHOUT losing history, and that persists compaction so the full transcript is not
 * re-sent on every turn.
 *
 * The division of labor:
 *
 * - Provider-native compaction (OpenAI Responses `store` + `previousResponseId`,
 *   Anthropic `contextManagement`) is a per-request, provider-specific optimization.
 *   OpenAI's stored responses persist server-side, so later turns send only the delta.
 *   Anthropic's context editing is stateless per request (see ./context-editing.ts),
 *   so on its own it does not stop you re-sending the messages across turns.
 * - trigger.dev's `compaction` config is the durable, provider-AGNOSTIC checkpoint:
 *   `summarize` returns a plain string and `compactModelMessages` returns neutral
 *   ModelMessages. That summary is stored in the chat history, so the next turn sends
 *   the summary instead of the raw transcript, and it survives a provider switch.
 * - The native handle is persisted TAGGED with the provider that produced it. On a
 *   switch it is a cache miss, so we fall back to the portable summary + recent
 *   messages instead of blowing the context back open.
 *
 * `COMPACT_AT_TOKENS` defaults to 80k for real use. Set it low (e.g. 100) to watch
 * compaction fire in a short demo conversation. See the README.
 */

type Provider = "anthropic" | "openai";

const MODELS = {
  anthropic: anthropic("claude-sonnet-4-5"),
  openai: openai("gpt-4o"),
} as const;

const FALLBACK_ORDER: Provider[] = ["anthropic", "openai"];
const COMPACT_AT_TOKENS = Number(process.env.COMPACT_AT_TOKENS) || 80_000;

/**
 * The provider-native handle we persist between turns. Only OpenAI's stored-response
 * id is a true client-side handle; Anthropic's context editing is applied server-side
 * per request and needs no handle.
 */
type NativeState = { provider: "openai"; previousResponseId: string };

/**
 * Demo persistence. The run stays alive across turns (idleTimeoutInSeconds), so an
 * in-memory Map is enough to see the behavior. Replace both with your database.
 */
const nativeStore = new Map<string, NativeState>();
const summaryStore = new Map<string, string>();

/**
 * Demo controls parsed from the latest user message so a plain text driver can steer
 * the example: `[[provider:openai]]` sets the preferred provider for the turn,
 * `[[fail:anthropic]]` simulates that provider being down so the fallback path runs.
 * Remove this in a real app.
 */
function parseDirectives(messages: ModelMessage[]): { provider?: Provider; fail?: Provider } {
  let text = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "user") {
      text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      break;
    }
  }
  const provider = /\[\[provider:(anthropic|openai)\]\]/.exec(text)?.[1] as Provider | undefined;
  const fail = /\[\[fail:(anthropic|openai)\]\]/.exec(text)?.[1] as Provider | undefined;
  return { provider, fail };
}

/**
 * When OpenAI already holds the thread under a `previousResponseId`, send only what is
 * new since the last assistant reply. Everything before that lives server-side.
 */
function messagesSinceLastAssistant(messages: ModelMessage[]): ModelMessage[] {
  let last = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === "assistant") last = i;
  }
  return last === -1 ? messages : messages.slice(last + 1);
}

/** Provider-agnostic summary. A plain string, portable across any provider. */
async function summarizeConversation(messages: ModelMessage[]): Promise<string> {
  console.log(`[resilient-chat] summarize() running over ${messages.length} messages (provider-agnostic)`);
  const { text } = await generateText({
    model: openai("gpt-4o-mini"),
    messages: [
      ...messages,
      {
        role: "user",
        content:
          "Summarize this conversation so it can continue with ANY model. " +
          "Preserve decisions made, facts established, open questions, and the user's intent.",
      },
    ],
  });
  return text;
}

export const resilientChat = chat.agent({
  id: "resilient-chat",
  idleTimeoutInSeconds: 120,

  uiMessageStreamOptions: {
    onError: (error) => {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("rate limit")) return "Rate limited. Please try again shortly.";
      return "The model had a problem generating a response. Please try again.";
    },
  },

  compaction: {
    shouldCompact: ({ totalTokens }) => {
      const decision = (totalTokens ?? 0) > COMPACT_AT_TOKENS;
      console.log(`[resilient-chat] shouldCompact totalTokens=${totalTokens ?? 0} threshold=${COMPACT_AT_TOKENS} -> ${decision}`);
      return decision;
    },
    summarize: ({ messages }) => summarizeConversation(messages),
    compactModelMessages: ({ modelMessages, summary }) => [
      { role: "user", content: `Summary of the conversation so far:\n\n${summary}` },
      ...modelMessages.slice(-2),
    ],
    compactUIMessages: ({ uiMessages, summary }) => [
      {
        id: generateId(),
        role: "assistant",
        parts: [{ type: "text", text: `[Conversation summary]\n\n${summary}` }],
      },
      ...uiMessages.slice(-2),
    ],
  },

  /**
   * A trigger.dev compaction is the reset point. Persist the portable summary and
   * invalidate the native handle: the provider's server-side thread no longer matches
   * the compacted baseline, so the next turn rebuilds from the summary.
   */
  onCompacted: async ({ chatId, summary }) => {
    if (!chatId) return;
    summaryStore.set(chatId, summary);
    nativeStore.delete(chatId);
    console.log(
      `[resilient-chat] onCompacted FIRED: summaryLen=${summary.length} nativeHandleInvalidated`
    );
  },

  run: async ({ messages, chatId, signal }) => {
    const { provider: directive, fail } = parseDirectives(messages);
    const preferred = directive ?? FALLBACK_ORDER[0];
    const order: Provider[] = [preferred, ...FALLBACK_ORDER.filter((p) => p !== preferred)];

    const saved = nativeStore.get(chatId);
    console.log(
      `[resilient-chat] run order=${order.join(">")} fail=${fail ?? "none"} hasNative=${saved?.provider ?? "none"} totalMessages=${messages.length}`
    );

    let lastError: unknown;
    for (const providerId of order) {
      const native = saved?.provider === providerId ? saved : undefined;

      try {
        if (fail === providerId) throw new Error(`simulated ${providerId} outage`);

        if (providerId === "openai") {
          const outbound = native ? messagesSinceLastAssistant(messages) : messages;
          console.log(
            `[resilient-chat] openai turn usedPreviousResponseId=${Boolean(native)} sent=${outbound.length}/${messages.length} messages`
          );

          const result = streamText({
            model: MODELS.openai,
            messages: outbound,
            abortSignal: signal,
            stopWhen: stepCountIs(5),
            providerOptions: {
              openai: native
                ? { store: true, previousResponseId: native.previousResponseId }
                : { store: true },
            },
          });

          void result.providerMetadata.then((meta) => {
            const rid = typeof meta?.openai?.responseId === "string" ? meta.openai.responseId : undefined;
            if (rid) {
              nativeStore.set(chatId, { provider: "openai", previousResponseId: rid });
              console.log(`[resilient-chat] stored openai responseId=${rid.slice(0, 16)}… for next turn`);
            }
          });

          return result;
        }

        console.log(`[resilient-chat] anthropic turn sent=${messages.length} messages`);
        return streamText({
          model: MODELS.anthropic,
          messages,
          abortSignal: signal,
          stopWhen: stepCountIs(5),
          providerOptions: {
            anthropic: {
              contextManagement: {
                edits: [
                  {
                    type: "clear_tool_uses_20250919",
                    trigger: { type: "input_tokens", value: COMPACT_AT_TOKENS },
                    keep: { type: "tool_uses", value: 3 },
                  },
                ],
              },
            },
          },
        });
      } catch (error) {
        lastError = error;
        console.log(
          `[resilient-chat] provider ${providerId} FAILED -> falling back: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    throw lastError;
  },
});
