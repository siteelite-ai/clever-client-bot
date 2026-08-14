// V3 shared types — minimal, data-agnostic.

export interface ProductRef {
  id: string;
  pagetitle: string;
  vendor: string | null;
  price: number;
  stock: "in_stock" | "low" | "out" | "unknown";
  /**
   * Единица измерения товара ИЗ КАТАЛОГА (характеристика «Единица измерения»): «м», «шт», «компл».
   * Никогда не выдумывается: если API её не отдал — undefined/null.
   * Используется render_products для строки цены (`₸/м`).
   */
  unit?: string | null;
  short_traits: string[];
  /** Pagetitle листовой категории товара (если API его вернул). Источник L₀ для режима «аналог». */
  leaf_category?: string | null;
  /**
   * Складские остатки по городам (из /products.warehouses). Только записи с qty>0,
   * отсортированные по убыванию qty. Пусто/undefined — данных нет (не путать с «нет в наличии»).
   * Используется LLM для ответов «в каком городе / сколько в городе X», и render_products для строки «Наличие».
   */
  warehouses?: Array<{ city: string; qty: number }>;
}

export interface ProductFull extends ProductRef {
  url: string;
}

export type ToolName =
  | "search_catalog"
  | "discover_category"
  | "jargon_recover_catalog"
  | "lookup_knowledge"
  | "lookup_contacts"
  | "render_products"
  | "propose_clarification"
  | "escalate_to_manager"
  | "note_state";

/** Side-channel SSE events tools may want the orchestrator to emit. */
export type ToolSideEffect =
  | { type: "contacts"; html: string }
  | { type: "quick_replies"; replies: Array<{ value: string; label: string }>; facet_key: string }
  | { type: "slot_update"; slots: Record<string, unknown> };

export interface ToolError {
  ok: false;
  error_code:
    | "catalog_timeout"
    | "transport_5xx"
    | "rate_limited"
    | "bad_input"
    | "no_products"
    | "all_zero_price"
    | "knowledge_unavailable"
    | "contacts_unavailable"
    | "internal";
  message: string;
}

export interface SearchCatalogOk {
  ok: true;
  mode: string;
  total: number;
  results: ProductRef[];
  /** Серверные предупреждения (например, anchor_leaf_category_injected:<L₀>). */
  warnings?: string[];
  side_effects?: ToolSideEffect[];
}

export interface DiscoverCategoryOk {
  ok: true;
  category: { id: number | null; pagetitle: string; total_products: number };
  facets: Array<{
    key: string;
    caption: string;
    type: string;
    unit: string | null;
    min?: number | null;
    max?: number | null;
    values: Array<{ value: string; products_count?: number }>;
  }>;
  /** Листовые категории для search_catalog?category=. См. discover-category.ts. */
  leaf_categories: Array<{ id: number; pagetitle: string }>;
  resolved_from?: string;
  side_effects?: ToolSideEffect[];
}


export interface JargonRecoverOk {
  ok: true;
  source_query: string;
  candidates: string[];
  results: ProductRef[];
  matched_query: string | null;
  total: number;
  /**
   * true, если в карточках результата НЕ нашлись все значимые токены исходного запроса
   * (включая modifiers). Значит инструмент вытащил каталог по родственному, но не точному
   * соответствию — LLM не имеет права называть результаты той формой/жаргоном, которые
   * не подтвердились. Должен честно раскрыть unmatched_tokens клиенту.
   */
  partial_match: boolean;
  /** Токены source_query+modifiers, отсутствующие во всех найденных карточках. */
  unmatched_tokens: string[];
  side_effects?: ToolSideEffect[];
}

export interface LookupKnowledgeOk {
  ok: true;
  hits: Array<{
    title: string;
    snippet: string;
    source_url: string | null;
    type: string;
    score: number;
  }>;
  side_effects?: ToolSideEffect[];
}

export interface LookupContactsOk {
  ok: true;
  data: {
    phone?: string;
    address?: string;
    hours?: string;
    payment?: string;
    delivery?: string;
    html_block?: string;
    cities?: string[];
    branches_count?: number;
    requires_city?: boolean;
    matched_city?: string;
    /** Сигнал оркестратору/LLM: тема (доставка/оплата) описана в KB, надо вызвать lookup_knowledge. */
    route_to_knowledge?: boolean;
    hint?: string;
  };
  side_effects?: ToolSideEffect[];
}

export interface RenderProductsOk {
  ok: true;
  rendered_count: number;
  blocked_by_zero_price: number;
  markdown: string;
  side_effects?: ToolSideEffect[];
}

export interface ProposeClarificationOk {
  ok: true;
  slot_id: string;
  side_effects?: ToolSideEffect[];
}

export interface EscalateOk {
  ok: true;
  contact_card: string | null;
  side_effects?: ToolSideEffect[];
}

export interface NoteStateOk {
  ok: true;
  side_effects?: ToolSideEffect[];
}

interface WithSideEffects {
  side_effects?: ToolSideEffect[];
}

export type ToolResult =
  | (SearchCatalogOk & { tool: "search_catalog" } & WithSideEffects)
  | (DiscoverCategoryOk & { tool: "discover_category" } & WithSideEffects)
  | (JargonRecoverOk & { tool: "jargon_recover_catalog" } & WithSideEffects)
  | (LookupKnowledgeOk & { tool: "lookup_knowledge" } & WithSideEffects)
  | (LookupContactsOk & { tool: "lookup_contacts" } & WithSideEffects)
  | (RenderProductsOk & { tool: "render_products" } & WithSideEffects)
  | (ProposeClarificationOk & { tool: "propose_clarification" } & WithSideEffects)
  | (EscalateOk & { tool: "escalate_to_manager" } & WithSideEffects)
  | (NoteStateOk & { tool: "note_state" } & WithSideEffects)
  | (ToolError & { tool: ToolName } & WithSideEffects);

/**
 * Per-turn cache: id → full product. Filled by search_catalog / jargon_recover_catalog,
 * read by render_products. Ensures anti-hallucination invariant.
 */
export type ProductCache = Map<string, ProductFull>;
