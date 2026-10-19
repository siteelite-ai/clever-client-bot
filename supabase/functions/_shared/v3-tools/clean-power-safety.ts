// Deterministic safety boundary for sensitive loads powered from a generator.
// A voltage stabilizer does not prove that the waveform becomes a clean sine;
// therefore no catalog card is safe without explicit output-waveform evidence.

function norm(value: string): string {
  return String(value ?? "").toLowerCase().replace(/ё/g, "е").replace(
    /\s+/g,
    " ",
  ).trim();
}

export function isCleanPowerSafetyRequest(message: string): boolean {
  const text = norm(message);
  const unstableSource =
    /генератор|грязн\p{L}*\s+(?:энерг\p{L}*|питан\p{L}*|синус\p{L}*)|нестабил\p{L}*\s+напряж\p{L}*/u
      .test(text);
  const sensitiveLoad =
    /котел|котёл|котл\p{L}*|циркуляцион\p{L}*\s+насос|чувствительн\p{L}*\s+электрон/u
      .test(text);
  const cleanOutput =
    /чист\p{L}*\s+(?:энерг\p{L}*|питан\p{L}*|синус\p{L}*)|pure\s+sine/u.test(
      text,
    );
  return unstableSource && sensitiveLoad && cleanOutput;
}

export function isSensitiveBackupPowerRequest(message: string): boolean {
  const text = norm(message);
  const backupPower =
    /(?<!\p{L})(?:ибп|ups)(?!\p{L})|источник\p{L}*\s+бесперебойн\p{L}*\s+питан\p{L}*|бесперебойник/u
      .test(text);
  const sensitiveLoad =
    /котел|котёл|котл\p{L}*|циркуляцион\p{L}*\s+насос|чувствительн\p{L}*\s+электрон/u
      .test(text);
  return backupPower && sensitiveLoad;
}

/**
 * A generator's stated power is not the boiler's consumption. We only use a
 * wattage that is attached to a load/consumption noun. Multiple independent
 * wattages need clarification rather than an invented combined load.
 */
export function extractSensitiveLoadWatts(message: string): number | null {
  const text = norm(message);
  const measurements = [
    ...text.matchAll(
      /(?<!\d)(\d+(?:[.,]\d+)?)\s*(?:вт|w|ватт\p{L}*)(?!\p{L})/gu,
    ),
  ];
  const grounded: number[] = [];
  for (const match of measurements) {
    const index = match.index ?? 0;
    const prefix = text.slice(Math.max(0, index - 65), index);
    const sourceNoun =
      [...prefix.matchAll(/генератор\p{L}*/gu)].at(-1)?.index ?? -1;
    const loadNoun = [...prefix.matchAll(
      /кот(?:ел|л)\p{L}*|насос\p{L}*|нагрузк\p{L}*|потреблен\p{L}*/gu,
    )].at(-1)?.index ?? -1;
    if (loadNoun < 0 || sourceNoun > loadNoun) continue;
    const watts = Number(match[1].replace(",", "."));
    if (Number.isFinite(watts) && watts > 0) grounded.push(watts);
  }
  return grounded.length === 1 ? grounded[0] : null;
}

function roundUp(value: number, step: number): number {
  return Math.ceil(value / step) * step;
}

/**
 * Deterministic safety guidance for backup power of a sensitive load. It does
 * not assert catalog availability or recommend an unverified card; numeric
 * guidance is derived only from the load stated by the customer.
 */
export function buildSensitiveBackupPowerGuidance(message: string): string {
  const loadWatts = extractSensitiveLoadWatts(message);
  const sizing = loadWatts === null
    ? "Уточните максимальное суммарное потребление котла и насоса в Вт. Мощность ИБП выбирайте с запасом 50% и отдельно проверьте пусковой ток насоса: номинальная мощность в ВА не заменяет активную мощность в Вт."
    : (() => {
      const recommendedWatts = roundUp(loadWatts * 1.5, 50);
      return `Если ${loadWatts} Вт — максимальное суммарное потребление котла и насоса, предварительный ориентир по активной выходной мощности ИБП — не менее ${recommendedWatts} Вт с 50%-м запасом. Отдельно сверьте пусковой ток циркуляционного насоса: кратковременная допустимая мощность ИБП должна покрывать его пуск. Одного номинала в ВА для этого недостаточно.`;
    })();
  return [
    "Для газового котла нужен ИБП с явно указанной чистой синусоидой на выходе: ступенчатая или аппроксимированная форма может нарушать работу электроники, розжига и циркуляционного насоса.",
    sizing,
    "Для времени автономной работы проверьте ёмкость и напряжение батарей, возможность подключения внешнего аккумулятора и допустимый ток заряда. Перед покупкой сопоставьте эти параметры с паспортом конкретной модели котла.",
    /генератор/u.test(norm(message))
      ? "Если питание будет от генератора, совместимость входа конкретного ИБП с его напряжением и частотой пока не подтверждена; это нужно сверить по паспортам обоих устройств."
      : "",
  ].filter(Boolean).join("\n\n");
}

export function buildSensitiveBackupPowerAnswer(message: string): string {
  return [
    buildSensitiveBackupPowerGuidance(message),
    "Без проверки карточек каталога я не могу подтвердить конкретную модель ИБП с чистой синусоидой и достаточной активной мощностью. Если укажете желаемое время автономной работы и модель котла, расчёт батареи можно уточнить.",
  ].join("\n\n");
}

export const CLEAN_POWER_SAFETY_ANSWER = [
  "Для газового котла и циркуляционного насоса нужен не обычный стабилизатор, а источник, который заново формирует чистую синусоиду.",
  "Подходящий класс решения — on-line ИБП с двойным преобразованием и явно указанной чистой синусоидой на выходе. Обычный релейный или электронный стабилизатор может выровнять напряжение, но не гарантирует исправление искажённой формы сигнала генератора.",
  "Мощность ИБП выбирают по фактической суммарной нагрузке котла и насоса с запасом на пусковой ток; отдельно нужно проверить совместимость входа ИБП с вашим генератором.",
  "Без проверки карточек каталога я не могу подтвердить конкретную модель с этими характеристиками, поэтому показывать стабилизаторы как замену небезопасно. Уточните у менеджера ИБП с чистой синусоидой и совместимостью с генератором.",
].join("\n\n");
