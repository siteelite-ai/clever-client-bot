// V3 — Layer 5 контракта «обещал = показал»: РАССУЖДЕНИЕ МОДЕЛИ — ИСТОЧНИК ИСТИНЫ.
//
// ПРОБЛЕМА (системная): клиент называет ЧИСЛО (например, размер своей детали),
// а подбирать надо товар, чей параметр этому числу не равен, а находится ПО ОДНУ
// СТОРОНУ от него. Модель это понимает и проговаривает клиенту словами
// («нужен диаметр больше 12 мм»), но в машинные criteria[] отправляет то число,
// которое видит в реплике: `op:"eq", value:12`. Гейт (Layer 2) сверяет карточки
// с criteria[], прозу он не читает, поэтому «ровно 12» проходит — и клиент видит
// то, что модель сама только что назвала неподходящим.
//
// РЕШЕНИЕ: сервер читает прозу модели и выравнивает по ней ОПЕРАТОР критерия.
// Направление подбора (больше / меньше / диапазон) берётся из рассуждения, а не
// из того, как число выглядело в чате. Сам ПОРОГ при этом не выдумывается —
// используется число, которое модель назвала вслух.
//
// Модуль ЧИСТЫЙ и DATA-AGNOSTIC: только числа, единицы и направляющие слова —
// никаких доменных ключей, категорий, брендов.

import { projectCriteriaFacetOptions, type CriteriaFacet, type Criterion } from "./criteria-gate.ts";
import { extractClientQuantities, normalizeUnit } from "./criteria-consistency.ts";

export interface ReasoningBound {
  op: "min" | "max";
  value: number;
  unit: string;
  /** «больше 12» — строго больше; «не менее 12» — включительно. */
  strict: boolean;
}

export interface ReasoningAlignment {
  key: string;
  from: string;
  to: "min" | "max";
  value: number;
  unit: string;
  strict: boolean;
}

export interface ReasoningRangeProjection {
  criteria: Criterion[];
  added: Criterion[];
}

export interface LiteralMeasuredProjection {
  criteria: Criterion[];
  added: Criterion[];
}

export interface CriteriaImportanceAlignment {
  criteria: Criterion[];
  demoted: string[];
}

export interface FrozenCriteriaAlignment {
  criteria: Criterion[];
  demoted: string[];
}

export interface MeasuredReasoningSearchContract {
  criteria: Criterion[];
  mandatory_criteria: Criterion[];
  projected_criteria: Criterion[];
  options: Record<string, string[]>;
  demoted: string[];
  unmatched_keys: string[];
}

const NUM = String.raw`\d+(?:[.,]\d+)?`;
const UNIT = String.raw`[a-zа-я°]{1,6}[²³]?\d?`;

