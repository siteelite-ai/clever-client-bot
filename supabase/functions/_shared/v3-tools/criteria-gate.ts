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
//   unknown — характеристики нет в карточке. Для обязательного уровня A это
//             означает «пригодность не доказана» и карточка не рендерится;
//             для рекомендательного уровня B остаётся только в отчёте.

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
  /**
   * Строгое неравенство для min/max: «больше 12» (а не «не менее 12»).
   * Ставится Слоем 5 по прозе модели (criteria-reasoning.ts).
   */
  exclusive?: boolean;
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
  /** id, доказательно прошедшие все критерии уровня A. */
  passed_ids: string[];
  /** Отсеянные карточки с причинами. */
  rejected: Array<{ id: string; key: string; expected: string; actual: string }>;
  /** Критерии уровня A, которые ни в одной карточке не подтверждены данными. */
  unverifiable_keys: string[];
  per_product: ProductGateResult[];
}

export interface CriteriaFacet {
  key: string;
  caption: string;
  unit: string | null;
  values: Array<{ value: string }>;
}

export interface CriteriaFacetProjection {
  options: Record<string, string[]>;
  proven_criteria: Criterion[];
  unmatched_keys: string[];
}

/** Intersects independent live-facet constraints into one catalog query. */
export function mergeFacetOptionConstraints(
  ...sources: Array<Record<string, string[]>>
): { options: Record<string, string[]>; conflicting_keys: string[] } {
  const merged = new Map<string, Set<string>>();
  const conflicting = new Set<string>();
  for (const source of sources) {
    for (const [key, rawValues] of Object.entries(source ?? {})) {
      const values = new Set((rawValues ?? []).map(String).filter(Boolean));
      if (values.size === 0) continue;
      const previous = merged.get(key);
      if (!previous) {
        merged.set(key, values);
        continue;
      }
      const intersection = new Set([...previous].filter((value) => values.has(value)));
      merged.set(key, intersection);
      if (intersection.size === 0) conflicting.add(key);
    }
  }
  return {
    options: Object.fromEntries([...merged].filter(([, values]) => values.size > 0).map(([key, values]) => [key, [...values]])),
    conflicting_keys: [...conflicting],
  };
}

/**
 * User-backed criteria are turn invariants. A later fallback may contribute
 * more explicit constraints, but it must never erase constraints proved by an
 * earlier strict search. Equality values for one facet are kept as separate
 * entries because the criteria gate interprets them as an OR group.
 */
export function mergeUserBackedCriteria(
  existing: Criterion[],
  incoming: Criterion[],
): Criterion[] {
  const merged: Criterion[] = [];
  const seen = new Set<string>();
  for (const criterion of [...(existing ?? []), ...(incoming ?? [])]) {
    if (!criterion?.key || criterion.value === undefined) continue;
    const value = Array.isArray(criterion.value)
      ? criterion.value.map((item) => String(item)).join("\u0000")
      : String(criterion.value);
    const signature = [
      normalizeKey(criterion.key),
      criterion.op,
      value,
      normalizeKey(String(criterion.unit ?? "")),
      criterion.exclusive === true ? "exclusive" : "inclusive",
    ].join("\u0001");
    if (seen.has(signature)) continue;
    seen.add(signature);
    merged.push({ ...criterion, level: "A" });
  }
  return merged;
}

// ─── Нормализация ────────────────────────────────────────────────────────────

export function normalizeKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/gi, " ")
    .trim();
}

function criterionEvidenceValue(criterion: Criterion): string {
  const value = Array.isArray(criterion.value)
    ? `${criterion.value[0]}–${criterion.value[1]}`
    : String(criterion.value);
  return `${value}${criterion.unit ? ` ${criterion.unit}` : ""}`;
}

/**
 * A successful canonical by_filter response is first-party catalog evidence
 * for the exact facet values used in that request, even if compact result
 * cards omit those facets. Project that lineage only onto products returned by
 * the proven filtered pool; free model criteria never enter this function.
 */
export function projectCatalogFilterEvidence<T extends ProductRef>(
  products: T[],
  provenCriteria: Criterion[],
): T[] {
  if (!Array.isArray(provenCriteria) || provenCriteria.length === 0) return products.map((product) => ({ ...product }));
  return products.map((product) => ({
    ...product,
    short_traits: [
      ...(product.short_traits ?? []),
      ...provenCriteria.map((criterion) => `${criterion.key}: ${criterionEvidenceValue(criterion)}`),
    ],
  }));
}

