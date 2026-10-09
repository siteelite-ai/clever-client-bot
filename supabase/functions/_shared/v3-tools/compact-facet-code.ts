// Resolves customer-visible compact technical codes through the live facet
// schema. This module deliberately contains no product, category or brand
// vocabulary: a code is accepted only when one unique combination of values
// from at least two distinct live axes covers the complete token.

export interface CompactCodeFacet {
  key?: string;
  caption?: string;
  unit?: string | null;
  // Discovery currently exposes canonical values as strings, while a few
  // internal/test callers use `{ value }` records. Keep the live-schema
  // boundary tolerant to both representations instead of silently compiling
  // an empty axis at runtime.
  values?: Array<string | { value: string }>;
}

export interface CompactFacetCodeEvidence {
  code: string;
  axes: Array<{ key: string; caption: string; value: string }>;
}

export interface CompoundFacetValueEvidence {
  token: string;
  axis: { key: string; caption: string; value: string };
}

export interface CompactCodeProductEvidence {
  pagetitle?: string;
  short_traits?: string[];
  facet_values?: Record<string, string[]>;
}

export interface CompactCodeProductEvidenceDiagnostic {
  code: string;
  supported_axes: Array<{
    key: string;
    caption: string;
    fragments: Array<{ fragment: string; value: string }>;
  }>;
  ranked_paths: Array<{
    coverage: number;
    axes: CompactFacetCodeEvidence["axes"];
  }>;
}

const VISUALLY_EQUIVALENT_CODE_LETTERS: Record<string, string> = {
  "а": "a",
  "в": "b",
  "с": "c",
  "е": "e",
  "н": "h",
  "к": "k",
  "м": "m",
  "о": "o",
  "р": "p",
  "т": "t",
  "х": "x",
  "у": "y",
};

function normalizeCompactCode(value: string): string {
  return String(value ?? "").toLowerCase().replace(
    /[авсенкмортху]/gu,
    (letter) => VISUALLY_EQUIVALENT_CODE_LETTERS[letter] ?? letter,
  ).replace(/[^a-z0-9]/g, "");
}

function normalizeRussianWord(value: string): string {
  return String(value ?? "").toLocaleLowerCase("ru-RU").replace(/ё/gu, "е")
    .replace(/[^а-я0-9]/gu, "");
}

function canonicalFacetValue(entry: string | { value: string }): string {
  return String(typeof entry === "string" ? entry : entry?.value ?? "").trim();
}

const RUSSIAN_COMPOUND_NUMBER_PREFIXES: Array<[string, string]> = [
  ["четырех", "4"],
  ["четыре", "4"],
  ["трех", "3"],
  ["три", "3"],
  ["двух", "2"],
  ["дву", "2"],
  ["два", "2"],
  ["две", "2"],
  ["одно", "1"],
  ["один", "1"],
  ["одна", "1"],
];

const RUSSIAN_ADJECTIVE_ENDINGS = [
  "ными",
  "ними",
  "ного",
  "него",
  "ному",
  "нему",
  "ная",
  "няя",
  "ное",
  "нее",
  "ный",
  "ний",
  "ные",
  "ние",
  "ных",
  "них",
  "ным",
  "ним",
  "ной",
  "ней",
  "ную",
  "нюю",
];

function russianFacetRoot(value: string): string {
  const normalized = normalizeRussianWord(value);
  for (const ending of RUSSIAN_ADJECTIVE_ENDINGS) {
    if (normalized.endsWith(ending) && normalized.length - ending.length >= 5) {
      return normalized.slice(0, -ending.length);
    }
  }
  for (
    const ending of [
      "ами",
      "ями",
      "ов",
      "ев",
      "ей",
      "ам",
      "ям",
      "ах",
      "ях",
      "ы",
      "и",
      "а",
      "я",
    ]
  ) {
    if (normalized.endsWith(ending) && normalized.length - ending.length >= 5) {
      return normalized.slice(0, -ending.length);
    }
  }
  return normalized;
}

function rootsMatch(left: string, right: string): boolean {
  const a = russianFacetRoot(left);
  const b = russianFacetRoot(right);
  if (a.length < 5 || b.length < 5) return false;
  const shorter = Math.min(a.length, b.length);
  let shared = 0;
  while (shared < shorter && a[shared] === b[shared]) shared += 1;
  return shared >= 5 && shared / shorter >= 0.7;
}

