import {
  extractClientQuantities,
  isPhysicalMeasurementUnit,
  normalizeUnit,
} from "./criteria-consistency.ts";
import { selectionTargetIsDeclared } from "./selection-contract.ts";

export interface VisibleRequestRequirement {
  kind:
    | "linear_measurement"
    | "bounded_measurement"
    | "count"
    | "literal_modifier";
  label: string;
  op?: "eq" | "min" | "max";
  value?: string | number;
  unit?: string;
  exclusive?: boolean;
  matches: (title: string) => boolean;
}

export interface VisibleRequestProductEvidence {
  pagetitle: string;
  short_traits?: string[];
}

export interface VisibleRequestContractContext {
  /** Frozen product class established by the selection-target gate. */
  productClass?: string | null;
  /** Live catalog taxonomy that independently proves the complete class. */
  taxonomyClass?: string | null;
  /** All live titles observed in this turn, not only the latest recovery pool. */
  candidateTitles?: string[];
  /** Literal customer phrases whose exact live-facet meaning was declared by
   * the bounded reasoning contract. They remain mandatory through that facet
   * and must not also require one particular title-language spelling. */
  semanticallyMappedCustomerPhrases?: string[];
  /** Customer-object measurement proved by a live, two-sided paired-fit
   * contract and the consultant's visible reasoning. Never infer this from
   * the mere presence of a number in the request. */
  verifiedPairedFitReference?: { value: number; unit: string } | null;
}

const RU_ADJECTIVE_TOKEN = String
  .raw`\p{L}{3,}(?:ыми|ими|ого|его|ому|ему|ая|яя|ое|ее|ой|ей|ом|ем|ую|юю|ый|ий|ые|ие|ых|их)`;
const RU_ADJECTIVE_WORD = new RegExp(`^${RU_ADJECTIVE_TOKEN}$`, "iu");

function hasDoubleSocketPhrase(source: string): boolean {
  const between = `(?:\\s+${RU_ADJECTIVE_TOKEN}){0,3}`;
  return new RegExp(
    `(?:двойн\\p{L}*${between}\\s+розет\\p{L}*|розет\\p{L}*${between}\\s+двойн\\p{L}*)`,
    "iu",
  ).test(source);
}

function hasSingleSocketPhrase(source: string): boolean {
  const between = `(?:\\s+${RU_ADJECTIVE_TOKEN}){0,3}`;
  const single = String.raw`(?:одинарн|одноместн)\p{L}*`;
  return new RegExp(
    `(?:${single}${between}\\s+розет\\p{L}*|розет\\p{L}*${between}\\s+${single})`,
    "iu",
  ).test(source);
}

/** A double socket's exact count can be proved by title wording or a
 * first-party count. In USB/RJ/Type-C context, only a count explicitly naming
 * силовая/штепсельная розетка proves two mains outlets. A stated one-outlet
 * count still vetoes a favourable but contradictory double title. */
