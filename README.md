# Resilient chat: persist provider-native compaction (and fall back without losing history)

A [Trigger.dev](https://trigger.dev) `chat.agent` example. The main thing it shows is how to **use a provider's native compaction and persist it across turns**, so a new turn doesn't re-send the entire chat history in its first API request. It also handles **provider fallback without losing history**.

Everything here is built on primitives that ship today: the `compaction` option on `chat.agent()`, `chat.history.set()`, and the AI SDK provider options for `@ai-sdk/openai` and `@ai-sdk/anthropic`.

## The core problem: the provider compacts, but the state isn't persisted

A provider can compact the context within a request (Anthropic clears old tool-uses / compacts; OpenAI stores the thread). But if that compaction isn't reflected in what `chat.agent` persists, the **next turn re-sends the whole history again** in its first API request. That is the thing to fix.

**Anthropic native context editing, persisted (`src/trigger/native-persist.ts`).** Anthropic's `contextManagement` clears old tool-use / tool-result blocks server-side, per request, and reports how many it cleared in `providerMetadata.anthropic.contextManagement.appliedEdits` (`clearedToolUses`, `clearedInputTokens`). On its own it's stateless per request, so `chat.agent` still re-sends everything next turn. The fix, and the point of this file: after the turn, read the `appliedEdits` counts and **mirror the clearing into `chat.agent`'s stored history with `chat.history.set()`** in `onTurnComplete`. The next turn is derived from that pruned history, so it re-sends the smaller conversation. No custom summarizer.

```
[native-persist] run: incoming modelMessages=1 toolResultsResent=0       turn 1: just the user message
[native-persist] anthropic cleared 4 tool-uses server-side this step     native editing fired
[native-persist] PERSISTED native reduction: ... toolParts 6 -> 2        mirrored into stored history
[native-persist] run: incoming modelMessages=5 toolResultsResent=1       turn 2 re-sends 1, not 6
```

**OpenAI native store (`src/trigger/resilient-chat.ts`).** OpenAI Responses (`store` + `previousResponseId`) persists the thread server-side, so the same idea is even simpler: once OpenAI holds the thread, later turns send only the new message. Verified: turn 2 sends `1/3 messages`.

## Also handled: falling back across providers without losing history

A provider's native compaction reference is provider-specific and won't transfer on a switch. So across a fallback you rely on a **provider-agnostic baseline**: trigger.dev `compaction`'s `summarize` returns a plain string and `compactModelMessages` returns neutral `ModelMessage[]`, persisted into the chat history. That summary survives a switch. You persist the native handle **tagged with its provider**; on a switch it's a cache miss and you rebuild from the summary rather than the raw transcript. A trigger.dev compaction also invalidates the native handle.

Because the persisted baseline is a *summary*, even the one turn right after a switch sends something small, not the full raw history.

## What is in here

```
src/trigger/native-persist.ts    Anthropic native context editing, persisted into chat.agent history
src/trigger/resilient-chat.ts    provider fallback + OpenAI native store + trigger.dev compaction
driver.mjs                       a server-side driver that runs the four scenarios below
```

`resilient-chat` supports two demo directives, parsed from the user message, so a plain text driver can steer it: `[[provider:openai]]` / `[[provider:anthropic]]` picks the provider, `[[fail:anthropic]]` simulates that provider being down. Remove these in a real app. `COMPACT_AT_TOKENS` defaults to 80k; set it low (e.g. `100`) to watch trigger.dev compaction fire in a short demo.

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

Start the dev worker with a low compaction threshold so scenario 4 fires in a short conversation:

```bash
COMPACT_AT_TOKENS=100 npx trigger dev
```

In another terminal:

```bash
node --env-file=.env driver.mjs
```

Expected output:

```
1. Anthropic native compaction, persisted across turns   (see worker log)
   turn1: "DONE"          (6 tool calls; Anthropic clears the old ones server-side)
   turn2: a short recap   (chat.agent re-sends the pruned history, not all 6 tool results)

2. OpenAI native store, history not resent
   turn1: "Got it! Your favorite animal is the axolotl."
   turn2: "Axolotl"                                       PASS

3. Provider fallback preserves history
   turn1 (anthropic): "I've noted that your lucky number is 4287..."
   turn2 (anthropic forced-fail -> openai): "4287"        PASS

4. trigger.dev compaction fires + summary survives a switch
   turn3 (openai): "March 14"                             PASS
```

## What to look for in the `trigger dev` logs

Each agent prints a short trace so you can see the mechanism, not just the answer:

```
1. Anthropic native compaction persisted:
   [native-persist] anthropic cleared 4 tool-uses server-side this step
   [native-persist] PERSISTED native reduction: ... toolParts 6 -> 2
   turn 2 [native-persist] run: incoming ... toolResultsResent=1        (not 6)

2. OpenAI native store:
   turn 2 [resilient-chat] openai turn usedPreviousResponseId=true sent=1/3 messages

3. Provider fallback:
   [resilient-chat] provider anthropic FAILED -> falling back: simulated anthropic outage
   [resilient-chat] openai turn usedPreviousResponseId=false sent=3/3 messages

4. trigger.dev compaction:
   [resilient-chat] shouldCompact totalTokens=373 threshold=100 -> true
   [resilient-chat] onCompacted FIRED: summaryLen=596 nativeHandleInvalidated
   turn 3 [resilient-chat] run order=openai ... totalMessages=2          (summary + question, not the raw 3)
```

The lines that answer the question directly: in **1**, Anthropic clears 4 tool-uses server-side, we persist that into `chat.agent`'s history (`toolParts 6 -> 2`), and turn 2 re-sends only `toolResultsResent=1` instead of all six — the provider's native compaction is now persisted across turns, no custom summarizer. In **2**, `sent=1/3 messages` shows OpenAI's stored responses doing the same for its provider. **4** is the fallback case: compaction fired and OpenAI (a different provider than turn 1) answered from a summary that saw 2 messages instead of the raw 3.

## Caveats and honest limits

- **Mid-stream failover needs a retry, not a `try/catch`.** The `try/catch` in `run()` only catches errors thrown synchronously when `streamText` is set up. A failure mid-stream goes through `uiMessageStreamOptions.onError` and ends the turn. To fail those over, have the frontend re-send the last message (`useChat`'s `regenerate()`), which re-enters `run()` and advances to the next provider. History is preserved either way.
- **Anthropic context editing is per-request and stateless.** It clears server-side but does not itself persist a compacted state, so `native-persist.ts` mirrors the `appliedEdits` counts into `chat.agent`'s stored history to make the reduction persist across turns. Alternatively, use trigger.dev `compaction`.
- **No cross-provider compaction translation.** A native ref never transfers; the provider-agnostic summary is the portable baseline that makes a switch safe.
- **The stores here are in-memory.** `nativeStore` and `summaryStore` are `Map`s so the example runs with no database. Persist them in your own database for production.
- **Rate limits.** The driver runs the scenarios back to back; on a shared or low-tier API key you may hit rate limits. The driver spaces the tests out, but if you see empty replies, run the scenarios one at a time.

## Adapting this to your app

- Replace the in-memory `Map` stores with your database, keyed by chat id.
- Remove the `[[...]]` demo directives and drive the provider choice from your own logic.
- On the frontend, wire the agent through `useTriggerChatTransport` from `@trigger.dev/sdk/chat/react`. See the [Trigger.dev AI chat docs](https://trigger.dev/docs/ai-chat).

## License

MIT. See [LICENSE](./LICENSE).
