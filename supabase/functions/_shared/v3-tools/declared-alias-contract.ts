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

const POST_NOMINAL_STOP = new Set([
  "для", "под", "с", "со", "без", "на", "в", "во", "из", "к", "по", "до", "от",
  "есть", "имеется", "нужен", "нужна", "нужно", "нужны", "покажи", "найди", "ищу",
  "самый", "самая", "дешевый", "дешевая", "дешевые",
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
