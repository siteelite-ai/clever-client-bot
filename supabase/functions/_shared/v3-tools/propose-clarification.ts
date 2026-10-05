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
  const freeform = input.freeform === true;

  if (
    !question || !facet_key || opts.length > 5 ||
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

  const replies = opts
    .filter((o) => typeof o?.value === "string" && o.value.trim())
    .map((o) => ({
      value: String(o.value),
      label: String(o.label ?? o.value),
    }));

  if (!freeform && replies.length < 2) {
    return {
      tool: "propose_clarification",
      ok: false,
      error_code: "bad_input",
      message: "need ≥2 valid options",
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
