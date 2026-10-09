import type { Criterion } from "../_shared/v3-tools/criteria-gate.ts";
import {
  type CompatibilityFacet,
  type CompatibilityRelation,
  completePairedCompatibilityRelations,
  enforceFinalPairedCompatibility,
  extractSingleMeasuredReference,
  pairedStateCriterionReference,
} from "../_shared/v3-tools/compatibility-contract.ts";
import { extractReasoningBounds } from "../_shared/v3-tools/criteria-reasoning.ts";
import { extractBudgetCap } from "../_shared/v3-tools/budget-cap.ts";
import {
  extractClientQuantities,
  isPhysicalMeasurementUnit,
} from "../_shared/v3-tools/criteria-consistency.ts";
import { isRecentProductPriceSelectionFollowup } from "../_shared/v3-tools/recent-product-evidence.ts";
import {
  extractReplacementLookupKeys,
  extractReplacementSourceDescription,
} from "../_shared/v3-tools/replacement-preflight.ts";
import type { ProductRef } from "../_shared/v3-tools/types.ts";

function normalize(value: string): string {
  return String(value ?? "").toLocaleLowerCase("ru-RU").replace(/ё/gu, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/gu, " ").trim();
}

/**
 * A direct series lookup can prove the series identity, but it cannot compile
 * extra customer conditions. Admit only a plain request to browse that series;
 * every other word goes through the criteria-aware consultant.
 */
export function isPureNamedSeriesBrowse(
  userMessage: string,
  seriesToken: string,
): boolean {
  const token = normalize(seriesToken);
  if (!token) return false;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const request = normalize(userMessage);
  const named = new RegExp(
    String.raw`(?:^| )сер(?:ия|ии|ию|ией) ${escaped}(?= |$)`,
    "u",
  );
  const deictic = /(?:^| )(?:этой|данной|указанной|названной) серии(?= |$)/u;
  if (!named.test(request) && !deictic.test(request)) return false;
  const remaining = request.replace(named, " ").replace(deictic, " ")
    .replace(/\s+/gu, " ").trim();
  if (!remaining) return false;
  const words = remaining.split(" ");
  const allowed = new Set([
    "покажи",
    "покажите",
    "найди",
    "найдите",
    "подбери",
    "подберите",
    "предложи",
    "предложите",
    "выведи",
    "выведите",
    "есть",
    "ли",
    "у",
    "вас",
    "мне",
    "все",
    "весь",
    "всю",
    "только",
    "товар",
    "товары",
    "варианты",
    "ассортимент",
    "модельный",
    "ряд",
    "на",
    "сайте",
    "в",
    "каталоге",
  ]);
  const hasAction = words.some((word) =>
    /^(?:покажи|покажите|найди|найдите|подбери|подберите|предложи|предложите|выведи|выведите|есть)$/u
      .test(word)
  );
  return hasAction && words.every((word) => allowed.has(word));
}

/** Price-only selection from the last verified batch, never a new fit test. */
export function isPureRecentPriceFollowup(userMessage: string): boolean {
  if (!isRecentProductPriceSelectionFollowup(userMessage)) return false;
  const words = normalize(userMessage).split(" ").filter(Boolean);
  const allowed = new Set([
    "а",
    "ну",
    "тогда",
    "пожалуйста",
    "можно",
    "мне",
    "да",
    "хорошо",
    "покажи",
    "покажите",
    "выведи",
    "выведите",
    "дай",
    "дайте",
    "найди",
    "найдите",
    "какой",
    "какая",
    "какие",
    "который",
    "самый",
    "самая",
    "самые",
    "дешевый",
    "дешевая",
    "дешевые",
    "недорогой",
    "недорогая",
    "недорогие",
    "доступный",
    "доступная",
    "доступные",
    "дорогой",
    "дорогая",
    "дорогие",
    "бюджетный",
    "бюджетная",
    "бюджетные",
    "премиум",
    "премьюм",
    "флагман",
    "из",
    "них",
    "этих",
    "вариантов",
    "варианта",
    "вариант",
    "этот",
    "эта",
    "эти",
    "тот",
    "та",
    "те",
    "выше",
    "списка",
    "ссылку",
    "ссылка",
    "на",
    "товар",
    "товары",
    "цена",
    "цену",
    "стоит",
    "сколько",
  ]);
  return words.every((word) => allowed.has(word));
}

