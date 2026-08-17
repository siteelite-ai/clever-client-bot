// V3 tool: note_state — пишет ключ-значение в server-managed slot-state
// `slot:v3:<sessionId>` в chat_cache_v2 (TTL 30 мин).
//
// См. mem://features/v1-slot-persistence для аналогичного контракта V1.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import type { NoteStateOk, ToolError } from "./types.ts";

export interface NoteStateInput {
  key: string;
  value: string | number | boolean | null;
  ttl_turns?: number;
}

const SLOT_TTL_SEC = 30 * 60; // 30 минут

export async function executeNoteState(
  input: NoteStateInput,
  supabase: SupabaseClient,
  sessionId: string,
): Promise<(NoteStateOk & { tool: "note_state" }) | (ToolError & { tool: "note_state" })> {
  const key = (input.key ?? "").trim();
  if (!key) {
    return { tool: "note_state", ok: false, error_code: "bad_input", message: "key required" };
  }
  const cacheKey = `slot:v3:${sessionId}`;
  try {
    // read-modify-write
    const { data: existing } = await supabase
      .from("chat_cache_v2")
      .select("cache_value")
      .eq("cache_key", cacheKey)
      .maybeSingle();
    const current = (existing?.cache_value as Record<string, unknown> | null) ?? {};
    const next = {
      ...current,
      [key]: {
        value: input.value ?? null,
        ttl_turns: typeof input.ttl_turns === "number" ? input.ttl_turns : 1,
        set_at: new Date().toISOString(),
      },
    };
    const expiresAt = new Date(Date.now() + SLOT_TTL_SEC * 1000).toISOString();
    const { error } = await supabase
      .from("chat_cache_v2")
      .upsert({ cache_key: cacheKey, cache_value: next, expires_at: expiresAt }, { onConflict: "cache_key" });
    if (error) {
      return { tool: "note_state", ok: false, error_code: "internal", message: error.message };
    }
    return { tool: "note_state", ok: true };
  } catch (e) {
    return { tool: "note_state", ok: false, error_code: "internal", message: (e as Error)?.message ?? "upsert failed" };
  }
}
