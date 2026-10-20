import type { Facet } from "./discover-category.ts";
import {
  compactFacetCandidateKeys,
  compactFacetCodeSupportScore,
  resolveCompactFacetCodeEvidence,
  resolveCompactFacetCodeEvidenceFromProductsV2,
  resolveCompoundFacetValueEvidence,
  resolveLabeledFacetValueEvidence,
} from "./compact-facet-code.ts";
import {
  explicitReplacementModelValues,
  isReplacementIdentityFacet,
} from "./search-filter-guard.ts";
import type { ProductRef } from "./types.ts";

export interface LiveReplacementClarification {
  facet_key: string;
  caption: string;
  question: string;
  options: Array<{ value: string; label: string; count?: number }>;
}

/** Accept model-proposed chips only when a live facet independently contains
 * every option. Rebuild the question and labels from catalog evidence so a
 * model sentence cannot smuggle compatibility claims through server origin. */
export function verifiedReplacementClarificationFromLiveFacets(
  input: {
    facet_key: string;
    options: Array<{ value: string; label?: string }>;
  },
  facets: Facet[],
): LiveReplacementClarification | null {
  const facet = facets.find((item) => item.key === input.facet_key);
  if (!facet || !Array.isArray(input.options) ||
    input.options.length < 2 || input.options.length > 5) return null;
  const caption = facet.caption.replace(/[^\p{L}\p{N}\s.,%°/+()-]/gu, " ")
    .replace(/\s+/gu, " ").trim().slice(0, 80);
  if (!caption) return null;
  const options = input.options.map(({ value }) => {
    const live = facet.values.find((item) => norm(item.value) === norm(value));
    return live && /^[\p{L}\p{N}\s.,%°/+()-]{1,80}$/u.test(live.value)
      ? { value: live.value, label: live.value }
      : null;
  });
  if (options.some((option) => !option)) return null;
  const verified = options as Array<{ value: string; label: string }>;
  if (new Set(verified.map(({ value }) => norm(value))).size !== verified.length) {
    return null;
  }
  return {
    facet_key: facet.key,
    caption,
    question: `Уточните «${caption}» исходного изделия: ${verified.map(({ label }) => label).join(" или ")}?`,
    options: verified,
  };
}

/** A compact source description is not a unique SKU when its live category
 * exposes an unstated structural variant. An exact article remains an exact
 * source lookup; an ungrounded taxonomy cannot authorize a question. */
export function shouldClarifyCompactReplacementSource(input: {
  grounded_source_class: boolean;
  has_exact_article: boolean;
  live_clarification: LiveReplacementClarification | null;
}): boolean {
  return input.grounded_source_class && !input.has_exact_article &&
    input.live_clarification !== null;
}