function doubleSocketEvidenceMatches(evidence: string): boolean {
  const lines = String(evidence ?? "").split(/\r?\n/u);
  const title = lines[0] ?? "";
  const auxiliaryPortContext =
    /(?<![\p{L}\p{N}])(?:usb|rj(?:[-\s]?\d{0,2})?|type[-\s]?c|hdmi|ethernet|lan)(?![\p{L}\p{N}])/iu
      .test(evidence);
  const countNoun = String
    .raw`(?:мест\p{L}*|розет\p{L}*|гнезд\p{L}*|гн\.?|разъ[её]м\p{L}*|пост\p{L}*)`;
  const qualifier = String
    .raw`(?:силов\p{L}*|электрическ\p{L}*|штепсельн\p{L}*)`;
  // A free-text "гнездо" or "разъем" may be an auxiliary port. Count-first
  // proof is limited to unmistakable outlet/place/post wording in the title.
  const directOutletNoun = String.raw`(?:мест\p{L}*|розет\p{L}*|пост\p{L}*)`;
  const countField = new RegExp(
    `^(?:(?:количеств\\p{L}*|числ\\p{L}*)\\s+)?(${qualifier}\\s+)?(${countNoun})(?:\\s*,?\\s*шт\\.?)?\\s*(?::|=|[-–—])\\s*(\\d+)(?:\\s*шт\\.?)?\\s*$`,
    "iu",
  );
  const countFirst = new RegExp(
    `(?<!\\d)(\\d+)\\s*(?:[-–—]?\\s*)?${directOutletNoun}(?!\\p{L})`,
    "giu",
  );
  const qualifiedOutletCountFirst = new RegExp(
    `(?<![\\p{L}\\p{N}])(\\d+)\\s*(?:[-–—]?\\s*)?(?:${qualifier}\\s+розет\\p{L}*|розет\\p{L}*\\s+${qualifier})(?!\\p{L})`,
    "giu",
  );
  let contradiction = false;
  let provenTwo = false;
  const record = (count: number, provesMains: boolean) => {
    if (count !== 2) contradiction = true;
    else if (provesMains) provenTwo = true;
  };
  for (const line of lines) {
    const field = line.trim().match(countField);
    if (field) {
      const fieldQualifier = field[1] ?? "";
      const fieldNoun = field[2];
      const count = Number(field[3]);
      const socketNoun = /^розет/iu.test(fieldNoun);
      const strongMains = socketNoun &&
        /^(?:силов|штепсельн)/iu.test(fieldQualifier);
      const weakOutletContradiction = socketNoun &&
        /^электрическ/iu.test(fieldQualifier) && count !== 2;
      if (strongMains || !auxiliaryPortContext) record(count, true);
      else if (weakOutletContradiction) record(count, false);
    }
    for (const match of line.matchAll(qualifiedOutletCountFirst)) {
      const count = Number(match[1]);
      const strongMains = /(?:силов|штепсельн)\p{L}*/iu.test(match[0]);
      if (count !== 2 || strongMains || !auxiliaryPortContext) {
        record(count, strongMains || !auxiliaryPortContext);
      }
    }
  }
  if (!auxiliaryPortContext) {
    for (const match of title.matchAll(countFirst)) {
      record(Number(match[1]), true);
    }
  }
  if (contradiction || hasSingleSocketPhrase(title)) {
    return false;
  }
  return provenTwo || hasDoubleSocketPhrase(title);
}

const WORKFLOW_WORDS = new Set([
  "покажи",
  "покажите",
  "найди",
  "найдите",
  "подбери",
  "подберите",
  "нужен",
  "нужна",
  "нужно",
  "нужны",
  "хочу",
  "ищу",
  "есть",
  "дайте",
  "мне",
  "нам",
  "самый",
  "самая",
  "самые",
  "дешевый",
  "дешевле",
]);

// A relation can introduce a measured fit object ("трубка на кабель 12 мм")
// or a product requirement ("кронштейн на стену 12 мм"). Only the former can
// be omitted after independent paired-fit proof; the wording alone is not
// enough. An equipped-product relation ("с кабелем") is not included.
const MEASURED_OBJECT_RELATIONS = new Set([
  "для",
  "на",
  "к",
  "ко",
  "под",
  "for",
  "to",
]);

function normalizeToken(value: string): string {
  return String(value ?? "")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/giu, "")
    .trim();
}

function tokenStem(value: string): string {
  const token = normalizeToken(value);
  if (/^[a-z0-9]+$/u.test(token) || token.length < 5) return token;
  const stripped = token.replace(
    /(?:иями|ями|ами|ыми|ими|ого|его|ому|ему|ая|яя|ое|ее|ые|ие|ый|ий|ой|ую|юю|ых|их|ым|им|ом|ем|ов|ев|ам|ям|ах|ях|а|я|у|ю|ы|и|е|о)$/u,
    "",
  );
  return stripped.length >= 4 ? stripped : token;
}

function sameTaxonomyModifier(
  sourceToken: string,
  taxonomyToken: string,
): boolean {
  const sourceStem = tokenStem(sourceToken);
  const taxonomyStem = tokenStem(taxonomyToken);
  // Normal inflections have the same stem. Derivational variants can share a
  // longer lexical base, but a short class prefix (for example "термо-") is
  // not enough to conflate distinct refinements.
  return sourceStem === taxonomyStem || (
    sourceStem.length >= 8 && taxonomyStem.length >= 8 &&
    sourceStem.slice(0, 8) === taxonomyStem.slice(0, 8)
  );
}

function canonicalUnit(raw: string): string {
  const unit = normalizeUnit(raw);
  const aliases: Record<string, string> = {
    ватт: "вт",
    ватта: "вт",
    ваттов: "вт",
    watt: "вт",
    watts: "вт",
    w: "вт",
    люмен: "лм",
    люмена: "лм",
    люменов: "лм",
    lumen: "лм",
    lumens: "лм",
    lm: "лм",
    вольт: "в",
    вольта: "в",
    вольтов: "в",
    volt: "в",
    volts: "в",
    v: "в",
    ампер: "а",
    ампера: "а",
    амперов: "а",
    amp: "а",
    amps: "а",
    a: "а",
  };
  return aliases[unit] ?? unit;
}

