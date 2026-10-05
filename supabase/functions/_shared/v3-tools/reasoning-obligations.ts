import type { Criterion } from "./criteria-gate.ts";
import {
  extractClientQuantities,
  normalizeUnit,
} from "./criteria-consistency.ts";
import { extractReasoningBounds } from "./criteria-reasoning.ts";
import { compoundCountFacetValue, guardSearchFilters } from "./search-filter-guard.ts";

export interface ReasoningObligation {
  criterion: Criterion;
  sourceSpan: string;
}

export interface ObligationResolution {
  obligations: ReasoningObligation[];
  unresolved: Array<{ index: number; reason: string }>;
}

export interface ObligationFacet {
  key?: string;
  caption?: string;
  unit?: string | null;
  values?: Array<{ value?: string }>;
}

/** Repair prose/quote formatting only, never replace the selected semantics,
 * live IDs, scope or cardinality with a second model's different answer. */
export function repairObligationDeclaration(
  original: Record<string, unknown>,
  repaired: Record<string, unknown>,
  facets: ObligationFacet[] = [],
  customerEvidence = "",
  confirmedCustomerCriteria: Criterion[] = [],
): Record<string, unknown> | null {
  const before = original.mandatory_properties;
  const after = repaired.mandatory_properties;
  if (
    !Array.isArray(before) || !Array.isArray(after) || before.length === 0 ||
    before.length > 12 || before.length !== after.length ||
    typeof original.reasoning !== "string" ||
    typeof repaired.reasoning !== "string" ||
    repaired.reasoning.length > 1600 ||
    !repaired.reasoning.startsWith(original.reasoning)
  ) return null;
  const signature = (item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const value = item as Record<string, unknown>;
    if (
      typeof value.key !== "string" || typeof value.op !== "string" ||
      !(typeof value.value === "string" || typeof value.value === "number") ||
      typeof value.unit !== "string" || value.scope !== "per_product"
    ) return null;
    return JSON.stringify([
      value.key,
      value.op,
      value.value,
      value.unit,
      value.scope,
    ]);
  };
  const first = before.map(signature).sort();
  const second = after.map(signature).sort();
  if (
    first.some((s) => s === null) || second.some((s) => s === null) ||
    JSON.stringify(first) !== JSON.stringify(second)
  ) return null;
  if (
    resolveReasoningObligations(after, repaired.reasoning, facets, customerEvidence, confirmedCustomerCriteria).unresolved.length > 0
  ) return null;
  return {
    ...original,
    reasoning: repaired.reasoning,
    mandatory_properties: after,
    // The revised text must quote the same per-item evidence if one existed.
    // The normal resolver checks visibility; never silently change its number.
    per_product_measurement_evidence:
      original.per_product_measurement_evidence ?? "",
  };
}

export const reasoningObligationsPolicy =
  "После составления reasoning заполни mandatory_properties всеми обязательными свойствами отдельных товаров, которые ты сам обосновал в reasoning. Это независимый от live-фасетов список: отсутствие свойства в каталожной схеме не отменяет требование. Не копируй туда автоматически числа из запроса: расстояние, площадь и количество покупаемого материала — условия задачи, а не обязательно параметр одного заводского изделия. Сначала сформулируй каждое обязательное свойство отдельным полным предложением с ключом и значением, например в форме «Необходим …» или «Обязательна …». source_span — точная копия этого полного предложения из reasoning, не из сообщения клиента и не отдельный фрагмент. key и строковое value должны дословно встречаться в этом предложении; числовое value должно встречаться вместе с unit и тем же направлением сравнения. Для чисел используй тип number. Для текстового значения unit — пустая строка. Не подменяй необходимость предпочтением. Не создавай обязательное свойство только ради заполнения массива. Если вместо окончательного подбора задан clarification_question, оставь mandatory_properties пустым.";

export const reasoningObligationsSchema = {
  type: "array",
  maxItems: 12,
  description:
    "Обязательные свойства каждого товара независимо от наличия поискового фасета. Для каждого свойства скопируй полное предложение из reasoning с явной необходимостью, именем свойства и значением. Не включай предположения, общие суммы, предпочтения и входные параметры объекта. Числа передавай числом с единицей, не строкой. Не теряй необходимое свойство только потому, что его нет среди live IDs. Пусто только при отсутствии дополнительных обязательных свойств.",
  items: {
    type: "object",
    properties: {
      key: { type: "string", minLength: 3, maxLength: 120 },
      op: { type: "string", enum: ["eq", "min", "max"] },
      value: {
        anyOf: [{ type: "number" }, {
          type: "string",
          minLength: 1,
          maxLength: 160,
        }],
      },
      unit: { type: "string", maxLength: 20 },
      scope: { type: "string", enum: ["per_product"] },
      source_span: { type: "string", minLength: 8, maxLength: 600 },
    },
    required: ["key", "op", "value", "unit", "scope", "source_span"],
    additionalProperties: false,
  },
};

const normalized = (value: string) =>
  value.replace(/\s+/gu, " ").trim().toLowerCase();

