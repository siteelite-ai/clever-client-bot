// V3 — Universal criteria gate (Layer 2 of the "stated criteria == rendered cards" contract).
//
// ПРОБЛЕМА, которую решает модуль (системная, не кейсовая):
// критерии подбора, которые модель проговаривает клиенту, до сих пор существовали
// ТОЛЬКО как проза в первом пузыре. Ни оркестратор, ни render_products не могли
// сверить «что обещано» с «что показано». Единственные серверные инварианты были
// price>0 и исключение якоря; числовые/диапазонные критерии (сечение, диаметр,
// мощность, ток, длина, объём, температура) не проверялись вообще, потому что
// фасеты каталога — строгое равенство строк.
//
// Модуль — ЧИСТЫЙ и DATA-AGNOSTIC: никаких доменных ключей, значений, брендов и
// жаргона. Он умеет только: (1) распарсить число/диапазон/единицу из произвольной
// строки характеристики, (2) сопоставить критерий с характеристикой карточки по
// нормализованному имени ключа, (3) вынести вердикт pass | fail | unknown.
//
// Политика вердиктов:
//   pass    — характеристика найдена и удовлетворяет оператору критерия.
//   fail    — характеристика найдена и ПРОТИВОРЕЧИТ критерию → карточку не рендерим.
//   unknown — характеристики нет в карточке → НЕ повод отсеивать (данных нет,
//             а не «не подходит»), но факт попадает в отчёт для честного текста.

import type { ProductRef } from "./types.ts";

export type CriteriaOp = "eq" | "min" | "max" | "range";

export interface Criterion {
  /** Имя параметра бытовыми словами или как в фасете — сверка по нормализованному вхождению. */
  key: string;
  op: CriteriaOp;
  /** Для eq/min/max — число или строка. Для range — [min, max]. */
  value: number | string | [number, number];
  unit?: string | null;
  /** A — критический (отсев), B — вторичный (только отчёт). По умолчанию A. */
  level?: "A" | "B";
}

export type CriterionVerdict = "pass" | "fail" | "unknown";

export interface CriterionCheck {
  key: string;
  verdict: CriterionVerdict;
  expected: string;
  actual: string | null;
}

export interface ProductGateResult {
  id: string;
  verdict: CriterionVerdict;
  checks: CriterionCheck[];
}

export interface CriteriaGateReport {
  /** id, прошедшие гейт (pass или unknown по всем критериям уровня A). */
  passed_ids: string[];
  /** Отсеянные карточки с причинами. */
  rejected: Array<{ id: string; key: string; expected: string; actual: string }>;
  /** Критерии уровня A, которые ни в одной карточке не подтверждены данными. */
  unverifiable_keys: string[];
  per_product: ProductGateResult[];
}

// ─── Нормализация ────────────────────────────────────────────────────────────

export function normalizeKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/gi, " ")
    .trim();
}

/** Числовой интервал, к которому сводится любое распознанное значение характеристики. */
export interface NumSpan {
  min: number;
  max: number;
}

const NUM = String.raw`-?\d+(?:[.,]\d+)?`;

function toNum(s: string): number {
  return Number(s.replace(",", "."));
}

/**
 * Достаёт число или диапазон из произвольной строки значения характеристики.
 * Поддержано: "12", "12,5", "12-15", "12 – 15", "12…15", "от 12 до 15",
 * "не менее 12" / "от 12" (открытый сверху), "до 15" / "не более 15" (открытый снизу).
 * Отношения/пропорции вида "2:1" и версии "1.2.3" сознательно НЕ парсим —
 * это не размерные величины.
 */