function isCurrencyUnit(raw: string): boolean {
  const unit = normalizeToken(raw);
  return /^(?:тенге|тг|kzt|руб(?:ль|ля|лей)?|rub|доллар(?:а|ов)?|usd|евро|eur)$/u
    .test(unit);
}

/** A physical number can describe the environment rather than the product.
 * Placement height is input for the consultant's sizing calculation and must
 * not become an exact length that every product card has to contain. */
function isPlacementContextMeasurement(
  source: string,
  measurementIndex: number,
): boolean {
  const prefix = source.slice(
    Math.max(0, measurementIndex - 64),
    measurementIndex,
  );
  return /(?:высот\p{L}*(?:\s+(?:установ\p{L}*|монтаж\p{L}*))?|(?:установ\p{L}*|монтаж\p{L}*)\s+на\s+высот\p{L}*)[^.!?\n]{0,24}$/iu
    .test(prefix);
}

/** Route/line length describes the installation task, not the physical length
 * encoded by every product card. Literal product length remains guarded when
 * the customer names the product itself (`удлинитель на 50 м`). */
function isRouteContextMeasurement(
  source: string,
  measurementIndex: number,
): boolean {
  const prefix = source.slice(
    Math.max(0, measurementIndex - 72),
    measurementIndex,
  );
  return /(?:расстоян\p{L}*|длин\p{L}*\s+(?:трасс\p{L}*|лини\p{L}*)|(?:трасс\p{L}*|лини\p{L}*)\s+(?:длин\p{L}*|протяжен\p{L}*))[^.!?\n]{0,28}$/iu
    .test(prefix);
}

function titleSatisfiesBound(
  title: string,
  expected: {
    value: number;
    unit: string;
    direction: "min" | "max";
    exclusive: boolean;
  },
): boolean {
  const unit = canonicalUnit(expected.unit);
  return extractClientQuantities(title).some((quantity) => {
    if (canonicalUnit(quantity.unit) !== unit) return false;
    if (expected.direction === "min") {
      return expected.exclusive
        ? quantity.value > expected.value
        : quantity.value >= expected.value;
    }
    return expected.exclusive
      ? quantity.value < expected.value
      : quantity.value <= expected.value;
  });
}

