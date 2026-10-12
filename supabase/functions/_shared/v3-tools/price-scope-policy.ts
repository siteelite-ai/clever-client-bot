/**
 * A sorted search_catalog response is a candidate window, never an exhaustive
 * price proof. In particular, `total <= results.length` does not certify the
 * query's taxonomy, filters, stock, units, or pagination. Only a separate
 * complete-scope verifier may call a product the catalog minimum/maximum.
 */
export type CatalogPriceExtreme = "cheapest" | "expensive";
export type PriceDirection = "cheaper" | "more_expensive" | "same";
export type PriceIntent = {
  kind: "superlative" | "comparative";
  direction: PriceDirection;
};

export type PriceSearchCoverage =
  | "not_attempted"
  | "truncated"
  | "unverified"
  | "failed";

function normalized(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase("ru-RU").replace(/ё/gu, "е");
}

const CHEAPEST = [
  /(?<![\p{L}\p{N}])сам(?:ый|ая|ое|ые|ого|ую|ой|ым|ых|ыми)\s+(?:дешев[\p{L}]*|недорог[\p{L}]*|доступн[\p{L}]*|бюджетн[\p{L}]*)(?![\p{L}])/u,
  /(?<![\p{L}\p{N}])наиболее\s+(?:дешев[\p{L}]*|недорог[\p{L}]*|доступн[\p{L}]*)(?![\p{L}])/u,
  /(?<![\p{L}\p{N}])сам(?:ая|ую|ой)\s+низк[\p{L}]*\s+цен[\p{L}]*(?![\p{L}])/u,
  /(?<![\p{L}\p{N}])(?:минимальн[\p{L}]*|наименьш[\p{L}]*|низш[\p{L}]*)\s+(?:цен[\p{L}]*|стоимост[\p{L}]*)(?![\p{L}])/u,
  /(?<![\p{L}\p{N}])(?:цен[\p{L}]*|стоимост[\p{L}]*)\s+(?:минимальн[\p{L}]*|наименьш[\p{L}]*)(?![\p{L}])/u,
  /(?<![\p{L}\p{N}])дешевле\s+всех(?![\p{L}])/u,
];

const EXPENSIVE = [
  /(?<![\p{L}\p{N}])сам(?:ый|ая|ое|ые|ого|ую|ой|ым|ых|ыми)\s+дорог[\p{L}]*(?![\p{L}])/u,
  /(?<![\p{L}\p{N}])наиболее\s+дорог[\p{L}]*(?![\p{L}])/u,
  /(?<![\p{L}\p{N}])сам(?:ая|ую|ой)\s+высок[\p{L}]*\s+цен[\p{L}]*(?![\p{L}])/u,
  /(?<![\p{L}\p{N}])(?:максимальн[\p{L}]*|наибольш[\p{L}]*|высш[\p{L}]*)\s+(?:цен[\p{L}]*|стоимост[\p{L}]*)(?![\p{L}])/u,
  /(?<![\p{L}\p{N}])(?:цен[\p{L}]*|стоимост[\p{L}]*)\s+(?:максимальн[\p{L}]*|наибольш[\p{L}]*)(?![\p{L}])/u,
  /(?<![\p{L}\p{N}])дороже\s+всех(?![\p{L}])/u,
];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function absolutePricePhrases(text: string): Array<{ direction: CatalogPriceExtreme; negated: boolean }> {
  const matches: Array<{ direction: CatalogPriceExtreme; start: number; end: number }> = [];
  for (const [direction, patterns] of [
    ["cheapest", CHEAPEST], ["expensive", EXPENSIVE],
  ] as const) {
    for (const pattern of patterns) {
      const repeated = new RegExp(pattern.source, `${pattern.flags}g`);
      for (const match of text.matchAll(repeated)) {
        if (match.index === undefined) continue;
        matches.push({ direction, start: match.index, end: match.index + match[0].length });
      }
    }
  }
  matches.sort((a, b) => a.start - b.start || a.end - b.end);
  const classified: Array<{ direction: CatalogPriceExtreme; start: number; end: number; negated: boolean }> = [];
  for (const phrase of matches) {
    const before = text.slice(0, phrase.start);
    const after = text.slice(phrase.end).split(/[.!?;,—]/u, 1)[0];
    const prefixNegated = /(?<![\p{L}\p{N}])не\s+(?:(?:обязательно|нужен|нужна|нужно|нужны|хочу|ищу|надо|должен|должна|должно)\s+(?:быть\s+)?(?:именно\s+)?(?:(?:вариант|товар|модель)\s+(?:с|по)\s+)?)?$/u
      .test(before);
    const suffixNegated = /^(?:\s+(?!(?:и|или|а|но|зато)(?!\p{L}))[\p{L}\p{N}-]+){0,3}\s+не\s+(?:нужен|нужна|нужно|нужны|подходит|хочу)(?!\p{L})/u
      .test(after);
    const previous = classified.at(-1);
    // "Не хочу самый дешёвый или самый дорогой" negates both members of a
    // coordinate phrase. A contrast (", а ...") starts a new positive request.
    const coordinatedNegation = previous?.negated === true &&
      /^(?:\s*,?\s*(?:или|и)\s*)$/u.test(text.slice(previous.end, phrase.start));
    classified.push({ ...phrase, negated: prefixNegated || suffixNegated || coordinatedNegation });
  }
  for (let index = classified.length - 2; index >= 0; index--) {
    const current = classified[index];
    const next = classified[index + 1];
    if (next.negated && /^(?:\s*,?\s*(?:или|и)\s*)$/u.test(text.slice(current.end, next.start))) {
      current.negated = true;
    }
  }
  return classified.map(({ direction, negated }) => ({ direction, negated }));
}

