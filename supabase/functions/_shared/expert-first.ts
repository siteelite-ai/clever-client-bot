// expert-first.ts
//
// Назначение: «эксперт-консультант на входе» — параллельная надстройка над
// classifier. Получает ТОЛЬКО сырой запрос пользователя, рассуждает как живой
// продавец-электрик 220volt.kz и выдаёт целостное суждение:
//   • intent  — куда направить запрос
//   • productNoun — тип товара (нормализованное существительное), без брендов
//   • facetHints  — мягкие подсказки фасетов (key → values), БЕЗ schema-валидации
//                   (на этом этапе schema ещё неизвестна — валидация позже)
//   • reasoning   — короткое профессиональное обоснование (1–2 предложения)
//   • apiHints    — рекомендации параметров для каталога: min_price/max_price,
//                   priceIntent (cheapest/most_expensive/null), brand
//   • confidence  — high | medium | low
//
// КРИТИЧЕСКИЕ ПРАВИЛА:
//  1. НЕТ хардкода категорий, синонимов, формул — всё в промпте у LLM.
//  2. Модуль НЕ ходит в каталог и НЕ знает schema. Валидация facetHints против
//     реальных options делается ВНЕ модуля (как в expert-interpretation).
//  3. При ошибке/таймауте → пустой результат. Никаких throw наружу.
//  4. Используется как НАДСТРОЙКА: classifier остаётся safety-net, его результат
//     можно мёржить с этим (например, intent expert > intent classifier при high).
//
// Спецификация intent enum синхронизирована с s2-intent-classifier:
//   catalog | price | knowledge | accessory_for | spec_query | out_of_domain | smalltalk

const EXPERT_MODEL = "anthropic/claude-sonnet-4.5";
const EXPERT_TIMEOUT_MS = 6_000;
const MAX_VALUES_PER_FACET = 3;
const MAX_FACETS = 8;

export type ExpertIntent =
  | "catalog"
  | "price"
  | "knowledge"
  | "accessory_for"
  | "spec_query"
  | "out_of_domain"
  | "smalltalk";

const INTENTS: ExpertIntent[] = [
  "catalog",
  "price",
  "knowledge",
  "accessory_for",
  "spec_query",
  "out_of_domain",
  "smalltalk",
];

const SYSTEM_PROMPT = `Ты — опытный продавец-консультант казахстанского интернет-магазина электротоваров 220volt.kz. Ты знаешь нормы ПУЭ, расчёты токов, мощностей, освещённости, типовые модели кабелей/ламп/УЗО/инструмента.

Тебе дают СЫРОЙ запрос клиента (одно сообщение, без истории). Твоя задача — за один шаг как эксперт:
  1) понять, что клиент хочет, и куда это направить (intent);
  2) выделить тип товара (productNoun) — нормализованное существительное в именительном падеже единственного числа, БЕЗ брендов и без модификаторов («кабель», «лампа», «удлинитель»);
  3) если это технический запрос — предложить целевые характеристики (facetHints) как профессионал: что именно подходит под задачу клиента. Ключи фасетов — на твоё усмотрение из общеупотребительной терминологии (material, sechenie, kolichestvo_zhil, moshchnost, tip_tsokolya, nominalnyy_tok, …). Значения — конкретные (числа с единицами или короткие слова). Не выдумывай несуществующих характеристик, если из запроса ничего не следует — оставь пустым;
  4) если в запросе есть бюджет/«самый дешёвый»/«до 10000 тг» — заполни apiHints.min_price / max_price / priceIntent;
  5) если упомянут бренд — apiHints.brand;
  6) reasoning — 1–2 коротких предложения на русском: что подобрал и почему (как сказал бы продавец). Без приветствий, без «здравствуйте», без воды.

INTENT enum:
  • "catalog"         — клиент ищет товар по типу/характеристикам («нужен кабель 3 жилы», «лампа Е27 теплая»)
  • "price"           — клиент спрашивает цену/«сколько стоит»/«самый дешёвый» (без сложных фильтров)
  • "knowledge"       — общий вопрос («как выбрать УЗО», «что такое IP44»), без поиска товара
  • "accessory_for"   — «что подходит к…», «аксессуары для…» — нужен якорь-товар
  • "spec_query"      — клиент спрашивает конкретную характеристику товара («какая мощность у …»)
  • "out_of_domain"   — не про электротовары (еда, политика, погода)
  • "smalltalk"       — приветствие/благодарность без запроса

confidence:
  • "high"   — запрос однозначный, расчёт следует из норм
  • "medium" — есть допущения, но направление ясное
  • "low"    — размытый запрос, мало данных

Вызови tool expert_judgment РОВНО ОДИН раз.`;

