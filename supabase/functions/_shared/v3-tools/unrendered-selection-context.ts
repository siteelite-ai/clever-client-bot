/** Shared task handoff for semantic continuations outside established routes.
 * A routing decision is not product proof: prefer the fully rehydrated server
 * batch's base; before cards exist use completed active-session customer logs.
 * Never browser prose, stale product cache, model answers or a guessed noun.
 * The original export name is retained for the initial unrendered contract. */
import type { ConversationBoundaryResult } from "./conversation-boundary.ts";
import {
  extractClientQuantities,
  joinCustomerTurns,
} from "./criteria-consistency.ts";
import { canonicalMeasurementUnit } from "./criteria-reasoning.ts";
import { hasExplicitNewTaskPreface } from "./request-preface.ts";

export type UnrenderedSelectionContext =
  | { status: "unchanged"; message: string }
  | {
    status: "restored";
    message: string;
    sourceCount: number;
    source:
      | "completed_server_customer_queries"
      | "completed_server_products_block";
    baseRequest?: string;
  }
  | {
    status: "needs_input";
    message: string;
    reason:
      | "missing_server_context"
      | "ambiguous_quantity_override"
      | "context_limit";
  };

export const UNRENDERED_SELECTION_CONTEXT_QUESTION =
  "Уточните, пожалуйста, какой товар подбираем, и повторите нужные параметры в одном сообщении.";

export function resolveUnrenderedSelectionContext(input: {
  current: string;
  enabled: boolean;
  boundary: ConversationBoundaryResult;
  newTask: boolean;
  strongerContext: boolean;
  replacement: boolean;
  lookupFailed: boolean;
  /** Supplied only by the bounded completed-log loader, newest first. */
  serverQueriesNewestFirst: readonly string[];
  /** Only after the ENTIRE server batch was freshly rehydrated by the caller. */
  verifiedRenderedBase?: string | null;
}): UnrenderedSelectionContext {
  const unchanged = { status: "unchanged" as const, message: input.current };
  if (
    !input.enabled || input.newTask || input.strongerContext ||
    input.replacement ||
    hasExplicitNewTaskPreface(input.current) ||
    input.boundary.mode !== "continuation" ||
    input.boundary.source !== "model" || input.boundary.confidence < 0.85
  ) return unchanged;
  const missing = (
    reason: Extract<
      UnrenderedSelectionContext,
      { status: "needs_input" }
    >["reason"],
  ): UnrenderedSelectionContext => ({
    status: "needs_input",
    message: UNRENDERED_SELECTION_CONTEXT_QUESTION,
    reason,
  });
  if (input.verifiedRenderedBase) {
    // Stronger than raw history. The caller also passes this exact certificate
    // into the existing rendered-axis override/criteria engine. Do not use
    // the conservative unrendered quantity merge in place of that engine.
    const message = joinCustomerTurns([
      input.verifiedRenderedBase,
      input.current,
    ]);
    if (message.length > 500) return missing("context_limit");
    return {
      status: "restored",
      message,
      sourceCount: 1,
      source: "completed_server_products_block",
      baseRequest: input.verifiedRenderedBase,
    };
  }
  if (input.lookupFailed || !input.serverQueriesNewestFirst.length) {
    return missing("missing_server_context");
  }
  if (
    input.serverQueriesNewestFirst.length > 8 || input.current.length > 3000 ||
    input.serverQueriesNewestFirst.some((query) =>
      !query.trim() || query.length > 3000
    )
  ) return missing("context_limit");
  // A quantity's unit alone cannot prove that a correction belongs to the
  // same axis (length vs diameter, for example). Do not carry contradictory
  // old numbers into new hard filters or silently delete another constraint.
  // Established pending/card routes retain their existing override engines.
  const values = new Map<string, Set<number>>();
  for (const query of [...input.serverQueriesNewestFirst, input.current]) {
    const quantities = extractClientQuantities(query);
    const thisTurn = new Map<string, Set<number>>();
    for (const q of quantities) {
      const unit = canonicalMeasurementUnit(q.unit);
      if (!unit) continue;
      const set = thisTurn.get(unit) ?? new Set<number>();
      set.add(q.value);
      thisTurn.set(unit, set);
    }
    for (const [unit, current] of thisTurn) {
      const prior = values.get(unit);
      if (
        prior &&
        (prior.size !== current.size ||
          [...prior].some((value) => !current.has(value)))
      ) {
        return missing("ambiguous_quantity_override");
      }
      values.set(unit, current);
    }
  }
  const queries = [...input.serverQueriesNewestFirst].reverse();
  const message = joinCustomerTurns([...queries, input.current]);
  // A later clarification may carry this task in the existing500-character
  // readiness scope. Do not allow its serializer to truncate a safety fact.
  if (message.length > 500) return missing("context_limit");
  return {
    status: "restored",
    message,
    sourceCount: queries.length,
    source: "completed_server_customer_queries",
  };
}