function normalizeEvidence(value: unknown): string {
  return String(value ?? "")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function criteriaIdentityMatches(left: Criterion, right: Criterion): boolean {
  const leftKey = normalizeEvidence(left.key);
  const rightKey = normalizeEvidence(right.key);
  if (!leftKey || !rightKey || !(leftKey === rightKey || leftKey.includes(rightKey) || rightKey.includes(leftKey))) return false;
  const leftValue = normalizeEvidence(Array.isArray(left.value) ? left.value.join(" ") : left.value);
  const rightValue = normalizeEvidence(Array.isArray(right.value) ? right.value.join(" ") : right.value);
  return !leftValue || !rightValue || leftValue === rightValue;
}

function clauseSupportsCriterion(clause: string, criterion: Criterion): boolean {
  const normalizedClause = normalizeEvidence(clause);
  if (!normalizedClause) return false;
  const rawValues = Array.isArray(criterion.value) ? criterion.value : [criterion.value];
  const valueSupported = rawValues.some((value) => {
    const normalized = normalizeEvidence(value);
    return normalized.length >= 2 && normalizedClause.includes(normalized);
  });
  if (valueSupported) return true;
  const keyTokens = normalizeEvidence(criterion.key).split(" ").filter((token) => token.length >= 4);
  const shortCodeSupported = rawValues.some((value) => {
    const normalized = normalizeEvidence(value);
    const shortCodes = normalized.split(" ").filter((token) => token.length === 1 && /\p{L}/u.test(token));
    if (shortCodes.length === 0) return false;
    const visual = (token: string) => ({ а: "a", в: "b", е: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x" }[token] ?? token);
    return shortCodes.some((code) => normalizedClause.split(" ").some((token) => token.length === 1 && visual(token) === visual(code))) &&
      keyTokens.some((token) => normalizedClause.includes(token));
  });
  if (shortCodeSupported) return true;
  return keyTokens.length > 0 && keyTokens.every((token) => normalizedClause.includes(token));
}

/**
 * A consultant may explain useful defaults without declaring them mandatory
 * ("preferable", "probably", "for comfort"). Model-supplied level A must not
 * turn such advice into an empty hard intersection. Only user-backed criteria
 * or clauses with explicit necessity/limit language remain mandatory.
 */
export function alignCriteriaImportanceWithReasoning(
  criteria: Criterion[],
  reasoningText: string,
  userBackedCriteria: Criterion[] = [],
  protectedReasoningCriteria: Criterion[] = [],
): CriteriaImportanceAlignment {
  const clauses = String(reasoningText ?? "").split(/(?<=[.!?;])|\n+/u).map((clause) => clause.trim()).filter(Boolean);
  const mandatory = /(?:обязат|необходим|нуж(?:ен|на|но|ны)|треб(?:уется|уем|ование)|долж(?:ен|на|но|ны)|ключев\p{L}*\s+параметр\p{L}*|не\s+менее|не\s+более|минимум|максимум|точно|значит|счита|расчет|получа|итого|составля|[=×])/iu;
  const advisory = /(?:логичн|предпочт|скорее\s+всего|желатель|комфортн|уютн|можно|например|по\s+желанию|кому\s+как)/iu;
  const demoted: string[] = [];
  const aligned = (Array.isArray(criteria) ? criteria : []).map((criterion) => {
    if (!criterion || (criterion.level ?? "A") !== "A") return { ...criterion };
    if (
      userBackedCriteria.some((candidate) => criteriaIdentityMatches(criterion, candidate)) ||
      protectedReasoningCriteria.some((candidate) => criteriaIdentityMatches(criterion, candidate))
    ) return { ...criterion, level: "A" as const };
    const relevant = clauses.filter((clause) => clauseSupportsCriterion(clause, criterion));
    if (relevant.some((clause) => mandatory.test(clause))) return { ...criterion, level: "A" as const };
    if (relevant.length === 0 || relevant.some((clause) => advisory.test(clause)) || !relevant.some((clause) => mandatory.test(clause))) {
      demoted.push(criterion.key);
      return { ...criterion, level: "B" as const };
    }
    return { ...criterion };
  });
  return { criteria: aligned, demoted };
}

/**
 * Freeze a selection's hard contract at retrieval time. A criterion
 * invented only for render did not shape the candidate pool and cannot make
 * that pool retroactively empty. User-backed, guarded-search and structurally
 * projected reasoning criteria are supplied as `frozenCriteria` and stay A.
 */
export function demoteUnfrozenRenderCriteria(
  criteria: Criterion[],
  frozenCriteria: Criterion[],
): FrozenCriteriaAlignment {
  const frozen = Array.isArray(frozenCriteria) ? frozenCriteria : [];
  const demoted: string[] = [];
  const aligned = (Array.isArray(criteria) ? criteria : []).map((criterion) => {
    if (!criterion || (criterion.level ?? "A") !== "A") return { ...criterion };
    if (frozen.some((candidate) => criteriaIdentityMatches(criterion, candidate))) {
      return { ...criterion, level: "A" as const };
    }
    demoted.push(criterion.key);
    return { ...criterion, level: "B" as const };
  });
  return { criteria: aligned, demoted };
}

/**
 * Compile an ordinary selection's measured reasoning into the exact values of
 * the live catalog facets before search. This closes the gap where the model
 * states a calculated range, but serializes only unrelated preference filters:
 * the same range then governs both candidate retrieval and final rendering.
 *
 * Projected ranges are protected from wording-based importance demotion. Their
 * origin is structural (an explicit measured range mapped to one live facet),
 * so equivalent phrases cannot randomly switch the contract between A and B.
 */
export function compileMeasuredReasoningSearchContract(
  criteria: Criterion[],
  reasoningText: string,
  userBackedCriteria: Criterion[],
  facets: Array<CriteriaFacet & { type: string }>,
): MeasuredReasoningSearchContract {
  const projected = projectReasoningRangeCriteria(criteria, reasoningText, facets);
  const importance = alignCriteriaImportanceWithReasoning(
    projected.criteria,
    reasoningText,
    userBackedCriteria,
    projected.added,
  );
  const mandatory = importance.criteria.filter((criterion) => (criterion.level ?? "A") === "A");
  const facetProjection = projectCriteriaFacetOptions(mandatory, facets);
  return {
    criteria: importance.criteria,
    mandatory_criteria: mandatory,
    projected_criteria: projected.added,
    options: facetProjection.options,
    demoted: importance.demoted,
    unmatched_keys: facetProjection.unmatched_keys,
  };
}

/** Measured reasoning must be represented by at least one render criterion.
 * Bare structural markings such as 2×1.5 have no unit and remain under the
 * existing exact-compound policy. */
export function hasMeasuredSelectionRequirement(text: string): boolean {
  const value = String(text ?? "").toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
  // Do not reinterpret a numeric suffix inside a hyphenated model identifier
  // (`ABC-03-100W`) as a measured requirement. Standalone `100W` remains a
  // valid customer literal and is handled by the ordinary quantity projector.
  const re = new RegExp(String.raw`(?<![a-zа-я0-9-])\d+(?:[.,]\d+)?(?:\s*[–—-]\s*\d+(?:[.,]\d+)?)?\s*(${UNIT})(?![a-zа-я])`, "giu");
  for (let match; (match = re.exec(value)) !== null;) {
    const unit = normalizeUnit(match[1]);
    if (!unit || /^(шт|штук|раз|года?|лет|мин|сек)$/u.test(unit)) continue;
    const clauseStart = Math.max(
      value.lastIndexOf(".", match.index),
      value.lastIndexOf("!", match.index),
      value.lastIndexOf("?", match.index),
      value.lastIndexOf("\n", match.index),
    ) + 1;
    const nextStops = [".", "!", "?", "\n"]
      .map((separator) => value.indexOf(separator, re.lastIndex))
      .filter((index) => index >= 0);
    const clauseEnd = nextStops.length > 0 ? Math.min(...nextStops) : value.length;
    const clause = value.slice(clauseStart, clauseEnd);
    const explicitRange = /\d+(?:[.,]\d+)?\s*[–—-]\s*\d+(?:[.,]\d+)?/u.test(match[0]);
    const obligation = /(?:нуж|необходим|долж|треб|минимум|максимум|не\s+менее|не\s+более|больше|меньше|свыше|до\s+\d|от\s+\d|ориентир|диапазон|расчет|счита|получа|итого|составля|подбира|выбира|[≈=×])/iu.test(clause);
    // Measurements used only to describe a typical product ("обычно 220 В",
    // "часто 10 Вт") are catalog narration, not selection requirements.
    if (explicitRange || obligation) return true;
  }
  return false;
}

function canonicalMeasurementUnit(raw: string): string {
  const unit = normalizeUnit(raw);
  const aliases: Record<string, string> = {
    ватт: "вт", ватта: "вт", ваттов: "вт", watt: "вт", watts: "вт", w: "вт",
    люмен: "лм", люмена: "лм", люменов: "лм", lumen: "лм", lumens: "лм", lm: "лм",
    вольт: "в", вольта: "в", вольтов: "в", volt: "в", volts: "в", v: "в",
    ампер: "а", ампера: "а", амперов: "а", amp: "а", amps: "а",
  };
  return aliases[unit] ?? unit;
}

/** A measured requirement stated in the consultant's prose is mandatory even
 * if the model accidentally serializes it as level B. */
export function promoteMeasuredReasoningCriteria(
  criteria: Criterion[],
  reasoningText: string,
): { criteria: Criterion[]; promoted: string[] } {
  const reasoningUnits = new Set(
    extractClientQuantities(reasoningText).map((quantity) => canonicalMeasurementUnit(quantity.unit)),
  );
  const promoted: string[] = [];
  const next = (Array.isArray(criteria) ? criteria : []).map((criterion) => {
    const numeric = typeof criterion.value === "number" ||
      Array.isArray(criterion.value) && criterion.value.every((value) => Number.isFinite(Number(value)));
    const unit = canonicalMeasurementUnit(criterion.unit ?? "");
    if ((criterion.level ?? "A") !== "B" || !numeric || !unit || !reasoningUnits.has(unit)) return { ...criterion };
    promoted.push(criterion.key);
    return { ...criterion, level: "A" as const };
  });
  return { criteria: next, promoted };
}

/**
 * An ordinary selection must not reach render with only advisory criteria when
 * the model did serialize a measurable catalog constraint. If there is no A
 * criterion at all, promote only numeric B criteria that compile to one exact
 * live facet with at least one valid value. The live schema supplies the proof;
 * no product vocabulary is involved.
 */
export function promoteProjectableMeasuredFallbackCriteria(
  criteria: Criterion[],
  facets: CriteriaFacet[],
  excludedCriteria: string[] = [],
): { criteria: Criterion[]; promoted: string[] } {
  const source = (Array.isArray(criteria) ? criteria : []).map((criterion) => ({ ...criterion }));
  if (source.some((criterion) => (criterion.level ?? "A") === "A")) {
    return { criteria: source, promoted: [] };
  }
  const excludedKeys = new Set(
    (Array.isArray(excludedCriteria) ? excludedCriteria : []).map(normalizeEvidence).filter(Boolean),
  );
  const candidates = source
    .filter((criterion) => {
      const numeric = typeof criterion.value === "number" ||
        Array.isArray(criterion.value) && criterion.value.every((value) => Number.isFinite(Number(value)));
      return (criterion.level ?? "A") === "B" && numeric && !excludedKeys.has(normalizeEvidence(criterion.key));
    })
    .map((criterion) => ({ ...criterion, level: "A" as const }));
  const projection = projectCriteriaFacetOptions(candidates, facets);
  const promoted: string[] = [];
  const next = source.map((criterion) => {
    if (!projection.proven_criteria.some((candidate) => criteriaIdentityMatches(criterion, candidate))) return criterion;
    promoted.push(criterion.key);
    return { ...criterion, level: "A" as const };
  });
  return { criteria: next, promoted };
}

/** Projects explicit numeric ranges from the consultant's own prose onto a
 * unique live numeric facet with the same unit. This is the server-side bridge
 * from reasoning to criteria; no product/category vocabulary is embedded. */
export function projectReasoningRangeCriteria(
  criteria: Criterion[],
  reasoningText: string,
  facets: Array<{ key: string; caption: string; type: string; unit: string | null; values?: Array<{ value: string }> }>,
): ReasoningRangeProjection {
  const next = (Array.isArray(criteria) ? criteria : []).map((criterion) => ({ ...criterion }));
  const added: Criterion[] = [];
  const text = String(reasoningText ?? "").toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
  const ranges: Array<{ low: number; high: number; unit: string; context: string }> = [];
  const rangePatterns = [
    new RegExp(String.raw`(?<![a-zа-я0-9-])(${NUM})\s*[–—-]\s*(${NUM})\s*([a-zа-я°]{1,10}[²³]?\d?)(?![a-zа-я])`, "giu"),
    new RegExp(String.raw`от\s+(${NUM})\s+до\s+(${NUM})\s*([a-zа-я°]{1,10}[²³]?\d?)(?![a-zа-я])`, "giu"),
  ];
  for (const re of rangePatterns) {
    for (let match; (match = re.exec(text)) !== null;) {
      const first = Number(match[1].replace(",", "."));
      const second = Number(match[2].replace(",", "."));
      const unit = canonicalMeasurementUnit(match[3]);
      if (!Number.isFinite(first) || !Number.isFinite(second) || !unit) continue;
      const candidate = {
        low: Math.min(first, second),
        high: Math.max(first, second),
        unit,
        context: text.slice(Math.max(0, match.index - 90), Math.min(text.length, re.lastIndex + 30)),
      };
      if (!ranges.some((range) => range.low === candidate.low && range.high === candidate.high && range.unit === candidate.unit)) {
        ranges.push(candidate);
      }
    }
  }
  // Preserve the interval behind a verified arithmetic estimate. Models may
  // correctly state an input range, calculate its midpoint and then serialize
  // only the midpoint as a product requirement. If the prose contains
  //   scalar unit × midpoint unit ≈ result resultUnit
  // and the midpoint belongs to exactly one explicit range of the same unit,
  // derive scalar×[low,high] in the result unit. This is unit/arithmetic based:
  // no category, product or parameter names are embedded.
  const calculations = new RegExp(
    String.raw`(${NUM})\s*(${UNIT})\s*[×xх*]\s*(${NUM})\s*(${UNIT})[^\n]{0,60}?[≈=][\s*_~≈]*(${NUM})\s*(${UNIT})(?![a-zа-я])`,
    "giu",
  );
  for (let match; (match = calculations.exec(text)) !== null;) {
    const factor = Number(match[1].replace(",", "."));
    const midpoint = Number(match[3].replace(",", "."));
    const statedResult = Number(match[5].replace(",", "."));
    const midpointUnit = canonicalMeasurementUnit(match[4]);
    const resultUnit = canonicalMeasurementUnit(match[6]);
    if (![factor, midpoint, statedResult].every(Number.isFinite) || factor <= 0 || midpoint <= 0 || !midpointUnit || !resultUnit) continue;
    const expectedResult = factor * midpoint;
    if (Math.abs(expectedResult - statedResult) > Math.max(1, expectedResult * 0.02)) continue;
    const sourceRanges = ranges.filter((range) =>
      range.unit === midpointUnit && midpoint >= range.low && midpoint <= range.high
    );
    if (sourceRanges.length !== 1) continue;
    const source = sourceRanges[0];
    const candidate = {
      low: factor * source.low,
      high: factor * source.high,
      unit: resultUnit,
      context: text.slice(Math.max(0, match.index - 60), Math.min(text.length, calculations.lastIndex + 30)),
    };
    if (!ranges.some((range) => range.low === candidate.low && range.high === candidate.high && range.unit === candidate.unit)) {
      ranges.push(candidate);
    }
  }
  for (const range of ranges) {
    // Multiple ranges with the same unit usually describe different product
    // parameters/states. Mapping both onto one facet would invent semantics;
    // the structured compatibility contract must identify their live keys.
    if (ranges.filter((candidate) => candidate.unit === range.unit).length !== 1) continue;
    const unitFacets = (facets ?? []).filter((facet) => {
      const hasNumericLiveValues = (facet.values ?? []).some(({ value }) =>
        /\d+(?:[.,]\d+)?/u.test(String(value ?? ""))
      );
      const declaredUnit = canonicalMeasurementUnit(facet.unit ?? "");
      const publicLabel = String(facet.caption ?? "").trim() || facet.key;
      const labelHasUnit = publicLabel
        .match(/[a-zа-я°]{1,10}[²³]?\d?/giu)
        ?.some((token) => canonicalMeasurementUnit(token) === range.unit) ?? false;
      return (facet.type === "number" || hasNumericLiveValues) &&
        (declaredUnit === range.unit || labelHasUnit);
    });
    const sameUnitHints = next.filter((criterion) =>
      canonicalMeasurementUnit(criterion.unit ?? "") === range.unit
    );
    const hintedFacets = unitFacets.filter((facet) => {
      const labels = [facet.key, facet.caption].map((value) =>
        String(value ?? "").toLocaleLowerCase("ru-RU").replace(/ё/g, "е").replace(/[^a-zа-я0-9]+/giu, " ").trim()
      );
      return sameUnitHints.some((criterion) => {
        const wanted = String(criterion.key ?? "").toLocaleLowerCase("ru-RU").replace(/ё/g, "е").replace(/[^a-zа-я0-9]+/giu, " ").trim();
        return wanted.length >= 4 && labels.some((label) => label === wanted || label.includes(wanted) || wanted.includes(label));
      });
    });
    const contextTokens = new Set(
      range.context.match(/[a-zа-я]{4,}/giu)?.map((token) => token.toLocaleLowerCase("ru-RU").replace(/ё/g, "е")) ?? [],
    );
    const contextualScores = unitFacets.map((facet) => {
      const labelTokens = `${facet.key} ${facet.caption}`
        .match(/[a-zа-я]{4,}/giu)?.map((token) => token.toLocaleLowerCase("ru-RU").replace(/ё/g, "е")) ?? [];
      return { facet, score: labelTokens.filter((token) => contextTokens.has(token)).length };
    });
    const bestContextScore = Math.max(0, ...contextualScores.map(({ score }) => score));
    const contextualFacets = contextualScores
      .filter(({ score }) => score > 0 && score === bestContextScore)
      .map(({ facet }) => facet);
    const matchingFacets = hintedFacets.length === 1
      ? hintedFacets
      : contextualFacets.length === 1 ? contextualFacets : unitFacets;
    if (matchingFacets.length !== 1) continue;
    const alreadyRepresented = next.some((criterion) => {
      if (canonicalMeasurementUnit(criterion.unit ?? "") !== range.unit) return false;
      if (criterion.op === "range" && Array.isArray(criterion.value)) {
        return Number(criterion.value[0]) === range.low && Number(criterion.value[1]) === range.high;
      }
      return false;
    });
    if (alreadyRepresented) continue;
    const facet = matchingFacets[0];
    const criterion: Criterion = { key: facet.caption || facet.key, op: "range", value: [range.low, range.high], unit: facet.unit ?? range.unit, level: "A" };
    next.push(criterion);
    added.push(criterion);
  }
  return { criteria: next, added };
}

/**
 * Projects literal measured values from the customer's own message onto a
 * unique live facet. Catalogs commonly store a value and its unit separately
 * (for example value `16` in a facet whose unit is `A`), so code-like string
 * matching cannot preserve such a requirement across a recovery search.
 *
 * Safety boundaries:
 * - the number always comes from the customer, never from model prose;
 * - a directional statement for the same number/unit is left to the range/
 *   bound contract instead of being narrowed to equality;
 * - a live exact value and one unambiguous facet are both required;
 * - no category, product or parameter vocabulary is embedded here.
 */
export function projectLiteralMeasuredCriteria(
  criteria: Criterion[],
  customerText: string,
  reasoningText: string,
  facets: Array<{ key: string; caption: string; type: string; unit: string | null; values?: Array<{ value: string }> }>,
): LiteralMeasuredProjection {
  const next = (Array.isArray(criteria) ? criteria : []).map((criterion) => ({ ...criterion }));
  const added: Criterion[] = [];
  const bounds = collapseBounds(extractReasoningBounds(reasoningText));
  const quantities = extractClientQuantities(customerText);

  for (const quantity of quantities) {
    const unit = canonicalMeasurementUnit(quantity.unit);
    if (!unit) continue;
    if (bounds.some((bound) =>
      canonicalMeasurementUnit(bound.unit) === unit && bound.value === quantity.value
    )) continue;

    const unitFacets = (facets ?? []).filter((facet) => {
      const declaredUnit = canonicalMeasurementUnit(facet.unit ?? "");
      const publicLabel = String(facet.caption ?? "").trim() || facet.key;
      const labelHasUnit = publicLabel
        .match(/[a-zа-я°]{1,10}[²³]?\d?/giu)
        ?.some((token) => canonicalMeasurementUnit(token) === unit) ?? false;
      // Some catalog branches omit `unit` even for numeric facets. A unitless
      // fallback is safe only when no suffix declares another scale and the
      // remaining exact-value facet is unique. Example schema shape:
      // `Nominal current` values [6,16] vs `Cable section, mm2` values [6,16].
      const captionSuffix = String(facet.caption ?? "").split(",").slice(1).join(" ");
      const suffixDeclaresAnotherUnit = captionSuffix
        .match(/[a-zа-я°]{1,10}[²³]?\d?/giu)
        ?.some((token) => canonicalMeasurementUnit(token) !== unit) ?? false;
      const hasExplicitUnitEvidence = Boolean(declaredUnit) || labelHasUnit || Boolean(captionSuffix.trim());
      if (
        declaredUnit !== unit && !labelHasUnit &&
        (hasExplicitUnitEvidence || suffixDeclaresAnotherUnit)
      ) return false;
      return (facet.values ?? []).some(({ value }) => {
        const span = parseNumericFacetValue(value);
        return span !== null && span.min === quantity.value && span.max === quantity.value;
      });
    });
    if (unitFacets.length === 0) continue;

    const sameUnitHints = next.filter((criterion) =>
      canonicalMeasurementUnit(criterion.unit ?? "") === unit
    );
    const hintedFacets = unitFacets.filter((facet) => {
      const labels = [facet.key, facet.caption].map(normalizeEvidence);
      return sameUnitHints.some((criterion) => {
        const wanted = normalizeEvidence(criterion.key);
        return wanted.length >= 4 && labels.some((label) =>
          label === wanted || label.includes(wanted) || wanted.includes(label)
        );
      });
    });

    const customer = String(customerText ?? "").toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
    const literal = String(quantity.value).replace(".", "[.,]");
    const unitPattern = String(quantity.unit).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const occurrence = customer.search(new RegExp(`${literal}\\s*${unitPattern}(?![a-zа-я])`, "iu"));
    const context = occurrence >= 0
      ? customer.slice(Math.max(0, occurrence - 60), Math.min(customer.length, occurrence + 80))
      : customer;
    const contextTokens = new Set(
      context.match(/[a-zа-я]{4,}/giu)?.map((token) => normalizeEvidence(token)) ?? [],
    );
    const contextualScores = unitFacets.map((facet) => {
      const labelTokens = `${facet.key} ${facet.caption}`
        .match(/[a-zа-я]{4,}/giu)?.map((token) => normalizeEvidence(token)) ?? [];
      return { facet, score: labelTokens.filter((token) => contextTokens.has(token)).length };
    });
    const bestContextScore = Math.max(0, ...contextualScores.map(({ score }) => score));
    const contextualFacets = contextualScores
      .filter(({ score }) => score > 0 && score === bestContextScore)
      .map(({ facet }) => facet);
    const matchingFacets = hintedFacets.length === 1
      ? hintedFacets
      : contextualFacets.length === 1 ? contextualFacets : unitFacets;
    if (matchingFacets.length !== 1) continue;

    const facet = matchingFacets[0];
    const liveValue = (facet.values ?? []).find(({ value }) => {
      const span = parseNumericFacetValue(value);
      return span !== null && span.min === quantity.value && span.max === quantity.value;
    })?.value;
    if (liveValue === undefined) continue;
    const alreadyRepresented = next.some((criterion) => {
      const key = normalizeEvidence(criterion.key);
      const facetKey = normalizeEvidence(facet.caption || facet.key);
      if (!(key === facetKey || key.includes(facetKey) || facetKey.includes(key))) return false;
      return criterion.op === "eq" && String(criterion.value) === String(liveValue);
    });
    if (alreadyRepresented) continue;
    const criterion: Criterion = {
      key: facet.caption || facet.key,
      op: "eq",
      value: liveValue,
      unit: facet.unit ?? unit,
      level: "A",
    };
    next.push(criterion);
    added.push(criterion);
  }
  return { criteria: next, added };
}

function parseNumericFacetValue(raw: string): { min: number; max: number } | null {
  const value = String(raw ?? "").trim();
  if (!value || /\d\s*[:xх×]\s*\d/iu.test(value)) return null;
  const match = value.match(new RegExp(String.raw`^\s*(${NUM})(?:\s*[a-zа-я°]{1,10}[²³]?\d?)?\s*$`, "iu"));
  if (!match) return null;
  const number = Number(match[1].replace(",", "."));
  return Number.isFinite(number) ? { min: number, max: number } : null;
}

// Порядок важен: сначала отрицательные формы («не более»), иначе «более»
// перехватит их и направление получится обратным.
const DIRECTIONS: Array<{ re: string; op: "min" | "max"; strict: boolean }> = [
  { re: String.raw`не\s+менее|не\s+меньше|не\s+ниже|минимум|>=|≥`, op: "min", strict: false },
  { re: String.raw`не\s+более|не\s+больше|не\s+выше|максимум|<=|≤`, op: "max", strict: false },
  { re: String.raw`больше|более|свыше|выше|превыша\w*|>`, op: "min", strict: true },
  { re: String.raw`меньше|менее|ниже|<`, op: "max", strict: true },
  { re: String.raw`от`, op: "min", strict: false },
  { re: String.raw`до`, op: "max", strict: false },
];

/**
 * Извлекает из прозы модели направленные числовые утверждения:
 * «не менее 40 мм», «больше 12 мм», «до 15 А».
 * Числа без единицы игнорируются — сопоставить их с критерием нельзя.
 */
export function extractReasoningBounds(text: string): ReasoningBound[] {
  const s = String(text ?? "").toLowerCase().replace(/ё/g, "е");
  const out: ReasoningBound[] = [];
  for (const dir of DIRECTIONS) {
    const re = new RegExp(
      // Отрицательные формы («не более», «не больше») ловятся своим правилом
      // выше; сюда они попадать не должны — иначе направление перевернётся.
      String.raw`(?:^|[^a-zа-я])(?<!не\s)(?:${dir.re})\s*(?:чем\s+)?(${NUM})\s*(${UNIT})(?![a-zа-я])`,
      "gu",
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
      const value = Number(m[1].replace(",", "."));
      const unit = normalizeUnit(m[2]);
      if (!Number.isFinite(value) || !unit) continue;
      if (/^(и|или|на|за|по|шт|штук|раз)$/.test(unit)) continue;
      out.push({ op: dir.op, value, unit, strict: dir.strict });
    }
  }
  return out;
}

function criterionNumber(c: Criterion): number | null {
  if (typeof c.value === "number") return c.value;
  if (typeof c.value === "string") {
    const m = c.value.match(new RegExp(NUM));
    if (m) {
      const n = Number(m[0].replace(",", "."));
      if (Number.isFinite(n)) return n;
    }
  }
  if (Array.isArray(c.value)) {
    const hi = Math.max(Number(c.value[0]), Number(c.value[1]));
    if (Number.isFinite(hi)) return hi;
  }
  return null;
}

/**
 * Схлопывает границы по (единица, число, направление).
 * Внутри группы строгость — по САМОЙ ЖЁСТКОЙ формулировке: если модель хоть раз
 * сказала «больше/меньше», требование строгое, а последующие «≥ / от» его не
 * размывают. Без этого побеждала та формулировка, что раньше попалась парсеру.
 */
export function collapseBounds(bounds: ReasoningBound[]): ReasoningBound[] {
  const byKey = new Map<string, ReasoningBound>();
  for (const b of bounds) {
    const k = `${b.unit}|${b.value}|${b.op}`;
    const prev = byKey.get(k);
    if (!prev) byKey.set(k, { ...b });
    else if (b.strict) prev.strict = true;
  }
  return [...byKey.values()];
}

/**
 * Выравнивает критерии по рассуждению модели.
 *
 * Полномочия слоя строго ограничены:
 * 1. Направление меняется ТОЛЬКО для `op:"eq"` — это исходная задача слоя:
 *    клиент назвал число, модель прислала «ровно X», а прозой сказала
 *    «больше X» → `> X`. Если по этому числу проза дала несколько направлений,
 *    сервер не угадывает (границы уходят в `ambiguities`).
 * 2. Для `min` / `max` / `range` направление модели НЕПРИКОСНОВЕННО: из прозы
 *    берётся только строгость, и только у границы того же направления.
 *    Иначе одна распарсенная граница («больше 10 мм») переворачивала бы
 *    противоположный критерий («после усадки ≤ 10 мм») — и требование
 *    становилось физически невыполнимым.
 * 3. Строгость только ужесточается: нестрогая формулировка не размывает
 *    уже строгий критерий.
 *
 * Порог никогда не выдумывается — используется число, названное вслух.
 */

export function alignCriteriaWithReasoning(
  criteria: Criterion[],
  reasoningText: string,
): { criteria: Criterion[]; alignments: ReasoningAlignment[]; ambiguities: ReasoningBound[] } {
  const bounds = collapseBounds(extractReasoningBounds(reasoningText));
  const list = Array.isArray(criteria) ? criteria : [];
  if (bounds.length === 0 || list.length === 0) return { criteria: list, alignments: [], ambiguities: [] };

  const alignments: ReasoningAlignment[] = [];
  const ambiguities: ReasoningBound[] = [];
  const next = list.map((c) => {
    if (!c || !c.key || (c.level ?? "A") !== "A") return c;
    const unit = normalizeUnit(c.unit ?? "");
    if (!unit) return c;
    const num = criterionNumber(c);
    if (num === null) return c;

    // Совпадение по единице И по числу: это то же самое требование, о котором
    // модель говорила прозой. Без совпадения числа порог не трогаем — иначе
    // сервер начал бы выдумывать величины.
    const candidates = bounds.filter((b) => b.unit === unit && b.value === num);
    if (candidates.length === 0) return c;

    let bound: ReasoningBound | undefined;
    if (c.op === "eq") {
      // Исходная задача слоя: клиент назвал число, модель прислала «ровно X»,
      // а прозой сказала «больше X» → направление берём из прозы.
      // Несколько направлений по одному числу — сервер не угадывает.
      if (candidates.length === 1) bound = candidates[0];
    } else {
      // Направление модель задала осознанно (min / max / range) — сервер его
      // НИКОГДА не переворачивает: из прозы берём только строгость, и только
      // у границы того же направления. Иначе одна распарсенная граница
      // («больше 10 мм») переворачивала бы противоположный критерий
      // («после усадки ≤ 10 мм») и требование становилось невыполнимым.
      bound = candidates.find((b) => b.op === c.op);
    }
    if (!bound) {
      ambiguities.push(...candidates);
      return c;
    }

    // Строгость только ужесточается: если критерий уже строгий, нестрогая
    // формулировка («не менее») его не размывает.
    const strict = bound.strict || (c.op === bound.op && Boolean(c.exclusive));
    if (c.op === bound.op && Boolean(c.exclusive) === strict) return c;

    alignments.push({
      key: c.key,
      from: `${c.op}:${String(c.value)}`,
      to: bound.op,
      value: bound.value,
      unit: c.unit ?? unit,
      strict,
    });
    return { ...c, op: bound.op, value: bound.value, exclusive: strict };

  });

  return { criteria: next, alignments, ambiguities };
}
