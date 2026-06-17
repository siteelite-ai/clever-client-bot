// V3 tool: lookup_contacts — прямая ветка «инфо о магазине».
//
// Источник истины — knowledge_entries (title ilike 'контакт'/'филиал'),
// тот же что у V2 (см. branches.ts:createContactsLoaderDeps).
// Парсер html_block переиспользует ту же логику что V2 (formatContactsCard).

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import type { LookupContactsOk, ToolError, ToolSideEffect } from "./types.ts";

export interface LookupContactsInput {
  topic: "phone" | "address" | "hours" | "payment" | "delivery" | "general";
}

async function loadContactsRaw(supabase: SupabaseClient): Promise<string> {
  const { data, error } = await supabase
    .from("knowledge_entries")
    .select("title, content")
    .or("title.ilike.%контакт%,title.ilike.%филиал%,title.ilike.%адрес%,title.ilike.%график%,title.ilike.%доставк%,title.ilike.%оплат%")
    .limit(10);
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) return "";
  return data
    .map((d: { title: string; content: string }) => `--- ${d.title} ---\n${d.content}`)
    .join("\n\n");
}

function formatContactsCard(raw: string): string | null {
  if (!raw || raw.trim().length === 0) return null;
  const lines: string[] = [];
  const seen = new Set<string>();

  const phoneRegex = /(?:\+7|8)[\s\(\)\-]*\d{3}[\s\(\)\-]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}/g;
  const phoneMatches = raw.match(phoneRegex);
  if (phoneMatches) {
    for (const m of phoneMatches) {
      const tel = m.replace(/[\s\(\)\-]/g, "");
      if (!seen.has(tel)) {
        seen.add(tel);
        lines.push(`📞 [${m.trim()}](tel:${tel})`);
      }
      if (lines.filter((l) => l.startsWith("📞")).length >= 2) break;
    }
  }

  const waMatch =
    raw.match(/https?:\/\/wa\.me\/\d+/i) ||
    raw.match(/WhatsApp[^:]*:\s*([\+\d\s]+)/i);
  if (waMatch) {
    const value = waMatch[0];
    if (value.startsWith("http")) lines.push(`💬 [WhatsApp](${value})`);
    else {
      const num = waMatch[1]?.replace(/[\s\(\)\-]/g, "") || "";
      if (num) lines.push(`💬 [WhatsApp](https://wa.me/${num})`);
    }
  }

  const emailMatch = raw.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  if (emailMatch) lines.push(`📧 [${emailMatch[0]}](mailto:${emailMatch[0]})`);

  if (lines.length === 0) return null;
  return `**Наши контакты:**\n${lines.join("\n")}`;
}

function extractTopicSnippet(raw: string, topic: LookupContactsInput["topic"]): string | undefined {
  if (topic === "general" || !raw) return undefined;
  const patterns: Record<typeof topic, RegExp | null> = {
    phone: /(?:\+7|8)[\s\(\)\-]*\d{3}[\s\(\)\-]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}/,
    address: /(?:адрес|г\.\s*\w+|ул\.\s*[А-Яа-яA-Za-z0-9 .\-]+)/i,
    hours: /(?:график|часы|с\s*\d{1,2}[:\.]?\d{0,2}\s*до\s*\d{1,2}[:\.]?\d{0,2}|пн|пн-пт|пн-вс)/i,
    payment: /(?:оплат\w*|карт\w*|kaspi|каспи|наличн\w*)/i,
    delivery: /(?:доставк\w*|курьер\w*|самовывоз|kazpost|казпочт\w*)/i,
    general: null,
  };
  const re = patterns[topic];
  if (!re) return undefined;
  const m = raw.match(re);
  if (!m) return undefined;
  // вернём окружение совпадения (до 240 символов)
  const idx = raw.indexOf(m[0]);
  const start = Math.max(0, idx - 80);
  const end = Math.min(raw.length, idx + m[0].length + 160);
  return raw.slice(start, end).replace(/\s+/g, " ").trim();
}

export async function executeLookupContacts(
  input: LookupContactsInput,
  supabase: SupabaseClient,
): Promise<(LookupContactsOk & { tool: "lookup_contacts" }) | (ToolError & { tool: "lookup_contacts" })> {
  const topic = input.topic ?? "general";
  try {
    const raw = await loadContactsRaw(supabase);
    if (!raw) {
      return {
        tool: "lookup_contacts",
        ok: false,
        error_code: "contacts_unavailable",
        message: "knowledge_entries: contacts not found",
      };
    }
    const html_block = formatContactsCard(raw) ?? undefined;
    const data: LookupContactsOk["data"] = { html_block };
    const snippet = extractTopicSnippet(raw, topic);
    if (snippet) {
      if (topic === "phone") data.phone = snippet;
      else if (topic === "address") data.address = snippet;
      else if (topic === "hours") data.hours = snippet;
      else if (topic === "payment") data.payment = snippet;
      else if (topic === "delivery") data.delivery = snippet;
    }
    const side_effects: ToolSideEffect[] = html_block ? [{ type: "contacts", html: html_block }] : [];
    return {
      tool: "lookup_contacts",
      ok: true,
      data,
      side_effects,
    };
  } catch (e) {
    return {
      tool: "lookup_contacts",
      ok: false,
      error_code: "contacts_unavailable",
      message: (e as Error)?.message ?? "load failed",
    };
  }
}
