import type { ProductFull } from "./types.ts";

// The same use-case recognizers drive clarification and card verification.
export const OUTDOOR_AREA_FLOODLIGHT =
  /(?<!\p{L})прожектор\p{L}*[^.!?\n]{0,80}(?:ули[цч]\p{L}*|наруж\p{L}*|двор\p{L}*)|(?<!\p{L})(?:ули[цч]\p{L}*|наруж\p{L}*|двор\p{L}*)[^.!?\n]{0,80}(?<!\p{L})прожектор\p{L}*/iu;
export const PARKING_AREA_FLOODLIGHT =
  /(?<!\p{L})прожектор\p{L}*[^.!?\n]{0,80}парковк\p{L}*|(?<!\p{L})парковк\p{L}*[^.!?\n]{0,80}(?<!\p{L})прожектор\p{L}*/iu;

type Bounds = { min: number; max: number };
type Geometry = { area: Bounds | null; height: Bounds | null };
export type AreaLightingFit = Geometry & { exposed: boolean };

const NUMBER = String.raw`\d+(?:[.,]\d+)?`;
const VALUE = String
  .raw`(?:(до|выше|более)\s*)?(${NUMBER})(?:\s*[–—-]\s*(${NUMBER}))?`;
const AREA_UNIT = String.raw`(?:м[²2]|кв\.?\s*м|квадрат\p{L}*)`;
const HEIGHT_UNIT = String.raw`м(?:етр\p{L}*)?`;
const END = String.raw`(?![\p{L}\p{N}²])`;
const AREA = new RegExp(
  String.raw`(?<![\p{L}\p{N}.,])${VALUE}\s*${AREA_UNIT}${END}`,
  "iu",
);
const SIDES = new RegExp(
  String
    .raw`(?<![\p{L}\p{N}.,])(${NUMBER})\s*[хx×*]\s*(${NUMBER})\s*${HEIGHT_UNIT}${END}`,
  "iu",
);
const HEIGHT = new RegExp(
  String
    .raw`(?:высот\p{L}*|(?:монтаж|креп|установ)\p{L}*\s+на)\s*(?:(?:установки|монтажа|крепления)\s*)?[:=—-]?\s*(?:(?:примерно|около|на)\s*)?${VALUE}\s*${HEIGHT_UNIT}${END}`,
  "iu",
);
const SHORT_HEIGHT = new RegExp(
  String
    .raw`^\s*(?:(?:примерно|около)\s*)?${VALUE}\s*${HEIGHT_UNIT}\s*[.!]?\s*$`,
  "iu",
);
const parse = (s: string) => Number(s.replace(",", "."));
const positive = (n: number) => n > 0 && Number.isFinite(n);
export const isOpenAreaLightingProtection = (value: string): boolean =>
  /^(?:IP\s*)?6[56]$/iu.test(value.trim());

function bounds(match: RegExpMatchArray | null): Bounds | null {
  if (!match) return null;
  const [, qualifier, a, b] = match;
  const min = parse(a);
  const max = b ? parse(b) : min;
  if (!positive(min) || !positive(max) || min > max || (qualifier && b)) {
    return null;
  }
  if (qualifier?.toLowerCase() === "до") return { min: 0, max };
  if (qualifier) return { min, max: Infinity };
  return { min, max };
}

/** Input must be the current message and prior server-verified customer turns,
 * newest first. Never use assistant prose, product dimensions or client history. */
