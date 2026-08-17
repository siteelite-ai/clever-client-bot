// V3 — Layer 5 контракта «обещал = показал»: РАССУЖДЕНИЕ МОДЕЛИ — ИСТОЧНИК ИСТИНЫ.
//
// ПРОБЛЕМА (системная): клиент называет ЧИСЛО (например, размер своей детали),
// а подбирать надо товар, чей параметр этому числу не равен, а находится ПО ОДНУ
// СТОРОНУ от него. Модель это понимает и проговаривает клиенту словами
// («нужен диаметр больше 12 мм»), но в машинные criteria[] отправляет то число,
// которое видит в реплике: `op:"eq", value:12`. Гейт (Layer 2) сверяет карточки
// с criteria[], прозу он не читает, поэтому «ровно 12» проходит — и клиент видит
// то, что модель сама только что назвала неподходящим.
//
// РЕШЕНИЕ: сервер читает прозу модели и выравнивает по ней ОПЕРАТОР критерия.
// Направление подбора (больше / меньше / диапазон) берётся из рассуждения, а не
// из того, как число выглядело в чате. Сам ПОРОГ при этом не выдумывается —
// используется число, которое модель назвала вслух.
//
// Модуль ЧИСТЫЙ и DATA-AGNOSTIC: только числа, единицы и направляющие слова —
// никаких доменных ключей, категорий, брендов.

import type { Criterion } from "./criteria-gate.ts";
import { normalizeUnit } from "./criteria-consistency.ts";

export interface ReasoningBound {
  op: "min" | "max";
  value: number;
  unit: string;
  /** «больше 12» — строго больше; «не менее 12» — включительно. */
  strict: boolean;
}

export interface ReasoningAlignment {
  key: string;
  from: string;
  to: "min" | "max";
  value: number;
  unit: string;
  strict: boolean;
}

const NUM = String.raw`\d+(?:[.,]\d+)?`;
const UNIT = String.raw`[a-zа-я°]{1,6}[²³]?\d?`;

// Порядок важен: сначала отрицательные формы («не более»), иначе «более»
// перехватит их и направление получится обратным.
const DIRECTIONS: Array<{ re: string; op: "min" | "max"; strict: boolean }> = [
  { re: String.raw`не\s+менее|не\s+меньше|не\s+ниже|минимум|>=|≥`, op: "min", strict: false },
  { re: String.raw`не\s+более|не\s+больше|не\s+выше|максимум|<=|≤`, op: "max", strict: false },
  { re: String.raw`больше|более|свыше|выше|превыша\w*|>`, op: "min", strict: true },
  { re: String.raw`меньше|менее|ниже|<`, op: "max", strict: true },
  { re: String.raw`от`, op: "min", strict: false },
  { re: String.raw`до`, op: "max", strict: false },
];

/**
 * Извлекает из прозы модели направленные числовые утверждения:
 * «не менее 40 мм», «больше 12 мм», «до 15 А».
 * Числа без единицы игнорируются — сопоставить их с критерием нельзя.
 */
export function extractReasoningBounds(text: string): ReasoningBound[] {
  const s = String(text ?? "").toLowerCase().replace(/ё/g, "е");
  const out: ReasoningBound[] = [];
  for (const dir of DIRECTIONS) {
    const re = new RegExp(
      // Отрицательные формы («не более», «не больше») ловятся своим правилом
      // выше; сюда они попадать не должны — иначе направление перевернётся.
      String.raw`(?:^|[^a-zа-я])(?<!не\s)(?:${dir.re})\s*(?:чем\s+)?(${NUM})\s*(${UNIT})(?![a-zа-я])`,
      "gu",
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
      const value = Number(m[1].replace(",", "."));
      const unit = normalizeUnit(m[2]);
      if (!Number.isFinite(value) || !unit) continue;
      if (/^(и|или|на|за|по|шт|штук|раз)$/.test(unit)) continue;
      out.push({ op: dir.op, value, unit, strict: dir.strict });
    }
  }
  return out;
}

