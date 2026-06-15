// c5-broad-clarify.ts
//
// LLM-helper для underspecified-broad запросов (см. c5-broad-detector.ts).
// Формулирует ОДИН точечный уточняющий вопрос про ключевой физический параметр,
// который позволит сузить выбор до осмысленной выборки.
//
// Контракт: модуль НЕ бросает наружу. При любой ошибке LLM/сети/таймауте
// возвращает пустой результат — вызывающий код продолжает по обычному пути
// (например, обычный поиск).

const CLARIFY_MODEL = "anthropic/claude-sonnet-4.5";
const CLARIFY_TIMEOUT_MS = 6_000;

const SYSTEM_PROMPT = `Ты — эксперт-консультант казахстанского интернет-магазина электротоваров 220volt.kz.

Клиент описал товар. Тебе нужно решить: уже-достаточно-конкретно для точного поиска, или ассортимент по этим параметрам остаётся слишком широким и нужен ОДИН уточняющий вопрос про ключевой физический параметр (площадь, мощность, длина, ток, диаметр, назначение, тип монтажа и т.п.)?

ПРАВИЛО ПУСТОГО ВОПРОСА (важно): если запрос УЖЕ содержит достаточно параметров для осмысленной выборки (конкретная модель/маркировка/артикул, или хотя бы 2-3 чётких технических параметра, или явно узкая подкатегория) — верни question="" (пустую строку). Это сигнал что уточнение НЕ нужно, и система продолжит обычным поиском. НЕ задавай вопрос «на всякий случай».

Если уточнение действительно нужно — задай ОДИН короткий вопрос (1 предложение, ≤ 20 слов, без приветствий, без извинений, без перечисления уже-сказанного) про ОДИН конкретный физический параметр, который наиболее сузит выборку для ИМЕННО ЭТОГО типа товара. Если уместно — добавь 2-4 коротких варианта ответа.

Запрещено:
- здороваться, благодарить, извиняться;
- задавать несколько вопросов сразу;
- спрашивать про бренд, цену или дизайн (это вторично);
- предлагать товары или ссылки.

Вызови tool ask_clarify.`;


const TOOL_SCHEMA = {
  type: "function" as const,
  function: {
    name: "ask_clarify",
    description: "Один уточняющий вопрос про ключевой физический параметр товара.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "Один короткий уточняющий вопрос (≤ 20 слов, 1 предложение, без приветствий).",
        },
        options: {
          type: "array",
          items: { type: "string" },
          minItems: 0,
          maxItems: 4,
          description: "Опционально: 2-4 коротких варианта ответа клиенту. Пустой массив если уточняющий параметр числовой.",
        },
      },
      required: ["question", "options"],
      additionalProperties: false,
    },
  },
};

const TOOL_CHOICE = {
  type: "function" as const,
  function: { name: "ask_clarify" },
};

export interface BroadClarifyInput {
  originalQuery: string;
  category: string | null;
  modifiers: string[];
  openrouterKey: string;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

export interface BroadClarifyResult {
  question: string;
  options: string[];
  llmOk: boolean;
  elapsedMs: number;
}

const EMPTY: BroadClarifyResult = { question: "", options: [], llmOk: false, elapsedMs: 0 };

export async function askBroadClarify(input: BroadClarifyInput): Promise<BroadClarifyResult> {
  const log = input.log ?? (() => {});
  const query = (input.originalQuery ?? "").trim();
  if (query.length === 0 || query.length > 300) return EMPTY;
  if (!input.openrouterKey) {
    log("c5_clarify.no_key", {});
    return EMPTY;
  }

  const userMsg =
    `Запрос клиента: «${query}»\n` +
    `Тип товара: ${input.category ?? "(не назван)"}\n` +
    `Требования клиента: ${input.modifiers.length > 0 ? input.modifiers.join(", ") : "(нет)"}\n\n` +
    `Задай ОДИН уточняющий вопрос про ключевой физический параметр.`;

  const t0 = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CLARIFY_TIMEOUT_MS);
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${input.openrouterKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://chat-volt.testdevops.ru",
        "X-Title": "220volt-chat-consultant-c5-broad-clarify",
      },
      body: JSON.stringify({
        model: CLARIFY_MODEL,
        temperature: 0.2,
        max_tokens: 250,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMsg },
        ],
        tools: [TOOL_SCHEMA],
        tool_choice: TOOL_CHOICE,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const ms = Date.now() - t0;
    if (!response.ok) {
      log("c5_clarify.http_error", { status: response.status, ms });
      return { ...EMPTY, elapsedMs: ms };
    }
    // deno-lint-ignore no-explicit-any
    const data: any = await response.json();
    const toolCalls = data?.choices?.[0]?.message?.tool_calls;
    const argsRaw = toolCalls?.[0]?.function?.arguments;
    if (typeof argsRaw !== "string") {
      log("c5_clarify.bad_args", { ms });
      return { ...EMPTY, elapsedMs: ms };
    }
    const parsed = JSON.parse(argsRaw) as { question?: unknown; options?: unknown };
    const question = typeof parsed.question === "string" ? parsed.question.trim().slice(0, 250) : "";
    const rawOpts = Array.isArray(parsed.options) ? parsed.options : [];
    const options = rawOpts
      .filter((s): s is string => typeof s === "string")
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && s.length <= 60)
      .slice(0, 4);
    if (question.length === 0) {
      log("c5_clarify.empty_question", { ms });
      return { ...EMPTY, elapsedMs: ms };
    }
    log("c5_clarify.ok", { question, options, ms });
    return { question, options, llmOk: true, elapsedMs: ms };
  } catch (e) {
    const ms = Date.now() - t0;
    log("c5_clarify.error", { error: e instanceof Error ? e.message : String(e), ms });
    return { ...EMPTY, elapsedMs: ms };
  }
}