/** Attribution may expand an exact sentence prefix to its complete source,
 * never shorten the source or invent/replace words. All semantic checks run
 * on the expanded sentence, including trailing conditions and negations. */
function completeVisibleSource(quote: string, reasoning: string): string | null {
  const prefix = normalized(quote).replace(/[.!?]+$/u, "").trim();
  if (prefix.length < 8) return null;
  const sentences = reasoning.match(/[\s\S]+?(?:[.!?](?=\s|$)|$)/gu) ?? [];
  const matches = sentences.map((sentence) => sentence.trim()).filter((sentence) => {
    if (sentence.length > 600) return false;
    const source = normalized(sentence);
    if (!source.startsWith(prefix)) return false;
    const next = source.slice(prefix.length, prefix.length + 1);
    return !next || /[\s,;:.!?—()]/u.test(next);
  });
  return matches.length === 1 ? matches[0] : null;
}
const containsPhrase = (text: string, phrase: string) => {
  const escaped = normalized(phrase).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u")
    .test(text);
};

/** Same lexemes in inflected prose, not arbitrary prefixes or synonyms.
 * Preserve every short code and number; punctuation/order may differ. */
function containsInflectedPhrase(text: string, phrase: string): boolean {
  if (containsPhrase(text, phrase)) return true;
  const tokens = (value: string) => (normalized(value).match(/[\p{L}\p{N}]+/gu) ?? []).map((token) =>
    /^[а-яё]{5,}$/u.test(token)
      ? token.replace(/(?:ыми|ими|ого|его|ому|ему|ами|ями|ая|яя|ое|ее|ые|ие|ой|ей|ом|ем|ым|им|ую|юю|ый|ий|ых|их|ов|ев|ам|ям|ах|ях|а|я|о|е|ы|и|у|ю|ь)$/u, "")
      : token);
  const wanted = tokens(phrase);
  const actual = new Set(tokens(text));
  return wanted.length > 0 && wanted.every((token) => actual.has(token));
}

/** A declaration of necessity is not product evidence. This compiler only
 * preserves visible per-product requirements independently of search facets.
 * Callers must reject unresolved declarations and prove each obligation
 * against each candidate; an empty live facet schema cannot erase one. */
