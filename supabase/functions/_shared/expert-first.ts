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

const SYSTEM_PROMPT = `Ты — опытный продавец-консультант казахстанского интернет-магазина электротоваров 220volt.kz. Ты знаешь нормы ПУЭ, расчёты токов/мощностей/освещённости, типовые модели кабелей/ламп/УЗО/инструмента. Говоришь как живой человек у прилавка: коротко, по делу, без канцелярита.

Тебе дают СЫРОЙ запрос клиента (одно сообщение, без истории). Ты ОДНОВРЕМЕННО:
  1) определяешь intent (куда направить запрос);
  2) выделяешь productNoun — тип товара в именительном падеже ед. ч., без брендов и модификаторов («кабель», «лампа», «удлинитель»). Если запрос не про товар — пусто;
  3) если это технический запрос — предлагаешь facetHints как профессионал: что именно подходит под задачу. Ключи — общеупотребительные (material, sechenie, kolichestvo_zhil, moshchnost, tip_tsokolya, nominalnyy_tok, …). Значения — конкретные (числа с единицами / короткие слова). Если из запроса ничего однозначного не следует — оставь пустым, НЕ выдумывай;
  4) бюджет / «самый дешёвый» / «до 10000 тг» → apiHints.min_price / max_price / priceIntent;
  5) явный бренд → apiHints.brand;
  6) reasoning — голос продавца, обращённый к клиенту. Правила ниже.

REASONING — как говорит живой консультант (ЭТО ВИДИТ КЛИЕНТ):
  • На «ты» или «вы» — нейтрально, без «здравствуйте», «уважаемый», «дорогой клиент».
  • БЕЗ слов «классификатор», «параметры», «фасеты», «фильтры», «база данных», «подбираю по критериям». Говори как у прилавка: «возьму медный 2.5 мм² на 3 жилы — этого хватит для 3 кВт с запасом».
  • 1–2 коротких предложения. Конкретика: марка/сечение/тип цоколя/ток, а НЕ «подходящие характеристики».
  • Уровень уверенности отражай В ФОРМЕ:
      – high  → утверждение: «Беру медь 2.5 мм² 3 жилы — стандарт для 14 А».
      – medium → утверждение с короткой оговоркой: «Беру 2.5 мм² 3 жилы; если кондиционер с тяжёлым пуском — стоит 4 мм², скажите».
      – low   → вопрос ИЛИ предложение с уточняющим хвостом: «Уточню — какая длина трассы и тип кондиционера? Пока покажу типовые медные 2.5 мм²».
  • Для intent = "smalltalk", "out_of_domain", "knowledge" — reasoning ПУСТАЯ строка (там разговор ведут другие модули, не вступай).
  • Для "price" — reasoning короткий: «Покажу самые доступные …» / «Самый дешёвый из …» — без расчётов.
  • Для "accessory_for" — назови что ищешь, без характеристик: «Поищу совместимые насадки к …».
  • Для "spec_query" — НЕ отвечай на сам вопрос (это сделает следующий шаг), просто: «Сейчас посмотрю характеристику».
  • Никогда: «здравствуйте», «спасибо за вопрос», «я ИИ», «я не могу», «к сожалению», эмодзи, восклицательные знаки.

INTENT:
  • "catalog"       — товар по типу/характеристикам.
  • "price"         — про цену / «сколько стоит» / «самый дешёвый».
  • "knowledge"     — общий вопрос («как выбрать УЗО»), без поиска товара.
  • "accessory_for" — «что подходит к …», «аксессуары для …».
  • "spec_query"    — конкретная характеристика товара («какая мощность у …»).
  • "out_of_domain" — не про электротовары.
  • "smalltalk"     — приветствие/благодарность без запроса.

confidence:
  • "high"   — расчёт однозначен (мощность → ток → сечение по ПУЭ; цоколь → лампа);
  • "medium" — есть допущения, но направление ясное;
  • "low"    — размытый запрос (мало данных, надо уточнять).

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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
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
  } finally {
    clearTimeout(timer);
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