function replacementFacetValueIsDeclared(
  message: string,
  facet: Facet,
): boolean {
  if (
    resolveCompoundFacetValueEvidence(message, [facet]).length > 0 ||
    resolveLabeledFacetValueEvidence(message, [facet]).length > 0
  ) return true;
  const source = norm(message);
  const captionWords = norm(facet.caption).split(" ").filter((word) =>
    word.length >= 5
  );
  const sourceWords = source.split(" ");
  const captionMentioned = captionWords.some((captionWord) =>
    sourceWords.some((sourceWord) => {
      const shared = Math.min(captionWord.length, sourceWord.length, 6);
      return shared >= 5 &&
        captionWord.slice(0, shared) === sourceWord.slice(0, shared);
    })
  );
  if (captionWords.length === 0 || !captionMentioned) return false;
  return facet.values.some(({ value }) => {
    const wanted = norm(value);
    if (!wanted) return false;
    const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^| )${escaped}(?: |$)`, "u").test(source);
  });
}

function isStructuralCardinalityFacet(facet: Facet): boolean {
  const label = norm(`${facet.key} ${facet.caption}`);
  if (isReplacementIdentityFacet(facet)) return false;
  if (
    /(?:упаков\p{L}*|короб\p{L}*|комплект\p{L}*|палл\p{L}*|транспорт\p{L}*)/u
      .test(label)
  ) return false;
  return /(?:^| )(?:количеств\p{L}*|числ\p{L}*|count|number|полюс\p{L}*|фаз\p{L}*)(?: |$)/u
    .test(label);
}

export interface LiveCompactReplacementContract {
  compact_codes: string[];
  axes: Array<{ key: string; caption: string; value: string }>;
}

/**
 * Matching a subset of catalogue facets proves candidates, not interchangeability.
 * Both the compact-code continuation and the exact-source preflight use this
 * disclosure until a complete source-to-candidate compatibility proof exists.
 */
export function provisionalReplacementCandidateText(
  axes: ReadonlyArray<{ caption: string; value: string }>,
  sourceIdentityVerified: boolean,
): string {
  const matched = axes.map(({ caption, value }) => `${caption}: ${value}`)
    .join(", ");
  const evidence = matched
    ? `Подтверждено совпадение только по параметрам (${matched}).`
    : "Подтверждены только отдельные параметры каталога.";
  const remaining = sourceIdentityVerified
    ? "Перед заменой сверьте остальные критичные паспортные и монтажные характеристики исходного и выбранного изделия."
    : "Для проверки нужен точный артикул исходного изделия и сверка остальных критичных паспортных и монтажных характеристик.";
  return `Показываю кандидатов для замены из той же категории. ${evidence} Полная взаимозаменяемость не подтверждена. ${remaining}`;
}

/**
 * A search match is not a substitution certificate. The complete list of
 * critical live facet keys must come from an independently verified source
 * specification; a model-selected subset, title code (E27/IP65/D90), or
 * customer shorthand cannot opt into the `equivalent` state.
 */
export interface ReplacementProofInput {
  source: ProductRef | null;
  sourceIdentity: "exact" | "unverified";
  candidates: ProductRef[];
  /** The customer named the source's exact catalog article, not only a title. */
  sourcePriceIdentityVerified?: boolean;
  /** Complete, independently verified critical facet set. Empty = unknown. */
  completeCriticalFacetKeys?: string[];
  /** Final server selection contract. Only criteria verified on every rendered
   * live catalogue card may be described to the customer. */
  candidateSelectionCriteria?: ReadonlyArray<{
    key: string;
    op: string;
    value: string | number | [number, number];
    unit?: string | null;
  }>;
}

export interface ReplacementProofContract {
  source_identity: "exact" | "unverified";
  source_id: string | null;
  candidates: Array<{
    id: string;
    title: string;
    status: "candidate" | "equivalent";
    /** A known difference, not a model-inferred safety threshold. */
    contradicted: string[];
    /** Source evidence absent in the candidate. */
    unverified: string[];
    lower_numeric: string[];
    /** Only exact live source-to-candidate trait equality. */
    matched: Array<{ key: string; value: string }>;
  }>;
  all_equivalent: boolean;
  cheaper_than_source_proven: boolean;
  /** User-requested criteria proven by the live facets of every shown card. */
  verified_candidate_criteria: Array<{ key: string; value: string }>;
  /** Presentation only: catalog captions corroborated for every involved card. */
  display_labels: Record<string, string>;
  /** Only a complete, independently supplied critical-facet set can support
   * customer-facing claims about a lower compatibility parameter. */
  critical_facet_keys: string[];
}

/** Exact article or complete catalogue title, never a series/compact code. */
export function resolveExactReplacementSource(
  request: string,
  products: ProductRef[],
  candidateIds: ReadonlySet<string> = new Set(),
): ProductRef | null {
  const lookup = extractReplacementLookupKeys(request);
  const identifiers = new Set([
    ...lookup.articles.map(identityCodeNorm),
    ...lookup.modelCodes.map(identityCodeNorm),
  ].filter((value) => value.length >= 5));
  const sourceDescription = norm(extractReplacementSourceDescription(request));
  const matches = products.filter((product) => {
    if (candidateIds.has(product.id)) return false;
    const article = identityCodeNorm(product.article ?? "");
    return Boolean(
      (article && identifiers.has(article)) ||
        (sourceDescription && sourceDescription === norm(product.pagetitle)),
    );
  });
  return matches.length === 1 ? matches[0] : null;
}

function replacementProofTraits(product: ProductRef): Map<string, string> {
  const traits = new Map<string, string>();
  for (const [key, values] of Object.entries(
    (product as ProductRef & { facet_values?: Record<string, string[]> })
      .facet_values ?? {},
  )) {
    if (isReplacementIdentityFacet({ key, caption: key })) continue;
    const value = (values ?? []).map(String).map((item) => item.trim())
      .filter(Boolean).join(" / ");
    if (value) traits.set(norm(key), value);
  }
  for (const { caption, value } of traitEntries(product)) {
    if (isReplacementIdentityFacet({ key: caption, caption })) continue;
    const key = norm(caption);
    if (key && !traits.has(key)) traits.set(key, value);
  }
  return traits;
}

function comparableNumericTrait(value: string): {
  amount: number;
  unit: string;
} | null {
  // A complete numeric value only: D90, IP65, E27, a range and a SKU must
  // never be decomposed into an invented rating or compatibility threshold.
  const match = String(value).trim().match(
    /^(\d+(?:[.,]\d+)?)\s*([\p{L}%²]{0,8})$/u,
  );
  if (!match) return null;
  const amount = Number(match[1].replace(",", "."));
  return Number.isFinite(amount)
    ? { amount, unit: norm(match[2]).replace(/\s+/gu, "") }
    : null;
}

function strictProofFacet(value: string): string {
  // `norm` is useful for search, but deliberately folds 2,5 / 2/5 and drops
  // units. A customer-visible proof must preserve those distinctions.
  return String(value).normalize("NFKC").trim().toLocaleLowerCase("ru")
    .replace(/\s+/gu, " ");
}

function strictLiveCandidateFacetValue(
  product: ProductRef,
  key: string,
): string | null {
  // The API uses a machine `option.key` in facet_values but the final
  // selection contract may use its human `caption_ru`. short_traits is built
  // from that same live options array (all non-administrative captions), not
  // from model prose. Match the complete caption literally, never fuzzily.
  const captionValues = traitEntries(product)
    .filter(({ caption }) =>
      strictProofFacet(caption) === strictProofFacet(key)
    )
    .map(({ value }) => strictProofFacet(value)).filter(Boolean);
  if (captionValues.length > 0) {
    const uniqueCaptions = [...new Set(captionValues)];
    return uniqueCaptions.length === 1 ? uniqueCaptions[0] : null;
  }
  const facets = (product as ProductRef & {
    facet_values?: Record<string, string[]>;
  }).facet_values;
  if (!facets) return null;
  const matching = Object.entries(facets)
    .filter(([caption]) => strictProofFacet(caption) === strictProofFacet(key))
    .flatMap(([, values]) => values ?? [])
    .map(strictProofFacet).filter(Boolean);
  const unique = [...new Set(matching)];
  return unique.length === 1 ? unique[0] : null;
}

function safeProofDisplayLabel(raw: string): string | null {
  const caption = String(raw).normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s.,%°/+()-]/gu, " ")
    .replace(/\s+/gu, " ").trim();
  // A normalized ASCII key is not a Russian customer-facing caption. A
  // catalogue acronym such as IP is still a legitimate display label.
  if (caption.length > 60 || /[a-z]{3,}/u.test(caption)) return null;
  return /\p{Script=Cyrillic}/u.test(caption) ||
      /^[A-Z0-9/+()-]{2,12}$/u.test(caption)
    ? caption
    : null;
}

function proofDisplayLabelForProduct(
  product: ProductRef,
  key: string,
): string | null {
  const normalizedKey = norm(key);
  const withFacets = product as ProductRef & {
    facet_values?: Record<string, string[]>;
    facet_captions?: Record<string, string>;
  };
  const rawKeys = Object.keys(withFacets.facet_values ?? {})
    .filter((rawKey) => norm(rawKey) === normalizedKey);
  if (rawKeys.length > 1) return null;
  if (rawKeys.length === 1) {
    const caption = withFacets.facet_captions?.[rawKeys[0]];
    if (caption) return safeProofDisplayLabel(caption);
  }
  // Some live cards expose a human caption directly, without a machine-keyed
  // facet. Accept only an exact caption match from the original short traits;
  // never pretty-print the normalized key as a fallback.
  const matching = [...new Set(traitEntries(product)
    .filter(({ caption }) => norm(caption) === normalizedKey)
    .map(({ caption }) => caption))];
  return matching.length === 1 ? safeProofDisplayLabel(matching[0]) : null;
}

function commonProofDisplayLabels(
  source: ProductRef | null,
  candidates: ProductRef[],
  keys: Iterable<string>,
): Record<string, string> {
  const products = source ? [source, ...candidates] : candidates;
  if (products.length === 0) return {};
  return Object.fromEntries([...keys].flatMap((key) => {
    const captions = products.map((product) => proofDisplayLabelForProduct(product, key));
    const first = captions[0];
    return first && captions.every((caption) =>
      caption && strictProofFacet(caption) === strictProofFacet(first)
    ) ? [[key, first]] : [];
  }));
}

/** A single server-owned proof for direct, model and fallback render paths. */
export function buildReplacementProofContract(
  input: ReplacementProofInput,
): ReplacementProofContract {
  const source = input.sourceIdentity === "exact" ? input.source : null;
  const sourceTraits = source ? replacementProofTraits(source) : new Map();
  const criticalKeys = [...new Set(
    (input.completeCriticalFacetKeys ?? []).map(norm).filter(Boolean),
  )];
  const candidates = input.candidates.map((candidate) => {
    const candidateTraits = replacementProofTraits(candidate);
    const contradicted: string[] = [];
    const unverified: string[] = [];
    const lowerNumeric: string[] = [];
    const matched: Array<{ key: string; value: string }> = [];
    if (source) {
      for (const [key, sourceValue] of sourceTraits) {
        const candidateValue = candidateTraits.get(key);
        if (!candidateValue) {
          unverified.push(key);
          continue;
        }
        if (norm(sourceValue) === norm(candidateValue)) {
          matched.push({ key, value: sourceValue });
          continue;
        }
        contradicted.push(key);
        const sourceNumber = comparableNumericTrait(sourceValue);
        const candidateNumber = comparableNumericTrait(candidateValue);
        if (
          sourceNumber && candidateNumber &&
          sourceNumber.unit === candidateNumber.unit &&
          candidateNumber.amount < sourceNumber.amount
        ) lowerNumeric.push(key);
      }
    }
    const categoryMatches = Boolean(
      source?.leaf_category && candidate.leaf_category &&
        norm(source.leaf_category) === norm(candidate.leaf_category),
    );
    const completeCriticalProof = criticalKeys.length > 0 &&
      criticalKeys.every((key) =>
        sourceTraits.has(key) && candidateTraits.has(key) &&
        norm(sourceTraits.get(key)!) === norm(candidateTraits.get(key)!)
      );
    const status = source && source.id !== candidate.id && categoryMatches &&
        completeCriticalProof && contradicted.length === 0 &&
        unverified.length === 0
      ? "equivalent"
      : "candidate";
    return {
      id: candidate.id,
      title: String(candidate.pagetitle ?? "").replace(/[^\p{L}\p{N}\s.,%°/+()-]/gu, " ")
        .replace(/\s+/gu, " ").trim().slice(0, 100),
      status,
      contradicted,
      unverified,
      lower_numeric: lowerNumeric,
      matched,
    } as const;
  });
  const sourceUnit = norm(source?.unit ?? "");
  const cheaperThanSourceProven = Boolean(
    source && input.sourcePriceIdentityVerified === true &&
      Number.isFinite(source.price) && source.price > 0 &&
      sourceUnit && input.candidates.length > 0 &&
      input.candidates.every((candidate) =>
        candidate.id !== source.id && Number.isFinite(candidate.price) &&
        candidate.price > 0 && candidate.price < source.price &&
        norm(candidate.unit ?? "") === sourceUnit
      ),
  );
  const verifiedCandidateCriteria: Array<{ key: string; value: string }> = [];
  const seenCriteria = new Set<string>();
  if (input.candidates.length > 0) {
    for (const criterion of input.candidateSelectionCriteria ?? []) {
      // A contract is a search instruction, not proof of a card. Verify the
      // final value against every rendered product before mentioning it.
      if (criterion.op !== "eq" || criterion.unit ||
        typeof criterion.value !== "string" &&
        typeof criterion.value !== "number") continue;
      const key = String(criterion.key);
      const wanted = strictProofFacet(String(criterion.value));
      const normalizedKey = strictProofFacet(key);
      if (!normalizedKey || !wanted || seenCriteria.has(normalizedKey) ||
        isReplacementIdentityFacet({ key, caption: key })) continue;
      if (!input.candidates.every((candidate) =>
        strictLiveCandidateFacetValue(candidate, key) === wanted
      )) continue;
      const safeKey = key.replace(/[^\p{L}\p{N}\s.,%°/+()-]/gu, " ")
        .replace(/\s+/gu, " ").trim().slice(0, 60);
      const safeValue = String(criterion.value)
        .replace(/[^\p{L}\p{N}\s.,%°/+()-]/gu, " ")
        .replace(/\s+/gu, " ").trim().slice(0, 40);
      if (!safeKey || !safeValue) continue;
      verifiedCandidateCriteria.push({ key: safeKey, value: safeValue });
      seenCriteria.add(normalizedKey);
      if (verifiedCandidateCriteria.length >= 3) break;
    }
  }
  const visibleKeys = new Set([
    ...verifiedCandidateCriteria.map(({ key }) => key),
    ...candidates.flatMap(({ matched, lower_numeric }) => [
      ...matched.map(({ key }) => key),
      ...lower_numeric.filter((key) => criticalKeys.includes(key)),
    ]),
  ]);
  return {
    source_identity: source ? "exact" : "unverified",
    source_id: source?.id ?? null,
    candidates,
    all_equivalent: candidates.length > 0 &&
      candidates.every(({ status }) => status === "equivalent"),
    cheaper_than_source_proven: cheaperThanSourceProven,
    verified_candidate_criteria: verifiedCandidateCriteria,
    display_labels: commonProofDisplayLabels(source, input.candidates, visibleKeys),
    critical_facet_keys: criticalKeys,
  };
}

/** Caption belongs to the proof, not to whichever route found the cards. */
export function replacementProofCaption(
  proof: ReplacementProofContract,
): string {
  const label = (key: string) => proof.display_labels?.[key] ?? null;
  const criticalKeys = new Set(proof.critical_facet_keys ?? []);
  const visibleSelection = [...new Set(proof.verified_candidate_criteria.flatMap(({ key, value }) =>
    label(key) ? [`${label(key)}: ${value}`] : []
  ))];
  const verifiedSelection = visibleSelection.length > 0
    ? ` В карточках всех показанных товаров подтверждены параметры подбора: ${visibleSelection.join(", ")}.`
    : "";
  if (proof.source_identity !== "exact") {
    return `Показываю кандидатов для замены.${verifiedSelection} Исходный товар не подтверждён по точному артикулу: взаимозаменяемость и сравнение с его ценой не проверены. Уточните артикул исходного изделия и его критичные паспортные параметры.`;
  }
  const lower = proof.candidates.flatMap((item, index) => {
    const captions = [...new Set(
      item.lower_numeric.filter((key) => criticalKeys.has(key)).flatMap((key) =>
        label(key) ? [label(key)!] : []
      ),
    )].slice(0, 2);
    return captions.length > 0
      ? [`№${index + 1}${item.title ? ` «${item.title}»` : ""}: «${captions.join("», «")}»`]
      : [];
  });
  const hiddenLower = proof.candidates.some((item) =>
    item.lower_numeric.some((key) => criticalKeys.has(key) && !label(key))
  );
  const shared = proof.candidates[0]?.matched.filter(({ key, value }) =>
    proof.candidates.every((candidate) =>
      candidate.matched.some((item) =>
        item.key === key && norm(item.value) === norm(value)
      )
    )
  ).filter(({ key }) => label(key)).slice(0, 3) ?? [];
  const verifiedCriteria = shared.length > 0
    ? ` По данным карточек совпадают отдельные параметры: ${[...new Set(shared.map((item) =>
      `${label(item.key)}: ${item.value}`
    ))].join(", ")}.`
    : "";
  const difference = lower.length > 0
    ? ` Ниже значение параметра у конкретных кандидатов (${lower.join("; ")}); не считайте их равноценной заменой без проверки.`
    : "";
  const undisplayedDifference = hiddenLower
    ? " У некоторых кандидатов подтверждены и другие более низкие числовые параметры; проверьте их в карточках и паспортах изделий."
    : "";
  const compatibility = proof.all_equivalent
    ? "Совпадение подтверждено по полному набору проверенных критичных параметров каталога; перед установкой всё равно сверьте паспорт и монтаж."
    : `Полная взаимозаменяемость по данным каталога не подтверждена.${difference}${undisplayedDifference} Перед покупкой сверьте остальные критичные паспортные и монтажные характеристики.`;
  const price = proof.cheaper_than_source_proven
    ? " Цены показанных товаров ниже актуальной цены исходной карточки при той же единице продажи."
    : " Сравнение с ценой исходного товара не подтверждено.";
  return `Показываю кандидатов для замены.${verifiedSelection}${verifiedCriteria} ${compatibility}${price}`;
}

/**
 * Replacement prose is an information-flow decision, not a phrase classifier.
 * Unknown freeform/model text may contain an unlimited paraphrase of a false
 * compatibility or price claim, so only explicitly server-owned verified copy
 * is admitted. The server's proof caption is generated separately above.
 */
export function guardReplacementEgressText(
  text: string,
  trustedServerCopy = false,
): { text: string; removed: number } {
  const value = String(text);
  return trustedServerCopy
    ? { text: value, removed: 0 }
    : { text: "", removed: value.trim() ? 1 : 0 };
}

/** Structural replacement intent for egress, broader than direct routing. */
export function isReplacementProofRequest(message: string): boolean {
  const clean = norm(message);
  const hasReplacementRelation =
    /(?:^| )(?:аналог\p{L}*|альтернатив\p{L}*|похож\p{L}*|замен\p{L}*|вместо|взамен)(?: |$)/u
      .test(clean);
  if (!hasReplacementRelation) return false;
  const hasNamedSourceToken = (text: string): boolean => {
    const words = text.match(/\p{L}[\p{L}\p{N}-]*/gu) ?? [];
    return words.some((word, index) =>
      /^[A-Z][a-z]{2,}$/u.test(word) ||
      /^[A-Z]{4,}$/u.test(word) ||
      (index > 0 && /^[А-ЯЁ][а-яё]{2,}$/u.test(word))
    );
  };
  const keys = extractReplacementLookupKeys(message);
  const sourceBeforeReplacementTarget = String(message).match(
    /(?:^|\s)замен\p{L}*\s+(.+?)\s+на\s+\S/iu,
  )?.[1] ?? "";
  const namedSourceBeforeReplacementTarget = hasNamedSourceToken(
    sourceBeforeReplacementTarget,
  );
  // A category redesign ("replace a chandelier with LED lighting") has no
  // named source product. It remains normal selection, not SKU equivalence.
  if (
    /замен\p{L}* .+ на .+/u.test(clean) &&
    !/(?:^| )(?:аналог\p{L}*|альтернатив\p{L}*)(?: |$)/u.test(clean) &&
    keys.articles.length === 0 &&
    keys.modelCodes.length === 0 &&
    !namedSourceBeforeReplacementTarget
  ) return false;
  const source = extractReplacementSourceDescription(message);
  if (source.length < 3) return false;
  if (keys.articles.length > 0 || keys.modelCodes.length > 0) return true;
  const quotedSource = /[«"][^»"]{3,}[»"]/u.test(message);
  if (quotedSource) return true;
  // Similarity/"alternatives" can describe a desired class or application;
  // a brand alone is not a source SKU in that exploratory grammar. By contrast,
  // an explicit analogue/replacement of a named line is a source-directed ask.
  const explicitSubstitution =
    /(?:^| )(?:аналог\p{L}*|замен\p{L}*|вместо|взамен)(?: |$)/u.test(clean);
  if (!explicitSubstitution) return false;
  // A trailing application cannot erase an explicitly named source in an
  // analogue/substitution ask ("... Gallant для кухни"). An unnamed class
  // with an application remains ordinary selection. Broad similarity asks
  // were excluded above, even when they happen to mention a brand.
  const application = /(?:^|\s)(?:для|в)\s+\p{L}/iu.exec(source);
  if (application) {
    const beforeApplication = source.slice(0, application.index);
    if (
      !hasNamedSourceToken(beforeApplication) &&
      !namedSourceBeforeReplacementTarget
    ) return false;
  }
  // A named line is an identifiable source for output safety, while an
  // unnamed class or room measurement is an ordinary selection.
  return hasNamedSourceToken(source);
}

/** A relative-price claim needs an explicitly supplied exact source article. */
export function sourceArticleIsExplicitInRequest(
  request: string,
  source: ProductRef | null,
): boolean {
  const article = identityCodeNorm(source?.article ?? "");
  if (article.length < 5) return false;
  const lookup = extractReplacementLookupKeys(request);
  return [...lookup.articles, ...lookup.modelCodes]
    .some((key) => identityCodeNorm(key) === article);
}

/** Terminal text must not imply catalog absence or ask again for a supplied SKU. */
export function replacementTerminalFallback(request: string): string {
  const keys = extractReplacementLookupKeys(request);
  return keys.articles.length > 0 || keys.modelCodes.length > 0
    ? "Не удалось завершить проверку замены по указанному артикулу или модели. Это не доказывает, что подходящих товаров нет. Повторите запрос позже."
    : "Не удалось завершить проверку замены. Это не доказывает, что подходящих товаров нет. Уточните точный артикул исходного изделия или повторите запрос позже.";
}

/** Only the completed server log, never client history, authorizes replay. */
export function persistedReplacementEgressMode(
  events: readonly { type: string; phase?: string; replacement_egress?: string }[],
): "replacement" | "ordinary" | null {
  const complete = [...events].reverse().find((event) =>
    event.type === "diagnostic" && event.phase === "complete"
  );
  return complete?.replacement_egress === "replacement" ||
      complete?.replacement_egress === "ordinary"
    ? complete.replacement_egress
    : null;
}

export function shouldGuardReplayWithoutClientHistory(
  events: readonly { type: string; phase?: string; replacement_egress?: string }[],
): boolean {
  // Unknown legacy rows are scrubbed rather than guessed from client history.
  return persistedReplacementEgressMode(events) !== "ordinary";
}

/** Legacy chip replies keep a coherent, claim-free question without trusting
 * the old model-authored question stored in a pending slot. */
export function replacementReplayClarificationCaption(
  events: readonly {
    type: string;
    facet_key?: string;
    replies?: Array<{ value: string }>;
  }[],
  replacement = true,
): string {
  const chips = events.find((event) => event.type === "quick_replies");
  const facet = String(chips?.facet_key ?? "").replace(/[_-]+/gu, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/gu, " ").trim()
    .slice(0, 80);
  const values = chips?.replies?.slice(0, 5).map((item) =>
    String(item.value ?? "").replace(/[^\p{L}\p{N}\s.,%°/+()-]/gu, " ")
      .replace(/\s+/gu, " ").trim().slice(0, 40)
  ).filter(Boolean) ?? [];
  if (facet && values.length >= 2) {
    const object = replacement ? "исходного изделия" : "товара";
    return `Уточните значение параметра «${facet}» ${object}: ${values.join(" или ")}?`;
  }
  return replacement
    ? "Уточните параметры исходного изделия, чтобы проверить замену."
    : "Не удалось безопасно восстановить прежний текст ответа. Повторите запрос, если вопрос остался актуальным.";
}

/**
 * Carry the protection through a short relative-price follow-up only when
 * the previous user task was a replacement and no new task was detected.
 * Routing remains unchanged: this is a monotone safety boundary.
 */
export function resolveReplacementProofContext(
  currentMessage: string,
  recentDialogue: ReplacementDialogueMessage[],
  options: { newTask?: boolean; comparativeFollowup?: boolean } = {},
): string | null {
  if (isReplacementProofRequest(currentMessage)) return currentMessage;
  if (options.newTask || !options.comparativeFollowup) return null;
  const latestUser = [...recentDialogue].reverse().find((entry) =>
    entry.role === "user"
  );
  return latestUser && isReplacementProofRequest(latestUser.content)
    ? latestUser.content
    : null;
}

/**
 * Old persisted replies may predate this egress boundary. Replays cannot
 * establish a fresh source SKU without catalog work, so they retain card and
 * protocol events but replace all historical freeform deltas with a guarded
 * server caption. No LLM/catalog request is made on reconnect.
 */
export function guardReplacementReplayEvents<T extends {
  type: string;
  phase?: string;
  origin?: string;
  replacement_proof?: boolean;
}>(
  events: readonly T[],
  candidateCaption: T,
  clarificationCaption: T,
): T[] {
  const guarded: T[] = [];
  let sawCards = false;
  let sawQuestion = false;
  let sawTrustedText = false;
  let sawProofCaption = false;
  for (const event of events) {
    if (event.type === "delta") {
      if (event.origin === "server") {
        guarded.push(event);
        sawTrustedText = true;
        if (event.replacement_proof) sawProofCaption = true;
      }
      continue;
    }
    if (event.type === "products_block") {
      if (!sawProofCaption) guarded.push(candidateCaption);
      sawCards = true;
    } else if (
      event.type === "quick_replies" && !sawCards && !sawQuestion &&
      !sawTrustedText
    ) {
      guarded.push(clarificationCaption);
      sawQuestion = true;
    } else if (
      event.type === "diagnostic" && event.phase === "complete" &&
      !sawCards && !sawQuestion && !sawTrustedText
    ) {
      guarded.push(clarificationCaption);
      sawQuestion = true;
    } else if (
      event.type === "done" && !sawCards && !sawQuestion && !sawTrustedText
    ) {
      guarded.push(clarificationCaption);
      sawQuestion = true;
    }
    guarded.push(event);
  }
  return guarded;
}

/** The issued chip is a customer answer, not a catalog filter. Promote it only
 * after the same category exposes the same structural key and exact value.
 * A typed phrase must additionally label its value with that live axis;
 * a bare numeric chip is already unambiguous within the server-issued slot. */
export function resolveVerifiedIssuedLiveReplacementAxis(
  answer: {
    facet_key: string;
    value: string;
    resolved_category: string;
  },
  customerReply: string,
  resolvedCategory: string,
  facets: Facet[],
): { key: string; caption: string; value: string } | null {
  if (
    !answer || norm(answer.resolved_category) !== norm(resolvedCategory) ||
    !norm(resolvedCategory)
  ) return null;
  const matches = facets.filter((facet) =>
    facet.key === answer.facet_key && isStructuralCardinalityFacet(facet)
  );
  if (matches.length !== 1) return null;
  const facet = matches[0];
  const values = [...new Set(facet.values.map(({ value }) => value.trim()))]
    .filter((value) => value === answer.value);
  if (values.length !== 1) return null;
  if (customerReply.trim() !== answer.value) {
    const labeled = resolveLabeledFacetValueEvidence(customerReply, [facet]);
    if (
      labeled.length !== 1 || labeled[0].axis.key !== facet.key ||
      labeled[0].axis.value !== answer.value
    ) return null;
  }
  return { key: facet.key, caption: facet.caption, value: values[0] };
}

/**
 * A replacement request may identify the source by a live series/collection
 * and compact technical code without spelling the product class.  A model-
 * proposed taxonomy class is safe to use only when the proposed class exposes
 * both the exact customer-named live model identity and at least two live axes
 * decoded from the compact code.  Neither the model proposal, the series name,
 * nor a short code is sufficient on its own.
 */
export function replacementClassIsGroundedByLiveIdentity(
  message: string,
  facets: Facet[],
): boolean {
  return explicitReplacementModelValues(facets, message).length > 0 &&
    compactFacetCodeSupportScore(message, facets) >= 2;
}

/**
 * Compile a continuation such as `C16 … / 1 полюс` from the live schema and
 * literal-search product evidence.  At least two axes must be proved by the
 * compact code and at least one additional structural axis must be explicitly
 * supplied by the customer.  Nothing category- or brand-specific is encoded.
 */
export function compileLiveCompactReplacementContract(
  message: string,
  facets: Facet[],
  products: Array<
    { short_traits?: string[]; facet_values?: Record<string, string[]> }
  >,
): LiveCompactReplacementContract | null {
  const explicit = [
    ...resolveCompoundFacetValueEvidence(message, facets),
    ...resolveLabeledFacetValueEvidence(message, facets),
  ].map(({ axis }) => axis)
    .filter((axis) => {
      const facet = facets.find((candidate) => candidate.key === axis.key);
      return Boolean(facet && isStructuralCardinalityFacet(facet));
    });
  if (explicit.length === 0) return null;
  const candidateKeys = new Set([
    ...compactFacetCandidateKeys(message, facets),
    ...explicit.map(({ key }) => key),
  ]);
  const proofFacets = facets.filter((facet) =>
    candidateKeys.has(facet.key) && !isReplacementIdentityFacet(facet)
  );
  const compact = resolveCompactFacetCodeEvidenceFromProductsV2(
    message,
    proofFacets,
    products,
  );
  if (compact.length === 0 || compact.some(({ axes }) => axes.length < 2)) {
    return null;
  }
  const compactAxes = compact.flatMap(({ axes }) => axes);

  const merged = new Map<
    string,
    { key: string; caption: string; value: string }
  >();
  for (const axis of [...compactAxes, ...explicit]) {
    const existing = merged.get(axis.key);
    if (existing && norm(existing.value) !== norm(axis.value)) return null;
    merged.set(axis.key, axis);
  }
  const structuralKeys = new Set(explicit.map(({ key }) => key));
  if (
    ![...structuralKeys].some((key) =>
      !compactAxes.some((axis) => axis.key === key)
    )
  ) return null;
  return {
    compact_codes: [...new Set(compact.map(({ code }) => code))],
    axes: [...merged.values()],
  };
}

/**
 * A compact source code can identify several live catalogue variants while
 * leaving a structural choice unstated.  Instead of guessing one SKU, ask for
 * the missing axis supplied by the current live schema.  The rule knows no
 * brands, categories or products: it accepts only a uniquely decoded compact
 * code and a small, non-identity cardinality facet from discovery.
 */
export function inferLiveReplacementClarification(
  message: string,
  facets: Facet[],
): LiveReplacementClarification | null {
  const compact = resolveCompactFacetCodeEvidence(message, facets);
  // An ambiguous live decomposition is sufficient only to ask a question. It
  // is deliberately insufficient for filters/cards; those still require the
  // stricter unique decoder (or product evidence) elsewhere in the pipeline.
  if (
    compact.length === 0 && compactFacetCodeSupportScore(message, facets) < 2
  ) return null;
  const resolvedKeys = new Set(
    compact.flatMap(({ axes }) => axes.map(({ key }) => key)),
  );
  // The customer has answered the structural clarification. Do not turn every
  // remaining `quantity` facet (for example, package count) into a chain of
  // compatibility questions.
  if (
    facets.some((facet) =>
      isStructuralCardinalityFacet(facet) &&
      replacementFacetValueIsDeclared(message, facet)
    )
  ) return null;
  const candidates = facets.flatMap((facet) => {
    if (resolvedKeys.has(facet.key) || isReplacementIdentityFacet(facet)) {
      return [];
    }
    if (replacementFacetValueIsDeclared(message, facet)) return [];
    const label = norm(`${facet.key} ${facet.caption}`);
    // Cardinality/structure axes are the safe universal discriminator for an
    // otherwise ambiguous replacement. Commercial flags, colours and labels
    // are preferences and must never block the dialogue here.
    if (!isStructuralCardinalityFacet(facet)) {
      return [];
    }
    const options = facet.values
      .filter(({ value }) => {
        const clean = String(value ?? "").trim();
        return clean.length > 0 && clean.length <= 24;
      })
      .slice(0, 6);
    const unique = [
      ...new Map(options.map((entry) => [norm(entry.value), entry])).values(),
    ];
    if (unique.length < 2 || unique.length > 5) return [];
    const total = unique.reduce(
      (sum, entry) => sum + Math.max(0, entry.products_count ?? 0),
      0,
    );
    const explicitCountCaption = /(?:количеств\p{L}*|числ\p{L}*|count|number)/u
      .test(label);
    return [{ facet, values: unique, total, explicitCountCaption }];
  }).sort((left, right) =>
    Number(right.explicitCountCaption) - Number(left.explicitCountCaption) ||
    right.total - left.total ||
    left.values.length - right.values.length ||
    left.facet.caption.localeCompare(right.facet.caption)
  );
  const selected = candidates[0];
  if (!selected) return null;
  const caption = selected.facet.caption.trim();
  return {
    facet_key: selected.facet.key,
    caption,
    question: `Чтобы подобрать кандидатов для замены, уточните ${
      caption.toLocaleLowerCase("ru-RU")
    }.`,
    options: selected.values.map(({ value, products_count }) => ({
      value,
      label: value,
      ...(typeof products_count === "number" ? { count: products_count } : {}),
    })),
  };
}

export interface ExplicitReplacementAxis {
  key: string;
  caption: string;
  value: string;
  total: number;
  /** A customer-visible technical code that must survive near-match recovery. */
  mandatory?: true;
}

export function productTitleSupportsMandatoryAxes(
  productTitle: string,
  axes: ExplicitReplacementAxis[],
): boolean {
  return axes
    .filter((axis) => axis.mandatory)
    .every((axis) =>
      portableTechnicalCodeMatchesText(axis.value, productTitle)
    );
}

export function excludeMandatoryAxisCodesFromSourceModels(
  modelCodes: string[],
  axes: ExplicitReplacementAxis[],
): string[] {
  const mandatory = axes.filter((axis) => axis.mandatory);
  return modelCodes.filter((code) =>
    !mandatory.some((axis) =>
      portableTechnicalCodeMatchesText(axis.value, code)
    )
  );
}

export interface ReplacementLookupKeys {
  articles: string[];
  modelCodes: string[];
}

/**
 * Extracts the customer's source-product description without knowing any
 * product vocabulary. A colon after the replacement command and a trailing
 * replacement clause are high-confidence grammatical boundaries; otherwise
 * only the replacement command itself is removed. The result is used as a
 * high-recall catalog lookup and never as proof by itself.
 */
export function extractReplacementSourceDescription(message: string): string {
  const source = String(message ?? "").replace(/\s+/gu, " ").trim();
  if (!source) return "";
  const trigger =
    /(?:аналог\p{L}*|альтернатив\p{L}*|похож\p{L}*|замен\p{L}*|вместо|взамен)/iu;
  const quoted = source.match(/(?:«([^»]{2,})»|"([^"]{2,})")/u);
  if (quoted && trigger.test(source.slice(0, quoted.index ?? 0))) {
    return String(quoted[1] ?? quoted[2] ?? "").trim();
  }
  const colon = source.indexOf(":");
  if (colon >= 0 && trigger.test(source.slice(0, colon))) {
    return source.slice(colon + 1).replace(/^[\s:–—-]+|[\s:–—-]+$/gu, "")
      .trim();
  }
  const trailing = source.match(
    /^(.*?)[\s,;:–—-]+(?:предлож\p{L}*|подбер\p{L}*|найд\p{L}*|покаж\p{L}*)\s+(?:равноцен\p{L}*\s+)?(?:аналог\p{L}*|альтернатив\p{L}*|замен\p{L}*)(?:\s.*)?$/iu,
  );
  if (trailing?.[1]?.trim()) return trailing[1].trim();
  const match = trigger.exec(source);
  if (!match || match.index === undefined) return source;
  return source.slice(match.index + match[0].length)
    .replace(
      /^(?:\s+(?:для|на|к|ко|этой|этому|этого|этот|эту)){0,5}[\s:–—-]*/iu,
      "",
    )
    .replace(/^[\s:–—-]+|[\s:–—-]+$/gu, "")
    .trim();
}

/**
 * A customer-declared source class is compiled to live taxonomy leaves before
 * anchor selection. When that scope exists, an alphanumeric compatibility
 * token cannot move the source to a sibling class. Empty scope means that the
 * customer did not lexically ground a class, so exact identifiers keep the
 * previous behavior.
 */
export function productBelongsToReplacementSourceScope(
  product: Pick<ProductRef, "leaf_category">,
  liveLeafCategories: string[],
): boolean {
  if (liveLeafCategories.length === 0) return true;
  const leaf = norm(product.leaf_category ?? "");
  return Boolean(
    leaf && liveLeafCategories.some((candidate) => norm(candidate) === leaf),
  );
}

export interface ReplacementDialogueMessage {
  role: "user" | "assistant";
  content: string;
}

/** Detect an alternative request only when the same phrase also identifies
 * the source product structurally. Broad redesign requests stay ordinary. */
export function isReplacementIntent(message: string): boolean {
  const value = norm(message);
  const trigger =
    /(?:^| )(?:аналог\p{L}*|альтернатив\p{L}*|похож\p{L}*|замен\p{L}*|вместо|взамен)(?: |$)/u
      .test(value);
  if (!trigger) return false;
  const tokens = String(message).match(/[a-zа-я0-9][a-zа-я0-9-]{2,}/giu) ?? [];
  const hasAlphaNumericAnchor = tokens.some((token) =>
    /\p{L}/u.test(token) && /\d/u.test(token)
  );
  return hasAlphaNumericAnchor || /\b\d{4,}\b/u.test(value) ||
    /«[^»]{2,}»|"[^"]{2,}"/u.test(message);
}

/** Replacement-only exclusions must never run merely because an ordinary
 * product request contains two technical codes. Those codes are positive
 * selection criteria outside replacement mode, not evidence of a source SKU
 * that should be removed from the result. */
export function shouldApplyReplacementExclusionGuard(
  replacementIntent: boolean,
  hasAnchor: boolean,
  hasIdentityExclusions: boolean,
): boolean {
  return replacementIntent && (hasAnchor || hasIdentityExclusions);
}

/** Carry replacement mode through a short confirmation/show command only.
 * Substantive new wording breaks inheritance and starts ordinary routing. */
export function resolveReplacementIntent(
  message: string,
  recentDialogue: ReplacementDialogueMessage[],
): boolean {
  return resolveReplacementSourceMessage(message, recentDialogue) !== null;
}

/** Returns the authoritative source request for replacement guards. */
export function resolveReplacementSourceMessage(
  message: string,
  recentDialogue: ReplacementDialogueMessage[],
): string | null {
  if (isReplacementIntent(message)) return message;
  const followup = norm(message);
  if (
    !/^(?:(?:да|хорошо|ладно|ок|okay|давай|тогда|ну|пожалуйста|можно) )*(?:покаж\p{L}*|предлож\p{L}*|давай|продолж\p{L}*)(?: (?:их|эти|варианты|товары|подходящие|найденные|предложенные|ссылки?))?$/u
      .test(followup)
  ) {
    return null;
  }
  for (const fragment of [...recentDialogue].reverse()) {
    if (fragment.role !== "user") continue;
    return isReplacementIntent(fragment.content) ? fragment.content : null;
  }
  return null;
}

/** Read the original replacement request from a previously server-verified
 * readiness slot, never from its synthetic `original + clarification` prompt.
 * The caller must pass only a slot verified against the latest completed
 * response; equality with the scoped continuation prevents mixed tasks. */
export function resolveScopedReplacementSource(
  currentMessage: string,
  scopedContinuation: { message: string; category: string } | null,
  verifiedPendingSlot: unknown,
): string | null {
  if (!scopedContinuation || !verifiedPendingSlot ||
    typeof verifiedPendingSlot !== "object" ||
    Array.isArray(verifiedPendingSlot)) return null;
  const scope = (verifiedPendingSlot as { scope?: unknown }).scope;
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return null;
  const record = scope as Record<string, unknown>;
  if (
    record.kind !== "selection_readiness" ||
    typeof record.token !== "string" ||
    typeof record.resolved_category !== "string" ||
    record.resolved_category !== scopedContinuation.category
  ) return null;
  const original = record.token.trim().slice(0, 500);
  const current = String(currentMessage ?? "").trim();
  if (
    !original || !current || !isReplacementIntent(original) ||
    scopedContinuation.message !==
      `${original}\nУточнение клиента: ${current}`
  ) return null;
  return original;
}

/** Compact variant/curve/class codes are often visible in titles even when
 * the catalog omits the matching trait. Capture only a standalone uppercase
 * letter explicitly introduced by a parameter label. */
export function extractExplicitSingleLetterCodes(message: string): string[] {
  const matches = [
    ...String(message ?? "").matchAll(
      /(?<![\p{L}\p{N}])\p{L}{4,}(?:\s+\p{L}{4,}){0,2}\s*[:=–—-]?\s+([A-ZА-ЯЁ])(?![\p{L}\p{N}])/gu,
    ),
  ];
  return distinct(matches.map((match) => visualCodeNorm(match[1])));
}

/**
 * Extracts technical requirements that can legitimately survive a change of
 * product identity. The grammar accepts compact letter/number standards and
 * numeric values with units, but rejects SKU-shaped codes and a false code
 * formed across two adjacent measurements (for example `16 А 4,5 кА`).
 */
export function extractPortableTechnicalRequirements(
  message: string,
): string[] {
  const source = String(message ?? "");
  const out: string[] = [];
  const add = (raw: string) => {
    const clean = raw.replace(/\s+/gu, "").replace(/,/gu, ".").trim();
    const normalized = codeNorm(clean);
    if (!normalized || normalized.includes("-")) return;
    if (!/\p{L}/u.test(normalized) || !/\d/u.test(normalized)) return;
    if (/^\d+(?:\.\d+)?(?:тг|тенге|kzt)$/iu.test(normalized)) return;
    if (
      /^\d+(?:\.\d+)?\p{L}{1,5}$/u.test(normalized) || normalized.length <= 4
    ) {
      out.push(clean);
    }
  };

  for (
    const match of source.matchAll(
      /(?<![\p{L}\p{N}])\d+(?:[.,]\d+)?\s*(?:[\p{L}]{1,5}|мм²|мм2)(?![\p{L}\p{N}])/giu,
    )
  ) add(match[0]);

  for (
    const match of source.matchAll(
      /(?<![\p{L}\p{N}])[\p{L}]{1,5}\s*\d{1,5}[\p{L}\d.-]*(?![\p{L}\p{N}])/giu,
    )
  ) {
    const prefix = source.slice(0, match.index ?? 0);
    if (/\d+(?:[.,]\d+)?\s*$/u.test(prefix)) continue;
    add(match[0]);
  }
  return distinct(out.map((value) => codeNorm(value)))
    .map((normalized) => out.find((value) => codeNorm(value) === normalized)!)
    .filter(Boolean);
}

function norm(value: string): string {
  return String(value ?? "")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е")
    .replace(/[^a-zа-я0-9]+/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function codeNorm(value: string): string {
  return norm(value).replace(/\s+/gu, "");
}

function identityCodeNorm(value: string): string {
  const lookalikes: Record<string, string> = {
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
  return codeNorm(value).replace(
    /[авекмнорстух]/gu,
    (char) => lookalikes[char] ?? char,
  );
}

function visualCodeNorm(value: string): string {
  return identityCodeNorm(value)
    // Standard electrical units may be written as Latin symbols or Russian
    // abbreviations. Normalize only terminal unit suffixes, never prose.
    .replace(/(?<=\d)kbt$/u, "kw")
    .replace(/(?<=\d)bt$/u, "w")
    .replace(/(?<=\d)b$/u, "v");
}

export interface PortableReplacementAxis {
  caption: string;
  values: string[];
  unit: string | null;
}

/**
 * Compiles live replacement axes into title-visible proof obligations. A live
 * facet may omit its unit even though the consultant states it explicitly
 * (`Номинальный ток: 16 А`). In that case the number is accepted only when a
 * unique number+unit code in the reasoning has the same live numeric value.
 * Model-only codes without a matching live axis never enter the result.
 */
export function derivePortableAxisTitleRequirements(
  axes: PortableReplacementAxis[],
  reasoningText: string,
): string[] {
  const explicitSingleCodes = new Set(
    extractExplicitSingleLetterCodes(reasoningText),
  );
  const reasoningCodes = extractPortableTechnicalRequirements(reasoningText);
  const compactReasoningCodes = new Set(
    (String(reasoningText).match(
      /(?<![\p{L}\p{N}])(?=[\p{L}\p{N}.-]{2,24}(?![\p{L}\p{N}]))(?=[\p{L}\p{N}.-]*\p{L})(?=[\p{L}\p{N}.-]*\d)[\p{L}\p{N}][\p{L}\p{N}.-]{1,23}(?![\p{L}\p{N}])/gu,
    ) ?? [])
      .map(visualCodeNorm)
      .filter(Boolean),
  );
  const requirements: string[] = [];
  const axisFragments = (
    axis: PortableReplacementAxis,
  ): Array<{ fragment: string; requirement: string | null }> => {
    const unit = axis.unit ??
      axis.caption.match(/(?:,|\()\s*([a-zа-я]{1,5})\)?$/iu)?.[1] ?? null;
    return (axis.values ?? []).flatMap((rawValue) => {
      const value = String(rawValue).trim();
      const normalized = visualCodeNorm(value);
      if (!normalized) return [];
      const numericOnly = /^\d+(?:[.,]\d+)?$/u.test(value);
      const requirement = numericOnly
        ? unit && /\p{L}/u.test(unit) ? `${value}${unit}` : null
        : value;
      const fragments = new Set([normalized]);
      if (/^\d+(?:[.,]\d+)?$/u.test(value) && unit) {
        fragments.add(visualCodeNorm(`${value}${unit}`));
        fragments.add(visualCodeNorm(`${unit}${value}`));
      }
      return [...fragments].map((fragment) => ({ fragment, requirement }));
    });
  };
  for (const axis of axes ?? []) {
    const captionUnit =
      axis.caption.match(/(?:,|\()\s*([a-zа-я]{1,5})\)?$/iu)?.[1] ?? null;
    const unit = axis.unit ?? captionUnit;
    for (const value of axis.values ?? []) {
      const shortCode = value.split(/[^\p{L}\p{N}]+/gu)
        .find((token) => {
          const normalized = visualCodeNorm(token);
          return normalized.length === 1 && explicitSingleCodes.has(normalized);
        });
      if (shortCode) {
        requirements.push(shortCode);
        continue;
      }
      if (/\d/u.test(value) && /\p{L}/u.test(value)) {
        requirements.push(value);
        continue;
      }
      if (!/^\d+(?:[.,]\d+)?$/u.test(value)) continue;
      if (unit && /\p{L}/u.test(unit)) {
        requirements.push(`${value}${unit}`);
        continue;
      }
      const numeric = Number(value.replace(",", "."));
      const groundedCodes = reasoningCodes.filter((code) => {
        const match = visualCodeNorm(code).match(
          /^(\d+(?:\.\d+)?)(\p{L}{1,5})$/u,
        );
        return Boolean(match && Number(match[1]) === numeric);
      });
      if (groundedCodes.length === 1) requirements.push(groundedCodes[0]);
    }
  }
  // Some customer-visible catalog codes encode two independent live axes in
  // one token (letter+number or number+letter). Accept the decomposition only
  // when the complete normalized token equals the concatenation of one exact
  // value from each axis. A digit occurring inside a longer SKU is therefore
  // insufficient and cannot manufacture an obligation.
  for (let leftIndex = 0; leftIndex < (axes ?? []).length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < axes.length;
      rightIndex += 1
    ) {
      for (const left of axisFragments(axes[leftIndex])) {
        for (const right of axisFragments(axes[rightIndex])) {
          if (
            !compactReasoningCodes.has(`${left.fragment}${right.fragment}`) &&
            !compactReasoningCodes.has(`${right.fragment}${left.fragment}`)
          ) continue;
          if (left.requirement) requirements.push(left.requirement);
          if (right.requirement) requirements.push(right.requirement);
        }
      }
    }
  }
  return [
    ...new Map(requirements.map((value) => [visualCodeNorm(value), value]))
      .values(),
  ];
}

/** Exact comparison for mixed letter/digit codes such as GX53, IP44 or 16A. */
export function portableTechnicalCodeMatchesText(
  target: string,
  text: string,
): boolean {
  const wanted = visualCodeNorm(target);
  if (!wanted || !/\p{L}/u.test(wanted) || !/\d/u.test(wanted)) return false;
  const candidates = [
    ...(String(text).match(/[\p{L}\p{N}]+/gu) ?? []),
    ...(String(text).match(/[\p{L}]{1,12}\s*[-_/]?\s*\d{1,12}/gu) ?? []),
    ...(String(text).match(/\d{1,12}(?:[.,-]\d{1,12})*\s*[\p{L}]{1,6}/gu) ??
      []),
  ];
  return candidates.some((candidate) => visualCodeNorm(candidate) === wanted);
}

/**
 * Final title-level compatibility contract for replacement cards. This is
 * deliberately independent from categories, brands and product dictionaries:
 * every portable requirement came either from the customer's request or from
 * a live facet value explicitly selected in the consultant's reasoning.
 */
export function productTitleSupportsPortableRequirements(
  productTitle: string,
  requirements: string[],
): boolean {
  const titleTokens = new Set(
    (String(productTitle).match(/[\p{L}\p{N}]+/gu) ?? []).map(visualCodeNorm),
  );
  return requirements.every((requirement) => {
    const normalized = visualCodeNorm(requirement);
    return normalized.length === 1
      ? titleTokens.has(normalized)
      : portableTechnicalCodeMatchesText(requirement, productTitle);
  });
}

function distinct(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/** Extracts only structural identifiers from the current request. */
export function extractReplacementLookupKeys(
  message: string,
): ReplacementLookupKeys {
  const articles = distinct(
    [...message.matchAll(/(?<!\d)\d{6,18}(?!\d)/gu)].map((match) => match[0]),
  );
  const tokens = message.match(/[a-zа-я0-9][a-zа-я0-9._/-]{2,}/giu) ?? [];
  const separatedModelCodes = [...message.matchAll(
    /(?<![\p{L}\p{N}])[\p{L}]{1,6}\s+\d{1,6}(?:\s*[-/.]\s*\d{1,6})+(?![\p{L}\p{N}])/giu,
  )].flatMap((match) => {
    const spaced = match[0].replace(/\s+/gu, " ").replace(
      /\s*([-/.])\s*/gu,
      "$1",
    ).trim();
    return [spaced, spaced.replace(/\s+/gu, "")];
  });
  const modelCodes = distinct([
    ...separatedModelCodes,
    ...tokens
      .map((token) => token.replace(/[^a-zа-я0-9-]/giu, ""))
      .filter((token) =>
        token.length >= 4 && /\p{L}/u.test(token) && /\d/u.test(token)
      )
      // A number followed only by a word is a quantity with a joined unit
      // (`4000тенге`, `100ватт`, `250вольт`), not a product identifier. Unit
      // names are deliberately not enumerated here: the structural distinction
      // works for every category and for new natural-language spellings.
      .filter((token) => !/^\d+(?:[.,-]\d+)?[a-zа-я]+$/iu.test(token))
      // The same physical notation can end with a plain 2/3 instead of a
      // Unicode superscript (`500м2`, `30см3`). It is still a measurement, not
      // an exact SKU. Keep the rule structural and unit-agnostic: a digit-led
      // scalar followed by one alphabetic unit chunk and a power suffix cannot
      // prove product identity.
      .filter((token) => !/^\d+(?:[.,-]\d+)?[a-zа-я]+[23]$/iu.test(token)),
  ].sort((left, right) => right.length - left.length));
  return { articles, modelCodes };
}

function traitEntries(
  product: { short_traits?: string[] },
): Array<{ caption: string; value: string }> {
  const entries: Array<{ caption: string; value: string }> = [];
  for (const line of product.short_traits ?? []) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const caption = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (caption && value) entries.push({ caption, value });
  }
  return entries;
}

/**
 * Lookup keys are intentionally broad: every code in a source title can help
 * find the anchor. Excluding analogue cards is a narrower operation. A code
 * explicitly recorded as a non-identity trait is portable; otherwise the
 * first model-like code in the live anchor title is the source-family key.
 * Later title codes describe variants/specifications and must not each become
 * an independent family exclusion merely because they were in the request.
 */
export function resolveReplacementSourceModelCodes(
  message: string,
  anchor: { pagetitle?: string; short_traits?: string[] } | null = null,
  axes: ExplicitReplacementAxis[] = [],
  lookupCodes = extractReplacementLookupKeys(message).modelCodes,
): string[] {
  const candidates = [...new Map(
    excludeMandatoryAxisCodesFromSourceModels(lookupCodes, axes)
      .map((code) => [
        identityCodeNorm(code),
        code.replace(/\s+/gu, ""),
      ]),
  ).values()];
  if (candidates.length === 0) return [];
  const traits = anchor ? traitEntries(anchor) : [];
  const hasTraitCode = (
    code: string,
    identity: boolean,
  ): boolean =>
    traits.some((trait) =>
      isReplacementIdentityFacet({
          key: trait.caption,
          caption: trait.caption,
        }) ===
        identity &&
      extractReplacementLookupKeys(trait.value).modelCodes.some((value) =>
        identityCodeNorm(value) === identityCodeNorm(code)
      )
    );
  const eligible = candidates.filter((code) => !hasTraitCode(code, false));
  if (eligible.length === 0) return [];

  const title = anchor?.pagetitle ?? "";
  const titleNorm = identityCodeNorm(title);
  const titlePosition = (code: string): number => {
    const position = titleNorm.indexOf(identityCodeNorm(code));
    return position < 0 ? Number.POSITIVE_INFINITY : position;
  };
  const byTitlePosition = (left: string, right: string): number =>
    titlePosition(left) - titlePosition(right);
  const explicitIdentity = eligible.filter((code) => hasTraitCode(code, true));
  if (explicitIdentity.length > 0) {
    return explicitIdentity.sort(byTitlePosition).slice(0, 1);
  }

  if (title) {
    const primaryTitleCode = extractReplacementLookupKeys(title).modelCodes
      .filter((code) => !hasTraitCode(code, false))
      .sort(byTitlePosition)[0];
    if (primaryTitleCode) {
      // A request may quote a later technical/variant code without naming the
      // actual family. In that case there is no proven model exclusion.
      return eligible.filter((code) =>
        identityCodeNorm(code) === identityCodeNorm(primaryTitleCode)
      );
    }
  }

  // Without a verified anchor, use only the first structural code in the
  // customer's source description. This keeps exclusion conservative while
  // the broad lookup still searches every candidate code.
  const source = identityCodeNorm(extractReplacementSourceDescription(message));
  return eligible
    .map((code, index) => ({
      code,
      index,
      position: source.indexOf(identityCodeNorm(code)),
    }))
    .sort((left, right) =>
      (left.position < 0 ? Number.POSITIVE_INFINITY : left.position) -
        (right.position < 0 ? Number.POSITIVE_INFINITY : right.position) ||
      left.index - right.index
    )
    .slice(0, 1)
    .map(({ code }) => code);
}

function captionsMatch(left: string, right: string): boolean {
  const a = norm(left);
  const b = norm(right);
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

function canonicalFacetValue(
  facet: Facet,
  traitValue: string,
): { value: string; total: number } | null {
  const wanted = norm(traitValue);
  const wantedCode = codeNorm(traitValue);
  const match = (facet.values ?? []).find((candidate) => {
    const candidateNorm = norm(candidate.value);
    const candidateCode = codeNorm(candidate.value);
    return candidateNorm === wanted || candidateCode === wantedCode;
  });
  if (!match) return null;
  return {
    value: String(match.value),
    total: Number(match.products_count ?? Number.POSITIVE_INFINITY),
  };
}

function explicitInAnchorText(value: string, evidence: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^\d+(?:[.,]\d+)?$/u.test(trimmed)) {
    const escaped = trimmed.replace(/[.,]/u, "[.,]");
    return new RegExp(`(?<!\\d)${escaped}(?!\\d)`, "u").test(evidence);
  }
  const compact = codeNorm(trimmed);
  return compact.length >= 2 && codeNorm(evidence).includes(compact);
}

function captionIsEvidenced(caption: string, evidence: string): boolean {
  const evidenceTokens = norm(evidence).split(" ").filter((token) =>
    token.length >= 4
  );
  return norm(caption).split(" ")
    .filter((token) => token.length >= 4)
    .some((captionToken) =>
      evidenceTokens.some((token) =>
        token.slice(0, 4) === captionToken.slice(0, 4)
      )
    );
}

function standaloneCodeIsEvidenced(value: string, evidence: string): boolean {
  const wanted = codeNorm(value);
  if (!wanted) return false;
  return (String(evidence ?? "").match(/[\p{L}\p{N}]+/gu) ?? [])
    .some((token) => codeNorm(token) === wanted);
}

function compactSingleCodes(value: string): string[] {
  return [
    ...new Set(
      (String(value ?? "").match(/[\p{L}\p{N}]+/gu) ?? [])
        .map(codeNorm)
        .filter((token) => token.length === 1 && /\p{L}/u.test(token)),
    ),
  ];
}

/**
 * Detect a portable technical code from live catalog evidence rather than a
 * product dictionary. The value must mix letters and digits, and the exact
 * canonical value must be visible both in the customer's request and in the
 * source card. Model/series facets are removed by the caller before this runs.
 */
function isExplicitPortableTechnicalCode(
  value: string,
  userMessage: string,
  productTitle: string,
): boolean {
  const compact = visualCodeNorm(value);
  return compact.length >= 2 && compact.length <= 24 &&
    /\p{L}/u.test(compact) && /\d/u.test(compact) &&
    portableTechnicalCodeMatchesText(value, userMessage) &&
    portableTechnicalCodeMatchesText(value, productTitle);
}

/**
 * Builds a compact search plan only from live anchor traits, live facet values,
 * and literals present in the customer's anchor description. No category or
 * product dictionaries are used. Identity facets never become analogue axes.
 */
export function selectExplicitAnchorAxes(
  product: ProductRef,
  facets: Facet[],
  userMessage: string,
  limit = 3,
): ExplicitReplacementAxis[] {
  const evidence = `${userMessage}\n${product.pagetitle}`;
  const axes: ExplicitReplacementAxis[] = [];
  for (const facet of facets) {
    if (isReplacementIdentityFacet(facet)) continue;
    const trait = traitEntries(product).find((entry) =>
      captionsMatch(entry.caption, facet.caption)
    );
    const traitCanonical = trait
      ? canonicalFacetValue(facet, trait.value)
      : null;
    const visibleCompactCanonical =
      captionIsEvidenced(facet.caption, userMessage)
        ? (facet.values ?? []).find((candidate) => {
          const codes = compactSingleCodes(candidate.value);
          return codes.some((code) =>
            standaloneCodeIsEvidenced(code, userMessage) &&
            standaloneCodeIsEvidenced(code, product.pagetitle)
          );
        })
        : null;
    const canonical = traitCanonical ??
      (visibleCompactCanonical
        ? {
          value: String(visibleCompactCanonical.value),
          total: Number(
            visibleCompactCanonical.products_count ?? Number.POSITIVE_INFINITY,
          ),
        }
        : null);
    if (!canonical) continue;
    const singleCodes = compactSingleCodes(canonical.value);
    const explicitValue = explicitInAnchorText(canonical.value, evidence) ||
      Boolean(
        singleCodes.length > 0 &&
          captionIsEvidenced(facet.caption, userMessage) &&
          singleCodes.some((code) =>
            standaloneCodeIsEvidenced(code, userMessage) &&
            standaloneCodeIsEvidenced(code, product.pagetitle)
          ),
      );
    if (!explicitValue) continue;
    // A bare binary number occurs in many unrelated technical and merchandising
    // facets. It becomes an analogue axis only when the customer also named
    // the facet meaning (for example, a pole-count caption), not merely because
    // another "1" happens to occur in the model title.
    const facetIsBinary = (facet.values ?? []).length > 0 &&
      (facet.values ?? []).every(({ value }) =>
        /^[01](?:[.,]0+)?$/u.test(String(value).trim())
      );
    if (facetIsBinary && !captionIsEvidenced(facet.caption, userMessage)) {
      continue;
    }
    const mandatory = isExplicitPortableTechnicalCode(
      canonical.value,
      userMessage,
      product.pagetitle,
    );
    axes.push({
      key: facet.key,
      caption: facet.caption,
      value: canonical.value,
      total: canonical.total,
      ...(mandatory ? { mandatory: true as const } : {}),
    });
  }
  return axes
    .sort((left, right) =>
      Number(Boolean(right.mandatory)) - Number(Boolean(left.mandatory)) ||
      left.total - right.total ||
      left.caption.localeCompare(right.caption, "ru")
    )
    .slice(0, Math.max(2, limit));
}

export function productContainsSourceModel(
  product: Pick<ProductRef, "pagetitle">,
  modelCodes: string[],
): boolean {
  const title = codeNorm(product.pagetitle);
  return modelCodes.some((code) => {
    const needle = codeNorm(code);
    return needle.length >= 4 && title.includes(needle);
  });
}

/** Exact-item inquiry must not silently substitute a sibling kit or revision.
 * The broader source-family matcher above remains unchanged for analogues. */
export function productContainsExactModelCode(
  product: Pick<ProductRef, "pagetitle">,
  code: string,
): boolean {
  const parts = String(code).match(/[\p{L}\p{N}]+/gu) ?? [];
  if (codeNorm(code).length < 4 || !parts.length) return false;
  const escaped = parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  const exact = new RegExp(
    `(?:^|[^\\p{L}\\p{N}])${escaped.join("[\\s._/–—−-]+")}(?![\\p{L}\\p{N}._/+–—−-])`,
    "iu",
  );
  const match = exact.exec(product.pagetitle);
  if (!match) return false;
  const prefix = product.pagetitle.slice(0, match.index);
  if (/(?:аналог|замен\p{L}*|совместим\p{L}*|подход\p{L}*\s+для|для\s+модел\p{L}*)[^,.()]{0,100}$/iu.test(prefix)) {
    return false;
  }
  const priorCodes = prefix.match(/[\p{L}\p{N}._/–—−+-]{4,}/gu) ?? [];
  return !priorCodes.some((token) => /\p{L}/u.test(token) && /\d/u.test(token));
}
