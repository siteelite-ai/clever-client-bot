// V3 tool: lookup_contacts — структурный парсер контактов и филиалов.
//
// Источник истины — knowledge_entries (title ilike 'контакт'/'филиал'/...).
// В отличие от прежней плоской regex-выборки, теперь:
//   1. Парсим HQ-контакты с подписями (Корпоративный/Розничный/Многоканальный/...)
//      и WhatsApp/E-mail — выдаём ВСЕ найденные телефоны, без лимита 2.
//   2. Парсим структурированные строки филиалов вида
//        "Филиал: г. <CITY> | <address> | <name> | <phone>? | <hours>"
//      и группируем по городам.
//   3. Если филиалов > 1 город и клиент не указал city — ход не отдаёт
//      готовую карточку, а возвращает requires_city + список городов;
//      LLM обязан переспросить (см. schemas.ts §lookup_contacts).
//   4. Если city указан или филиалы в одном городе — отдаём богатую markdown-
//      карточку с подписанными телефонами и графиком работы.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import type { LookupContactsOk, ToolError, ToolSideEffect } from "./types.ts";

export interface LookupContactsInput {
  topic: "phone" | "address" | "hours" | "payment" | "delivery" | "general";
  city?: string;
}

interface Branch {
  city: string;
  address: string;
  name: string;
  phones: string[];
  hours: string;
}

interface HqContacts {
  labeled_phones: Array<{ label: string; phone: string }>;
  whatsapp?: string;
  email?: string;
  hours?: string;
  address?: string;
}

interface ParsedKb {
  hq: HqContacts;
  branches: Branch[];
}

// ────────────────────────────────────────────────────────────────────────────
// Загрузка сырых записей
// ────────────────────────────────────────────────────────────────────────────

async function loadContactsRaw(supabase: SupabaseClient): Promise<Array<{ title: string; content: string }>> {
  const { data, error } = await supabase
    .from("knowledge_entries")
    .select("title, content")
    .or("title.ilike.%контакт%,title.ilike.%филиал%,title.ilike.%адрес%,title.ilike.%график%,title.ilike.%доставк%,title.ilike.%оплат%")
    .limit(20);
  if (error) throw new Error(error.message);
  return data ?? [];
}

// ────────────────────────────────────────────────────────────────────────────
// Утилиты для телефонов
// ────────────────────────────────────────────────────────────────────────────

const PHONE_RE = /(?:\+7|8)\s*\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}/g;

function normPhone(raw: string): string {
  return raw.replace(/[^\d]/g, "");
}

function prettyPhone(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

// ────────────────────────────────────────────────────────────────────────────
// Парсер HQ
// ────────────────────────────────────────────────────────────────────────────

const HQ_LABEL_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "Для вопросов по товарам и офлайн-продажам", re: /(?:Телефон для вопросов по товарам[^:]*):\s*([\+\d][\d\s\(\)\-]{9,})/i },
  { label: "Корпоративный отдел", re: /Корпоративный отдел:\s*([\+\d][\d\s\(\)\-]{9,})/i },
  { label: "Розничный отдел", re: /Розничный отдел:\s*([\+\d][\d\s\(\)\-]{9,})/i },
  { label: "Многоканальный", re: /Многоканальный[^:]*:\s*([\+\d][\d\s\(\)\-]{9,})/i },
];

function parseHq(records: Array<{ title: string; content: string }>): HqContacts {
  const hq: HqContacts = { labeled_phones: [] };
  const seen = new Set<string>();
  const combined = records.map((r) => r.content).join("\n\n");

  for (const { label, re } of HQ_LABEL_PATTERNS) {
    const m = combined.match(re);
    if (m && m[1]) {
      const phone = prettyPhone(m[1]);
      const norm = normPhone(phone);
      if (norm && !seen.has(norm)) {
        seen.add(norm);
        hq.labeled_phones.push({ label, phone });
      }
    }
  }

  const wa = combined.match(/https?:\/\/wa\.me\/(\d+)/i);
  if (wa) hq.whatsapp = `https://wa.me/${wa[1]}`;

  const email = combined.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  if (email) hq.email = email[0];

  // Часы работы HQ — первая встреча "Пн-Пт: ..."
  const hours = combined.match(/Пн-?Пт:?\s*\d{1,2}[:\.]\d{2}\s*[-–]\s*\d{1,2}[:\.]\d{2}[^\n]*/i);
  if (hours) hq.hours = hours[0].replace(/\s+/g, " ").trim();

  // Главный адрес — "ул. Ермекова" в первой записи
  const addr = combined.match(/Адрес:\s*([^\n]+?Караганд[^\n]*)/i);
  if (addr) hq.address = addr[1].trim();

  return hq;
}

