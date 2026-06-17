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
}

export interface JargonFallbackResult {
  ok: boolean;
  candidates: string[];
  error?: string;
}

const SYSTEM = `Ты — лексический помощник. Пользователь ввёл термин, по которому каталог 220volt.kz ничего не нашёл. Предложи 1–3 альтернативных поисковых термина — синонимов, профессиональных названий, англоязычных аналогов или альтернативных написаний. НЕ объясняй. Используй ТОЛЬКО инструмент propose_candidates.`;

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
    const res = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deps.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek/deepseek-chat-v3.1:free",
        temperature: 0.3,
        max_tokens: 200,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: `Запрос: «${query}». Предложи альтернативные термины.` },
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
