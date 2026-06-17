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
}

export function executeProposeClarification(
  input: ProposeClarificationInput,
): (ProposeClarificationOk & { tool: "propose_clarification" }) | (ToolError & { tool: "propose_clarification" }) {
  const question = (input.question ?? "").trim();
  const facet_key = (input.facet_key ?? "").trim();
  const opts = Array.isArray(input.options) ? input.options : [];

  if (!question || !facet_key || opts.length < 2 || opts.length > 5) {
    return {
      tool: "propose_clarification",
      ok: false,
      error_code: "bad_input",
      message: "question, facet_key and 2-5 options required",
    };
  }

  const replies = opts
    .filter((o) => typeof o?.value === "string" && o.value.trim())
    .map((o) => ({
      value: String(o.value),
      label: String(o.label ?? o.value),
    }));

  if (replies.length < 2) {
    return {
      tool: "propose_clarification",
      ok: false,
      error_code: "bad_input",
      message: "need ≥2 valid options",
    };
  }

  const slot_id = crypto.randomUUID();
  const side_effects: ToolSideEffect[] = [
    { type: "quick_replies", replies, facet_key },
    {
      type: "slot_update",
      slots: {
        pending_clarification: {
          slot_id,
          facet_key,
          question,
          options: replies,
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
