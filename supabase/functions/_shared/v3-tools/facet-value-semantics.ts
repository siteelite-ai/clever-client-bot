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
    .filter((word) => word.length >= 4);
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
    word.length >= 4 &&
    axisWords.some((axis) => axis.slice(0, 4) === word.slice(0, 4));
  for (const clause of String(customerEvidence ?? "").split(/[,.!?;\n]+/u)) {
    const words = normalizedWords(clause);
    for (let index = 0; index < words.length; index++) {
      const negative = words[index];
      if (["без", "нет", "отсутствует", "no", "without"].includes(negative)) {
        if (words.slice(index + 1, index + 4).some(matchesAxis)) return true;
      }
      if (
        negative === "не" &&
        ["имеет", "имею", "нужен", "нужна", "нужно", "нужны"]
          .includes(words[index + 1] ?? "")
      ) {
        if (words.slice(index + 2, index + 5).some(matchesAxis)) return true;
      }
      if (
        matchesAxis(negative) &&
        ["нет", "отсутствует", "не", "no"].includes(words[index + 1] ?? "")
      ) {
        return true;
      }
    }
  }
  return false;
}
