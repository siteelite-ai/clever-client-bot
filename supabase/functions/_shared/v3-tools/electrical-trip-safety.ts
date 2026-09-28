const TRIP_DEVICE = /(?:выбива\p{L}*|отключа\p{L}*|срабатыва\p{L}*)[^.!?\n]{0,80}(?:автомат\p{L}*|узо|диф(?:автомат\p{L}*)?)/iu;
const LOAD_EVENT = /(?:при|после|во\s+время)\s+(?:включен\p{L}*|подключен\p{L}*|запуск\p{L}*|работ\p{L}*)/iu;

/** Electrical protection trips are a safety diagnostic, never a product
 * selection. The classifier describes the incident shape and contains no
 * appliance, brand or catalog vocabulary. */
export function isElectricalProtectionTripDiagnostic(message: string): boolean {
  const text = String(message ?? "").replace(/ё/gu, "е");
  return TRIP_DEVICE.test(text) && LOAD_EVENT.test(text);
}

const FOLLOWUP_FACTS = /(?:\d+(?:[.,]\d+)?\s*(?:к?вт|а|в|сек)|автомат\p{L}*|узо|диф(?:автомат\p{L}*)?|кабел\p{L}*|сечен\p{L}*|фаз\p{L}*|сразу|через\s+\d+)/iu;
const PRODUCT_SELECTION = /(?:^|[^\p{L}])(?:найд\p{L}*|подбер\p{L}*|покаж\p{L}*|предлож\p{L}*|выбер\p{L}*)(?=$|[^\p{L}])/iu;

export interface ElectricalTripResolution {
  original: string;
  current: string;
  followup: boolean;
}

/**
 * Keeps a safety diagnostic active for a concise factual reply.  The prior
 * incident, not a product dictionary, supplies the scope; an explicit new
 * selection command is never captured.  Conversation-boundary handling has
 * already removed unrelated complete tasks before this resolver runs.
 */
export function resolveElectricalProtectionTripDiagnostic(
  currentMessage: string,
  history: Array<{ role: string; content: string }> = [],
): ElectricalTripResolution | null {
  const current = String(currentMessage ?? "").trim();
  if (!current) return null;
  if (isElectricalProtectionTripDiagnostic(current)) {
    return { original: current, current, followup: false };
  }
  if (PRODUCT_SELECTION.test(current) || !FOLLOWUP_FACTS.test(current)) return null;
  const original = [...history]
    .reverse()
    .find((message) => message.role === "user" && isElectricalProtectionTripDiagnostic(message.content))
    ?.content.trim();
  return original ? { original, current, followup: true } : null;
}

export function buildElectricalProtectionTripFollowupAnswer(message: string): string {
  const text = String(message ?? "").replace(/ё/gu, "е");
  const powerMatch = text.match(/(\d+(?:[.,]\d+)?)\s*квт/iu);
  const powerKw = powerMatch ? Number(powerMatch[1].replace(",", ".")) : null;
  const singlePhaseCurrent = powerKw && Number.isFinite(powerKw)
    ? Math.round(powerKw * 1000 / 230 * 10) / 10
    : null;
  const estimate = singlePhaseCurrent
    ? `При ${powerKw} кВт однофазная нагрузка 230 В потребляет ориентировочно ${singlePhaseCurrent} А, но это ещё не основание увеличивать номинал автомата.`
    : "По этим данным ещё нельзя безопасно менять номинал или характеристику автомата.";
  return [
    estimate,
    "Нужно проверить напряжение и число фаз, маркировку установленного автомата, материал и сечение кабеля, длину и способ прокладки линии, а также время срабатывания — сразу или после прогрева.",
    "Если дифавтомата нет, уточните, установлено ли отдельное УЗО: обычный автомат защищает от перегрузки и короткого замыкания, но не заменяет дифференциальную защиту от утечки.",
    "До проверки кабеля, контактов, сопротивления изоляции и тока утечки не включайте прибор повторно. Диагностику и выбор защиты должен выполнить квалифицированный электрик; конкретный номинал без этих измерений не называю.",
  ].join("\n\n");
}

export const ELECTRICAL_PROTECTION_TRIP_ANSWER = [
  "Не увеличивайте номинал автомата и не заменяйте защиту без проверки — это может перегреть проводку и создать риск пожара.",
  "Проверьте исходные данные: мощность прибора и рабочий ток (ориентировочно I = P / 230 В), номинал и характеристику автомата. Если ток нагрузки близок к номиналу защиты или линия питает другие приборы, возможна перегрузка.",
  "Если автомат срабатывает сразу, возможны короткое замыкание, повреждение кабеля, вилки, розетки или плохой контакт. Если отключается УЗО/дифавтомат, вероятна утечка тока — например, из-за повреждения изоляции или неисправности самого прибора.",
  "До диагностики отключите прибор и не включайте его повторно. Безопасно проверить линию, контакты, сопротивление изоляции и ток утечки должен квалифицированный электрик. Для уточнения сообщите мощность прибора, маркировку автомата, есть ли УЗО/дифавтомат и через сколько секунд происходит отключение.",
].join("\n\n");
