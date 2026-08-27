// V3 helper: tryJargonFallback
//
// Когда основной запрос вернул 0 — Claude Sonnet 4.5 предлагает 1-3
// альтернативных канонических термина (например «лампа кукуруза» → corn lamp).
// Tool calling без свободного текста. Data-agnostic: никаких whitelist'ов.

interface JargonFallbackDeps {
  apiKey: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Активная категория каталога (например «Лампы»). Помогает помощнику давать релевантные кандидаты. */
  category?: string;
  /** A stricter retry that asks only for short literal title tokens. */
  strategy?: "broad" | "title_token" | "translation_only";
}

export interface JargonFallbackResult {
  ok: boolean;
  candidates: string[];
  error?: string;
}

const SYSTEM = `Ты — лексический помощник. Пользователь ввёл термин, по которому каталог 220volt.kz ничего не нашёл. Предложи 1–3 альтернативных поисковых термина — синонимов, профессиональных названий, англоязычных аналогов или альтернативных написаний. НЕ объясняй. Используй ТОЛЬКО инструмент propose_candidates.`;

const TITLE_TOKEN_SYSTEM = `Ты — лексический помощник для буквального поиска по названиям товаров. Верни 1–3 коротких отличительных кандидата длиной 1–2 слова, которые выражают ТОТ ЖЕ лексический термин и могут буквально встречаться в названии карточки. Для разговорного или жаргонного слова обязательно рассмотри прямой перевод на английский, транслитерацию и общепринятое профессиональное обозначение. Запрещены ассоциации по назначению, внешнему контексту, материалу или области применения; не подменяй термин гиперонимом или похожим товаром. Не добавляй характеристики, которых нет в запросе, не возвращай одно только общее название категории, не объясняй. Используй ТОЛЬКО инструмент propose_candidates.`;

const TRANSLATION_ONLY_SYSTEM = `Ты — буквальный переводчик поискового слова. Выдели разговорное, жаргонное или необычное слово клиента и верни 1–3 варианта: его прямой перевод на английский, транслитерацию и вариант написания латиницей. Переводи именно слово, а не назначение товара; запрещены ассоциации, гиперонимы, похожие товары и добавление характеристик. Каждый кандидат — максимум 2 слова. НЕ объясняй. Используй ТОЛЬКО инструмент propose_candidates.`;

const TOOL = {
  type: "function",
  function: {
    name: "propose_candidates",
    description: "Предложить 1-3 альтернативных поисковых термина",
    parameters: {
      type: "object",
      properties: {
        candidates: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 3,
        },
      },
      required: ["candidates"],
      additionalProperties: false,
    },
  },
};

export async function tryJargonFallback(
  query: string,
  deps: JargonFallbackDeps,
): Promise<JargonFallbackResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 8000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = deps.signal
    ? AbortSignal.any([deps.signal, controller.signal])
    : controller.signal;

  try {
    const deterministicMode = deps.strategy === "title_token" || deps.strategy === "translation_only";
    const system = deps.strategy === "translation_only"
      ? TRANSLATION_ONLY_SYSTEM
      : deps.strategy === "title_token"
      ? TITLE_TOKEN_SYSTEM
      : SYSTEM;
    const userContent = deps.strategy === "translation_only"
      ? deps.category
        ? `Категория каталога: «${deps.category}» — это только граница безопасности, а не подсказка для замены слова названием типа товара. Не повторяй категорию и не добавляй свойства товара. Запрос клиента: «${query}». Верни прямой перевод, транслитерацию или латинское написание именно необычного слова клиента; самый буквальный вариант поставь первым.`
        : `Запрос клиента: «${query}». Верни прямой перевод, транслитерацию или латинское написание именно необычного слова клиента; самый буквальный вариант поставь первым. Не заменяй его названием категории или похожего товара.`
      : deps.category
      ? `Категория каталога: «${deps.category}». Запрос клиента: «${query}». Предложи 1–3 канонических термина ИМЕННО В КОНТЕКСТЕ этой категории (форма/тип/подтип товара внутри категории). Кандидаты, не относящиеся к этой категории, НЕ предлагай.`
      : `Запрос: «${query}». Предложи альтернативные термины.`;
    const res = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deps.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        temperature: deterministicMode ? 0 : 0.3,
        max_tokens: 200,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userContent },
        ],
        tools: [TOOL],
        tool_choice: { type: "function", function: { name: "propose_candidates" } },
      }),
      signal,
    });

    if (!res.ok) {
      await res.body?.cancel();
      return { ok: false, candidates: [], error: `LLM ${res.status}` };
    }
    const data = await res.json() as {
      choices?: Array<{ message?: { tool_calls?: Array<{ function?: { arguments?: string } }> } }>;
    };
    const argsStr = data?.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    if (!argsStr) return { ok: false, candidates: [], error: "no_tool_call" };
    const parsed = JSON.parse(argsStr) as { candidates?: unknown };
    const candidates = Array.isArray(parsed.candidates)
      ? parsed.candidates.filter((c): c is string => typeof c === "string" && c.trim().length > 0).map((c) => c.trim()).slice(0, 3)
      : [];
    return { ok: candidates.length > 0, candidates };
  } catch (e) {
    return { ok: false, candidates: [], error: (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
