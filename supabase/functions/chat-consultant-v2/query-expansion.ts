/**
 * chat-consultant-v2 / query-expansion.ts
 * Stage 6 — Step 6B: Query Expansion (§9.2b спецификации chat-consultant-v2).
 *
 * Контракт (§9.2b + core memory «Search pipeline (V2)»):
 *   Вход:  { query, locale, traceId }
 *   Выход: QueryAttempts { attempts: QueryAttempt[], skipped: SkipReason[] }
 *
 * Порядок попыток (фиксированный, §9.2b):
 *   1. as_is_ru          — оригинальный запрос (всегда первый)
 *   2. lexicon_canonical — замена пользовательских терминов на канонические
 *                          из app_settings.lexicon_json. Добавляется ТОЛЬКО
 *                          если хоть одна замена реально произошла.
 *   3. en_translation    — перевод на английский через LLM (для брендов и
 *                          техн. терминов). Добавляется только если результат
 *                          отличается от as_is_ru.
 *   4. kk_off            — казахская форма, по спеке §9.2b «kk_off» — этап
 *                          выключен по умолчанию (флаг в deps), скелет на
 *                          будущее.
 *
 * Жёсткие правила (core memory):
 *   • Provider: OpenRouter (Gemini family) — единственный разрешённый шлюз LLM.
 *   • Никаких whitelists/snapshots — lexicon приходит из app_settings live.
 *   • Data-agnostic: НИ ОДНОГО реального термина 220volt в коде/промпте.
 *   • Систематическое решение: если lexicon пуст — ступень корректно
 *     пропускается (skipped: 'lexicon_empty'), пайплайн НЕ ломается.
 *
 * V1 НЕ ТРОГАЕТСЯ. Этот файл — только chat-consultant-v2/.
 */

// ─── Контракты ───────────────────────────────────────────────────────────────

export type QueryAttemptForm =
  | "as_is_ru"
  | "lexicon_canonical"
  | "en_translation"
  | "kk_off";

export interface QueryAttempt {
  /** Какая ступень expansion породила эту форму. */
  form: QueryAttemptForm;
  /** Текст запроса для передачи в search.ts. */
  text: string;
  /**
   * Опциональная диагностика — что именно изменилось.
   * Для lexicon_canonical: список применённых замен (term → canonical).
   * Для en_translation: исходник (= as_is_ru.text).
   * Для as_is_ru: undefined.
   */
  meta?: Record<string, unknown>;
}

export type SkipReason =
  | "lexicon_empty"          // словарь пуст в app_settings.lexicon_json
  | "lexicon_no_match"       // словарь есть, но ни один токен не совпал
  | "lexicon_identity"       // замены произошли, но текст не изменился (deduped)
  | "en_translation_off"     // флаг deps.enableEnTranslation = false
  | "en_translation_failed"  // LLM упал или вернул мусор
  | "en_translation_identity"// перевод == оригинал (нечего добавлять)
  | "kk_off";                // §9.2b: ступень выключена по умолчанию

export interface ExpansionResult {
  /**
   * Упорядоченный список попыток (1..4). Минимум один элемент (as_is_ru).
   * Search.ts (Этап 6D) перебирает по порядку, останавливаясь на первой
   * успешной (status='ok' или 'soft_fallback').
   */
  attempts: QueryAttempt[];
  /** Что было пропущено и почему (для метрик query_expansion_*). */
  skipped: SkipReason[];
  /** Длительность всей expansion-стадии. */
  ms: number;
}

export interface ExpansionDeps {
  /**
   * Получить актуальный lexicon из app_settings.lexicon_json.
   * Формат: { "<lowercased_term_or_phrase>": "<canonical_form>" }.
   * Если колонка пуста или ошибка чтения — вернуть {}.
   */
  getLexicon: () => Promise<Record<string, string>>;

  /**
   * Перевод запроса на английский через OpenRouter (Gemini).
   * Реализация: см. createProductionExpansionDeps().
   * Должна вернуть строку или null (если перевод нецелесообразен/ошибка).
   * НЕ должна бросать — оборачивайте try/catch внутри.
   */
  translateToEnglish: (queryRu: string) => Promise<string | null>;

  /** §9.2b: ступень kk_translation выключена по умолчанию. */
  enableKkTranslation?: boolean;

  /** Можно отключить англ. перевод (например, когда LLM-бюджет исчерпан). */
  enableEnTranslation?: boolean;

  /** Структурированный лог для traceId. */
  log?: (event: string, data?: Record<string, unknown>) => void;
}

