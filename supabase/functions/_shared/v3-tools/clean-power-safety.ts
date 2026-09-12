// Deterministic safety boundary for sensitive loads powered from a generator.
// A voltage stabilizer does not prove that the waveform becomes a clean sine;
// therefore no catalog card is safe without explicit output-waveform evidence.

function norm(value: string): string {
  return String(value ?? "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

export function isCleanPowerSafetyRequest(message: string): boolean {
  const text = norm(message);
  const unstableSource = /генератор|грязн\p{L}*\s+(?:энерг\p{L}*|питан\p{L}*|синус\p{L}*)|нестабил\p{L}*\s+напряж\p{L}*/u.test(text);
  const sensitiveLoad = /котел|котёл|котл\p{L}*|циркуляцион\p{L}*\s+насос|чувствительн\p{L}*\s+электрон/u.test(text);
  const cleanOutput = /чист\p{L}*\s+(?:энерг\p{L}*|питан\p{L}*|синус\p{L}*)|pure\s+sine/u.test(text);
  return unstableSource && sensitiveLoad && cleanOutput;
}

export function isSensitiveBackupPowerRequest(message: string): boolean {
  const text = norm(message);
  const backupPower = /(?<!\p{L})(?:ибп|ups)(?!\p{L})|источник\p{L}*\s+бесперебойн\p{L}*\s+питан\p{L}*|бесперебойник/u.test(text);
  const sensitiveLoad = /котел|котёл|котл\p{L}*|циркуляцион\p{L}*\s+насос|чувствительн\p{L}*\s+электрон/u.test(text);
  return backupPower && sensitiveLoad;
}

function extractLoadWatts(message: string): number | null {
  const match = norm(message).match(/(?<!\d)(\d+(?:[.,]\d+)?)\s*(?:вт|w|ватт\p{L}*)(?!\p{L})/u);
  if (!match) return null;
  const watts = Number(match[1].replace(",", "."));
  return Number.isFinite(watts) && watts > 0 ? watts : null;
}

function roundUp(value: number, step: number): number {
  return Math.ceil(value / step) * step;
}

/**
 * Deterministic safety guidance for backup power of a sensitive load. It does
 * not assert catalog availability or recommend an unverified card; numeric
 * guidance is derived only from the load stated by the customer.
 */
export function buildSensitiveBackupPowerAnswer(message: string): string {
  const loadWatts = extractLoadWatts(message);
  const sizing = loadWatts === null
    ? "Мощность выбирайте по максимальному потреблению котла и насоса с запасом не менее 30–50%; отдельно проверьте пусковой ток насоса. Сверяйте активную мощность в Вт, а не только полную мощность в ВА."
    : (() => {
      const recommendedWatts = roundUp(loadWatts * 1.5, 50);
      const recommendedVa = roundUp(recommendedWatts / 0.7, 50);
      return `При нагрузке ${loadWatts} Вт ориентир по активной мощности ИБП — не менее ${recommendedWatts} Вт с учётом 50%-го запаса; по полной мощности это примерно от ${recommendedVa} ВА. Отдельно сверьте пусковой ток циркуляционного насоса: кратковременная допустимая мощность ИБП должна покрывать его пуск.`;
    })();
  return [
    "Для газового котла нужен ИБП с явно указанной чистой синусоидой на выходе: ступенчатая или аппроксимированная форма может нарушать работу электроники, розжига и циркуляционного насоса.",
    sizing,
    "Для времени автономной работы проверьте ёмкость и напряжение батарей, возможность подключения внешнего аккумулятора и допустимый ток заряда. Перед покупкой сопоставьте эти параметры с паспортом конкретной модели котла.",
    "Показывать карточку без подтверждённой формы выходного сигнала небезопасно. Если укажете желаемое время автономной работы и модель котла, расчёт батареи можно уточнить.",
  ].join("\n\n");
}

export const CLEAN_POWER_SAFETY_ANSWER = [
  "Для газового котла и циркуляционного насоса нужен не обычный стабилизатор, а источник, который заново формирует чистую синусоиду.",
  "Подходящий класс решения — on-line ИБП с двойным преобразованием и явно указанной чистой синусоидой на выходе. Обычный релейный или электронный стабилизатор может выровнять напряжение, но не гарантирует исправление искажённой формы сигнала генератора.",
  "Мощность ИБП выбирают по фактической суммарной нагрузке котла и насоса с запасом на пусковой ток; отдельно нужно проверить, принимает ли выбранный ИБП питание именно от вашего генератора 900 Вт.",
  "В текущих данных каталога я не могу подтвердить карточку с этими обязательными характеристиками, поэтому показывать стабилизаторы как замену небезопасно. Уточните у менеджера on-line ИБП с чистой синусоидой и совместимостью с генератором.",
].join("\n\n");
