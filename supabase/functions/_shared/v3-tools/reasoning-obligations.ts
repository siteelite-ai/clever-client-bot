import type { Criterion } from "./criteria-gate.ts";
import {
  extractClientQuantities,
  normalizeUnit,
} from "./criteria-consistency.ts";
import { extractReasoningBounds } from "./criteria-reasoning.ts";

export interface ReasoningObligation {
  criterion: Criterion;
  sourceSpan: string;
}

export interface ObligationResolution {
  obligations: ReasoningObligation[];
  unresolved: Array<{ index: number; reason: string }>;
}

/** Repair prose/quote formatting only, never replace the selected semantics,
 * live IDs, scope or cardinality with a second model's different answer. */
export function repairObligationDeclaration(
  original: Record<string, unknown>,
  repaired: Record<string, unknown>,
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
    resolveReasoningObligations(after, repaired.reasoning).unresolved.length > 0
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
          minLength: 3,
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
      ? token.replace(/(?:ыми|ими|ого|его|ому|ему|ами|ями|ая|яя|ое|ее|ой|ей|ом|ем|ую|юю|ый|ий|ых|их|ов|ев|ам|ям|ах|ях|а|я|о|е|ы|и|у|ю)$/u, "")
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
    const span = normalized(sourceSpan);
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
    if (!containsInflectedPhrase(span, key)) {
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
      !/(?:необходим|требует|требуется|обязател|долж|критич)/iu.test(span)
    ) {
      reject("necessity_not_established");
      continue;
    }
    let criterion: Criterion;
    if (typeof value === "number" && Number.isFinite(value)) {
      if (
        typeof unit !== "string" || !unit.trim() ||
        !extractClientQuantities(span).some((q) =>
          q.value === value && q.unit === normalizeUnit(unit)
        )
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
        unit,
        exclusive: bounds.some((bound) => bound.strict),
        level: "A",
        evidence: "derived_required",
      };
    } else if (
      typeof value === "string" && value.trim().length >= 3 &&
      value.length <= 160 && op === "eq" &&
      !unit && containsInflectedPhrase(span, value) &&
      extractClientQuantities(value).length === 0
    ) {
      criterion = {
        key,
        op: "eq",
        value,
        level: "A",
        evidence: "derived_required",
      };
    } else {
      reject("value_not_grounded");
      continue;
    }
    obligations.push({ criterion, sourceSpan });
  }
  return { obligations, unresolved };
}