export interface ExpansionInput {
  query: string;
  locale?: "ru" | "kk" | "en"; // default 'ru'
  traceId: string;
}

// ─── Lexicon: применение замен ──────────────────────────────────────────────
// Алгоритм (детерминированный, без LLM):
//   1. Нормализовать запрос: lowercase + collapse spaces.
//   2. Сначала пробовать многословные ключи (длинее → раньше) через простую
//      замену по границе слова. Это решает кейс «тёплый пол» → «теплый пол»
//      (если такой ключ есть в lexicon) до однословных.
//   3. Затем — однословные ключи.
//   4. Если ни одна замена не сработала → skipped: 'lexicon_no_match'.
//   5. Если применённый текст совпадает с as_is (с учётом нормализации
//      пробелов) → skipped: 'lexicon_identity' (избегаем дубликат attempt).

interface LexicalApply {
  text: string;
  appliedReplacements: Array<{ from: string; to: string }>;
}

export function applyLexicon(
  query: string,
  lexicon: Record<string, string>,
): LexicalApply {
  const applied: Array<{ from: string; to: string }> = [];
  if (!query) return { text: "", appliedReplacements: [] };

  // Сортируем ключи по убыванию длины — длинные фразы матчатся первыми,
  // чтобы «тёплый пол» победил «пол».
  const keys = Object.keys(lexicon).sort((a, b) => b.length - a.length);
  let result = query;

  for (const key of keys) {
    const canonical = lexicon[key];
    if (!key || typeof canonical !== "string" || !canonical) continue;

    // Word-boundary match с поддержкой кириллицы (\b не работает с не-ASCII):
    // используем lookarounds на не-буквенно-цифровые символы.
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // (?<![\p{L}\p{N}_]) и (?![\p{L}\p{N}_]) = unicode-aware word boundary
    const re = new RegExp(
      `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`,
      "giu",
    );

    const before = result;
    result = result.replace(re, canonical);
    if (result !== before) {
      applied.push({ from: key, to: canonical });
    }
  }

  // Collapse внутренних повторных пробелов (могут возникнуть после замен).
  result = result.replace(/\s+/g, " ").trim();
  return { text: result, appliedReplacements: applied };
}

// ─── Главная функция ─────────────────────────────────────────────────────────

export async function expandQuery(
  input: ExpansionInput,
  deps: ExpansionDeps,
): Promise<ExpansionResult> {
  const t0 = Date.now();
  const log = deps.log ?? (() => {});
  const skipped: SkipReason[] = [];
  const attempts: QueryAttempt[] = [];

  const original = (input.query ?? "").trim();
  // Нормализованная база для сравнения «изменилось ли» — collapse пробелов.
  const asIsNormalized = original.replace(/\s+/g, " ");

  // ── 1. as_is_ru — всегда первый ──────────────────────────────────────────
  attempts.push({ form: "as_is_ru", text: asIsNormalized });
  log("expansion.as_is_ru", { text: asIsNormalized, traceId: input.traceId });

  // ── 2. lexicon_canonical ─────────────────────────────────────────────────
  let lexicon: Record<string, string> = {};
  try {
    lexicon = await deps.getLexicon();
  } catch (err) {
    log("expansion.lexicon.error", {
      message: (err as Error).message,
      traceId: input.traceId,
    });
    lexicon = {};
  }

  if (!lexicon || Object.keys(lexicon).length === 0) {
    skipped.push("lexicon_empty");
  } else {
    const lex = applyLexicon(asIsNormalized, lexicon);
    if (lex.appliedReplacements.length === 0) {
      skipped.push("lexicon_no_match");
    } else if (lex.text === asIsNormalized) {
      // Замены произошли (например, term → сам себе нормализованный),
      // но финальный текст идентичен → не плодим дубликат.
      skipped.push("lexicon_identity");
    } else {
      attempts.push({
        form: "lexicon_canonical",
        text: lex.text,
        meta: { replacements: lex.appliedReplacements },
      });
      log("expansion.lexicon_canonical", {
        text: lex.text,
        replacements: lex.appliedReplacements,
        traceId: input.traceId,
      });
    }
  }

  // ── 3. en_translation ────────────────────────────────────────────────────
  if (deps.enableEnTranslation === false) {
    skipped.push("en_translation_off");
  } else {
    try {
      const en = await deps.translateToEnglish(asIsNormalized);
      if (!en || typeof en !== "string" || !en.trim()) {
        skipped.push("en_translation_failed");
      } else {
        const enTrim = en.trim().replace(/\s+/g, " ");
        // Проверка идентичности: если перевод по сути равен оригиналу
        // (с учётом case) — не добавляем.
        if (enTrim.toLowerCase() === asIsNormalized.toLowerCase()) {
          skipped.push("en_translation_identity");
        } else {
          attempts.push({
            form: "en_translation",
            text: enTrim,
            meta: { source: asIsNormalized },
          });
          log("expansion.en_translation", {
            text: enTrim,
            traceId: input.traceId,
          });
        }
      }
    } catch (err) {
      log("expansion.en_translation.error", {
        message: (err as Error).message,
        traceId: input.traceId,
      });
      skipped.push("en_translation_failed");
    }
  }

  // ── 4. kk_off (§9.2b: выключено по умолчанию) ────────────────────────────
  if (deps.enableKkTranslation === true) {
    // Future: когда включат — тут будет deps.translateToKazakh.
    // Сейчас — даже при флаге=true честно пропускаем, потому что нет
    // переводчика в deps. Лучше явный skip, чем тихий no-op.
    skipped.push("kk_off");
  } else {
    skipped.push("kk_off");
  }

  return {
    attempts,
    skipped,
    ms: Date.now() - t0,
  };
}

