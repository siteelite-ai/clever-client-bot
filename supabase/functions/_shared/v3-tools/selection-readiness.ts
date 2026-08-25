import type { ProposeClarificationInput } from "./propose-clarification.ts";

export interface SelectionReadinessClarification extends ProposeClarificationInput {
  profile: string;
}

interface ReadinessProfile {
  id: string;
  applies: RegExp;
  required: RegExp[];
  question: string;
  facet_key: string;
  options: ProposeClarificationInput["options"];
}

// These are reusable engineering-selection profiles, not catalog aliases or
// product values. A profile only decides whether the request contains enough
// input data to start a safe search; live discovery still owns all filters.
const PROFILES: ReadinessProfile[] = [
  {
    id: "pump_cable",
    applies: /кабел\p{L}*[^.!?\n]{0,50}(?:для\s+)?насос\p{L}*/iu,
    required: [
      /(?:мощн\p{L}*|ток\p{L}*|\d+(?:[.,]\d+)?\s*(?:к?вт|а))/iu,
      /(?:длин\p{L}*|расстоян\p{L}*|\d+(?:[.,]\d+)?\s*м(?:етр\p{L}*)?)/iu,
      /(?:напряж\p{L}*|фаз\p{L}*|\b(?:220|230|380|400)\s*в?\b)/iu,
      /(?:улиц\p{L}*|помещен\p{L}*|перенос\p{L}*|стационар\p{L}*|проклад\p{L}*)/iu,
    ],
    question: "Чтобы безопасно подобрать кабель для насоса, уточните, пожалуйста: мощность или рабочий ток насоса; длину линии/расстояние; напряжение и число фаз; способ прокладки — в помещении, на улице, стационарно или как переносное подключение. С чего начнём?",
    facet_key: "supply_phase",
    options: [
      { value: "220 В, 1 фаза", label: "220 В, 1 фаза" },
      { value: "380 В, 3 фазы", label: "380 В, 3 фазы" },
    ],
  },
  {
    id: "underground_cable",
    applies: /кабел\p{L}*[^.!?\n]{0,80}(?:земл\p{L}*|подзем\p{L}*)|проклад\p{L}*[^.!?\n]{0,40}земл\p{L}*/iu,
    required: [
      /(?:труб\p{L}*|пнд|брон\p{L}*|непосредственно\s+в\s+земл)/iu,
      /(?:мощн\p{L}*|ток\p{L}*|\d+(?:[.,]\d+)?\s*(?:к?вт|а))/iu,
      /(?:напряж\p{L}*|фаз\p{L}*|\b(?:220|230|380|400)\s*в?\b)/iu,
      /(?:жил\p{L}*|заземл\p{L}*)/iu,
    ],
    question: "Для подземной линии нужно уточнить: кабель пойдёт прямо в землю (тогда обычно рассматривают бронированный) или в трубе/ПНД; мощность либо ток нагрузки; напряжение и число фаз; требуемое число жил и наличие заземления. Как планируется прокладка?",
    facet_key: "installation_method",
    options: [
      { value: "В трубе/ПНД", label: "В трубе/ПНД" },
      { value: "Прямо в земле", label: "Прямо в земле" },
    ],
  },
  {
    id: "motor_breaker",
    applies: /автомат\p{L}*[^.!?\n]{0,60}(?:для\s+)?двигател\p{L}*/iu,
    required: [
      /(?:мощн\p{L}*|ток\p{L}*|\d+(?:[.,]\d+)?\s*(?:к?вт|а))/iu,
      /(?:напряж\p{L}*|фаз\p{L}*|\b(?:220|230|380|400)\s*в?\b)/iu,
      /(?:пуск\p{L}*|характерист\p{L}*|крив\p{L}*)/iu,
    ],
    question: "Для выбора автомата двигателя нужны мощность или рабочий ток, напряжение и число фаз, а также условия пуска/требуемая характеристика срабатывания. Какое питание у двигателя?",
    facet_key: "supply_phase",
    options: [
      { value: "220 В, 1 фаза", label: "220 В, 1 фаза" },
      { value: "380 В, 3 фазы", label: "380 В, 3 фазы" },
    ],
  },
  {
    id: "apartment_breaker",
    applies: /автомат\p{L}*[^.!?\n]{0,80}(?:квартир\p{L}*|квартир\p{L}*[^.!?\n]{0,80}автомат\p{L}*)/iu,
    required: [
      /(?:полюс\p{L}*|\b[1234]\s*[pрп]\b|фаз\p{L}*)/iu,
      /(?:характерист\p{L}*|крив\p{L}*|(?:^|\s)[bcdвсд](?:\s|$))/iu,
      /(?:отключ\p{L}*|\d+(?:[.,]\d+)?\s*к?а\b)/iu,
    ],
    question: "Номинал тока понятен. До подбора уточните полюсность/число фаз, характеристику (кривую B, C или D) и требуемую отключающую способность в кА. Какая полюсность нужна?",
    facet_key: "pole_count",
    options: [
      { value: "1P", label: "1P" },
      { value: "2P", label: "2P" },
      { value: "3P", label: "3P" },
    ],
  },
  {
    id: "kg_cable_replacement",
    applies: /замен\p{L}*[^.!?\n]{0,50}(?:кабел\p{L}*\s+)?кг(?!\p{L})/iu,
    required: [
      /(?:услов\p{L}*|примен\p{L}*|назнач\p{L}*|подключ\p{L}*)/iu,
      /(?:сечен\p{L}*|\d+\s*[xх×*]\s*\d+(?:[.,]\d+)?|жил\p{L}*)/iu,
      /(?:гибк\p{L}*|стационар\p{L}*|подвиж\p{L}*)/iu,
    ],
    question: "Замена КГ зависит от условий применения и назначения подключения. Уточните сечение и число жил, а также нужна ли гибкость для подвижного подключения или кабель будет проложен стационарно. Как он используется?",
    facet_key: "installation_mode",
    options: [
      { value: "Подвижное подключение", label: "Подвижное" },
      { value: "Стационарная прокладка", label: "Стационарное" },
    ],
  },
  {
    id: "cable_lug",
    applies: /наконечник\p{L}*[^.!?\n]{0,80}кабел\p{L}*/iu,
    required: [
      /(?:мед\p{L}*|алюмин\p{L}*)/iu,
      /(?:болт\p{L}*|клемм\p{L}*|отверст\p{L}*|тип\p{L}*)/iu,
    ],
    question: "Сечение кабеля понятно. Для выбора наконечника уточните материал жилы — медь или алюминий — и тип присоединения: под болт/размер отверстия либо в клемму. Какой материал жилы?",
    facet_key: "conductor_material",
    options: [
      { value: "Медь", label: "Медь" },
      { value: "Алюминий", label: "Алюминий" },
    ],
  },
  {
    id: "surveillance_cable",
    applies: /кабел\p{L}*[^.!?\n]{0,80}видеонаблюден\p{L}*/iu,
    required: [
      /(?:цифров\p{L}*|аналог\p{L}*|ip[- ]?камер)/iu,
      /(?:улиц\p{L}*|помещен\p{L}*)/iu,
      /(?:poe|питан\p{L}*|расстоян\p{L}*)/iu,
    ],
    question: "Уточните систему видеонаблюдения: цифровая/IP или аналоговая; прокладка на улице или в помещении; нужны ли PoE/питание по кабелю и какая длина линии/расстояние. Какая система камер?",
    facet_key: "camera_system",
    options: [
      { value: "Цифровая/IP", label: "Цифровая/IP" },
      { value: "Аналоговая", label: "Аналоговая" },
    ],
  },
  {
    id: "warm_led_lamp",
    applies: /светодиодн\p{L}*\s+ламп\p{L}*[^.!?\n]{0,100}(?:тепл\p{L}*|3000\s*к)|(?:тепл\p{L}*|3000\s*к)[^.!?\n]{0,100}светодиодн\p{L}*\s+ламп\p{L}*/iu,
    required: [
      /(?:цокол\p{L}*|\b(?:e|е|gu|gx)\s*\d+\b)/iu,
      /(?:форм\p{L}*|колб\p{L}*)/iu,
      /(?:мощн\p{L}*|\d+(?:[.,]\d+)?\s*(?:вт|w)\b)/iu,
    ],
    question: "Тёплый свет 3000 К понятен. Чтобы выбрать лампу, уточните цоколь, форму колбы и желаемую мощность в ваттах. Какой цоколь нужен?",
    facet_key: "socket_type",
    options: [
      { value: "E27", label: "E27" },
      { value: "E14", label: "E14" },
      { value: "GU10", label: "GU10" },
    ],
  },
  {
    id: "parking_floodlight",
    applies: /прожектор\p{L}*[^.!?\n]{0,80}парковк\p{L}*|парковк\p{L}*[^.!?\n]{0,80}прожектор\p{L}*/iu,
    required: [
      /\bip\s*6[56]\b/iu,
      /(?:площад\p{L}*|размер\p{L}*|территор\p{L}*)/iu,
      /(?:высот\p{L}*|установ\p{L}*)/iu,
    ],
    question: "Для парковки сначала нужны площадь территории и высота установки. Для улицы также уточним требуемую защиту, обычно рассматривают IP65/IP66. Какая площадь и высота монтажа?",
    facet_key: "mounting_height",
    options: [
      { value: "До 4 м", label: "До 4 м" },
      { value: "4–8 м", label: "4–8 м" },
      { value: "Выше 8 м", label: "Выше 8 м" },
    ],
  },
];

export function selectReadinessClarification(
  currentMessage: string,
  dialogueEvidence = "",
): SelectionReadinessClarification | null {
  const current = String(currentMessage ?? "").trim();
  if (!current) return null;
  const evidence = `${dialogueEvidence}\n${current}`;
  for (const profile of PROFILES) {
    if (!profile.applies.test(current)) continue;
    if (profile.required.every((requirement) => requirement.test(evidence))) {
      return null;
    }
    return {
      profile: profile.id,
      question: profile.question,
      facet_key: profile.facet_key,
      options: profile.options,
    };
  }
  return null;
}
