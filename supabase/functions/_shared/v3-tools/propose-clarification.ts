// V3 tool: propose_clarification — структурированный уточняющий вопрос
// с quick-replies (аналог price_clarify / dialogSlot из V1).
//
// Эффект: эмитит SSE quick_replies + slot_update.
// После этого эксперт ОБЯЗАН завершить ход (см. §3.7 spec).

import type {
  ProposeClarificationOk,
  ToolError,
  ToolSideEffect,
} from "./types.ts";

export interface ProposeClarificationInput {
  question: string;
  facet_key: string;
  options: Array<{ value: string; label?: string; count?: number }>;
  /** Internal readiness follow-up requiring a value the quick replies cannot supply. */
  freeform?: boolean;
  scope?: {
    kind: string;
    token: string;
    /** Server-proven taxonomy context for the next dialogue turn. */
    resolved_category?: string;
    /** Number of plain-language help turns already shown for this question. */
    assistance_level?: number;
    reasoning_checkpoint?:
      import("./selection-actionability.ts").SelectionReasoningCheckpoint;
  };
}

export function executeProposeClarification(
  input: ProposeClarificationInput,
):
  | (ProposeClarificationOk & { tool: "propose_clarification" })
  | (ToolError & { tool: "propose_clarification" }) {
  const question = typeof input?.question === "string"
    ? input.question.trim()
    : "";
  const facet_key = typeof input?.facet_key === "string"
    ? input.facet_key.trim()
    : "";
  const opts = Array.isArray(input?.options) ? input.options : [];
  const freeform = input?.freeform === true;

  if (
    !question || question.length > 8_000 ||
    !facet_key || facet_key.length > 128 || opts.length > 5 ||
    (freeform ? opts.length !== 0 : opts.length < 2)
  ) {
    return {
      tool: "propose_clarification",
      ok: false,
      error_code: "bad_input",
      message:
        "question, facet_key and 2-5 options required (or an explicit freeform follow-up)",
    };
  }

  // The server and embedded widget must agree on a selectable option. A
  // malformed model-authored value must not be saved as a pending choice that
  // the client later hides, nor can two visually identical buttons represent
  // different answers.
  const replies = opts.map((option) => ({
    value: option?.value,
    label: option?.label ?? option?.value,
  }));
  if (replies.some((reply) =>
    typeof reply.value !== "string" ||
    typeof reply.label !== "string" ||
    !reply.value.trim() || !reply.label.trim() ||
    reply.value !== reply.value.trim() ||
    reply.label !== reply.label.trim() ||
    reply.value.length > 2_000 || reply.label.length > 160
  ) || new Set(replies.map((reply) => reply.value)).size !== replies.length ||
    new Set(replies.map((reply) => reply.label)).size !== replies.length) {
    return {
      tool: "propose_clarification",
      ok: false,
      error_code: "bad_input",
      message: "options must have distinct, bounded values and labels",
    };
  }

  const slot_id = crypto.randomUUID();
  const side_effects: ToolSideEffect[] = [
    ...(!freeform
      ? [{ type: "quick_replies" as const, replies, facet_key }]
      : []),
    {
      type: "slot_update",
      slots: {
        pending_clarification: {
          status: "pending",
          slot_id,
          facet_key,
          question,
          options: replies,
          ...(input.scope?.kind && input.scope?.token
            ? { scope: input.scope }
            : {}),
        },
      },
    },
  ];

  return {
    tool: "propose_clarification",
    ok: true,
    slot_id,
    side_effects,
  };
}
