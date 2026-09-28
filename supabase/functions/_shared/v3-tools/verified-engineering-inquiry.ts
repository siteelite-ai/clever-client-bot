/**
 * Deterministic answers for bounded engineering questions whose result follows
 * from a stable formula or a safety condition.  These rules are the verified
 * offline layer of the inquiry route: they never claim catalog availability,
 * never choose a SKU and never turn an application assumption into a product
 * filter.  A question outside the narrow proof conditions returns null and is
 * handled by the ordinary consultant.
 */

export interface VerifiedEngineeringInquiry {
  rule: string;
  answer: string;
}

function normalize(value: string): string {
  return String(value ?? "")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е")
    .replace(/\s+/gu, " ")
    .trim();
}

function extractLumens(text: string): number | null {
  const match = normalize(text).match(
    /(?<!\d)(\d{1,3}(?:[ .]\d{3})*|\d+)\s*(?:лм|люмен\p{L}*)(?!\p{L})/u,
  );
  if (!match) return null;
  const value = Number(match[1].replace(/[ .]/gu, ""));
  return Number.isFinite(value) && value > 0 && value <= 1_000_000
    ? value
    : null;
}

function extractVoltage(text: string): number | null {
  const match = normalize(text).match(
    /(?<!\d)(\d{2,4}(?:[.,]\d+)?)\s*(?:в|вольт\p{L}*)(?!\p{L})/u,
  );
  if (!match) return null;
  const value = Number(match[1].replace(",", "."));
  return Number.isFinite(value) && value > 0 ? value : null;
}

function cableComparison(text: string): VerifiedEngineeringInquiry | null {
  const source = normalize(text);
  const hasVvgNg = /(?<!\p{L})ввг\s*[- ]?нг(?!\p{L})/u.test(source);
  const hasNym = /(?<![a-zа-я])nym(?![a-zа-я])/iu.test(source);
  const comparison = /отлич\p{L}*|сравн\p{L}*|разниц\p{L}*|что\s+лучше|какой\s+лучше/u
    .test(source);
  if (!hasVvgNg || !hasNym || !comparison) return null;
  return {
    rule: "cable_vvgng_nym_comparison",
    answer: [
      "ВВГнг и NYM применяют для стационарной проводки, но это разные конструкции. ВВГнг не распространяет горение при групповой прокладке; для квартиры обычно рассматривают исполнение ВВГнг-LS с пониженным дымо- и газовыделением. NYM имеет заполнение между жилами и оболочкой, поэтому круглее и удобнее в монтаже, но его оболочку обычно защищают от прямого УФ-излучения.",
      "Для скрытой проводки внутри сухого помещения допустимый вариант выбирают по проекту: нужны медные жилы требуемого сечения, корректное число жил и подтверждённая пожарная маркировка. На практике для квартирной проводки часто выбирают ВВГнг-LS; NYM тоже применим внутри помещения, если конкретный кабель соответствует стандарту и условиям прокладки.",
      "Окончательные сечение, способ прокладки и защиту линии должен подтвердить проект или квалифицированный электрик.",
    ].join("\n\n"),
  };
}

function floodlightEstimate(text: string): VerifiedEngineeringInquiry | null {
  const source = normalize(text);
  const lumens = extractLumens(source);
  const floodlight = /прожектор\p{L}*/u.test(source);
  const asksEstimate = /скольк\p{L}*\s+ватт|какая\s+мощност|мощност\p{L}*|какую\s+площад|площад\p{L}*\s+(?:он|это)\s+освещ/u
    .test(source);
  if (!floodlight || lumens === null || !asksEstimate) return null;
  const minWatts = Math.max(1, Math.ceil(lumens / 120));
  const maxWatts = Math.max(minWatts, Math.ceil(lumens / 80));
  const areaAt100Lux = Math.max(1, Math.round(lumens / 100));
  const areaAt50Lux = Math.max(areaAt100Lux, Math.round(lumens / 50));
  return {
    rule: "floodlight_lumen_power_area_estimate",
    answer: [
      `Для светового потока ${lumens.toLocaleString("ru-RU")} лм типичная мощность современного LED-прожектора — примерно ${minWatts}–${maxWatts} Вт при эффективности около 80–120 лм/Вт. Это ориентир: точное значение зависит от светодиодов и драйвера.`,
      `Площадь определяется требуемой освещённостью: по формуле E = Φ / S теоретически получится около ${areaAt100Lux} м² при 100 лк или ${areaAt50Lux} м² при 50 лк. Реальная площадь будет меньше из-за высоты, угла луча, отражений и потерь; для выбора нужно знать назначение площадки и высоту установки.`,
    ].join("\n\n"),
  };
}

