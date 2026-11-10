import { detectUserIntentMode } from "./intent-mode.ts";
import { extractReplacementLookupKeys } from "./replacement-preflight.ts";

// A reference to an earlier item, comparison or replacement still needs its
// server-owned context, even when the customer repeats a model code. Identity
// wording alone is never permission to discard such dependencies.
const PRIOR_CONTEXT =
  /(?<![\p{L}\p{N}])(?:этот|эта|это|эти|этого|этой|этому|этим|этими|этих|эту|тот|та|те|того|той|тех|они|их|его|е[её]|него|не[её]|них|так(?:ой|ая|ие|ого|их|ую|ое|ому|им|ими)|данн\p{L}*|указанн\p{L}*|названн\p{L}*|перв\p{L}*|втор\p{L}*|трет\p{L}*|последн\p{L}*|предыдущ\p{L}*|прежн\p{L}*|показанн\p{L}*|предложенн\p{L}*|выше|ниже|ранее|сравн\p{L}*|аналог\p{L}*|вместо|замен\p{L}*)(?![\p{L}\p{N}])|чем\s+отлича\p{L}*|разниц\p{L}*\s+(?:с|между)/iu;

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
  const keys = extractReplacementLookupKeys(text);
  return keys.modelCodes.length > 0 || keys.articles.some((article) => {
    // A bare quantity with a unit is not a newly named article. A labelled
    // article is allowed; downstream catalogue equality remains mandatory.
    const index = text.indexOf(article);
    return /(?:артикул\p{L}*|арт\.?|sku|ean|код(?:\s+товара)?)\s*[:№#-]?\s*$/iu
      .test(text.slice(0, index)) ||
      !/^\s*(?:[\p{L}²³]|₸|₽|\$|€)/u.test(text.slice(index + article.length));
  });
}
