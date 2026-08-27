// V3 guard: конфиденциальность внутреннего устройства ассистента.
//
// ЗАЧЕМ. Консультант — продавец магазина, а не разработчик системы. Клиенту
// нельзя раскрывать: устройство поиска (фасеты, fulltext, function calling,
// названия инструментов), архитектуру, стек, названия LLM/провайдеров,
// системный промпт, внутренние правила и «ТЗ, как сделать такого же».
// В логах реальных диалогов модель по просьбе клиента выдавала полную
// спецификацию системы — это утечка интеллектуальной собственности.
//
// ДВА СЛОЯ (промпт — это уговор, а не гарантия):
//   1) isMetaSelfQuestion(userMessage) — мета-вопрос про устройство сервиса
//      перехватывается ДО запуска цепочки инструментов; модель на такой ход
//      вообще не отвечает своими словами.
//   2) redactInternals(text) — страховка на текст ассистента: если служебная
//      лексика всё же просочилась, текст подменяется нейтральной фразой.
//
// DATA-AGNOSTIC: никаких брендов/категорий товаров — только служебный словарь
// механики и структурные признаки (идентификаторы, snake_case, бэктики).

/** Нейтральный ответ на мета-вопрос про устройство сервиса. */
export const META_DECLINE_TEXT =
  "Я консультант магазина — устройство сервиса и его внутреннюю механику не обсуждаю. " +
  "Зато с подбором помогу предметно: скажите, что нужно (тип товара, ключевые параметры или бюджет) — и подберу варианты.";

/** Нейтральная замена, когда служебная лексика просочилась в текст ответа. */
export const INTERNALS_REDACTED_TEXT =
  "Часть ответа содержала служебные сведения, поэтому я её скрыл. " +
  "Могу продолжить по существу: уточнить характеристики, цену или наличие нужного товара.";

function norm(s: string): string {
  return (s || "").toLowerCase().replace(/ё/g, "е");
}

/**
 * Служебная лексика механики/архитектуры. Регэкспы, а не подстроки: важны
 * границы слов, чтобы «опции товара» не путать с параметром `options`.
 */
const INTERNALS_PATTERNS: RegExp[] = [
  /(?<![а-яa-z])фасет[а-я]*/u,
  /\bfulltext\b|(?<![а-яa-z])фултекст[а-я]*/u,
  /function[\s-]?calling|tool[\s_-]?call\w*|вызов\w*\s+инструмент\w*/u,
  /(?<![а-яa-z])эндпоинт[а-я]*|\bendpoint\w*/u,
  /систем[а-я]+\s+промпт[а-я]*|(?<![а-яa-z])промпт[а-я]*/u,
  /json[\s-]?schema|\bjson-схем\w*/u,
  /\bfts\b|вектор[а-я]+\s+поиск[а-я]*|гибридн[а-я]+\s+поиск[а-я]*/u,
  /\bllm\b|языков[а-я]+\s+модел[а-я]*|(?<![а-яa-z])нейросет[а-я]*/u,
  /(?<![а-яa-z])опенроутер[а-я]*|openrouter|deepseek|\bgpt-?\d|\bgpt-4\w*|\bclaude\b|\bsonnet\b|\bopus\b|\bqwen\b|\bllama\b|\bgemini\b|\bvllm\b/u,
  /(?<![а-яa-z])рендер[\s-]?гейт[а-я]*|render[\s_-]?gate\w*/u,
  /\bshort_traits\b|\bpagetitle\b|\bby_query\b|\bby_filter\b|\bby_article\b|\bby_pagetitle\b|\bcategory_in\b|\bper_page\b|\bmin_price\b|\bmax_price\b|\bcriteria\b|\bproduct_ids\b|\bunmatched_tokens\b|\bpartial_match\b|\bleaf_categories\b/u,
  /\bsearch_catalog\b|\bdiscover_category\b|\bjargon_recover_catalog\b|\brender_products\b|\blookup_knowledge\b|\blookup_contacts\b|\bpropose_clarification\b|\bescalate_to_manager\b|\bnote_state\b/u,
  /(?<![а-яa-z])инвариант[а-я]*/u,
  /(?<![а-яa-z])оркестратор[а-я]*|(?<![а-яa-z])пайплайн[а-я]*|\bpipeline\b/u,
  /(?<![а-яa-z])апи[\s-]?инструмент[а-я]*|(?<![а-яa-z])апи-эндпоинт[а-я]*/u,
  /умею\s+искать\s+только|не\s+чита[а-я]+\s+(?:полнотекст[а-я]*|текстов[а-я]*\s+)?описани[а-я]*/u,
  /техническое\s+задание|(?<![а-яa-z])тз\s+(?:по|на)(?![а-яa-z])/u,
];