export type DirectSelectionRoute =
  | "compound"
  | "outdoor_poe"
  | "replacement"
  | "exact_inquiry";

/**
 * Direct routes prove only their declared invariant (marking, established PoE
 * safety profile, source identity or exact SKU facts). Anything that needs a
 * second customer-owned criterion is delegated to the expert contract. This
 * parser is intentionally about the *shape* of the obligation, not product
 * categories, brands or values.
 */
export function admitDirectSelectionRoute(input: {
  route: DirectSelectionRoute;
  userMessage: string;
  coversBudgetCap?: boolean;
  coveredCompound?: { first: number; second: number } | null;
}): boolean {
  const raw = String(input.userMessage ?? "").toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е");
  if (!raw.trim()) return false;
  if (input.route === "replacement") {
    const source = extractReplacementSourceDescription(input.userMessage);
    const lookup = extractReplacementLookupKeys(input.userMessage);
    if (!source || lookup.articles.length + lookup.modelCodes.length === 0) {
      return false;
    }
    const normalizedSource = source.toLocaleLowerCase("ru-RU").replace(
      /ё/gu,
      "е",
    );
    const sourceOffset = raw.indexOf(normalizedSource);
    if (sourceOffset < 0) return false;
    const frame = normalize(
      `${raw.slice(0, sourceOffset)} ${
        raw.slice(sourceOffset + normalizedSource.length)
      }`,
    );
    const requestWords = new Set([
      "найди",
      "найдите",
      "подбери",
      "подберите",
      "предложи",
      "предложите",
      "покажи",
      "покажите",
      "аналоги",
      "аналог",
      "альтернативы",
      "альтернативу",
      "замену",
      "замены",
      "равноценную",
      "на",
      "для",
      "к",
      "ко",
      "эту",
      "этой",
      "этому",
      "этого",
    ]);
    if (frame.split(" ").some((word) => word && !requestWords.has(word))) {
      return false;
    }
    if (
      /(?:^|[^\p{L}])(?:для|чтобы|котор\p{L}*|с|со|без|кроме|исключая|цвет\p{L}*|налич\p{L}*|склад\p{L}*|город\p{L}*|подойд\p{L}*|годит\p{L}*|хватит)(?=$|[^\p{L}])/iu
        .test(normalizedSource) ||
      /\d[\d\s]{0,9}\s*(?:₸|тенге|тг|kzt)(?!\p{L})/iu.test(normalizedSource)
    ) return false;
    // Source names may legitimately contain electrical nameplate specs such
    // as 7W/220V. A separate length, area or diameter needs fit reasoning.
    if (
      extractClientQuantities(normalizedSource).some(({ unit }) =>
        isPhysicalMeasurementUnit(unit) &&
        !/^(?:w|вт|ватт|ватта|ваттов|v|в|вольт|вольта|вольтов|a|а|ампер|ампера|амперов)$/u
          .test(unit)
      )
    ) return false;
    // The lookup extractor intentionally omits short source codes such as
    // D90. They are still structural boundaries inside a long source name,
    // not a new customer criterion after the replacement instruction.
    const sourceCodes = [...normalizedSource.matchAll(
      /(?<![\p{L}\p{N}])[\p{L}]{1,6}\d{1,6}[\p{L}]{0,4}(?![\p{L}\p{N}])/giu,
    )].map((match) => match[0]);
    const ids = [...lookup.articles, ...lookup.modelCodes, ...sourceCodes]
      .map((id) => ({ id, offset: raw.lastIndexOf(id.toLowerCase()) }))
      .filter(({ offset }) => offset >= sourceOffset)
      .sort((left, right) => right.offset - left.offset);
    if (ids.length === 0) return false;
    const last = ids[0];
    const suffix = normalize(
      raw.slice(
        last.offset + last.id.length,
        sourceOffset + normalizedSource.length,
      ),
    );
    // A final short technical code or one-letter variant can be part of the
    // source name. Free prose after its last identity key is a new condition.
    return !suffix || /^(?:[a-zа-я]?\d+[a-zа-я]?|[a-zа-я])$/u.test(suffix);
  }
  if (input.route === "outdoor_poe") {
    // Only the already established safety profile is consumed here. A new
    // length (305 m), budget, port count, colour or application remains in the
    // residual and must go through the expert's ordinary fit contract.
    const residual = normalize(
      raw
        .replace(
          /(?:^|[^\p{L}])(?:для\s+)?(?:наружн|уличн)\p{L}*\s+poe[-\s]?камер\p{L}*/giu,
          " ",
        )
        .replace(
          /(?:^|[^\p{L}])вместо\s+cca\s*[/,и]\s*pvc(?=$|[^\p{L}])/giu,
          " ",
        )
        .replace(
          /(?:^|[^\p{L}\p{N}])(?:около|почти|примерно)?\s*100\s*(?:м|метр\p{L}*)(?=$|[^\p{L}\p{N}])/giu,
          " ",
        ),
    );
    return /^(?:(?:тогда|ну|а) )?(?:подбери|подберите|найди|найдите|покажи|покажите|предложи|предложите) (?:(?:подходящий|подходящую|подходящие) )?\p{L}+$/u
      .test(residual);
  }
  const compounds = [...raw.matchAll(
    /(?<!\d)(\d{1,3})\s*(?:x|х|×|\*)\s*(\d+(?:[.,]\d+)?)(?!\d)/giu,
  )];
  if (input.route === "compound") {
    if (!input.coveredCompound || compounds.length !== 1) return false;
    const [, first, second] = compounds[0];
    if (
      Number(first) !== input.coveredCompound.first ||
      Number(second.replace(",", ".")) !== input.coveredCompound.second
    ) return false;
  } else if (compounds.length > 0) {
    return false;
  }
  const withoutCompound = raw.replace(
    /(?<!\d)\d{1,3}\s*(?:x|х|×|\*)\s*\d+(?:[.,]\d+)?(?!\d)/giu,
    " ",
  );
  if (
    extractClientQuantities(withoutCompound).some(({ unit }) =>
      isPhysicalMeasurementUnit(unit)
    )
  ) return false;
  const hasCurrencyAmount =
    /\d[\d\s]{0,9}\s*(?:₸|тенге|тг|kzt|руб\p{L}*|usd|eur)(?!\p{L})/iu
      .test(withoutCompound);
  if (
    hasCurrencyAmount &&
    (!input.coversBudgetCap || extractBudgetCap(raw) === null)
  ) return false;
  const withoutCoveredBudget = input.coversBudgetCap && hasCurrencyAmount
    ? withoutCompound.replace(
      /(?:до|не\s+дороже|не\s+более|в\s+пределах|максимум|макс\.?|бюджет(?:\s+до)?)\s+\d[\d\s]{0,9}\s*(?:₸|тенге|тг|kzt)(?!\p{L})/giu,
      " ",
    )
    : withoutCompound;
  // Relation, application, stock and negative qualifiers demand a live-facet
  // or model-owned fit proof. None of these fast paths can infer that proof
  // merely from a successful title lookup.
  if (
    /(?:^|[^\p{L}])(?:для|чтобы|котор\p{L}*|с|со|без|кроме|исключая|из|в|цвет\p{L}*|бренд\p{L}*|налич\p{L}*|склад\p{L}*|город\p{L}*|совместим\p{L}*|подойд\p{L}*|годит\p{L}*|хватит)(?=$|[^\p{L}])/iu
      .test(withoutCoveredBudget)
  ) return false;
  if (input.route === "exact_inquiry") return true;
  if (input.route === "compound") return true;
  return false;
}

