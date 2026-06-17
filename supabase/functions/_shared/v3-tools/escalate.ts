// V3 tool: escalate_to_manager — финальный Soft-404 + контакт менеджера.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { executeLookupContacts } from "./lookup-contacts.ts";
import type { EscalateOk, ToolError, ToolSideEffect } from "./types.ts";

export interface EscalateInput {
  reason: "not_found" | "out_of_domain" | "error" | "user_request";
  note?: string;
}

export async function executeEscalate(
  input: EscalateInput,
  supabase: SupabaseClient,
): Promise<(EscalateOk & { tool: "escalate_to_manager" }) | (ToolError & { tool: "escalate_to_manager" })> {
  const reason = input?.reason ?? "user_request";
  // Загружаем карточку контактов через тот же loader.
  const r = await executeLookupContacts({ topic: "general" }, supabase);
  if (!r.ok) {
    // Даже если контакты не загрузились, escalation сам по себе валиден —
    // эксперт скажет «передаю менеджеру», виджет покажет fallback.
    return {
      tool: "escalate_to_manager",
      ok: true,
      contact_card: null,
    };
  }
  const html = r.data.html_block ?? null;
  const side_effects: ToolSideEffect[] = html ? [{ type: "contacts", html }] : [];
  // reason используется только для логов; чтобы не «терять» — кладём в console
  console.log(`[v3] escalate_to_manager reason=${reason} note=${input?.note ?? ""}`);
  return {
    tool: "escalate_to_manager",
    ok: true,
    contact_card: html,
    side_effects,
  };
}