function compoundNumberTokens(queryText: string): Array<{
  token: string;
  value: string;
  root: string;
}> {
  const tokens = String(queryText ?? "").split(/[^\p{L}\p{N}]+/u)
    .map(normalizeRussianWord)
    .filter(Boolean);
  return tokens.flatMap((token) => {
    const prefix = RUSSIAN_COMPOUND_NUMBER_PREFIXES.find(([candidate]) =>
      token.startsWith(candidate) && token.length - candidate.length >= 5
    );
    if (!prefix) return [];
    return [{ token, value: prefix[1], root: token.slice(prefix[0].length) }];
  });
}

/**
 * Resolve productive Russian compounds such as `однополюсный` or
 * `двухклавишный` only through a matching live caption and a matching live
 * numeric value. This is language grammar, not product vocabulary; an
 * ambiguous match across several axes is rejected.
 */
export function resolveCompoundFacetValueEvidence(
  queryText: string,
  facets: CompactCodeFacet[],
): CompoundFacetValueEvidence[] {
  return compoundNumberTokens(queryText).flatMap(({ token, value, root }) => {
    const matches = facets.flatMap((facet, index) => {
      const key = String(facet.key ?? "").trim() || `axis:${index}`;
      const caption = String(facet.caption ?? "").trim() || key;
      const captionMatches = String(caption).split(/[^\p{L}\p{N}]+/u)
        .some((captionToken) => rootsMatch(root, captionToken));
      if (!captionMatches) return [];
      const canonical = (facet.values ?? []).map(canonicalFacetValue)
        .filter((candidate) =>
          new RegExp(`(?:^|[^0-9])${value}(?:[^0-9]|$)`, "u").test(candidate)
        );
      const unique = Array.from(new Set(canonical));
      return unique.length === 1 ? [{ key, caption, value: unique[0] }] : [];
    });
    return matches.length === 1 ? [{ token, axis: matches[0] }] : [];
  });
}

/**
 * Resolve an explicitly labelled live value written as separate words, for
 * example `1 полюс`, `полюсов: 3` or `2 клавиши`.  The value is accepted only
 * when it is adjacent to a lexical root from exactly one live facet caption
 * and maps to exactly one value of that facet.  This complements productive
 * compounds (`однополюсный`) without adding product/category vocabulary.
 */
export function resolveLabeledFacetValueEvidence(
  queryText: string,
  facets: CompactCodeFacet[],
): CompoundFacetValueEvidence[] {
  const sourceTokens = String(queryText ?? "").split(/[^\p{L}\p{N}.,]+/u)
    .map((raw) => ({ raw, normalized: normalizeRussianWord(raw) }))
    .filter(({ normalized }) => Boolean(normalized));
  const candidates: CompoundFacetValueEvidence[] = [];

  facets.forEach((facet, index) => {
    const key = String(facet.key ?? "").trim() || `axis:${index}`;
    const caption = String(facet.caption ?? "").trim() || key;
    const captionTokens = caption.split(/[^\p{L}\p{N}]+/u)
      .map(normalizeRussianWord)
      .filter((token) => token.length >= 5);
    if (captionTokens.length === 0) return;

    const liveValues = (facet.values ?? []).map(canonicalFacetValue).filter(
      Boolean,
    );
    for (
      let tokenIndex = 0;
      tokenIndex < sourceTokens.length;
      tokenIndex += 1
    ) {
      const sourceValue = normalizeCompactCode(sourceTokens[tokenIndex].raw);
      if (!sourceValue || sourceValue.length > 12) continue;
      const matchingValues = liveValues.filter((value) => {
        const normalized = normalizeCompactCode(value);
        if (normalized === sourceValue) return true;
        const sourceScalar = numericFacetScalar(sourceTokens[tokenIndex].raw);
        const valueScalar = numericFacetScalar(value);
        return sourceScalar !== null && valueScalar !== null &&
          sourceScalar === valueScalar;
      });
      const uniqueValues = [...new Set(matchingValues)];
      if (uniqueValues.length !== 1) continue;

      const neighbours = [
        sourceTokens[tokenIndex - 1],
        sourceTokens[tokenIndex + 1],
      ]
        .filter((entry): entry is { raw: string; normalized: string } =>
          Boolean(entry)
        );
      const matchingNeighbour = neighbours.find(({ normalized }) =>
        captionTokens.some((captionToken) =>
          rootsMatch(normalized, captionToken)
        )
      );
      if (!matchingNeighbour) continue;
      candidates.push({
        token: `${sourceTokens[tokenIndex].raw} ${matchingNeighbour.raw}`,
        axis: { key, caption, value: uniqueValues[0] },
      });
    }
  });

  const bySignature = new Map<string, CompoundFacetValueEvidence>();
  for (const candidate of candidates) {
    const signature = `${candidate.axis.key}\u0000${candidate.axis.value}`;
    bySignature.set(signature, candidate);
  }
  const unique = [...bySignature.values()];
  // The same labelled fragment pointing at several live axes is ambiguous and
  // therefore cannot become a search filter.
  const ambiguousTokens = new Set(unique.flatMap((candidate) => {
    const normalizedToken = normalizeRussianWord(candidate.token);
    const axes = unique.filter((other) =>
      normalizeRussianWord(other.token) === normalizedToken
    )
      .map((other) => other.axis.key);
    return new Set(axes).size > 1 ? [normalizedToken] : [];
  }));
  return unique.filter((candidate) =>
    !ambiguousTokens.has(normalizeRussianWord(candidate.token))
  );
}

