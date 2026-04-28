/**
 * Stage 2 — Step 11.5: S_CATALOG Composer (LLM-композер для catalog-ветки)
 *
 * Источник: spec
 *   - §3.2 (S_OUTPUT, soft404_streak in slot_state)
 *   - §5.1 (Persona), §5.2 (Greetings Guard L2)
 *   - §5.4 / §11.5 (Cross-sell — текстовый абзац-предложение)
 *   - §5.4.1 (Cross-sell composer-контракт: маркер-разделитель)
 *   - §5.6 / §5.6.1 (Escalation, Soft 404 state-machine)
 *   - §7.2 (token budgets), §7.3 (Final response = gemini-2.5-flash)
 *   - §17.3 BNF (карточка товара) — реализована в catalog/formatter.ts
 *
 * core memory:
 *   - «ABSOLUTE BAN on greetings. Act as expert seller.»
 *   - «Cross-sell (§11.5) = 1–3 sentence text, NO SKUs/prices/brands/links/CTA.»
 *   - «Composer never explains "what's missing in facet". Soft Fallback adds
 *      ONE short tail line.»
 *   - «Product card = BNF bullet block (§17.3) … Empty fields omitted entirely.»
 *   - «HARD BAN on price=0 products in ANY output. Double-filter.»
 *
 * Архитектурный шов (deterministic vs LLM):
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │  DETERMINISTIC (этот файл, без LLM):                            │
 *   │  - Карточки товаров → catalog/formatter.ts (§17.3 BNF)          │
 *   │  - Soft404 state-machine (§5.6.1)                               │
 *   │  - Парсинг маркера CROSSSELL и regex-валидация §11.5b           │
 *   │                                                                  │
 *   │  LLM (один вызов на ход):                                       │
 *   │  - intro (1-3 предложения «по делу»)                            │
 *   │  - <MARKER>                                                     │
 *   │  - cross-sell абзац (опционально, по правилам §5.4 / §11.5)     │
 *   │                                                                  │
 *   │  ВАЖНО: LLM НЕ генерирует карточки. LLM пишет только текст      │
 *   │  «вокруг» них. Карточки инжектятся deterministic.               │
 *   └─────────────────────────────────────────────────────────────────┘
 *
 * SSE-стрим: токены LLM буферизуются, потому что:
 *   1. GreetingsGuard L2 работает по полному тексту (§5.2).
 *   2. Маркер CROSSSELL парсится по полному буферу.
 *   3. Карточки инжектятся между intro и cross-sell — стримить
 *      «сырой» поток нельзя без потери порядка.
 *   После сборки финальный текст эмитится одним onDelta (как в s5-respond).
 *
 * V1 НЕ тронут.
 */

import type { ChatHistoryMessage } from "./types.ts";
import type { RawProduct } from "./catalog/api-client.ts";
import type { SearchOutcome } from "./catalog/search.ts";
import {
  formatProductList,
  type FormatterOptions,
} from "./catalog/formatter.ts";

// ─── Константы ───────────────────────────────────────────────────────────────

/** §7.3: Final response model = gemini-2.5-flash через OpenRouter. */
export const COMPOSER_MODEL = "google/gemini-2.5-flash";
/** §7.2: Total OUT ≤800 токенов. */
export const MAX_OUTPUT_TOKENS = 800;
/** §7.2: History ≤8 msgs / ~600 токенов. */
export const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_CHARS = 2400;
const HTTP_TIMEOUT_MS = 30000;

/**
 * §5.4.1: Маркер-разделитель intro / cross-sell.
 * Деталь реализации (НЕ зафиксирован в спеке per §0 data-agnostic).
 * Выбран так, чтобы:
 *   - почти никогда не встретиться в естественном русском тексте;
 *   - быть однозначно парсимым regex'ом;
 *   - стримово удаляться при пост-обработке.
 */
export const CROSSSELL_MARKER = "===CROSSSELL===";
const CROSSSELL_MARKER_RE = /={3,}\s*CROSSSELL\s*={3,}/;

