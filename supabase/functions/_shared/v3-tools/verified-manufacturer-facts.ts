import { normalizeProductUrl } from "./search-catalog.ts";
import type { ProductFull } from "./types.ts";

/**
 * Internal, manually approved manufacturer evidence. The caller must fetch the
 * row with service-role authority from a controlled table; a public request or
 * ProductRef must never supply it. This validator does not fetch the document,
 * decide that a domain belongs to the manufacturer, or prove installation fit.
 */
export interface VerifiedManufacturerFacts {
  binding: {
    product_id: string;
    article: string;
    catalog_url: string;
  };
  provenance: {
    source_url: string;
    document_version: string;
    /** Required for PDF sources; null for an unpaginated HTML product page. */
    document_page: number | null;
    verified_at: string;
    valid_until: string;
    approved_at: string;
    approved_by: string;
  };
  technical: {
    /** Explicit form in the approved manufacturer document, never a synonym inferred from catalogue grouping. */
    fixture_form?: "downlight" | null;
    cutout: {
      shape: "round";
      kind: "exact" | "range";
      /** Inclusive bounds in millimetres; equal only for `exact`. */
      min_mm: number;
      max_mm: number;
    } | null;
    outer_diameter_mm: number | null;
    color_temperature_k: number | null;
    integrated_led: boolean | null;
    socket: { kind: "none" } | { kind: "base"; code: string } | null;
    driver: { included: boolean; type: string | null } | null;
    supply_v: { min: number; max: number } | null;
  };
}

type Row = Record<string, unknown>;
type Interval = { min: number; max: number };

const REQUIRED_COLUMNS = [
  "product_id",
  "article",
  "catalog_url",
  "source_url",
  "document_version",
  "document_page",
  "verified_at",
  "valid_until",
  "approval_status",
  "approved_at",
  "approved_by",
  "revoked_at",
  "cutout_shape",
  "cutout_kind",
  "cutout_min_mm",
  "cutout_max_mm",
  "outer_diameter_mm",
  "color_temperature_k",
  "integrated_led",
  "socket_kind",
  "socket_code",
  "driver_included",
  "driver_type",
  "supply_min_v",
  "supply_max_v",
] as const;

const DAY_MS = 86_400_000;
const MAX_VALIDITY_MS = 366 * DAY_MS;
const CUTOUT_LABEL = String
  .raw`(?:диаметр\s+(?:монтажного|посадочного|установочного)\s+отверстия|(?:монтажное|посадочное|установочное)\s+отверстие|(?:монтажный|посадочный|установочный)\s+(?:вырез|диаметр)|диаметр\s+выреза|размер\s+(?:монтажного|посадочного|установочного)\s+отверстия|размер\s+выреза|вырез(?:\s+под\s+светильник)?|(?:cut[\s-]?out|mounting\s+hole|installation\s+hole)(?:\s+(?:diameter|size))?)`;
const OUTER_LABEL = String
  .raw`(?:(?:наружный|внешний|габаритный)\s+диаметр|(?:outer|outside|overall)\s+diameter)`;
const CUTOUT_CAPTION = new RegExp(`^${CUTOUT_LABEL}(?:[, ]+(?:мм|mm))?$`, "iu");
const CUTOUT_IN_CONTENT = new RegExp(CUTOUT_LABEL, "giu");
const CUTOUT_ANY = new RegExp(CUTOUT_LABEL, "iu");
const OUTER_CAPTION = new RegExp(`^${OUTER_LABEL}(?:[, ]+(?:мм|mm))?$`, "iu");
const OUTER_IN_CONTENT = new RegExp(OUTER_LABEL, "giu");
const OUTER_ANY = new RegExp(OUTER_LABEL, "iu");
const DIMENSION_VALUE =
  /^\s*(?:[Ø⌀]\s*)?(\d{1,4}(?:[.,]\d{1,2})?)(?:\s*[-–—]\s*(\d{1,4}(?:[.,]\d{1,2})?))?\s*(мм|mm)?\s*$/iu;
const DIMENSION_PREFIX =
  /^\s*(?::|=|[-–—])?\s*(?:[Ø⌀]\s*)?(\d{1,4}(?:[.,]\d{1,2})?)(?:\s*[-–—]\s*(\d{1,4}(?:[.,]\d{1,2})?))?\s*(мм|mm)(?=$|[^\p{L}\p{N}])/iu;

function plainRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null);
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= max && value === value.trim() &&
    !/[\p{Cc}\p{Cf}]/u.test(value);
}

function positive(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) &&
    value > 0 && value <= max;
}

function nullablePositive(value: unknown, max: number): value is number | null {
  return value === null || positive(value, max);
}

function nullableBoolean(value: unknown): value is boolean | null {
  return value === null || typeof value === "boolean";
}

function timestamp(value: unknown): number | null {
  if (
    typeof value !== "string" || value.length > 40 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/u
      .test(value)
  ) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const [year, month, day, hour, minute, second] = value.match(/\d+/gu)!.slice(
    0,
    6,
  ).map(Number);
  if (
    month < 1 || month > 12 || day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    hour > 23 || minute > 59 || second > 59
  ) return null;
  return parsed;
}

function httpsUrl(value: unknown, max: number): URL | null {
  if (!boundedText(value, max)) return null;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/u
        .test(parsed.hostname) ||
      parsed.username || parsed.password || parsed.port ||
      parsed.hash || parsed.href !== value ||
      /(?:\.local|\.internal)$/u.test(parsed.hostname)
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

function canonicalCatalogUrl(value: unknown): value is string {
  const parsed = httpsUrl(value, 600);
  return Boolean(
    parsed && parsed.hostname === "220volt.kz" &&
      !parsed.search && normalizeProductUrl(value) === value,
  );
}

function normalizedLabel(raw: string): string {
  return raw.normalize("NFKC").toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е").replace(/\s+/gu, " ").trim();
}

function dimensionNumber(raw: string): number | null {
  const value = Number(raw.replace(",", "."));
  return positive(value, 10_000) ? value : null;
}

function intervalFromMatch(match: RegExpMatchArray): Interval | null {
  const min = dimensionNumber(match[1]);
  const max = dimensionNumber(match[2] ?? match[1]);
  return min !== null && max !== null && min <= max ? { min, max } : null;
}

function optionDimension(
  caption: string,
  rawValue: unknown,
): Interval | null {
  if (typeof rawValue !== "string" || rawValue.length > 100) return null;
  const value = normalizedLabel(rawValue);
  const match = value.match(DIMENSION_VALUE);
  if (!match) return null;
  const captionHasUnit = /(?:[, ]+(?:мм|mm))$/u.test(normalizedLabel(caption));
  if (!match[3] && !captionHasUnit) return null;
  return intervalFromMatch(match);
}

/**
 * Only explicitly labelled live catalogue data is checked. Generic diameter,
 * the product title and model/stock/article digits are never cut-out evidence.
 * A labelled but malformed value makes the approved row unusable.
 */
function contentIntervals(
  content: string,
  labelPattern: RegExp,
): Interval[] | null {
  const intervals: Interval[] = [];
  const text = normalizedLabel(content.slice(0, 1_200));
  for (const label of text.matchAll(labelPattern)) {
    const after = text.slice((label.index ?? 0) + label[0].length);
    const match = after.match(DIMENSION_PREFIX);
    if (!match) return null;
    const interval = intervalFromMatch(match);
    if (!interval) return null;
    const tail = after.slice(match[0].length).split(".", 1)[0];
    // A tolerance, second unlabeled number or prose still attached to the
    // measurement makes the catalogue claim ambiguous. Later sentences do not.
    if (
      tail && !/^[\s,;:!?()]*$/u.test(tail) &&
      !/^\s*[,;]?\s*(?:диаметр|монтаж|посадоч|установоч|вырез|cut[\s-]?out|mounting\s+hole|installation\s+hole|наружный|внешний|габаритный|outer|outside|overall)/u
        .test(tail)
    ) return null;
    intervals.push(interval);
  }
  return intervals;
}

function liveCatalogDimensions(
  product: ProductFull,
): { cutout: Interval[]; outer: Interval[] } | null {
  const cutout: Interval[] = [];
  const outer: Interval[] = [];
  for (const trait of product.short_traits ?? []) {
    if (typeof trait !== "string" || trait.length > 300) continue;
    const separator = trait.indexOf(":");
    const caption = separator > 0
      ? normalizedLabel(trait.slice(0, separator))
      : "";
    const directTarget = CUTOUT_CAPTION.test(caption)
      ? cutout
      : OUTER_CAPTION.test(caption)
      ? outer
      : null;
    if (directTarget) {
      const interval = optionDimension(caption, trait.slice(separator + 1));
      if (!interval) return null;
      directTarget.push(interval);
    } else if (CUTOUT_ANY.test(trait) || OUTER_ANY.test(trait)) {
      // A labelled cut-out embedded in a nonstandard trait is still live
      // catalogue evidence; it must not silently disappear behind the lack
      // of a normal `caption: value` projection.
      const embeddedCutout = contentIntervals(trait, CUTOUT_IN_CONTENT);
      const embeddedOuter = contentIntervals(trait, OUTER_IN_CONTENT);
      if (!embeddedCutout || !embeddedOuter) return null;
      cutout.push(...embeddedCutout);
      outer.push(...embeddedOuter);
    }
  }
  for (
    const [key, rawCaption] of Object.entries(product.facet_captions ?? {})
  ) {
    if (typeof rawCaption !== "string") continue;
    const caption = normalizedLabel(rawCaption);
    const target = CUTOUT_CAPTION.test(caption)
      ? cutout
      : OUTER_CAPTION.test(caption)
      ? outer
      : null;
    if (!target) continue;
    const values = product.facet_values?.[key];
    if (!Array.isArray(values) || values.length !== 1) return null;
    const interval = optionDimension(rawCaption, values[0]);
    if (!interval) return null;
    target.push(interval);
  }
  const content = product.description_excerpt;
  if (typeof content === "string") {
    const contentCutout = contentIntervals(content, CUTOUT_IN_CONTENT);
    const contentOuter = contentIntervals(content, OUTER_IN_CONTENT);
    if (!contentCutout || !contentOuter) return null;
    cutout.push(...contentCutout);
    outer.push(...contentOuter);
  }
  if (
    cutout.some(({ min, max }) =>
      min !== cutout[0].min || max !== cutout[0].max
    ) ||
    outer.some(({ min, max }) => min !== outer[0].min || max !== outer[0].max)
  ) return null;
  return { cutout, outer };
}

type TechnicalClaimRole =
  | "fixture_form"
  | "color_temperature"
  | "integrated_led"
  | "lamp_technology"
  | "socket"
  | "driver"
  | "supply";
type TechnicalClaim = {
  role: TechnicalClaimRole;
  caption: string;
  value: string;
};

/** Machine keys and title/model tokens are not evidence; only the human
 * caption paired with a live option or an explicit description label is. */
function technicalClaimRole(rawCaption: string): TechnicalClaimRole | null {
  const caption = normalizedLabel(rawCaption);
  if (/^(?:вид|тип|класс) светильника$/u.test(caption)) {
    return "fixture_form";
  }
  if (
    /^(?:цветовая температура(?:,\s*(?:к|k))?|color temperature(?:,\s*k)?)$/u
      .test(caption)
  ) {
    return "color_temperature";
  }
  if (
    /^(?:встроенн(?:ый|ые) (?:светодиод(?:ы|ный источник света)|led(?:-модуль)?)|наличие встроенных светодиодов|integrated led)$/u
      .test(caption)
  ) {
    return "integrated_led";
  }
  if (/^(?:тип лампы|технология освещения)$/u.test(caption)) {
    return "lamp_technology";
  }
  if (/^(?:тип цоколя|цоколь|тип патрона)$/u.test(caption)) {
    return "socket";
  }
  if (
    /^(?:пра|драйвер|тип драйвера|драйвер в комплекте|пра в комплекте)$/u.test(
      caption,
    )
  ) {
    return "driver";
  }
  if (
    /^(?:(?:рабочее|питающее) напряжение|напряжение питания|напряжение)(?:,\s*(?:в|v))?$/u
      .test(caption)
  ) {
    return "supply";
  }
  return null;
}

const TECHNICAL_DESCRIPTION_LABEL =
  /(?:^|[^\p{L}\p{N}])((?:(?:вид|тип|класс) светильника|цветовая температура(?:,\s*(?:к|k))?|color temperature(?:,\s*k)?|встроенн(?:ый|ые) (?:светодиод(?:ы|ный источник света)|led(?:-модуль)?)|наличие встроенных светодиодов|integrated led|тип лампы|технология освещения|тип цоколя|цоколь|тип патрона|драйвер в комплекте|пра в комплекте|тип драйвера|драйвер|пра|(?:рабочее|питающее) напряжение|напряжение питания|напряжение)(?:,\s*(?:в|v))?)\s*[:=–—]\s*([^.;\n]{1,100})/giu;

/** Only mutually exclusive explicit catalogue classes can veto a downlight.
 * A broader class such as "точечные светильники" stays unknown, never proof.
 * Titles, model tokens and machine facet keys are not class evidence. */
const NON_DOWNLIGHT_FIXTURE_CLASSES = new Set([
  "прожектор",
  "прожекторы",
  "уличный прожектор",
  "уличные прожекторы",
  "линейный светильник",
  "линейные светильники",
  "трековый светильник",
  "трековые светильники",
  "панельный светильник",
  "панельные светильники",
  "светодиодная панель",
  "светодиодные панели",
  "люстра",
  "люстры",
  "настенное бра",
  "светодиодная лента",
  "floodlight",
  "linear luminaire",
  "track light",
  "led panel",
]);

function explicitlyDifferentFixtureClass(value: string): boolean {
  if (NON_DOWNLIGHT_FIXTURE_CLASSES.has(value)) return true;
  // Catalogue classes can prepend usage and mounting adjectives. Only these
  // bounded, positive modifiers plus an explicit incompatible form count;
  // never treat "точечные" as an alias or a contradiction for downlight.
  return /^(?:(?:бытов[а-я]*|офисн[а-я]*|уличн[а-я]*|промышленн[а-я]*|светодиодн[а-я]*|встраиваем[а-я]*|накладн[а-я]*|подвесн[а-я]*)\s+){1,3}(?:линейн(?:ый|ые)\s+светильник(?:и)?|треков(?:ый|ые)\s+светильник(?:и)?|панельн(?:ый|ые)\s+светильник(?:и)?|светодиодн(?:ая|ые)\s+панел(?:ь|и)|прожектор(?:ы)?|панели)$/u
    .test(value);
}

function liveTechnicalClaims(product: ProductFull): TechnicalClaim[] {
  const claims: TechnicalClaim[] = [];
  const add = (caption: string, value: unknown) => {
    const role = technicalClaimRole(caption);
    if (role && typeof value === "string" && value.length <= 120) {
      claims.push({
        role,
        caption: normalizedLabel(caption),
        value: normalizedLabel(value),
      });
    }
  };
  for (const trait of product.short_traits ?? []) {
    if (typeof trait !== "string" || trait.length > 300) continue;
    const colon = trait.indexOf(":");
    if (colon > 0) add(trait.slice(0, colon), trait.slice(colon + 1));
  }
  for (const [key, caption] of Object.entries(product.facet_captions ?? {})) {
    if (typeof caption !== "string") continue;
    const values = product.facet_values?.[key];
    if (!Array.isArray(values)) continue;
    for (const value of values) add(caption, value);
  }
  if (typeof product.description_excerpt === "string") {
    const content = product.description_excerpt.slice(0, 1_200);
    for (const match of content.matchAll(TECHNICAL_DESCRIPTION_LABEL)) {
      add(match[1], match[2]);
    }
  }
  return claims;
}

/** Re-check explicit live classes at the final selection boundary too. This
 * guards callers that attach an already typed fact object without hydration.
 * Unknown or broad classes are not proof of form; only an explicitly
 * incompatible class can veto a manufacturer-approved downlight. */
export function fixtureFormContradictsLiveCatalogue(
  product: ProductFull,
  form: "downlight",
): boolean {
  if (form !== "downlight") return true;
  return liveTechnicalClaims(product).some((claim) =>
    claim.role === "fixture_form" &&
    explicitlyDifferentFixtureClass(claim.value)
  );
}

function voltageInterval(raw: string): Interval | null {
  const match = raw.match(
    /^(\d{1,4}(?:[.,]\d{1,2})?)(?:\s*[-–—]\s*(\d{1,4}(?:[.,]\d{1,2})?))?\s*(?:в|v)?$/u,
  );
  if (!match) return null;
  const min = Number(match[1].replace(",", "."));
  const max = Number((match[2] ?? match[1]).replace(",", "."));
  return min > 0 && max >= min && max <= 10_000 ? { min, max } : null;
}

function kelvinInterval(raw: string): Interval | null {
  const match = raw.match(/^(\d{4,5})(?:\s*[-–—]\s*(\d{4,5}))?\s*(?:к|k)?$/u);
  if (!match) return null;
  const min = Number(match[1]);
  const max = Number(match[2] ?? match[1]);
  return min >= 1_000 && max >= min && max <= 20_000 ? { min, max } : null;
}

function catalogSocket(
  raw: string,
): { kind: "none" } | { kind: "base"; code: string } | null {
  if (/^(?:нет|без цоколя|отсутствует|не предусмотрен)$/u.test(raw)) {
    return { kind: "none" };
  }
  const compact = raw.replace(/[\s-]/gu, "").toUpperCase()
    .replace(/^Е/u, "E").replace(/^Г/u, "G")
    .replace(/^GУ/u, "GU").replace(/^GХ/u, "GX");
  return /^(?:GU|GX|G|E|R)\d{1,3}[A-Z]?$/u.test(compact)
    ? { kind: "base", code: compact }
    : null;
}

function explicitBoolean(raw: string): boolean | null {
  if (
    /^(?:да|есть|встроенн[\p{L}]*|интегрирован[\p{L}]*|yes|true|included|built[ -]?in)$/u
      .test(raw)
  ) {
    return true;
  }
  if (
    /^(?:нет|отсутствует|не предусмотрен|не встроен[\p{L}]*|no|false)$/u.test(
      raw,
    )
  ) {
    return false;
  }
  return null;
}

function integratedLed(raw: string): boolean | null {
  const boolean = explicitBoolean(raw);
  if (boolean !== null) return boolean;
  if (
    /^(?:встроенн[\p{L}]*|интегрирован[\p{L}]*)\s+(?:led(?:-модуль)?|светодиод[\p{L}]*)$/u
      .test(raw)
  ) {
    return true;
  }
  if (/^(?:сменная|заменяемая) лампа$/u.test(raw)) return false;
  return null;
}

function driverIncluded(raw: string, caption: string): boolean | null {
  if (/(?:драйвер|пра) в комплекте$/u.test(caption)) {
    return explicitBoolean(raw);
  }
  if (
    /^(?:в комплекте|встроенн[\p{L}]*|интегрирован[\p{L}]*|included|built[ -]?in)$/u
      .test(raw)
  ) {
    return true;
  }
  if (
    /^(?:не в комплекте|без драйвера|без пра|отсутствует|нет|not included)$/u
      .test(raw)
  ) {
    return false;
  }
  return null;
}

function driverCurrentType(
  raw: string,
): "constant_current" | "constant_voltage" | null {
  const current =
    /(?:constant[ -]?current|постоянн[\p{L}]*\s+ток[\p{L}]*|\bcc\b)/u.test(raw);
  const voltage =
    /(?:constant[ -]?voltage|постоянн[\p{L}]*\s+напряжен[\p{L}]*|\bcv\b)/u.test(
      raw,
    );
  return current === voltage
    ? null
    : current
    ? "constant_current"
    : "constant_voltage";
}

function technicalClaimContradicts(row: Row, claim: TechnicalClaim): boolean {
  const { role, caption, value } = claim;
  if (role === "fixture_form" && row.fixture_form === "downlight") {
    return explicitlyDifferentFixtureClass(value);
  }
  if (role === "color_temperature" && row.color_temperature_k !== null) {
    const observed = kelvinInterval(value);
    return observed !== null && (
      (row.color_temperature_k as number) < observed.min ||
      (row.color_temperature_k as number) > observed.max
    );
  }
  if (role === "integrated_led" && row.integrated_led !== null) {
    const observed = integratedLed(value);
    return observed !== null && observed !== row.integrated_led;
  }
  if (role === "lamp_technology" && row.integrated_led === true) {
    return /^(?:галогенн[\p{L}]*|люминесцентн[\p{L}]*|накаливан[\p{L}]*|halogen|fluorescent|incandescent)$/u
      .test(value);
  }
  if (role === "socket" && row.socket_kind !== null) {
    const observed = catalogSocket(value);
    return observed !== null &&
      (observed.kind !== row.socket_kind ||
        observed.kind === "base" && observed.code !== row.socket_code);
  }
  if (role === "driver" && row.driver_included !== null) {
    const observedIncluded = driverIncluded(value, caption);
    if (observedIncluded !== null && observedIncluded !== row.driver_included) {
      return true;
    }
    const expectedType = typeof row.driver_type === "string"
      ? driverCurrentType(normalizedLabel(row.driver_type))
      : null;
    const observedType = driverCurrentType(value);
    return expectedType !== null && observedType !== null &&
      expectedType !== observedType;
  }
  if (role === "supply" && row.supply_min_v !== null) {
    const observed = voltageInterval(value);
    return observed !== null &&
      (observed.min < (row.supply_min_v as number) ||
        observed.max > (row.supply_max_v as number));
  }
  return false;
}

function intervalsCompatible(approved: Interval, observed: Interval): boolean {
  // A narrower labelled catalogue statement is not contradictory to a
  // broader manufacturer tolerance. Crossing (partly overlapping) ranges are
  // ambiguous and therefore rejected, as are disjoint ranges.
  return (approved.min <= observed.min && observed.max <= approved.max) ||
    (observed.min <= approved.min && approved.max <= observed.max);
}

/**
 * Pure gate over a service-role-fetched row and the exact live ProductFull.
 * Returns null for any missing, stale, revoked, malformed or contradictory
 * evidence. Never mutates ProductFull and never adds facts to ProductRef.
 */
export function validateVerifiedManufacturerFacts(
  value: unknown,
  product: ProductFull,
  now: Date,
): VerifiedManufacturerFacts | null {
  if (
    !plainRow(value) ||
    !REQUIRED_COLUMNS.every((key) =>
      Object.prototype.hasOwnProperty.call(value, key)
    )
  ) return null;
  const row = value;
  const nowMs = now instanceof Date ? now.getTime() : NaN;
  const verifiedMs = timestamp(row.verified_at);
  const approvedMs = timestamp(row.approved_at);
  const untilMs = timestamp(row.valid_until);
  if (
    !Number.isFinite(nowMs) || verifiedMs === null || approvedMs === null ||
    untilMs === null || verifiedMs > approvedMs || approvedMs > nowMs ||
    untilMs <= nowMs || untilMs <= approvedMs ||
    untilMs - verifiedMs > MAX_VALIDITY_MS ||
    row.approval_status !== "approved" || row.revoked_at !== null ||
    !boundedText(row.approved_by, 160)
  ) return null;
  const source = httpsUrl(row.source_url, 1_000);
  if (
    !boundedText(row.product_id, 160) || !boundedText(row.article, 200) ||
    row.product_id !== product.id || row.article !== product.article ||
    !canonicalCatalogUrl(row.catalog_url) ||
    normalizeProductUrl(product.url) !== row.catalog_url ||
    !source ||
    !boundedText(row.document_version, 80) ||
    !/^[\p{L}\p{N}][\p{L}\p{N} ._+\-()/]{0,79}$/u.test(row.document_version) ||
    !(row.document_page === null ||
      (Number.isInteger(row.document_page) &&
        positive(row.document_page, 10_000))) ||
    (/\.pdf$/iu.test(source.pathname) && row.document_page === null)
  ) return null;
  const cutoutEmpty = row.cutout_shape === null && row.cutout_kind === null &&
    row.cutout_min_mm === null && row.cutout_max_mm === null;
  const cutoutPresent = row.cutout_shape === "round" &&
    (row.cutout_kind === "exact" || row.cutout_kind === "range") &&
    positive(row.cutout_min_mm, 10_000) &&
    positive(row.cutout_max_mm, 10_000) &&
    (row.cutout_kind === "exact"
      ? row.cutout_min_mm === row.cutout_max_mm
      : row.cutout_min_mm < row.cutout_max_mm);
  if (!cutoutEmpty && !cutoutPresent) return null;
  if (
    !(row.fixture_form === undefined || row.fixture_form === null ||
      row.fixture_form === "downlight") ||
    !nullablePositive(row.outer_diameter_mm, 10_000) ||
    (row.color_temperature_k !== null &&
      (!Number.isInteger(row.color_temperature_k) ||
        !positive(row.color_temperature_k, 20_000) ||
        row.color_temperature_k < 1_000)) ||
    !nullableBoolean(row.integrated_led) ||
    !nullableBoolean(row.driver_included)
  ) return null;
  if (
    !(
      (row.socket_kind === null && row.socket_code === null) ||
      (row.socket_kind === "none" && row.socket_code === null) ||
      (row.socket_kind === "base" &&
        boundedText(row.socket_code, 20) &&
        /^[A-Za-z]{1,5}\d{1,3}[A-Za-z\d-]{0,12}$/u.test(row.socket_code))
    ) ||
    (row.integrated_led === true && row.socket_kind === "base") ||
    !(
      row.driver_type === null ||
      (row.driver_included === true && boundedText(row.driver_type, 80) &&
        /^[\p{L}\p{N}][\p{L}\p{N} ._+\-/]{0,79}$/u.test(row.driver_type))
    ) ||
    !(
      (row.supply_min_v === null && row.supply_max_v === null) ||
      (positive(row.supply_min_v, 10_000) &&
        positive(row.supply_max_v, 10_000) &&
        row.supply_min_v <= row.supply_max_v)
    )
  ) return null;
  if (
    cutoutPresent && row.outer_diameter_mm !== null &&
    row.outer_diameter_mm <= (row.cutout_max_mm as number)
  ) return null;
  const catalogDimensions = liveCatalogDimensions(product);
  if (
    catalogDimensions === null ||
    catalogDimensions.cutout.some((interval) =>
      !cutoutPresent || !intervalsCompatible(
        { min: row.cutout_min_mm as number, max: row.cutout_max_mm as number },
        interval,
      )
    ) ||
    catalogDimensions.outer.some((interval) =>
      row.outer_diameter_mm === null ||
      !intervalsCompatible(
        {
          min: row.outer_diameter_mm as number,
          max: row.outer_diameter_mm as number,
        },
        interval,
      )
    )
  ) return null;
  if (
    liveTechnicalClaims(product).some((claim) =>
      technicalClaimContradicts(row, claim)
    )
  ) return null;
  // An all-null evidence row cannot support a claim, even if approved.
  if (
    row.fixture_form !== "downlight" && !cutoutPresent &&
    row.outer_diameter_mm === null &&
    row.color_temperature_k === null && row.integrated_led === null &&
    row.socket_kind === null && row.driver_included === null &&
    row.supply_min_v === null
  ) return null;
  return {
    binding: {
      product_id: row.product_id,
      article: row.article,
      catalog_url: row.catalog_url,
    },
    provenance: {
      source_url: row.source_url as string,
      document_version: row.document_version,
      document_page: row.document_page as number | null,
      verified_at: row.verified_at as string,
      valid_until: row.valid_until as string,
      approved_at: row.approved_at as string,
      approved_by: row.approved_by,
    },
    technical: {
      fixture_form: row.fixture_form === "downlight" ? "downlight" : null,
      cutout: cutoutPresent
        ? {
          shape: "round",
          kind: row.cutout_kind as "exact" | "range",
          min_mm: row.cutout_min_mm as number,
          max_mm: row.cutout_max_mm as number,
        }
        : null,
      outer_diameter_mm: row.outer_diameter_mm as number | null,
      color_temperature_k: row.color_temperature_k as number | null,
      integrated_led: row.integrated_led as boolean | null,
      socket: row.socket_kind === "none"
        ? { kind: "none" }
        : row.socket_kind === "base"
        ? { kind: "base", code: row.socket_code as string }
        : null,
      driver: row.driver_included === null ? null : {
        included: row.driver_included as boolean,
        type: row.driver_type as string | null,
      },
      supply_v: row.supply_min_v === null ? null : {
        min: row.supply_min_v as number,
        max: row.supply_max_v as number,
      },
    },
  };
}
