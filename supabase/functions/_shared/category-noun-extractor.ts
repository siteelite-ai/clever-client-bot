// chat-consultant-v2 / category-noun-extractor.ts
// Stage 8 / §22.2 spec — Branch A (Query-First) extractor.
//
// Контракт:
//   Вход:  { userQuery: string, locale: 'ru' | 'kk' }
//   Выход: { categoryNoun: string, source: 'llm' | 'empty' | 'invalid', ms: number }
//
// Жёсткие правила (Core Memory + spec §22):
//   • OpenRouter (Gemini) only — никаких прямых Google/OpenAI вызовов.
//   • Data-agnostic: ни одного хардкода категорий 220volt в промпте.
//   • Post-validation regex `^[\p{L}]{2,30}$` — отбрасываем мусор LLM.
//   • Если в запросе нет товарной категории — возвращаем "" (Branch A пропускается).
//   • НЕ бросаем исключений наружу: при сбое LLM возвращаем "" с source='invalid'
//     (вызывающий код делает fallback на ?category=).

const EXTRACTOR_TIMEOUT_MS = 8_000;
const EXTRACTOR_MODEL_DEFAULT = "anthropic/claude-sonnet-4.5";
const NOUN_REGEX = /^[\p{L}]{2,30}$/u;

export type CategoryNounSource = "llm" | "empty" | "invalid";

export interface CategoryNounExtractionResult {
  /** Лемма-существительное (lowercase, им.п., ед.ч.) или "" если категория не определена. */
  categoryNoun: string;
  source: CategoryNounSource;
  ms: number;
  /** Сырой текст LLM до валидации (для логов/дебага). */
  rawLLMValue?: string;
}

export interface CategoryNounExtractorDeps {
  /**
   * Низкоуровневый LLM-вызов с tool calling. В проде → OpenRouter.
   * В тестах → mock. Возвращает извлечённый JSON-объект из tool_calls[0].function.arguments.
   */
  callLLMTool: (params: {
    systemPrompt: string;
    userMessage: string;
    // deno-lint-ignore no-explicit-any
    tool: any;
    // deno-lint-ignore no-explicit-any
    toolChoice: any;
  }) => Promise<unknown>;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

const SYSTEM_PROMPT = `Ты — лингвистический экстрактор. Твоя единственная задача — выделить из пользовательского запроса ОДНО существительное, обозначающее категорию товара.

Жёсткие правила:
1. ОДНО существительное. Не словосочетание.
2. Лемма: именительный падеж, единственное число, lowercase.
3. БЕЗ прилагательных, причастий, модификаторов, предлогов, числительных.
4. Если в запросе нет товарной категории (приветствие, вопрос, общая фраза) — верни пустую строку.
5. Если есть несколько существительных — выбери основное (то, что обозначает сам предмет, а не его свойство или назначение).

Вызови tool extract_category_noun с результатом.`;

const TOOL_SCHEMA = {
  type: "function" as const,
  function: {
    name: "extract_category_noun",
    description: "Извлекает одно существительное категории товара из пользовательского запроса.",
    parameters: {
      type: "object",
      properties: {
        category_noun: {
          type: "string",
          description: "Одно существительное в лемме (им.п., ед.ч., lowercase) или пустая строка",
        },
      },
      required: ["category_noun"],
      additionalProperties: false,
    },
  },
};

const TOOL_CHOICE = {
  type: "function" as const,
  function: { name: "extract_category_noun" },
};

export async function extractCategoryNoun(
  input: { userQuery: string; locale: "ru" | "kk" },
  deps: CategoryNounExtractorDeps,
): Promise<CategoryNounExtractionResult> {
  const t0 = Date.now();
  const log = deps.log ?? (() => {});
  const userQuery = (input.userQuery ?? "").trim();

  if (userQuery.length === 0) {
    return { categoryNoun: "", source: "empty", ms: Date.now() - t0 };
  }

  let raw: unknown;
  try {
    raw = await deps.callLLMTool({
      systemPrompt: SYSTEM_PROMPT,
      userMessage: `Запрос пользователя (${input.locale}): «${userQuery}»\n\nИзвлеки одно существительное категории товара.`,
      tool: TOOL_SCHEMA,
      toolChoice: TOOL_CHOICE,
    });
  } catch (e) {
    log("category_noun.llm_error", { error: e instanceof Error ? e.message : String(e) });
    return { categoryNoun: "", source: "invalid", ms: Date.now() - t0 };
  }

  // Парсим { category_noun: string }
  const candidate =
    raw && typeof raw === "object" && "category_noun" in raw
      ? String((raw as { category_noun: unknown }).category_noun ?? "").trim().toLowerCase()
      : "";

  if (candidate.length === 0) {
    log("category_noun.empty", { rawLLMValue: candidate });
    return { categoryNoun: "", source: "empty", ms: Date.now() - t0, rawLLMValue: candidate };
  }

  if (!NOUN_REGEX.test(candidate)) {
    log("category_noun.invalid", { rawLLMValue: candidate });
    return { categoryNoun: "", source: "invalid", ms: Date.now() - t0, rawLLMValue: candidate };
  }

  log("category_noun.ok", { categoryNoun: candidate, ms: Date.now() - t0 });
  return { categoryNoun: candidate, source: "llm", ms: Date.now() - t0, rawLLMValue: candidate };
}

// ─── Production deps factory (OpenRouter) ───────────────────────────────────

export function createProductionExtractorDeps(
  openRouterKey: string,
  model: string = EXTRACTOR_MODEL_DEFAULT,
): CategoryNounExtractorDeps {
  return {
    callLLMTool: async (params) => {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${openRouterKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://chat-volt.testdevops.ru",
          "X-Title": "220volt-chat-consultant-v2-category-noun-extractor",
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 60,
          // Provider lock: без него OpenRouter роутит часть запросов в Google Vertex
          // Anthropic, который отвечает 400 на наш payload с tool_calls.
          provider: {
            order: ["Anthropic", "Amazon Bedrock"],
            ignore: ["Google Vertex", "Google"],
            allow_fallbacks: true,
          },
          messages: [
            { role: "system", content: params.systemPrompt },
            { role: "user", content: params.userMessage },
          ],
          tools: [params.tool],
          tool_choice: params.toolChoice,
        }),
        signal: AbortSignal.timeout(EXTRACTOR_TIMEOUT_MS),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`extractor LLM HTTP ${res.status}: ${errText.slice(0, 200)}`);
      }
      // deno-lint-ignore no-explicit-any
      const json: any = await res.json();
      const toolCalls = json?.choices?.[0]?.message?.tool_calls;
      if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
        throw new Error("extractor LLM: no tool_calls");
      }
      const argsRaw = toolCalls[0]?.function?.arguments;
      if (typeof argsRaw !== "string") {
        throw new Error("extractor LLM: arguments not a string");
      }
      try {
        return JSON.parse(argsRaw);
      } catch (e) {
        throw new Error(`extractor LLM: arguments not valid JSON: ${(e as Error).message}`);
      }
    },
  };
}