function lowVoltageStabilizerGuidance(
  text: string,
): VerifiedEngineeringInquiry | null {
  const source = normalize(text);
  const voltage = extractVoltage(source);
  const stabilizer = /стабилизатор\p{L}*[^.!?\n]{0,40}напряжен\p{L}*|стабилизатор\p{L}*/u
    .test(source);
  const lowInput = /пада\p{L}*|проседа\p{L}*|понижен\p{L}*|низк\p{L}*|входн\p{L}*/u
    .test(source);
  if (!stabilizer || !lowInput || voltage === null || voltage > 210) return null;
  return {
    rule: "stabilizer_low_input_guidance",
    answer: [
      `При просадке до ${voltage} В сначала нужен стабилизатор, у которого рабочий входной диапазон явно включает ${voltage} В не только как предельное отключение. На пониженном входном напряжении доступная выходная мощность у многих моделей уменьшается, поэтому номинал по лицевой мощности выбирать нельзя.`,
      "Посчитайте максимальную одновременную нагрузку дома в кВт, отдельно учтите пусковые токи насосов, холодильников и другого двигателя. Затем сверяйте график допустимой мощности при 170 В и оставляйте запас примерно 20–30%; если производитель задаёт коэффициент снижения мощности, применяйте именно его.",
      "Для точного подбора нужны суммарная и пиковая мощность нагрузки, число фаз и минимальное фактически измеренное входное напряжение.",
    ].join("\n\n"),
  };
}

function threePhaseMotorOnSinglePhase(
  text: string,
): VerifiedEngineeringInquiry | null {
  const source = normalize(text);
  const motor = /двигател\p{L}*/u.test(source);
  const threePhase = /тр[её]хфаз\p{L}*|3\s*фаз/u.test(source);
  const singlePhase = /однофаз\p{L}*|бытов\p{L}*\s+сет|(?:^|\D)220\s*в?(?:$|\D)/u
    .test(source);
  const asksConnection = /подключ\p{L}*|можно\s+ли|как\s+запуст/u.test(source);
  if (!motor || !threePhase || !singlePhase || !asksConnection) return null;
  return {
    rule: "three_phase_motor_single_phase_supply",
    answer: [
      "Подключение возможно не для любого трёхфазного двигателя. Сначала проверьте шильдик и схему обмоток: двигатель с маркировкой 220/380 В обычно подключают к 220 В треугольником; двигатель 380/660 В напрямую к однофазной сети 220 В через конденсатор подключать нельзя.",
      "Конденсаторная схема требует рабочего, а иногда и пускового конденсатора, но пусковой момент и полезная мощность обычно снижаются примерно на 30–50%. Ёмкость нельзя безопасно выбирать только по слову «двигатель» — нужны мощность, номинальный ток и схема на шильдике.",
      "Более управляемое решение — частотный преобразователь с однофазным входом 220 В и трёхфазным выходом 220 В, если обмотки допускают соединение треугольником на 220 В. Схему и защиту должен проверить квалифицированный электрик.",
    ].join("\n\n"),
  };
}

const RULES = [
  cableComparison,
  floodlightEstimate,
  lowVoltageStabilizerGuidance,
  threePhaseMotorOnSinglePhase,
] as const;

export function resolveVerifiedEngineeringInquiry(
  message: string,
): VerifiedEngineeringInquiry | null {
  for (const rule of RULES) {
    const result = rule(message);
    if (result) return result;
  }
  return null;
}