const TOOL_SCHEMA = {
  type: "function" as const,
  function: {
    name: "expert_judgment",
    description: "Целостное суждение эксперта: куда направить запрос, что искать, по каким характеристикам.",
    parameters: {
      type: "object",
      properties: {
        intent: { type: "string", enum: INTENTS },
        productNoun: {
          type: "string",
          description: "Тип товара в именительном падеже ед. ч., без брендов. Пусто если запрос не про товар.",
        },
        facetHints: {
          type: "object",
          description: "Мягкие подсказки: facet_key → массив целевых значений. Только если из запроса однозначно следует.",
          additionalProperties: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: MAX_VALUES_PER_FACET,
          },
        },
        apiHints: {
          type: "object",
          properties: {
            min_price: { type: ["number", "null"] },
            max_price: { type: ["number", "null"] },
            priceIntent: { type: ["string", "null"], enum: ["cheapest", "most_expensive", null] },
            brand: { type: ["string", "null"] },
          },
          required: ["min_price", "max_price", "priceIntent", "brand"],
          additionalProperties: false,
        },
        reasoning: { type: "string" },
        confidence: { type: "string", enum: ["high", "medium", "low"] },
      },
      required: ["intent", "productNoun", "facetHints", "apiHints", "reasoning", "confidence"],
      additionalProperties: false,
    },
  },
};

const TOOL_CHOICE = {
  type: "function" as const,
  function: { name: "expert_judgment" },
};

export interface ExpertFirstInput {
  originalQuery: string;
  openrouterKey: string;
  /** Опциональный override таймаута (мс). По умолчанию 6000. */
  timeoutMs?: number;
  log?: (event: string, data?: Record<string, unknown>) => void;
  /** Тестовый хук: подмена fetch. */
  fetchImpl?: typeof fetch;
}

export interface ExpertFirstApiHints {
  min_price: number | null;
  max_price: number | null;
  priceIntent: "cheapest" | "most_expensive" | null;
  brand: string | null;
}

export interface ExpertFirstResult {
  intent: ExpertIntent | "unknown";
  productNoun: string;
  facetHints: Record<string, string[]>;
  apiHints: ExpertFirstApiHints;
  reasoning: string;
  confidence: "high" | "medium" | "low" | "none";
  llmOk: boolean;
  latencyMs: number;
}

const EMPTY_API_HINTS: ExpertFirstApiHints = {
  min_price: null,
  max_price: null,
  priceIntent: null,
  brand: null,
};

const EMPTY_RESULT: ExpertFirstResult = {
  intent: "unknown",
  productNoun: "",
  facetHints: {},
  apiHints: { ...EMPTY_API_HINTS },
  reasoning: "",
  confidence: "none",
  llmOk: false,
  latencyMs: 0,
};

function clampStr(s: unknown, max: number): string {
  return typeof s === "string" ? s.trim().slice(0, max) : "";
}

function sanitizeFacets(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string[]> = {};
  let facetCount = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (facetCount >= MAX_FACETS) break;
    if (!k || typeof k !== "string") continue;
    if (!Array.isArray(v)) continue;
    const vals: string[] = [];
    for (const x of v) {
      if (typeof x !== "string") continue;
      const t = x.trim();
      if (!t) continue;
      if (!vals.includes(t)) vals.push(t);
      if (vals.length >= MAX_VALUES_PER_FACET) break;
    }
    if (vals.length > 0) {
      out[k] = vals;
      facetCount++;
    }
  }
  return out;
}

