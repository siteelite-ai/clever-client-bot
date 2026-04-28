/**
 * Stage 2 — Step 6: Pipeline Orchestrator (S0 → S1 → S2 → S3)
 * Источник: spec §3.2 (state machine), §5.2 (greetings short-circuit),
 *           §3.3 (Slot, Intent, ConversationState, PipelineTrace).
 *
 * Чистая функция: на вход — ChatRequest и DI-зависимости (для S2 LLM/cache),
 * на выход — PipelineDecision (что должен сделать caller: какой route выполнить,
 * какое сообщение взять, какой обновлённый state записать клиенту).
 *
 * НЕ выполняет S_* станции — это задача Шагов 7+. Здесь только маршрутизация.
 *
 * Контракт связывания (буква спеки §3.2):
 *   1. S0 всегда первым: preprocess + history trim.
 *   2. is_pure_greeting (§5.2 уровень 1) → short-circuit в S_GREETING:
 *      ни S1, ни S2 не вызываются («перехватываем без вызова LLM»).
 *   3. S1 на cleaned_message:
 *        match  → S3 получает синтетический Intent с intent='catalog'
 *                 (слот несёт намерение по §3.3 SlotType: все четыре типа
 *                 продолжают каталоговый поток); S2 пропускается.
 *        miss   → переходим к S2.
 *   4. S2 классифицирует cleaned_message → Intent.
 *   5. S3 — детерминированный диспетчер по Intent.
 *
 * Ошибки:
 *   - S2 уже сам делает safe fallback (см. s2-intent-classifier).
 *   - Если что-то невосстановимо упало в S0/S1 — orchestrator пробрасывает
 *     наверх (caller отдаст SSE error).
 */

import type {
  ChatRequest,
  ConversationState,
  Intent,
  PipelineTrace,
  Slot,
  SlotState,
} from './types.ts';
import { DEFAULT_SLOT_STATE } from './types.ts';
import { s0Preprocess } from './s0-preprocess.ts';
import { s1SlotResolver, type S1Match } from './s1-slot-resolver.ts';
import { classifyIntent, safeFallbackIntent, type ClassifierDeps } from './s2-intent-classifier.ts';
import { routeIntent, type Route } from './s3-router.ts';

// ─── Контракт результата orchestrator'а ──────────────────────────────────────

export interface PipelineDecision {
  /** Какой S_* маршрут должен выполнить caller. */
  route: Route;
  /**
   * Что подавать на вход исполнителю маршрута.
   * Это уже очищенный текст (без приветствия) и, если был slot match —
   * текст с восстановленным контекстом слота.
   */
  effective_message: string;
  /** Intent, выбранный/синтезированный пайплайном. Передаётся в S_*. */
  intent: Intent;
  /** Если slot был сматчен — здесь его слепок (для S_CATALOG continuation). */
  slot_match: S1Match | null;
  /**
   * Обновлённый ConversationState для отправки клиенту в SSE done.
   * - закрытые слоты удалены
   * - turns_since_created проинкрементирован у переживших ход
   * - last_intent обновлён
   */
  next_state: ConversationState;
  /** Внутренняя диагностика, не уходит в публичный API. */
  trace: PipelineTrace;
  /**
   * Был ли использован safe fallback в S2 (LLM упал/мусор).
   * Caller может поднять метрику `s2_fallback_total`.
   */
  s2_used_fallback: boolean;
}