/**
 * Fast paths may never treat a catalog search hit as proof of all free-text
 * words: OR-style search can return the marking while ignoring a requested
 * colour, material or brand. Each residual customer token must occur in
 * first-party card evidence. Unproven synonyms fall back to expert reasoning.
 */
export function directProductProvesLiteralWords(
  requestedText: string,
  product: Pick<
    ProductRef,
    "pagetitle" | "short_traits" | "description_excerpt"
  >,
  ignoredIdentity: string[] = [],
): boolean {
  const source = normalize(requestedText.replace(
    /(?<!\d)\d{1,3}\s*(?:x|х|×|\*)\s*\d+(?:[.,]\d+)?(?!\d)/giu,
    " ",
  ));
  const ignored = new Set(
    ignoredIdentity.flatMap((value) => normalize(value).split(" ")).filter(
      Boolean,
    ),
  );
  const workflow = new Set([
    "найди",
    "найдите",
    "ищу",
    "покажи",
    "покажите",
    "подбери",
    "подберите",
    "предложи",
    "предложите",
    "хочу",
    "нужен",
    "нужна",
    "нужно",
    "мне",
    "самый",
    "самая",
    "самые",
    "дешевый",
    "дешевая",
    "недорогой",
    "недорогая",
    "дорогой",
    "дорогая",
    "бюджетный",
    "бюджетная",
    "все",
    "весь",
    "всю",
    "товары",
    "варианты",
    "на",
  ]);
  const expected = source.split(" ").filter((word) =>
    word.length >= 2 && !workflow.has(word) && !ignored.has(word)
  );
  const evidence = normalize([
    product.pagetitle,
    ...(product.short_traits ?? []),
    product.description_excerpt ?? "",
  ].join(" ")).split(" ").filter(Boolean);
  const stem = (word: string) =>
    /^[a-z0-9]+$/u.test(word) || word.length < 5 ? word : word.slice(0, 4);
  return expected.every((word) =>
    evidence.some((token) => stem(token) === stem(word))
  );
}