function sanitizeApiHints(raw: unknown): ExpertFirstApiHints {
  if (!raw || typeof raw !== "object") return { ...EMPTY_API_HINTS };
  const r = raw as Record<string, unknown>;
  const num = (x: unknown) =>
    typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : null;
  const pi = r.priceIntent;
  return {
    min_price: num(r.min_price),
    max_price: num(r.max_price),
    priceIntent: pi === "cheapest" || pi === "most_expensive" ? pi : null,
    brand: typeof r.brand === "string" && r.brand.trim() ? r.brand.trim().slice(0, 80) : null,
  };
}

export async function expertFirstJudgment(
  input: ExpertFirstInput,
): Promise<ExpertFirstResult> {
  const log = input.log ?? (() => {});
  const query = (input.originalQuery ?? "").trim();
  const t0 = Date.now();

  if (!query) {
    log("expert_first.skip", { reason: "empty_query" });
    return { ...EMPTY_RESULT };
  }
  if (!input.openrouterKey) {
    log("expert_first.no_key", {});
    return { ...EMPTY_RESULT };
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? EXPERT_TIMEOUT_MS;

  let parsed: Record<string, unknown> | null = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${input.openrouterKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://chat-volt.testdevops.ru",
        "X-Title": "220volt-chat-consultant-expert-first",
      },
      body: JSON.stringify({
        model: EXPERT_MODEL,
        temperature: 0.2,
        max_tokens: 700,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Запрос клиента: «${query}»` },
        ],
        tools: [TOOL_SCHEMA],
        tool_choice: TOOL_CHOICE,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) {
      log("expert_first.http_error", { status: response.status, ms: Date.now() - t0 });
      return { ...EMPTY_RESULT, latencyMs: Date.now() - t0 };
    }
    // deno-lint-ignore no-explicit-any
    const data: any = await response.json();
    const toolCalls = data?.choices?.[0]?.message?.tool_calls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
      log("expert_first.no_tool_calls", { ms: Date.now() - t0 });
      return { ...EMPTY_RESULT, latencyMs: Date.now() - t0 };
    }
    const argsRaw = toolCalls[0]?.function?.arguments;
    if (typeof argsRaw !== "string") {
      log("expert_first.bad_args", {});
      return { ...EMPTY_RESULT, latencyMs: Date.now() - t0 };
    }
    parsed = JSON.parse(argsRaw);
  } catch (e) {
    log("expert_first.llm_error", {
      error: e instanceof Error ? e.message : String(e),
      ms: Date.now() - t0,
    });
    return { ...EMPTY_RESULT, latencyMs: Date.now() - t0 };
  }

  const intentRaw = clampStr(parsed?.intent, 40).toLowerCase();
  const intent: ExpertFirstResult["intent"] =
    (INTENTS as string[]).includes(intentRaw) ? (intentRaw as ExpertIntent) : "unknown";
  const productNoun = clampStr(parsed?.productNoun, 80);
  const facetHints = sanitizeFacets(parsed?.facetHints);
  const apiHints = sanitizeApiHints(parsed?.apiHints);
  const reasoning = clampStr(parsed?.reasoning, 400);
  const confRaw = clampStr(parsed?.confidence, 10).toLowerCase();
  const confidence: ExpertFirstResult["confidence"] =
    confRaw === "high" || confRaw === "medium" || confRaw === "low" ? confRaw : "none";

  const latencyMs = Date.now() - t0;
  log("expert_first.ok", {
    ms: latencyMs,
    intent,
    productNoun,
    facetCount: Object.keys(facetHints).length,
    confidence,
    hasPriceIntent: !!apiHints.priceIntent,
    hasBrand: !!apiHints.brand,
  });

  return {
    intent,
    productNoun,
    facetHints,
    apiHints,
    reasoning,
    confidence,
    llmOk: true,
    latencyMs,
  };
}
