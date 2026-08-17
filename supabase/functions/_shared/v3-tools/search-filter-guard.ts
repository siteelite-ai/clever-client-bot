// Pure guard for catalog facet filters.
//
// The model may suggest a real catalog value that the customer never requested
// (for example, a commercial/utility use class for a household fixture). Such a
// filter is syntactically valid and therefore dangerous: the catalog faithfully
// returns the wrong products. This guard only permits keys and canonical values
// from the latest discovery response, and only when the value is supported by
// the consultant's declared reasoning or the customer's wording. The customer's
// explicit negation always wins. Unproven filters are removed; the catalog can
// still search the discovered category and the evidence gate validates cards.

export interface SearchFacetValue {
  value: string;
}

export interface SearchFacet {
  key: string;
  values: SearchFacetValue[];
}

export interface DroppedSearchFilter {
  key: string;
  value: string;
  reason: "unknown_facet" | "unknown_value" | "not_declared_in_reasoning" | "negated_by_user";
}

export interface SearchFilterGuardResult {
  args: Record<string, unknown>;
  kept: Array<{ key: string; value: string }>;
  dropped: DroppedSearchFilter[];
}

function norm(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function codeNorm(value: string): string {
  return norm(value).replace(/\s+/g, "");
}

function sameFacetValue(left: string, right: string): boolean {
  if (norm(left) === norm(right)) return true;
  return /\d/.test(left + right) && codeNorm(left) === codeNorm(right);
}

function evidenceStatus(value: string, userEvidence: string): "affirmed" | "negated" | "absent" {
  const wanted = norm(value);
  const evidence = norm(userEvidence);
  if (!wanted || !evidence) return "absent";

  const occurrences: number[] = [];
  let from = 0;
  while (from < evidence.length) {
    const index = evidence.indexOf(wanted, from);
    if (index < 0) break;
    occurrences.push(index);
    from = index + Math.max(1, wanted.length);
  }
  if (occurrences.length === 0) return "absent";

  let sawNegated = false;
  for (const index of occurrences) {
    const prefix = evidence.slice(Math.max(0, index - 40), index).trim();
    const negated = /(?:^|\s)(?:не|без|кроме|исключая|никаких?)\s+(?:\S+\s+){0,2}$/u.test(prefix);
    if (!negated) return "affirmed";
    sawNegated = true;
  }
  return sawNegated ? "negated" : "absent";
}

function contradictedByUser(value: string, userEvidence: string): boolean {
  if (evidenceStatus(value, userEvidence) === "negated") return true;
  const valueTokens = new Set(norm(value).split(" ").filter((token) => token.length >= 3));
  const tokens = norm(userEvidence).split(" ").filter(Boolean);
  for (let index = 0; index < tokens.length; index++) {
    if (!["не", "без", "кроме", "исключая"].includes(tokens[index])) continue;
    const negatedWindow = tokens.slice(index + 1, index + 5);
    if (negatedWindow.some((token) => valueTokens.has(token))) return true;
  }
  return false;
}

export function guardSearchFilters(
  args: Record<string, unknown>,
  facets: SearchFacet[],
  declaredReasoning: string,
  userEvidence: string = declaredReasoning,
): SearchFilterGuardResult {
  if (args.mode !== "by_filter" || !args.options || typeof args.options !== "object") {
    return { args, kept: [], dropped: [] };
  }

  const nextOptions: Record<string, string[]> = {};
  const kept: Array<{ key: string; value: string }> = [];
  const dropped: DroppedSearchFilter[] = [];

  for (const [key, rawValues] of Object.entries(args.options as Record<string, unknown>)) {
    const values = Array.isArray(rawValues) ? rawValues.map(String).filter((v) => v.trim()) : [];
    const facet = facets.find((candidate) => candidate.key === key);
    if (!facet) {
      for (const value of values) dropped.push({ key, value, reason: "unknown_facet" });
      continue;
    }

    for (const rawValue of values) {
      const canonical = facet.values.find((candidate) => sameFacetValue(candidate.value, rawValue))?.value;
      if (!canonical) {
        dropped.push({ key, value: rawValue, reason: "unknown_value" });
        continue;
      }
      if (contradictedByUser(canonical, userEvidence)) {
        dropped.push({ key, value: canonical, reason: "negated_by_user" });
        continue;
      }
      const status = evidenceStatus(canonical, declaredReasoning);
      if (status !== "affirmed") {
        dropped.push({
          key,
          value: canonical,
          reason: status === "negated" ? "negated_by_user" : "not_declared_in_reasoning",
        });
        continue;
      }
      nextOptions[key] ??= [];
      if (!nextOptions[key].includes(canonical)) nextOptions[key].push(canonical);
      kept.push({ key, value: canonical });
    }
  }

  const nextArgs = { ...args };
  if (Object.keys(nextOptions).length > 0) nextArgs.options = nextOptions;
  else delete nextArgs.options;
  return { args: nextArgs, kept, dropped };
}
