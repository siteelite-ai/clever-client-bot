// V3 — Layer 4 контракта «обещал = показал»: сверка критериев с ЧИСЛАМИ КЛИЕНТА.
//
// ПРОБЛЕМА (системная): гейт (Layer 2) проверяет карточки против критериев,
// которые назвала модель. Но сама модель может ТИХО ослабить требование клиента
// до того, что есть в каталоге (клиент назвал число X, модель отправила в
// criteria порог Y < X) — и тогда гейт честно пропускает карточки, потому что
// они удовлетворяют ослабленному порогу. Клиент получает «подходит», хотя
// требование не выполнено. Ни один слой это не ловил.
//
// РЕШЕНИЕ: числа, названные КЛИЕНТОМ, — тоже инвариант. Сервер извлекает из
// реплики клиента пары (число, единица) и не даёт критерию уровня A с той же
// единицей быть слабее клиентского числа:
//   op=min  → value должно быть ≥ максимального клиентского числа этой единицы;
//   op=max  → value должно быть ≤ минимального клиентского числа этой единицы;
//   op=range→ верхняя граница трактуется как min-порог.
//
// Модуль ЧИСТЫЙ и DATA-AGNOSTIC: никаких доменных ключей, категорий и жаргона —
// только числа и единицы измерения как токены текста.

import type { Criterion } from "./criteria-gate.ts";

export interface ClientQuantity {
  value: number;
  unit: string;
}

export interface CriterionViolation {
  key: string;
  op: string;
  /** Порог, который прислала модель. */
  stated: number;
  /** Число клиента той же единицы, которому порог противоречит. */
  client: number;
  unit: string;
}

const NUM = String.raw`\d+(?:[.,]\d+)?`;

export function normalizeUnit(raw: string): string {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/([a-zа-я])2\b/gi, "$1²")
    .replace(/([a-zа-я])3\b/gi, "$1³")
    .replace(/[^a-zа-я²³/]+/gi, "")
    .trim();
}

/** Normalizes common natural-language measurement spellings before generic
 * number+unit extraction. This is linguistic normalization only: no catalog,
 * category or product vocabulary is involved. */
export function normalizeMeasurementText(raw: string): string {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(
      /(\d+(?:[.,]\d+)?)\s*(?:квадрат(?:а|ов)?|квадратн(?:ый|ая|ое|ые|ых|ого|ому|ыми)?\s+метр(?:а|ов|е|у|ы)?|кв\.?\s*м(?:етр(?:а|ов|е|у|ы)?)?)(?![a-zа-я])/giu,
      "$1 м²",
    );
}

/**
 * Извлекает из произвольного текста пары «число + единица».
 * Единица — короткий буквенный токен сразу после числа (мм, см, м, кв, вт, а, в,
 * мм2, °c и т.п.). Числа без единицы игнорируются: без единицы сопоставление
 * с критерием невозможно и было бы догадкой.
 */
export function extractClientQuantities(text: string): ClientQuantity[] {
  const s = normalizeMeasurementText(text);
  const out: ClientQuantity[] = [];
  // A number embedded in a product/model identifier is not a measurement:
  // `Acti9 C16` must not become `9 C`, just as `IP65` is not `65` of an
  // arbitrary unit. An explicit quantity still works (`C16, ток 16 А`).
  const re = new RegExp(String.raw`(?<![a-zа-я])(${NUM})\s*([a-zа-я°]{1,6}[²³]?\d?)(?![a-zа-я])`, "gu");
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const value = Number(m[1].replace(",", "."));
    const unit = normalizeUnit(m[2]);
    if (!Number.isFinite(value) || !unit) continue;
    // Предлоги/союзы, случайно прилипшие к числу, единицами не являются.
    if (/^(и|или|на|до|от|за|по|шт|штук|раз)$/.test(unit)) continue;
    out.push({ value, unit });
  }
  return out;
}

function boundOf(c: Criterion): { op: "min" | "max"; value: number } | null {
  if (c.op === "min" && typeof c.value === "number") return { op: "min", value: c.value };
  if (c.op === "max" && typeof c.value === "number") return { op: "max", value: c.value };
  if (c.op === "range" && Array.isArray(c.value)) {
    const hi = Math.max(Number(c.value[0]), Number(c.value[1]));
    if (Number.isFinite(hi)) return { op: "min", value: hi };
  }
  return null;
}

/**
 * Находит критерии уровня A, которые слабее чисел клиента.
 * Единица критерия должна совпасть с единицей клиентского числа — иначе сверка
 * не производится (нет общей шкалы).
 */
export function findUnderstatedCriteria(
  criteria: Criterion[],
  clientText: string,
): CriterionViolation[] {
  const quantities = extractClientQuantities(clientText);
  if (quantities.length === 0) return [];

  const byUnit = new Map<string, number[]>();
  for (const q of quantities) {
    const arr = byUnit.get(q.unit) ?? [];
    arr.push(q.value);
    byUnit.set(q.unit, arr);
  }

  const violations: CriterionViolation[] = [];
  for (const c of Array.isArray(criteria) ? criteria : []) {
    if (!c || !c.key || (c.level ?? "A") !== "A") continue;
    const unit = normalizeUnit(c.unit ?? "");
    if (!unit) continue;
    const values = byUnit.get(unit);
    if (!values || values.length === 0) continue;
    const bound = boundOf(c);
    if (!bound) continue;

    if (bound.op === "min") {
      const client = Math.max(...values);
      if (bound.value < client) {
        violations.push({ key: c.key, op: c.op, stated: bound.value, client, unit: c.unit ?? unit });
      }
    } else {
      const client = Math.min(...values);
      if (bound.value > client) {
        violations.push({ key: c.key, op: c.op, stated: bound.value, client, unit: c.unit ?? unit });
      }
    }
  }
  return violations;
}

/** Возвращает копию критериев с порогами, поднятыми до чисел клиента. */
export function correctCriteria(criteria: Criterion[], violations: CriterionViolation[]): Criterion[] {
  if (violations.length === 0) return criteria;
  const fix = new Map(violations.map((v) => [v.key, v]));
  return (Array.isArray(criteria) ? criteria : []).map((c) => {
    const v = c && c.key ? fix.get(c.key) : undefined;
    if (!v) return c;
    if (c.op === "range") return { ...c, op: "min" as const, value: v.client };
    return { ...c, value: v.client };
  });
}
