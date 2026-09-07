import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const REVIEW_MODEL = "openai-codex/gpt-5.6-sol";
const REVIEW_THINKING: ModelThinkingLevel = "xhigh";
const MAX_PLAN_BYTES = 160 * 1024;

const INLINE_REVIEW_PROMPT = `
Review the original request and candidate implementation plan from the immediately preceding submit_plan_for_review tool call.

Use the existing conversation context only. Do not start a child process, inspect the repository, use tools, or make changes. Be an independent, adversarial implementation-plan reviewer. Evaluate correctness, completeness, safe sequencing, testability, scope, unstated assumptions, dependencies, unsafe migrations, rollback/data-loss risks, concurrency/lifecycle issues, and validation gaps.

Return exactly these sections:

## Verdict
READY, REVISE, or BLOCKED, followed by one sentence.

## Critical gaps
Only issues that would make the work incorrect, unsafe, or blocked. Use "None" when there are none.

## Important improvements
Concrete additions, removals, or reorderings that would materially improve the plan. Use "None" when there are none.

## Validation gaps
Specific tests, checks, or manual validation that the plan needs.

## Recommended revision
A concise corrected step sequence. Preserve sound steps rather than rewriting for style alone.
`;

type PendingInlineReview = {
  model: Model<Api> | undefined;
  thinkingLevel: ModelThinkingLevel;
  tools: string[];
};

export default function planReviewExtension(pi: ExtensionAPI) {
  let pendingReview: PendingInlineReview | undefined;

  async function restore(previous: PendingInlineReview, ctx: ExtensionContext): Promise<void> {
    if (previous.model) await pi.setModel(previous.model);
    pi.setThinkingLevel(previous.thinkingLevel);
    pi.setActiveTools(previous.tools);
    ctx.ui.notify("Restored the previous model after the inline Sol review.", "info");
  }

  pi.registerTool({
    name: "submit_plan_for_review",
    label: "Submit Plan for Review",
    description:
      "Switch the current conversation to GPT-5.6 Sol at xhigh for an inline, read-only critique of the implementation plan, then restore the previous model.",
    parameters: Type.Object({
      request: Type.String({ description: "The original user request the plan addresses." }),
      plan: Type.String({ description: "The complete candidate implementation plan to review." }),
    }),
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      if (Buffer.byteLength(params.plan, "utf8") > MAX_PLAN_BYTES) {
        throw new Error("The candidate plan exceeds the 160 KiB review limit.");
      }
      if (pendingReview) throw new Error("An inline Sol review is already running.");

      const targetModel = ctx.modelRegistry.find("openai-codex", "gpt-5.6-sol");
      if (!targetModel) throw new Error(`Model not found: ${REVIEW_MODEL}`);

      const previous: PendingInlineReview = {
        model: ctx.model,
        thinkingLevel: pi.getThinkingLevel(),
        tools: pi.getActiveTools(),
      };

      if (!(await pi.setModel(targetModel))) {
        throw new Error(`Could not use ${REVIEW_MODEL}; check its authentication.`);
      }

      pi.setThinkingLevel(REVIEW_THINKING);
      pi.setActiveTools([]);
      pendingReview = previous;
      onUpdate?.({
        content: [{ type: "text", text: "Switched this conversation to GPT-5.6 Sol for an inline review…" }],
        details: { model: REVIEW_MODEL, thinking: REVIEW_THINKING, inline: true },
      });

      try {
        pi.sendUserMessage(INLINE_REVIEW_PROMPT, { deliverAs: "steer" });
      } catch (error) {
        pendingReview = undefined;
        await restore(previous, ctx);
        throw error;
      }

      return {
        content: [{
          type: "text",
          text: "The review is queued inline in the existing conversation. Do not start another review; wait for Sol's critique.",
        }],
        details: { model: REVIEW_MODEL, thinking: REVIEW_THINKING, inline: true },
      };
    },
  });

  pi.registerCommand("plan-review", {
    description: "Create a plan, switch the current conversation to Sol for an inline xhigh critique, then return a revised plan.",
    handler: async (args, ctx) => {
      const request = args.trim();
      if (!request) {
        ctx.ui.notify("Usage: /plan-review <request>", "warning");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("The agent is busy; run /plan-review after it settles.", "warning");
        return;
      }

      pi.sendUserMessage(`Create an implementation plan for this request:\n\n${request}\n\nDo not modify files. You may inspect the repository as needed. Before giving a final answer, write a concrete draft with these sections: Goal, Steps, Files, Validation, Risks, and Open questions. Then call submit_plan_for_review exactly once, passing the original request and the complete draft plan verbatim. After Sol's inline review returns, provide all three sections: Draft plan, Independent review, and Revised plan. Treat the review as advisory: adopt valid findings, explain any rejected findings briefly, and do not call the reviewer again.`);
    },
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!pendingReview) return;
    const previous = pendingReview;
    pendingReview = undefined;
    await restore(previous, ctx);
  });

  pi.on("session_shutdown", async () => {
    if (!pendingReview) return;
    const previous = pendingReview;
    pendingReview = undefined;
    if (previous.model) await pi.setModel(previous.model);
    pi.setThinkingLevel(previous.thinkingLevel);
    pi.setActiveTools(previous.tools);
  });
}