// ────────────────────────────────────────────────────────────────────────────
// Парсер филиалов
// Формат строки (структурированная KB-запись):
//   "Филиал: г. Астана | ул. Сембинова, 20/1, ... | Филиал г. Астана | +7 (701) 026-23-67 | пн.-пт. 9:00-19:00, сб.-вс. 10:00-19:00"
// Также поддерживаем плоские блоки из первой записи:
//   "Адрес: ... Корпоративный отдел: ... Наименование организации: ... Время работы: ..."
// ────────────────────────────────────────────────────────────────────────────

const BRANCH_LINE_RE = /Филиал:\s*г\.\s*([А-ЯЁа-яё\-]+)\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*(?:\|\s*([^|]*))?(?:\|\s*([^|\n]*))?/g;

function parseBranches(records: Array<{ title: string; content: string }>): Branch[] {
  const branches: Branch[] = [];
  const combined = records.map((r) => r.content).join("\n\n");

  // 1) Структурированные строки "Филиал: г. X | ..."
  let m: RegExpExecArray | null;
  BRANCH_LINE_RE.lastIndex = 0;
  while ((m = BRANCH_LINE_RE.exec(combined)) !== null) {
    const city = m[1].trim();
    const address = (m[2] ?? "").trim();
    const name = (m[3] ?? "").trim();
    const rest1 = (m[4] ?? "").trim();
    const rest2 = (m[5] ?? "").trim();
    const tail = `${rest1} ${rest2}`.trim();
    const phones = (tail.match(PHONE_RE) ?? []).map(prettyPhone);
    const hours = tail.replace(PHONE_RE, "").replace(/\s+/g, " ").trim();
    branches.push({ city, address, name, phones, hours });
  }

  // 2) Плоские блоки из первой записи (HQ-портянка с филиалами в Караганде)
  //    "Адрес: <addr> ... Корпоративный отдел: <phone> ... Наименование организации: <name> ... Время работы: <hours>"
  const flatBlockRe = /Адрес:\s*([^А-Я]+?Караганд[а-я]*[^.]*?)(?=\s*(?:Корпоративный|Наименование|Время|E-mail|Адрес:|$))/gi;
  // Менее формальный, но рабочий подход — раскалываем по "Адрес:" и парсим каждый кусок.
  const chunks = combined.split(/(?=Адрес:\s+)/g);
  for (const chunk of chunks) {
    if (!/Караганд/i.test(chunk)) continue;
    if (!/Наименование организации|Магазин 220|Отдел 220/i.test(chunk)) continue;
    const addrM = chunk.match(/Адрес:\s*([^\n]+?)(?=\s+(?:Корпоративный|Наименование|Время|E-mail|$))/i);
    const nameM = chunk.match(/Наименование организации:\s*([^\n]+?)(?=\s+(?:Время|E-mail|Адрес|Корпоративный|$))/i);
    const phoneM = chunk.match(PHONE_RE);
    const hoursM = chunk.match(/Время работы:\s*([^\n]+?)(?=\s+E-mail|\s+Адрес|\s+Наименование|$)/i);
    if (!addrM) continue;
    const address = addrM[1].trim();
    // Не дублируем то, что уже распознано структурированным парсером.
    const norm = address.toLowerCase().replace(/\s+/g, " ");
    if (branches.some((b) => b.address.toLowerCase().replace(/\s+/g, " ") === norm)) continue;
    branches.push({
      city: "Караганда",
      address,
      name: nameM ? nameM[1].trim() : "",
      phones: phoneM ? phoneM.map(prettyPhone) : [],
      hours: hoursM ? hoursM[1].trim() : "",
    });
  }

  // Дедуп по (city + address)
  const seen = new Set<string>();
  return branches.filter((b) => {
    const k = `${b.city.toLowerCase()}|${b.address.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Рендер карточки
// ────────────────────────────────────────────────────────────────────────────

function renderHqCard(hq: HqContacts): string {
  const lines: string[] = [];
  if (hq.hours) {
    lines.push("**График работы (головной офис):**");
    // Разбиваем "Пн-Пт: 09:00-18:00; Сб: 10:00-17:00; Вс: Выходной"
    const parts = hq.hours.split(/[;,]\s*/).filter(Boolean);
    for (const p of parts) lines.push(`- ${p.trim()}`);
    lines.push("");
  }
  if (hq.labeled_phones.length > 0) {
    lines.push("**Контакты:**");
    for (const { label, phone } of hq.labeled_phones) {
      const tel = normPhone(phone);
      lines.push(`- **${label}:** [${phone}](tel:+${tel.startsWith("8") ? "7" + tel.slice(1) : tel})`);
    }
  }
  if (hq.whatsapp) lines.push(`- 💬 [WhatsApp](${hq.whatsapp})`);
  if (hq.email) lines.push(`- 📧 [${hq.email}](mailto:${hq.email})`);
  return lines.join("\n");
}

function renderBranchCard(branches: Branch[], city: string): string {
  const lines: string[] = [`**Филиалы в г. ${city}:**`, ""];
  for (const b of branches) {
    if (b.name) lines.push(`**${b.name}**`);
    lines.push(`📍 ${b.address}`);
    for (const p of b.phones) {
      const tel = normPhone(p);
      lines.push(`📞 [${p}](tel:+${tel.startsWith("8") ? "7" + tel.slice(1) : tel})`);
    }
    if (b.hours) lines.push(`🕐 ${b.hours}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

// ────────────────────────────────────────────────────────────────────────────
// Сравнение городов (нормализация для matched_city)
// ────────────────────────────────────────────────────────────────────────────

function normCity(s: string): string {
  return s
    .toLowerCase()
    .replace(/^г\.?\s*/, "")
    .replace(/[^а-яё\-]/g, "")
    .trim();
}

// ────────────────────────────────────────────────────────────────────────────
// Главная функция
// ────────────────────────────────────────────────────────────────────────────

export async function executeLookupContacts(
  input: LookupContactsInput,
  supabase: SupabaseClient,
): Promise<(LookupContactsOk & { tool: "lookup_contacts" }) | (ToolError & { tool: "lookup_contacts" })> {
  const topic = input.topic ?? "general";
  const cityFilter = input.city?.trim();

  try {
    const records = await loadContactsRaw(supabase);
    if (!records || records.length === 0) {
      return {
        tool: "lookup_contacts",
        ok: false,
        error_code: "contacts_unavailable",
        message: "knowledge_entries: contacts not found",
      };
    }

    const hq = parseHq(records);
    const branches = parseBranches(records);
    const cities = [...new Set(branches.map((b) => b.city))].sort();

    // Сценарий 1: клиент указал город → отдаём именно его филиалы.
    if (cityFilter) {
      const norm = normCity(cityFilter);
      const matched = branches.filter((b) => normCity(b.city) === norm || normCity(b.city).startsWith(norm));
      if (matched.length === 0) {
        return {
          tool: "lookup_contacts",
          ok: true,
          data: {
            html_block: undefined,
            cities,
            branches_count: branches.length,
            requires_city: true,
          },
          side_effects: [],
        };
      }
      const html_block = renderBranchCard(matched, matched[0].city);
      return {
        tool: "lookup_contacts",
        ok: true,
        data: {
          html_block,
          cities,
          branches_count: branches.length,
          matched_city: matched[0].city,
        },
        side_effects: [{ type: "contacts", html: html_block }],
      };
    }

    // Сценарий 2: вопрос про оплату/доставку — не привязан к филиалу,
    //             отдаём HQ-карточку.
    if (topic === "payment" || topic === "delivery") {
      const html_block = renderHqCard(hq);
      const data: LookupContactsOk["data"] = { html_block, cities, branches_count: branches.length };
      const side_effects: ToolSideEffect[] = html_block ? [{ type: "contacts", html: html_block }] : [];
      return { tool: "lookup_contacts", ok: true, data, side_effects };
    }

    // Сценарий 3: филиалов больше одного города и topic про адрес/часы/телефон/общий —
    //             ход требует уточнения города, карточку НЕ показываем.
    if (cities.length > 1) {
      return {
        tool: "lookup_contacts",
        ok: true,
        data: {
          html_block: undefined,
          cities,
          branches_count: branches.length,
          requires_city: true,
        },
        side_effects: [],
      };
    }

    // Сценарий 4: все филиалы в одном городе — отдаём комбинированную карточку
    //             (HQ-телефоны + все филиалы).
    const html_block = [renderHqCard(hq), branches.length > 0 ? renderBranchCard(branches, cities[0]) : ""]
      .filter(Boolean)
      .join("\n\n");
    return {
      tool: "lookup_contacts",
      ok: true,
      data: {
        html_block,
        cities,
        branches_count: branches.length,
        matched_city: cities[0],
      },
      side_effects: html_block ? [{ type: "contacts", html: html_block }] : [],
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
