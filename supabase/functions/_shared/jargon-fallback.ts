// jargon-fallback.ts
//
// Назначение: когда поиск по каталогу 220volt.kz вернул 0 товаров, а пользователь
// явно ищет товар (intent='catalog'), мы НЕ сразу падаем в Soft 404.
// Сначала спрашиваем у Claude Sonnet 4.5: «может это бытовое/жаргонное название?»
// (кукуруза = corn lamp / лампа-початок, груша = A60, морковка = сверло Морзе и т.п.).
//
// LLM возвращает структурированно через tool calling:
//   { alternatives: string[1..3], clarifyQuestion: string }
//
// Дальше мы:
//   1. По очереди ищем каждую alternative через переданный searchFn (= searchProductsByCandidate).
//   2. Первый непустой результат → возвращаем его + matchedAlternative (для логов).
//   3. Если все 0 → возвращаем clarifyQuestion для подстановки в Soft-404 промпт.
//
// ВАЖНО: модуль НЕ бросает исключений наружу. При любой ошибке LLM/сети возвращает
// пустой результат — вызывающий код продолжает по обычному Soft-404 пути.

const JARGON_MODEL = "anthropic/claude-sonnet-4.5";
const JARGON_TIMEOUT_MS = 8_000;
const MAX_ALTERNATIVES = 3;

const SYSTEM_PROMPT = `Ты — эксперт по электротоварам казахстанского интернет-магазина 220volt.kz (лампы, светильники, провода, выключатели, розетки, инструменты, крепёж, автоматика, бытовая электротехника).

Клиент ввёл запрос, по которому в каталоге НЕ нашлось ни одного товара. Возможные причины:
1. Бытовое/жаргонное название («кукуруза» = corn lamp / лампа-початок, «груша» = A60, «морковка» = сверло Морзе, «улитка» = центробежный вентилятор, «таблетка» = downlight и т.д.).
2. Транслитерация / заимствование с английского (corn lamp, downlight, smd, cob).
3. Описательное название по форме/назначению вместо технического термина.
4. Опечатка или редкий региональный термин.

Твоя задача — предложить 1-3 АЛЬТЕРНАТИВНЫХ поисковых запроса (технические/каталожные термины), которыми этот товар может быть назван в каталоге электротоваров. Если запрос явно НЕ про электротовары (еда, одежда, транспорт) — верни пустой массив alternatives и в clarifyQuestion вежливо уточни, что именно ищет клиент.

Также сформулируй ОДИН короткий уточняющий вопрос (1 предложение, без приветствий, без извинений) на случай, если ни одна альтернатива не сработает.

Вызови tool suggest_alternatives.`;

const TOOL_SCHEMA = {
  type: "function" as const,
  function: {
    name: "suggest_alternatives",
    description: "Предлагает альтернативные поисковые запросы и уточняющий вопрос.",
    parameters: {
      type: "object",
      properties: {
        alternatives: {
          type: "array",
          items: { type: "string" },
          minItems: 0,
          maxItems: MAX_ALTERNATIVES,
          description: "1-3 альтернативных поисковых запроса (технические термины каталога). Пустой массив если запрос не про электротовары.",
        },
        clarifyQuestion: {
          type: "string",
          description: "Один короткий уточняющий вопрос клиенту (1 предложение, без приветствий).",
        },
      },
      required: ["alternatives", "clarifyQuestion"],
      additionalProperties: false,
    },
  },
};

const TOOL_CHOICE = {
  type: "function" as const,
  function: { name: "suggest_alternatives" },
};

