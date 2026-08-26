import type { Facet } from "./discover-category.ts";
import type { Criterion } from "./criteria-gate.ts";
import { projectCriteriaFacetOptions } from "./criteria-gate.ts";
import { dropAffirmativeBooleanFilters } from "./search-filter-guard.ts";
import {
  type DiscoveredCategoryScope,
  groundedCategoryRecoveryQueries,
  groundedTokenRecoveryQueries,
} from "./category-reasoning-guard.ts";

export type SelectionSearchRecoveryKind =
  | "preserve_filters_expand_category_scope"
  | "preserve_scope_verify_sparse_boolean_as_evidence"
  | "verify_compatibility_in_grounded_category"
  | "project_reasoning_ranges_in_category"
  | "project_reasoning_ranges_expand_category_scope";

export interface SelectionSearchRecoveryAttempt {
  kind: SelectionSearchRecoveryKind;
  args: Record<string, unknown>;
  relaxed_inputs: string[];
  /** Mandatory criteria proved by this exact catalog filter. */
  proven_criteria: Criterion[];
  /** Every recovery pool must be rechecked by these contracts before render. */
  revalidate: Array<"selection_target" | "mandatory_criteria" | "compatibility" | "budget">;
}

export interface SelectionSearchRecoveryPlanInput {
  failed_args: Record<string, unknown>;
  facets: Facet[];
  leaf_categories: string[];
  reasoning_criteria: Criterion[];
  compatibility_shaped: boolean;
}

export interface SelectionSearchFailure {
  ok: boolean;
  total?: number;
  error_code?: string;
  message?: string;
}

export interface PendingSelectionFinalizationInput {
  products_rendered: number;
  intent_mode: "select" | "inquire";
  has_discovery: boolean;
  has_selection_target: boolean;
  has_search_attempt: boolean;
  mandatory_criteria_count: number;
  replacement_intent: boolean;
  series_grounding_required: boolean;
  compatibility_relation_count: number;
  compatibility_required: boolean;
}

export interface CatalogEmptyDecisionInput {
  products_rendered: number;
  intent_mode: "select" | "inquire";
  final_text: string;
}

/**
 * A cold or inconsistent facet endpoint can report an empty intersection even
 * though the already-grounded live category contains valid products. Fetch a
 * bounded category candidate pool and let the caller revalidate the complete
 * target/criteria/compatibility/budget contract locally. No filter is claimed
 * as proven by this retrieval step.
 */
export function buildCategoryVerificationSearchInput(
  leafCategories: string[],
): Record<string, unknown> | null {
  const categories = [...new Set(
    (Array.isArray(leafCategories) ? leafCategories : [])
      .map((category) => String(category ?? "").trim())
      .filter(Boolean),
  )];
  if (categories.length === 0) return null;
  return {
    mode: "by_filter",
    category_in: categories,
    per_page: 50,
  };
}

/**
 * A model response without another tool call is not allowed to bypass an
 * already-formed selection contract. All ordinary selections with enough
 * machine-readable evidence must converge on the same deterministic finalizer.
 * Compatibility, replacement and named-series modes retain their specialised
 * proof controllers and therefore fail closed here.
 */
export function shouldFinalizePendingSelection(input: PendingSelectionFinalizationInput): boolean {
  return input.products_rendered === 0 &&
    input.intent_mode === "select" &&
    input.has_discovery &&
    input.has_selection_target &&
    (input.mandatory_criteria_count > 0 || input.has_search_attempt) &&
    !input.replacement_intent &&
    !input.series_grounding_required &&
    input.compatibility_relation_count < 2 &&
    !input.compatibility_required;
}

/** A product-selection turn must close an empty catalog attempt explicitly.
 * An inquiry that already produced a substantive evidence-backed answer must
 * not append the contradictory phrase “no suitable products found”. */