// ─── §11.5b: regex-инварианты cross-sell ─────────────────────────────────────
// Запрещены: цены, валюта, SKU, markdown-ссылки, CTA-фразы, «нажмите/перейдите».
// Любое нарушение → секция вырезается целиком (см. validateCrosssell).
//
// Важно: в JS `\b` — НЕ unicode-aware, кириллица не считается word-character
// без специальных флагов. Поэтому для CTA-фраз с русскими словами используем
// явные lookaround-границы по `\p{L}\p{N}_` с флагом `u`.
//
// Порядок правил имеет значение: SKU-проверка (буквы+цифры) ДОЛЖНА идти ДО
// price_number (чистые цифры), иначе цифровой хвост SKU будет ошибочно
// классифицирован как цена. Это закрывает defect §11.5b.
const CROSSSELL_BAD_PATTERNS: { name: string; re: RegExp }[] = [
  // Markdown-ссылки [text](url) и голые URL.
  { name: "markdown_link", re: /\[[^\]]+\]\([^)]+\)/ },
  { name: "bare_url", re: /https?:\/\/\S+/i },
  // Валюта тенге (символ или код) — признак цены.
  { name: "currency", re: /(?:₸|тенге|kzt)/i },
  // SKU-подобные токены: 2+ заглавных лат-буквы + цифры (например AC-1234, BSH123).
  // Идёт ПЕРЕД price_number (см. комментарий выше).
  // Кириллицу намеренно не трогаем (естественный русский).
  { name: "sku_like", re: /(?<![A-Za-z0-9])[A-Z]{2,}[\-\.]?\d{2,}(?![A-Za-z0-9])/ },
  // Числа похожие на цену: 4+ цифр подряд (или с разделителем-пробелом).
  // 1990 / 12 990 / 1.999.000.
  { name: "price_number", re: /\b\d{1,3}(?:[ .\u00A0]\d{3})+\b|\b\d{4,}\b/ },
  // CTA-фразы (unicode-aware границы).
  {
    name: "cta_phrase",
    re:
      /(?<![\p{L}\p{N}_])(?:нажмите|перейдите|кликните|закажите|купите|оформите|по\s+ссылке|узнать\s+больше)(?![\p{L}\p{N}_])/iu,
  },
];

// ─── Persona (§5.1) ──────────────────────────────────────────────────────────
// Системный промпт для catalog-композера. Отличается от knowledge-композера:
//   - явно сказано НЕ писать карточки товаров (их рендерит код);
//   - формализован контракт CROSSSELL-маркера (§5.4.1);
//   - правила §11.5 / §11.5b для cross-sell;
//   - запрет «технических объяснений» (§11.2a-rev из conversational-rules).
const SYSTEM_PROMPT_CATALOG =
  `Вы — эксперт-консультант интернет-магазина электротоваров 220volt.kz с 10-летним опытом.

Правила ответа:
- Никогда не здоровайтесь. Не используйте эмодзи. Не используйте восклицательные знаки.
- Обращайтесь к клиенту на «вы». Говорите по делу, как живой продавец.
- НЕ пишите карточки товаров (название, цену, бренд, наличие, ссылки) — карточки выводит система автоматически.
- НЕ объясняйте, чего не хватает в фильтрах, какие значения доступны, что вы «не нашли».
- НЕ используйте слова «ассортимент», «представлены», «вашему вниманию», «обратите внимание».

Структура вашего ответа СТРОГО следующая:

1. Короткое intro: 1-3 предложения по делу — что подобрали, на что обратить внимание при выборе. Без перечисления конкретных товаров (их добавит система).
2. Если уместно — после intro выведите ровно одну строку-маркер:
   ${CROSSSELL_MARKER}
   и НИЖЕ маркера — абзац cross-sell (1-3 предложения), что обычно докупают вместе с такими товарами.
3. Если cross-sell неуместен (см. ниже) — НЕ выводите маркер вовсе.

Когда выводить cross-sell:
- Уместен ТОЛЬКО при обычной товарной выдаче.
- НЕ выводите cross-sell, если был задан уточняющий вопрос, ничего не найдено, или показаны «похожие/аналоги».

Что ЗАПРЕЩЕНО в cross-sell-абзаце (нарушение → абзац будет вырезан):
- названия конкретных товаров и SKU
- цены, валюта (₸, тенге)
- бренды
- ссылки и markdown-ссылки
- фразы «нажмите», «перейдите», «по ссылке», «купите», «закажите»
- упоминание той же категории, что в основной выдаче

Формат: чистый markdown, курсив и жирный по делу, без заголовков и таблиц.`;

