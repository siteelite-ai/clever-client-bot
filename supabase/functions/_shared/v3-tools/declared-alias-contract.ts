function normalize(value: string): string {
  return String(value ?? "")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

const ALIAS_DECLARATION = /(?:это\s+)?(?:(?:народн|разговорн|жаргонн|бытов|неофициальн)\p{L}*\s+)+(?:названи\p{L}*|обозначени\p{L}*|термин\p{L}*)/iu;

/**
 * Extracts a customer-owned phrase only when the consultant explicitly
 * declares it to be an alias. The relation is structural and vocabulary-free:
 * quoted product words alone, examples and ordinary application context do not
 * create an alias obligation.
 */
export function extractDeclaredCatalogAlias(
  customerText: string,
  consultantReasoning: string,
): string | null {
  const customer = normalize(customerText);
  if (!customer) return null;
  const reasoning = String(consultantReasoning ?? "");
  const quotePattern = /[«“"]([^»”"\r\n]{2,80})[»”"]/gu;
  for (let match; (match = quotePattern.exec(reasoning)) !== null;) {
    const phrase = String(match[1] ?? "").trim();
    const normalizedPhrase = normalize(phrase);
    if (!normalizedPhrase || normalizedPhrase.split(" ").length > 6) continue;
    if (!(` ${customer} `.includes(` ${normalizedPhrase} `))) continue;
    const relationWindow = reasoning.slice(quotePattern.lastIndex, quotePattern.lastIndex + 100);
    if (ALIAS_DECLARATION.test(relationWindow)) return phrase;
  }
  return null;
}

/** Exact customer vocabulary may satisfy the alias contract without recovery. */
export function titleContainsDeclaredAlias(title: string, alias: string): boolean {
  const haystack = ` ${normalize(title)} `;
  const needle = normalize(alias);
  return Boolean(needle && haystack.includes(` ${needle} `));
}

/** A mixed candidate pool must be narrowed to the cards that independently
 * prove the customer's literal qualifier; one unrelated neighbour must not
 * invalidate the proven subset. */
export function filterProductsByDeclaredAlias<T extends { pagetitle: string }>(
  products: T[],
  alias: string,
): T[] {
  return (Array.isArray(products) ? products : []).filter((product) =>
    titleContainsDeclaredAlias(product.pagetitle, alias)
  );
}

/** A grounded canonical spelling remains mandatory until final cards pass all
 * independent criteria; an earlier invariant outranks a later helper result. */
export function retainRequiredCatalogAlias(current: string | null, matchedQuery: string): string | null {
  const retained = String(current ?? "").trim();
  if (retained) return retained;
  const grounded = String(matchedQuery ?? "").trim();
  return grounded || null;
}

/** A qualifier is not an alias when it merely repeats the already grounded
 * product class with another inflection (for example plural customer wording
 * versus singular catalog titles). Real colloquial names remain distinct. */
export function aliasDuplicatesCatalogClass(alias: string, classes: Array<string | null | undefined>): boolean {
  const aliasTokens = normalize(alias).split(" ").filter(Boolean);
  if (aliasTokens.length === 0) return false;
  return classes.some((value) => {
    const classTokens = normalize(String(value ?? "")).split(" ").filter(Boolean);
    return classTokens.length > 0 && aliasTokens.every((aliasToken) =>
      classTokens.some((classToken) => inflectionStem(aliasToken) === inflectionStem(classToken))
    );
  });
}

/** Only independently discovered class labels may discharge an alias. A
 * model-generated selection target is intentionally not accepted here. */
export function aliasDuplicatesIndependentCatalogClass(
  alias: string,
  liveTaxonomy: string | null | undefined,
  discoveryNoun: string | null | undefined,
): boolean {
  return aliasDuplicatesCatalogClass(alias, [liveTaxonomy, discoveryNoun]);
}

const POST_NOMINAL_STOP = new Set([
  "для", "под", "с", "со", "без", "на", "в", "во", "из", "к", "по", "до", "от",
  "есть", "имеется", "нужен", "нужна", "нужно", "нужны", "покажи", "найди", "ищу",
  "самый", "самая", "дешевый", "дешевая", "дешевые",
  // Relational markers introduce a separately parsed entity; they are not a
  // customer nickname for the product class itself.
  "серия", "серии", "серий", "коллекция", "коллекции", "линейка", "линейки",
]);

function inflectionStem(token: string): string {
  if (/^[a-z0-9]+$/u.test(token)) return token;
  if (token.length >= 7) return token.slice(0, 5);
  if (token.length >= 5) return token.slice(0, 4);
  return token;
}

/**
 * Captures a compact qualifier placed directly after the discovered product
 * noun (for example a family code or customer nickname). Prepositional usage,
 * numeric measurements and ordinary shopping verbs are excluded, so room/use
 * context remains in the application contract instead.
 */
export function extractPostNominalCatalogQualifier(
  customerText: string,
  discoveredNoun: string,
): string | null {
  const nounTokens = normalize(discoveredNoun).split(" ").filter(Boolean);
  if (nounTokens.length === 0) return null;
  const nounStem = inflectionStem(nounTokens.at(-1)!);
  const tokens = normalize(customerText).split(" ").filter(Boolean);
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (inflectionStem(tokens[index]) !== nounStem) continue;
    const candidate = tokens[index + 1];
    const following = tokens.slice(index + 2, index + 5);
    const measurementTail = /^\d/u.test(following[0] ?? "") ||
      /^(?:от|до|более|менее|свыше|не)$/u.test(following[0] ?? "") &&
        following.slice(1).some((token) => /^\d/u.test(token));
    if (
      candidate.length < 3 ||
      /^\d/u.test(candidate) ||
      POST_NOMINAL_STOP.has(candidate) ||
      inflectionStem(candidate) === nounStem ||
      measurementTail
    ) continue;
    return candidate;
  }
  return null;
}