/** An explicit absolute price request, distinct from a budget or preference. */
export function classifyCatalogPriceExtreme(
  message: string,
): CatalogPriceExtreme | null {
  const text = normalized(message);
  const phrases = absolutePricePhrases(text);
  const cheapest = phrases.some((phrase) => phrase.direction === "cheapest" && !phrase.negated);
  const expensive = phrases.some((phrase) => phrase.direction === "expensive" && !phrase.negated);
  // An ambiguous request must not silently pick an order.
  if (cheapest === expensive) return null;
  return cheapest ? "cheapest" : "expensive";
}

/** A budget never erases a separately requested order or comparison. */
export function detectPriceDirection(message: string): PriceIntent | null {
  const text = normalized(message);
  const explicit = classifyCatalogPriceExtreme(message);
  if (explicit) {
    return {
      kind: "superlative",
      direction: explicit === "cheapest" ? "cheaper" : "more_expensive",
    };
  }
  // "Не дороже 5000" is a cap, not a request for a comparative ranking.
  const comparativeText = text.replace(
    /(?<![\p{L}\p{N}])не\s+(?:подороже|дороже|подешевле|дешевле)(?![\p{L}])/gu,
    "",
  );

  if (
    /(?:в том же.*(?:сегмент|ценов)|таком же.*ценов|той же цене|такого же.*ценов)/u
      .test(comparativeText)
  ) {
    return { kind: "comparative", direction: "same" };
  }
  if (/(?:подешевле|дешевле)/u.test(comparativeText)) {
    return { kind: "comparative", direction: "cheaper" };
  }
  if (/(?:подороже|дороже)/u.test(comparativeText)) {
    return { kind: "comparative", direction: "more_expensive" };
  }
  // Relative price-tier preferences remain candidate ranking only; the
  // separate explicit-extreme classifier decides whether a catalog-wide
  // minimum/maximum disclosure is required.
  if (
    /(?:бюджетн|поэконом|подоступн|премиум|премьюм|топов|подсолидн|флагман)/u
      .test(text)
  ) {
    return {
      kind: "superlative",
      direction: /(?:бюджетн|поэконом|подоступн)/u.test(text)
        ? "cheaper"
        : "more_expensive",
    };
  }
  return null;
}

/** Diagnostic only: none of these states certifies a catalog-wide extreme. */
export function classifyPriceSearchCoverage(
  result: {
    ok: boolean;
    warnings?: string[];
  } | null,
): PriceSearchCoverage {
  if (!result) return "not_attempted";
  if (!result.ok) return "failed";
  if (
    result.warnings?.some((warning) => warning.startsWith("sort_truncated:"))
  ) {
    return "truncated";
  }
  return "unverified";
}

/** Remove model-authored absolute-price sentences; keep unrelated reasoning. */
export function stripUnprovenPriceClaimSentences(text: string): string {
  const source = String(text ?? "");
  const claims = [...CHEAPEST, ...EXPENSIVE];
  // This runs on every generic answer, including ordinary non-price answers.
  // Leave their paragraph and list formatting intact when there is no claim.
  if (!matchesAny(normalized(source), claims)) return source.trim();
  const lines = source.split("\n").map((line) => {
    if (!matchesAny(normalized(line), claims)) return line;
    const parts = line.split(/(?<=[.!?])(\s+)/u);
    let safe = "";
    for (let i = 0; i < parts.length; i += 2) {
      const sentence = parts[i] ?? "";
      if (!matchesAny(normalized(sentence), claims)) {
        safe += sentence + (parts[i + 1] ?? "");
      }
    }
    return safe.trimEnd();
  });
  return lines.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
}

export function unprovenCatalogPriceNotice(
  direction: CatalogPriceExtreme,
  hasCandidates: boolean,
): string {
  const bound = direction === "cheapest" ? "минимальную" : "максимальную";
  return hasCandidates
    ? `Показываю варианты из найденной части каталога. Полнота поиска не подтверждена, поэтому ${bound} цену среди всех подходящих товаров назвать не могу.`
    : `Не удалось подтвердить ${bound} цену среди всех подходящих товаров каталога. Попробуйте повторить запрос позже или уточните нужную категорию.`;
}

/**
 * Every generic model final is unproved for catalog-wide price extrema,
 * including when the customer only named a budget or asked an ordinary
 * selection question. A disclosure is required only for an explicit customer
 * superlative; it must never be triggered by the model's volunteered claim.
 */
export function guardGenericExpertFinalPriceText(input: {
  modelText: string;
  requestedExtreme: CatalogPriceExtreme | null;
  noticeAlreadySent: boolean;
  catalogSearchAttempted: boolean;
  renderedCandidates: number;
}): { text: string; noticeAdded: boolean } {
  const text = stripUnprovenPriceClaimSentences(input.modelText);
  const needsNotice = Boolean(
    input.requestedExtreme && !input.noticeAlreadySent &&
      (input.catalogSearchAttempted || !text.trim()),
  );
  if (!needsNotice || !input.requestedExtreme) {
    return { text, noticeAdded: false };
  }
  const notice = unprovenCatalogPriceNotice(
    input.requestedExtreme,
    input.renderedCandidates > 0,
  );
  return {
    text: `${text.trim()}${text.trim() ? "\n\n" : ""}${notice}`,
    noticeAdded: true,
  };
}