function literalRequestModifiers(
  source: string,
  context: VisibleRequestContractContext,
): Array<{ stem: string; label: string }> {
  const classTokens = String(context.productClass ?? "")
    .match(/[a-zа-я0-9]+/giu) ?? [];
  // Only the final class head is exempt. Earlier class words can themselves
  // be customer-owned modifiers ("LED floodlight", "double socket") and must
  // not disappear merely because a model repeated them inside product_class.
  const classHead = tokenStem(classTokens.at(-1) ?? "");
  if (classHead.length < 3) return [];
  // If live taxonomy independently declares the complete selected class, its
  // preceding words are class identity rather than customer modifiers. This
  // keeps abbreviated titles valid (for example, a catalog acronym) while a
  // genuine refinement absent from taxonomy (LED, double, colour, etc.) stays
  // visible. The decision uses the same data-agnostic class contract as the
  // final selection gate; no category vocabulary is duplicated here.
  const taxonomyProvesCompleteClass = Boolean(
    context.productClass &&
      context.taxonomyClass &&
      selectionTargetIsDeclared(context.productClass, context.taxonomyClass),
  );
  const taxonomyBackedClassStems = taxonomyProvesCompleteClass
    ? new Set(classTokens.map(tokenStem).filter(Boolean))
    : new Set([classHead]);
  const taxonomyClassTokens = taxonomyProvesCompleteClass
    ? (String(context.taxonomyClass).match(/[a-zа-я0-9]+/giu) ?? [])
      .filter((token) => tokenStem(token) !== classHead)
    : [];
  const sourceTokenMatches = [...source.matchAll(/[a-zа-я0-9]+/giu)];
  const sourceTokens = sourceTokenMatches.map((match) => match[0]);
  const sourceStems = new Set(sourceTokens.map(tokenStem));
  const mappedStems = new Set(
    (context.semanticallyMappedCustomerPhrases ?? [])
      .flatMap((phrase) => String(phrase).match(/[a-zа-я0-9]+/giu) ?? [])
      .map(tokenStem)
      .filter(Boolean),
  );
  const liveTitleTokens = (context.candidateTitles ?? [])
    .map((title) => title.match(/[a-zа-я0-9]+/giu) ?? []);
  const liveTitleStems = new Set(
    liveTitleTokens.flat().map(tokenStem).filter(Boolean),
  );
  const modifiers = new Map<string, string>();
  const precedesDirectionalMeasurement = (index: number): boolean => {
    const tail = sourceTokens.slice(index + 1, index + 6).join(" ");
    return /^(?:(?:не\s+менее|минимум|от|не\s+более|максимум|до|больше|свыше|меньше|менее)\s+)\d+(?:[.,]\d+)?\s*[a-zа-я°]{1,10}[²³]?\d?(?:\s|$)/iu
      .test(tail);
  };
  const describesMeasurement = (index: number): boolean => {
    const token = normalizeToken(sourceTokens[index] ?? "");
    // Instrumental nouns such as "диаметром", "сечением" or "мощностью"
    // label the following quantity; they are not title-language modifiers.
    if (!/(?:ом|ем|ью)$/u.test(token)) return false;
    const quantity = sourceTokens[index + 1] ?? "";
    const unit = sourceTokens[index + 2] ?? "";
    return /^\d+(?:[.,]\d+)?$/u.test(quantity) &&
      /^[a-zа-я°]{1,10}[²³]?\d?$/iu.test(unit);
  };
  const isMeasuredRelationObject = (index: number): boolean => {
    const pairedReference = context.verifiedPairedFitReference;
    if (!pairedReference) return false;
    if (
      !MEASURED_OBJECT_RELATIONS.has(
        normalizeToken(sourceTokens[index - 1] ?? ""),
      )
    ) return false;
    const match = sourceTokenMatches[index];
    if (!match) return false;
    const tail = source.slice((match.index ?? 0) + match[0].length);
    // A quantity directly after the governed noun, or after one instrumental
    // measurement descriptor, belongs to that external fit object. Without
    // this local quantity the noun may name a mount or compatibility variant.
    const measured = tail.match(
      /^\s*(?:([\p{L}]{4,})\s+)?(\d+(?:[.,]\d+)?)\s*([a-zа-я°]{1,10}[²³]?\d?)(?![a-zа-я])/iu,
    );
    if (!measured) return false;
    const descriptor = normalizeToken(measured[1] ?? "");
    return (!descriptor || /(?:ом|ем|ью)$/u.test(descriptor)) &&
      isPhysicalMeasurementUnit(measured[3]) &&
      Number(measured[2].replace(",", ".")) === pairedReference.value &&
      canonicalUnit(measured[3]) === canonicalUnit(pairedReference.unit);
  };
  const hasContrastingRelationalVariant = (
    requestedStem: string,
    relation: string,
  ): boolean =>
    liveTitleTokens.some((tokens) => {
      const stems = tokens.map(tokenStem);
      const classIndex = stems.findIndex((stem, index) =>
        stem === classHead &&
        !MEASURED_OBJECT_RELATIONS.has(normalizeToken(tokens[index - 1] ?? ""))
      );
      if (classIndex < 0 || stems.includes(requestedStem)) return false;
      const otherRelationObject = tokens.some((token, index) =>
        MEASURED_OBJECT_RELATIONS.has(normalizeToken(token)) &&
        Boolean(stems[index + 1]) && stems[index + 1].length >= 4 &&
        stems[index + 1] !== classHead
      );
      if (otherRelationObject) return true;
      // "На" can introduce a mount. A competing same-class card with its own
      // visible adjectival variant ("кронштейн потолочный") is positive
      // contrast; an opaque model code ("трубка ТТУ") is not. "Для" needs an
      // explicit alternative object, because an unrelated colour/material
      // adjective does not distinguish application objects.
      if (relation !== "на") return false;
      return tokens.some((token, index) =>
        Math.abs(index - classIndex) <= 2 &&
        RU_ADJECTIVE_WORD.test(token) &&
        !sourceStems.has(stems[index]) &&
        !taxonomyBackedClassStems.has(stems[index]) &&
        !taxonomyClassTokens.some((taxonomyToken) =>
          sameTaxonomyModifier(token, taxonomyToken)
        )
      );
    });
  for (let index = 0; index < sourceTokens.length; index += 1) {
    if (tokenStem(sourceTokens[index]) !== classHead) continue;
    for (const offset of [-2, -1, 1, 2]) {
      const modifierIndex = index + offset;
      const token = normalizeToken(sourceTokens[modifierIndex] ?? "");
      const stem = tokenStem(token);
      const measuredRelationObject = isMeasuredRelationObject(modifierIndex);
      const relation = normalizeToken(sourceTokens[modifierIndex - 1] ?? "");
      const uncontrastedRelationalObject =
        MEASURED_OBJECT_RELATIONS.has(relation) &&
        !hasContrastingRelationalVariant(stem, relation);
      const taxonomyProvesModifierIsClass = taxonomyClassTokens.some((
        taxonomyToken,
      ) => sameTaxonomyModifier(token, taxonomyToken));
      if (
        !stem || stem.length < 4 || stem === classHead ||
        mappedStems.has(stem) ||
        taxonomyBackedClassStems.has(stem) ||
        taxonomyProvesModifierIsClass || measuredRelationObject ||
        uncontrastedRelationalObject ||
        WORKFLOW_WORDS.has(token) || /^\d/u.test(token) ||
        precedesDirectionalMeasurement(modifierIndex) ||
        describesMeasurement(modifierIndex) ||
        !liveTitleStems.has(stem)
      ) continue;
      modifiers.set(stem, token);
    }
  }
  return [...modifiers].map(([stem, label]) => ({ stem, label }));
}

