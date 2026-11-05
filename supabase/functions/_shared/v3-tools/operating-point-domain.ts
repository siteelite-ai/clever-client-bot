import { canonicalMeasurementUnit } from "./criteria-reasoning.ts";
import { extractClientQuantities } from "./criteria-consistency.ts";
import type { CriteriaFacet, Criterion } from "./criteria-gate.ts";
import type { ProductFull } from "./types.ts";

export interface OperatingPointDomain {
  facetKey: string;
  facetCaption: string;
  unit: string;
  point: number;
  acceptedValues: string[];
  criterion: Criterion;
}

/** Physical roles, not catalog/product aliases. An insulation, coil or output
 * voltage is never the operating supply of the selected main circuit. */
function supplyRole(text: string): boolean {
  if (
    /(?:изоляц|insulat|dielectric|испыт|прочност|импульс|катуш|coil|выходн|output|управл|control)/iu
      .test(text)
  ) return false;
  return /(?:рабоч|(?:^|[^\p{L}])раб(?=$|[^\p{L}])|питан|входн|электросет|(?:^|\s)сет[ьи]|working|operat|supply|input|mains)/iu
    .test(text);
}

/** Strict closed scalar/interval grammar. No open maximum, prose number,
 * multi-rating list, code, or unit conversion becomes a supported domain. */
function parseDomain(
  raw: string,
  unit: string,
): { low: number; high: number } | null {
  const m = raw.trim().match(
    /^(\d+(?:[.,]\d+)?)\s*(?:[-–—]\s*(\d+(?:[.,]\d+)?))?\s*([\p{L}]+)?$/u,
  );
  if (!m || m[3] && canonicalMeasurementUnit(m[3]) !== unit) return null;
  const low = Number(m[1].replace(",", "."));
  const high = Number((m[2] ?? m[1]).replace(",", "."));
  return Number.isFinite(low) && Number.isFinite(high) && low > 0 && high >= low
    ? { low, high }
    : null;
}

/** Server compilation of a literal customer operating point. The facet role,
 * unit, closed domain and same raw value on each final SKU must all agree.
 * A scalar 690 V does not prove support for 380 V; 230–690 V does. */
export function compileCustomerOperatingPointDomains(
  customerText: string,
  facets: readonly CriteriaFacet[],
): OperatingPointDomain[] {
  return resolveCustomerOperatingPointDomains(customerText, facets).domains;
}