/**
 * Самоуничижительные ярлыки — не служебная утечка, но и не тон продавца.
 * Вырезаются точечно, весь текст из-за них не подменяется.
 */
const SELF_FLAGELLATION_RE =
  /(?<![а-яa-z])(?:облажал[а-я]*|косяк\s+мой|мой\s+косяк|погорячил[а-я]*|стопорнул[а-я]*|тк?нули\s+носом|исправлюсь)(?![а-яa-z])[\s,.!—-]*/giu;

/** Точечная коррекция подтверждённой опечатки в клиентском ответе. */
const CASH_RECEIPT_TYPO_RE = /(?<![а-я])кассовые\s+челы(?![а-я])/giu;

function correctCustomerTextTypos(text: string): string {
  return text.replace(
    CASH_RECEIPT_TYPO_RE,
    (match) => /^[А-ЯЁ]/u.test(match) ? "Кассовые чеки" : "кассовые чеки",
  );
}

/**
 * A lone catalog term in otherwise useful shopping prose is a wording defect,
 * not an architecture disclosure. Rewrite it locally instead of discarding the
 * complete answer. If the same text also contains tool names, schema fields or
 * other internal markers, the ordinary hard redaction still applies.
 */
function rewriteCustomerFacingServiceTerms(text: string): string {
  const forms: Record<string, string> = {
    "фасет": "характеристика",
    "фасета": "характеристики",
    "фасеты": "характеристики",
    "фасетов": "характеристик",
    "фасету": "характеристике",
    "фасетам": "характеристикам",
    "фасетом": "характеристикой",
    "фасетами": "характеристиками",
    "фасете": "характеристике",
    "фасетах": "характеристиках",
  };
  const facetsRewritten = text.replace(/(?<![а-яa-z])фасет(?:а|ы|ов|у|ам|ом|ами|е|ах)?(?![а-яa-z])/giu, (match) => {
    const replacement = forms[match.toLocaleLowerCase("ru")] ?? "характеристика";
    return /^[А-ЯЁ]/u.test(match)
      ? replacement[0].toLocaleUpperCase("ru") + replacement.slice(1)
      : replacement;
  });
  return facetsRewritten.replace(
    /(?:пройдусь|пойду|проверю)?\s*(?:по|через)\s+лестниц\p{L}*\s+(?:жаргон\p{L}*|перевод\p{L}*)/giu,
    (match) => /^[А-ЯЁ]/u.test(match.trim()) ? "Проверю варианты написания" : "проверю варианты написания",
  );
}

export interface RedactResult {
  text: string;
  redacted: boolean;
  /** Какие признаки сработали — для логов. */
  matched: string[];
}

/**
 * Product facts must be emitted by the deterministic product-card renderer.
 * This detector is deliberately structural: it knows catalog-shaped facts,
 * not product names, categories, brands, or jargon.
 */