/**
 * Builds only contracts the customer can verify from a compact product card:
 * literal cable/extension length and socket/place counts. Other attributes,
 * such as color, may be proven by live short_traits even when omitted from the
 * product title and remain the responsibility of the normal criteria gate.
 */
export function buildVisibleRequestContract(
  userMessage: string,
  context: VisibleRequestContractContext = {},
): VisibleRequestRequirement[] {
  const source = String(userMessage ?? "");
  const requirements: VisibleRequestRequirement[] = [];
  const seen = new Set<string>();
  const structurallyCoveredModifierStems = new Set<string>();
  const add = (key: string, requirement: VisibleRequestRequirement) => {
    if (seen.has(key)) return;
    seen.add(key);
    requirements.push(requirement);
  };

  for (
    const match of source.matchAll(
      /(?<!\d)(\d+(?:[.,]\d+)?)\s*(?:м|m)(?![\p{L}\p{N}²³])/giu,
    )
  ) {
    if (
      isPlacementContextMeasurement(source, match.index ?? 0) ||
      isRouteContextMeasurement(source, match.index ?? 0)
    ) continue;
    const prefix = source.slice(
      Math.max(0, (match.index ?? 0) - 24),
      match.index ?? 0,
    );
    if (
      /(?:не\s+менее|минимум|от|не\s+более|максимум|до|больше|свыше|меньше|менее)\s*$/iu
        .test(prefix)
    ) {
      continue;
    }
    const raw = match[1];
    const canonical = raw.replace(",", ".");
    const escaped = canonical.replace(".", "[.,]");
    add(`length:${canonical}`, {
      kind: "linear_measurement",
      label: `${raw} м`,
      op: "eq",
      value: Number(canonical),
      unit: "м",
      matches: (title) =>
        new RegExp(
          `(?<!\\d)${escaped}\\s*(?:м|m)(?![\\p{L}\\p{N}²³])`,
          "iu",
        ).test(title),
    });
  }

  for (
    const match of source.matchAll(
      /(?<!\d)(\d+)\s*(?:мест\p{L}*|розет\p{L}*|гнезд\p{L}*)(?!\p{L})/giu,
    )
  ) {
    const count = match[1];
    add(`count:${count}`, {
      kind: "count",
      label: `${count} места/розетки/гнезда`,
      op: "eq",
      value: Number(count),
      matches: (evidence) => {
        const countFirst = new RegExp(
          `(?<!\\d)${count}\\s*(?:[-–—]?\\s*)?(?:мест\\p{L}*|розет\\p{L}*|гнезд\\p{L}*|гн\\.?)(?!\\p{L})`,
          "iu",
        );
        const labelFirst = new RegExp(
          `(?:мест\\p{L}*|розет\\p{L}*|гнезд\\p{L}*|разъем\\p{L}*)\\s*(?::|=|-|–|—)?\\s*(?<!\\d)${count}(?!\\d)`,
          "iu",
        );
        return countFirst.test(evidence) || labelFirst.test(evidence);
      },
    });
  }

  if (hasDoubleSocketPhrase(source)) {
    add("count:double-socket", {
      kind: "count",
      label: "двойная розетка",
      op: "eq",
      value: 2,
      matches: doubleSocketEvidenceMatches,
    });
    structurallyCoveredModifierStems.add(tokenStem("двойная"));
  }

  // Preserve explicit directional quantities at the final card boundary.
  // The check is purely number+unit based and therefore applies equally to
  // power, current, voltage, length, luminous flux and future catalog scales.
  // Area/volume describe application context and are deliberately excluded.
  const boundPattern =
    /(?:(не\s+менее|минимум|от|не\s+более|максимум|до|больше|свыше|меньше|менее)\s*)(\d+(?:[.,]\d+)?)\s*([a-zа-я°]{1,10}[²³]?\d?)(?![a-zа-я])/giu;
  for (const match of source.matchAll(boundPattern)) {
    const marker = match[1].toLocaleLowerCase("ru-RU").replace(/ё/g, "е")
      .replace(/\s+/g, " ");
    const value = Number(match[2].replace(",", "."));
    const unit = canonicalUnit(match[3]);
    // Price is first-class catalog evidence and is guarded independently.
    // Requiring a currency amount in a product title would reject every valid
    // card even when its structured price satisfies the customer's ceiling.
    if (
      !Number.isFinite(value) || !unit || /[²³]/u.test(unit) ||
      isCurrencyUnit(unit)
    ) continue;
    const direction = /^(?:не менее|минимум|от|больше|свыше)$/u.test(marker)
      ? "min"
      : "max";
    const exclusive = /^(?:больше|свыше|меньше|менее)$/u.test(marker);
    const label = `${marker} ${match[2]} ${match[3]}`;
    add(`bound:${direction}:${exclusive}:${value}:${unit}`, {
      kind: "bounded_measurement",
      label,
      op: direction,
      value,
      unit,
      exclusive,
      matches: (title) =>
        titleSatisfiesBound(title, { value, unit, direction, exclusive }),
    });
  }

  // Keep a literal modifier next to the selected class only when at least one
  // live title in this turn independently proves that vocabulary. This avoids
  // dictionaries and prevents a later broad recovery from mixing cards that
  // satisfy different halves of the request (for example type vs power).
  for (const modifier of literalRequestModifiers(source, context)) {
    // The explicit double-socket count above already owns this customer
    // requirement. Its matcher accepts a trusted count trait without forcing
    // the same Russian adjective into the title; other nearby modifiers
    // (such as colour) remain independent mandatory checks.
    if (structurallyCoveredModifierStems.has(modifier.stem)) continue;
    add(`modifier:${modifier.stem}`, {
      kind: "literal_modifier",
      label: modifier.label,
      op: "eq",
      value: modifier.label,
      matches: (title) =>
        (title.match(/[a-zа-я0-9]+/giu) ?? []).some((token) =>
          tokenStem(token) === modifier.stem
        ),
    });
  }

  return requirements;
}