/**
 * Resolve compact numeric axis notation such as `1P` against a unique live
 * facet. The suffix is never interpreted from a product dictionary: it must
 * be the initial of a non-generic token in the live machine key/caption, and
 * the numeric part must select one exact live value. Ambiguous schemas fail
 * closed.
 */
export function resolveAbbreviatedNumericFacetValueEvidence(
  queryText: string,
  facets: CompactCodeFacet[],
): CompoundFacetValueEvidence[] {
  const tokens = String(queryText ?? "").match(
    /(?<![\p{L}\p{N}])(\d+(?:[.,]\d+)?)([\p{L}])(?![\p{L}\p{N}])/gu,
  ) ?? [];
  const genericAxisTokens =
    /^(?:kolichestvo|chislo|count|number|количеств|числ)/iu;
  const resolved: CompoundFacetValueEvidence[] = [];

  for (const token of tokens) {
    const match = token.match(/^(\d+(?:[.,]\d+)?)([\p{L}])$/u);
    if (!match) continue;
    const scalar = Number(match[1].replace(",", "."));
    const suffix = normalizeCompactCode(match[2]);
    if (!Number.isFinite(scalar) || suffix.length !== 1) continue;

    const matches = facets.flatMap((facet, index) => {
      const key = String(facet.key ?? "").trim() || `axis:${index}`;
      const caption = String(facet.caption ?? "").trim() || key;
      const allLabelTokens = `${key} ${caption}`
        .split(/[^\p{L}\p{N}]+/u)
        .filter((candidate) => candidate.length >= 3);
      // A number+letter form denotes an axis cardinality, not an arbitrary
      // administrative flag whose machine key happens to share the letter.
      if (
        !allLabelTokens.some((candidate) => genericAxisTokens.test(candidate))
      ) return [];
      const labelTokens = allLabelTokens.filter((candidate) =>
        !genericAxisTokens.test(candidate)
      );
      const suffixMatches = labelTokens.some((candidate) => {
        const normalized = normalizeCompactCode(candidate);
        return normalized.length >= 3 && normalized.startsWith(suffix);
      });
      if (!suffixMatches) return [];
      const values = (facet.values ?? []).map(canonicalFacetValue).filter(
        (value) => {
          const numeric = value.match(/^\s*(\d+(?:[.,]\d+)?)\s*$/u)?.[1];
          return numeric !== undefined &&
            Number(numeric.replace(",", ".")) === scalar;
        },
      );
      const unique = [...new Set(values)];
      return unique.length === 1
        ? [{ token, axis: { key, caption, value: unique[0] } }]
        : [];
    });
    if (matches.length === 1) {
      resolved.push(matches[0]);
      continue;
    }
    if (matches.length > 1) {
      const contextTokens = String(queryText ?? "")
        .split(/[^\p{L}\p{N}]+/u)
        .map(normalizeRussianWord)
        .filter((candidate) => candidate.length >= 5);
      const scored = matches.map((candidate) => ({
        candidate,
        score: String(candidate.axis.caption ?? "")
          .split(/[^\p{L}\p{N}]+/u)
          .filter((label) => label.length >= 5)
          .filter((label) =>
            contextTokens.some((context) => rootsMatch(label, context))
          )
          .length,
      })).sort((left, right) => right.score - left.score);
      if (scored[0]?.score > 0 && scored[0].score > (scored[1]?.score ?? 0)) {
        resolved.push(scored[0].candidate);
      }
    }
  }
  return resolved;
}