export function containsUnrenderedCatalogFacts(text: string): boolean {
  const raw = String(text ?? "");
  if (!raw.trim()) return false;
  return (
    /https?:\/\/(?:www\.)?220volt\.kz\/[^\s)]+/iu.test(raw) ||
    /\[[^\]]+\]\(https?:\/\/[^\s)]+\)/u.test(raw) ||
    /\d[\d\s.,]{0,}\s*(?:₸|тг(?:\.|\b)|тенге\b)/iu.test(raw) ||
    /(?:^|[\s*_-])(?:арт(?:икул)?\.?|наличие|цена)\s*:\s*\S/imu.test(raw) ||
    // Availability is also a catalog fact even when the model omits price,
    // article and URL. Questions/future intent such as «проверю, есть ли» do
    // not match because the assertion must begin with «в каталоге ...».
    /(?<![а-яa-z])в\s+каталог\p{L}*\s+(?:[^.!?\r\n]{0,80}\s+)?(?:есть|имеются|нет|долж\p{L}*\s+быть|нашл\p{L}*|представл\p{L}*|доступн\p{L}*|видн\p{L}*|отсутств\p{L}*|не\s+(?:знач\p{L}*|найд\p{L}*|вид\p{L}*)|проход\p{L}*\s+как|называ\p{L}*|относят\p{L}*)(?![а-яa-z])/iu.test(raw)
  );
}

export interface CatalogFactStripResult {
  text: string;
  removed: string[];
}

export const MISSING_ANCHOR_SAFE_INTRO =
  "Сначала проверю исходную модель в актуальном каталоге, чтобы не переносить в подбор неподтверждённые характеристики. " +
  "Если карточка не найдётся, покажу только товары подтверждённого класса и отдельно отмечу границы сравнения.";

const MISSING_ANCHOR_TASK_RE =
  /(?:аналог\p{L}*|альтернатив\p{L}*|замен\p{L}*|ищ(?:у|ем|ешь|ете)|нужн\p{L}*\s+найт\p{L}*|подобр\p{L}*)/iu;
const MISSING_ANCHOR_SPECULATION_RE =
  /(?:судя\s+по|скорее\s+всего|вероятн\p{L}*|предполож\p{L}*|похож\p{L}*\s+на|можно\s+вывест\p{L}*\s+из\s+код\p{L}*)/iu;

/**
 * Before the source card is found, no attribute or brand inferred from its
 * opaque identifier is evidence. Keep the useful, visible reasoning as a
 * deterministic verification plan instead of exposing model guesses that may
 * later be (correctly) ignored by the search contract.
 *
 * The caller activates this only for a confirmed missing-anchor replacement;
 * ordinary selections and replacements with a grounded source card retain the
 * consultant's own reasoning.
 */
export function replaceUngroundedMissingAnchorIntro(
  text: string,
  customerText = "",
): CatalogFactStripResult {
  const original = String(text ?? "").trim();
  if (!original) return { text: original, removed: [] };
  if (original === MISSING_ANCHOR_SAFE_INTRO) return { text: original, removed: [] };
  const sentences = original.match(/[^.!?]+(?:[.!?]+|$)/gu)
    ?.map((sentence) => sentence.trim())
    .filter(Boolean) ?? [];
  const taskCandidate = sentences
    .map((sentence) => ({
      original: sentence,
      // Keep the model-owned product-class interpretation, but cut an appended
      // source definition such as “— это релейный …” or “— тот же класс (…)”:
      // the absent card cannot prove that tail.
      grounded: sentence
        .replace(/\s+[—–-]\s+(?:это|тот\s+же\s+класс)(?!\p{L})[\s\S]*$/iu, ".")
        .replace(/\s+/gu, " ")
        .trim(),
    }))
    .find(({ grounded }) =>
      MISSING_ANCHOR_TASK_RE.test(grounded) &&
      !MISSING_ANCHOR_SPECULATION_RE.test(grounded)
    );
  const taskSentence = taskCandidate?.original;
  const groundedTask = taskCandidate?.grounded;

  // Preserve model-decoded parameter labels only when the explanatory clause
  // contains a number/code literally present in the customer's request. This
  // keeps useful mappings such as `C16` -> “16 А, характеристика C”, while an
  // unrequested mounting type or guessed phase count is discarded.
  const customerCompact = normalizeCompactCode(customerText);
  const customerNumbers = new Set(String(customerText ?? "").match(/\d+(?:[.,]\d+)?/gu) ?? []);
  const backedExplanations = [...String(taskSentence ?? "").matchAll(/\(([^()]{2,160})\)/gu)]
    .flatMap((match) => String(match[1] ?? "").split(/[,;]+/gu))
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => {
      const numbers = part.match(/\d+(?:[.,]\d+)?/gu) ?? [];
      if (numbers.some((value) => customerNumbers.has(value))) return true;
      const codes = part.match(/(?<!\p{L})([A-ZА-ЯЁ])(?!\p{L})/gu) ?? [];
      return codes.some((code) => customerCompact.includes(normalizeCompactCode(code)));
    });
  const backedReasoning = backedExplanations.length > 0
    ? ` Проверяю явно указанные параметры: ${backedExplanations.join(", ")}.`
    : "";
  const safeText = groundedTask
    ? `${groundedTask}${backedReasoning} ${MISSING_ANCHOR_SAFE_INTRO}`
    : MISSING_ANCHOR_SAFE_INTRO;
  if (safeText === original) return { text: original, removed: [] };
  return { text: safeText, removed: [original] };
}