export interface OrchestratorDeps {
  /** DI для S2 — см. s2-intent-classifier.ts. */
  classifier: ClassifierDeps;
  /** Источник времени (для тестов). */
  now?: () => number;
  /** Источник traceId (для тестов). По умолчанию crypto.randomUUID. */
  newTraceId?: () => string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Синтетический Intent для случая slot match.
 * Слот по §3.3 всегда уточняет КАТАЛОГОВЫЙ поток (category_disambiguation,
 * price_clarify, replacement_offer, contact_collect). Первые три — catalog,
 * последний — escalation/contact продолжение, но в нашем MVP каталог-сцены
 * это catalog. Для contact_collect возвращаем escalation, чтобы caller
 * собрал контакт.
 *
 * domain_check='in_domain' принудительно: раз слот существует, мы уже
 * прошли domain check на предыдущем ходе.
 */
function synthIntentFromSlot(match: S1Match): Intent {
  const slotType = match.matched_slot.type;
  const isContact = slotType === 'contact_collect';
  return {
    intent: isContact ? 'escalation' : 'catalog',
    has_sku: false,
    sku_candidate: null,
    price_intent: null,
    category_hint: match.matched_slot.pending_query || null,
    search_modifiers: match.matched_slot.pending_modifiers ?? [],
    critical_modifiers: [],
    is_replacement: slotType === 'replacement_offer',
    domain_check: 'in_domain',
  };
}

/** Заглушка-Intent для is_pure_greeting (S2 не вызываем). */
function greetingIntent(): Intent {
  return {
    intent: 'greeting',
    has_sku: false,
    sku_candidate: null,
    price_intent: null,
    category_hint: null,
    search_modifiers: [],
    critical_modifiers: [],
    is_replacement: false,
    domain_check: 'in_domain',
  };
}

function defaultTraceId(): string {
  // Deno + браузеры поддерживают randomUUID; добавим fallback на всякий.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `tr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

// ─── Главная функция ─────────────────────────────────────────────────────────

export async function runPipeline(
  req: ChatRequest,
  deps: OrchestratorDeps,
): Promise<PipelineDecision> {
  const now = deps.now ?? Date.now;
  const traceId = (deps.newTraceId ?? defaultTraceId)();
  const incomingState: ConversationState = req.state ?? {
    conversation_id: 'unknown',
    slots: [],
    slot_state: { ...DEFAULT_SLOT_STATE },
  };
  // §3.3 + §5.6.1: гарантируем slot_state — даже если клиент не прислал
  // (backward-compat). Стрик меняется только в S_CATALOG branch (Этап 6E),
  // orchestrator его НЕ модифицирует — только пробрасывает.
  const carriedSlotState: SlotState = incomingState.slot_state ?? { ...DEFAULT_SLOT_STATE };

  // ── S0 ─────────────────────────────────────────────────────────────────
  const s0 = s0Preprocess(req.message ?? '', req.history);
  const trace: PipelineTrace = {
    traceId,
    s0_preprocess: {
      stripped_greeting: s0.stripped_greeting,
      cleaned_message: s0.cleaned_message,
      history_count: s0.trimmed_history.length,
    },
  };

  // ── Short-circuit: pure greeting (§5.2 уровень 1) ──────────────────────
  if (s0.is_pure_greeting) {
    const intent = greetingIntent();
    const decision = routeIntent(intent);
    trace.s3_router = { route: intent.intent };
    return {
      route: decision.route,
      effective_message: '',
      intent,
      slot_match: null,
      next_state: {
        ...incomingState,
        slots: incomingState.slots ?? [],
        slot_state: carriedSlotState,
        last_intent: 'greeting',
      },
      trace,
      s2_used_fallback: false,
    };
  }

  // ── S1 — slot resolver ─────────────────────────────────────────────────
  const s1 = s1SlotResolver(s0.cleaned_message, incomingState.slots, now());
  trace.s1_slot_resolver = {
    had_active_slot: s1.had_active_slot,
    matched_slot_id: s1.match?.matched_slot.id ?? null,
    closed_slots: s1.closed_slots.map((c) => ({ id: c.slot.id, reason: c.reason })),
  };

  // Если матч есть — синтезируем Intent из слота, S2 НЕ вызываем
  if (s1.match) {
    const intent = synthIntentFromSlot(s1.match);
    const decision = routeIntent(intent);
    trace.s3_router = { route: intent.intent };

    const nextSlots: Slot[] = s1.remaining_slots; // matched уже исключён
    return {
      route: decision.route,
      effective_message: s1.match.cleaned_query || s0.cleaned_message,
      intent,
      slot_match: s1.match,
      next_state: {
        ...incomingState,
        slots: nextSlots,
        slot_state: carriedSlotState,
        last_intent: intent.intent,
      },
      trace,
      s2_used_fallback: false,
    };
  }

  // ── S2 — Intent Classifier ─────────────────────────────────────────────
  const t2_0 = now();
  const s2 = await classifyIntent(s0.cleaned_message, s0.language, deps.classifier);
  trace.s2_intent_classifier = {
    cache_hit: s2.cache_hit,
    intent: s2.intent,
    latency_ms: now() - t2_0,
  };

  // ── S3 — Router ─────────────────────────────────────────────────────────
  let intent = s2.intent;
  // Защитный пояс: если S2 каким-то чудом вернул мусор — safeFallback
  // (validateIntent в S2 уже это делает, но дополнительная проверка дешёвая).
  try {
    const decision = routeIntent(intent);
    trace.s3_router = { route: intent.intent };

    return {
      route: decision.route,
      effective_message: s0.cleaned_message,
      intent,
      slot_match: null,
      next_state: {
        ...incomingState,
        slots: s1.remaining_slots,
        slot_state: carriedSlotState,
        last_intent: intent.intent,
        last_category_hint: intent.category_hint ?? incomingState.last_category_hint,
      },
      trace,
      s2_used_fallback: s2.used_fallback,
    };
  } catch (err) {
    console.error(`[v2.orchestrator] S3 routing failed: ${(err as Error).message}`);
    intent = safeFallbackIntent(s0.cleaned_message);
    const decision = routeIntent(intent);
    trace.s3_router = { route: intent.intent };
    return {
      route: decision.route,
      effective_message: s0.cleaned_message,
      intent,
      slot_match: null,
      next_state: {
        ...incomingState,
        slots: s1.remaining_slots,
        slot_state: carriedSlotState,
        last_intent: intent.intent,
      },
      trace,
      s2_used_fallback: true,
    };
  }
}
