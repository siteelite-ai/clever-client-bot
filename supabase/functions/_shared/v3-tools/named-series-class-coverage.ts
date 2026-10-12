import type { ProductFull } from "./types.ts";
import { extractNamedSeriesToken } from "./intent-mode.ts";

function normalize(value: string): string {
  return String(value ?? "").toLocaleLowerCase("ru-RU").replace(/ё/gu, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function classStem(value: string): string {
  const token = normalize(value).split(" ")[0] ?? "";
  if (token.length >= 7) return token.slice(0, 5);
  if (token.length >= 5) return token.slice(0, 4);
  return token;
}

/**
 * Preserve a customer's explicit bare product-type wording across a later
 * deictic series browse. A single term is only a candidate: grammar alone
 * cannot distinguish "по розеткам" from "по скидкам". No candidate becomes
 * a confirmed class without independent live category evidence.
 */
export function extractRequestedNamedSeriesClasses(message: string): string[] {
  const normalized = normalize(message);
  const series = normalized.match(/(?:^| )сер(?:ия|ии|ию|ией) [\p{L}\p{N}-]{4,}(.*)$/u);
  if (!series) return [];
  const list = series[1].match(
    /(?:^| )(?:по|для) ([\p{L}]{4,}(?: (?:и|или) [\p{L}]{4,}){1,3})$/u,
  ) ?? series[1].match(/^ (?:по|для) ([\p{L}]{4,})$/u);
  if (!list) return [];
  const terms = list[1].split(/ (?:и|или) /u);
  const distinct = new Set<string>();
  return terms.filter((term) => {
    const stem = classStem(term);
    if (!stem || distinct.has(stem)) return false;
    distinct.add(stem);
    return true;
  });
}

export function resolveRequestedNamedSeriesClasses(
  message: string,
  recentDialogue: Array<{ role: "user" | "assistant"; content: string }>,
  seriesToken: string,
): string[] {
  const current = extractRequestedNamedSeriesClasses(message);
  if (current.length > 0) return current;
  const wanted = normalize(seriesToken);
  for (const fragment of [...recentDialogue].reverse()) {
    if (fragment.role !== "user") continue;
    const mentioned = extractNamedSeriesToken(fragment.content);
    if (!mentioned) continue;
    if (normalize(mentioned) !== wanted) break;
    return extractRequestedNamedSeriesClasses(fragment.content);
  }
  return [];
}

export interface NamedSeriesClassCoverage {
  requested: string;
  label: string;
  products: ProductFull[];
}

/** The live leaf category is the strongest class proof; for multi-class
 * requests a title head is a fallback when the API omitted the leaf. A
 * relation such as "рамка для розетки" cannot become a socket by mentioning
 * the word after a preposition. */
export function productProvesNamedSeriesClass(
  product: ProductFull,
  requested: string,
  requireLeaf = false,
): boolean {
  const wanted = classStem(requested);
  if (!wanted) return false;
  const leaf = normalize(product.leaf_category ?? "");
  if (leaf) return leaf.split(" ").some((token) => classStem(token) === wanted);
  return !requireLeaf && classStem(product.pagetitle) === wanted;
}

export function namedSeriesClassCoverage(
  requestedClasses: string[],
  products: ProductFull[],
): NamedSeriesClassCoverage[] {
  return requestedClasses.map((requested) => {
    const matching = products.filter((product) =>
      // A lone syntactic candidate may be an attribute ("по скидкам").
      // Only live taxonomy, not a suggestive title, can promote it to class.
      productProvesNamedSeriesClass(
        product,
        requested,
        requestedClasses.length === 1,
      )
    );
    const leaf = normalize(
      matching.find((product) => product.leaf_category)?.leaf_category ?? "",
    ).slice(0, 80);
    return {
      requested,
      label: leaf ? leaf[0].toLocaleUpperCase("ru-RU") + leaf.slice(1) : requested,
      products: matching,
    };
  });
}

/** Search only a bounded next page while an explicit candidate still lacks
 * live class proof. With no candidate the ordinary one-page route is intact. */
export function shouldSearchNextNamedSeriesClassPage(
  requestedClasses: string[],
  products: ProductFull[],
  total: number,
  pageSize: number,
  pagesScanned: number,
): boolean {
  return requestedClasses.length > 0 && pagesScanned < 3 &&
    total > pagesScanned * pageSize &&
    namedSeriesClassCoverage(requestedClasses, products).some((group) =>
      group.products.length === 0
    );
}

/** One card per requested class before any second card of the same class. */
export function stratifyNamedSeriesProducts(
  coverage: NamedSeriesClassCoverage[],
  limit: number,
): ProductFull[] {
  const selected: ProductFull[] = [];
  const seen = new Set<string>();
  for (let offset = 0; selected.length < limit; offset += 1) {
    let advanced = false;
    for (const group of coverage) {
      const product = group.products[offset];
      if (!product || seen.has(product.id)) continue;
      selected.push(product);
      seen.add(product.id);
      advanced = true;
      if (selected.length >= limit) break;
    }
    if (!advanced) break;
  }
  return selected;
}

/** Add only source-backed class status when explanatory prose missed a type. */
export function appendNamedSeriesClassCoverage(
  explanation: string,
  coverage: NamedSeriesClassCoverage[],
  searchedAllPages: boolean,
): string {
  const notes: string[] = [];
  for (const group of coverage) {
    if (group.products.length > 0) {
      if (!normalize(explanation).split(" ").some((word) =>
        classStem(word) === classStem(group.requested)
      )) {
        notes.push(
          `В этой серии также подтверждены товары раздела «${group.label}».`,
        );
      }
    } else if (coverage.length === 1) {
      // A lone "по X" may describe a property, not a product class. Avoid
      // asserting that the class is absent from the whole catalog.
      notes.push(
        `По уточнению «${group.requested}» не нашёл подтверждённых карточек серии в проверенной части каталога. Уточните, какой тип товара серии вас интересует.`,
      );
    } else {
      notes.push(
        `По запросу «${group.requested}» подтверждённых карточек серии ${
          searchedAllPages ? "в каталоге" : "в проверенной части каталога"
        } не нашёл.`,
      );
    }
  }
  return [explanation.trim(), ...notes].filter(Boolean).join("\n\n");
}
