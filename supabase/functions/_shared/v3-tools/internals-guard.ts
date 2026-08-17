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
  "Не удалось подтвердить подходящие товары по данным каталога. " +
  "Уточните один ключевой параметр или бюджет — и я попробую подобрать точнее.";

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

export interface RedactResult {
  text: string;
  redacted: boolean;
  /** Какие признаки сработали — для логов. */
  matched: string[];
}

/**
 * Проверяет текст ассистента на служебную лексику. При срабатывании возвращает
 * нейтральную замену целиком (частичная чистка тут бессмысленна: утечка обычно
 * размазана по всему абзацу). Самокритичные ярлыки чистятся без подмены.
 */
export function redactInternals(text: string): RedactResult {
  const raw = text ?? "";
  if (!raw.trim()) return { text: raw, redacted: false, matched: [] };
  const n = norm(raw);
  const matched: string[] = [];
  for (const re of INTERNALS_PATTERNS) {
    if (re.test(n)) matched.push(re.source.slice(0, 40));
  }
  // Идентификаторы в бэктиках и snake_case-слова — структурный признак кода.
  if (/`[A-Za-z_][A-Za-z0-9_.\[\]]*`/.test(raw)) matched.push("backticked_identifier");
  if (/\b[a-z]{3,}_[a-z]{3,}(?:_[a-z]+)*\b/.test(raw)) matched.push("snake_case_identifier");

  if (matched.length > 0) {
    return { text: INTERNALS_REDACTED_TEXT, redacted: true, matched };
  }
  const withoutSelfFlagellation = raw.replace(SELF_FLAGELLATION_RE, "")
    .replace(/[ \t]{2,}/g, " ").trim();
  const cleaned = correctCustomerTextTypos(withoutSelfFlagellation);
  if (cleaned !== raw.trim()) {
    const softMatches: string[] = [];
    if (withoutSelfFlagellation !== raw.trim()) {
      softMatches.push("self_flagellation");
    }
    if (cleaned !== withoutSelfFlagellation) {
      softMatches.push("customer_text_typo:cash_receipt");
    }
    return { text: cleaned, redacted: false, matched: softMatches };
  }
  return { text: raw, redacted: false, matched: [] };
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
