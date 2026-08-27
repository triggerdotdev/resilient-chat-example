import { chat } from "@trigger.dev/sdk/ai";
import { streamText, stepCountIs, tool, type UIMessage } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";

/**
 * Using a provider's NATIVE compaction and persisting it across chat.agent turns.
 *
 * This is the case Henry asked about: a chat gets compacted by the provider, but if
 * that compaction isn't reflected in what you persist, the next turn re-sends the whole
 * history again.
 *
 * Anthropic's `contextManagement` (context editing) clears old tool-use/tool-result
 * blocks SERVER-SIDE, per request, and reports how many it cleared in
 * `providerMetadata.anthropic.contextManagement.appliedEdits` (`clearedToolUses`,
 * `clearedInputTokens`). It does not change what chat.agent has accumulated, so on its
 * own the next turn still re-sends everything.
 *
 * The fix, and the whole point of this file: after the turn, read the `appliedEdits`
 * counts and MIRROR the clearing into chat.agent's stored history with
 * `chat.history.set()`. The next turn is derived from that pruned history, so it
 * re-sends the smaller conversation. No custom summarizer involved — the provider's
 * native editing drives what gets persisted.
 *
 * Watch the `[native-persist]` lines in your `trigger dev` terminal:
 *
 *   run: incoming modelMessages=1 toolResultsResent=0            (turn 1: just the user message)
 *   anthropic cleared 4 tool-uses server-side this step          (native editing fired)
 *   PERSISTED native reduction: ... toolParts 6 -> 2             (mirrored into stored history)
 *   run: incoming modelMessages=5 toolResultsResent=1            (turn 2 re-sends the smaller history, not all 6)
 */

function bigRecord(id: number): string {
  return `RECORD ${id}: ` + "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(40) + `(end record ${id})`;
}

const fetchRecord = tool({
  description: "Fetch the full text of a record by its numeric id. Call once per id.",
  inputSchema: z.object({ id: z.number() }),
  execute: async ({ id }) => ({ id, text: bigRecord(id) }),
});

/** How many tool-uses Anthropic cleared this turn, per chat, captured in run() and applied in onTurnComplete. */
const clearedByChat = new Map<string, number>();

function isToolPart(p: { type?: string }): boolean {
  return typeof p?.type === "string" && (p.type.startsWith("tool-") || p.type === "dynamic-tool");
}

function countToolParts(messages: UIMessage[]): number {
  let n = 0;
  for (const m of messages) for (const p of m.parts ?? []) if (isToolPart(p)) n++;
  return n;
}

/** Drop the oldest `n` tool parts, mirroring what the provider cleared. Tool call + result live in one part, so pairing stays intact. */
function pruneOldestToolParts(messages: UIMessage[], n: number): UIMessage[] {
  let toRemove = n;
  const out: UIMessage[] = [];
  for (const m of messages) {
    if (toRemove <= 0 || m.role !== "assistant" || !m.parts) {
      out.push(m);
      continue;
    }
    const kept = m.parts.filter((p) => {
      if (toRemove > 0 && isToolPart(p)) {
        toRemove--;
        return false;
      }
      return true;
    });
    if (kept.length > 0) out.push({ ...m, parts: kept });
  }
  return out;
}

export const nativePersist = chat.agent({
  id: "native-persist",
  idleTimeoutInSeconds: 120,
  tools: { fetchRecord },
  run: async ({ messages, chatId, tools, signal }) => {
    const toolResultsResent = messages.filter((m) => m.role === "tool").length;
    console.log(`[native-persist] run: incoming modelMessages=${messages.length} toolResultsResent=${toolResultsResent}`);

    return streamText({
      model: anthropic("claude-sonnet-4-5"),
      messages,
      tools,
      abortSignal: signal,
      stopWhen: stepCountIs(12),
      providerOptions: {
        anthropic: {
          contextManagement: {
            edits: [
              {
                type: "clear_tool_uses_20250919",
                trigger: { type: "tool_uses", value: 2 },
                keep: { type: "tool_uses", value: 1 },
                clearToolInputs: true,
              },
            ],
          },
        },
      },
      onStepFinish: ({ providerMetadata }) => {
        const cm = providerMetadata?.anthropic?.contextManagement as
          | { appliedEdits?: Array<{ type?: string; clearedToolUses?: number }> }
          | undefined;
        let stepCleared = 0;
        for (const e of cm?.appliedEdits ?? []) {
          if (e.type === "clear_tool_uses_20250919") stepCleared += e.clearedToolUses ?? 0;
        }
        if (stepCleared > 0) {
          clearedByChat.set(chatId, (clearedByChat.get(chatId) ?? 0) + stepCleared);
          console.log(`[native-persist] anthropic cleared ${stepCleared} tool-uses server-side this step`);
        }
      },
    });
  },
  onTurnComplete: async ({ chatId, uiMessages }) => {
    const cleared = clearedByChat.get(chatId) ?? 0;
    if (cleared <= 0) return;
    const before = countToolParts(uiMessages);
    const pruned = pruneOldestToolParts(uiMessages, cleared);
    const after = countToolParts(pruned);
    chat.history.set(pruned);
    clearedByChat.set(chatId, 0);
    console.log(
      `[native-persist] PERSISTED native reduction: mirrored ${cleared} Anthropic-cleared tool-uses into stored history; toolParts ${before} -> ${after}. Next turn re-sends the smaller history.`
    );
  },
});
