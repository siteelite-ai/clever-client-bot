// Deterministic safety boundary for sensitive loads powered from a generator.
// A voltage stabilizer does not prove that the waveform becomes a clean sine;
// therefore no catalog card is safe without explicit output-waveform evidence.

function norm(value: string): string {
  return String(value ?? "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

export function isCleanPowerSafetyRequest(message: string): boolean {
  const text = norm(message);
  const unstableSource = /генератор|грязн\p{L}*\s+(?:энерг\p{L}*|питан\p{L}*|синус\p{L}*)|нестабил\p{L}*\s+напряж\p{L}*/u.test(text);
  const sensitiveLoad = /котел|котёл|циркуляцион\p{L}*\s+насос|чувствительн\p{L}*\s+электрон/u.test(text);
  const cleanOutput = /чист\p{L}*\s+(?:энерг\p{L}*|питан\p{L}*|синус\p{L}*)|pure\s+sine/u.test(text);
  return unstableSource && sensitiveLoad && cleanOutput;
}

export const CLEAN_POWER_SAFETY_ANSWER = [
  "Для газового котла и циркуляционного насоса нужен не обычный стабилизатор, а источник, который заново формирует чистую синусоиду.",
  "Подходящий класс решения — on-line ИБП с двойным преобразованием и явно указанной чистой синусоидой на выходе. Обычный релейный или электронный стабилизатор может выровнять напряжение, но не гарантирует исправление искажённой формы сигнала генератора.",
  "Мощность ИБП выбирают по фактической суммарной нагрузке котла и насоса с запасом на пусковой ток; отдельно нужно проверить, принимает ли выбранный ИБП питание именно от вашего генератора 900 Вт.",
  "В текущих данных каталога я не могу подтвердить карточку с этими обязательными характеристиками, поэтому показывать стабилизаторы как замену небезопасно. Уточните у менеджера on-line ИБП с чистой синусоидой и совместимостью с генератором.",
].join("\n\n");