export function parseNumSpan(raw: string): NumSpan | null {
  const s = String(raw).toLowerCase().replace(/ё/g, "е").trim();
  if (!s) return null;
  if (/\d\s*:\s*\d/.test(s)) return null; // пропорция
  if (/\d+\.\d+\.\d+/.test(s)) return null; // версия/составной код

  const range = s.match(new RegExp(String.raw`(${NUM})\s*(?:-|–|—|\.\.\.|…|\.\.|до)\s*(${NUM})`));
  if (range) {
    const a = toNum(range[1]);
    const b = toNum(range[2]);
    if (Number.isFinite(a) && Number.isFinite(b)) return { min: Math.min(a, b), max: Math.max(a, b) };
  }

  const openMin = s.match(new RegExp(String.raw`(?:от|не\s+менее|не\s+ниже|минимум|>=|≥)\s*(${NUM})`));
  if (openMin) {
    const a = toNum(openMin[1]);
    if (Number.isFinite(a)) return { min: a, max: Number.POSITIVE_INFINITY };
  }

  const openMax = s.match(new RegExp(String.raw`(?:до|не\s+более|не\s+выше|максимум|<=|≤)\s*(${NUM})`));
  if (openMax) {
    const a = toNum(openMax[1]);
    if (Number.isFinite(a)) return { min: Number.NEGATIVE_INFINITY, max: a };
  }

  const single = s.match(new RegExp(String.raw`(?:^|[^\w.,])(${NUM})`));
  if (single) {
    const a = toNum(single[1]);
    if (Number.isFinite(a)) return { min: a, max: a };
  }
  return null;
}

/** Находит строку характеристики карточки, чей label соответствует key критерия. */
export function findTrait(product: ProductRef, key: string): { label: string; value: string } | null {
  const nk = normalizeKey(key);
  if (!nk) return null;
  const traits = Array.isArray(product.short_traits) ? product.short_traits : [];
  let fallback: { label: string; value: string } | null = null;

  for (const line of traits) {
    const idx = String(line).indexOf(":");
    if (idx <= 0) continue;
    const label = String(line).slice(0, idx).trim();
    const value = String(line).slice(idx + 1).trim();
    const nl = normalizeKey(label);
    if (!nl || !value) continue;
    if (nl === nk) return { label, value };
    if (!fallback && (nl.includes(nk) || nk.includes(nl))) fallback = { label, value };
  }
  return fallback;
}

function expectedLabel(c: Criterion): string {
  const unit = c.unit ? ` ${c.unit}` : "";
  if (c.op === "range" && Array.isArray(c.value)) return `${c.value[0]}–${c.value[1]}${unit}`;
  if (c.op === "min") return `≥ ${c.value}${unit}`;
  if (c.op === "max") return `≤ ${c.value}${unit}`;
  return `${c.value}${unit}`;
}

function spansOverlap(a: NumSpan, b: NumSpan): boolean {
  return a.min <= b.max && b.min <= a.max;
}

/**
 * Проверка одного критерия против одной карточки.
 * Числовые критерии сравниваются как ПЕРЕСЕЧЕНИЕ интервалов: значение карточки
 * может быть диапазоном (например фасет-диапазон), критерий — тоже.
 * Строковые критерии (op="eq" со строковым value) — нормализованное вхождение.
 */
export function checkCriterion(product: ProductRef, c: Criterion): CriterionCheck {
  const expected = expectedLabel(c);
  const trait = findTrait(product, c.key);
  if (!trait) {
    return { key: c.key, verdict: "unknown", expected, actual: null };
  }
  const actual = trait.value;

  // Строковый критерий
  if (c.op === "eq" && typeof c.value === "string") {
    const want = normalizeKey(c.value);
    const got = normalizeKey(actual);
    if (!want) return { key: c.key, verdict: "unknown", expected, actual };
    return {
      key: c.key,
      verdict: got.includes(want) || want.includes(got) ? "pass" : "fail",
      expected,
      actual,
    };
  }

  const got = parseNumSpan(actual);
  if (!got) return { key: c.key, verdict: "unknown", expected, actual };

  let want: NumSpan | null = null;
  if (c.op === "range" && Array.isArray(c.value)) {
    want = { min: Math.min(c.value[0], c.value[1]), max: Math.max(c.value[0], c.value[1]) };
  } else if (typeof c.value === "number") {
    if (c.op === "min") want = { min: c.value, max: Number.POSITIVE_INFINITY };
    else if (c.op === "max") want = { min: Number.NEGATIVE_INFINITY, max: c.value };
    else want = { min: c.value, max: c.value };
  } else if (typeof c.value === "string") {
    // Число могло прийти строкой ("12") — оператор всё равно определяет открытость
    // интервала, иначе min/max деградируют в строгое равенство.
    const parsed = parseNumSpan(c.value);
    if (parsed) {
      if (c.op === "min") want = { min: parsed.min, max: Number.POSITIVE_INFINITY };
      else if (c.op === "max") want = { min: Number.NEGATIVE_INFINITY, max: parsed.max };
      else want = parsed;
    }
  }
  if (!want) return { key: c.key, verdict: "unknown", expected, actual };

  return { key: c.key, verdict: spansOverlap(got, want) ? "pass" : "fail", expected, actual };
}