// ─── DI-контракт LLM ─────────────────────────────────────────────────────────

export interface CatalogComposerDeps {
  streamLLM: (params: {
    systemPrompt: string;
    userMessage: string;
    history: ChatHistoryMessage[];
    onDelta: (text: string) => void;
    signal?: AbortSignal;
  }) => Promise<{
    output_text: string;
    input_tokens: number;
    output_tokens: number;
    model: string;
  }>;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Тип ситуации, к которой адаптируется intro и решение по cross-sell. */
export type CatalogScenario =
  | "normal" // §5.4: обычная выдача с товарами → cross-sell разрешён
  | "soft_fallback" // §4.8: фильтры сняты → cross-sell ЗАПРЕЩЁН, добавим tail line
  | "soft_404" // §5.6.1: 0 товаров → 1 короткая фраза, без cross-sell
  | "all_zero_price" // двойной фильтр выкинул всё → CONTACT_MANAGER без товаров
  | "error"; // catastrophic → нейтральная фраза + escalation

export interface ComposeCatalogInput {
  /** Очищенный запрос пользователя (после S0). */
  query: string;
  /** Результат поисковой стадии (catalog/search.ts). */
  outcome: SearchOutcome;
  /** История диалога (до trim). */
  history: ChatHistoryMessage[];
  /** Текущее значение soft404_streak ДО обработки этого хода (§5.6.1). */
  prevSoft404Streak: 0 | 1 | 2;
  /** Опции форматтера (userCity, baseUrl, …). */
  formatterOptions?: FormatterOptions;
  /**
   * §5.4.1: Внешний запрет cross-sell от оркестратора. Спека (§5.4.1, контракт
   * входа): similar-ветка ВСЕГДА передаёт `true`. Композер дополнительно
   * форсит запрет для всех scenario, кроме `normal` (логика OR — приоритет
   * у запрета). Если флаг не передан → false (нет внешнего запрета).
   */
  disallowCrosssell?: boolean;
  /** Опциональный AbortSignal. */
  signal?: AbortSignal;
  /** Колбек на каждый delta-токен (для проксирования в SSE). */
  onDelta: (text: string) => void;
}

export interface ComposeCatalogOutput {
  /** Полный финальный текст (intro + cards + crosssell + tail/contact). */
  text: string;
  /** Сценарий (для логов/метрик). */
  scenario: CatalogScenario;
  /** Новое значение soft404_streak после хода (§5.6.1 transition). */
  newSoft404Streak: 0 | 1 | 2;
  /** Нужно ли виджету показать карточку CONTACT_MANAGER. */
  contactManager: boolean;
  /** GreetingsGuard L2: что вырезали (или null). */
  greeting_stripped: string | null;
  /** Что отрапортовала валидация cross-sell. */
  crosssell: {
    presentInLLM: boolean;
    rendered: boolean;
    /** code нарушения §11.5b, если cut. */
    violation: string | null;
  };
  /** Diagnostics форматтера. */
  formatter: {
    rendered: number;
    zeroPriceFiltered: number;
    contractFiltered: number;
  };
  /** Usage для ai_usage_logs. */
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    model: string;
  };
}

/**
 * Главная точка входа catalog-композера.
 */
