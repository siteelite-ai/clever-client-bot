// chat-consultant-v2 / category-resolver.ts
// Stage B — Category Resolver (§9.2a спецификации chat-consultant-v2).
//
// Контракт (из mem://features/search-pipeline и §9.2a спеки):
//   Вход:  { query, intent, slot, traceId }
//   Выход: ResolverResult { status, pagetitle?, candidates?, confidence, source, ms }
//
// Жёсткие правила (core memory):
//   • Live /api/categories only — никаких whitelists, snapshot-таблиц, hardcoded
//     списков. Список приходит из соседней edge-функции `search-products`
//     (action=list_categories), которая уже умеет кэш 1ч и live-fallback.
//   • Skip-логика: при intent ∈ {refine_filter, next_page} И slot.category есть
//     → возврат напрямую slot.category, без LLM-вызова.
//   • Provider: OpenRouter (Gemini family) — единственный разрешённый шлюз LLM.
//   • Пороги: app_settings.resolver_thresholds_json
//       category_high (>= → resolved)
//       category_low  (>= и < high → ambiguous, top-3)
//                     (< low → null, передаём вверх для Multi-bucket fallback)
//
// V1 НЕ ТРОГАЕТСЯ. Этот файл живёт ТОЛЬКО внутри chat-consultant-v2/.

export type ResolverIntent =
  | "catalog"
  | "refine_filter"
  | "next_page"
  | "knowledge"
  | "out_of_domain"
  | "unknown";

export interface ResolverSlotSnapshot {
  // Текущая «активная» категория диалога. Если есть и intent — refine/next_page,
  // resolver НЕ дёргает LLM, чтобы не сменить фокус разговора.
  category?: string | null;
}

export interface ResolverInput {
  query: string;
  intent: ResolverIntent;
  slot?: ResolverSlotSnapshot | null;
  traceId: string;
}

export type ResolverStatus =
  | "resolved"          // confidence >= category_high → одна уверенная категория
  | "ambiguous"         // category_low <= confidence < category_high → top-3
  | "unresolved"        // confidence < category_low → передаём в multi-bucket
  | "skipped_slot"      // intent=refine/next_page, использовали slot.category
  | "skipped_intent";   // knowledge / out_of_domain — категория не нужна

export interface ResolverCandidate {
  pagetitle: string;
  confidence: number; // 0..1
}

export interface ResolverResult {
  status: ResolverStatus;
  pagetitle: string | null;          // основная категория (для resolved/skipped_slot)
  candidates: ResolverCandidate[];   // top-3 при ambiguous, иначе []
  confidence: number;                // 0..1, для resolved/ambiguous
  source: "llm" | "slot" | "skip" | "error";
  ms: number;                        // длительность работы резолвера
  error?: string;                    // сообщение, если source=error
}

export interface ResolverDeps {
  // Получить полный live-список pagetitle категорий через search-products.
  listCategories: () => Promise<string[]>;
  // Вызвать OpenRouter (Gemini) с messages → строка ответа.
  callLLM: (
    messages: Array<{ role: "system" | "user"; content: string }>,
  ) => Promise<{ text: string; model: string; usage?: unknown }>;
  // Прочитать пороги из app_settings.resolver_thresholds_json.
  getThresholds: () => Promise<{ category_high: number; category_low: number }>;
  // Логирование прогресса (trace).
  log: (event: string, data?: Record<string, unknown>) => void;
}

// --------------------------------------------------------------------------
// LLM-промпт. Жёстко data-agnostic: НИ ОДНОГО реального названия категории
// 220volt в инструкции. Только формальный контракт.
// --------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are a CATEGORY MATCHER for an electronics-and-tools e-commerce catalog.

Your ONLY job: pick the best matching category PAGETITLE from the provided
catalog list for the user's query, or report uncertainty.

STRICT RULES:
1. You MUST choose a pagetitle EXACTLY as it appears in the provided list
   (same characters, same case). Do NOT invent, translate or shorten it.
2. If multiple categories look plausible, return up to 3 candidates ordered
   by confidence DESC.
3. confidence is your subjective probability that the candidate is the
   correct catalog branch for the query. Use the full 0.0–1.0 range:
     • 0.85–1.0 — query clearly names this category
     • 0.55–0.84 — strong but not unique match
     • 0.25–0.54 — partial / ambiguous
     • 0.0–0.24 — long shot / unrelated
4. If NOTHING in the list looks related, return an empty candidates array.
5. Output STRICT JSON only, no prose, no markdown fences:
   {"candidates":[{"pagetitle":"<exact list item>","confidence":<0..1>}]}
