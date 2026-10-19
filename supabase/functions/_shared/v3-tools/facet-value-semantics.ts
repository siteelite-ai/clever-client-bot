/**
 * Catalogs sometimes mix real choices with an absence marker (`нет`, `none`)
 * on the same axis. An assistant's statement `facet: нет` can mean "the user
 * did not specify this facet", not "the product must lack this feature".
 * Only the customer's own, axis-specific negation can make absence binding.
 * This module deliberately knows no product or category names.
 */

type FacetLabel = { key: string; caption?: string };

function normalizedWords(value: string): string[] {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е")
    .match(/[a-zа-я0-9]+/giu) ?? [];
}

const ABSENCE_VALUES = new Set([
  "нет",
  "отсутствует",
  "no",
  "none",
  "false",
  "absent",
]);

/** Unknown catalog metadata is never a requested product property. */
const UNKNOWN_VALUES = new Set([
  "не указано",
  "не задано",
  "неизвестно",
  "н д",
  "not specified",
  "not set",
  "unknown",
]);

const GENERIC_AXIS_STEMS = new Set([
  "нали",
  "коли",
  "длин",
  "тип",
  "вид",
  "спос",
  "мате",
  "цвет",
  "форм",
  "пара",
  "знач",
  "свой",
  "номи",
  "хара",
  "коло",
]);

/** True for values that require an explicit customer-owned absence claim. */
export function isAbsenceOrUnknownFacetValue(value: string): boolean {
  const normalized = normalizedWords(value).join(" ");
  return ABSENCE_VALUES.has(normalized) || UNKNOWN_VALUES.has(normalized);
}

/**
 * Prove the customer requested absence of this live property, not merely
 * absence of a preference. The negative word and a distinctive facet-axis
 * noun must occur in the same short clause. A bare "нет" or "без" elsewhere
 * in the request cannot authorize an unrelated filter.
 */
export function customerOwnsAbsentFacetValue(
  facet: FacetLabel,
  value: string,
  customerEvidence: string,
): boolean {
  const normalizedValue = normalizedWords(value).join(" ");
  if (!ABSENCE_VALUES.has(normalizedValue)) return false;
  const captionWords = normalizedWords(facet.caption || facet.key)
    .filter((word) => word.length >= 3);
  const distinctive = captionWords.filter((word) =>
    !GENERIC_AXIS_STEMS.has(word.slice(0, 4))
  );
  // In a compound axis, the first distinctive noun is the feature's head.
  // `без движения` does not mean `без датчика движения`.
  const axisWords = (distinctive.length > 0 ? distinctive : captionWords).slice(
    0,
    1,
  );
  if (axisWords.length === 0) return false;
  const matchesAxis = (word: string) =>
    axisWords.some((axis) =>
      axis.length <= 3
        ? word === axis
        : word.length >= 4 && axis.slice(0, 4) === word.slice(0, 4)
    );
  for (const clause of String(customerEvidence ?? "").split(/[,.!?;\n]+/u)) {
    const words = normalizedWords(clause);
    for (let index = 0; index < words.length; index++) {
      const negative = words[index];
      // Absence of a preference is not a request for a product without the
      // feature: "нет предпочтений по заземлению" must never bind "нет".
      if (["без", "нет", "отсутствует", "no", "without"].includes(negative)) {
        if (matchesAxis(words[index + 1] ?? "")) return true;
      }
      if (
        negative === "не" &&
        ["имеет", "имею", "нужен", "нужна", "нужно", "нужны"]
          .includes(words[index + 1] ?? "")
      ) {
        if (matchesAxis(words[index + 2] ?? "")) return true;
      }
      if (
        matchesAxis(negative) &&
        (["нет", "отсутствует", "no"].includes(words[index + 1] ?? "") ||
          (words[index + 1] === "не" &&
            ["нужно", "нужен", "нужна", "нужны", "требуется", "требуются",
              "должно", "должен", "должна", "должны", "имеет", "имеют"]
              .includes(words[index + 2] ?? "")))
      ) {
        return true;
      }
    }
  }
  return false;
}