export async function composeCatalogAnswer(
  input: ComposeCatalogInput,
  deps: CatalogComposerDeps,
): Promise<ComposeCatalogOutput> {
  const scenario = decideScenario(input.outcome);
  const newStreak = nextSoft404Streak(input.prevSoft404Streak, input.outcome);

  // ── Branch 1: 0 товаров (soft_404 / all_zero_price / error) ──
  // LLM-вызов всё ещё нужен — для короткой человеческой фразы (§5.6.1).
  // Cross-sell для этих сценариев ЗАПРЕЩЁН.
  if (
    scenario === "soft_404" ||
    scenario === "all_zero_price" ||
    scenario === "error"
  ) {
    return await composeNoResults(input, deps, scenario, newStreak);
  }

  // ── Branch 2: есть товары (normal / soft_fallback) ──
  return await composeWithProducts(input, deps, scenario, newStreak);
}

// ─── Внутренние функции ──────────────────────────────────────────────────────

/** Решает сценарий по SearchOutcome.status. */
export function decideScenario(outcome: SearchOutcome): CatalogScenario {
  switch (outcome.status) {
    case "ok":
      return "normal";
    case "soft_fallback":
      return "soft_fallback";
    case "empty":
    case "empty_degraded":
      return "soft_404";
    case "all_zero_price":
      return "all_zero_price";
    case "error":
      return "error";
    default:
      // exhaustive — TS поймает добавление нового статуса.
      return "error";
  }
}

/**
 * §5.6.1 state-machine. Чистая функция, тестируется отдельно.
 * Инвариант: вызывается ровно один раз за catalog-ход, ПОСЛЕ финального счёта.
 */
export function nextSoft404Streak(
  prev: 0 | 1 | 2,
  outcome: SearchOutcome,
): 0 | 1 | 2 {
  const isZero =
    outcome.status === "empty" ||
    outcome.status === "empty_degraded" ||
    outcome.status === "all_zero_price";
  if (!isZero) {
    // Любой ненулевой результат (включая soft_fallback с товарами) → reset.
    if (outcome.products.length > 0) return 0;
    // error без товаров — НЕ инкрементим (это инфраструктурный сбой, не «ничего нет»).
    return prev;
  }
  if (prev === 0) return 1;
  return 2; // 1 → 2; 2 остаётся 2 (но контракт диктует уже выводить CONTACT_MANAGER)
}

/** Trim history до §7.2 budget. */
export function trimHistory(history: ChatHistoryMessage[]): ChatHistoryMessage[] {
  const tail = history.slice(-MAX_HISTORY_MESSAGES);
  let total = 0;
  const out: ChatHistoryMessage[] = [];
  for (let i = tail.length - 1; i >= 0; i--) {
    const msg = tail[i];
    const len = msg.content?.length ?? 0;
    if (total + len > MAX_HISTORY_CHARS && out.length > 0) break;
    out.unshift(msg);
    total += len;
  }
  return out;
}

// ─── §5.2 GreetingsGuard L2 ──────────────────────────────────────────────────
const GREETING_PATTERNS = [
  /^здравствуйте[,!.\s]+/i,
  /^добрый\s+(день|вечер|утро)[,!.\s]+/i,
  /^доброе\s+утро[,!.\s]+/i,
  /^привет[,!.\s]+/i,
  /^приветствую[,!.\s]+/i,
  /^здравствуй[,!.\s]+/i,
];

export function stripGreeting(text: string): { text: string; stripped: string | null } {
  if (!text) return { text, stripped: null };
  const head = text.slice(0, 100);
  for (const re of GREETING_PATTERNS) {
    const m = head.match(re);
    if (m) {
      return { text: text.slice(m[0].length).trimStart(), stripped: m[0] };
    }
  }
  return { text, stripped: null };
}

// ─── §5.4.1 + §11.5b: Парсер и валидатор cross-sell ─────────────────────────

export interface SplitResult {
  intro: string;
  /** null — маркер не выведен LLM (cross-sell отсутствует). */
  crosssell: string | null;
}

