import {
  extractPortableTechnicalRequirements,
  extractReplacementLookupKeys,
} from "./replacement-preflight.ts";
import type { CatalogSearchState } from "./catalog-search-outcome.ts";
import { projectCriteriaFacetOptions, type CriteriaFacet, type Criterion } from "./criteria-gate.ts";
import { alignCriteriaImportanceWithReasoning } from "./criteria-reasoning.ts";
import {
  dropImplicitReplacementIdentityCriteria,
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

function compileAxes(
  source: Record<string, string[]>,
  facets: Array<SearchFacet & CriteriaFacet>,
): ReplacementReasoningContract["axes"] {
  return Object.entries(source).flatMap(([key, values]) => {
    const facet = facets.find((candidate) => candidate.key === key);
    if (!facet || values.length === 0) return [];
    return [{
      key,
      caption: facet.caption || key,
      values: [...values],
      unit: facet.unit ?? null,
    }];
  });
}

function normalizeWords(value: string): string {
  return String(value ?? "")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е")
    .replace(/[^a-zа-я0-9]+/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeVisibleCode(value: string): string {
  const lookalikes: Record<string, string> = {
    а: "a",
    в: "b",
    е: "e",
    к: "k",
    м: "m",
    н: "h",
    о: "o",
    р: "p",
    с: "c",
    т: "t",
    у: "y",
    х: "x",
  };
  return normalizeWords(value).replace(/\s+/gu, "").replace(
    /[авекмнорстух]/gu,
    (char) => lookalikes[char] ?? char,
  );
}

function sourceTechnicalLiterals(sourceMessage: string): {
  codes: Set<string>;
  standaloneCodes: Set<string>;
  words: string;
} {
  const codes = new Set<string>();
  for (
    const token of String(sourceMessage ?? "").match(/[\p{L}\p{N}]+/gu) ?? []
  ) {
    const normalized = normalizeVisibleCode(token);
    if (/\p{L}/u.test(normalized) && /\d/u.test(normalized)) {
      codes.add(normalized);
    }
  }
  const portableRequirements = extractPortableTechnicalRequirements(
    sourceMessage,
  );
  for (const portable of portableRequirements) {
    const normalized = normalizeVisibleCode(portable);
    if (normalized) codes.add(normalized);
  }
  const standaloneCodes = new Set<string>();
  // A bare trailing letter in a spaced SKU is still source identity. Accept a
  // standalone compact value only alongside another independently extracted
  // portable code (for example `1P 16A C`).
  if (portableRequirements.length > 0) {
    for (
      const match of String(sourceMessage ?? "").matchAll(
        /(?<![\p{L}\p{N}-])([A-ZА-ЯЁ])(?![\p{L}\p{N}-])/gu,
      )
    ) {
      const normalized = normalizeVisibleCode(match[1]);
      if (normalized) standaloneCodes.add(normalized);
    }
  }
  return { codes, standaloneCodes, words: normalizeWords(sourceMessage) };
}

function axisCodeFragments(
  axis: ReplacementReasoningContract["axes"][number],
): string[] {
  const fragments = new Set<string>();
  for (const rawValue of axis.values) {
    const valueWords = normalizeWords(rawValue);
    const value = normalizeVisibleCode(valueWords);
    if (!value) continue;
    fragments.add(value);
    const withoutGenericType = normalizeVisibleCode(
      valueWords.replace(/^(?:тип|type)(?:\s+|$)/u, ""),
    );
    if (withoutGenericType) fragments.add(withoutGenericType);
    const unit = normalizeVisibleCode(axis.unit ?? "");
    if (unit && /^\d+(?:\.\d+)?$/u.test(value)) {
      fragments.add(`${value}${unit}`);
      fragments.add(`${unit}${value}`);
    }
  }
  return [...fragments];
}

/**
 * A missing source card cannot prove that a decoded model-name property
 * belongs to that source. Keep only axes literally present in the request or
 * structurally encoded by one complete customer-visible code (`16A`, `C16`).
 * Two axes may jointly decode a compact code, but a numeric prefix inside a
 * longer SKU (`10` inside `ACH-10001-C`) is never sufficient on its own.
 */
function literalBackedReplacementOptionKeys(
  options: Record<string, string[]>,
  facets: Array<SearchFacet & CriteriaFacet>,
  sourceMessage: string,
): Set<string> {
  const axes = compileAxes(options, facets);
  const literals = sourceTechnicalLiterals(sourceMessage);
  const supported = new Set<string>();
  const fragments = new Map(
    axes.map((axis) => [axis.key, axisCodeFragments(axis)]),
  );

  for (const axis of axes) {
    const rawValues = axis.values.map(normalizeWords).filter(Boolean);
    const wordBacked = rawValues.some((value) =>
      value.length >= 2 && /\p{L}/u.test(value) &&
      ` ${literals.words} `.includes(` ${value} `)
    );
    const codeBacked = (fragments.get(axis.key) ?? []).some((fragment) =>
      literals.codes.has(fragment) ||
      fragment.length === 1 && literals.standaloneCodes.has(fragment)
    );
    if (wordBacked || codeBacked) supported.add(axis.key);
  }

  for (let leftIndex = 0; leftIndex < axes.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < axes.length;
      rightIndex += 1
    ) {
      const left = axes[leftIndex];
      const right = axes[rightIndex];
      const pairBacked = (fragments.get(left.key) ?? []).some((leftFragment) =>
        (fragments.get(right.key) ?? []).some((rightFragment) =>
          literals.codes.has(`${leftFragment}${rightFragment}`) ||
          literals.codes.has(`${rightFragment}${leftFragment}`)
        )
      );
      if (pairBacked) {
        supported.add(left.key);
        supported.add(right.key);
      }
    }
  }
  return supported;
}

function pickOptions(
  options: Record<string, string[]>,
  keys: Set<string>,
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(options)
      .filter(([key, values]) => keys.has(key) && values.length > 0)
      .map(([key, values]) => [key, [...values]]),
  );
}

/**
 * Turns final structured replacement criteria into live, title-verifiable
 * axes. Source identity is removed first. The render guard later accepts only
 * codes that were also explicit in the consultant's reasoning.
 */
export function compileReplacementRenderTitleAxes(
  facets: Array<SearchFacet & CriteriaFacet>,
  criteria: Criterion[],
  sourceMessage: string,
  literalOnly = false,
): ReplacementReasoningContract["title_axes"] {
  const identityFree = dropImplicitReplacementIdentityCriteria(
    Array.isArray(criteria) ? criteria : [],
    facets,
    sourceMessage,
  );
  const projected = projectCriteriaFacetOptions(
    identityFree.criteria.map((criterion) => ({
      ...criterion,
      level: "A" as const,
    })),
    facets,
  );
  const options = literalOnly
    ? pickOptions(
      projected.options,
      literalBackedReplacementOptionKeys(
        projected.options,
        facets,
        sourceMessage,
      ),
    )
    : projected.options;
  return compileAxes(options, facets);
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
  frozenUserCriteria: Criterion[] = [],
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
  const options =
    identityFree.args.options && typeof identityFree.args.options === "object"
      ? identityFree.args.options as Record<string, string[]>
      : {};
  const criteria: Criterion[] = Object.entries(options).flatMap(
    ([key, values]) => {
      const facet = facets.find((candidate) => candidate.key === key);
      return values.map((value) => ({
        key: facet?.caption || key,
        op: "eq" as const,
        value,
        unit: facet?.unit ?? undefined,
        level: "A" as const,
      }));
    },
  );
  const userBacked: Criterion[] = guarded.user_backed.map(({ key, value }) => {
    const facet = facets.find((candidate) => candidate.key === key);
    return {
      key: facet?.caption || key,
      op: "eq",
      value,
      unit: facet?.unit ?? undefined,
      level: "A",
    };
  });
  const importance = alignCriteriaImportanceWithReasoning(
    criteria,
    reasoningText,
    userBacked,
  );
  const userBackedKeys = new Set(guarded.user_backed.map(({ key }) => key));
  const literalBackedKeys = literalBackedReplacementOptionKeys(
    options,
    facets,
    sourceMessage,
  );
  const provenKeys = new Set([...userBackedKeys, ...literalBackedKeys]);
  const mandatory = importance.criteria.filter((criterion) => {
    if ((criterion.level ?? "A") !== "A") return false;
    const facet = facets.find((candidate) => {
      const label = normalizeWords(criterion.key);
      return normalizeWords(candidate.key) === label ||
        normalizeWords(candidate.caption ?? "") === label;
    });
    return Boolean(facet && provenKeys.has(facet.key));
  });
  const frozenIdentityFree = dropImplicitReplacementIdentityCriteria(
    Array.isArray(frozenUserCriteria) ? frozenUserCriteria : [],
    facets,
    sourceMessage,
  ).criteria.filter((criterion) => (criterion.level ?? "A") === "A");
  // The same proof-qualified contract must shape retrieval, rendering and
  // title verification. This prevents a literal customer requirement from
  // being enforced only after broad retrieval has already discarded it.
  const projected = projectCriteriaFacetOptions(
    [...mandatory, ...frozenIdentityFree],
    facets,
  );
  const literalTitleOptions = pickOptions(options, provenKeys);
  const titleOptions = {
    ...literalTitleOptions,
    ...projected.options,
  };
  const unproven = criteria.flatMap((criterion) => {
    const facet = facets.find((candidate) => {
      const label = normalizeWords(criterion.key);
      return normalizeWords(candidate.key) === label ||
        normalizeWords(candidate.caption ?? "") === label;
    });
    return facet && provenKeys.has(facet.key) ? [] : [criterion.key];
  });
  return {
    criteria: projected.proven_criteria,
    options: projected.options,
    demoted: [...new Set([...importance.demoted, ...unproven])],
    axes: compileAxes(projected.options, facets),
    // Advisory axes can become title obligations only when the customer's own
    // wording/code structurally contains them. Frozen customer criteria join
    // those literal axes, but live facet vocabulary alone remains insufficient
    // evidence about an unavailable source SKU.
    title_axes: compileAxes(titleOptions, facets),
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