export function shouldAppendCatalogEmpty(input: CatalogEmptyDecisionInput): boolean {
  if (input.products_rendered > 0) return false;
  if (input.intent_mode === "select") return true;
  return String(input.final_text ?? "").trim().length === 0;
}

function normalizeQuery(value: string): string {
  return String(value ?? "")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Bounded query plan built exclusively from wording already selected by the
 * consultant. More specific phrases run first; no product vocabulary or
 * synthetic dictionary is introduced by the server.
 */
export function rankReasoningSearchQueries(values: Array<string | null | undefined>, limit = 4): string[] {
  const unique = new Map<string, string>();
  for (const raw of values) {
    const query = String(raw ?? "").trim();
    const normalized = normalizeQuery(query);
    if (!normalized || unique.has(normalized)) continue;
    unique.set(normalized, query);
  }
  return [...unique.values()]
    .sort((left, right) => {
      const leftTokens = normalizeQuery(left).split(" ").filter(Boolean).length;
      const rightTokens = normalizeQuery(right).split(" ").filter(Boolean).length;
      return rightTokens - leftTokens || right.length - left.length;
    })
    .slice(0, Math.max(1, limit));
}

/**
 * When an exact source SKU is absent, derive a bounded search ladder only from
 * live taxonomy names already supported by the consultant's reasoning. Token
 * fallbacks remain safe because the caller must revalidate every candidate
 * against the complete grounded category targets and final selection contract.
 */
export function buildAnchorMissingRecoveryQueries(
  discovered: DiscoveredCategoryScope | null,
  declaredReasoning: string,
  literalRequirements: string[] = [],
  limit = 4,
): { targets: string[]; queries: string[] } {
  const targets = groundedCategoryRecoveryQueries(
    discovered,
    declaredReasoning,
    20,
  );
  const tokens = targets.flatMap((target) =>
    groundedTokenRecoveryQueries(target, 4)
  );
  const requirementQuery = literalRequirements
    .map((value) => value.trim())
    .filter(Boolean)
    .join(" ");
  const combined = targets.map((target) =>
    [target, requirementQuery].filter(Boolean).join(" ")
  );
  return {
    targets,
    queries: rankReasoningSearchQueries(
      [...combined, requirementQuery, ...targets, ...tokens],
      limit,
    ),
  };
}

/**
 * Recovery is allowed for an empty filtered result and for the structured
 * incomplete-filter result where the model emitted `by_filter` without either
 * a live scope or options. Other catalog/input errors fail closed.
 */
export function isRecoverableSelectionSearchFailure(
  args: Record<string, unknown>,
  result: SelectionSearchFailure,
): boolean {
  if (args.mode !== "by_filter") return false;
  if (result.ok) return Number(result.total ?? 0) === 0;
  return result.error_code === "incomplete_filter";
}

const REVALIDATE: SelectionSearchRecoveryAttempt["revalidate"] = [
  "selection_target",
  "mandatory_criteria",
  "compatibility",
  "budget",
];

function signature(args: Record<string, unknown>): string {
  const sorted = Object.fromEntries(Object.entries(args).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify(sorted);
}

function pageSize(args: Record<string, unknown>): number {
  const value = Number(args.per_page);
  return Number.isFinite(value) ? Math.max(50, value) : 50;
}

function projectedFilterArgs(
  original: Record<string, unknown>,
  options: Record<string, string[]>,
  leafCategories: string[],
): Record<string, unknown> {
  return {
    mode: "by_filter",
    ...(leafCategories.length > 0 ? { category_in: [...leafCategories] } : {}),
    options,
    ...(typeof original.min_price === "number" ? { min_price: original.min_price } : {}),
    ...(typeof original.max_price === "number" ? { max_price: original.max_price } : {}),
    ...(original.sort_cheapest === true ? { sort_cheapest: true } : {}),
    ...(original.sort_expensive === true ? { sort_expensive: true } : {}),
    per_page: pageSize(original),
  };
}

/**
 * Builds one bounded, deterministic recovery plan for an empty selection
 * search. The plan contains no product/category vocabulary: all taxonomy,
 * facets and criteria arrive from live discovery and model reasoning.
 */
export function buildSelectionSearchRecoveryPlan(
  input: SelectionSearchRecoveryPlanInput,
): SelectionSearchRecoveryAttempt[] {
  const original = { ...input.failed_args };
  if (original.mode !== "by_filter") return [];

  const attempts: SelectionSearchRecoveryAttempt[] = [];
  const seen = new Set([signature(original)]);
  const add = (attempt: SelectionSearchRecoveryAttempt) => {
    const key = signature(attempt.args);
    if (seen.has(key)) return;
    seen.add(key);
    attempts.push(attempt);
  };

  const options = original.options && typeof original.options === "object"
    ? original.options as Record<string, unknown>
    : {};
  const hasScope = typeof original.category === "string" || Array.isArray(original.category_in);
  if (hasScope && Object.keys(options).length > 0) {
    const args = { ...original };
    delete args.category;
    delete args.category_in;
    add({
      kind: "preserve_filters_expand_category_scope",
      args,
      relaxed_inputs: ["category_scope"],
      proven_criteria: [],
      revalidate: [...REVALIDATE],
    });
  }

  const booleanFallback = dropAffirmativeBooleanFilters(original, input.facets);
  if (booleanFallback.removed.length > 0) {
    const args: Record<string, unknown> = {
      ...booleanFallback.args,
      per_page: pageSize(booleanFallback.args),
      ...(
        typeof booleanFallback.args.max_price === "number" &&
        booleanFallback.args.sort_cheapest !== true &&
        booleanFallback.args.sort_expensive !== true
          ? { sort_expensive: true }
          : {}
      ),
    };
    add({
      kind: "preserve_scope_verify_sparse_boolean_as_evidence",
      args,
      relaxed_inputs: booleanFallback.removed.map(({ key }) => `boolean:${key}`),
      proven_criteria: [],
      revalidate: [...REVALIDATE],
    });
  }

  // A paired/relational selection can be reasoned correctly while the model
  // serializes the threshold as an exact facet value. After that intersection
  // is empty, fetch only a bounded pool from the already-grounded live
  // category. This retrieval proves no filter: the caller must rebuild and
  // enforce the full compatibility relation before rendering any card.
  if (input.compatibility_shaped) {
    const args = buildCategoryVerificationSearchInput(input.leaf_categories);
    if (args) {
      add({
        kind: "verify_compatibility_in_grounded_category",
        args,
        relaxed_inputs: ["model_filter_serialization"],
        proven_criteria: [],
        revalidate: [...REVALIDATE],
      });
    }
  }

  // Paired-state compatibility has its own two-sided projection. A scalar
  // range recovery must never pre-empt or weaken that contract.
  if (!input.compatibility_shaped) {
    const projection = projectCriteriaFacetOptions(input.reasoning_criteria, input.facets);
    if (Object.keys(projection.options).length > 0 && projection.proven_criteria.length > 0) {
      const scoped = projectedFilterArgs(original, projection.options, input.leaf_categories);
      add({
        kind: "project_reasoning_ranges_in_category",
        args: scoped,
        relaxed_inputs: ["model_filter_serialization"],
        proven_criteria: projection.proven_criteria,
        revalidate: [...REVALIDATE],
      });
      if (Array.isArray(scoped.category_in)) {
        const unscoped = { ...scoped };
        delete unscoped.category_in;
        add({
          kind: "project_reasoning_ranges_expand_category_scope",
          args: unscoped,
          relaxed_inputs: ["model_filter_serialization", "category_scope"],
          proven_criteria: projection.proven_criteria,
          revalidate: [...REVALIDATE],
        });
      }
    }
  }

  return attempts.slice(0, 4);
}