export function compileAreaLightingFit(
  current: string,
  priorNewestFirst: readonly string[],
  selectionRequest: string,
): AreaLightingFit | null {
  const applies = (text: string) =>
    OUTDOOR_AREA_FLOODLIGHT.test(text) ||
    PARKING_AREA_FLOODLIGHT.test(text);
  if (!applies(selectionRequest)) return null;
  const turns = [current, ...priorNewestFirst];
  const base = turns.findIndex(applies);
  if (base === -1) return null;
  const active = turns.slice(0, base + 1);
  let area: Bounds | null = null;
  let height: Bounds | null = null;
  let areaWithdrawn = false;
  let heightWithdrawn = false;
  for (const turn of active) {
    areaWithdrawn ||=
      /площад\p{L}*[^,;.!?\n]{0,24}(?:не\s+знаю|неизвестн\p{L}*)/iu.test(turn);
    heightWithdrawn ||=
      /высот\p{L}*[^,;.!?\n]{0,30}(?:не\s+знаю|неизвестн\p{L}*)/iu.test(turn);
    const sides = turn.match(SIDES);
    const rectangle = sides ? parse(sides[1]) * parse(sides[2]) : 0;
    if (!areaWithdrawn) {
      area ??= bounds(turn.match(AREA)) ??
        (positive(rectangle) ? { min: rectangle, max: rectangle } : null);
    }
    if (!heightWithdrawn) {
      height ??= bounds(turn.match(HEIGHT)) ??
        (turn !== turns[base] ? bounds(turn.match(SHORT_HEIGHT)) : null);
    }
  }
  if (!area && !height) return null;
  // A covered installation is not evidence of open-weather exposure. Its
  // explicit IP requirements still go through the existing criteria checks.
  const sheltered =
    /(?:под\s+(?:навес|крыш)\p{L}*|крыт\p{L}*\s+парковк\p{L}*|в\s+помещени\p{L}*)/iu;
  const open =
    /(?:без\s+(?:навес|крыш)\p{L}*|под\s+открыт\p{L}*\s+неб\p{L}*|открыт\p{L}*\s+парковк\p{L}*)/iu;
  const exposureTurn = active.find((turn) =>
    open.test(turn) || sheltered.test(turn)
  );
  return { area, height, exposed: !exposureTurn || open.test(exposureTurn) };
}

const LABEL_UNIT_HEIGHT = String.raw`(?:[,\s(]+м\)?)?`;
const MOUNT = new RegExp(
  String
    .raw`^(?:(?:рекомендуемая|допустимая|максимальная|минимальная|диапазон)\s+)?высот[аы]\s+(?:установки|монтажа|крепления)${LABEL_UNIT_HEIGHT}$`,
  "iu",
);
const COVERAGE = new RegExp(
  String
    .raw`^(?:максимальная\s+)?площадь\s+(?:освещения|освещаемой\s+(?:зоны|территории))(?:[,\s(]+м[²2]\)?)?$`,
  "iu",
);
const COVERAGE_AT_HEIGHT = new RegExp(
  String
    .raw`^(?:максимальная\s+)?площадь\s+освещения\s+при\s+высоте\s+(?:(?:установки|монтажа)\s+)?${VALUE}\s*м(?:[,\s(]+м[²2]\)?)?$`,
  "iu",
);

function catalogBounds(value: string, unit: string): Bounds | null {
  return bounds(
    value.trim().match(
      new RegExp(String.raw`^${VALUE}(?:\s*${unit})?$`, "iu"),
    ),
  );
}

