/**
 * Stage 2 — S1: Slot Resolver
 * Источник: spec §3.2 (S1) + §3.3 (Slot).
 *
 * Контракт §3.2 S1:
 *   Active slot exists?
 *   ├─ YES → match user input against options
 *   │        ├─ MATCH → consume slot, route to S3 with cleaned query
 *   │        │           (modifiers preserved, option-text removed)
 *   │        └─ NO MATCH → mark slot stale, close it, fall to S2
 *   └─ NO  → S2
 *
 * §3.3 Slot:
 *   - hard TTL: created_at + 5*60*1000  → close (reason: 'ttl_time')
 *   - ttl_turns: 2 хода без матча       → close (reason: 'ttl_turns')
 *   - turns_since_created инкрементируется на КАЖДОМ запросе
 *
 * Чистые функции — никаких внешних вызовов. Время и rng инжектируются для тестов.
 */

import type { Slot, SlotOption, SlotClosedReason } from './types.ts';

export const SLOT_HARD_TTL_MS = 5 * 60 * 1000; // §3.3
export const SLOT_TTL_TURNS = 2;               // §3.3
export const SLOTS_MAX = 3;                    // §3.3 ConversationState.slots max 3

export interface S1Match {
  matched_slot: Slot;
  matched_option: SlotOption;
  /**
   * Очищенный запрос для S3: исходный pending_query + модификаторы
   * пользователя минус текст выбранной опции.
   * Спека: «cleaned query (modifiers preserved, option-text removed)».
   */
  cleaned_query: string;
}

