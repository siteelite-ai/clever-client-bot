import type { Criterion } from "./criteria-gate.ts";
import {
  extractClientQuantities,
  isPhysicalMeasurementUnit,
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

export interface OmittedReasoningObligation {
  reason:
    | "undeclared_measured_product_property"
    | "undeclared_qualitative_product_property";
  sourceSpan: string;
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
      ? token.replace(/(?:иями|иях|ием|ыми|ими|ого|его|ому|ему|ами|ями|ия|ию|ии|ая|яя|ое|ее|ые|ие|ой|ей|ом|ем|ым|им|ую|юю|ый|ий|ых|их|ов|ев|ам|ям|ах|ях|а|я|о|е|ы|и|у|ю|ь)$/u, "")
      : token);
  const wanted = tokens(phrase);
  const actual = new Set(tokens(text));
  return wanted.length > 0 && wanted.every((token) => actual.has(token));
}

/** Deliberately high-precision coverage check, not a substitute for the
 * declaration compiler or a way to invent a property from a customer number.
 * Only an explicit product-side necessity can trigger a repair/retry. */
export function findOmittedReasoningObligations(
  raw: unknown,
  visibleReasoning: string,
  options: { clarificationQuestion?: unknown } = {},
): OmittedReasoningObligation[] {
  if (
    typeof options.clarificationQuestion === "string" &&
    options.clarificationQuestion.trim()
  ) return [];
  if (typeof visibleReasoning !== "string" || !visibleReasoning.trim()) {
    return [];
  }
  const declarations = Array.isArray(raw) ? raw.filter((item): item is Record<string, unknown> =>
    !!item && typeof item === "object" && !Array.isArray(item) &&
    item.scope === "per_product" && typeof item.source_span === "string" &&
    !!completeVisibleSource(item.source_span, visibleReasoning)) : [];
  const sentences = visibleReasoning.match(/[^.!?]+(?:[.!?](?=\s|$)|$)/gu) ?? [];
  const omitted: OmittedReasoningObligation[] = [];
  const necessity = /(?:необходим\p{L}*|требуется|обязател\p{L}*|обязательн\p{L}*|долж\p{L}*|нуж\p{L}*)/iu;
  const nonbinding = /(?:возможно|желательн|предпочт|рекоменду|например|обычно|гипотез|предполож|(?:^|[^\p{L}])(?:можно|если|либо|или)(?:$|[^\p{L}])|при\s+(?:условии|необходимости)|не\s+(?:требуется|нуж\p{L}*|долж\p{L}*|обязател\p{L}*))/iu;
  const aggregate = /(?:суммарн|совокупн|распредел|между\s+нескольк|общ\p{L}*\s+(?:светов\p{L}*\s+)?(?:поток|мощност|потребност)|для\s+всей\s+системы)/iu;
  const taskInput = /(?:уч[её]т|площад|расстоян|трасс|помещен|двор|участ|высот\p{L}*\s+(?:установ|монтаж)|длин\p{L}*\s+(?:проклад|трасс))/iu;
  const numeric = /(?<![\p{L}\p{N}])(\d+(?:[.,]\d+)?)\s*([a-zа-я°]{1,6}[²³]?\d?)(?![\p{L}\p{N}×xх*/]|[.,]\d)/giu;
  const coversQualitativeValue = (value: string, predicate: string): boolean => {
    const resistance = /^((?:устойчив|стойк|защищ)\p{L}*)\s+к\s+([\p{L}-]+(?:\s+[\p{L}-]+){0,2})/iu.exec(predicate);
    if (resistance) {
      // "Устойчива" without "к ультрафиолету" is not the same requirement.
      return containsInflectedPhrase(value, resistance[1]) &&
        containsInflectedPhrase(value, resistance[2]);
    }
    const compound = /^([\p{L}\p{N}]{2,})-((?:стойк|устойчив|защищ)\p{L}*)$/iu.exec(predicate);
    if (compound) {
      return containsInflectedPhrase(value, compound[1]) &&
        containsInflectedPhrase(value, compound[2]);
    }
    return containsInflectedPhrase(predicate, value);
  };

  for (const untrimmed of sentences) {
    const sentence = untrimmed.trim();
    // Examples in parentheses may be optional while the surrounding clause
    // remains binding; do not let "обычно ..." cancel the whole requirement.
    const statement = sentence.replace(/\([^)]*\)/gu, "").replace(/\s+/gu, " ").trim();
    if (
      sentence.length < 16 || sentence.length > 600 || sentence.endsWith("?") ||
      !necessity.test(statement) || nonbinding.test(statement) ||
      /необязател/iu.test(statement) || aggregate.test(statement) ||
      /(?:уточните|уточнить|для\s+(?:выбора|подбора)|чтобы\s+подобрать)/iu.test(statement)
    ) continue;
    const declaredIn = declarations.filter((item) => {
      const full = completeVisibleSource(String(item.source_span), visibleReasoning);
      return full && normalized(full) === normalized(sentence);
    });
    let measuredMissing = false;
    for (const match of statement.matchAll(numeric)) {
      const value = Number(match[1].replace(",", "."));
      const unit = normalizeUnit(match[2]);
      if (
        !Number.isFinite(value) || !isPhysicalMeasurementUnit(unit) ||
        /^(?:м²|см²|км²|m²|cm²|km²)$/iu.test(unit)
      ) continue;
      const prefix = statement.slice(0, match.index).trimEnd().replace(
        /(?:не\s+менее|не\s+более|более|менее|от|до)\s*$/iu,
        "",
      ).trimEnd();
      const withProperty = /(?:^|[^\p{L}\p{N}])(?:с|со)\s+([\p{L}-]+(?:\s+[\p{L}-]+){0,4})\s*$/iu.exec(prefix);
      const directProperty = /(?:необходим\p{L}*|требуется|обязател\p{L}*|обязательн\p{L}*|нуж\p{L}*)\s+([\p{L}-]+(?:\s+[\p{L}-]+){1,4})\s*$/iu.exec(prefix);
      const property = (withProperty?.[1] ?? directProperty?.[1] ?? "").trim();
      if (!property || taskInput.test(property)) continue;
      const covered = declarations.some((item) =>
        typeof item.value === "number" && item.value === value &&
        typeof item.unit === "string" && normalizeUnit(item.unit) === unit &&
        (declaredIn.includes(item) ||
          typeof item.key === "string" && containsInflectedPhrase(property, item.key)));
      if (!covered) measuredMissing = true;
    }
    if (measuredMissing) omitted.push({
      reason: "undeclared_measured_product_property",
      sourceSpan: sentence,
    });

    // A component's demanded resistance/material is product-side evidence,
    // unlike a site size or a qualitative preference. These predicates are
    // grammatical attribute families, never category, brand or SKU rules.
    const qualitative = /([\p{L}-]+(?:\s+[\p{L}-]+){0,3})\s+(?:должен|должна|должно|должны|обязан|обязана|обязано|обязаны)\s+быть\s+((?:устойчив\p{L}*|стойк\p{L}*|защищ\p{L}*|влагозащищ\p{L}*|негорюч\p{L}*|самозатухающ\p{L}*|выполнен\p{L}*\s+из|изготовлен\p{L}*\s+из)[^.!?]*)/iu.exec(statement);
    const adjectiveFirst = /(?:обязательн\p{L}*|необходим\p{L}*|требуется)\s+([\p{L}-]*(?:стойк|устойчив|защищ|влагозащищ|негорюч|самозатухающ)[\p{L}-]*(?:\s+к\s+[\p{L}-]+)?)\s+([\p{L}-]+)/iu.exec(statement);
    // "Требуется оболочка из полиэтилена, устойчивая к УФ" states two
    // independently provable properties of the same component. A declaration
    // of its material must not silently cover the separate resistance claim.
    const materialMatch = /(?:^|[^\p{L}])(?:необходим\p{L}*|требуется|обязательн\p{L}*|нуж\p{L}*)\s+([\p{L}-]+(?:\s+[\p{L}-]+){0,2})\s+из\s+([\p{L}-]+(?:\s+[\p{L}-]+){0,2}?)(?=\s*(?:,|[.!?]|$|(?:устойчив|стойк|защищ)\p{L}*))/iu.exec(statement);
    // "Один из светильников" selects from a set; "из" is not a material
    // relation when its left-hand side is a quantifier/pronoun.
    const requiredMaterial = materialMatch && !/^(?:\d+|один|одн\p{L}*|два|две|двух|три|тр[её]х|четыре|четыр[её]х|пять|пяти|шесть|семь|восемь|девять|десять|много|пара|нескольк\p{L}*|люб\p{L}*|кажд\p{L}*|част\p{L}*)$/iu.test(materialMatch[1])
      ? materialMatch
      : null;
    const afterMaterial = requiredMaterial
      ? statement.slice((requiredMaterial.index ?? 0) + requiredMaterial[0].length).replace(/^\s*,?\s*/u, "")
      : "";
    const modalMaterial = /([\p{L}-]+(?:\s+[\p{L}-]+){0,3})\s+(?:должен|должна|должно|должны|обязан|обязана|обязано|обязаны)\s+быть\s+(?:(?:выполнен|изготовлен)\p{L}*\s+)?из\s+([\p{L}-]+(?:\s+[\p{L}-]+){0,2}?)(?=\s*(?:,|[.!?]|$|(?:устойчив|стойк|защищ)\p{L}*))/iu.exec(statement);
    const afterModalMaterial = modalMaterial
      ? statement.slice((modalMaterial.index ?? 0) + modalMaterial[0].length).replace(/^\s*,?\s*/u, "")
      : "";
    const resistanceAfter = /^((?:устойчив|стойк|защищ)\p{L}*\s+к\s+[\p{L}-]+(?:\s+[\p{L}-]+){0,2})/iu;
    const materialResistance = resistanceAfter.exec(afterMaterial);
    const modalResistance = resistanceAfter.exec(afterModalMaterial);
    const modalSubject = modalMaterial?.[1].split(/\s+/u).slice(-2).join(" ") ?? "";
    const claims = [
      ...(qualitative && !modalMaterial ? [{ subject: qualitative[1].split(/\s+/u).slice(-2).join(" "), predicate: qualitative[2].trim() }] : []),
      ...(adjectiveFirst ? [{ subject: adjectiveFirst[2], predicate: adjectiveFirst[1] }] : []),
      ...(requiredMaterial ? [{ subject: requiredMaterial[1], predicate: requiredMaterial[2], requireSubjectKey: true }] : []),
      ...(requiredMaterial && materialResistance ? [{ subject: requiredMaterial[1], predicate: materialResistance[1], requireSubjectKey: true }] : []),
      ...(modalMaterial ? [{ subject: modalSubject, predicate: modalMaterial[2], requireSubjectKey: true }] : []),
      ...(modalMaterial && modalResistance ? [{ subject: modalSubject, predicate: modalResistance[1], requireSubjectKey: true }] : []),
    ];
    if (claims.some(({ subject, predicate, requireSubjectKey }) => subject && predicate && !taskInput.test(subject) &&
      !declarations.some((item) =>
        typeof item.value === "string" && !item.unit &&
        coversQualitativeValue(item.value, predicate) &&
        typeof item.key === "string" &&
        (!requireSubjectKey || containsInflectedPhrase(subject, item.key) || containsInflectedPhrase(item.key, subject)) &&
        (declaredIn.includes(item) || containsInflectedPhrase(subject, item.key))))) omitted.push({
      reason: "undeclared_qualitative_product_property",
      sourceSpan: sentence,
    });
  }
  return omitted;
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
    // A live yes/no facet may say "да" while the model's complete source
    // sentence expresses the same truth as required *presence* of that exact
    // property. This is a grammatical equivalence, not a blanket acceptance
    // of the model's preferred Boolean or a new category-specific synonym.
    const presenceKey = key.replace(/^(?:с|со)\s+/iu, "").replace(/^наличи\p{L}*\s+/iu, "");
    const affirmativePresenceGrounded =
      typeof value === "string" && normalized(value) === "да" &&
      op === "eq" && unit === "" && presenceKey.length >= 3 &&
      /(?:^|[^\p{L}])(?:наличи\p{L}*|имеется|имеет|оснащ[её]н\p{L}*|предусмотрен\p{L}*|присутств\p{L}*)/iu.test(span) &&
      containsInflectedPhrase(span, presenceKey);
    if (!containsInflectedPhrase(span, key) && !liveValueOwnsKey && !countGrounded && !customerGrounded && !affirmativePresenceGrounded) {
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
      !unit && (containsInflectedPhrase(span, value) || affirmativePresenceGrounded) &&
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