/** Enforces a user price ceiling on every render path, including recoveries. */
export function filterProductIdsByBudgetCap<T extends { price: number }>(
  ids: string[],
  products: ReadonlyMap<string, T>,
  budgetCap: number | null,
): { ids: string[]; dropped: number } {
  if (budgetCap === null || !Number.isFinite(budgetCap) || budgetCap <= 0) {
    return { ids: [...ids], dropped: 0 };
  }
  const kept = ids.filter((id) => {
    const price = Number(products.get(id)?.price);
    return Number.isFinite(price) && price > 0 && price <= budgetCap;
  });
  return { ids: kept, dropped: ids.length - kept.length };
}

/**
 * Compose the criteria enforced at render time. Named-entity browse turns use
 * strict user-evidence mode: the model may describe or rank the exact entity,
 * but it cannot silently turn its own prose into a new mandatory filter.
 */
export function resolveRenderCriteria(
  enforced: Criterion[],
  raw: Criterion[],
  userBacked: Criterion[],
  strictUserEvidenceOnly: boolean,
): Criterion[] {
  const userKeys = new Set(userBacked.map((criterion) => normalizeKey(criterion.key)));
  const base = strictUserEvidenceOnly
    ? userBacked
    : [
      ...userBacked,
      ...enforced.filter((criterion) => !userKeys.has(normalizeKey(criterion.key))),
    ];
  const baseKeys = new Set(base.map((criterion) => normalizeKey(criterion.key)));
  return [
    ...base,
    ...(strictUserEvidenceOnly
      ? []
      : raw.filter((criterion) => !baseKeys.has(normalizeKey(String(criterion?.key ?? ""))))),
  ].filter((criterion) => criterion && typeof criterion.key === "string" && criterion.value !== undefined)
    .map((criterion) => ({ ...criterion }));
}

/**
 * The deterministic finalizer must enforce the same monotonic contract as a
 * normal render. In particular, a broad recovery may not forget literals that
 * were frozen from the customer's request before the model built its latest
 * criteria array.
 */
export function resolveTerminalSelectionCriteria(
  projected: Criterion[],
  latest: Criterion[],
  userBacked: Criterion[],
  strictUserEvidenceOnly = false,
): Criterion[] {
  return resolveRenderCriteria(
    projected,
    latest,
    userBacked,
    strictUserEvidenceOnly,
  ).filter((criterion) => (criterion.level ?? "A") === "A");
}

/** Compact letter/code values are unsafe when they only exist in hidden
 * traits: the customer cannot verify the promised variant from the card. */