export function compactCodeTokensInQuery(value: string): Array<{
  raw: string;
  normalized: string;
}> {
  const unique = new Map<string, string>();
  for (const raw of String(value ?? "").split(/[^\p{L}\p{N}]+/u)) {
    const normalized = normalizeCompactCode(raw);
    // A quantity written without a space (`500м2`, `1000lm`, `16A`) is still
    // a measurement, not a model/family code. Keep the list at the physical-
    // unit layer: it is product- and category-agnostic, while letter-first
    // technical identifiers such as C16/IP65 remain eligible compact codes.
    const compactMeasurement =
      /^\d+(?:[.,]\d+)?(?:мм|см|м|км|м2|м3|m|mm|cm|km|m2|m3|вт|квт|w|kw|в|кв|v|kv|а|ма|a|ma|лм|lm|лк|lx|гц|hz|к|k|кг|kg|г|g|л|ml|мл|тенге|тг|kzt)$/u
        .test(
          normalized,
        );
    const compactBudget = /^\d+(?:[.,]\d+)?(?:тенге|тг|kzt)$/iu.test(raw);
    if (
      normalized.length < 2 || normalized.length > 16 ||
      !/[a-z]/.test(normalized) || !/\d/.test(normalized) ||
      compactMeasurement || compactBudget
    ) continue;
    if (!unique.has(normalized)) unique.set(normalized, raw);
  }
  return [...unique].map(([normalized, raw]) => ({ raw, normalized }));
}

function compactCodesInQuery(value: string): string[] {
  return compactCodeTokensInQuery(value).map(({ normalized }) => normalized);
}

export function unresolvedCompactCodeTokens(
  queryText: string,
  facets: CompactCodeFacet[],
  representedValues: string[] = [],
  resolutionEvidence: string = queryText,
): string[] {
  const resolved = new Set(
    resolveCompactFacetCodeEvidence(resolutionEvidence, facets).map((
      { code },
    ) => code),
  );
  for (
    const { token } of resolveAbbreviatedNumericFacetValueEvidence(
      resolutionEvidence,
      facets,
    )
  ) {
    resolved.add(normalizeCompactCode(token));
  }
  const represented = new Set(
    representedValues.map(normalizeCompactCode).filter(Boolean),
  );
  return compactCodeTokensInQuery(queryText)
    .filter(({ normalized }) =>
      !resolved.has(normalized) && !represented.has(normalized)
    )
    .map(({ raw }) => raw);
}

function valueFragments(value: string, unit?: string | null): string[] {
  const fragments = new Set<string>();
  const full = normalizeCompactCode(value);
  if (full) fragments.add(full);
  for (const part of String(value ?? "").split(/[^\p{L}\p{N}]+/u)) {
    const normalized = normalizeCompactCode(part);
    if (normalized) fragments.add(normalized);
  }
  const normalizedUnit = normalizeCompactCode(unit ?? "");
  if (normalizedUnit && /^\d+(?:\.\d+)?$/u.test(full)) {
    fragments.add(`${full}${normalizedUnit}`);
    fragments.add(`${normalizedUnit}${full}`);
  }
  return [...fragments].filter((fragment) => fragment.length <= 16);
}

function numericFacetScalar(value: string): number | null {
  const scalar = String(value ?? "").match(
    /^\s*(\d+(?:[.,]\d+)?)\s*(?:[\p{L}°²³]+)?\s*$/u,
  )?.[1]?.replace(",", ".");
  if (scalar === undefined) return null;
  const parsed = Number(scalar);
  return Number.isFinite(parsed) ? parsed : null;
}