/** The intro boundary follows what the customer has seen, not an agent step. */
export function shouldGuardFirstVisibleReasoning(input: {
  productsRendered: number;
  firstAssistantText: string;
  hasRenderCall: boolean;
}): boolean {
  return input.productsRendered === 0 && !String(input.firstAssistantText ?? "").trim() && !input.hasRenderCall;
}

/**
 * Preserve a grounded explanatory answer while removing whole paragraphs that
 * contain card-only facts such as prices, articles, availability or product
 * links. The previous all-or-nothing replacement hid valid explanations when
 * one price sentence slipped into an otherwise useful response.
 */
export function stripUnrenderedCatalogFactSegments(text: string): CatalogFactStripResult {
  const paragraphs = String(text ?? "")
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const kept: string[] = [];
  const removed: string[] = [];
  for (const paragraph of paragraphs) {
    if (!containsUnrenderedCatalogFacts(paragraph)) {
      kept.push(paragraph);
      continue;
    }
    // A useful intro and a premature catalog claim often share one paragraph.
    // Remove only the unsafe sentence so the customer's visible reasoning is
    // preserved instead of being replaced by silence.
    const sentences = paragraph.match(/[^.!?]+(?:[.!?]+|$)/gu)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [];
    const safeSentences: string[] = [];
    for (const sentence of sentences.length > 0 ? sentences : [paragraph]) {
      if (containsUnrenderedCatalogFacts(sentence)) removed.push(sentence);
      else safeSentences.push(sentence);
    }
    if (safeSentences.length > 0) kept.push(safeSentences.join(" "));
  }
  return { text: kept.join("\n\n"), removed };
}

const COMPACT_TECHNICAL_CODE_RE = /(?<![\p{L}\p{N}])(?=[\p{L}\p{N}.-]{2,18}(?![\p{L}\p{N}]))(?=[\p{L}\p{N}.-]*\p{L})(?=[\p{L}\p{N}.-]*\d)[\p{L}\p{N}][\p{L}\p{N}.-]{1,17}(?![\p{L}\p{N}])/gu;
const ALIAS_OR_GENERALIZATION_RE = /(?:\bэто\b|названи\p{L}*|обычно|как\s+правило|чаще\s+всего|проход\p{L}*\s+как)/iu;
const EXPLICIT_CRITERION_RE = /(?:нуж\p{L}*|треб\p{L}*|беру|закладыва\p{L}*|долж\p{L}*|не\s+(?:ниже|менее|выше|более))/iu;
const TECHNICAL_ATTRIBUTE_CODE_LIST_RE = /((?:,\s*)?(?:обычно\s+)?(?:с|на|под)\s+(?:[\p{L}-]{2,32}\s+){1,3})((?:[\p{L}]*\d[\p{L}\d.-]*)(?:\s*(?:,|\/|или)\s*(?:[\p{L}]*\d[\p{L}\d.-]*))*)/giu;
const UNGROUNDED_ALIAS_DEFINITION_RE = /(?:(?:(?:народн|разговорн|бытов|жаргонн|неофициальн)\p{L}*\s+)+(?:названи\p{L}*|обозначени\p{L}*|термин\p{L}*)|так\s+(?:в\s+народе\s+)?называ\p{L}*|(?:по\s+смыслу\s+)?это\s+чаще\s+всего|это\s+оно\s+и\s+есть|это\s+ближе\s+всего|ближе\s+всего\s+к|проход\p{L}*\s+как)/iu;
const ALIAS_GENERALIZATION_FOLLOWUP_RE = /^\s*(?:обычно|как\s+правило|чаще\s+всего)\s+(?:это|такие|они)(?!\p{L})/iu;

