// V3 tool: lookup_knowledge — hybrid search over knowledge_chunks via RPC.
// Generates query embedding via OpenRouter (google/gemini-embedding-001, 768 dim)
// to enable vector search alongside FTS. Falls back to FTS-only on embedding failure.

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

// Generate query embedding via OpenRouter. Returns null on any failure so caller
// gracefully degrades to FTS-only search.
async function generateQueryEmbedding(
  query: string,
  supabase: SupabaseClient,
): Promise<number[] | null> {
  try {
    const { data: settings } = await supabase
      .from("app_settings")
      .select("openrouter_api_key")
      .limit(1)
      .single();

    const apiKey = (settings as { openrouter_api_key?: string } | null)?.openrouter_api_key;
    if (!apiKey) {
      console.warn("[lookup_knowledge] No OpenRouter API key — FTS-only fallback");
      return null;
    }

    const truncated = query.substring(0, 8000);
    const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-embedding-001",
        input: truncated,
        dimensions: 768,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.warn(`[lookup_knowledge] Embedding API ${response.status}: ${errText.slice(0, 200)}`);
      return null;
    }

    const data = await response.json();
    const embedding = data?.data?.[0]?.embedding;
    if (Array.isArray(embedding) && embedding.length > 0) {
      return embedding;
    }
    return null;
  } catch (e) {
    console.warn("[lookup_knowledge] Embedding generation failed:", (e as Error).message);
    return null;
  }
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
    // Generate query embedding for hybrid (FTS + vector) search.
    // Returns null on failure; RPC then runs FTS-only path.
    const queryEmbedding = await generateQueryEmbedding(q, supabase);
    console.log(`[lookup_knowledge] query="${q}" embedding=${queryEmbedding ? "yes" : "no"}`);

    // 1) Chunk-level RPC (preferred — focused snippets).
    const { data: chunkData, error: chunkErr } = await supabase.rpc("search_knowledge_chunks_hybrid", {
      search_query: q,
      query_embedding: queryEmbedding,
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

    // 2) Fallback: search entries directly if no chunks matched.
    if (rows.length === 0) {
      const { data: entryData, error: entryErr } = await supabase.rpc("search_knowledge_hybrid", {
        search_query: q,
        query_embedding: queryEmbedding,
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
