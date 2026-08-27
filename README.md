# Resilient chat: provider fallback + persisted compaction

A [Trigger.dev](https://trigger.dev) `chat.agent` example that solves two problems you hit together in a production chat agent:

1. **Stop re-sending the whole chat history on every turn.** A provider can compact the context, but if that compacted state isn't persisted, the next turn sends the entire history again in its first API request.
2. **Fall back from one LLM provider to another mid-conversation without losing history.** A provider's native compaction reference is provider-specific and won't transfer on a switch.

Everything here is built on primitives that ship today: the `compaction` option on `chat.agent()`, and the AI SDK provider options for `@ai-sdk/openai` and `@ai-sdk/anthropic`.

## The idea

Provider-native compaction and provider fallback pull in opposite directions. The fix is a division of labor:

- **Provider-native compaction is a per-request, provider-specific optimization.**
  - OpenAI Responses (`store` + `previousResponseId`) persists the thread server-side, so later turns send only the new message.
  - Anthropic `contextManagement` (context editing) clears old tool-uses / compacts server-side, but it is stateless per request: it does not hand you a persisted compacted state, so on its own it does not stop you re-sending across turns.
- **trigger.dev `compaction` is the durable, provider-agnostic checkpoint.** `summarize` returns a plain string and `compactModelMessages` returns neutral `ModelMessage[]`. The summary is persisted into the chat history, so the next turn sends the summary instead of the raw transcript, and because it is provider-neutral it survives a provider switch.
- **Persist the native handle tagged with the provider that produced it.** On a switch the tag doesn't match, so you treat it as a cache miss and rebuild from the summary rather than the raw transcript. A trigger.dev compaction also invalidates the native handle.

Because the persisted baseline is a *summary*, even the one turn right after a switch sends something small, not the full raw history. Within a provider, the native mechanism avoids re-sending entirely.

## What is in here

```
src/trigger/resilient-chat.ts    the main agent: fallback + OpenAI native store + trigger.dev compaction
src/trigger/context-editing.ts   a focused agent showing Anthropic native context editing (clear_tool_uses)
driver.mjs                       a server-side driver that runs the four scenarios below
```

The main agent supports two demo directives, parsed from the user message, so a plain text driver can steer it: `[[provider:openai]]` / `[[provider:anthropic]]` picks the provider, `[[fail:anthropic]]` simulates that provider being down. Remove these in a real app.

`COMPACT_AT_TOKENS` defaults to 80k. Set it low (e.g. `100`) to watch compaction fire in a short demo.

## Setup

1. Create a project in the [Trigger.dev dashboard](https://cloud.trigger.dev) and copy its **project ref** (`proj_...`) and a **Development secret key** (`tr_dev_...`).
2. Install (Node 20 or 22; the CLI does not yet run on Node 24):

   ```bash
   npm install
   ```
3. Copy the environment file and fill it in (`TRIGGER_PROJECT_REF`, `TRIGGER_SECRET_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`):

   ```bash
   cp .env.example .env
   ```

## Run

Start the dev worker with a low compaction threshold so Test C fires in a short conversation:

```bash
COMPACT_AT_TOKENS=100 npx trigger dev
```

In another terminal:

```bash
node --env-file=.env driver.mjs
```

Expected output:

```
Test A — fallback preserves history
  turn1 (anthropic): "I've noted that your lucky number is 4287..."
  turn2 (anthropic forced-fail -> openai): "4287"                         PASS

Test B — OpenAI native store, history not resent
  turn1 (openai): "Got it! Your favorite animal is the axolotl."
  turn2 (openai): "Axolotl"                                                PASS

Test C — compaction fires + summary survives a provider switch
  turn1 (anthropic): states "launch date is March 14"
  turn2 (anthropic, long): triggers compaction
  turn3 (openai): "March 14"                                               PASS

Test D — Anthropic native context editing (see worker log)
  reply: "DONE"
```

## What to look for in the `trigger dev` logs

Each agent prints a short trace so you can see the mechanism, not just the answer:

```
A (fallback):    [resilient-chat] provider anthropic FAILED -> falling back: simulated anthropic outage
                 [resilient-chat] openai turn usedPreviousResponseId=false sent=3/3 messages

B (native store): turn 2 [resilient-chat] openai turn usedPreviousResponseId=true sent=1/3 messages

C (compaction):  [resilient-chat] shouldCompact totalTokens=373 threshold=100 -> true
                 [resilient-chat] summarize() running over 2 messages (provider-agnostic)
                 [resilient-chat] onCompacted FIRED: summaryLen=596 nativeHandleInvalidated
                 turn 3 [resilient-chat] run order=openai ... totalMessages=2   (summary + question, not the raw 3)

D (context editing): [context-editing] TURN DONE clearedToolUses=4 clearedInputTokens=2287
```

The two lines that answer the customer's question directly: `sent=1/3 messages` (B) means only the new message was sent, and `clearedToolUses=4` (D) means Anthropic cleared context server-side. Test C is the combined case: compaction fired, and OpenAI (a different provider than turn 1) answered "March 14" from a summary that saw 2 messages instead of the raw 3.

## Caveats and honest limits

- **Mid-stream failover needs a retry, not a `try/catch`.** The `try/catch` in `run()` only catches errors thrown synchronously when `streamText` is set up. A failure mid-stream goes through `uiMessageStreamOptions.onError` and ends the turn. To fail those over, have the frontend re-send the last message (`useChat`'s `regenerate()`), which re-enters `run()` and advances to the next provider. History is preserved either way.
- **Anthropic context editing is per-request and stateless.** It reduces what the model processes but does not persist a compacted state; to stop re-sending across turns you prune your stored messages using the `appliedEdits` counts, or use trigger.dev compaction.
- **No cross-provider compaction translation.** A native ref never transfers; the provider-agnostic summary is the portable baseline that makes a switch safe.
- **The stores here are in-memory.** `nativeStore` and `summaryStore` are `Map`s so the example runs with no database. Persist them in your own database for production.
- **Rate limits.** The driver runs the four scenarios back to back; on a shared or low-tier API key you may hit rate limits. The driver spaces the tests out, but if you see empty replies, run the scenarios one at a time or lower the volume.

## Adapting this to your app

- Replace the in-memory `Map` stores with your database, keyed by chat id.
- Remove the `[[...]]` demo directives and drive the provider choice from your own logic.
- On the frontend, wire the agent through `useTriggerChatTransport` from `@trigger.dev/sdk/chat/react`. See the [Trigger.dev AI chat docs](https://trigger.dev/docs/ai-chat).

## License

MIT. See [LICENSE](./LICENSE).