/**
 * Taxonomy is passed by category/category_in, never as a second literal-title
 * axis. Only independent customer-owned equality text/code values can become
 * jargon modifiers; derived measurements and prices stay in their own gates.
 */
export function customerOwnedJargonModifiers(
  criteria: Criterion[],
  liveCategoryLabels: string[],
): string[] {
  const categories = liveCategoryLabels.map(normalize).filter(Boolean);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const criterion of criteria) {
    if (
      criterion.evidence !== "user_explicit" ||
      (criterion.level ?? "A") !== "A" || criterion.op !== "eq" ||
      typeof criterion.value !== "string"
    ) continue;
    const value = criterion.value.trim();
    const normalized = normalize(value);
    if (!normalized || seen.has(normalized)) continue;
    if (
      categories.some((category) =>
        category === normalized || category.startsWith(`${normalized} `) ||
        category.endsWith(` ${normalized}`)
      )
    ) continue;
    seen.add(normalized);
    result.push(value);
  }
  return result;
}

/** A pre-reasoning lexical plan cannot outrank the consultant's derivation. */
export function shouldDeferQueuedLexicalSearch(
  selectionReasoningOnlyRequired: boolean,
  queuedToolName: string | null | undefined,
): boolean {
  return selectionReasoningOnlyRequired &&
    queuedToolName === "jargon_recover_catalog";
}

export interface TerminalPairedFitDecision {
  state: "not_applicable" | "unproven" | "required";
  reference: { value: number; unit: string } | null;
  relations: CompatibilityRelation[];
  selected_pair?: {
    before_facet_key: string;
    after_facet_key: string;
    require_facet_values: boolean;
  };
}

