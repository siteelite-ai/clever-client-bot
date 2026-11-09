import {
  type CriteriaFacet,
  type Criterion,
  mergeMandatorySelectionCriteria,
} from "./criteria-gate.ts";
import {
  guardSearchFilters,
  projectExplicitCompactFacetValues,
} from "./search-filter-guard.ts";
import {
  projectLiteralMeasuredCriteria,
  projectReasoningRangeCriteria,
} from "./criteria-reasoning.ts";
import { extractBudgetCap } from "./budget-cap.ts";

const axisName = (value: string): string =>
  String(value ?? "")
    .normalize("NFKC").toLocaleLowerCase("ru-RU").replace(/ё/gu, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Resolve only unambiguous schema identities, never substring/similar keys. */
function axis(key: string, facets: readonly CriteriaFacet[]): string {
  const name = axisName(key);
  if (["цена", "стоимость", "бюджет", "price", "budget"].includes(name)) {
    return "catalog:price";
  }
  const matches = facets.filter((facet) =>
    axisName(facet.key) === name || axisName(facet.caption) === name
  );
  return matches.length === 1 ? `facet:${matches[0].key}` : `unmapped:${name}`;
}

export function isDialoguePriceCriterion(criterion: Criterion): boolean {
  return axis(criterion.key, []) === "catalog:price";
}

/** Budget eligibility already has a dedicated gate. Correct an existing
 * price contract, but do not fabricate an unprojectable category facet. */
export function enforceDialogueBudgetCriteria(
  criteria: Criterion[],
  budgetCap: number | null,
): Criterion[] {
  if (budgetCap === null || !criteria.some(isDialoguePriceCriterion)) {
    return criteria;
  }
  return [
    ...criteria.filter((criterion) => !isDialoguePriceCriterion(criterion)),
    {
      key: "Цена",
      op: "max",
      value: budgetCap,
      level: "A",
      evidence: "user_explicit",
    },
  ];
}

/** Currency is a first-class catalog field, independent of category facets. */
export function resolveDialogueBudgetCap(
  priorQueriesNewestFirst: readonly string[],
  current: string,
  priorCriteria: readonly Criterion[] = [],
): number | null {
  const currentCap = extractBudgetCap(current);
  if (currentCap !== null) return currentCap;
  const serverCaps = priorCriteria.filter((criterion) =>
    axis(criterion.key, []) === "catalog:price" && criterion.op === "max" &&
    typeof criterion.value === "number" && Number.isFinite(criterion.value) &&
    criterion.value > 0 && criterion.level !== "B" &&
    (criterion.evidence === "user_explicit" ||
      criterion.evidence === "derived_required")
  ).map((criterion) => Number(criterion.value));
  if (serverCaps.length) return Math.min(...serverCaps);
  for (const query of priorQueriesNewestFirst.slice(0, 9)) {
    const cap = extractBudgetCap(query);
    if (cap !== null) return cap;
  }
  return null;
}

/**
 * A customer turn is a patch, not another extension of the previous turn.
 * Every value on an explicitly updated axis replaces that axis's old family;
 * alternatives inside this one turn remain OR. Independent axes survive.
 * Call only with server-owned prior evidence and current customer evidence.
 * Model/recovery additions must use enforceDialogueSelectionCriteria instead.
 */
export function updateDialogueSelectionCriteria(
  previous: readonly Criterion[],
  customerPatch: readonly Criterion[],
  facets: readonly CriteriaFacet[],
): Criterion[] {
  const patch = mergeMandatorySelectionCriteria([...customerPatch]);
  const replaced = new Set(
    patch.map((criterion) => axis(criterion.key, facets)),
  );
  return mergeMandatorySelectionCriteria([
    ...previous.filter((criterion) =>
      !replaced.has(axis(criterion.key, facets))
    ),
    ...patch,
  ]);
}

/** Within a turn, even a real catalog/model value cannot revive a retired axis. */
export function enforceDialogueSelectionCriteria(
  incoming: readonly Criterion[],
  customerState: readonly Criterion[],
  facets: readonly CriteriaFacet[],
): Criterion[] {
  const owned = new Set(
    customerState.map((criterion) => axis(criterion.key, facets)),
  );
  return [
    ...incoming.filter((criterion) => !owned.has(axis(criterion.key, facets))),
    ...customerState.map((criterion) => ({ ...criterion })),
  ];
}

/**
 * Parse each verified customer message separately. Passing a joined history to
 * the lexical projector would re-authorize every old value as a current OR.
 * There are no product, brand, color or facet dictionaries in this reducer.
 */
export function compileDialogueSelectionCriteria(input: {
  facets: CriteriaFacet[];
  priorQueriesNewestFirst: readonly string[];
  currentEvidence: string;
  priorCriteria?: readonly Criterion[];
  trustedActiveProductTarget?: string | null;
  trustedBaseUserMessage?: string | null;
}): Criterion[] {
  let state: Criterion[] = [];
  const project = (message: string, currentTurn: boolean): Criterion[] => {
    if (!message.trim() || message.length > 8_000) return [];
    const guarded = guardSearchFilters(
      { mode: "by_filter" },
      input.facets,
      message,
      message,
      message,
      [],
      {
        currentUserMessage: message,
        trustedActiveProductTarget: input.trustedActiveProductTarget,
        trustedBaseUserMessage: input.trustedBaseUserMessage,
      },
    );
    const compact = projectExplicitCompactFacetValues(input.facets, message);
    const categorical: Criterion[] = [
      ...guarded.user_backed,
      ...compact.user_backed,
    ]
      .map(({ key, value }) => ({
        key: input.facets.find((facet) => facet.key === key)?.caption || key,
        op: "eq",
        value,
        level: "A",
        evidence: "user_explicit",
      }));
    // Reuse the existing measured-evidence ownership and ambiguity guards.
    // Crucially, do not extract numbers from joined history or model prose.
    const measuredFacets = input.facets.map((facet) => ({
      ...facet,
      type: "string",
    }));
    // Old application measurements are not new product thresholds. Restore
    // their certified criteria from the completed contract below; otherwise
    // leave the existing measurement/destination workflow in charge. Only
    // this turn can introduce a newly stated numeric replacement here.
    const ranges = currentTurn
      ? projectReasoningRangeCriteria([], message, measuredFacets, {
        customerText: message,
      }).added
      : [];
    const literal = currentTurn
      ? projectLiteralMeasuredCriteria(
        [],
        message,
        message,
        measuredFacets,
        categorical,
      ).added
      : [];
    const measured = [...ranges, ...literal].map((criterion) => ({
      ...criterion,
      level: "A" as const,
      evidence: "user_explicit" as const,
    }));
    const budgetCap = extractBudgetCap(message);
    return updateDialogueSelectionCriteria(categorical, [
      ...measured,
      ...(budgetCap === null ? [] : [{
        key: "Цена",
        op: "max" as const,
        value: budgetCap,
        level: "A" as const,
        evidence: "user_explicit" as const,
      }]),
    ], input.facets);
  };
  for (
    const message of [...input.priorQueriesNewestFirst.slice(0, 9)].reverse()
  ) {
    state = updateDialogueSelectionCriteria(
      state,
      project(message, false),
      input.facets,
    );
  }
  // The latest completed contract may include a proven semantic OR family
  // that literal reconstruction cannot recover. It owns the historical axes;
  // only the new customer patch may replace them.
  state = updateDialogueSelectionCriteria(
    state,
    input.priorCriteria ?? [],
    input.facets,
  );
  return updateDialogueSelectionCriteria(
    state,
    project(input.currentEvidence, true),
    input.facets,
  );
}

/** Bounded server-log projection. Browser history/slots never call this reader. */
export function readServerSelectionCriteria(events: unknown): Criterion[] {
  if (!Array.isArray(events) || events.length > 2_000) return [];
  const candidates: unknown[] = [];
  for (const event of events) {
    if (
      !event || typeof event !== "object" || event.type !== "products_block"
    ) continue;
    const criteria = event.selection_contract?.mandatory_criteria;
    if (criteria === undefined) continue; // Backwards-compatible older logs.
    if (!Array.isArray(criteria) || criteria.length > 64) return [];
    candidates.push(...criteria);
  }
  if (candidates.length > 64) return [];
  const result: Criterion[] = [];
  for (const raw of candidates) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const c = raw as Record<string, unknown>;
    if (
      typeof c.key !== "string" || !c.key.trim() || c.key.length > 200 ||
      !["eq", "min", "max", "range"].includes(String(c.op)) ||
      c.level !== undefined && c.level !== "A" ||
      c.evidence !== undefined &&
        !["user_explicit", "derived_required"].includes(String(c.evidence)) ||
      c.unit !== undefined && c.unit !== null &&
        (typeof c.unit !== "string" || c.unit.length > 40) ||
      c.proof_scope !== undefined &&
        c.proof_scope !== "application_suitability" ||
      c.exclusive !== undefined && typeof c.exclusive !== "boolean"
    ) return [];
    if (c.op === "range") {
      if (
        !Array.isArray(c.value) || c.value.length !== 2 ||
        !c.value.every((v) => typeof v === "number" && Number.isFinite(v)) ||
        c.value[0] > c.value[1]
      ) return [];
    } else if (
      !(typeof c.value === "string" && c.value.trim() &&
          c.value.length <= 300 ||
        typeof c.value === "number" && Number.isFinite(c.value))
    ) return [];
    result.push({
      key: c.key,
      op: c.op as Criterion["op"],
      value: Array.isArray(c.value)
        ? [...c.value] as [number, number]
        : c.value as number | string,
      level: "A",
      evidence: c.evidence as Criterion["evidence"],
      ...(c.unit !== undefined ? { unit: c.unit as string | null } : {}),
      ...(c.exclusive !== undefined
        ? { exclusive: c.exclusive as boolean }
        : {}),
      ...(c.proof_scope
        ? { proof_scope: "application_suitability" as const }
        : {}),
    });
  }
  return mergeMandatorySelectionCriteria(result);
}
