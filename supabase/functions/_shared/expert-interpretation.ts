// expert-interpretation.ts
//
// Назначение: «эксперт-электрик» — LLM-шаг между классификатором и выдачей,
// который превращает требование клиента в целевые значения фасетов каталога.
//
// Пример: «кабель для подключения кондиционера мощностью 3 кВт»
//   → classifier: {category: "кабель", modifiers: ["3","кВт",...]}
//   → expert: P=3 кВт → I≈14 А → сечение 2.5 мм² медь, 3 жилы
//   → targetFacets: { material: ["медь"], kolichestvo_zhil: ["3"], sechenie: ["2.5"] }
//
// КРИТИЧЕСКИЕ ПРАВИЛА (data-agnostic):
//  1. LLM ВСЕГДА получает реальную schema опций категории (из /categories/options
//     или bootstrap). Без schema — модуль возвращает пустой результат.
//  2. Каждый возвращённый key ОБЯЗАН существовать в schema; иначе drop.
//  3. Каждое value ОБЯЗАНО матчиться (case-insensitive, substring) с одним из
//     реальных values этого фасета; иначе drop. Защита от галлюцинаций.
//  4. При ошибке/таймауте — пустой результат, вызывающий код продолжает обычным путём.
//  5. НЕТ хардкода категорий/единиц измерения/формул — всё в промпте у LLM.
//
// Модуль НЕ бросает исключений наружу.

const EXPERT_MODEL = "deepseek/deepseek-chat-v3.1:free";
const EXPERT_TIMEOUT_MS = 8_000;
const MAX_VALUES_PER_FACET = 3;

const SYSTEM_PROMPT = `Ты — эксперт-консультант казахстанского интернет-магазина электротоваров 220volt.kz.

Клиент описал свою задачу/потребность (например: «кабель для кондиционера 3 кВт», «лампа для гостиной 18 м²», «УЗО для квартиры 32 А»). Тебе дана категория товара и РЕАЛЬНАЯ schema фасетов (опций) этой категории из каталога — список доступных характеристик с их возможными значениями.

Твоя задача — как эксперт перевести бытовое требование клиента в КОНКРЕТНЫЕ целевые значения фасетов из schema, по которым потом отфильтруется выдача.

ПРАВИЛА:
1. Используй ТОЛЬКО ключи (key) фасетов из переданной schema. Не выдумывай новые.
2. Используй ТОЛЬКО значения (value_ru), которые присутствуют в schema этого фасета. Не выдумывай.
3. Применяй профессиональные нормы (ПУЭ, токи нагрузки, мощность, освещённость и т.п.) для перевода требований клиента в технические параметры.
4. Заполняй ТОЛЬКО те фасеты, для которых из запроса клиента однозначно следует целевое значение. Если параметр не определён — НЕ добавляй его.
5. Если 2-3 значения одинаково подходят (например, сечение 2.5 или 4 для запаса) — можно вернуть несколько значений в массиве.
6. В reasoning — 1 короткое предложение на русском: что именно ты подобрал и почему. Без приветствий, без воды.
7. confidence: "high" если из запроса однозначно следует расчёт; "medium" если есть допущения; "low" если требование размытое.
8. Если запрос клиента НЕ содержит инженерных параметров (просто «хочу кабель», «нужна лампа») — верни пустой targetFacets и confidence="low".

Вызови tool interpret_requirement.`;

const TOOL_SCHEMA = {
  type: "function" as const,
  function: {
    name: "interpret_requirement",
    description: "Возвращает целевые значения фасетов и краткое обоснование.",
    parameters: {
      type: "object",
      properties: {
        targetFacets: {
          type: "object",
          description: "Map: facet_key (из schema) → массив целевых value_ru (из schema). Только однозначно следующие из запроса.",
          additionalProperties: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: MAX_VALUES_PER_FACET,
          },
        },
        reasoning: {
          type: "string",
          description: "Одно предложение на русском: что и почему подобрано (без приветствий).",
        },
        confidence: {
          type: "string",
          enum: ["high", "medium", "low"],
        },
      },
      required: ["targetFacets", "reasoning", "confidence"],
      additionalProperties: false,
    },
  },
};

const TOOL_CHOICE = {
  type: "function" as const,
  function: { name: "interpret_requirement" },
};

/** Минимальный shape опции, который нужен модулю. Совместим с RawOption / bootstrap. */
export interface ExpertOption {
  key: string;
  caption_ru?: string | null;
  values: Array<{ value_ru: string; count?: number }>;
}

