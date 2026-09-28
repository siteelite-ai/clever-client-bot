import type { Criterion } from "./criteria-gate.ts";

interface LiveFacet {
  key: string;
  caption?: string | null;
  unit?: string | null;
  values?: Array<{ value: string }>;
}

export interface VerifiedApplicationSelectionPlan {
  rule: string;
  reasoning: string;
  criteria: Criterion[];
}

function normalize(value: string): string {
  return String(value ?? "")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е")
    .replace(/[×х*]/gu, "x")
    .replace(/,/gu, ".")
    .replace(/[^\p{L}\p{N}.]+/gu, " ")
    .trim();
}

function exactLiveCriterion(
  facets: LiveFacet[],
  caption: RegExp,
  expected: RegExp,
): Criterion | null {
  const candidates = facets.filter((facet) =>
    caption.test(normalize(`${facet.caption ?? ""} ${facet.key}`))
  );
  const matches = candidates.flatMap((facet) =>
    (facet.values ?? [])
      .filter(({ value }) => expected.test(normalize(value)))
      .map(({ value }) => ({ facet, value }))
  );
  if (matches.length !== 1) return null;
  return {
    key: matches[0].facet.caption || matches[0].facet.key,
    op: "eq",
    value: matches[0].value,
    unit: matches[0].facet.unit ?? undefined,
    level: "A",
    evidence: "derived_required",
  };
}

function outdoorWeldingExtensionPlan(
  message: string,
  productClass: string,
  facets: LiveFacet[],
): VerifiedApplicationSelectionPlan | null {
  const source = normalize(message);
  if (!/удлинител\p{L}*/u.test(source)) return null;
  if (!/свароч\p{L}*\s+аппарат\p{L}*/u.test(source)) return null;
  if (!/ули[цч]\p{L}*|наруж\p{L}*/u.test(source)) return null;
  if (!/удлинител\p{L}*/u.test(normalize(productClass))) return null;

  const requestedLength = source.match(
    /(?<!\d)(\d+(?:\.\d+)?)\s*м(?:етр\p{L}*)?(?!\p{L})/u,
  )?.[1];
  // The rule describes a length-specific engineering selection. Never fill a
  // missing length or silently accept a nearby live value: the exact value
  // must be both customer-owned and uniquely represented by the category
  // schema.
  if (!requestedLength) return null;
  const escapedLength = requestedLength.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const lengthCriterion = exactLiveCriterion(
    facets,
    /длин\p{L}*\s+(?:кабел|провод|шнур)\p{L}*/u,
    new RegExp(`^${escapedLength}(?:\\.0+)?(?:\\s*м)?$`, "u"),
  );

  const requirements = [
    lengthCriterion,
    exactLiveCriterion(
      facets,
      /сечен\p{L}*\s+жил/u,
      /^(?:2\.5|2\.50)(?:\s*мм2)?$/u,
    ),
    exactLiveCriterion(facets, /количеств\p{L}*\s+жил/u, /^3$/u),
    exactLiveCriterion(
      facets,
      /степен\p{L}*\s+защит/u,
      /^(?:ip\s*)?44$/u,
    ),
    exactLiveCriterion(
      facets,
      /номинальн\p{L}*\s+ток/u,
      /^16(?:\.0)?(?:\s*а)?$/u,
    ),
    exactLiveCriterion(
      facets,
      /тип\p{L}*\s+кабел/u,
      /^кг$/u,
    ),
  ];
  if (requirements.some((criterion) => !criterion)) return null;
  return {
    rule: "outdoor_welding_extension_16a",
    reasoning:
      `Для уличного подключения сварочного аппарата на ${requestedLength} м обязательны: длина кабеля — ${requestedLength} м; тип кабеля — КГ; количество жил — 3; сечение жилы — 2,5 мм²; номинальный ток — 16 А; степень защиты — 44 (IP44). Показываю только удлинители, у которых эти характеристики подтверждены. Такой вариант допустим, только если входной ток аппарата по шильдику не превышает 16 А; кабель на катушке при работе нужно полностью разматывать.`,
    criteria: requirements as Criterion[],
  };
}

const RULES = [outdoorWeldingExtensionPlan] as const;

/**
 * Returns a complete live-schema-backed suitability contract or null.  A rule
 * is fail-closed: if even one mandatory facet/value is absent or ambiguous,
 * no partial criteria are returned and the ordinary reasoning route remains
 * responsible for the request.
 */
export function resolveVerifiedApplicationSelection(
  message: string,
  productClass: string,
  facets: LiveFacet[],
): VerifiedApplicationSelectionPlan | null {
  for (const rule of RULES) {
    const plan = rule(message, productClass, facets);
    if (plan) return plan;
  }
  return null;
}