interface CompiledAxis {
  key: string;
  caption: string;
  fragments: Map<string, string>;
  allFragments: Set<string>;
  candidateValues: Map<string, string[]>;
}

function codeFragments(codes: string[]): Set<string> {
  const fragments = new Set<string>();
  for (const code of codes) {
    for (let start = 0; start < code.length; start += 1) {
      for (let end = start + 1; end <= code.length; end += 1) {
        fragments.add(code.slice(start, end));
      }
    }
  }
  return fragments;
}

/**
 * Bounded preselection for callers that need product-backed disambiguation.
 * Only axes containing a live value that can form a fragment of the typed
 * compact code are returned. This keeps the proof algorithm independent from
 * rich unrelated category metadata and avoids quadratic work on large schemas.
 */
export function compactFacetCandidateKeys(
  queryText: string,
  facets: CompactCodeFacet[],
): string[] {
  const codes = compactCodesInQuery(queryText);
  if (codes.length === 0) return [];
  return [
    ...new Set(compileAxes(facets, codeFragments(codes)).map(({ key }) => key)),
  ];
}

function compileAxes(
  facets: CompactCodeFacet[],
  wantedFragments: Set<string>,
): CompiledAxis[] {
  return facets.flatMap((facet, index) => {
    const key = String(facet.key ?? "").trim() || `axis:${index}`;
    const caption = String(facet.caption ?? "").trim() || key;
    const candidates = new Map<string, Set<string>>();
    for (const entry of facet.values ?? []) {
      const value = canonicalFacetValue(entry);
      if (!value) continue;
      for (const fragment of valueFragments(value, facet.unit)) {
        if (!wantedFragments.has(fragment)) continue;
        const values = candidates.get(fragment) ?? new Set<string>();
        values.add(value);
        candidates.set(fragment, values);
      }
    }
    const fragments = new Map<string, string>();
    for (const [fragment, values] of candidates) {
      if (values.size === 1) {
        fragments.set(fragment, [...values][0]);
        continue;
      }
      const exactValues = [...values].filter((value) =>
        normalizeCompactCode(value) === fragment
      );
      if (exactValues.length === 1) {
        fragments.set(fragment, exactValues[0]);
        continue;
      }
      // The live schema can expose the same scalar through several display
      // forms (`16`, `16 А`, `16.0`). They are one filter value semantically,
      // not competing code decodes. Collapse only when every candidate is a
      // complete scalar and all parsed numbers are equal; long text values
      // that merely contain the fragment remain ambiguous and fail closed.
      const scalarValues = [...values].map(numericFacetScalar);
      if (
        scalarValues.length > 0 && scalarValues.every((value) =>
          value !== null
        ) &&
        new Set(scalarValues).size === 1
      ) {
        const canonical = [...values].sort((left, right) =>
          Number(normalizeCompactCode(right) === fragment) -
            Number(normalizeCompactCode(left) === fragment) ||
          left.length - right.length || left.localeCompare(right)
        )[0];
        fragments.set(fragment, canonical);
      }
    }
    const allFragments = new Set(candidates.keys());
    const candidateValues = new Map(
      [...candidates].map(([fragment, values]) => [fragment, [...values]]),
    );
    return allFragments.size > 0
      ? [{ key, caption, fragments, allFragments, candidateValues }]
      : [];
  });
}

function hasMultiAxisCodePath(code: string, axes: CompiledAxis[]): boolean {
  const visit = (offset: number, usedKeys: Set<string>): boolean => {
    if (offset === code.length) return usedKeys.size >= 2;
    if (usedKeys.size >= 4) return false;
    for (let end = code.length; end > offset; end -= 1) {
      const fragment = code.slice(offset, end);
      for (const axis of axes) {
        if (usedKeys.has(axis.key) || !axis.allFragments.has(fragment)) {
          continue;
        }
        const nextKeys = new Set(usedKeys);
        nextKeys.add(axis.key);
        if (visit(end, nextKeys)) return true;
      }
    }
    return false;
  };
  return visit(0, new Set());
}