export interface ExpertInterpretationInput {
  originalQuery: string;
  productCategory: string;
  searchModifiers?: string[];
  /** Реальная schema опций категории. Без неё модуль возвращает пустой результат. */
  optionSchema: ExpertOption[];
  openrouterKey: string;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

export interface ExpertInterpretationResult {
  /** Map: facet_key → массив реальных value_ru. Пусто = нечего применять. */
  targetFacets: Record<string, string[]>;
  reasoning: string;
  confidence: "high" | "medium" | "low" | "none";
  llmOk: boolean;
  /** Ключи/значения, которые LLM вернула, но отсеялись валидацией (для логов). */
  droppedKeys: string[];
  droppedValues: Array<{ key: string; value: string }>;
}

const EMPTY_RESULT: ExpertInterpretationResult = {
  targetFacets: {},
  reasoning: "",
  confidence: "none",
  llmOk: false,
  droppedKeys: [],
  droppedValues: [],
};

function normForMatch(s: string): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[,;()]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Substring-match (case-insensitive, ё→е) реального value_ru с тем, что вернула LLM. */
function matchValue(returned: string, realValues: string[]): string | null {
  const r = normForMatch(returned);
  if (!r) return null;
  // 1. exact
  for (const v of realValues) if (normForMatch(v) === r) return v;
  // 2. substring (LLM могла вернуть «2.5» а schema хранит «2.5 мм²»)
  for (const v of realValues) {
    const nv = normForMatch(v);
    if (nv.includes(r) || r.includes(nv)) return v;
  }
  return null;
}

export async function interpretRequirement(
  input: ExpertInterpretationInput,
): Promise<ExpertInterpretationResult> {
  const log = input.log ?? (() => {});
  const query = (input.originalQuery ?? "").trim();
  const category = (input.productCategory ?? "").trim();
  const schema = Array.isArray(input.optionSchema) ? input.optionSchema : [];

  if (!query || !category || schema.length === 0) {
    log("expert.skip", { reason: !query ? "no_query" : !category ? "no_category" : "no_schema" });
    return EMPTY_RESULT;
  }
  if (!input.openrouterKey) {
    log("expert.no_key", {});
    return EMPTY_RESULT;
  }

  // Компактное представление schema для промпта.
  // Ограничиваем по 25 values на фасет чтобы не раздуть контекст.
  const schemaForPrompt = schema.map((opt) => ({
    key: opt.key,
    caption_ru: opt.caption_ru ?? opt.key,
    values: (opt.values ?? []).map((v) => v.value_ru).filter(Boolean).slice(0, 25),
  })).filter((o) => o.values.length > 0);

  if (schemaForPrompt.length === 0) {
    log("expert.skip", { reason: "schema_empty_after_filter" });
    return EMPTY_RESULT;
  }

  const userBlock = [
    `Запрос клиента: «${query}»`,
    `Категория: ${category}`,
    input.searchModifiers && input.searchModifiers.length > 0
      ? `Модификаторы из запроса: ${input.searchModifiers.join(", ")}`
      : null,
    ``,
    `Schema фасетов категории (key → values):`,
    JSON.stringify(schemaForPrompt, null, 2),
  ].filter(Boolean).join("\n");

  let parsed: { targetFacets?: unknown; reasoning?: unknown; confidence?: unknown } | null = null;
  const t0 = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), EXPERT_TIMEOUT_MS);
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${input.openrouterKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://chat-volt.testdevops.ru",
        "X-Title": "220volt-chat-consultant-expert-interpretation",
      },
      body: JSON.stringify({
        model: EXPERT_MODEL,
        temperature: 0.2,
        max_tokens: 600,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userBlock },
        ],
        tools: [TOOL_SCHEMA],
        tool_choice: TOOL_CHOICE,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) {
      log("expert.http_error", { status: response.status, ms: Date.now() - t0 });
      return EMPTY_RESULT;
    }
    // deno-lint-ignore no-explicit-any
    const data: any = await response.json();
    const toolCalls = data?.choices?.[0]?.message?.tool_calls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
      log("expert.no_tool_calls", { ms: Date.now() - t0 });
      return EMPTY_RESULT;
    }
    const argsRaw = toolCalls[0]?.function?.arguments;
    if (typeof argsRaw !== "string") {
      log("expert.bad_args", {});
      return EMPTY_RESULT;
    }
    parsed = JSON.parse(argsRaw);
  } catch (e) {
    log("expert.llm_error", { error: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 });
    return EMPTY_RESULT;
  }

  const rawFacets = (parsed?.targetFacets && typeof parsed.targetFacets === "object")
    ? parsed.targetFacets as Record<string, unknown>
    : {};
  const reasoning = typeof parsed?.reasoning === "string" ? parsed!.reasoning.trim().slice(0, 300) : "";
  const confRaw = typeof parsed?.confidence === "string" ? parsed!.confidence.toLowerCase() : "";
  const confidence: ExpertInterpretationResult["confidence"] =
    confRaw === "high" || confRaw === "medium" || confRaw === "low" ? confRaw : "none";

  // Schema index for validation.
  const byKey = new Map<string, string[]>();
  for (const opt of schema) {
    byKey.set(opt.key, (opt.values ?? []).map((v) => v.value_ru).filter(Boolean));
  }

  const targetFacets: Record<string, string[]> = {};
  const droppedKeys: string[] = [];
  const droppedValues: Array<{ key: string; value: string }> = [];

  for (const [key, valuesRaw] of Object.entries(rawFacets)) {
    const realValues = byKey.get(key);
    if (!realValues || realValues.length === 0) {
      droppedKeys.push(key);
      continue;
    }
    if (!Array.isArray(valuesRaw)) continue;
    const accepted: string[] = [];
    for (const v of valuesRaw) {
      if (typeof v !== "string") continue;
      const matched = matchValue(v, realValues);
      if (matched && !accepted.includes(matched)) {
        accepted.push(matched);
      } else if (!matched) {
        droppedValues.push({ key, value: v });
      }
    }
    if (accepted.length > 0) {
      targetFacets[key] = accepted.slice(0, MAX_VALUES_PER_FACET);
    }
  }

  log("expert.ok", {
    ms: Date.now() - t0,
    confidence,
    facetCount: Object.keys(targetFacets).length,
    droppedKeys,
    droppedValuesCount: droppedValues.length,
  });

  return {
    targetFacets,
    reasoning,
    confidence,
    llmOk: true,
    droppedKeys,
    droppedValues,
  };
}
