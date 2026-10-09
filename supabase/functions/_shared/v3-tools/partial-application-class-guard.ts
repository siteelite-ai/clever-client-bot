import type { ProductFull } from "./types.ts";

interface LiveClassFacet {
  key: string;
  caption: string;
  values: Array<{ value: string }>;
}

export interface PartialApplicationClassGuard {
  facetKey: string;
  facetCaption: string;
  /** Customer-owned qualifier, not a guessed complete catalog subtype. */
  ownedStems: string[];
  compatibleValues: string[];
  contradictoryValues: string[];
  productClassStems: string[];
}

const CLASS_FACET =
  /(?:^|[^\p{L}])(?:категори\p{L}*|класс\p{L}*|вид(?:а|ы|ов|у|ом|е)?|тип\p{L}*|назначен\p{L}*|применен\p{L}*)(?:$|[^\p{L}])/iu;
const GLUE = new Set([
  "для",
  "без",
  "при",
  "под",
  "над",
  "или",
  "как",
  "for",
  "with",
  "and",
  "the",
]);
const NEGATION = new Set(["не", "без", "кроме", "исключая"]);

function words(value: string): string[] {
  return (String(value ?? "").toLocaleLowerCase("ru-RU").replace(/ё/gu, "е")
    .match(/[a-zа-я0-9]{2,}/giu) ?? []);
}

// Match grammatical forms without embedding a product or application dictionary.
function stem(word: string): string {
  if (/^[a-z0-9]+$/u.test(word)) return word;
  if (word.length >= 7) return word.slice(0, 5);
  if (word.length >= 5) return word.slice(0, 4);
  return word;
}

function normalized(value: string): string {
  return words(value).join(" ");
}

function applicationStems(
  value: string,
  productClassStems: Set<string>,
): string[] {
  const tokens = words(value);
  const anchor = tokens.findIndex((token) =>
    productClassStems.has(stem(token))
  );
  const purpose = tokens.findIndex((token, index) =>
    token === "для" && (anchor < 0 || index > anchor)
  );
  const leading = anchor > 0 ? tokens.slice(0, anchor) : [];
  const trailingPurpose = purpose >= 0 ? tokens.slice(purpose + 1) : [];
  // A value without the resolved class noun can itself be a purpose label.
  const qualifier = anchor < 0 && purpose < 0 ? tokens : [
    ...leading,
    ...trailingPurpose,
  ];
  return [
    ...new Set(
      qualifier.map(stem).filter((token) =>
        !GLUE.has(token) && !productClassStems.has(token)
      ),
    ),
  ];
}

function positiveCustomerStems(message: string): Set<string> {
  const positive = new Set<string>();
  // Keep negation within its clause. "Не хочу для X" spans three preceding
  // words, whereas "не X, а Y" must still permit the positive Y qualifier.
  for (
    const clause of String(message ?? "").split(
      /[,;.!?]|\s+(?:а|но|зато)\s+/iu,
    )
  ) {
    const tokens = words(clause);
    for (const [index, token] of tokens.entries()) {
      if (
        tokens.slice(Math.max(0, index - 4), index).some((prior) =>
          NEGATION.has(prior)
        )
      ) continue;
      positive.add(stem(token));
    }
  }
  return positive;
}

/**
 * Freeze only a partial customer-owned use-class qualifier from the live
 * classification axis. A broad word shared by every option, or a locally
 * negated word, cannot choose a class. In particular, one adjective does not
 * become an exact compound catalog value with an unrequested mounting type.
 */
