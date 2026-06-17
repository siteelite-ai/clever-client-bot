// V3 shared types — minimal, data-agnostic.

export interface ProductRef {
  id: string;
  pagetitle: string;
  vendor: string | null;
  price: number;
  stock: "in_stock" | "low" | "out" | "unknown";
  short_traits: string[];
}

export interface ProductFull extends ProductRef {
  url: string;
}

export type ToolName =
  | "search_catalog"
  | "expand_search_to_pool"
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
  side_effects?: ToolSideEffect[];
}

export interface ExpandPoolOk {
  ok: true;
  total: number;
  results: ProductRef[];
  branch_tag:
    | "qfv2_final"
    | "qfv2_pool_rescue"
    | "qfv2_honest_empty"
    | "qfv2_jargon_recovery";
  applied_facets?: Array<{ key: string; values: string[]; alternative_values?: string[] }>;
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
  | (ExpandPoolOk & { tool: "expand_search_to_pool" } & WithSideEffects)
  | (LookupKnowledgeOk & { tool: "lookup_knowledge" } & WithSideEffects)
  | (LookupContactsOk & { tool: "lookup_contacts" } & WithSideEffects)
  | (RenderProductsOk & { tool: "render_products" } & WithSideEffects)
  | (ProposeClarificationOk & { tool: "propose_clarification" } & WithSideEffects)
  | (EscalateOk & { tool: "escalate_to_manager" } & WithSideEffects)
  | (NoteStateOk & { tool: "note_state" } & WithSideEffects)
  | (ToolError & { tool: ToolName } & WithSideEffects);

/**
 * Per-turn cache: id → full product. Filled by search_catalog / expand_search_to_pool,
 * read by render_products. Ensures anti-hallucination invariant.
 */
export type ProductCache = Map<string, ProductFull>;
