import { configure } from "@trigger.dev/sdk";
import { AgentChat } from "@trigger.dev/sdk/chat";

/**
 * Server-side driver for the resilient-chat example.
 *
 * Runs two scripted conversations against the deployed `resilient-chat` agent and
 * prints PASS/FAIL plus the assistant replies. Watch your `trigger dev` terminal for
 * the `[resilient-chat]` lines that show the fallback and the previousResponseId reuse.
 *
 * Run with:  node --env-file=.env driver.mjs
 */

if (!process.env.TRIGGER_SECRET_KEY) {
  console.error("Set TRIGGER_SECRET_KEY (and TRIGGER_API_URL if not using the default cloud). Try: node --env-file=.env driver.mjs");
  process.exit(1);
}

configure({
  baseURL: process.env.TRIGGER_API_URL,
  secretKey: process.env.TRIGGER_SECRET_KEY,
});

const rid = (p) => `${p}-${Math.random().toString(36).slice(2, 10)}`;

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

  console.log("\n===== Test B: OpenAI native store — history not resent =====");
  const b = new AgentChat({ agent: "resilient-chat", id: rid("openai-store") });
  const b1 = await turn(b, "[[provider:openai]] Remember this: my favorite animal is the axolotl.");
  console.log("B turn1 (openai, first):", JSON.stringify(b1));
  const b2 = await turn(b, "[[provider:openai]] What is my favorite animal? Reply with only the animal.");
  console.log("B turn2 (openai, reuses previousResponseId + sends delta only):", JSON.stringify(b2));
  const bPass = /axolotl/i.test(b2);
  console.log("B RESULT:", bPass ? "PASS (recalled via OpenAI server-side state)" : "FAIL");
  await b.close();

  console.log("\n===== SUMMARY =====");
  console.log("A (fallback preserves history):", aPass ? "PASS" : "FAIL");
  console.log("B (openai store, no full resend):", bPass ? "PASS" : "FAIL");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("driver error:", e);
    process.exit(1);
  });