export function freezePartialApplicationClassGuards(
  customerMessage: string,
  productClass: string,
  facets: LiveClassFacet[],
): PartialApplicationClassGuard[] {
  const classStems = new Set(words(productClass).map(stem));
  const customerStems = positiveCustomerStems(customerMessage);
  const guards: PartialApplicationClassGuard[] = [];
  for (const facet of facets ?? []) {
    if (!CLASS_FACET.test(`${facet.caption} ${facet.key}`)) continue;
    const choices = (facet.values ?? []).map(({ value }) => ({
      value,
      stems: applicationStems(value, classStems),
    })).filter(({ value }) => normalized(value));
    if (choices.length < 2) continue;
    const facetStems = new Set(
      words(`${facet.caption} ${facet.key}`).map(stem),
    );
    const selected = [...customerStems].filter((token) =>
      !GLUE.has(token) && !facetStems.has(token) &&
      !classStems.has(token) &&
      choices.some(({ stems }) => stems.includes(token)) &&
      choices.some(({ stems }) => !stems.includes(token))
    );
    if (selected.length === 0) continue;
    const compatible = choices.filter(({ stems }) =>
      selected.every((token) => stems.includes(token))
    );
    // Two independently mentioned, incompatible live classes are ambiguous.
    if (compatible.length === 0) continue;
    const contradictory = choices.filter(({ stems }) =>
      stems.length > 0 && selected.every((token) => !stems.includes(token))
    );
    if (contradictory.length === 0) continue;
    guards.push({
      facetKey: facet.key,
      facetCaption: facet.caption,
      ownedStems: selected,
      compatibleValues: compatible.map(({ value }) => value),
      contradictoryValues: contradictory.map(({ value }) => value),
      productClassStems: [...classStems],
    });
  }
  return guards;
}

function titledClassPhrase(
  title: string,
  value: string,
  classStems: Set<string>,
): boolean {
  const titleWords = words(title);
  const valueWords = words(value);
  const anchor = valueWords.findIndex((word) => classStems.has(stem(word)));
  const purpose = valueWords.findIndex((word, index) =>
    word === "для" && (anchor < 0 || index > anchor)
  );
  if (purpose >= 0) {
    const phrase = valueWords.slice(purpose).map(stem);
    return titleWords.some((word, index) =>
      word === "для" &&
      !titleWords.slice(Math.max(0, index - 3), index).some((prior) =>
        NEGATION.has(prior)
      ) &&
      phrase.every((part, offset) =>
        stem(titleWords[index + offset] ?? "") === part
      )
    );
  }
  if (anchor <= 0) return false;
  const leading = valueWords.slice(0, anchor).map(stem)
    .filter((token) => !GLUE.has(token));
  if (leading.length === 0) return false;
  // An adjective immediately attached to the same product-class noun is a
  // title class phrase; a stray word elsewhere in the title is not.
  return titleWords.some((word, index) =>
    classStems.has(stem(word)) &&
    leading.every((part, offset) =>
      stem(titleWords[index - leading.length + offset] ?? "") === part
    )
  );
}

function explicitClassValues(
  product: ProductFull,
  guard: PartialApplicationClassGuard,
): string[] {
  const values = Object.entries(product.facet_values ?? {})
    .filter(([key]) => normalized(key) === normalized(guard.facetKey))
    .flatMap(([, raw]) => Array.isArray(raw) ? raw : []);
  const labels = new Set([
    normalized(guard.facetKey),
    normalized(guard.facetCaption),
  ]);
  for (const trait of product.short_traits ?? []) {
    const separator = trait.indexOf(":");
    if (separator < 0 || !labels.has(normalized(trait.slice(0, separator)))) {
      continue;
    }
    values.push(trait.slice(separator + 1).trim());
  }
  return values;
}

function contradictsGuard(
  product: ProductFull,
  guard: PartialApplicationClassGuard,
): boolean {
  const classStems = new Set(guard.productClassStems);
  // A visible, unambiguous title class claim cannot be cancelled by a
  // conflicting hidden facet: that is exactly what the customer will see.
  if (
    guard.contradictoryValues.some((value) =>
      titledClassPhrase(product.pagetitle, value, classStems)
    )
  ) return true;
  const compatible = new Set(guard.compatibleValues.map(normalized));
  const contradictory = new Set(guard.contradictoryValues.map(normalized));
  const labelled = explicitClassValues(product, guard).map(normalized);
  // Conflicting catalogue evidence is ambiguous, not grounds for a veto.
  if (labelled.some((value) => compatible.has(value))) return false;
  return labelled.some((value) => contradictory.has(value));
}

/** One final render eligibility rule for both ordinary and terminal pools. */
export function filterPartialApplicationClassContradictions<
  T extends ProductFull,
>(
  products: T[],
  guards: PartialApplicationClassGuard[],
): T[] {
  if (guards.length === 0) return products;
  return products.filter((product) =>
    !guards.some((guard) => contradictsGuard(product, guard))
  );
}
