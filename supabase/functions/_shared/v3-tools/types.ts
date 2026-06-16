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
  // Reserved for future: image, options, full description.
}

export type ToolName =
  | "search_catalog"
  | "lookup_knowledge"
  | "render_products";

export interface ToolError {
  ok: false;
  error_code:
    | "catalog_timeout"
    | "transport_5xx"
    | "rate_limited"
    | "bad_input"
    | "no_products"
    | "all_zero_price"
    | "knowledge_unavailable";
  message: string;
}

export interface SearchCatalogOk {
  ok: true;
  mode: string;
  total: number;
  results: ProductRef[];
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
}

export interface RenderProductsOk {
  ok: true;
  rendered_count: number;
  blocked_by_zero_price: number;
  markdown: string;
}

export type ToolResult =
  | (SearchCatalogOk & { tool: "search_catalog" })
  | (LookupKnowledgeOk & { tool: "lookup_knowledge" })
  | (RenderProductsOk & { tool: "render_products" })
  | (ToolError & { tool: ToolName });

/**
 * Per-turn cache: id → full product. Filled by search_catalog,
 * read by render_products. Ensures anti-hallucination invariant.
 */
export type ProductCache = Map<string, ProductFull>;