export function titleProvesCompactCriterion(title: string, criterion: Criterion): boolean {
  if (typeof criterion.value !== "string") return true;
  const rawValue = criterion.value.trim();
  const value = normalizeKey(rawValue).replace(/\s+/g, "");
  const isCompactCode = /^[a-z0-9]{1,4}$/iu.test(rawValue) || /^[А-ЯЁ]$/u.test(rawValue);
  if (!value || !isCompactCode || !/[a-zа-я]/iu.test(value)) return true;
  if (["да", "нет", "yes", "no", "true", "false"].includes(value)) return true;
  const foldCode = (token: string) => token === "С" ? "c" : normalizeKey(token);
  const titleTokens = title.match(/[a-zа-я0-9]+/giu)?.map(foldCode) ?? [];
  return titleTokens.includes(foldCode(rawValue));
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

  // Price is a first-class catalog field, not a short trait. Search already
  // returns it as `ProductRef.price` and applies min_price/max_price against
  // the same value. Treating it as absent here makes the evidence gate reject
  // products that the catalog has just proven are within budget.
  const keyTokens = new Set(nk.split(/\s+/u));
  if (["цена", "стоимость", "бюджет", "price", "budget"].some((token) => keyTokens.has(token))) {
    const price = Number(product.price);
    if (Number.isFinite(price) && price > 0) {
      return { label: "Цена", value: String(price) };
    }
  }

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

function productEvidenceText(product: ProductRef): string {
  return normalizeKey([
    product.pagetitle,
    product.article ?? "",
    ...(Array.isArray(product.short_traits) ? product.short_traits : []),
    product.description_excerpt ?? "",
  ].join(" "));
}

function looseStem(token: string): string {
  if (token.length < 5) return token;
  return token.replace(/(?:ыми|ими|ого|его|ому|ему|ами|ями|ая|яя|ое|ее|ой|ей|ом|ем|ую|юю|ый|ий|ых|их|ов|ев|ам|ям|ах|ях|а|я|о|е|ы|и|у|ю)$/u, "");
}

function semanticStem(token: string): string {
  const stem = looseStem(token);
  if (["датчик", "сенсор", "sensor", "detector"].includes(stem)) return "__sensor__";
  return stem;
}

function stringEvidenceMatches(wanted: string, evidence: string): boolean {
  const want = normalizeKey(wanted);
  const got = normalizeKey(evidence);
  if (!want || !got) return false;
  if (got.includes(want) || want.includes(got)) return true;
  const gotStems = got.split(/\s+/u).filter((x) => x.length >= 3).map(semanticStem);
  const wantStems = want.split(/\s+/u).filter((x) => x.length >= 3).map(semanticStem);
  return wantStems.length > 0 && wantStems.every((stem) => gotStems.some((actual) => {
    if (actual === stem || actual.startsWith(stem) || stem.startsWith(actual)) return true;
    // Russian derivations can change the suffix after a short stable root:
    // "движения" ↔ "движущихся". Accept that only for long words with a
    // shared root of at least four letters; short unrelated tokens remain
    // exact-only.
    if (actual.length < 6 || stem.length < 6) return false;
    let shared = 0;
    while (shared < actual.length && shared < stem.length && actual[shared] === stem[shared]) shared++;
    return shared >= 4;
  }));
}

function isAffirmativeValue(value: string): boolean {
  return ["да", "есть", "имеется", "присутствует", "yes", "true"].includes(normalizeKey(value));
}

function expectedLabel(c: Criterion): string {
  const unit = c.unit ? ` ${c.unit}` : "";
  if (c.op === "range" && Array.isArray(c.value)) return `${c.value[0]}–${c.value[1]}${unit}`;
  if (c.op === "min") return `${c.exclusive ? ">" : "≥"} ${c.value}${unit}`;
  if (c.op === "max") return `${c.exclusive ? "<" : "≤"} ${c.value}${unit}`;
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
    // Часть доказательных признаков живёт только в названии/описании товара,
    // а не в отдельном фасете. Строковое требование можно подтвердить по всему
    // каталожному evidence, но отсутствие слова остаётся unknown, а не fail.
    if (c.op === "eq" && typeof c.value === "string") {
      const want = normalizeKey(c.value);
      const evidence = productEvidenceText(product);
      // Boolean facets are often sparse in the source catalog even when the
      // feature is explicitly described in the product title or description.
      // For an affirmative value, the criterion key carries the feature name
      // (e.g. "С датчиком движения"); require that full key to be evidenced
      // instead of looking for the uninformative word "да".
      if (isAffirmativeValue(c.value) && stringEvidenceMatches(c.key, evidence)) {
        return { key: c.key, verdict: "pass", expected, actual: c.key };
      }
      if (want && stringEvidenceMatches(want, evidence)) {
        return { key: c.key, verdict: "pass", expected, actual: c.value };
      }
    }
    return { key: c.key, verdict: "unknown", expected, actual: null };
  }
  const actual = trait.value;

  // Catalog facet values are strings even when they represent measurements.
  // Numeric equality must therefore use numeric spans, not substring matching:
  // `16` is not equal to `160`, `1600` or `0.1-0.16`. Keep mixed letter-number
  // codes (1P, E27, IP65) on the string path unless an explicit unit proves
  // that the criterion is measured.
  if (c.op === "eq" && typeof c.value === "string") {
    const valueIsPlainNumeric = /^\s*-?\d+(?:[.,]\d+)?\s*$/u.test(c.value);
    const wantedNumeric = c.unit || valueIsPlainNumeric ? parseNumSpan(c.value) : null;
    if (wantedNumeric) {
      const actualNumeric = parseNumSpan(actual);
      return {
        key: c.key,
        verdict: actualNumeric && spansOverlap(actualNumeric, wantedNumeric)
          ? "pass"
          : actualNumeric ? "fail" : "unknown",
        expected,
        actual,
      };
    }
  }

  // Строковый критерий
  if (c.op === "eq" && typeof c.value === "string") {
    const want = normalizeKey(c.value);
    const got = normalizeKey(actual);
    if (!want) return { key: c.key, verdict: "unknown", expected, actual };
    return {
      key: c.key,
      verdict: stringEvidenceMatches(want, got) ? "pass" : "fail",
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

  // Строгое неравенство (Слой 5, «больше X» вместо «не менее X»): граница не
  // засчитывается, поэтому проверяем пересечение строго.
  let ok: boolean;
  if (c.exclusive && c.op === "min") ok = got.max > want.min;
  else if (c.exclusive && c.op === "max") ok = got.min < want.max;
  else ok = spansOverlap(got, want);

  return { key: c.key, verdict: ok ? "pass" : "fail", expected, actual };
}

/**
 * Главная функция гейта. Критерий уровня A — обязательное утверждение о
 * пригодности, поэтому и явное противоречие, и отсутствие доказательства
 * исключают карточку. Уровень B остаётся рекомендательным и не отсеивает.
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

  // Multiple values of one canonical `eq` facet come from an OR filter
  // (`options[key][]=a&options[key][]=b`). Treating them as independent AND
  // requirements makes every product impossible to prove.
  const grouped = new Map<string, Criterion[]>();
  active.forEach((criterion, index) => {
    const key = criterion.op === "eq" ? `eq:${normalizeKey(criterion.key)}` : `single:${index}`;
    const list = grouped.get(key) ?? [];
    list.push(criterion);
    grouped.set(key, list);
  });
  const groups = [...grouped.values()].map((items) => ({
    items,
    key: items[0].key,
    level: items.some((criterion) => (criterion.level ?? "A") === "A") ? "A" as const : "B" as const,
  }));
  const evaluateGroup = (product: ProductRef, items: Criterion[]): CriterionCheck => {
    const checks = items.map((criterion) => checkCriterion(product, criterion));
    if (checks.length === 1) return checks[0];
    const passed = checks.find((check) => check.verdict === "pass");
    const expected = `одно из: ${checks.map((check) => check.expected).join(" | ")}`;
    if (passed) return { key: items[0].key, verdict: "pass", expected, actual: passed.actual };
    const actual = checks.map((check) => check.actual).filter((value): value is string => Boolean(value));
    if (checks.every((check) => check.verdict === "fail")) {
      return { key: items[0].key, verdict: "fail", expected, actual: [...new Set(actual)].join(" | ") || null };
    }
    return { key: items[0].key, verdict: "unknown", expected, actual: [...new Set(actual)].join(" | ") || null };
  };

  const verifiedKeys = new Set<string>();

  for (const p of products) {
    const checks = groups.map((group) => evaluateGroup(p, group.items));
    checks.forEach((ch, i) => {
      if (ch.verdict !== "unknown" && groups[i].level === "A") verifiedKeys.add(ch.key);
    });

    const hardFail = checks.find((ch, i) => ch.verdict !== "pass" && groups[i].level === "A");
    if (hardFail) {
      report.rejected.push({
        id: String(p.id),
        key: hardFail.key,
        expected: hardFail.expected,
        actual: hardFail.actual ?? "нет данных",
      });
      report.per_product.push({ id: String(p.id), verdict: "fail", checks });
      continue;
    }
    const anyPass = checks.some((ch) => ch.verdict === "pass");
    report.passed_ids.push(String(p.id));
    report.per_product.push({ id: String(p.id), verdict: anyPass ? "pass" : "unknown", checks });
  }

  report.unverifiable_keys = groups
    .filter((group) => group.level === "A" && !verifiedKeys.has(group.key))
    .map((group) => group.key);

  return report;
}

/** Compile mandatory criteria into exact values of uniquely matching live
 * facets. Repeated equality criteria for one key become OR values; different
 * constraints on one facet intersect. Product and category names are absent. */
export function projectCriteriaFacetOptions(
  criteria: Criterion[],
  facets: CriteriaFacet[],
): CriteriaFacetProjection {
  const mandatory = (Array.isArray(criteria) ? criteria : []).filter((criterion) =>
    criterion?.key && (criterion.level ?? "A") === "A"
  );
  const groups = new Map<string, Criterion[]>();
  mandatory.forEach((criterion) => {
    const key = normalizeKey(criterion.key);
    groups.set(key, [...(groups.get(key) ?? []), criterion]);
  });
  const optionSets = new Map<string, Set<string>>();
  const proven: Criterion[] = [];
  const unmatched: string[] = [];
  for (const items of groups.values()) {
    const wanted = normalizeKey(items[0].key);
    const exact = facets.filter((facet) => [normalizeKey(facet.key), normalizeKey(facet.caption)].includes(wanted));
    const matches = exact.length > 0 ? exact : facets.filter((facet) => {
      const labels = [normalizeKey(facet.key), normalizeKey(facet.caption)];
      return wanted.length >= 5 && labels.some((label) => label.includes(wanted) || wanted.includes(label));
    });
    if (matches.length !== 1) {
      unmatched.push(items[0].key);
      continue;
    }
    const facet = matches[0];
    const acceptedByCriterion = items.map((criterion) => new Set(facet.values.flatMap(({ value }) => {
      const pseudo = {
        id: "facet",
        pagetitle: "",
        vendor: null,
        price: 1,
        stock: "unknown" as const,
        // The resolved live facet may be referenced by either its public
        // caption or its machine key. Expose both aliases to the pure checker.
        short_traits: [
          `${facet.caption || facet.key}: ${value}`,
          `${facet.key}: ${value}`,
        ],
      };
      return checkCriterion(pseudo, criterion).verdict === "pass" ? [String(value)] : [];
    })));
    const equalitySets = acceptedByCriterion.filter((_, index) => items[index].op === "eq");
    const constraintSets = acceptedByCriterion.filter((_, index) => items[index].op !== "eq");
    const equalityAlternatives = equalitySets.length > 0
      ? new Set(equalitySets.flatMap((set) => [...set]))
      : null;
    const constraints = constraintSets.length > 0
      ? new Set([...constraintSets[0]].filter((value) => constraintSets.slice(1).every((set) => set.has(value))))
      : null;
    const accepted = equalityAlternatives && constraints
      ? new Set([...equalityAlternatives].filter((value) => constraints.has(value)))
      : equalityAlternatives ?? constraints ?? new Set<string>();
    if (accepted.size === 0) {
      unmatched.push(items[0].key);
      continue;
    }
    const bounded = new Set([...accepted].slice(0, 12));
    const previous = optionSets.get(facet.key);
    optionSets.set(
      facet.key,
      previous ? new Set([...previous].filter((value) => bounded.has(value))) : bounded,
    );
    if ((optionSets.get(facet.key)?.size ?? 0) === 0) {
      unmatched.push(items[0].key);
      continue;
    }
    proven.push(...items);
  }
  return {
    options: Object.fromEntries([...optionSets].filter(([, values]) => values.size > 0).map(([key, values]) => [key, [...values]])),
    proven_criteria: proven,
    unmatched_keys: unmatched,
  };
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

/**
 * Многословные строковые значения (описания назначения, категории, длинные
 * формулировки) в текстовый запрос НЕ попадают: каталог ищет по словам, и такая
 * фраза сужает выдачу до нуля. Правило чисто формальное (длина/число слов),
 * без доменных словарей.
 */
function isVerboseValue(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const s = v.trim();
  return s.length > 24 || s.split(/\s+/).length > 3;
}

export function buildCriteriaQuery(noun: string, criteria: Criterion[]): string {
  const parts: string[] = [];
  const base = String(noun ?? "").trim();
  if (base) parts.push(base);

  for (const c of Array.isArray(criteria) ? criteria : []) {
    if (!c || !c.key || (c.level ?? "A") !== "A") continue;
    if (isVerboseValue(c.value)) continue;
    const unit = c.unit ? ` ${c.unit}` : "";
    let value: string;
    if (c.op === "range" && Array.isArray(c.value)) value = `${c.value[0]}-${c.value[1]}${unit}`;
    else if (c.op === "min") value = `${c.exclusive ? "больше" : "от"} ${c.value}${unit}`;
    else if (c.op === "max") value = `${c.exclusive ? "меньше" : "до"} ${c.value}${unit}`;
    else value = `${c.value}${unit}`;
    parts.push(`${String(c.key).trim()} ${value}`.trim());
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}