6. Do NOT add explanations, comments, or extra fields.`;

function buildUserPrompt(query: string, categories: string[]): string {
  // Нумеруем для уменьшения галлюцинаций — модель чаще копирует точный токен.
  const numbered = categories.map((c, i) => `${i + 1}. ${c}`).join("\n");
  return [
    `USER QUERY:`,
    query.trim(),
    ``,
    `CATALOG CATEGORIES (${categories.length} items, choose pagetitle EXACTLY as written):`,
    numbered,
    ``,
    `Return JSON now.`,
  ].join("\n");
}

// Парсинг ответа LLM с защитой от markdown-fence и мусора по краям.
function parseLLMResponse(
  raw: string,
  validSet: Set<string>,
): ResolverCandidate[] {
  let txt = raw.trim();
  // Срезаем ```json ... ```
  if (txt.startsWith("```")) {
    txt = txt.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  }
  // Первая `{` … последняя `}` — на случай префиксов типа "Here is..."
  const first = txt.indexOf("{");
  const last = txt.lastIndexOf("}");
  if (first >= 0 && last > first) txt = txt.slice(first, last + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(txt);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const arr = (parsed as { candidates?: unknown }).candidates;
  if (!Array.isArray(arr)) return [];

  const out: ResolverCandidate[] = [];
  for (const c of arr) {
    if (!c || typeof c !== "object") continue;
    const pagetitle = (c as { pagetitle?: unknown }).pagetitle;
    const confidence = (c as { confidence?: unknown }).confidence;
    if (typeof pagetitle !== "string") continue;
    if (typeof confidence !== "number") continue;
    if (!validSet.has(pagetitle)) continue; // защита от галлюцинаций
    const clamped = Math.max(0, Math.min(1, confidence));
    out.push({ pagetitle, confidence: clamped });
  }
  // Сортируем по убыванию уверенности и режем до top-3.
  out.sort((a, b) => b.confidence - a.confidence);
  return out.slice(0, 3);
}

export async function resolveCategory(
  input: ResolverInput,
  deps: ResolverDeps,
): Promise<ResolverResult> {
  const t0 = Date.now();
  const { query, intent, slot, traceId } = input;

  // ----- 1. Skip по intent -------------------------------------------------
  if (intent === "knowledge" || intent === "out_of_domain") {
    deps.log("category_resolver.skip", { traceId, reason: `intent=${intent}` });
    return {
      status: "skipped_intent",
      pagetitle: null,
      candidates: [],
      confidence: 0,
      source: "skip",
      ms: Date.now() - t0,
    };
  }

  // ----- 2. Skip по slot (refine_filter / next_page) ----------------------
  if (
    (intent === "refine_filter" || intent === "next_page") &&
    slot?.category
  ) {
    deps.log("category_resolver.slot_reuse", {
      traceId,
      pagetitle: slot.category,
      intent,
    });
    return {
      status: "skipped_slot",
      pagetitle: slot.category,
      candidates: [],
      confidence: 1,
      source: "slot",
      ms: Date.now() - t0,
    };
  }

  // ----- 3. Полный путь: live list + LLM ----------------------------------
  let categories: string[];
  try {
    categories = await deps.listCategories();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    deps.log("category_resolver.list_failed", { traceId, error: msg });
    return {
      status: "unresolved",
      pagetitle: null,
      candidates: [],
      confidence: 0,
      source: "error",
      ms: Date.now() - t0,
      error: `list_categories: ${msg}`,
    };
  }
  if (!Array.isArray(categories) || categories.length === 0) {
    deps.log("category_resolver.empty_list", { traceId });
    return {
      status: "unresolved",
      pagetitle: null,
      candidates: [],
      confidence: 0,
      source: "error",
      ms: Date.now() - t0,
      error: "empty_categories_list",
    };
  }

  const thresholds = await deps.getThresholds();
  const validSet = new Set(categories);

  let llmText = "";
  let llmModel = "";
  try {
    const res = await deps.callLLM([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(query, categories) },
    ]);
    llmText = res.text;
    llmModel = res.model;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    deps.log("category_resolver.llm_failed", { traceId, error: msg });
    return {
      status: "unresolved",
      pagetitle: null,
      candidates: [],
      confidence: 0,
      source: "error",
      ms: Date.now() - t0,
      error: `llm: ${msg}`,
    };
  }

  const candidates = parseLLMResponse(llmText, validSet);
  const top = candidates[0];
  const conf = top?.confidence ?? 0;

  let status: ResolverStatus;
  let pagetitle: string | null = null;
  let returnCandidates: ResolverCandidate[] = [];

  if (top && conf >= thresholds.category_high) {
    status = "resolved";
    pagetitle = top.pagetitle;
    returnCandidates = candidates;
  } else if (top && conf >= thresholds.category_low) {
    status = "ambiguous";
    pagetitle = top.pagetitle; // лучший кандидат, но требует подтверждения
    returnCandidates = candidates;
  } else {
    status = "unresolved";
    pagetitle = null;
    returnCandidates = candidates; // оставляем для трассировки
  }

  deps.log("category_resolver.done", {
    traceId,
    status,
    pagetitle,
    confidence: conf,
    candidates_count: candidates.length,
    catalog_size: categories.length,
    model: llmModel,
    thresholds,
    ms: Date.now() - t0,
  });

  return {
    status,
    pagetitle,
    candidates: returnCandidates,
    confidence: conf,
    source: "llm",
    ms: Date.now() - t0,
  };
}