function collectOneCodePaths(
  code: string,
  axes: CompiledAxis[],
): Map<string, CompactFacetCodeEvidence["axes"]> {
  const uniquePaths = new Map<string, CompactFacetCodeEvidence["axes"]>();
  let visits = 0;
  const visit = (
    offset: number,
    path: CompactFacetCodeEvidence["axes"],
    usedKeys: Set<string>,
  ) => {
    // A live catalog can contain many incidental one-character flags. Keep
    // decoding strictly bounded so malformed or unusually rich schemas can
    // never consume the whole Edge Function request budget.
    visits += 1;
    if (visits > 1024 || uniquePaths.size > 32 || path.length > 4) return;
    if (offset === code.length) {
      if (path.length < 2) return;
      const signature = [...path]
        .sort((left, right) => left.key.localeCompare(right.key))
        .map(({ key, value }) => `${key}\u0000${value}`)
        .join("\u0001");
      uniquePaths.set(signature, path);
      return;
    }
    // Longest fragments first: this reaches the parsimonious decomposition
    // before bounded traversal is consumed by combinations of incidental
    // one-digit metadata facets.
    for (let end = code.length; end > offset; end -= 1) {
      const fragment = code.slice(offset, end);
      for (const axis of axes) {
        if (usedKeys.has(axis.key)) continue;
        const value = axis.fragments.get(fragment);
        if (!value) continue;
        const nextKeys = new Set(usedKeys);
        nextKeys.add(axis.key);
        visit(
          end,
          [...path, { key: axis.key, caption: axis.caption, value }],
          nextKeys,
        );
      }
    }
  };
  visit(0, [], new Set());
  return uniquePaths;
}

function resolveOneCode(
  code: string,
  axes: CompiledAxis[],
): CompactFacetCodeEvidence | null {
  const uniquePaths = collectOneCodePaths(code, axes);
  if (uniquePaths.size !== 1) return null;
  return { code, axes: [...uniquePaths.values()][0] };
}

