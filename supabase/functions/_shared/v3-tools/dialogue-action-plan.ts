/** Routing policy is independent of vocabulary, SKUs, providers and products.
 * Adapters report capabilities/verified preconditions; one plan chooses the
 * next action. A failed adapter does not silently authorise a different task.
 * Admission, per-card proofs and each adapter's residual-condition checks stay
 * mandatory; choosing an action is never a product suitability certificate. */
const ACTIONS = [
  ["acknowledge", "general"],
  ["fixture_scope_unverified", "clarify"],
  ["fixture_selection", "application"],
  ["fixture_pending", "clarify"],
  ["cutout_continuation", "replacement"],
  ["catalog_choice", "browse"],
  ["catalog_choice_unresolved", "clarify"],
  ["catalog_choice_unverified", "clarify"],
  ["application_unsupported", "application"],
  ["clarify", "clarify"],
  ["application_selection", "application"],
  ["constrained_catalog_choice", "refinement"],
  ["meta", "general"],
  ["engineering", "general"],
  ["clean_power", "application"],
  ["electrical_diagnostic", "general"],
  ["load_guidance", "general"],
  ["active_selection", "refinement"],
  ["assortment", "browse"],
  ["exact_item", "item_facts"],
  ["series_inquiry", "item_facts"],
  ["series_browse", "browse"],
  ["poe_assessment", "general"],
  ["poe_explanation", "general"],
  ["unavailable_reference", "batch_facts"],
  ["recent_show", "batch_facts"],
  ["recent_price", "batch_facts"],
  ["semantic_compound", "selection"],
  ["exact_compound", "selection"],
  ["poe_selection", "application"],
  ["batch_evidence", "batch_facts"],
  ["store_policy", "store"],
  ["general_inquiry", "general"],
  ["measured_replacement", "replacement"],
  ["replacement", "replacement"],
] as const;

export type DialogueAction = typeof ACTIONS[number][0] | "expert";
export type DialogueOperation = typeof ACTIONS[number][1];
export type DialogueCapabilities = Partial<
  Record<Exclude<DialogueAction, "expert">, boolean>
>;
const DEPENDENT_ACTIONS = new Set<DialogueAction>([
  "cutout_continuation",
  "catalog_choice",
  "catalog_choice_unresolved",
  "catalog_choice_unverified",
  "constrained_catalog_choice",
  "active_selection",
  "unavailable_reference",
  "recent_show",
  "recent_price",
  "batch_evidence",
  "fixture_scope_unverified",
  "fixture_pending",
]);
const BATCH_ACTIONS = new Set<DialogueAction>([
  "recent_show",
  "recent_price",
  "batch_evidence",
]);

export function planDialogueAction(input: {
  newTask: boolean;
  independentItemInquiry: boolean;
  capabilities: DialogueCapabilities;
}): {
  action: DialogueAction;
  operation: DialogueOperation;
  eligible: DialogueAction[];
  suppressed: DialogueAction[];
  requiresRenderedCards: boolean;
} {
  const eligible = ACTIONS.filter(([action]) =>
    input.capabilities[action] &&
    !(input.newTask && DEPENDENT_ACTIONS.has(action))
  );
  // A fully named factual question is a new identity lookup, not an answer
  // to an old question and not an application-selection readiness task.
  const selected = input.independentItemInquiry && input.capabilities.exact_item
    ? ACTIONS.find(([action]) => action === "exact_item")!
    : eligible[0];
  const action = selected?.[0] ?? "expert";
  return {
    action,
    operation: selected?.[1] ??
      (input.independentItemInquiry ? "item_facts" : "selection"),
    eligible: eligible.map(([name]) => name),
    suppressed: eligible.flatMap(([name]) => name === action ? [] : [name]),
    requiresRenderedCards: BATCH_ACTIONS.has(action),
  };
}