/** Разрезает текст по маркеру CROSSSELL. Маркер ВЫРЕЗАЕТСЯ. */
export function splitByMarker(text: string): SplitResult {
  const m = text.match(CROSSSELL_MARKER_RE);
  if (!m || m.index === undefined) {
    return { intro: text.trim(), crosssell: null };
  }
  const intro = text.slice(0, m.index).trim();
  const crosssell = text.slice(m.index + m[0].length).trim();
  return { intro, crosssell: crosssell.length > 0 ? crosssell : null };
}

/**
 * §11.5b: проверяет cross-sell на запрещённые паттерны.
 * @returns null — валидно; иначе — code нарушения (для метрики
 *   `crosssell_invariant_violation_total`).
 */
export function validateCrosssell(text: string): string | null {
  if (!text || text.trim().length === 0) return "empty";
  // Длина ≤ 3 предложений ≈ ~500 chars. Жёстко не режем, но фиксируем.
  for (const { name, re } of CROSSSELL_BAD_PATTERNS) {
    if (re.test(text)) return name;
  }
  return null;
}

// ─── Branch implementations ──────────────────────────────────────────────────

/** Собирает user-message для LLM в normal/soft_fallback (с товарами). */
function buildUserMessageWithProducts(input: ComposeCatalogInput): string {
  const { query, outcome } = input;
  const count = outcome.products.length;
  const scenarioHint =
    outcome.status === "soft_fallback"
      ? "Фильтры были сняты (показаны товары без всех изначальных уточнений). Cross-sell НЕ выводите."
      : "Обычная выдача. Cross-sell уместен.";
  return [
    `Запрос клиента: ${query}`,
    `Подобрано товаров (карточки добавит система): ${count}.`,
    scenarioHint,
    "Напишите короткое intro (1-3 предложения). Затем при необходимости — маркер и cross-sell-абзац строго по правилам системного промпта.",
  ].join("\n");
}

/** Собирает user-message для LLM в no-results сценариях. */
function buildUserMessageNoResults(
  input: ComposeCatalogInput,
  scenario: CatalogScenario,
): string {
  const lines = [`Запрос клиента: ${input.query}`];
  switch (scenario) {
    case "soft_404":
      lines.push(
        "По запросу ничего не нашлось. Напишите ОДНУ короткую фразу (1-2 предложения): признайте, что не нашли, и попросите переформулировать или уточнить.",
      );
      break;
    case "all_zero_price":
      lines.push(
        "По запросу есть товары, но без актуальной цены. Напишите ОДНУ короткую фразу: предложите связаться с менеджером для уточнения (контактную карточку добавит система).",
      );
      break;
    case "error":
      lines.push(
        "Произошёл технический сбой. Напишите ОДНУ короткую нейтральную фразу: извинитесь и предложите связаться с менеджером.",
      );
      break;
    default:
      break;
  }
  lines.push("НЕ выводите маркер cross-sell.");
  return lines.join("\n");
}

