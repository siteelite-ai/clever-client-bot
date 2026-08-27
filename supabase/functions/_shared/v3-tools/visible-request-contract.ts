import { extractClientQuantities, normalizeUnit } from "./criteria-consistency.ts";
import { selectionTargetIsDeclared } from "./selection-contract.ts";

export interface VisibleRequestRequirement {
  kind: "linear_measurement" | "bounded_measurement" | "count" | "literal_modifier";
  label: string;
  matches: (title: string) => boolean;
}

export interface VisibleRequestContractContext {
  /** Frozen product class established by the selection-target gate. */
  productClass?: string | null;
  /** Live catalog taxonomy that independently proves the complete class. */
  taxonomyClass?: string | null;
  /** All live titles observed in this turn, not only the latest recovery pool. */
  candidateTitles?: string[];
}

const WORKFLOW_WORDS = new Set([
  "покажи", "покажите", "найди", "найдите", "подбери", "подберите",
  "нужен", "нужна", "нужно", "нужны", "хочу", "ищу", "есть", "дайте",
  "мне", "нам", "самый", "самая", "самые", "дешевый", "дешевле",
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

function canonicalUnit(raw: string): string {
  const unit = normalizeUnit(raw);
  const aliases: Record<string, string> = {
    ватт: "вт", ватта: "вт", ваттов: "вт", watt: "вт", watts: "вт", w: "вт",
    люмен: "лм", люмена: "лм", люменов: "лм", lumen: "лм", lumens: "лм", lm: "лм",
    вольт: "в", вольта: "в", вольтов: "в", volt: "в", volts: "в", v: "в",
    ампер: "а", ампера: "а", амперов: "а", amp: "а", amps: "а", a: "а",
  };
  return aliases[unit] ?? unit;
}

function isCurrencyUnit(raw: string): boolean {
  const unit = normalizeToken(raw);
  return /^(?:тенге|тг|kzt|руб(?:ль|ля|лей)?|rub|доллар(?:а|ов)?|usd|евро|eur)$/u.test(unit);
}

function titleSatisfiesBound(
  title: string,
  expected: { value: number; unit: string; direction: "min" | "max"; exclusive: boolean },
): boolean {
  const unit = canonicalUnit(expected.unit);
  return extractClientQuantities(title).some((quantity) => {
    if (canonicalUnit(quantity.unit) !== unit) return false;
    if (expected.direction === "min") {
      return expected.exclusive ? quantity.value > expected.value : quantity.value >= expected.value;
    }
    return expected.exclusive ? quantity.value < expected.value : quantity.value <= expected.value;
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
  const sourceTokens = source.match(/[a-zа-я0-9]+/giu) ?? [];
  const liveTitleStems = new Set(
    (context.candidateTitles ?? [])
      .flatMap((title) => title.match(/[a-zа-я0-9]+/giu) ?? [])
      .map(tokenStem)
      .filter(Boolean),
  );
  const modifiers = new Map<string, string>();
  const precedesDirectionalMeasurement = (index: number): boolean => {
    const tail = sourceTokens.slice(index + 1, index + 6).join(" ");
    return /^(?:(?:не\s+менее|минимум|от|не\s+более|максимум|до|больше|свыше|меньше|менее)\s+)\d+(?:[.,]\d+)?\s*[a-zа-я°]{1,10}[²³]?\d?(?:\s|$)/iu.test(tail);
  };
  for (let index = 0; index < sourceTokens.length; index += 1) {
    if (tokenStem(sourceTokens[index]) !== classHead) continue;
    for (const offset of [-2, -1, 1, 2]) {
      const modifierIndex = index + offset;
      const token = normalizeToken(sourceTokens[modifierIndex] ?? "");
      const stem = tokenStem(token);
      if (
        !stem || stem.length < 4 || stem === classHead ||
        taxonomyBackedClassStems.has(stem) ||
        WORKFLOW_WORDS.has(token) || /^\d/u.test(token) ||
        precedesDirectionalMeasurement(modifierIndex) ||
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
  const add = (key: string, requirement: VisibleRequestRequirement) => {
    if (seen.has(key)) return;
    seen.add(key);
    requirements.push(requirement);
  };

  for (const match of source.matchAll(/(?<!\d)(\d+(?:[.,]\d+)?)\s*(?:м|m)(?![\p{L}\p{N}²³])/giu)) {
    const prefix = source.slice(Math.max(0, (match.index ?? 0) - 24), match.index ?? 0);
    if (/(?:не\s+менее|минимум|от|не\s+более|максимум|до|больше|свыше|меньше|менее)\s*$/iu.test(prefix)) {
      continue;
    }
    const raw = match[1];
    const canonical = raw.replace(",", ".");
    const escaped = canonical.replace(".", "[.,]");
    add(`length:${canonical}`, {
      kind: "linear_measurement",
      label: `${raw} м`,
      matches: (title) => new RegExp(
        `(?<!\\d)${escaped}\\s*(?:м|m)(?![\\p{L}\\p{N}²³])`,
        "iu",
      ).test(title),
    });
  }

  for (const match of source.matchAll(/(?<!\d)(\d+)\s*(?:мест\p{L}*|розет\p{L}*|гнезд\p{L}*)(?!\p{L})/giu)) {
    const count = match[1];
    add(`count:${count}`, {
      kind: "count",
      label: `${count} места/розетки/гнезда`,
      matches: (title) => new RegExp(
        `(?<!\\d)${count}\\s*(?:[-–—]?\\s*)?(?:мест\\p{L}*|розет\\p{L}*|гнезд\\p{L}*|гн\\.?)(?!\\p{L})`,
        "iu",
      ).test(title),
    });
  }

  if (/двойн\p{L}*\s+розет\p{L}*|розет\p{L}*\s+двойн\p{L}*/iu.test(source)) {
    add("count:double-socket", {
      kind: "count",
      label: "двойная розетка",
      matches: (title) =>
        /двойн\p{L}*|(?<!\d)2\s*(?:[-–—]?\s*)?(?:мест\p{L}*|розет\p{L}*|гнезд\p{L}*|пост\p{L}*)(?!\p{L})/iu.test(title),
    });
  }

  // Preserve explicit directional quantities at the final card boundary.
  // The check is purely number+unit based and therefore applies equally to
  // power, current, voltage, length, luminous flux and future catalog scales.
  // Area/volume describe application context and are deliberately excluded.
  const boundPattern = /(?:(не\s+менее|минимум|от|не\s+более|максимум|до|больше|свыше|меньше|менее)\s*)(\d+(?:[.,]\d+)?)\s*([a-zа-я°]{1,10}[²³]?\d?)(?![a-zа-я])/giu;
  for (const match of source.matchAll(boundPattern)) {
    const marker = match[1].toLocaleLowerCase("ru-RU").replace(/ё/g, "е").replace(/\s+/g, " ");
    const value = Number(match[2].replace(",", "."));
    const unit = canonicalUnit(match[3]);
    // Price is first-class catalog evidence and is guarded independently.
    // Requiring a currency amount in a product title would reject every valid
    // card even when its structured price satisfies the customer's ceiling.
    if (!Number.isFinite(value) || !unit || /[²³]/u.test(unit) || isCurrencyUnit(unit)) continue;
    const direction = /^(?:не менее|минимум|от|больше|свыше)$/u.test(marker) ? "min" : "max";
    const exclusive = /^(?:больше|свыше|меньше|менее)$/u.test(marker);
    const label = `${marker} ${match[2]} ${match[3]}`;
    add(`bound:${direction}:${exclusive}:${value}:${unit}`, {
      kind: "bounded_measurement",
      label,
      matches: (title) => titleSatisfiesBound(title, { value, unit, direction, exclusive }),
    });
  }

  // Keep a literal modifier next to the selected class only when at least one
  // live title in this turn independently proves that vocabulary. This avoids
  // dictionaries and prevents a later broad recovery from mixing cards that
  // satisfy different halves of the request (for example type vs power).
  for (const modifier of literalRequestModifiers(source, context)) {
    add(`modifier:${modifier.stem}`, {
      kind: "literal_modifier",
      label: modifier.label,
      matches: (title) => (title.match(/[a-zа-я0-9]+/giu) ?? []).some((token) => tokenStem(token) === modifier.stem),
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