export function resolveCustomerOperatingPointDomains(
  customerText: string,
  facets: readonly CriteriaFacet[],
): { domains: OperatingPointDomain[]; unresolved: number } {
  const points = new Map<string, number>();
  const ambiguous = new Set<string>();
  const addPoint = (unit: string, value: number) => {
    if (points.has(unit) && points.get(unit) !== value) ambiguous.add(unit);
    points.set(unit, value);
  };
  // A standalone voltage+phase answer is a supply fact even without the
  // repeated noun "питание". Preserve that physical role across server-joined
  // customer turns; arbitrary prose, product ratings, output/coil/insulation
  // fields and unfinished numbers must not inherit it.
  let unresolvedPhaseReplies = 0;
  for (const line of customerText.split(/\n+/u).map((text) => text.trim())) {
    const reply = line.replace(/^уточнение\s+клиента\s*:\s*/iu, "");
    const standalone =
      /^(\d+(?:[.,]\d+)?)\s*(?:к?в|k?v)\s*[,;/]?\s*[1-9]\d*\s*(?:фаз\p{L}*|phases?)$/iu
        .test(reply);
    const quantities = extractClientQuantities(reply).filter((q) =>
      /^(?:в|кв)$/u.test(canonicalMeasurementUnit(q.unit))
    );
    if (standalone && quantities.length === 1) {
      addPoint(
        canonicalMeasurementUnit(quantities[0].unit),
        quantities[0].value,
      );
    } else if (
      !supplyRole(line) &&
      !/(?:изоляц|insulat|выходн|output|катуш|coil|управл|control|испыт)/iu
        .test(line) &&
      /(?:фаз\p{L}*|phases?)/iu.test(line) && quantities.length > 0 &&
      /(?:^|[^\p{L}])(?:не|нет|кроме|точнее|поправк\p{L}*|исправ\p{L}*)(?!\p{L})|[<>≤≥]/iu
        .test(line)
    ) {
      // A rejected/corrected/qualified reply cannot silently leave a previous
      // exact supply point active. Its meaning must be resolved explicitly.
      unresolvedPhaseReplies++;
    }
  }
  for (const clause of customerText.split(/(?<!\d)[.!?;]+(?!\d)|,\s+|\n+/u)) {
    if (
      !supplyRole(clause) ||
      /(?:не\s+(?:менее|более|ниже|выше)|от\s+\d|до\s+\d|[<>≤≥]|\d\s*[-–—]\s*\d)/iu
        .test(clause)
    ) continue;
    for (const q of extractClientQuantities(clause)) {
      const unit = canonicalMeasurementUnit(q.unit);
      if (
        !/^(?:в|кв)$/u.test(unit) || !Number.isFinite(q.value) || q.value <= 0
      ) continue;
      addPoint(unit, q.value);
    }
  }
  const result: OperatingPointDomain[] = [];
  let unresolved = unresolvedPhaseReplies;
  for (const [unit, point] of points) {
    if (ambiguous.has(unit)) {
      unresolved++;
      continue;
    }
    const operatingAxes = facets.filter((f) =>
      supplyRole(f.caption || f.key) &&
      /(?:напряж|voltage)/iu.test(f.caption || f.key)
    );
    const axes = operatingAxes.filter((f) => {
      const label = f.caption || f.key;
      const captionUnit = label.match(/[,()]\s*([\p{L}]+)\s*\)?\s*$/u)?.[1];
      const declared = canonicalMeasurementUnit(f.unit ?? captionUnit ?? "");
      return declared === unit;
    });
    if (axes.length !== 1) {
      if (operatingAxes.length > 0) unresolved++;
      continue;
    }
    const facet = axes[0];
    // Preserve the existing exact-literal preference when a scalar exists,
    // while retaining its customer-owned obligation independently of prose.
    const exact = facet.values.filter((v) => {
      const d = parseDomain(String(v.value), unit);
      return d?.low === point && d.high === point;
    });
    const acceptedValues = (exact.length ? exact : facet.values).flatMap(
      (v) => {
        const d = parseDomain(String(v.value), unit);
        return d && d.low <= point && point <= d.high ? [String(v.value)] : [];
      },
    );
    if (!acceptedValues.length || acceptedValues.length > 12) {
      unresolved++;
      continue;
    }
    result.push({
      facetKey: facet.key,
      facetCaption: facet.caption,
      unit,
      point,
      acceptedValues,
      criterion: {
        key: facet.caption || facet.key,
        op: "eq",
        value: String(point),
        unit,
        level: "A",
        evidence: "user_explicit",
      },
    });
  }
  return { domains: result, unresolved };
}

/** Equality-style working-point prose must identify the same operating role,
 * not merely repeat the same number/unit for a different physical property. */
export function clauseStatesOperatingPoint(
  clause: string,
  domain: OperatingPointDomain,
): boolean {
  const q = extractClientQuantities(clause);
  return q.length === 1 && q[0].value === domain.point &&
    canonicalMeasurementUnit(q[0].unit) === domain.unit &&
    supplyRole(clause) && /(?:напряж|voltage)/iu.test(clause) &&
    !/(?:не\s+(?:рав|соответ|подход|долж)|не\s+на|кроме|исключ|[<>≤≥]|не\s+(?:менее|более|ниже|выше)|(?:от|до)\s+\d)/iu
      .test(clause);
}

export function productProvesOperatingPointDomain(
  product:
    | Pick<ProductFull, "facet_values" | "facet_captions">
    | null
    | undefined,
  domain: OperatingPointDomain,
): boolean {
  const caption = product?.facet_captions?.[domain.facetKey];
  const values = product?.facet_values?.[domain.facetKey];
  if (
    typeof caption !== "string" ||
    caption.normalize("NFKC").trim().toLowerCase() !==
      domain.facetCaption.normalize("NFKC").trim().toLowerCase() ||
    !Array.isArray(values) || values.length !== 1 ||
    !domain.acceptedValues.includes(values[0])
  ) return false;
  const d = parseDomain(values[0], domain.unit);
  return Boolean(d && d.low <= domain.point && domain.point <= d.high);
}
