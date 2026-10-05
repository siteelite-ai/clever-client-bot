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

const normalized = (value: string) =>
  value.replace(/\s+/gu, " ").trim().toLowerCase();
const containsPhrase = (text: string, phrase: string) => {
  const escaped = normalized(phrase).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u")
    .test(text);
};

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
    if (
      offset < 0 || (before && !/[.!?]$/u.test(before)) ||
      !containsPhrase(span, key)
    ) {
      reject("source_not_visible_or_key_not_grounded");
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
      !unit && containsPhrase(span, value) &&
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