function propertyStem(token: string): string {
  const clean = normalize(token);
  return clean.length >= 5 ? clean.slice(0, 4) : clean;
}

function customerPropertiesBeforeReferences(
  userMessage: string,
  reference: { value: number; unit: string },
): string[][] {
  // The shared reference extractor canonicalizes 010, 10.0, 10,00 and unit
  // aliases (W/Вт). Compare occurrences numerically through that same
  // extractor instead of reconstructing the customer's spelling from 10.
  const canonicalReference = extractSingleMeasuredReference(
    `1 ${reference.unit}`,
  )?.unit;
  if (!canonicalReference) return [];
  const matches = userMessage.matchAll(
    /(?<![\p{L}\p{N}])(\d+(?:[.,]\d+)?)\s*([a-zа-я°]{1,10}[²³]?\d?)(?![\p{L}])/giu,
  );
  return [...matches].filter((match) => {
    const parsed = extractSingleMeasuredReference(match[0]);
    return parsed?.value === reference.value &&
      parsed.unit === canonicalReference;
  }).map((match) => {
    const before = userMessage.slice(
      Math.max(0, match.index - 50),
      match.index,
    );
    return (before.match(/\p{L}+/gu) ?? []).slice(-4);
  });
}

/** Numeric directions must be asserted about the selected property locally. */
function modelProvesBothSelectedSides(
  reasoning: string,
  propertyStemValue: string,
  reference: { value: number; unit: string },
): boolean {
  const clauses = String(reasoning ?? "").split(
    /[!?;\n]+|,(?!\d)|(?<!\d),|\.(?!\d)|(?<!\d)\.|\s+(?:а|и)\s+(?=(?:до|после|исходн|конечн))/iu,
  );
  const states = new Set<"before" | "after">();
  for (const clause of clauses) {
    const words = normalize(clause).split(" ").filter(Boolean);
    const bounds = extractReasoningBounds(clause).filter((bound) =>
      bound.strict && bound.value === reference.value &&
      normalize(bound.unit) === normalize(reference.unit)
    );
    if (bounds.length === 0) continue;
    const namesProperty = words.some((word) =>
      propertyStem(word) === propertyStemValue
    );
    if (!namesProperty) return false;
    // Another physical quantity in the same claim makes attribution unsafe.
    if (
      words.some((word) =>
        /^(?:диам|длин|ширин|высот|толщин|глубин|радиус|масс|вес|объем|площад)/u
          .test(word) && propertyStem(word) !== propertyStemValue
      )
    ) return false;
    const before = words.some((word) =>
      word === "до" || /^(?:исходн|начальн|входн|before|initial)/u.test(word)
    );
    const after = words.some((word) =>
      word === "после" || /^(?:конечн|финальн|выходн|after|final)/u.test(word)
    );
    if (before === after) return false; // Missing or conflicting state attribution.
    const expected = before ? "min" : "max";
    if (bounds.some((bound) => bound.op !== expected)) return false;
    states.add(before ? "before" : "after");
  }
  return states.has("before") && states.has("after");
}

function exactFacetScalar(
  rawValues: string[] | undefined,
  requiredUnit: string,
): number | null {
  if (!Array.isArray(rawValues) || rawValues.length === 0) return null;
  const parsed = rawValues.map((raw) => {
    const match = String(raw).trim().match(
      /^(\d+(?:[.,]\d+)?)\s*([\p{L}°²³]+)?$/u,
    );
    if (!match || match[2] && normalize(match[2]) !== normalize(requiredUnit)) {
      return null;
    }
    const value = Number(match[1].replace(",", "."));
    return Number.isFinite(value) ? value : null;
  });
  return parsed.every((value) => value !== null && value === parsed[0])
    ? parsed[0]
    : null;
}

/**
 * A live before/after graph creates an obligation only when the customer's
 * measured property is the SAME property as the graph. Its existence never
 * proves the fit. The consultant's own visible prose must independently
 * establish both strict directions before any card is eligible.
 */
