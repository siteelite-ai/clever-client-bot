import type { StabilizerApplication } from "./stabilizer-application.ts";
import type { ProductFull } from "./types.ts";

type CurveStep = readonly [inputV: number, conservativePercent: number];
type PassportProfile = {
  source: string;
  page: number;
  revision: string;
  vendor: string;
  series: string;
  phases: 1 | 3;
  workInput: readonly [number, number];
  steady: readonly CurveStep[];
  motor: readonly CurveStep[];
  items: readonly (readonly [article: string, nominalVa: number])[];
};

// Evidence for an exact model family, not a general sizing formula. The
// two ascending curves are read from figure 2 (edition 3), rounded DOWN;
// between points take the previous lower step, never extrapolate below it.
// SKU mapping: IEK retail catalog, "Стабилизаторы напряжения релейные".
const IEK_HUB: PassportProfile = {
  source:
    "https://cdn-01.iek.ru/media/original/6409cddbe5c4af9d39c971f882beb0ed00043f58961cecab9d80f1a26541f067.pdf",
  page: 3,
  revision: "IEK-HUB-ed3-fig2",
  vendor: "IEK",
  series: "HUB",
  phases: 1,
  workInput: [140, 260],
  // Below 150 V this passport also permits transient voltage dips. That
  // part of the work range is deliberately not covered by this profile.
  steady: [[150, 50], [170, 55], [190, 72], [210, 88]],
  motor: [[150, 15], [170, 18], [190, 23], [210, 28]],
  items: [
    ["IVS21-1-D05-13", 500],
    ["IVS21-1-001-13", 1000],
    ["IVS21-1-D15-13", 1500],
    ["IVS21-1-002-13", 2000],
    ["IVS21-1-003-13", 3000],
    ["IVS21-1-005-13", 5000],
    ["IVS21-1-008-13", 8000],
    ["IVS21-1-010-13", 10000],
    ["IVS21-1-012-13", 12000],
  ],
};

export type StabilizerPassportCandidate =
  & Omit<PassportProfile, "steady" | "motor" | "items">
  & {
    article: string;
    nominalVa: number;
    provenVa: number;
  };

export function qualifyingStabilizerPassports(
  application: StabilizerApplication,
  profiles: readonly PassportProfile[] = [IEK_HUB],
): StabilizerPassportCandidate[] {
  if (
    !Number.isFinite(application.inputV) ||
    !Number.isFinite(application.loadVa) ||
    !Number.isFinite(application.peakVa) || application.loadVa <= 0 ||
    application.peakVa < application.loadVa
  ) return [];
  const proofs: StabilizerPassportCandidate[] = [];
  for (const profile of profiles) {
    if (
      application.phases !== profile.phases ||
      application.inputV < profile.workInput[0] ||
      application.inputV > profile.workInput[1]
    ) continue;
    const curve = application.kind === "motor" ? profile.motor : profile.steady;
    const point = curve.findLast(([volts]) => volts <= application.inputV);
    if (!point) continue;
    for (const [article, nominalVa] of profile.items) {
      const provenVa = Math.floor(nominalVa * point[1] / 100);
      if (provenVa < application.peakVa) continue;
      const { source, page, revision, vendor, series, phases, workInput } =
        profile;
      proofs.push({
        source,
        page,
        revision,
        vendor,
        series,
        phases,
        workInput,
        article,
        nominalVa,
        provenVa,
      });
    }
  }
  return proofs.sort((a, b) => a.nominalVa - b.nominalVa);
}

function normalized(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ru").replaceAll("ё", "е")
    .trim();
}

/** A manufacturer record can only supplement the same live SKU. It cannot
 * override a different product, a contradictory catalog field or no stock. */
export function agreesWithStabilizerPassport(
  product: ProductFull,
  proof: StabilizerPassportCandidate,
  inputV: number,
): boolean {
  const vendor = normalized(product.vendor ?? "");
  if (
    normalized(product.article ?? "") !== normalized(proof.article) ||
    (vendor !== normalized(proof.vendor) &&
      !(proof.vendor === "IEK" && vendor === "иэк")) ||
    !/^стабилизаторы(?: напряжения)?$/u.test(
      normalized(product.leaf_category ?? ""),
    ) ||
    !normalized(product.pagetitle).split(/[^\p{L}\p{N}]+/u).includes(
      normalized(proof.series),
    ) ||
    !(product.price > 0) || !Number.isFinite(product.price) ||
    (product.stock !== "in_stock" && product.stock !== "low") ||
    product.warehouse_evidence !== "positive" ||
    !product.warehouses?.some(({ city, qty }) =>
      !!city.trim() && Number.isFinite(qty) && qty > 0
    )
  ) return false;
  const traits: Array<[string, string]> = [];
  for (const [key, values] of Object.entries(product.facet_values ?? {})) {
    const caption = product.facet_captions?.[key];
    if (caption) {
      traits.push(...values.map((v): [string, string] => [caption, v]));
    }
  }
  for (const trait of product.short_traits) {
    const separator = trait.indexOf(":");
    if (separator > 0) {
      traits.push([trait.slice(0, separator), trait.slice(separator + 1)]);
    }
  }
  return traits.every(([name, value]) => {
    const key = normalized(name);
    const val = normalized(value).replaceAll(",", ".");
    if (/^количество\s+фаз$|^число\s+фаз$|^фазность$/u.test(key)) {
      return proof.phases === 1
        ? /^(?:1(?:\s*фаз\p{L}*)?|однофаз\p{L}*)$/u.test(val)
        : /^(?:3(?:\s*фаз\p{L}*)?|трехфаз\p{L}*)$/u.test(val);
    }
    if (
      /^(?:номинальная|полная|выходная)\s+мощность(?:,?\s*к?ва)?$/u.test(key) &&
      (/к?ва$/u.test(key) || /к?ва$/u.test(val))
    ) {
      const m = val.match(/^(\d+(?:\.\d+)?)\s*(к?ва)?$/u);
      return !!m &&
        Number(m[1]) * ((m[2] ?? key).endsWith("ква") ? 1000 : 1) ===
          proof.nominalVa;
    }
    if (
      /^(?:(?:рабочий\s+)?диапазон\s+)?входно(?:го\s+напряжения|е\s+напряжение)(?:,?\s*в)?$/u
        .test(key)
    ) {
      const range = val.match(
        /^(?:от\s+)?(\d{2,3})\s*(?:[-–—]|до)\s*(\d{2,3})\s*(?:в)?$/u,
      );
      // Some feeds report nominal input voltage in this field. A lone
      // nominal value isn't operating-range evidence and doesn't override it.
      if (range) {
        return Number(range[1]) <= inputV && inputV <= Number(range[2]);
      }
      return /^220\s*(?:в)?$/u.test(val);
    }
    return true;
  });
}
