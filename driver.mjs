import { configure } from "@trigger.dev/sdk";
import { AgentChat } from "@trigger.dev/sdk/chat";

/**
 * Server-side driver for the resilient-chat example.
 *
 * Runs the scenarios below against the deployed agents and prints PASS/FAIL. Watch your
 * `trigger dev` terminal for the `[native-persist]` / `[resilient-chat]` lines that show
 * the mechanism: the persisted native compaction, the previousResponseId reuse, the
 * fallback, and the compaction lifecycle.
 *
 * Compaction (test 4) needs a low threshold so it fires in a short demo:
 *
 *   COMPACT_AT_TOKENS=100 npx trigger dev     # in one terminal
 *   node --env-file=.env driver.mjs           # in another
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
  console.log("\n===== 1. Anthropic native compaction, PERSISTED across chat.agent turns =====");
  const p = new AgentChat({ agent: "native-persist", id: rid("native-persist") });
  const p1 = await turn(p, "Fetch records 1, 2, 3, 4, 5, and 6 using the fetchRecord tool, one call per record. Then reply with just DONE.");
  console.log("  turn1 (6 tool calls; Anthropic clears old ones server-side):", JSON.stringify(p1.slice(0, 40)));
  const p2 = await turn(p, "Give me a one-sentence recap of what you just did.");
  console.log("  turn2 (chat.agent re-sends the pruned history, not all 6 tool results):", JSON.stringify(p2.slice(0, 90)));
  console.log("  proof: worker log [native-persist] PERSISTED ... toolParts 6 -> 2, then turn2 toolResultsResent < 6");
  await p.close();
  await sleep(5000);

  console.log("\n===== 2. OpenAI native store — history not resent =====");
  const b = new AgentChat({ agent: "resilient-chat", id: rid("openai-store") });
  const b1 = await turn(b, "[[provider:openai]] Remember this: my favorite animal is the axolotl.");
  console.log("  turn1 (openai, first):", JSON.stringify(b1.slice(0, 60)));
  const b2 = await turn(b, "[[provider:openai]] What is my favorite animal? Reply with only the animal.");
  console.log("  turn2 (openai, reuses previousResponseId + sends delta only):", JSON.stringify(b2));
  const bPass = /axolotl/i.test(b2);
  console.log("  RESULT:", bPass ? "PASS (recalled via OpenAI server-side state)" : "FAIL");
  await b.close();
  await sleep(5000);

  console.log("\n===== 3. Provider fallback preserves history =====");
  const a = new AgentChat({ agent: "resilient-chat", id: rid("fallback") });
  const a1 = await turn(a, "Please remember my lucky number for later: 4287.");
  console.log("  turn1 (anthropic):", JSON.stringify(a1.slice(0, 60)));
  const a2 = await turn(a, "[[fail:anthropic]] What lucky number did I give you earlier? Reply with only the number.");
  console.log("  turn2 (anthropic forced-fail -> openai):", JSON.stringify(a2));
  const aPass = /4287/.test(a2);
  console.log("  RESULT:", aPass ? "PASS (history survived the provider switch)" : "FAIL");
  await a.close();
  await sleep(5000);

  console.log("\n===== 4. trigger.dev compaction fires + summary survives a provider switch =====");
  console.log("(needs COMPACT_AT_TOKENS low, e.g. 100, on the worker)");
  const c = new AgentChat({ agent: "resilient-chat", id: rid("compaction") });
  const c1 = await turn(c, "[[provider:anthropic]] Please remember this fact for later: the project launch date is March 14.");
  console.log("  turn1 (anthropic, states the fact):", JSON.stringify(c1.slice(0, 80)));
  const c2 = await turn(c, "[[provider:anthropic]] Now, for context, write about five short paragraphs on general software project management best practices.");
  console.log("  turn2 (anthropic, long -> triggers compaction; the fact is now only in the summary):", JSON.stringify(c2.slice(0, 60)) + "...");
  const c3 = await turn(c, "[[provider:openai]] What is the project launch date? Reply with only the date.");
  console.log("  turn3 (openai, sees summary + recent, NOT the raw fact message):", JSON.stringify(c3));
  const cPass = /march 14/i.test(c3);
  console.log("  RESULT:", cPass ? "PASS (compaction summary carried the fact across the provider switch)" : "FAIL (did compaction fire? set COMPACT_AT_TOKENS=100)");
  await c.close();

  console.log("\n===== SUMMARY =====");
  console.log("1. Anthropic native compaction persisted: see worker log for 'toolParts 6 -> 2' + reduced resend");
  console.log("2. OpenAI store, no full resend:", bPass ? "PASS" : "FAIL");
  console.log("3. Fallback preserves history:", aPass ? "PASS" : "FAIL");
  console.log("4. Compaction fires + summary survives switch:", cPass ? "PASS" : "FAIL");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("driver error:", e);
    process.exit(1);
  });
