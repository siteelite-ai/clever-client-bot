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
  scope?: {
    kind: string;
    token: string;
    /** Server-proven taxonomy context for the next dialogue turn. */
    resolved_category?: string;
  };
}

export function executeProposeClarification(
  input: ProposeClarificationInput,
):
  | (ProposeClarificationOk & { tool: "propose_clarification" })
  | (ToolError & { tool: "propose_clarification" }) {
  const question = (input.question ?? "").trim();
  const facet_key = (input.facet_key ?? "").trim();
  const opts = Array.isArray(input.options) ? input.options : [];

  if (
    !question || !facet_key || facet_key.length > 128 ||
    opts.length < 2 || opts.length > 5
  ) {
    return {
      tool: "propose_clarification",
      ok: false,
      error_code: "bad_input",
      message: "question, facet_key and 2-5 options required",
    };
  }

  const replies = opts.map((option) => ({
    value: option?.value,
    label: option?.label ?? option?.value,
  }));
  const values = new Set<string>();
  if (
    replies.some(({ value, label }) => {
      if (
        typeof value !== "string" || typeof label !== "string" ||
        !value.trim() || !label.trim() || value !== value.trim() ||
        value.length > 2000 || label.length > 160 || values.has(value)
      ) return true;
      values.add(value);
      return false;
    })
  ) {
    return {
      tool: "propose_clarification",
      ok: false,
      error_code: "bad_input",
      message: "options must be 2-5 distinct, nonblank widget-compatible choices",
    };
  }

  const slot_id = crypto.randomUUID();
  const side_effects: ToolSideEffect[] = [
    { type: "quick_replies", replies, facet_key },
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