export function resolveReasoningObligations(
  raw: unknown,
  visibleReasoning: string,
  facets: ObligationFacet[] = [],
  customerEvidence = "",
  confirmedCustomerCriteria: Criterion[] = [],
): ObligationResolution {
  const obligations: ReasoningObligation[] = [];
  const unresolved: ObligationResolution["unresolved"] = [];
  if (!Array.isArray(raw) || raw.length > 12) {
    return { obligations, unresolved: [{ index: -1, reason: "invalid_list" }] };
  }
  const visible = normalized(visibleReasoning);
  for (const [index, item] of raw.entries()) {
    const reject = (reason: string) => unresolved.push({ index, reason });
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      reject("invalid_item");
      continue;
    }
    const { key, value, unit, op, source_span: sourceSpan, scope } = item;
    if (
      typeof key !== "string" || key.length < 3 || key.length > 120 ||
      typeof sourceSpan !== "string" || sourceSpan.length < 8 ||
      sourceSpan.length > 600 ||
      !["eq", "min", "max"].includes(op) || scope !== "per_product"
    ) {
      reject("invalid_shape_or_scope");
      continue;
    }
    const completeSource = completeVisibleSource(sourceSpan, visibleReasoning);
    if (!completeSource) {
      reject("source_not_visible");
      continue;
    }
    const span = normalized(completeSource);
    const matchingFacets = facets.filter((facet) =>
      [facet.key, facet.caption].some((label) => typeof label === "string" && normalized(label) === normalized(key)));
    // Reuse the existing customer-owned facet proof, not modal words in the
    // model's explanation. This cannot promote a model-only default.
    // The server's frozen customer contract is stronger than rediscovering the
    // same fact through incomplete catalog metadata. Never use model-derived
    // criteria here, nor broaden equality, units, value or property identity.
    const confirmedCustomerOwned = op === "eq" && confirmedCustomerCriteria.some((criterion) =>
      criterion.evidence === "user_explicit" && criterion.level === "A" &&
      criterion.op === "eq" && !criterion.exclusive &&
      normalized(criterion.key) === normalized(key) &&
      normalizeUnit(criterion.unit ?? "") === normalizeUnit(unit ?? "") &&
      (typeof value === "number"
        ? /^\d+(?:[.,]\d+)?$/u.test(String(criterion.value)) &&
          Number(String(criterion.value).replace(",", ".")) === value
        : typeof value === "string" && normalized(String(criterion.value)) === normalized(value)));
    const customerGrounded = confirmedCustomerOwned || op === "eq" && customerEvidence.trim().length > 0 && matchingFacets.some((facet) => {
      const liveFacet = { key: facet.key ?? facet.caption ?? "", caption: facet.caption, unit: facet.unit,
        values: (facet.values ?? []).filter((entry): entry is { value: string } => typeof entry.value === "string") };
      const selected = liveFacet.values.find((entry) => typeof value === "number"
        ? /^\d+(?:[.,]\d+)?$/u.test(entry.value.trim()) && Number(entry.value.replace(",", ".")) === value
        : typeof value === "string" && normalized(entry.value) === normalized(value));
      if (!selected) return false;
      if (typeof value === "number" && (unit
        ? !extractClientQuantities(customerEvidence).some((q) => q.value === value && q.unit === normalizeUnit(unit))
        : Number(compoundCountFacetValue(liveFacet, customerEvidence)?.value) !== value)) return false;
      return guardSearchFilters({ mode: "by_filter", options: { [liveFacet.key]: [selected.value] } },
        [liveFacet], customerEvidence, customerEvidence, "").user_backed.some((entry) =>
          entry.key === liveFacet.key && entry.value === selected.value);
    });
    const offset = visible.indexOf(span);
    const before = offset < 0 ? "" : visible.slice(0, offset).trim();
    if (offset < 0) {
      reject("source_not_visible");
      continue;
    }
    if (before && !/[.!?]$/u.test(before)) {
      reject("source_not_sentence_boundary");
      continue;
    }
    const valueOwners = typeof value === "string" && op === "eq" && !unit &&
        (value.match(/[\p{L}]{3,}/gu) ?? []).length >= 2
      ? facets.filter((facet) => (facet.values ?? []).some((entry) =>
        typeof entry.value === "string" && normalized(entry.value) === normalized(value)))
      : [];
    // A unique live caption/value supplies the property name, while prose must
    // still ground the complete descriptive value. Ambiguous values, numbers,
    // boolean words and unknown keys cannot use this path.
    const liveValueOwnsKey = valueOwners.length === 1 &&
      [valueOwners[0].key, valueOwners[0].caption].some((caption) =>
        typeof caption === "string" && normalized(caption) === normalized(key)) &&
      containsInflectedPhrase(span, String(value));
    const countGrounded = typeof value === "number" && Number.isInteger(value) &&
      (!unit || /^(?:шт\.?|штук|pcs?|pieces?)$/iu.test(String(unit))) && op === "eq" &&
      facets.some((facet) =>
        [facet.key, facet.caption].some((label) => typeof label === "string" && normalized(label) === normalized(key)) &&
        Number(compoundCountFacetValue({
          key: facet.key ?? facet.caption ?? "",
          caption: facet.caption,
          values: (facet.values ?? []).filter((entry): entry is { value: string } => typeof entry.value === "string"),
        }, span)?.value) === value);
    if (!containsInflectedPhrase(span, key) && !liveValueOwnsKey && !countGrounded && !customerGrounded) {
      reject("key_not_grounded");
      continue;
    }
    // Preferences and unresolved alternatives cannot become hard conditions.
    const withoutBounds = span.replace(
      /не\s+(?:менее|более|меньше|больше)/giu,
      "",
    );
    if (
      /(?:возможно|желательн|например|предпочт|либо|если|можно|суммар|распредел|отсутств)|(?:^|\s)(?:не|без)(?:\s|$)/iu
        .test(withoutBounds) ||
      (!customerGrounded && !/(?:необходим|требует|требуется|обязател|долж|критич)/iu.test(span))
    ) {
      reject("necessity_not_established");
      continue;
    }
    let criterion: Criterion;
    if (typeof value === "number" && Number.isFinite(value)) {
      if (
        !countGrounded && !customerGrounded && (typeof unit !== "string" || !unit.trim() ||
        !extractClientQuantities(span).some((q) =>
          q.value === value && q.unit === normalizeUnit(unit)
        ))
      ) {
        reject("quantity_not_grounded");
        continue;
      }
      const bounds = extractReasoningBounds(span).filter((bound) =>
        bound.value === value &&
        normalizeUnit(bound.unit) === normalizeUnit(unit)
      );
      if (
        (op === "eq" && bounds.length > 0) ||
        (op !== "eq" &&
          (bounds.length === 0 || bounds.some((bound) => bound.op !== op)))
      ) {
        reject("operator_not_grounded");
        continue;
      }
      criterion = {
        key,
        op,
        value,
        ...(unit && !countGrounded ? { unit } : {}),
        exclusive: bounds.some((bound) => bound.strict),
        level: "A",
        evidence: customerGrounded ? "user_explicit" : "derived_required",
      };
    } else if (
      typeof value === "string" && value.trim().length >= 1 &&
      value.length <= 160 && op === "eq" &&
      !unit && containsInflectedPhrase(span, value) &&
      extractClientQuantities(value).length === 0
    ) {
      criterion = {
        key,
        op: "eq",
        value,
        level: "A",
        evidence: customerGrounded ? "user_explicit" : "derived_required",
      };
    } else {
      reject("value_not_grounded");
      continue;
    }
    obligations.push({ criterion, sourceSpan: completeSource });
  }
  return { obligations, unresolved };
}