function criterionNumber(c: Criterion): number | null {
  if (typeof c.value === "number") return c.value;
  if (typeof c.value === "string") {
    const m = c.value.match(new RegExp(NUM));
    if (m) {
      const n = Number(m[0].replace(",", "."));
      if (Number.isFinite(n)) return n;
    }
  }
  if (Array.isArray(c.value)) {
    const hi = Math.max(Number(c.value[0]), Number(c.value[1]));
    if (Number.isFinite(hi)) return hi;
  }
  return null;
}

/**
 * Схлопывает границы по (единица, число, направление).
 * Внутри группы строгость — по САМОЙ ЖЁСТКОЙ формулировке: если модель хоть раз
 * сказала «больше/меньше», требование строгое, а последующие «≥ / от» его не
 * размывают. Без этого побеждала та формулировка, что раньше попалась парсеру.
 */
export function collapseBounds(bounds: ReasoningBound[]): ReasoningBound[] {
  const byKey = new Map<string, ReasoningBound>();
  for (const b of bounds) {
    const k = `${b.unit}|${b.value}|${b.op}`;
    const prev = byKey.get(k);
    if (!prev) byKey.set(k, { ...b });
    else if (b.strict) prev.strict = true;
  }
  return [...byKey.values()];
}

/**
 * Выравнивает критерии по рассуждению модели.
 * Правило: если модель ВСЛУХ задала направление для числа X в единице U
 * («больше X U»), а в criteria[] по этой же единице пришёл `eq X` (или
 * противоположное/нестрогое направление) — оператор переписывается по прозе.
 * Порог остаётся тем, который назвала сама модель.
 *
 * Конфликт направлений по одному и тому же числу («до усадки больше 12»,
 * «после усадки меньше 12») сервер не угадывает: если ни одно направление не
 * совпадает с тем, что прислала модель машинно, критерий остаётся как есть, а
 * границы возвращаются в `ambiguities` для лога.
 */
export function alignCriteriaWithReasoning(
  criteria: Criterion[],
  reasoningText: string,
): { criteria: Criterion[]; alignments: ReasoningAlignment[]; ambiguities: ReasoningBound[] } {
  const bounds = collapseBounds(extractReasoningBounds(reasoningText));
  const list = Array.isArray(criteria) ? criteria : [];
  if (bounds.length === 0 || list.length === 0) return { criteria: list, alignments: [], ambiguities: [] };

  const alignments: ReasoningAlignment[] = [];
  const ambiguities: ReasoningBound[] = [];
  const next = list.map((c) => {
    if (!c || !c.key || (c.level ?? "A") !== "A") return c;
    const unit = normalizeUnit(c.unit ?? "");
    if (!unit) return c;
    const num = criterionNumber(c);
    if (num === null) return c;

    // Совпадение по единице И по числу: это то же самое требование, о котором
    // модель говорила прозой. Без совпадения числа порог не трогаем — иначе
    // сервер начал бы выдумывать величины.
    const candidates = bounds.filter((b) => b.unit === unit && b.value === num);
    if (candidates.length === 0) return c;
    let bound: ReasoningBound;
    if (candidates.length === 1) {
      bound = candidates[0];
    } else {
      // Направлений несколько → доверяем направлению, которое модель прислала
      // машинно, и берём от прозы только строгость.
      const same = candidates.find((b) => b.op === c.op);
      if (!same) {
        ambiguities.push(...candidates);
        return c;
      }
      bound = same;
    }
    if (c.op === bound.op && Boolean(c.exclusive) === bound.strict) return c;

    alignments.push({
      key: c.key,
      from: `${c.op}:${String(c.value)}`,
      to: bound.op,
      value: bound.value,
      unit: c.unit ?? unit,
      strict: bound.strict,
    });
    return { ...c, op: bound.op, value: bound.value, exclusive: bound.strict };
  });

  return { criteria: next, alignments, ambiguities };
}

