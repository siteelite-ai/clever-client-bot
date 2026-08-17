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
  "Внутреннюю механику подбора я не раскрываю. Давайте сделаю точнее: уточните нужные параметры или бюджет — и я подберу варианты.";

function norm(s: string): string {
  return (s || "").toLowerCase().replace(/ё/g, "е");
}

/**
 * Служебная лексика механики/архитектуры. Регэкспы, а не подстроки: важны
 * границы слов, чтобы «опции товара» не путать с параметром `options`.
 */
const INTERNALS_PATTERNS: RegExp[] = [
  /\bфасет\w*/u,
  /\bfulltext\b|\bфултекст\w*/u,
  /function[\s-]?calling|tool[\s_-]?call\w*|вызов\w*\s+инструмент\w*/u,
  /\bэндпоинт\w*|\bendpoint\w*/u,
  /систем\w+\s+промпт\w*|\bпромпт\w*\b/u,
  /json[\s-]?schema|\bjson-схем\w*/u,
  /\bfts\b|вектор\w+\s+поиск\w*|гибридн\w+\s+поиск\w*/u,
  /\bllm\b|языков\w+\s+модел\w*|нейросет\w*/u,
  /\bопенроутер\w*|openrouter|deepseek|\bgpt-?\d|\bgpt-4\w*|\bclaude\b|\bsonnet\b|\bopus\b|\bqwen\b|\bllama\b|\bgemini\b|\bvllm\b/u,
  /\bрендер[\s-]?гейт\w*|render[\s_-]?gate\w*/u,
  /\bshort_traits\b|\bpagetitle\b|\bby_query\b|\bby_filter\b|\bby_article\b|\bby_pagetitle\b|\bcategory_in\b|\bper_page\b|\bmin_price\b|\bmax_price\b|\bcriteria\b|\bproduct_ids\b|\bunmatched_tokens\b|\bpartial_match\b|\bleaf_categories\b/u,
  /\bsearch_catalog\b|\bdiscover_category\b|\bjargon_recover_catalog\b|\brender_products\b|\blookup_knowledge\b|\blookup_contacts\b|\bpropose_clarification\b|\bescalate_to_manager\b|\bnote_state\b/u,
  /\bинвариант\w*/u,
  /\bоркестратор\w*|\bпайплайн\w*|\bpipeline\b/u,
  /\bапи[\s-]?инструмент\w*|\bапи-эндпоинт\w*/u,
  /умею\s+искать\s+только|не\s+чита\w+\s+(?:полнотекст\w*|текстов\w*\s+)?описани\w*/u,
  /\bтехническое\s+задание\b|\bтз\s+(?:по|на)\b/u,
];

/**
 * Самоуничижительные ярлыки — не служебная утечка, но и не тон продавца.
 * Вырезаются точечно, весь текст из-за них не подменяется.
 */
const SELF_FLAGELLATION_RE =
  /\b(?:облажал\w*|косяк\s+мой|мой\s+косяк|погорячил\w*|стопорнул\w*|тк?нули\s+носом|исправлюсь)\b[\s,.!—-]*/giu;

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
  const cleaned = raw.replace(SELF_FLAGELLATION_RE, "").replace(/[ \t]{2,}/g, " ").trim();
  if (cleaned !== raw.trim()) {
    return { text: cleaned, redacted: false, matched: ["self_flagellation"] };
  }
  return { text: raw, redacted: false, matched: [] };
}

/** Признаки того, что реплика всё-таки про товар/магазин, а не про устройство бота. */
const COMMERCE_SIGNAL_RE =
  /\b(?:подбер\w*|найд\w*|нужен|нужна|нужно|купить|цена|стоит|стоимость|наличи\w*|доставк\w*|оплат\w*|гаранти\w*|аналог\w*|замен\w*|артикул\w*|склад\w*|бюджет\w*)\b|\d/u;

/** Маркеры вопроса про устройство ассистента / просьбы выдать спецификацию. */
const META_PATTERNS: RegExp[] = [
  /на\s+(?:как\w+|чем)\s+(?:платформ\w*|модел\w*|стек\w*|движк\w*|технолог\w*)/u,
  /(?:как|что)\s+(?:ты|вы)\s+(?:устроен\w*|работа\w+|написан\w*|сделан\w*|ищ\w+\s+внутри)/u,
  /(?:ты|вы)\s+(?:на\s+)?(?:какой|чем)\s+модел\w*/u,
  /\bчто\s+(?:за|у\s+теб\w+)\s+(?:модел\w*|нейросет\w*|движок|стек\w*)/u,
  /расскажи\w*\s+(?:технич\w*|про\s+сво\w+\s+(?:устройств\w*|архитектур\w*))/u,
  /\bархитектур\w*\s+(?:тво\w+|ваш\w+|систем\w+)|тво\w+\s+архитектур\w*/u,
  /систем\w+\s+промпт\w*|покажи\w*\s+промпт\w*|тво\w+\s+инструкц\w*|тво\w+\s+правил\w*\s+работы/u,
  /(?:напиши|составь|сдела\w+|дай)\w*\s+(?:мне\s+)?(?:чётк\w+\s+|четк\w+\s+|подробн\w+\s+)?тз\b/u,
  /техническое\s+задание/u,
  /(?:так\s*же|такого\s+же|похож\w+)\s+(?:как\s+ты|бот\w*|консультант\w*)\s+(?:для\s+)?сво\w+\s+(?:магазин\w*|сайт\w*|проект\w*)/u,
  /\bкакие\s+(?:у\s+теб\w+\s+)?(?:инструмент\w*|тул\w*|api|апи)\b/u,
  /\bты\s+(?:чат\s*)?(?:gpt|гпт|клод|claude|deepseek|дипсик)\b/u,
  /\bкто\s+теб\w+\s+(?:написал|сделал|разработал)\b/u,
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
