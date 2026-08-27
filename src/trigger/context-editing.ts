import { chat } from "@trigger.dev/sdk/ai";
import { streamText, stepCountIs, tool } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";

/**
 * Focused demo of Anthropic's provider-native context editing.
 *
 * Anthropic's `contextManagement` clears old tool-use/tool-result blocks (or compacts
 * the conversation) SERVER-SIDE, per request, once a trigger threshold is crossed, and
 * reports what it did in `providerMetadata.anthropic.contextManagement.appliedEdits`.
 *
 * The key thing to understand for chat.agent: this is stateless per request. It reduces
 * what the model processes for a given call, but it does NOT hand you a persisted
 * compacted state. Across turns you still send your messages array (Anthropic re-clears
 * each request; pair with prompt caching to avoid recompute). To actually stop
 * re-sending across turns you either mirror the clearing into your stored messages using
 * the `appliedEdits` counts, or use trigger.dev `compaction` (see ./resilient-chat.ts).
 *
 * This agent forces several tool calls in one turn and logs the `appliedEdits` so you
 * can see the native clearing happen (clearedToolUses > 0).
 */

function bigRecord(id: number): string {
  return `RECORD ${id}: ` + "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(40) + `(end record ${id})`;
}

const fetchRecord = tool({
  description: "Fetch the full text of a record by its numeric id. Call once per id.",
  inputSchema: z.object({ id: z.number() }),
  execute: async ({ id }) => ({ id, text: bigRecord(id) }),
});

export const contextEditing = chat.agent({
  id: "context-editing",
  idleTimeoutInSeconds: 120,
  tools: { fetchRecord },
  run: async ({ messages, tools, signal }) => {
    let clearedToolUses = 0;
    let clearedInputTokens = 0;

    const result = streamText({
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
          | { appliedEdits?: Array<{ type?: string; clearedToolUses?: number; clearedInputTokens?: number }> }
          | undefined;
        for (const edit of cm?.appliedEdits ?? []) {
          if (edit.type === "clear_tool_uses_20250919") {
            clearedToolUses += edit.clearedToolUses ?? 0;
            clearedInputTokens += edit.clearedInputTokens ?? 0;
          }
        }
        if (cm?.appliedEdits?.length) {
          console.log(`[context-editing] step appliedEdits=${JSON.stringify(cm.appliedEdits)}`);
        }
      },
    });

    void result.text.then(() => {
      console.log(
        `[context-editing] TURN DONE: native context editing clearedToolUses=${clearedToolUses} clearedInputTokens=${clearedInputTokens}`
      );
    });

    return result;
  },
});
