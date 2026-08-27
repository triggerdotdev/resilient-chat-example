import { configure } from "@trigger.dev/sdk";
import { AgentChat } from "@trigger.dev/sdk/chat";

/**
 * Server-side driver for the resilient-chat example.
 *
 * Runs four scripted conversations against the deployed agents and prints PASS/FAIL.
 * Watch your `trigger dev` terminal for the `[resilient-chat]` / `[context-editing]`
 * lines that show the fallback, the previousResponseId reuse, the compaction lifecycle,
 * and the native context-editing counts.
 *
 * Run compaction (Test C) and context editing (Test D) with a low threshold so they
 * fire in a short demo:
 *
 *   COMPACT_AT_TOKENS=100 npx trigger dev      # in one terminal
 *   node --env-file=.env driver.mjs            # in another
 */

if (!process.env.TRIGGER_SECRET_KEY) {
  console.error("Set TRIGGER_SECRET_KEY (and TRIGGER_API_URL if not using the default cloud). Try: node --env-file=.env driver.mjs");
  process.exit(1);
}

configure({ baseURL: process.env.TRIGGER_API_URL, secretKey: process.env.TRIGGER_SECRET_KEY });

const rid = (p) => `${p}-${Math.random().toString(36).slice(2, 10)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function turn(chat, text) {
  const stream = await chat.sendMessage(text);
  return (await stream.text()).trim();
}

async function main() {
  console.log("\n===== Test A: provider fallback preserves history =====");
  const a = new AgentChat({ agent: "resilient-chat", id: rid("fallback") });
  const a1 = await turn(a, "Please remember my lucky number for later: 4287.");
  console.log("A turn1 (anthropic):", JSON.stringify(a1));
  const a2 = await turn(a, "[[fail:anthropic]] What lucky number did I give you earlier? Reply with only the number.");
  console.log("A turn2 (anthropic forced-fail -> openai):", JSON.stringify(a2));
  const aPass = /4287/.test(a2);
  console.log("A RESULT:", aPass ? "PASS (history survived the provider switch)" : "FAIL");
  await a.close();
  await sleep(5000);

  console.log("\n===== Test B: OpenAI native store — history not resent =====");
  const b = new AgentChat({ agent: "resilient-chat", id: rid("openai-store") });
  const b1 = await turn(b, "[[provider:openai]] Remember this: my favorite animal is the axolotl.");
  console.log("B turn1 (openai, first):", JSON.stringify(b1));
  const b2 = await turn(b, "[[provider:openai]] What is my favorite animal? Reply with only the animal.");
  console.log("B turn2 (openai, reuses previousResponseId + sends delta only):", JSON.stringify(b2));
  const bPass = /axolotl/i.test(b2);
  console.log("B RESULT:", bPass ? "PASS (recalled via OpenAI server-side state)" : "FAIL");
  await b.close();
  await sleep(5000);

  console.log("\n===== Test C: compaction fires + summary survives a provider switch =====");
  console.log("(needs COMPACT_AT_TOKENS low, e.g. 100, on the worker)");
  const c = new AgentChat({ agent: "resilient-chat", id: rid("compaction") });
  const c1 = await turn(c, "[[provider:anthropic]] Please remember this fact for later: the project launch date is March 14.");
  console.log("C turn1 (anthropic, states the fact):", JSON.stringify(c1.slice(0, 80)));
  const c2 = await turn(c, "[[provider:anthropic]] Now, for context, write about five short paragraphs on general software project management best practices.");
  console.log("C turn2 (anthropic, long -> triggers compaction; the fact is now only in the summary):", JSON.stringify(c2.slice(0, 60)) + "...");
  const c3 = await turn(c, "[[provider:openai]] What is the project launch date? Reply with only the date.");
  console.log("C turn3 (openai, sees summary + recent, NOT the raw fact message):", JSON.stringify(c3));
  const cPass = /march 14/i.test(c3);
  console.log("C RESULT:", cPass ? "PASS (compaction summary carried the fact across the provider switch)" : "FAIL (did compaction fire? set COMPACT_AT_TOKENS=100)");
  await c.close();
  await sleep(5000);

  console.log("\n===== Test D: Anthropic native compaction PERSISTED across chat.agent turns =====");
  const d = new AgentChat({ agent: "native-persist", id: rid("native-persist") });
  const d1 = await turn(d, "Fetch records 1, 2, 3, 4, 5, and 6 using the fetchRecord tool, one call per record. Then reply with just DONE.");
  console.log("D turn1 (6 tool calls; Anthropic clears old ones server-side):", JSON.stringify(d1.slice(0, 40)));
  const d2 = await turn(d, "Give me a one-sentence recap of what you just did.");
  console.log("D turn2 (chat.agent re-sends the pruned history, not all 6 tool results):", JSON.stringify(d2.slice(0, 90)));
  console.log("D: proof is the worker log: [native-persist] PERSISTED ... toolParts 6 -> 2, then turn 2 run toolResultsResent < 6");
  await d.close();

  console.log("\n===== SUMMARY =====");
  console.log("A (fallback preserves history):", aPass ? "PASS" : "FAIL");
  console.log("B (openai store, no full resend):", bPass ? "PASS" : "FAIL");
  console.log("C (compaction fires + summary survives switch):", cPass ? "PASS" : "FAIL");
  console.log("D (anthropic native compaction persisted): see the worker log for 'toolParts 6 -> 2' + reduced resend");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("driver error:", e);
    process.exit(1);
  });