function normalizeCompactCode(value: string): string {
  return String(value ?? "").toLocaleLowerCase("ru-RU").replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * The first visible reasoning bubble may explain a customer-owned nickname,
 * but it must not attach arbitrary catalogue codes to that nickname. Codes the
 * customer actually typed are retained. Explicitly reasoned requirements are
 * also retained; only definitional/generalising claims are cleaned. This is a
 * structural evidence boundary and contains no product/category vocabulary.
 */
export function stripUngroundedIntroTechnicalAttributes(
  text: string,
  customerText: string,
): CatalogFactStripResult {
  const requestedCodes = new Set(
    (String(customerText ?? "").match(COMPACT_TECHNICAL_CODE_RE) ?? []).map(normalizeCompactCode),
  );
  const removed: string[] = [];
  const paragraphs = String(text ?? "").split(/\n\s*\n/u);
  const cleanedParagraphs = paragraphs.map((paragraph) => {
    const sentences = paragraph.match(/[^.!?]+(?:[.!?]+|$)/gu) ?? [paragraph];
    return sentences.map((sentence) => {
      if (!ALIAS_OR_GENERALIZATION_RE.test(sentence) || EXPLICIT_CRITERION_RE.test(sentence)) return sentence.trim();
      return sentence.replace(
        TECHNICAL_ATTRIBUTE_CODE_LIST_RE,
        (whole, prefix: string, codeList: string) => {
          const trailingPunctuation = codeList.match(/[.!?]+$/u)?.[0] ?? "";
          const codeBody = trailingPunctuation ? codeList.slice(0, -trailingPunctuation.length) : codeList;
          const codes = codeBody.match(COMPACT_TECHNICAL_CODE_RE) ?? [];
          const kept = codes.filter((code) => requestedCodes.has(normalizeCompactCode(code)));
          if (kept.length === codes.length) return whole;
          removed.push(String(whole).trim());
          if (kept.length === 0) return trailingPunctuation;
          return `${prefix}${kept.join(" или ")}${trailingPunctuation}`;
        },
      ).replace(/\s+,/gu, ",").replace(/[ \t]{2,}/gu, " ").trim();
    }).filter(Boolean).join(" ");
  }).map((paragraph) => paragraph.trim()).filter(Boolean);
  return { text: cleanedParagraphs.join("\n\n"), removed };
}

/**
 * Removes metalinguistic class substitutions from the first visible bubble.
 * A model may hypothesise that a customer's nickname is "usually" some other
 * class, but that relation is not evidence until live card titles prove it.
 * Explicit engineering criteria remain intact and continue to drive search.
 */
export function stripUngroundedIntroAliasDefinitions(
  text: string,
  customerText = "",
): CatalogFactStripResult {
  const removed: string[] = [];
  let aliasContext = false;
  const normalizedCustomer = norm(customerText).replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/gu, " ").trim();
  const paragraphs = String(text ?? "").split(/\n\s*\n/u);
  const cleaned = paragraphs.map((paragraph) => {
    const sentences = paragraph.match(/[^.!?]+(?:[.!?]+|$)/gu) ?? [paragraph];
    return sentences.map((sentence) => {
      const trimmed = sentence.trim();
      const quotedCustomerDefinition = [...trimmed.matchAll(/[«“"]([^»”"\r\n]{2,80})[»”"]/gu)].some((match) => {
        const phrase = norm(String(match[1] ?? "")).replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/gu, " ").trim();
        if (!phrase || !normalizedCustomer || !(` ${normalizedCustomer} `.includes(` ${phrase} `))) return false;
        const tail = trimmed.slice((match.index ?? 0) + match[0].length);
        return /^\s*[—–-]\s*это(?!\p{L})/iu.test(tail);
      });
      const directDefinition = quotedCustomerDefinition || UNGROUNDED_ALIAS_DEFINITION_RE.test(trimmed);
      const followupGeneralization = aliasContext && ALIAS_GENERALIZATION_FOLLOWUP_RE.test(trimmed);
      if ((directDefinition || followupGeneralization) && !EXPLICIT_CRITERION_RE.test(trimmed)) {
        removed.push(trimmed);
        aliasContext = true;
        return "";
      }
      return trimmed;
    }).filter(Boolean).join(" ");
  }).map((paragraph) => paragraph.trim()).filter(Boolean);
  return { text: cleaned.join("\n\n"), removed };
}