export interface JargonFallbackInput {
  originalQuery: string;
  openrouterKey: string;
  /** Функция поиска товаров — обычно searchProductsByCandidate из chat-consultant. */
  // deno-lint-ignore no-explicit-any
  searchFn: (alternativeQuery: string) => Promise<any[]>;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

export interface JargonFallbackResult {
  /** Найденные товары по одной из alternatives. Пусто если все попытки = 0. */
  // deno-lint-ignore no-explicit-any
  products: any[];
  /** Какая именно альтернатива сработала (для логов). */
  matchedAlternative: string | null;
  /** Все альтернативы которые предложила LLM (для логов). */
  alternatives: string[];
  /** Уточняющий вопрос для Soft-404 (если ничего не нашлось). */
  clarifyQuestion: string;
  /** true если LLM вообще вызвалась успешно (для метрик). */
  llmOk: boolean;
}

const EMPTY_RESULT: JargonFallbackResult = {
  products: [],
  matchedAlternative: null,
  alternatives: [],
  clarifyQuestion: "",
  llmOk: false,
};

export async function tryJargonFallback(input: JargonFallbackInput): Promise<JargonFallbackResult> {
  const log = input.log ?? (() => {});
  const query = (input.originalQuery ?? "").trim();
  if (query.length === 0 || query.length > 200) {
    return EMPTY_RESULT;
  }
  if (!input.openrouterKey) {
    log("jargon.no_key", {});
    return EMPTY_RESULT;
  }

  // 1. Запрос к Claude
  let parsed: { alternatives?: unknown; clarifyQuestion?: unknown } | null = null;
  const t0 = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), JARGON_TIMEOUT_MS);
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${input.openrouterKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://chat-volt.testdevops.ru",
        "X-Title": "220volt-chat-consultant-jargon-fallback",
      },
      body: JSON.stringify({
        model: JARGON_MODEL,
        temperature: 0.3,
        max_tokens: 300,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Запрос клиента: «${query}»\n\nПредложи альтернативные поисковые термины и уточняющий вопрос.` },
        ],
        tools: [TOOL_SCHEMA],
        tool_choice: TOOL_CHOICE,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) {
      log("jargon.http_error", { status: response.status, ms: Date.now() - t0 });
      return EMPTY_RESULT;
    }
    // deno-lint-ignore no-explicit-any
    const data: any = await response.json();
    const toolCalls = data?.choices?.[0]?.message?.tool_calls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
      log("jargon.no_tool_calls", { ms: Date.now() - t0 });
      return EMPTY_RESULT;
    }
    const argsRaw = toolCalls[0]?.function?.arguments;
    if (typeof argsRaw !== "string") {
      log("jargon.bad_args", {});
      return EMPTY_RESULT;
    }
    parsed = JSON.parse(argsRaw);
  } catch (e) {
    log("jargon.llm_error", { error: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 });
    return EMPTY_RESULT;
  }

  const rawAlts = Array.isArray(parsed?.alternatives) ? parsed!.alternatives as unknown[] : [];
  const alternatives = rawAlts
    .filter((s): s is string => typeof s === "string")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 100 && s.toLowerCase() !== query.toLowerCase())
    .slice(0, MAX_ALTERNATIVES);
  const clarifyQuestion = typeof parsed?.clarifyQuestion === "string"
    ? parsed!.clarifyQuestion.trim().slice(0, 250)
    : "";

  log("jargon.llm_ok", { alternatives, clarifyQuestion, ms: Date.now() - t0 });

  // 2. Ретрай поиска по каждой альтернативе
  for (const alt of alternatives) {
    try {
      const products = await input.searchFn(alt);
      if (Array.isArray(products) && products.length > 0) {
        log("jargon.match", { alternative: alt, count: products.length });
        return {
          products,
          matchedAlternative: alt,
          alternatives,
          clarifyQuestion,
          llmOk: true,
        };
      }
    } catch (e) {
      log("jargon.search_error", { alternative: alt, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // 3. Все альтернативы пустые → возвращаем clarifyQuestion
  log("jargon.all_empty", { alternatives });
  return {
    products: [],
    matchedAlternative: null,
    alternatives,
    clarifyQuestion,
    llmOk: true,
  };
}