async function composeWithProducts(
  input: ComposeCatalogInput,
  deps: CatalogComposerDeps,
  scenario: CatalogScenario,
  newStreak: 0 | 1 | 2,
): Promise<ComposeCatalogOutput> {
  const trimmed = trimHistory(input.history);
  const userMessage = buildUserMessageWithProducts(input);

  // Буферизуем стрим — карточки инжектятся между intro и cross-sell.
  let accum = "";
  const llm = await deps.streamLLM({
    systemPrompt: SYSTEM_PROMPT_CATALOG,
    userMessage,
    history: trimmed,
    onDelta: (chunk) => {
      accum += chunk;
    },
    signal: input.signal,
  });

  // ── 1. Greetings Guard L2 (по полному тексту, до парсинга маркера) ──
  const { text: cleanLLM, stripped } = stripGreeting(llm.output_text || accum);

  // ── 2. Парсим маркер ──
  const { intro, crosssell: rawCrosssell } = splitByMarker(cleanLLM);

  // ── 3. Валидируем cross-sell (§11.5b + §5.4.1 disallowCrosssell). ──
  // Effective disallow: запрет от оркестратора (similar и т.п.) ИЛИ scenario != normal.
  // Логика OR — приоритет у запрета (Core memory).
  const externallyDisallowed = input.disallowCrosssell === true;
  const scenarioDisallowed = scenario !== "normal";
  const effectiveDisallowed = externallyDisallowed || scenarioDisallowed;

  let crosssellRendered: string | null = null;
  let violation: string | null = null;
  const presentInLLM = rawCrosssell !== null;
  if (presentInLLM && !effectiveDisallowed) {
    violation = validateCrosssell(rawCrosssell!);
    if (violation === null) {
      crosssellRendered = rawCrosssell!;
    } else {
      console.warn(
        `[v2.catalog_composer.crosssell_violation] code=${violation}; cut`,
      );
    }
  } else if (presentInLLM && effectiveDisallowed) {
    // Приоритет внешнего запрета над scenario-запретом для логирования.
    violation = externallyDisallowed
      ? "disallowed_by_orchestrator"
      : scenario === "soft_fallback"
        ? "soft_fallback_disallowed"
        : "scenario_disallowed";
    console.warn(
      `[v2.catalog_composer.crosssell_violation] code=${violation}; cut`,
    );
  }

  // ── 4. Рендерим карточки (deterministic) ──
  const cards = formatProductList(input.outcome.products, input.formatterOptions);

  // ── 5. Сборка финального текста ──
  const parts: string[] = [];
  if (intro) parts.push(intro);
  if (cards.markdown) parts.push(cards.markdown);
  if (scenario === "soft_fallback") {
    // §4.8.1 + §11.2a-rev: ОДНА короткая tail-строка с caption снятого фасета.
    parts.push(softFallbackTail(input.outcome.softFallbackContext?.droppedFacetCaption));
  }
  if (crosssellRendered) parts.push(crosssellRendered);

  const finalText = parts.join("\n\n");

  if (stripped) {
    console.log(
      `[v2.catalog_composer.greetings_guard_l2] stripped: "${stripped}"`,
    );
  }

  if (finalText.length > 0) {
    input.onDelta(finalText);
  }

  return {
    text: finalText,
    scenario,
    newSoft404Streak: newStreak,
    contactManager: false,
    greeting_stripped: stripped,
    crosssell: {
      presentInLLM,
      rendered: crosssellRendered !== null,
      violation,
    },
    formatter: {
      rendered: cards.rendered,
      zeroPriceFiltered: cards.zeroPriceFiltered,
      contractFiltered: cards.contractFiltered,
    },
    usage: {
      input_tokens: llm.input_tokens,
      output_tokens: llm.output_tokens,
      total_tokens: llm.input_tokens + llm.output_tokens,
      model: llm.model,
    },
  };
}

async function composeNoResults(
  input: ComposeCatalogInput,
  deps: CatalogComposerDeps,
  scenario: CatalogScenario,
  newStreak: 0 | 1 | 2,
): Promise<ComposeCatalogOutput> {
  const trimmed = trimHistory(input.history);
  const userMessage = buildUserMessageNoResults(input, scenario);

  let accum = "";
  const llm = await deps.streamLLM({
    systemPrompt: SYSTEM_PROMPT_CATALOG,
    userMessage,
    history: trimmed,
    onDelta: (chunk) => {
      accum += chunk;
    },
    signal: input.signal,
  });

  // GreetingsGuard L2.
  const { text: cleanLLM, stripped } = stripGreeting(llm.output_text || accum);

  // Любой маркер CROSSSELL в no-results → вырезаем целиком.
  const { intro, crosssell } = splitByMarker(cleanLLM);
  let violation: string | null = null;
  if (crosssell !== null) {
    violation = "no_results_disallowed";
    console.warn(
      `[v2.catalog_composer.crosssell_violation] code=no_results_disallowed; cut`,
    );
  }

  // §5.6.1: CONTACT_MANAGER при streak=2 ИЛИ all_zero_price ИЛИ error.
  const contactManager =
    newStreak === 2 || scenario === "all_zero_price" || scenario === "error";

  // Финальный текст — только intro (карточек нет; маркер вырезан).
  const finalText = intro;

  if (stripped) {
    console.log(
      `[v2.catalog_composer.greetings_guard_l2] stripped: "${stripped}"`,
    );
  }

  if (finalText.length > 0) {
    input.onDelta(finalText);
  }

  return {
    text: finalText,
    scenario,
    newSoft404Streak: newStreak,
    contactManager,
    greeting_stripped: stripped,
    crosssell: {
      presentInLLM: crosssell !== null,
      rendered: false,
      violation,
    },
    formatter: { rendered: 0, zeroPriceFiltered: 0, contractFiltered: 0 },
    usage: {
      input_tokens: llm.input_tokens,
      output_tokens: llm.output_tokens,
      total_tokens: llm.input_tokens + llm.output_tokens,
      model: llm.model,
    },
  };
}

