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

export interface ReasoningRangeProjection {
  criteria: Criterion[];
  added: Criterion[];
}

const NUM = String.raw`\d+(?:[.,]\d+)?`;
const UNIT = String.raw`[a-zа-я°]{1,6}[²³]?\d?`;

/** Measured reasoning must be represented by at least one render criterion.
 * Bare structural markings such as 2×1.5 have no unit and remain under the
 * existing exact-compound policy. */
export function hasMeasuredSelectionRequirement(text: string): boolean {
  const value = String(text ?? "").toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
  const re = new RegExp(String.raw`\d+(?:[.,]\d+)?(?:\s*[–—-]\s*\d+(?:[.,]\d+)?)?\s*(${UNIT})(?![a-zа-я])`, "giu");
  for (let match; (match = re.exec(value)) !== null;) {
    const unit = normalizeUnit(match[1]);
    if (!unit || /^(шт|штук|раз|года?|лет|мин|сек)$/u.test(unit)) continue;
    return true;
  }
  return false;
}

function canonicalMeasurementUnit(raw: string): string {
  const unit = normalizeUnit(raw);
  const aliases: Record<string, string> = {
    ватт: "вт", ватта: "вт", ваттов: "вт", watt: "вт", watts: "вт", w: "вт",
    люмен: "лм", люмена: "лм", люменов: "лм", lumen: "лм", lumens: "лм", lm: "лм",
    вольт: "в", вольта: "в", вольтов: "в", volt: "в", volts: "в", v: "в",
    ампер: "а", ампера: "а", амперов: "а", amp: "а", amps: "а",
  };
  return aliases[unit] ?? unit;
}

/** Projects explicit numeric ranges from the consultant's own prose onto a
 * unique live numeric facet with the same unit. This is the server-side bridge
 * from reasoning to criteria; no product/category vocabulary is embedded. */
export function projectReasoningRangeCriteria(
  criteria: Criterion[],
  reasoningText: string,
  facets: Array<{ key: string; caption: string; type: string; unit: string | null }>,
): ReasoningRangeProjection {
  const next = (Array.isArray(criteria) ? criteria : []).map((criterion) => ({ ...criterion }));
  const added: Criterion[] = [];
  const text = String(reasoningText ?? "").toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
  const re = new RegExp(String.raw`(${NUM})\s*[–—-]\s*(${NUM})\s*([a-zа-я°]{1,10}[²³]?\d?)(?![a-zа-я])`, "giu");
  for (let match; (match = re.exec(text)) !== null;) {
    const first = Number(match[1].replace(",", "."));
    const second = Number(match[2].replace(",", "."));
    const unit = canonicalMeasurementUnit(match[3]);
    if (!Number.isFinite(first) || !Number.isFinite(second) || !unit) continue;
    const matchingFacets = (facets ?? []).filter((facet) =>
      facet.type === "number" && facet.unit && canonicalMeasurementUnit(facet.unit) === unit
    );
    if (matchingFacets.length !== 1) continue;
    const [low, high] = [Math.min(first, second), Math.max(first, second)];
    const alreadyRepresented = next.some((criterion) => {
      if (canonicalMeasurementUnit(criterion.unit ?? "") !== unit) return false;
      if (criterion.op === "range" && Array.isArray(criterion.value)) {
        return Number(criterion.value[0]) === low && Number(criterion.value[1]) === high;
      }
      return false;
    });
    if (alreadyRepresented) continue;
    const facet = matchingFacets[0];
    const criterion: Criterion = { key: facet.key || facet.caption, op: "range", value: [low, high], unit: facet.unit, level: "A" };
    next.push(criterion);
    added.push(criterion);
  }
  return { criteria: next, added };
}

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
 *
 * Полномочия слоя строго ограничены:
 * 1. Направление меняется ТОЛЬКО для `op:"eq"` — это исходная задача слоя:
 *    клиент назвал число, модель прислала «ровно X», а прозой сказала
 *    «больше X» → `> X`. Если по этому числу проза дала несколько направлений,
 *    сервер не угадывает (границы уходят в `ambiguities`).
 * 2. Для `min` / `max` / `range` направление модели НЕПРИКОСНОВЕННО: из прозы
 *    берётся только строгость, и только у границы того же направления.
 *    Иначе одна распарсенная граница («больше 10 мм») переворачивала бы
 *    противоположный критерий («после усадки ≤ 10 мм») — и требование
 *    становилось физически невыполнимым.
 * 3. Строгость только ужесточается: нестрогая формулировка не размывает
 *    уже строгий критерий.
 *
 * Порог никогда не выдумывается — используется число, названное вслух.
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

    let bound: ReasoningBound | undefined;
    if (c.op === "eq") {
      // Исходная задача слоя: клиент назвал число, модель прислала «ровно X»,
      // а прозой сказала «больше X» → направление берём из прозы.
      // Несколько направлений по одному числу — сервер не угадывает.
      if (candidates.length === 1) bound = candidates[0];
    } else {
      // Направление модель задала осознанно (min / max / range) — сервер его
      // НИКОГДА не переворачивает: из прозы берём только строгость, и только
      // у границы того же направления. Иначе одна распарсенная граница
      // («больше 10 мм») переворачивала бы противоположный критерий
      // («после усадки ≤ 10 мм») и требование становилось невыполнимым.
      bound = candidates.find((b) => b.op === c.op);
    }
    if (!bound) {
      ambiguities.push(...candidates);
      return c;
    }

    // Строгость только ужесточается: если критерий уже строгий, нестрогая
    // формулировка («не менее») его не размывает.
    const strict = bound.strict || (c.op === bound.op && Boolean(c.exclusive));
    if (c.op === bound.op && Boolean(c.exclusive) === strict) return c;

    alignments.push({
      key: c.key,
      from: `${c.op}:${String(c.value)}`,
      to: bound.op,
      value: bound.value,
      unit: c.unit ?? unit,
      strict,
    });
    return { ...c, op: bound.op, value: bound.value, exclusive: strict };

  });

  return { criteria: next, alignments, ambiguities };
}
