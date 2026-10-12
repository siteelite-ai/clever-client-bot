import { extractPostNominalCatalogQualifier } from "./declared-alias-contract.ts";

function normalize(value: string): string {
  return String(value ?? "").toLocaleLowerCase("ru-RU").replace(/ё/gu, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/gu, " ").trim();
}

type IdentityKind = "brand" | "series" | "model";

function identityKind(facetLabel: string): IdentityKind | null {
  const label = normalize(facetLabel);
  if (
    /(?:^| )(?:brand|vendor|manufacturer|producer|trademark|бренд|производител\p{L}*|изготовител\p{L}*|торгов\p{L}* марк\p{L}*)(?: |$)/u
      .test(label)
  ) return "brand";
  if (
    /(?:^| )(?:series|collection|сери\p{L}*|коллекц\p{L}*)(?: |$)/u.test(label)
  ) {
    return "series";
  }
  if (/(?:^| )(?:model|модел\p{L}*)(?: |$)/u.test(label)) {
    return "model";
  }
  return null;
}

export function isIdentityFacetLabel(facetLabel: string): boolean {
  return identityKind(facetLabel) !== null;
}

/**
 * A repeated token is not proof that the customer asked for a brand/series.
 * Identity is customer-owned only when the request states that relationship,
 * or when a known live product class gives an unambiguous post-nominal role.
 * A token already used by the class itself (e.g. a cable marking) is not a
 * new identity condition. This is structural; no brands/SKUs are listed.
 */
export function customerOwnsIdentityValue(input: {
  facetLabel: string;
  value: string;
  userMessage: string;
  categoryLabel?: string | null;
}): boolean {
  const kind = identityKind(input.facetLabel);
  if (!kind) return false;
  const value = normalize(input.value);
  const user = normalize(input.userMessage);
  const valueTokens = value.split(" ").filter(Boolean);
  if (!user || valueTokens.length === 0) return false;

  const marker = kind === "brand"
    ? String
      .raw`(?:бренд\p{L}*|производител\p{L}*|изготовител\p{L}*|торгов\p{L}*\s+марк\p{L}*|brand|vendor|manufacturer)`
    : kind === "series"
    ? String.raw`(?:сери\p{L}*|коллекц\p{L}*|series|collection)`
    : String.raw`(?:модел\p{L}*|model)`;
  const escapedFirst = valueTokens[0].replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const explicit = new RegExp(
    String.raw`(?:^| )${marker}\s+${escapedFirst}(?= |$)`,
    "u",
  ).test(user);
  if (explicit) return true;

  const category = normalize(input.categoryLabel ?? "");
  if (!category) return false;
  const categoryTokens = new Set(category.split(" "));
  if (categoryTokens.has(valueTokens[0])) return false;
  const postNominal = normalize(
    extractPostNominalCatalogQualifier(input.userMessage, category) ?? "",
  );
  if (
    !postNominal ||
    !(value === postNominal || value.startsWith(`${postNominal} `))
  ) {
    return false;
  }
  const userTokens = user.split(" ");
  const canonicalTokens = value.split(" ");
  const boundary = new Set([
    "на",
    "по",
    "для",
    "с",
    "со",
    "в",
    "во",
    "из",
    "от",
    "до",
    "и",
    "ценой",
    "цене",
    "который",
    "которая",
    "которые",
    "самый",
    "самая",
  ]);
  return userTokens.some((token, index) => {
    if (token !== postNominal) return false;
    let cursor = index + 1;
    for (const part of canonicalTokens.slice(1)) {
      if (userTokens[cursor] !== part) break;
      cursor += 1;
    }
    const next = userTokens[cursor];
    // An unclaimed second name word (Gauss HALL) may be a model/series, not
    // a brand. A preposition, measurement or end-of-phrase is a boundary.
    return !next || boundary.has(next) || /^\d/u.test(next);
  });
}