/**
 * Проверяет текст ассистента на служебную лексику. При срабатывании возвращает
 * нейтральную замену целиком (частичная чистка тут бессмысленна: утечка обычно
 * размазана по всему абзацу). Самокритичные ярлыки чистятся без подмены.
 */
export function redactInternals(text: string): RedactResult {
  const raw = text ?? "";
  if (!raw.trim()) return { text: raw, redacted: false, matched: [] };
  const customerFacing = rewriteCustomerFacingServiceTerms(raw);
  const n = norm(customerFacing);
  const matched: string[] = [];
  for (const re of INTERNALS_PATTERNS) {
    if (re.test(n)) matched.push(re.source.slice(0, 40));
  }
  // Идентификаторы в бэктиках и snake_case-слова — структурный признак кода.
  if (/`[A-Za-z_][A-Za-z0-9_.[\]]*`/.test(customerFacing)) matched.push("backticked_identifier");
  if (/\b[a-z]{3,}_[a-z]{3,}(?:_[a-z]+)*\b/.test(customerFacing)) matched.push("snake_case_identifier");

  if (matched.length > 0) {
    return { text: INTERNALS_REDACTED_TEXT, redacted: true, matched };
  }
  const withoutSelfFlagellation = customerFacing.replace(SELF_FLAGELLATION_RE, "")
    .replace(/[ \t]{2,}/g, " ").trim();
  const cleaned = correctCustomerTextTypos(withoutSelfFlagellation);
  if (cleaned !== raw.trim()) {
    const softMatches: string[] = [];
    if (withoutSelfFlagellation !== customerFacing.trim()) {
      softMatches.push("self_flagellation");
    }
    if (cleaned !== withoutSelfFlagellation) {
      softMatches.push("customer_text_typo:cash_receipt");
    }
    if (customerFacing !== raw) {
      softMatches.push("customer_term:facet");
    }
    return { text: cleaned, redacted: false, matched: softMatches };
  }
  return { text: raw, redacted: false, matched: [] };
}

/**
 * Keeps useful shopping reasoning while preventing internal tool names from
 * turning an intermediate bubble into a generic security fallback. Only tool
 * labels are rewritten; every other internal marker still triggers strict
 * suppression through redactInternals.
 */
export function sanitizeIntermediateReasoning(text: string): RedactResult & { suppressed: boolean } {
  const labels: Record<string, string> = {
    discover: "поиск категории",
    discover_category: "поиск категории",
    search_catalog: "поиск по каталогу",
    jargon_recover_catalog: "поиск по каталогу",
    render_products: "показ товаров",
  };
  const rewritten = String(text ?? "").replace(
    /\b(?:discover_category|discover|search_catalog|jargon_recover_catalog|render_products)\b/gu,
    (value) => labels[value] ?? "поиск по каталогу",
  );
  const guarded = redactInternals(rewritten);
  if (guarded.redacted) return { ...guarded, text: "", suppressed: true };
  return {
    ...guarded,
    text: guarded.text,
    suppressed: false,
    matched: rewritten === text ? guarded.matched : [...guarded.matched, "customer_term:tool_name"],
  };
}

