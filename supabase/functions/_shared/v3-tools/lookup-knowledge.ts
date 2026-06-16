// V3 tool: lookup_knowledge — hybrid search over knowledge_chunks via RPC.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import type { LookupKnowledgeOk, ToolError } from "./types.ts";

export interface LookupKnowledgeInput {
  query: string;
  top_k?: number;
}

interface HybridRow {
  entry_id: string;
  chunk_id: string;
  title: string | null;
  content: string | null;
  type: string | null;
  source_url: string | null;
  score: number | null;
}

function snippetOf(content: string, maxLen = 320): string {
  const clean = content.replace(/\s+/g, " ").trim();
  return clean.length <= maxLen ? clean : clean.slice(0, maxLen) + "…";
}

export async function executeLookupKnowledge(
  input: LookupKnowledgeInput,
  supabase: SupabaseClient,
): Promise<(LookupKnowledgeOk & { tool: "lookup_knowledge" }) | (ToolError & { tool: "lookup_knowledge" })> {
  const q = (input.query ?? "").trim();
  if (!q) {
    return { tool: "lookup_knowledge", ok: false, error_code: "bad_input", message: "empty query" };
  }
  const topK = Math.min(Math.max(input.top_k ?? 5, 1), 10);

  try {
    // Hybrid search WITHOUT embedding (FTS-only path).
    // Embeddings could be added later via Gemini Embedding 001 if needed.
    const { data, error } = await supabase.rpc("search_knowledge_chunks_hybrid", {
      search_query: q,
      query_embedding: null,
      match_count: topK,
      max_chunks_per_entry: 2,
    });

    if (error) {
      return {
        tool: "lookup_knowledge",
        ok: false,
        error_code: "knowledge_unavailable",
        message: error.message,
      };
    }

    const rows = (data ?? []) as HybridRow[];
    return {
      tool: "lookup_knowledge",
      ok: true,
      hits: rows.map((r) => ({
        title: r.title ?? "",
        snippet: snippetOf(r.content ?? ""),
        source_url: r.source_url,
        type: r.type ?? "general",
        score: Number(r.score ?? 0),
      })),
    };
  } catch (e) {
    return {
      tool: "lookup_knowledge",
      ok: false,
      error_code: "knowledge_unavailable",
      message: (e as Error)?.message ?? "rpc failed",
    };
  }
}