export function terminalPairedFitDecision(
  reference: { value: number; unit: string } | null,
  userMessage: string,
  visibleModelReasoning: string,
  facets: CompatibilityFacet[],
): TerminalPairedFitDecision {
  const none: TerminalPairedFitDecision = {
    state: "not_applicable",
    reference,
    relations: [],
  };
  const graphs = facets.flatMap((facet) => {
    const graph = pairedStateCriterionReference(
      [{
        key: facet.caption || facet.key,
        op: "min",
        value: reference?.value ?? 1,
        // Use this facet's own live unit. A customer-mm criterion must not
        // hide a second live pair measured in bar or another unit.
        exclusive: true,
        evidence: "derived_required",
        level: "A",
      }],
      facets,
    );
    if (!graph) return [];
    const beforeFacet = facets.find((candidate) =>
      candidate.caption === graph.criterion_key ||
      candidate.key === graph.criterion_key
    );
    const afterFacet = facets.find((candidate) =>
      candidate.key === graph.opposite_facet_key
    );
    return beforeFacet && afterFacet
      ? [{ graph, beforeFacet, afterFacet }]
      : [];
  }).filter((candidate, index, all) =>
    all.findIndex((other) =>
      other.beforeFacet.key === candidate.beforeFacet.key &&
      other.afterFacet.key === candidate.afterFacet.key
    ) === index
  );
  if (graphs.length === 0) return none;
  if (!reference) {
    return /\d+(?:[.,]\d+)?\s*\p{L}{1,10}/u.test(userMessage)
      ? { state: "unproven", reference: null, relations: [] }
      : none;
  }
  const sameUnitGraphs = graphs.filter(({ graph }) =>
    normalize(graph.unit) === normalize(reference.unit)
  );
  if (sameUnitGraphs.length === 0) return none;
  const customerMentions = customerPropertiesBeforeReferences(
    userMessage,
    reference,
  );
  // The same scalar/unit may belong to two distinct customer-owned axes.
  // One selected pair cannot discharge the other obligation; fail closed.
  if (customerMentions.length !== 1) {
    return { state: "unproven", reference, relations: [] };
  }
  const customerProperties = customerMentions[0];
  let nearestProperty: string | null = null;
  for (const property of [...customerProperties].reverse()) {
    const token = normalize(property);
    // Only measurement qualifiers may be skipped. An unknown intervening
    // noun is ambiguous; an older mention of diameter must never override a
    // nearer explicit length (or other physical property) for this scalar.
    if (
      /^(?:примерно|приблизительно|около|порядка|не|более|менее|до|от)$/u.test(
        token,
      )
    ) {
      continue;
    }
    nearestProperty = token;
    break;
  }
  if (!nearestProperty) {
    return { state: "unproven", reference, relations: [] };
  }
  const nearestStem = propertyStem(nearestProperty);
  const matchingGraphs = sameUnitGraphs.filter(
    ({ beforeFacet, afterFacet }) => {
      const beforeStems = new Set(
        `${beforeFacet.key} ${beforeFacet.caption}`
          .match(/\p{L}{4,}/gu)?.map(propertyStem) ?? [],
      );
      const afterStems = new Set(
        `${afterFacet.key} ${afterFacet.caption}`
          .match(/\p{L}{4,}/gu)?.map(propertyStem) ?? [],
      );
      return beforeStems.has(nearestStem) && afterStems.has(nearestStem);
    },
  );
  if (matchingGraphs.length === 0) {
    return /^(?:длин|ширин|высот|толщин|глубин|радиус|масс|вес|объем|площад)/u
        .test(nearestProperty)
      ? none
      : { state: "unproven", reference, relations: [] };
  }
  if (matchingGraphs.length !== 1) {
    return { state: "unproven", reference, relations: [] };
  }
  const selected = matchingGraphs[0];
  const selectedPair = {
    before_facet_key: selected.beforeFacet.key,
    after_facet_key: selected.afterFacet.key,
    require_facet_values: graphs.length > 1,
  };
  // A global mention of the property cannot lend unrelated numeric claims a
  // false proof. Each strict direction must belong to a local clause naming
  // the selected property, without a competing physical quantity.
  if (
    !modelProvesBothSelectedSides(
      visibleModelReasoning,
      nearestStem,
      reference,
    )
  ) {
    return {
      state: "unproven",
      reference,
      relations: [],
      selected_pair: selectedPair,
    };
  }
  const validated = completePairedCompatibilityRelations(
    [],
    visibleModelReasoning,
    [selected.beforeFacet, selected.afterFacet],
    reference,
  ).relations;
  const directions = validated.filter((relation) =>
    relation.reference_value === reference.value &&
    normalize(relation.unit ?? "") === normalize(reference.unit)
  );
  const proved = directions.some((relation) => relation.relation === "gt") &&
    directions.some((relation) => relation.relation === "lt");
  return proved
    ? {
      state: "required",
      reference,
      relations: directions,
      selected_pair: selectedPair,
    }
    : {
      state: "unproven",
      reference,
      relations: [],
      selected_pair: selectedPair,
    };
}

