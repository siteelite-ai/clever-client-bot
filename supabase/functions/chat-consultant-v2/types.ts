/**
 * Stage 2 — Data Contracts
 * Источник: .lovable/specs/chat-consultant-v2-spec.md §3.3
 *
 * ВАЖНО: эти типы — точная калька из спецификации. Любое расхождение
 * со спекой = баг. Не добавлять/удалять поля без правки спеки.
 */

// ─── Slot ────────────────────────────────────────────────────────────────────
// §3.3 Slot
export type SlotType =
  | 'category_disambiguation'   // выбор между похожими категориями
  | 'price_clarify'             // сужение перед сортировкой по цене
  | 'replacement_offer'         // выбор замены
  | 'contact_collect';          // сбор контактов для эскалации

export interface SlotOption {
  label: string;                                   // что показываем пользователю
  value: string;                                   // что подставляем во внутреннюю логику
  payload?: Record<string, unknown>;               // для category_disambiguation: pagetitle, categoryId
}

export type SlotClosedReason =
  | 'matched'
  | 'no_match'
  | 'ttl_turns'
  | 'ttl_time'
  | 'new_intent';

export interface Slot {
  id: string;                                      // slot_<timestamp>_<rand>
  type: SlotType;
  created_at: number;                              // unix ms
  expires_at: number;                              // hard TTL: created_at + 5*60*1000
  ttl_turns: number;                               // 2 хода без матча → close
  turns_since_created: number;                     // инкрементируется на каждом запросе

  options: SlotOption[];
  pending_query: string;                           // оригинальный запрос пользователя
  pending_modifiers: string[];                     // модификаторы вне категории
  pending_filters: Record<string, string[]> | null; // уже выбранные фильтры

  consumed: boolean;                               // true → удалить из state
  closed_reason?: SlotClosedReason;
}

// ─── Intent ──────────────────────────────────────────────────────────────────
// §3.3 Intent (см. также §3.2 S2: Intent Classifier)
export type IntentType =
  | 'catalog'
  | 'knowledge'
  | 'contact'
  | 'escalation'
  | 'smalltalk'
  | 'greeting';

export type PriceIntent = 'cheapest' | 'expensive' | 'range' | null;

export type DomainCheck = 'in_domain' | 'out_of_domain' | 'ambiguous';

export interface Intent {
  intent: IntentType;
  has_sku: boolean;
  sku_candidate: string | null;
  price_intent: PriceIntent;
  price_range?: { min?: number; max?: number };
  category_hint: string | null;
  search_modifiers: string[];
  critical_modifiers: string[];
  is_replacement: boolean;
  domain_check: DomainCheck;
}

// ─── Product (упрощённая карточка) ───────────────────────────────────────────
// §3.3 Product
// Примечание: в Catalog API возможен Product.name=null → используем pagetitle
// (см. mem://architecture/catalog-api-quirks). Здесь это уже нормализованный
// внутренний вид, поле `name` гарантированно непустое.
export interface Product {
  id: number;
  name: string;
  url: string;
  price: number;
  currency: 'KZT';
  brand: string | null;
  sku: string | null;
  category_path: { name: string; url: string }[];
  warehouses: { city: string; qty: number }[];
  soputstvuyuschiy?: string[];                     // SKU сопутствующих
  fayl?: string[];                                 // PDF/файлы
}

// ─── ConversationState (передаётся клиентом) ─────────────────────────────────
// §3.3 ConversationState
export interface ConversationState {
  conversation_id: string;
  slots: Slot[];                                   // активные слоты, max 3
  last_intent?: IntentType;
  last_category_hint?: string;
  user_city?: string;
  user_country?: string;
}

// ─── ChatRequest / ChatResponse ──────────────────────────────────────────────
// §3.3 ChatRequest
export interface ChatHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatClientMeta {
  ip?: string;
  user_agent?: string;
  referer?: string;
}

export interface ChatRequest {
  message: string;
  history: ChatHistoryMessage[];
  state: ConversationState;
  client_meta: ChatClientMeta;
}

// §3.3 ChatResponseSSE — строго описанный набор событий SSE-стрима.
// event: slot_update     data: { slots: Slot[] }
// event: thinking        data: { phrase: string }
// event: chunk           data: { delta: string }
// event: done            data: { usage: {...}, traceId: string }
// event: error           data: { code: string, message: string }
export type SSEEventName =
  | 'slot_update'
  | 'thinking'
  | 'chunk'
  | 'done'
  | 'error';

export interface SSESlotUpdateData { slots: Slot[]; }
export interface SSEThinkingData   { phrase: string; }
export interface SSEChunkData      { delta: string; }
export interface SSEDoneData {
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    model?: string;
  };
  traceId: string;
}
export interface SSEErrorData      { code: string; message: string; }

// ─── Internal: pipeline trace ────────────────────────────────────────────────
// Не из §3.3 — служебная структура для внутренней диагностики state machine
// (S0→S1→S2→S3). НЕ выходит наружу как контракт API. Используется только
// в логах и (опционально) в админ-диагностике.
export interface PipelineTrace {
  traceId: string;
  s0_preprocess?: {
    stripped_greeting: boolean;
    cleaned_message: string;
    history_count: number;
  };
  s1_slot_resolver?: {
    had_active_slot: boolean;
    matched_slot_id: string | null;
    closed_slots: { id: string; reason: SlotClosedReason }[];
  };
  s2_intent_classifier?: {
    cache_hit: boolean;
    intent: Intent;
    latency_ms: number;
  };
  s3_router?: {
    route: IntentType;
  };
}
