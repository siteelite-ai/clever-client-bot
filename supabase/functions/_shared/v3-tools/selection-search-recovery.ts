import type { Facet } from "./discover-category.ts";
import type { Criterion } from "./criteria-gate.ts";
import { projectCriteriaFacetOptions } from "./criteria-gate.ts";
import { dropAffirmativeBooleanFilters } from "./search-filter-guard.ts";

export type SelectionSearchRecoveryKind =
  | "preserve_filters_expand_category_scope"
  | "preserve_scope_verify_sparse_boolean_as_evidence"
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

/**
 * Recovery is allowed for an empty filtered result and for the one structural
 * serialization error where the model emitted `by_filter` without either a
 * live scope or options. Other catalog/input errors fail closed.
 */
export function isRecoverableSelectionSearchFailure(
  args: Record<string, unknown>,
  result: SelectionSearchFailure,
): boolean {
  if (args.mode !== "by_filter") return false;
  if (result.ok) return Number(result.total ?? 0) === 0;
  if (result.error_code !== "bad_input") return false;
  const message = String(result.message ?? "").toLocaleLowerCase("en-US");
  return message.includes("by_filter requires category/category_in or options");
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