// ─── Production deps factory ─────────────────────────────────────────────────
// OpenRouter (Gemini) для en-translation. Lexicon — из app_settings.lexicon_json.
// Используется в S_CATALOG branch (Этап 6E).

export interface ProductionExpansionDepsConfig {
  supabase: {
    from: (table: string) => {
      select: (cols: string) => {
        limit: (n: number) => Promise<{
          data: Array<{ lexicon_json: Record<string, string> | null }> | null;
          error: { message?: string } | null;
        }>;
      };
    };
  };
  openRouterKey: string;
  /** Модель для перевода — лёгкая (flash-lite). */
  translationModel?: string;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

const TRANSLATION_PROMPT_SYSTEM =
  "You translate Russian product search queries to English. " +
  "Rules: (1) Keep brand names unchanged. (2) Translate generic terms. " +
  "(3) Keep numbers and units (W, V, mm, kg) unchanged. " +
  "(4) Output ONLY the translation, no explanations, no quotes, no prefix. " +
  "(5) If query is already English or untranslatable, output it unchanged. " +
  "(6) Maximum 12 words.";

export function createProductionExpansionDeps(
  cfg: ProductionExpansionDepsConfig,
): ExpansionDeps {
  const log = cfg.log ?? (() => {});
  const model = cfg.translationModel ?? "google/gemini-2.5-flash-lite";

  return {
    enableEnTranslation: true,
    enableKkTranslation: false, // §9.2b kk_off

    log,

    getLexicon: async () => {
      try {
        const { data, error } = await cfg.supabase
          .from("app_settings")
          .select("lexicon_json")
          .limit(1);
        if (error) {
          log("expansion.lexicon.read_error", { message: error.message });
          return {};
        }
        const raw = data?.[0]?.lexicon_json;
        if (!raw || typeof raw !== "object") return {};
        // Sanitize: только string→string пары, lowercase ключей.
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(raw)) {
          if (typeof k === "string" && typeof v === "string" && k.trim() && v.trim()) {
            out[k.toLowerCase().trim()] = v.trim();
          }
        }
        return out;
      } catch (e) {
        log("expansion.lexicon.exception", { message: (e as Error).message });
        return {};
      }
    },

    translateToEnglish: async (queryRu) => {
      if (!cfg.openRouterKey) return null;
      try {
        const resp = await fetch(
          "https://openrouter.ai/api/v1/chat/completions",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${cfg.openRouterKey}`,
            },
            body: JSON.stringify({
              model,
              temperature: 0,
              max_tokens: 60,
              messages: [
                { role: "system", content: TRANSLATION_PROMPT_SYSTEM },
                { role: "user", content: queryRu },
              ],
            }),
          },
        );
        if (!resp.ok) {
          log("expansion.en_translation.http_error", {
            status: resp.status,
          });
          return null;
        }
        const json = await resp.json();
        const text = json?.choices?.[0]?.message?.content;
        if (typeof text !== "string") return null;
        // Sanitize: убираем кавычки, обёртки, переводы строк.
        return text.replace(/^["'`«»]+|["'`«»]+$/g, "").trim();
      } catch (e) {
        log("expansion.en_translation.exception", {
          message: (e as Error).message,
        });
        return null;
      }
    },
  };
}