/** Признаки того, что реплика всё-таки про товар/магазин, а не про устройство бота. */
const COMMERCE_SIGNAL_RE =
  /\b(?:подбер\w*|найд\w*|нужен|нужна|нужно|купить|цена|стоит|стоимость|наличи\w*|доставк\w*|оплат\w*|гаранти\w*|аналог\w*|замен\w*|артикул\w*|склад\w*|бюджет\w*)\b|\d/u;

/** Маркеры вопроса про устройство ассистента / просьбы выдать спецификацию. */
const META_PATTERNS: RegExp[] = [
  /(?:^|\s)на\s+чем(?![а-я])/u,
  /на\s+(?:как[а-я]+|чем)\s+(?:платформ[а-я]*|модел[а-я]*|стек[а-я]*|движк[а-я]*|технолог[а-я]*)/u,
  /(?:как|что)\s+(?:ты|вы)\s+(?:устроен[а-я]*|работа[а-я]+|написан[а-я]*|сделан[а-я]*|ищ[а-я]+\s+внутри)/u,
  /(?:ты|вы)\s+(?:на\s+)?(?:какой|чем)\s+модел[а-я]*/u,
  /что\s+(?:за|у\s+теб[а-я]+)\s+(?:модел[а-я]*|нейросет[а-я]*|движок|стек[а-я]*)/u,
  /расскажи[а-я]*\s+(?:технич[а-я]*|про\s+сво[а-я]+\s+(?:устройств[а-я]*|архитектур[а-я]*))/u,
  /технич[а-я]*\s+расскажи[а-я]*/u,
  /архитектур[а-я]*\s+(?:тво[а-я]+|ваш[а-я]+|систем[а-я]+)|тво[а-я]+\s+архитектур[а-я]*/u,
  /систем[а-я]+\s+промпт[а-я]*|покажи[а-я]*\s+промпт[а-я]*|тво[а-я]+\s+инструкц[а-я]*|тво[а-я]+\s+правил[а-я]*\s+работы/u,
  /(?:напиши|составь|сдела[а-я]+|дай)[а-я]*\s+(?:мне\s+)?(?:чётк[а-я]+\s+|четк[а-я]+\s+|подробн[а-я]+\s+)?тз(?![а-я])/u,
  /техническое\s+задание/u,
  /(?:так\s*же|такого\s+же|похож[а-я]+)\s+(?:как\s+ты|бот[а-я]*|консультант[а-я]*)?\s*(?:для\s+)?сво[а-я]+\s+(?:магазин[а-я]*|сайт[а-я]*|проект[а-я]*)/u,
  /какие\s+(?:у\s+теб[а-я]+\s+)?(?:инструмент[а-я]*|тул[а-я]*|api|апи)(?![а-я])/u,
  /ты\s+(?:чат\s*)?(?:gpt|гпт|клод|claude|deepseek|дипсик)(?![а-я])/u,
  /кто\s+теб[а-я]+\s+(?:написал|сделал|разработал)(?![а-я])/u,
];


/**
 * Мета-вопрос про устройство сервиса. При сомнении приоритет у обычного
 * подбора: если в реплике есть товарный/коммерческий сигнал — не глушим,
 * кроме явной просьбы выдать ТЗ/промпт/архитектуру.
 */
export function isMetaSelfQuestion(userMessage: string): boolean {
  const n = norm(userMessage || "");
  if (!n.trim()) return false;
  const hardAsk =
    /техническое\s+задание/u.test(n) ||
    /(?:напиши|составь|сдела\w+|дай)\w*\s+(?:мне\s+)?(?:чётк\w+\s+|четк\w+\s+|подробн\w+\s+)?тз\b/u.test(n) ||
    /систем\w+\s+промпт\w*|покажи\w*\s+промпт\w*/u.test(n) ||
    /на\s+(?:как\w+|чем)\s+(?:платформ\w*|модел\w*|стек\w*|движк\w*)/u.test(n);
  if (hardAsk) return true;
  const isMeta = META_PATTERNS.some((re) => re.test(n));
  if (!isMeta) return false;
  return !COMMERCE_SIGNAL_RE.test(n);
}
