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
    // 1) Try chunk-level RPC (preferred — gives focused snippets).
    const { data: chunkData, error: chunkErr } = await supabase.rpc("search_knowledge_chunks_hybrid", {
      search_query: q,
      query_embedding: null,
      match_count: topK,
      max_chunks_per_entry: 2,
    });

    if (chunkErr) {
      return {
        tool: "lookup_knowledge",
        ok: false,
        error_code: "knowledge_unavailable",
        message: chunkErr.message,
      };
    }

    let rows = (chunkData ?? []) as HybridRow[];

    // 2) Fallback: most entries don't have chunks generated. Search entries directly.
    if (rows.length === 0) {
      const { data: entryData, error: entryErr } = await supabase.rpc("search_knowledge_hybrid", {
        search_query: q,
        query_embedding: null,
        match_count: topK,
      });
      if (entryErr) {
        return {
          tool: "lookup_knowledge",
          ok: false,
          error_code: "knowledge_unavailable",
          message: entryErr.message,
        };
      }
      rows = ((entryData ?? []) as Array<{
        id: string;
        title: string | null;
        content: string | null;
        type: string | null;
        source_url: string | null;
        score: number | null;
      }>).map((r) => ({
        entry_id: r.id,
        chunk_id: r.id,
        title: r.title,
        content: r.content,
        type: r.type,
        source_url: r.source_url,
        score: r.score,
      }));
    }

    return {
      tool: "lookup_knowledge",
      ok: true,
      hits: rows.map((r) => ({
        title: r.title ?? "",
        snippet: snippetOf(r.content ?? "", 600),
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
