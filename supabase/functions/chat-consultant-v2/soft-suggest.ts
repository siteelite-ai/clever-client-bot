// chat-consultant-v2 / soft-suggest.ts
// Stage 8 / §22.3 spec — Branch B (Soft-Suggest).
//
// Контракт:
//   Вход:  { unmatchedModifier, facetSchema, pagetitle, locale }
//   Выход: { suggestions: SoftSuggestion[], hintText: string | null, ms, source }
//
// Жёсткие правила (Core Memory + spec §22.3, §22.5):
//   • OpenRouter (Gemini) only. Tool calling.
//   • Data-agnostic: schema приходит из live/stale/bootstrap, ни одного хардкода.
//   • Post-validation OBLIGATORY: каждый suggestion.facet_key И suggestion.value
//     ДОЛЖНЫ существовать в переданной schema. Невалидные молча отбрасываются.
//   • НЕ применяет фильтры. Только генерирует текст HINT-блока (no self-narrowing).
//   • При сбое LLM — возвращает empty suggestions, HINT не рендерится.

import type { RawOption } from "./catalog/api-client.ts";

const SUGGEST_TIMEOUT_MS = 10_000;
const SUGGEST_MODEL_DEFAULT = "google/gemini-2.5-flash";
const SUGGEST_MAX_ITEMS = 3;

export type SoftSuggestSource =
  | "ok"               // suggestions сгенерированы и валидны
  | "skipped_empty_modifier"
  | "skipped_empty_schema"
  | "llm_error"
  | "all_invalid";     // все suggestions отброшены post-validation

export interface SoftSuggestion {
  facet_key: string;
  facet_caption: string;
  value: string;
  value_caption: string;
  rationale_short: string;
}

export interface SoftSuggestResult {
  suggestions: SoftSuggestion[];
  /** Готовый markdown-блок для Composer ИЛИ null если не рендерим. */
  hintText: string | null;
  source: SoftSuggestSource;
  /** Сколько suggestions LLM вернул до post-validation. */
  rawCount: number;
  /** Сколько отброшено post-validation (метрика soft_suggest_invalid_dropped_total). */
  invalidDropped: number;
  ms: number;
}