export function titleSupportsVisibleRequestContract(
  title: string,
  requirements: VisibleRequestRequirement[],
): boolean {
  return requirements.every((requirement) => requirement.matches(title));
}

/**
 * Final cards may omit a characteristic from the title even though the
 * catalog exposes it in structured traits. Both fields are first-party,
 * customer-visible evidence, so the final guard accepts either source. This
 * prevents a correct facet search from being rejected merely because the
 * title is abbreviated, without trusting model prose or adding product data.
 */
export function productSupportsVisibleRequestContract(
  product: VisibleRequestProductEvidence,
  requirements: VisibleRequestRequirement[],
): boolean {
  const evidence = [
    String(product?.pagetitle ?? ""),
    ...(Array.isArray(product?.short_traits)
      ? product.short_traits.map(String)
      : []),
  ].join("\n");
  return requirements.every((requirement) => requirement.matches(evidence));
}

/**
 * A taxonomy leaf is only a successful terminal recovery scope after at least
 * one card survives the immutable customer contract. A non-empty but entirely
 * rejected leaf must not prevent one bounded full-text search for the already-
 * grounded product class.
 */
export function shouldExpandVisibleRecoverySearch(
  hasLeafScope: boolean,
  confirmedCount: number,
): boolean {
  return hasLeafScope && confirmedCount === 0;
}

export function shouldContinueVisibleRecoveryPage(input: {
  page: number;
  pageSize: number;
  total: number;
  confirmedCount: number;
  maxPages: number;
}): boolean {
  return input.confirmedCount === 0 &&
    input.page < input.maxPages &&
    input.page * input.pageSize < input.total;
}
