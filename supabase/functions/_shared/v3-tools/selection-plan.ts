import {
  extractPortableTechnicalRequirements,
  extractReplacementLookupKeys,
} from "./replacement-preflight.ts";
import type { CatalogSearchState } from "./catalog-search-outcome.ts";
import { projectCriteriaFacetOptions, type CriteriaFacet, type Criterion } from "./criteria-gate.ts";
import { alignCriteriaImportanceWithReasoning } from "./criteria-reasoning.ts";
import {
  dropImplicitReplacementIdentityFilters,
  guardSearchFilters,
  type SearchFacet,
} from "./search-filter-guard.ts";

export type SelectionCriterionSource =
  | "user_literal"
  | "anchor_trait"
  | "live_facet"
  | "model_inference";

export interface SelectionPlanCriterion {
  value: string;
  source: SelectionCriterionSource;
}

export interface ReplacementSelectionPlan {
  mode: "replacement";
  anchor_state: CatalogSearchState;
  source_identifiers: string[];
  portable_requirements: SelectionPlanCriterion[];
}

export interface ReplacementReasoningContract {
  criteria: Criterion[];
  options: Record<string, string[]>;
  demoted: string[];
  axes: Array<{ key: string; caption: string; values: string[]; unit: string | null }>;
  title_axes: Array<{ key: string; caption: string; values: string[]; unit: string | null }>;
}

/**
 * Compile the consultant's declared portable requirements into live facets.
 * Source identity is removed before compilation; advisory assumptions remain
 * level B and therefore cannot narrow retrieval or final rendering.
 */
export function compileReplacementReasoningContract(
  facets: Array<SearchFacet & CriteriaFacet>,
  reasoningText: string,
  userEvidence: string,
  sourceMessage: string,
): ReplacementReasoningContract {
  const guarded = guardSearchFilters(
    { mode: "by_filter" },
    facets,
    reasoningText,
    userEvidence,
  );
  const identityFree = dropImplicitReplacementIdentityFilters(
    guarded.args,
    facets,
    sourceMessage,
  );
  const options = identityFree.args.options && typeof identityFree.args.options === "object"
    ? identityFree.args.options as Record<string, string[]>
    : {};
  const criteria: Criterion[] = Object.entries(options).flatMap(([key, values]) => {
    const facet = facets.find((candidate) => candidate.key === key);
    return values.map((value) => ({
      key: facet?.caption || key,
      op: "eq" as const,
      value,
      unit: facet?.unit ?? undefined,
      level: "A" as const,
    }));
  });
  const userBacked: Criterion[] = guarded.user_backed.map(({ key, value }) => {
    const facet = facets.find((candidate) => candidate.key === key);
    return { key: facet?.caption || key, op: "eq", value, unit: facet?.unit ?? undefined, level: "A" };
  });
  const importance = alignCriteriaImportanceWithReasoning(
    criteria,
    reasoningText,
    userBacked,
  );
  const mandatory = importance.criteria.filter((criterion) => (criterion.level ?? "A") === "A");
  const projected = projectCriteriaFacetOptions(mandatory, facets);
  const compileAxes = (source: Record<string, string[]>) => Object.entries(source).flatMap(([key, values]) => {
    const facet = facets.find((candidate) => candidate.key === key);
    if (!facet || values.length === 0) return [];
    return [{
      key,
      caption: facet.caption || key,
      values: [...values],
      unit: facet.unit ?? null,
    }];
  });
  return {
    criteria: projected.proven_criteria,
    options: projected.options,
    demoted: importance.demoted,
    axes: compileAxes(projected.options),
    // These live, identity-free axes may be advisory for retrieval but still
    // provide title-visible proof for compact customer codes. The downstream
    // compiler accepts only explicit one-letter or number+unit requirements.
    title_axes: compileAxes(options),
  };
}

export function buildReplacementSelectionPlan(
  userMessage: string,
  anchorState: CatalogSearchState,
): ReplacementSelectionPlan {
  return {
    mode: "replacement",
    anchor_state: anchorState,
    source_identifiers: extractReplacementLookupKeys(userMessage).modelCodes,
    portable_requirements: extractPortableTechnicalRequirements(userMessage)
      .map((value) => ({ value, source: "user_literal" as const })),
  };
}

/**
 * This hint communicates server evidence, not a replacement decision. The
 * consultant keeps ownership of product-class reasoning while being prevented
 * from repeating a lookup that the server already proved unproductive.
 */
export function selectionPlanSystemHint(
  plan: ReplacementSelectionPlan | null,
): string {
  if (!plan || plan.anchor_state !== "anchor_missing") return "";
  const explicit = plan.portable_requirements.map((item) => item.value).join(
    ", ",
  );
  return [
    "<selection_plan>",
    "Сервер уже проверил точные идентификаторы исходной модели и не нашёл её карточку в актуальном каталоге.",
    "Не повторяй поиск исходной модели и не завершай ответ только из-за отсутствующего якоря.",
    "Опирайся на собственное уже сформулированное рассуждение о классе товара: открой живую категорию и ищи кандидатов по буквальным требованиям пользователя и подтверждённым live-фасетам.",
    "Не превращай модельную догадку о характеристике в обязательный параметр, пока она не подтверждена каталогом.",
    explicit
      ? `Буквальные переносимые требования пользователя: ${explicit}.`
      : "Буквальные переносимые технические требования в запросе не извлечены.",
    "Если найдены только кандидаты того же класса без доказанной эквивалентности, честно назови их возможными вариантами для дальнейшей сверки.",
    "</selection_plan>",
  ].join("\n");
}