/**
 * Главная функция гейта. Отсеивает только по критериям уровня A и только при
 * вердикте fail (данные есть и противоречат). unknown никогда не отсеивает.
 */
export function applyCriteriaGate(
  products: ProductRef[],
  criteria: Criterion[],
): CriteriaGateReport {
  const active = (Array.isArray(criteria) ? criteria : []).filter((c) => c && c.key);
  const report: CriteriaGateReport = {
    passed_ids: [],
    rejected: [],
    unverifiable_keys: [],
    per_product: [],
  };
  if (active.length === 0) {
    report.passed_ids = products.map((p) => String(p.id));
    return report;
  }

  const verifiedKeys = new Set<string>();

  for (const p of products) {
    const checks = active.map((c) => checkCriterion(p, c));
    checks.forEach((ch, i) => {
      if (ch.verdict !== "unknown" && (active[i].level ?? "A") === "A") verifiedKeys.add(ch.key);
    });

    const hardFail = checks.find((ch, i) => ch.verdict === "fail" && (active[i].level ?? "A") === "A");
    if (hardFail) {
      report.rejected.push({
        id: String(p.id),
        key: hardFail.key,
        expected: hardFail.expected,
        actual: hardFail.actual ?? "",
      });
      report.per_product.push({ id: String(p.id), verdict: "fail", checks });
      continue;
    }
    const anyPass = checks.some((ch) => ch.verdict === "pass");
    report.passed_ids.push(String(p.id));
    report.per_product.push({ id: String(p.id), verdict: anyPass ? "pass" : "unknown", checks });
  }

  report.unverifiable_keys = active
    .filter((c) => (c.level ?? "A") === "A" && !verifiedKeys.has(c.key))
    .map((c) => c.key);

  return report;
}

// ─── Слой 3: критерии как поисковый запрос (self-requery) ─────────────────────
//
// Ключевая идея (системная, а не кейсовая): рассуждение модели — это такой же
// запрос, как реплика клиента. Если модель вслух сформулировала «нужен внутренний
// диаметр не менее 40 мм», сервер обязан обработать эту формулировку ровно так,
// как обработал бы её, придя она из чата: собрать из неё текстовый запрос и
// отправить в каталог. Фасеты со строгим равенством этого не делают.
//
// Функция чистая и data-agnostic: берёт предмет поиска (noun) и критерии,
// возвращает человеческую строку запроса без доменных словарей.

export function buildCriteriaQuery(noun: string, criteria: Criterion[]): string {
  const parts: string[] = [];
  const base = String(noun ?? "").trim();
  if (base) parts.push(base);

  for (const c of Array.isArray(criteria) ? criteria : []) {
    if (!c || !c.key || (c.level ?? "A") !== "A") continue;
    const unit = c.unit ? ` ${c.unit}` : "";
    let value: string;
    if (c.op === "range" && Array.isArray(c.value)) value = `${c.value[0]}-${c.value[1]}${unit}`;
    else if (c.op === "min") value = `от ${c.value}${unit}`;
    else if (c.op === "max") value = `до ${c.value}${unit}`;
    else value = `${c.value}${unit}`;
    parts.push(`${String(c.key).trim()} ${value}`.trim());
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}
