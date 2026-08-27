# Resilient chat: provider fallback + persisted native compaction

A small [Trigger.dev](https://trigger.dev) `chat.agent` example that shows two things you often need together in a production chat agent:

1. **Fall back from one LLM provider to another mid-conversation without losing history.**
2. **Persist provider-native compaction** so a new turn does not re-send the entire chat history in its first API request.

Both are built on primitives that ship today: the `compaction` option on `chat.agent()` and the AI SDK's provider options (`@ai-sdk/openai`, `@ai-sdk/anthropic`).

## The idea

Provider-native compaction and provider fallback pull in opposite directions. A provider's native compaction reference is provider-specific: OpenAI's stored responses (`store` + `previousResponseId`) and Anthropic's context editing (`contextManagement`) do not transfer to each other. If you carry only that reference forward, a fallback to a different provider loses your context.

The fix is a division of labor:

- **Provider-native compaction is a per-request, provider-specific optimization.** It is what stops you re-sending the whole history *while you stay on one provider*. OpenAI's stored responses are the clearest case: once OpenAI holds the thread, later turns send only the new message.
- **Trigger.dev `compaction` is the durable, provider-agnostic checkpoint.** `summarize` returns a plain string and `compactModelMessages` returns neutral `ModelMessage[]`. That baseline is portable, so it survives a provider switch.
- **Persist the native handle tagged with the provider that produced it.** On a switch the tag does not match, so you treat it as a cache miss and rebuild from the portable summary plus recent messages, rather than re-sending the raw transcript.

A trigger.dev compaction also invalidates the native handle: once the conversation has a new compacted baseline, the provider's server-side thread no longer matches, so the next turn rebuilds from the summary.

## What is in here

```
src/trigger/resilient-chat.ts   the chat.agent (fallback + native compaction + trigger.dev compaction)
driver.mjs                      a server-side driver that runs two scripted conversations
trigger.config.ts               project ref + task dir
.env.example                    the environment variables you need
```

The agent supports two demo directives, parsed from the user message, so a plain text driver can steer the example:

- `[[provider:openai]]` / `[[provider:anthropic]]` picks the preferred provider for the turn.
- `[[fail:anthropic]]` / `[[fail:openai]]` simulates that provider being down so the fallback path runs.

Remove those in a real app.

## Setup

1. Create a project in the [Trigger.dev dashboard](https://cloud.trigger.dev) and copy its **project ref** (`proj_...`) and a **Development secret key** (`tr_dev_...`).
2. Install dependencies (Node 20 or 22; the CLI does not yet run on Node 24):

   ```bash
   npm install
   ```
3. Copy the environment file and fill it in:

   ```bash
   cp .env.example .env
   ```

   Set `TRIGGER_PROJECT_REF`, `TRIGGER_SECRET_KEY`, `ANTHROPIC_API_KEY`, and `OPENAI_API_KEY`. `TRIGGER_API_URL` only needs setting for a self-hosted instance.

## Run

In one terminal, start the dev worker (registers the agent and runs it locally so you can read the logs):

```bash
npx trigger dev
```

In another terminal, run the driver:

```bash
node --env-file=.env driver.mjs
```

Expected output:

```
===== Test A: provider fallback preserves history =====
A turn1 (anthropic): "I've noted that your lucky number is 4287..."
A turn2 (anthropic forced-fail -> openai): "4287"
A RESULT: PASS (history survived the provider switch)

===== Test B: OpenAI native store — history not resent =====
B turn1 (openai, first): "Got it! Your favorite animal is the axolotl."
B turn2 (openai, reuses previousResponseId + sends delta only): "Axolotl"
B RESULT: PASS (recalled via OpenAI server-side state)
```

## What to look for in the `trigger dev` logs

The agent prints a short trace of each decision:

```
Test A (fallback):
  [resilient-chat] run order=anthropic>openai fail=anthropic totalMessages=3
  [resilient-chat] provider anthropic FAILED -> falling back: simulated anthropic outage
  [resilient-chat] openai turn usedPreviousResponseId=false sent=3/3 messages

Test B (native store persisted):
  turn 1: [resilient-chat] openai turn usedPreviousResponseId=false sent=1/1 messages -> stored responseId
  turn 2: [resilient-chat] openai turn usedPreviousResponseId=true sent=1/3 messages
```

`sent=1/3` on turn 2 is the point: only the new message was sent, and OpenAI supplied the rest from its stored response. The full transcript was not re-sent.

## Caveats and honest limits

- **Mid-stream failover needs a retry, not a `try/catch`.** The `try/catch` in `run()` only catches errors thrown synchronously when `streamText` is set up. A failure that happens *mid-stream* goes through `uiMessageStreamOptions.onError` and ends the turn. To fail those over to another provider, have the frontend re-send the last message (`useChat`'s `regenerate()`), which re-enters `run()` and advances to the next provider. History is preserved either way because it is persisted provider-neutrally.
- **The two providers are not symmetric.** OpenAI's stored responses genuinely stop you re-sending history (you send only the delta). Anthropic's context editing clears and compacts server-side but you still send the messages; pair it with prompt caching to avoid recomputing the prefix.
- **There is no cross-provider compaction translation.** A provider's native compacted context cannot be handed to a different provider. The portable summary is the baseline that makes a switch safe; the native handle is only ever an optimization on top of it.
- **The stores here are in-memory.** `nativeStore` and `summaryStore` are `Map`s so the example runs with no database. The run stays alive across turns, so that is enough to see the behavior. Persist them in your own database for production.

## Adapting this to your app

- Replace the in-memory `Map` stores with your database, keyed by chat id.
- Remove the `[[...]]` demo directives and drive the provider choice from your own logic (per-user setting, cost policy, health checks).
- On the frontend, wire the agent through `useTriggerChatTransport` from `@trigger.dev/sdk/chat/react` instead of the server-side driver. See the [Trigger.dev AI chat docs](https://trigger.dev/docs/ai-chat).

## License

MIT. See [LICENSE](./LICENSE).