export function areaLightingCardIssue(
  product: ProductFull | undefined,
  fit: AreaLightingFit,
): "type" | "protection" | "height" | "coverage" | "missing_geometry" | null {
  if (!product || !/(?<!\p{L})прожектор\p{L}*/iu.test(product.pagetitle)) {
    return "type";
  }
  const traits = Object.entries(product.facet_values ?? {}).map((
    [key, values],
  ) => [product.facet_captions?.[key]?.trim() ?? "", values] as const);
  if (fit.exposed) {
    const ipTraits = traits.filter(([caption]) =>
      /^(?:ip|(?:степень|класс)\s+(?:ip\s+)?защиты(?:\s*\(?ip\)?)?)$/iu
        .test(caption)
    ).flatMap(([, values]) => values);
    // 65/66 are documented jet ratings. Immersion-only labels do not
    // establish jet protection. Respect explicit customer IP via existing gates.
    const titleCodes = [
      ...product.pagetitle.matchAll(
        /(?<![\p{L}\p{N}])ip\s*([0-6x][0-9x])(?![\p{L}\p{N}])/giu,
      ),
    ]
      .map((match) => match[1]);
    const ratings = ipTraits.map((value) =>
      /^(?:ip\s*)?([0-6x][0-9x])$/iu.exec(value.trim())?.[1] ?? ""
    );
    const jet = isOpenAreaLightingProtection;
    if (
      !(ratings.length ? ratings : titleCodes).some(jet) ||
      !ratings.every(jet) || !titleCodes.every(jet)
    ) return "protection";
  }
  if (
    !fit.area || !fit.height || !Number.isFinite(fit.area.max) ||
    !Number.isFinite(fit.height.max)
  ) return "missing_geometry";
  const { area, height } = fit;
  const supportedHeights = traits.filter(([caption]) => MOUNT.test(caption))
    .flatMap(([caption, values]) =>
      values.map((value) => {
        const declared = catalogBounds(value, HEIGHT_UNIT);
        if (
          !declared || /^(?:до|выше|более)/iu.test(value.trim())
        ) return declared;
        if (/^максимальная/iu.test(caption)) {
          return { min: 0, max: declared.max };
        }
        if (/^минимальная/iu.test(caption)) {
          return { min: declared.min, max: Infinity };
        }
        return declared;
      })
    );
  if (
    supportedHeights.some((declared) =>
      !declared ||
      declared.min > height.min || declared.max < height.max
    )
  ) return "height";
  const coverage = traits.flatMap(([caption, values]) => {
    const at = bounds(caption.match(COVERAGE_AT_HEIGHT));
    const paired = at && at.min <= height.min && at.max >= height.max;
    // A generic area at one declared mounting height is usable. It must not
    // be transferred across an entire height range without paired evidence.
    const singleMount = supportedHeights.some((bound) =>
      bound && bound.min === height.min && bound.max === height.max &&
      bound.min === bound.max
    );
    return paired || (singleMount && COVERAGE.test(caption))
      ? values.map((value) => catalogBounds(value, AREA_UNIT)?.max ?? 0)
      : [];
  });
  if (
    coverage.length === 0 ||
    coverage.some((max) => !Number.isFinite(max) || max < area.max)
  ) return "coverage";
  return null;
}

function describe(bounds: Bounds, unit: string): string {
  const format = (value: number) => String(value).replace(".", ",");
  if (!Number.isFinite(bounds.max)) {
    return `более ${format(bounds.min)} ${unit}`;
  }
  if (!bounds.min) return `до ${format(bounds.max)} ${unit}`;
  return `${format(bounds.min)}${
    bounds.min !== bounds.max ? `–${format(bounds.max)}` : ""
  } ${unit}`;
}

export function areaLightingFitText(
  fit: AreaLightingFit,
  found: boolean,
): string {
  const geometry = [
    fit.area ? `площадь — ${describe(fit.area, "м²")}` : "",
    fit.height ? `высота установки — ${describe(fit.height, "м")}` : "",
  ].filter(Boolean).join(", ");
  if (found) {
    return `Учёл условия: ${geometry}. Параметры в карточках подтверждены, но это не расчёт освещения всего участка.`;
  }
  if (
    !fit.area || !fit.height || !Number.isFinite(fit.area.max) ||
    !Number.isFinite(fit.height.max)
  ) {
    const missing = [
      !fit.area || !Number.isFinite(fit.area.max) ? "площадь участка" : "",
      !fit.height || !Number.isFinite(fit.height.max) ? "высоту установки" : "",
    ].filter(Boolean).join(" и ");
    return `Учёл условия: ${geometry}. Для проверки уточните ${missing}.`;
  }
  return `Учёл условия: ${geometry}. Среди проверенных карточек не нашёл прожектор, для которого подтверждены все условия. По IP и ваттам нельзя определить площадь освещения. Менеджер может сверить её по паспорту светильника и схеме установки.`;
}