export interface SoftSuggestDeps {
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

const SYSTEM_PROMPT = `Ты — экспертный продавец-консультант. Пользователь добавил к запросу модификатор (например, описание получателя, назначения, контекста использования), но в каталоге нет фасета, прямо соответствующего этому модификатору.

Твоя задача: предложить 0–${SUGGEST_MAX_ITEMS} уточняющих фасетов из ПЕРЕДАННОЙ СХЕМЫ, которые типично подходят под этот модификатор.

Жёсткие правила:
1. Выбирай ТОЛЬКО facet_key и value, которые ЕСТЬ в переданной схеме. Никаких выдумок.
2. rationale_short — короткое объяснение (≤6 слов, до 60 символов), почему это подходит.
3. Если ничего разумного не подходит — верни пустой массив.
4. Не предлагай фильтры по цене, бренду или артикулу — только описательные характеристики.
5. Используй caption_ru / value_ru как human-readable формы.

Вызови tool suggest_facet_clarifications.`;

const TOOL_SCHEMA = {
  type: "function" as const,
  function: {
    name: "suggest_facet_clarifications",
    description: "Предлагает уточняющие фасеты из переданной схемы.",
    parameters: {
      type: "object",
      properties: {
        suggestions: {
          type: "array",
          minItems: 0,
          maxItems: SUGGEST_MAX_ITEMS,
          items: {
            type: "object",
            properties: {
              facet_key: { type: "string" },
              facet_caption: { type: "string" },
              value: { type: "string" },
              value_caption: { type: "string" },
              rationale_short: { type: "string", maxLength: 60 },
            },
            required: [
              "facet_key",
              "facet_caption",
              "value",
              "value_caption",
              "rationale_short",
            ],
            additionalProperties: false,
          },
        },
      },
      required: ["suggestions"],
      additionalProperties: false,
    },
  },
};

const TOOL_CHOICE = {
  type: "function" as const,
  function: { name: "suggest_facet_clarifications" },
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

function getValueForLocale(v: { value_ru?: string | null; value_kz?: string | null; value?: string | null }, locale: "ru" | "kk"): string {
  return (locale === "kk" ? v.value_kz : v.value_ru) ?? v.value ?? "";
}

/** Возвращает Map<facet_key, Set<normalized_value>> для O(1) lookup. */
function indexSchema(schema: RawOption[], locale: "ru" | "kk"): Map<string, Set<string>> {
  const idx = new Map<string, Set<string>>();
  for (const opt of schema) {
    if (!opt.key) continue;
    const set = new Set<string>();
    for (const v of opt.values ?? []) {
      const val = getValueForLocale(v, locale);
      if (val) set.add(normalize(val));
    }
    idx.set(opt.key, set);
  }
  return idx;
}

function buildSchemaContext(schema: RawOption[], locale: "ru" | "kk"): string {
  // Передаём LLM компактное представление схемы:
  //   facet_key | caption | value1, value2, value3, ...
  const lines: string[] = [];
  for (const opt of schema) {
    const caption = (locale === "kk" ? opt.caption_kz : opt.caption_ru) ?? opt.caption ?? opt.key;
    const values = (opt.values ?? [])
      .map((v) => getValueForLocale(v, locale))
      .filter((v) => v.length > 0)
      .slice(0, 20); // ограничиваем длину payload
    if (values.length === 0) continue;
    lines.push(`${opt.key} | ${caption} | ${values.join(", ")}`);
  }
  return lines.join("\n");
}

function renderHint(modifier: string, suggestions: SoftSuggestion[]): string {
  if (suggestions.length === 0) return "";
  const lines = suggestions
    .map((s) => `- ${s.facet_caption}: ${s.value_caption} — ${s.rationale_short}`)
    .join("\n");
  return `\n\nДля «${modifier}» обычно подходит:\n${lines}\n\nХотите применить эти уточнения или показать всё?`;
}

// ─── Main entry ─────────────────────────────────────────────────────────────

export async function runSoftSuggest(
  input: {
    unmatchedModifier: string;
    facetSchema: RawOption[];
    pagetitle: string;
    locale: "ru" | "kk";
  },
  deps: SoftSuggestDeps,
): Promise<SoftSuggestResult> {
  const t0 = Date.now();
  const log = deps.log ?? (() => {});
  const modifier = (input.unmatchedModifier ?? "").trim();

  if (modifier.length === 0) {
    return {
      suggestions: [],
      hintText: null,
      source: "skipped_empty_modifier",
      rawCount: 0,
      invalidDropped: 0,
      ms: Date.now() - t0,
    };
  }

  if (!input.facetSchema || input.facetSchema.length === 0) {
    return {
      suggestions: [],
      hintText: null,
      source: "skipped_empty_schema",
      rawCount: 0,
      invalidDropped: 0,
      ms: Date.now() - t0,
    };
  }

  const schemaContext = buildSchemaContext(input.facetSchema, input.locale);
  if (schemaContext.length === 0) {
    return {
      suggestions: [],
      hintText: null,
      source: "skipped_empty_schema",
      rawCount: 0,
      invalidDropped: 0,
      ms: Date.now() - t0,
    };
  }

  const userMessage = `Категория: ${input.pagetitle}
Модификатор пользователя: «${modifier}»
Локаль: ${input.locale}

Доступная схема фасетов (формат: facet_key | caption | values):
${schemaContext}

Предложи 0–${SUGGEST_MAX_ITEMS} уточнений из этой схемы.`;

  let raw: unknown;
  try {
    raw = await deps.callLLMTool({
      systemPrompt: SYSTEM_PROMPT,
      userMessage,
      tool: TOOL_SCHEMA,
      toolChoice: TOOL_CHOICE,
    });
  } catch (e) {
    log("soft_suggest.llm_error", { error: e instanceof Error ? e.message : String(e) });
    return {
      suggestions: [],
      hintText: null,
      source: "llm_error",
      rawCount: 0,
      invalidDropped: 0,
      ms: Date.now() - t0,
    };
  }

  // Парсинг ответа
  // deno-lint-ignore no-explicit-any
  const rawSuggestions: any[] = Array.isArray((raw as any)?.suggestions) ? (raw as any).suggestions : [];
  const rawCount = rawSuggestions.length;

  // Post-validation против schema
  const schemaIdx = indexSchema(input.facetSchema, input.locale);
  const validated: SoftSuggestion[] = [];
  for (const s of rawSuggestions) {
    if (!s || typeof s !== "object") continue;
    const facet_key = String(s.facet_key ?? "").trim();
    const value = String(s.value ?? "").trim();
    if (!facet_key || !value) continue;
    const valuesSet = schemaIdx.get(facet_key);
    if (!valuesSet || !valuesSet.has(normalize(value))) continue;
    validated.push({
      facet_key,
      facet_caption: String(s.facet_caption ?? facet_key).trim(),
      value,
      value_caption: String(s.value_caption ?? value).trim(),
      rationale_short: String(s.rationale_short ?? "").trim().slice(0, 60),
    });
    if (validated.length >= SUGGEST_MAX_ITEMS) break;
  }

  const invalidDropped = rawCount - validated.length;

  if (validated.length === 0) {
    log("soft_suggest.all_invalid", { rawCount, invalidDropped });
    return {
      suggestions: [],
      hintText: null,
      source: rawCount > 0 ? "all_invalid" : "ok",
      rawCount,
      invalidDropped,
      ms: Date.now() - t0,
    };
  }

  log("soft_suggest.ok", { count: validated.length, rawCount, invalidDropped });
  return {
    suggestions: validated,
    hintText: renderHint(modifier, validated),
    source: "ok",
    rawCount,
    invalidDropped,
    ms: Date.now() - t0,
  };
}

// ─── Production deps factory (OpenRouter) ───────────────────────────────────

export function createProductionSoftSuggestDeps(
  openRouterKey: string,
  model: string = SUGGEST_MODEL_DEFAULT,
): SoftSuggestDeps {
  return {
    callLLMTool: async (params) => {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${openRouterKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://chat-volt.testdevops.ru",
          "X-Title": "220volt-chat-consultant-v2-soft-suggest",
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          max_tokens: 600,
          messages: [
            { role: "system", content: params.systemPrompt },
            { role: "user", content: params.userMessage },
          ],
          tools: [params.tool],
          tool_choice: params.toolChoice,
        }),
        signal: AbortSignal.timeout(SUGGEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`soft-suggest LLM HTTP ${res.status}: ${errText.slice(0, 200)}`);
      }
      // deno-lint-ignore no-explicit-any
      const json: any = await res.json();
      const toolCalls = json?.choices?.[0]?.message?.tool_calls;
      if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
        throw new Error("soft-suggest LLM: no tool_calls");
      }
      const argsRaw = toolCalls[0]?.function?.arguments;
      if (typeof argsRaw !== "string") {
        throw new Error("soft-suggest LLM: arguments not a string");
      }
      try {
        return JSON.parse(argsRaw);
      } catch (e) {
        throw new Error(`soft-suggest LLM: arguments not valid JSON: ${(e as Error).message}`);
      }
    },
  };
}
