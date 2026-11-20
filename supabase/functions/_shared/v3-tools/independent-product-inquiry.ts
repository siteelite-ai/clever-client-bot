import { detectUserIntentMode } from "./intent-mode.ts";
import { extractReplacementLookupKeys } from "./replacement-preflight.ts";

// A comparison, ranking or explicit reference to an earlier batch depends on
// that batch. A local determiner ("этот светильник MODEL-123") does not: the
// code is independent lookup input, never proof of that item's properties.
const PRIOR_CONTEXT =
  /(?<![\p{L}\p{N}])(?:они|их|его|е[её]|него|не[её]|них|перв\p{L}*|втор\p{L}*|трет\p{L}*|последн\p{L}*|предыдущ\p{L}*|прежн\p{L}*|показанн\p{L}*|предложенн\p{L}*|выше|ниже|ранее|сравн\p{L}*|аналог\p{L}*|вместо|замен\p{L}*|дешевле|дороже|лучше|хуже|так(?:ой|ая|ие|ого|их|ую|ое|ому|им|ими))(?![\p{L}\p{N}])|чем\s+отлича\p{L}*|разниц\p{L}*\s+(?:с|между)|(?:из|среди)\s+(?:этих|тех|них)/iu;

/** A spaced model identifier is the same lookup input as a compact one.
 * Uppercase label + long numeric suffix is identity syntax, not a quantity.
 * When present it takes precedence over incidental short specification codes. */
export function independentItemLookupKeys(message: string) {
  const existing = extractReplacementLookupKeys(message);
  const spaced = [...message.matchAll(/(?<![\p{L}\p{N}])[A-ZА-ЯЁ]{2,12}\s+\d{3,6}(?:[-/.]\d+)*(?![\p{L}\p{N}])/gu)]
    .map(match => match[0].replace(/\s+/gu, " "));
  return { ...existing, modelCodes: spaced.length ? [...new Set(spaced)] : existing.modelCodes };
}

/** Routing evidence only: an independently named factual question must reach
 * fresh identity lookup instead of requiring an unrelated previous batch.
 * No SKU, class or brand dictionary. The existing exact lookup must still
 * prove one unambiguous live card; this predicate proves no product facts. */
export function isIndependentExactProductInquiry(message: string): boolean {
  const text = String(message ?? "").replace(/\p{Cc}/gu, " ").trim();
  if (
    !text || text.length > 2_000 || detectUserIntentMode(text) !== "inquire" ||
    PRIOR_CONTEXT.test(text)
  ) return false;
  const keys = independentItemLookupKeys(text);
  return keys.modelCodes.length > 0 || keys.articles.some((article) => {
    // A bare quantity with a unit is not a newly named article. A labelled
    // article is allowed; downstream catalogue equality remains mandatory.
    const index = text.indexOf(article);
    return /(?:артикул\p{L}*|арт\.?|sku|ean|код(?:\s+товара)?)\s*[:№#-]?\s*$/iu
      .test(text.slice(0, index)) ||
      !/^\s*(?:[\p{L}²³]|₸|₽|\$|€)/u.test(text.slice(index + article.length));
  });
}