function normalizeEvidenceLabel(value: string): string {
  return String(value ?? "").toLocaleLowerCase("ru-RU").replace(/ё/gu, "е")
    .replace(
      /[авсенкмортху]/gu,
      (letter) => VISUALLY_EQUIVALENT_CODE_LETTERS[letter] ?? letter,
    )
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

function facetValuesEquivalent(
  expectedRaw: string,
  actualRaw: string,
): boolean {
  const expectedValue = normalizeCompactCode(expectedRaw);
  const actualValue = normalizeCompactCode(actualRaw);
  if (actualValue === expectedValue) return true;
  const expectedScalar = numericFacetScalar(expectedRaw);
  const actualScalar = numericFacetScalar(actualRaw);
  return expectedScalar !== null && actualScalar !== null &&
    actualScalar === expectedScalar;
}

function productAxisEvidenceValues(
  product: CompactCodeProductEvidence,
  axis: Pick<CompactFacetCodeEvidence["axes"][number], "key" | "caption">,
): string[] {
  const values = [...(product.facet_values?.[axis.key] ?? [])].map(String);
  const expectedCaption = normalizeEvidenceLabel(axis.caption);
  for (const line of product.short_traits ?? []) {
    const [caption, ...valueParts] = String(line).split(":");
    const actualCaption = normalizeEvidenceLabel(caption ?? "");
    const captionMatches = actualCaption === expectedCaption || (
      Math.min(actualCaption.length, expectedCaption.length) >= 8 &&
      Math.abs(actualCaption.length - expectedCaption.length) <= 4 &&
      (actualCaption.startsWith(expectedCaption) ||
        expectedCaption.startsWith(actualCaption))
    );
    if (!caption || valueParts.length === 0 || !captionMatches) continue;
    values.push(valueParts.join(":").trim());
  }
  return [...new Set(values.filter(Boolean))];
}

function productSupportsAxis(
  product: CompactCodeProductEvidence,
  axis: CompactFacetCodeEvidence["axes"][number],
): boolean {
  return productAxisEvidenceValues(product, axis).some((actualRaw) =>
    facetValuesEquivalent(axis.value, actualRaw)
  );
}

export interface CustomerNumericAxisAliasProof<T> {
  status:
    | "proven"
    | "not_numeric_axis_alias"
    | "live_axis_unresolved"
    | "customer_axis_unresolved"
    | "product_axis_unproven";
  axis: CompoundFacetValueEvidence["axis"] | null;
  products: T[];
}

/**
 * A model's compact label such as `1P` is not a product-title obligation when
 * the customer independently requested `1 полюсной` and both expressions
 * resolve to the same unique live facet/value. Still require that exact value
 * on each candidate's own live traits or keyed facet values. A title-shaped
 * code alone, an ambiguous schema, or conflicting card values never proves
 * the alias. This discharges only the alias representation; callers must keep
 * their category, remaining criteria, price and stock gates unchanged.
 */
export function proveCustomerNumericAxisAliasFromProducts<
  T extends CompactCodeProductEvidence,
>(
  alias: string,
  customerMessage: string,
  facets: CompactCodeFacet[],
  products: T[],
): CustomerNumericAxisAliasProof<T> {
  const token = String(alias ?? "").trim();
  const empty = (status: CustomerNumericAxisAliasProof<T>["status"],
    axis: CompoundFacetValueEvidence["axis"] | null = null,
  ): CustomerNumericAxisAliasProof<T> => ({ status, axis, products: [] });
  if (!/^\d+(?:[.,]\d+)?[\p{L}]$/u.test(token)) {
    return empty("not_numeric_axis_alias");
  }
  const canonicalToken = normalizeCompactCode(token);
  const resolved = resolveAbbreviatedNumericFacetValueEvidence(token, facets)
    .filter((candidate) =>
      normalizeCompactCode(candidate.token) === canonicalToken
    );
  if (resolved.length !== 1) return empty("live_axis_unresolved");
  const axis = resolved[0].axis;
  const customerEvidence = [
    ...resolveLabeledFacetValueEvidence(customerMessage, facets),
    ...resolveCompoundFacetValueEvidence(customerMessage, facets),
    ...resolveAbbreviatedNumericFacetValueEvidence(customerMessage, facets),
  ];
  if (!customerEvidence.some((candidate) =>
    candidate.axis.key === axis.key &&
    facetValuesEquivalent(axis.value, candidate.axis.value)
  )) return empty("customer_axis_unresolved", axis);
  const suffix = canonicalToken.match(/[a-z]$/u)?.[0] ?? "";
  const proven = (Array.isArray(products) ? products : []).filter((product) => {
    const values = productAxisEvidenceValues(product, axis);
    const titleAxisTokens = String(product.pagetitle ?? "").match(
      /(?<![\p{L}\p{N}])\d+(?:[.,]\d+)?[\p{L}](?![\p{L}\p{N}])/gu,
    )?.map(normalizeCompactCode).filter((value) => value.endsWith(suffix)) ?? [];
    return values.length > 0 && values.every((value) =>
      facetValuesEquivalent(axis.value, value)
    ) && titleAxisTokens.every((value) => value === canonicalToken);
  });
  return proven.length > 0
    ? { status: "proven", axis, products: proven }
    : empty("product_axis_unproven", axis);
}

/**
 * When a live schema offers several possible decompositions for the same
 * compact code, exact-title catalog hits can disambiguate them. A path is
 * accepted only when the same live facet/value pair is evidenced by at least
 * two returned products and its coverage is strictly better than every other
 * path. Product text is evidence, never an instruction or a source of new
 * vocabulary.
 */
export function resolveCompactFacetCodeEvidenceFromProductsV2(
  queryText: string,
  facets: CompactCodeFacet[],
  products: CompactCodeProductEvidence[],
): CompactFacetCodeEvidence[] {
  return compactFacetCodeProductEvidenceDiagnostics(queryText, facets, products)
    .flatMap(({ code, ranked_paths: ranked }) => {
      const minimumCoverage = Math.min(2, products.length);
      const best = ranked[0];
      if (
        !best || best.coverage < minimumCoverage ||
        ranked.some((candidate, index) =>
          index > 0 && candidate.coverage === best.coverage &&
          candidate.axes.length === best.axes.length
        )
      ) return [];
      return [{ code, axes: best.axes }];
    });
}

// Compatibility export for focused unit tests and older local callers. The
// orchestrator imports the versioned symbol so a deployed Edge bundle cannot
// accidentally retain an older module instance while this contract evolves.
export const resolveCompactFacetCodeEvidenceFromProducts =
  resolveCompactFacetCodeEvidenceFromProductsV2;

/** Bounded, product-free observability for rejected live-schema decodes. */
export function compactFacetCodeProductEvidenceDiagnostics(
  queryText: string,
  facets: CompactCodeFacet[],
  products: CompactCodeProductEvidence[],
): CompactCodeProductEvidenceDiagnostic[] {
  const codes = compactCodesInQuery(queryText);
  if (codes.length === 0 || products.length === 0) return [];
  const minimumCoverage = Math.min(2, products.length);
  const axes = compileAxes(facets, codeFragments(codes)).flatMap((axis) => {
    const fragments = new Map<string, string>();
    const evidencedValues = products.flatMap((product) =>
      productAxisEvidenceValues(product, axis)
    );
    for (const [fragment, candidates] of axis.candidateValues) {
      const evidenceCandidates = candidates.filter((value) =>
        evidencedValues.some((actual) => facetValuesEquivalent(value, actual))
      );
      const ranked = evidenceCandidates.map((value) => ({
        value,
        support: products.filter((product) =>
          productSupportsAxis(product, {
            key: axis.key,
            caption: axis.caption,
            value,
          })
        ).length,
      })).sort((left, right) =>
        right.support - left.support ||
        Number(normalizeCompactCode(right.value) === fragment) -
          Number(normalizeCompactCode(left.value) === fragment) ||
        left.value.length - right.value.length ||
        left.value.localeCompare(right.value)
      );
      const best = ranked[0];
      if (!best || best.support < minimumCoverage) continue;
      const tied = ranked.filter(({ support }) => support === best.support);
      const bestScalar = numericFacetScalar(best.value);
      const equivalentTie = tied.every(({ value }) =>
        normalizeCompactCode(value) === normalizeCompactCode(best.value) ||
        (bestScalar !== null && numericFacetScalar(value) === bestScalar)
      );
      if (!equivalentTie) continue;
      fragments.set(fragment, best.value);
    }
    return fragments.size > 0
      ? [{ ...axis, fragments, allFragments: new Set(fragments.keys()) }]
      : [];
  });
  return codes.map((code) => {
    const paths = [...collectOneCodePaths(code, axes).values()];
    const ranked = paths.map((path) => ({
      axes: path,
      coverage: products.filter((product) =>
        path.every((axis) =>
          productSupportsAxis(product, axis)
        )
      ).length,
    })).sort((left, right) =>
      right.coverage - left.coverage || left.axes.length - right.axes.length
    );
    return {
      code,
      supported_axes: axes.map((axis) => ({
        key: axis.key,
        caption: axis.caption,
        fragments: [...axis.fragments].map(([fragment, value]) => ({
          fragment,
          value,
        })),
      })),
      ranked_paths: ranked.slice(0, 12),
    };
  });
}

/** Small bounded probe used while validating a deployed live-schema decoder. */

/**
 * Category disambiguation needs only proof that a candidate schema can decode
 * the full code across multiple axes. It deliberately receives a fixed score
 * per code, so a category with many ambiguous numeric facets does not win by
 * accumulating accidental matches. Exact filter projection remains stricter
 * and still requires one unique path below.
 */
export function compactFacetCodeSupportScore(
  queryText: string,
  facets: CompactCodeFacet[],
): number {
  const codes = compactCodesInQuery(queryText);
  if (codes.length === 0) return 0;
  const axes = compileAxes(facets, codeFragments(codes));
  return codes.reduce(
    (score, code) => score + (hasMultiAxisCodePath(code, axes) ? 2 : 0),
    0,
  );
}

export function resolveCompactFacetCodeEvidence(
  queryText: string,
  facets: CompactCodeFacet[],
): CompactFacetCodeEvidence[] {
  const codes = compactCodesInQuery(queryText);
  if (codes.length === 0) return [];
  const axes = compileAxes(facets, codeFragments(codes));
  return codes.flatMap((code) => {
    const resolved = resolveOneCode(code, axes);
    return resolved ? [resolved] : [];
  });
}
