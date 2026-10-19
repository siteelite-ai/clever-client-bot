import type { CriteriaFacet } from "./criteria-gate.ts";
import { isAdministrativeCatalogField } from "./catalog-field-policy.ts";
import { resolveAbbreviatedNumericFacetValueEvidence } from "./compact-facet-code.ts";
import {
  isReplacementIdentityFacet,
  type SearchFacet,
} from "./search-filter-guard.ts";

interface CustomerCode {
  token: string;
  scalar: number;
  suffix: string;
}

export interface DeclaredCodeFacetValue {
  key: string;
  value: string;
}

const CODE_LOOKALIKES: Record<string, string> = {
  а: "a",
  в: "b",
  е: "e",
  к: "k",
  м: "m",
  н: "h",
  о: "o",
  р: "p",
  с: "c",
  т: "t",
  у: "y",
  х: "x",
};

function normalizeCode(value: string): string {
  return String(value ?? "").toLocaleLowerCase("ru-RU")
    .replace(/[авекмнорстух]/gu, (letter) => CODE_LOOKALIKES[letter] ?? letter)
    .replace(/[^a-z0-9]/gu, "");
}

function words(value: string): string[] {
  return String(value ?? "").toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е")
    .match(/[a-zа-я0-9]+/gu) ?? [];
}

function inflectedWordMatches(left: string, right: string): boolean {
  if (left === right) return true;
  if (Math.min(left.length, right.length) < 3) return false;
  let shared = 0;
  while (
    shared < Math.min(left.length, right.length) &&
    left[shared] === right[shared]
  ) {
    shared += 1;
  }
  return shared >= Math.min(5, Math.min(left.length, right.length)) &&
    shared / Math.min(left.length, right.length) >= 0.8;
}

function customerCodes(sourceMessage: string): CustomerCode[] {
  const codes = new Map<string, CustomerCode>();
  // Boundaries exclude embedded SKU fragments (`ACH-10001-C`, `AB-16A-X`).
  // The entire customer token, rather than a substring of a model name, must
  // carry the number and its visible unit/axis abbreviation.
  for (
    const match of String(sourceMessage ?? "").matchAll(
      /(?<![\p{L}\p{N}._-])(\d+(?:[.,]\d+)?)([\p{L}]{1,3})(?![\p{L}\p{N}._-])/gu,
    )
  ) {
    const scalar = Number(match[1].replace(",", "."));
    const suffix = normalizeCode(match[2]);
    if (
      !Number.isFinite(scalar) || !suffix ||
      ["тг", "тенге", "kzt"].includes(suffix)
    ) continue;
    const token = normalizeCode(match[0]);
    codes.set(token, { token, scalar, suffix });
  }
  return [...codes.values()];
}

function modelClauses(reasoningText: string): string[][] {
  return String(reasoningText ?? "")
    .split(/[;.!?\n]|,(?!\d)/u)
    .map(words)
    .filter((tokens) => tokens.length > 0);
}

function hasCaptionBeforeClaim(
  caption: string,
  clause: string[],
  valueIndex: number,
): boolean {
  const captionTokens = words(String(caption ?? "").split(",")[0]);
  if (captionTokens.length === 0 || captionTokens.length > 5) return false;
  const first = Math.max(0, valueIndex - captionTokens.length - 3);
  for (let index = first; index + captionTokens.length <= valueIndex; index++) {
    if (valueIndex - index - captionTokens.length > 3) continue;
    if (
      captionTokens.every((token, offset) =>
        inflectedWordMatches(token, clause[index + offset] ?? "")
      )
    ) return true;
  }
  return false;
}

function declaredByModel(
  facet: SearchFacet & CriteriaFacet,
  code: CustomerCode,
  clauses: string[][],
): boolean {
  const suffixFromFacetUnit = normalizeCode(facet.unit ?? "");
  if (suffixFromFacetUnit && suffixFromFacetUnit !== code.suffix) return false;
  const structuralAbbreviation = resolveAbbreviatedNumericFacetValueEvidence(
    code.token,
    [facet],
  )
    .some(({ axis }) => axis.key === facet.key);
  return clauses.some((clause) =>
    clause.some((raw, index) => {
      const claim = raw.match(/^(\d+(?:[.,]\d+)?)([\p{L}]{0,3})$/u);
      if (!claim || Number(claim[1].replace(",", ".")) !== code.scalar) {
        return false;
      }
      const inlineSuffix = normalizeCode(claim[2]);
      const nextSuffix =
        !inlineSuffix && /^[\p{L}]$/u.test(clause[index + 1] ?? "")
          ? normalizeCode(clause[index + 1])
          : "";
      const modelSuffix = inlineSuffix || nextSuffix;
      // A bare model number is not enough to interpret a physical unit. It may
      // only confirm a code like `1P` whose suffix is structural in this live
      // axis; `16A` must also be written with A in the model's declaration.
      if (modelSuffix ? modelSuffix !== code.suffix : !structuralAbbreviation) {
        return false;
      }
      return hasCaptionBeforeClaim(facet.caption || facet.key, clause, index);
    })
  );
}

/**
 * Bridge an explicit customer code to retrieval only when the consultant
 * independently assigned that same number/unit to one complete live caption.
 * The model supplies axis meaning, never a new number. A duplicate live axis,
 * conflicting customer codes, or a model-only value fails closed.
 */
export function projectDeclaredCustomerCodesToLiveFacets(
  facets: Array<SearchFacet & CriteriaFacet>,
  reasoningText: string,
  sourceMessage: string,
): DeclaredCodeFacetValue[] {
  const clauses = modelClauses(reasoningText);
  const candidates = customerCodes(sourceMessage).flatMap((code) => {
    const matches = facets.flatMap((facet) => {
      if (
        isAdministrativeCatalogField(facet) ||
        isReplacementIdentityFacet(facet)
      ) return [];
      const exactValues = [...new Set(facet.values.map(({ value }) => value))]
        .filter((value) => {
          const scalar = String(value).trim().match(/^\d+(?:[.,]\d+)?$/u);
          return scalar && Number(scalar[0].replace(",", ".")) === code.scalar;
        });
      return exactValues.length === 1 && declaredByModel(facet, code, clauses)
        ? [{ key: facet.key, value: exactValues[0] }]
        : [];
    });
    // A model may name two axes with the same numeric value. The customer
    // supplied one code, not permission to hard-filter both axes.
    return matches.length === 1 ? matches : [];
  });
  const valuesByKey = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const values = valuesByKey.get(candidate.key) ?? new Set<string>();
    values.add(candidate.value);
    valuesByKey.set(candidate.key, values);
  }
  return [...valuesByKey].flatMap(([key, values]) =>
    values.size === 1 ? [{ key, value: [...values][0] }] : []
  );
}