export interface S1Result {
  /** Найден ли матч между сообщением и активным слотом. */
  match: S1Match | null;
  /** Слоты, закрытые на этом шаге (ttl/no_match). НЕ включают consumed. */
  closed_slots: { slot: Slot; reason: SlotClosedReason }[];
  /** Слоты, которые остаются активными в state после S1. */
  remaining_slots: Slot[];
  /** Был ли в state хотя бы один активный слот на момент входа. */
  had_active_slot: boolean;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function normalize(s: string): string {
  return (s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

/**
 * Матч сообщения против опций слота.
 * Правила (детерминированные, без LLM):
 *   1. Точное совпадение нормализованного value или label → win
 *   2. Сообщение содержит нормализованный label как подстроку → win
 *   3. Сообщение — короткий ответ-индекс ("1", "2", "первый", "второй", "третий")
 *      → выбираем опцию по индексу
 * Возвращает null, если ни одно правило не сработало.
 */
export function matchOption(message: string, options: SlotOption[]): SlotOption | null {
  const m = normalize(message);
  if (!m || options.length === 0) return null;

  // (1) exact value/label
  for (const opt of options) {
    if (m === normalize(opt.value) || m === normalize(opt.label)) return opt;
  }
  // (2) substring by label (label обычно человекочитаем)
  for (const opt of options) {
    const lab = normalize(opt.label);
    if (lab && m.includes(lab)) return opt;
  }
  // (3) numeric / ordinal
  const ordinalMap: Record<string, number> = {
    '1': 0, 'первый': 0, 'первая': 0, 'первое': 0,
    '2': 1, 'второй': 1, 'вторая': 1, 'второе': 1,
    '3': 2, 'третий': 2, 'третья': 2, 'третье': 2,
  };
  if (m in ordinalMap) {
    const idx = ordinalMap[m];
    if (idx < options.length) return options[idx];
  }
  return null;
}

/**
 * Убирает текст выбранной опции из сообщения, сохраняя оставшиеся
 * пользовательские модификаторы. Используется для построения cleaned_query.
 */
function buildCleanedQuery(slot: Slot, message: string, chosen: SlotOption): string {
  const base = slot.pending_query ?? '';
  const userExtras = normalize(message);
  const optTokens = new Set([normalize(chosen.label), normalize(chosen.value)]);

  // Берём из сообщения только то, чего НЕТ в опции и НЕТ уже в pending_query.
  const baseNorm = normalize(base);
  const extraTokens = userExtras
    .split(' ')
    .filter((t) => t && !optTokens.has(t) && !baseNorm.split(' ').includes(t));

  const modifiers = (slot.pending_modifiers ?? []).join(' ').trim();
  const parts = [base, modifiers, extraTokens.join(' ')]
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

// ─── S1 main ─────────────────────────────────────────────────────────────────

export function s1SlotResolver(
  message: string,
  slots: Slot[] | undefined,
  now: number = Date.now(),
): S1Result {
  const incoming = Array.isArray(slots) ? slots : [];
  const had_active_slot = incoming.some((s) => !s.consumed);

  // Шаг A: на каждом ходе инкрементируем turns_since_created у всех активных
  // слотов. Это требование §3.3 ("инкрементируется на каждом запросе").
  const ticked: Slot[] = incoming
    .filter((s) => !s.consumed)
    .map((s) => ({ ...s, turns_since_created: (s.turns_since_created ?? 0) + 1 }));

  // Шаг B: Hard TTL по времени → close('ttl_time') немедленно.
  const closed: { slot: Slot; reason: SlotClosedReason }[] = [];
  const aliveAfterTime: Slot[] = [];
  for (const s of ticked) {
    if (now >= s.expires_at) {
      closed.push({
        slot: { ...s, consumed: true, closed_reason: 'ttl_time' },
        reason: 'ttl_time',
      });
    } else {
      aliveAfterTime.push(s);
    }
  }

  // Шаг C: пытаемся матчить по самому свежему слоту первым (LIFO).
  const ordered = [...aliveAfterTime].sort((a, b) => b.created_at - a.created_at);

  let match: S1Match | null = null;
  const consumedIds = new Set<string>();

  for (const slot of ordered) {
    const chosen = matchOption(message, slot.options);
    if (chosen) {
      const cleaned_query = buildCleanedQuery(slot, message, chosen);
      const consumedSlot: Slot = {
        ...slot,
        consumed: true,
        closed_reason: 'matched',
      };
      match = { matched_slot: consumedSlot, matched_option: chosen, cleaned_query };
      closed.push({ slot: consumedSlot, reason: 'matched' });
      consumedIds.add(slot.id);
      break; // §3.2: матчим только один слот за ход
    }
  }

  // Шаг D: если не было матча → закрываем слоты, у которых ttl_turns исчерпан.
  // Если матч БЫЛ — оставшиеся слоты не трогаем (они доживают свой turn-count).
  const remaining_slots: Slot[] = [];
  for (const slot of aliveAfterTime) {
    if (consumedIds.has(slot.id)) continue;
    if (!match && slot.turns_since_created >= SLOT_TTL_TURNS) {
      closed.push({
        slot: { ...slot, consumed: true, closed_reason: 'ttl_turns' },
        reason: 'ttl_turns',
      });
    } else {
      remaining_slots.push(slot);
    }
  }

  // Шаг E: жёсткий cap на количество слотов (§3.3: max 3).
  // Если кто-то добавит слот выше — отрежем самые старые. Здесь S1 ничего
  // не добавляет, но защита на всякий случай.
  while (remaining_slots.length > SLOTS_MAX) {
    const oldest = remaining_slots.reduce((a, b) =>
      a.created_at <= b.created_at ? a : b,
    );
    const idx = remaining_slots.indexOf(oldest);
    remaining_slots.splice(idx, 1);
    closed.push({
      slot: { ...oldest, consumed: true, closed_reason: 'new_intent' },
      reason: 'new_intent',
    });
  }

  return { match, closed_slots: closed, remaining_slots, had_active_slot };
}

// ─── фабрика для тестов и для будущего S_CATALOG, который порождает слоты ───
export interface NewSlotInput {
  type: Slot['type'];
  options: SlotOption[];
  pending_query: string;
  pending_modifiers?: string[];
  pending_filters?: Record<string, string[]> | null;
  now?: number;
  id?: string;
}
export function createSlot(input: NewSlotInput): Slot {
  const now = input.now ?? Date.now();
  const id =
    input.id ??
    `slot_${now}_${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    type: input.type,
    created_at: now,
    expires_at: now + SLOT_HARD_TTL_MS,
    ttl_turns: SLOT_TTL_TURNS,
    turns_since_created: 0,
    options: input.options,
    pending_query: input.pending_query,
    pending_modifiers: input.pending_modifiers ?? [],
    pending_filters: input.pending_filters ?? null,
    consumed: false,
  };
}