/**
 * The customer's object measurement is a reference for the paired fit, not
 * an exact size of either product state. A generic literal-facet projector can
 * otherwise freeze `before = reference` before the two-sided derivation runs.
 * Remove only that copied equality on the uniquely selected live pair;
 * other dimensions and independently requested product values remain intact.
 */
export function omitPairedObjectReferenceExactCriteria<T extends Criterion>(
  criteria: T[],
  decision: TerminalPairedFitDecision,
  facets: CompatibilityFacet[],
): T[] {
  if (!decision.reference || !decision.selected_pair) return [...criteria];
  const { before_facet_key, after_facet_key } = decision.selected_pair;
  const selected = facets.filter((facet) =>
    facet.key === before_facet_key || facet.key === after_facet_key
  );
  if (selected.length !== 2) return [...criteria];
  const selectedLabels = selected.flatMap((facet) =>
    [facet.key, facet.caption].map(normalize).filter(Boolean)
  );
  return criteria.filter((criterion) => {
    if (criterion.op !== "eq") return true;
    const key = normalize(criterion.key);
    if (
      !selectedLabels.some((label) =>
        key === label || key.length >= 8 &&
          (label.startsWith(`${key} `) || key.startsWith(`${label} `))
      )
    ) return true;
    if (
      criterion.unit &&
      normalize(criterion.unit) !== normalize(decision.reference!.unit)
    ) return true;
    return exactFacetScalar(
      [String(criterion.value)],
      decision.reference!.unit,
    ) !== decision.reference!.value;
  });
}

/** Revalidate cached cards immediately before terminal rendering. */
export function enforceTerminalPairedFit<T extends ProductRef>(
  products: T[],
  decision: TerminalPairedFitDecision,
  visibleModelReasoning: string,
): T[] {
  if (decision.state === "not_applicable") return [...products];
  if (decision.state !== "required" || !decision.reference) return [];
  if (decision.selected_pair?.require_facet_values) {
    const { before_facet_key, after_facet_key } = decision.selected_pair;
    const { value, unit } = decision.reference;
    return products.filter((product) => {
      const facets = (product as ProductRef & {
        facet_values?: Record<string, string[]>;
      }).facet_values;
      const before = exactFacetScalar(facets?.[before_facet_key], unit);
      const after = exactFacetScalar(facets?.[after_facet_key], unit);
      return before !== null && after !== null &&
        before > value && after < value;
    });
  }
  const guarded = enforceFinalPairedCompatibility(
    products,
    decision.relations,
    visibleModelReasoning,
    decision.reference,
  );
  return guarded.required ? guarded.products : [];
}