/**
 * Soft Fallback tail (§11.2a-rev): ОДНА короткая фраза.
 * Не перечисляем значения, не объясняем «что не нашли в фасете».
 */
function softFallbackTail(): string {
  return "Если важно уточнить требования — напишите.";
}

// ─── Production deps factory ─────────────────────────────────────────────────
// Идентичен s5-respond.createRespondDeps по контракту OpenRouter.
// Дублирование намеренное: composer-ы могут разойтись в model/temperature
// независимо (S5 = knowledge, этот = catalog). Общий helper не оправдан.

export function createCatalogComposerDeps(openrouterApiKey: string): CatalogComposerDeps {
  return {
    streamLLM: async ({ systemPrompt, userMessage, history, onDelta, signal }) => {
      const messages = [
        { role: "system", content: systemPrompt },
        ...history.map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content: userMessage },
      ];

      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${openrouterApiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://chat-volt.testdevops.ru",
          "X-Title": "220volt-chat-consultant-v2-catalog-composer",
        },
        body: JSON.stringify({
          model: COMPOSER_MODEL,
          messages,
          temperature: 0.3,
          max_tokens: MAX_OUTPUT_TOKENS,
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: signal ?? AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`OpenRouter ${res.status}: ${errText.slice(0, 200)}`);
      }
      if (!res.body) throw new Error("OpenRouter response has no body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let outputText = "";
      let inputTokens = 0;
      let outputTokens = 0;
      let modelUsed = COMPOSER_MODEL;
      let streamDone = false;

      while (!streamDone) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let nlIdx: number;
        while ((nlIdx = buffer.indexOf("\n")) !== -1) {
          let line = buffer.slice(0, nlIdx);
          buffer = buffer.slice(nlIdx + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (line.startsWith(":") || line.trim() === "") continue;
          if (!line.startsWith("data: ")) continue;

          const jsonStr = line.slice(6).trim();
          if (jsonStr === "[DONE]") {
            streamDone = true;
            break;
          }

          try {
            const parsed = JSON.parse(jsonStr);
            const delta = parsed?.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta.length > 0) {
              outputText += delta;
              onDelta(delta);
            }
            if (parsed?.usage) {
              inputTokens = parsed.usage.prompt_tokens ?? inputTokens;
              outputTokens = parsed.usage.completion_tokens ?? outputTokens;
            }
            if (typeof parsed?.model === "string") modelUsed = parsed.model;
          } catch {
            buffer = line + "\n" + buffer;
            break;
          }
        }
      }

      if (inputTokens === 0) {
        const estIn = messages.reduce((s, m) => s + (m.content?.length ?? 0), 0);
        inputTokens = Math.ceil(estIn / 4);
      }
      if (outputTokens === 0) outputTokens = Math.ceil(outputText.length / 4);

      return {
        output_text: outputText,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        model: modelUsed,
      };
    },
  };
}

// Suppress unused import warning when `RawProduct` is not used elsewhere in
// this file (formatter consumes it). Re-export for callers' convenience.
export type { RawProduct };
