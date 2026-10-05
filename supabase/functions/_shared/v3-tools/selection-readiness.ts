import type { ProposeClarificationInput } from "./propose-clarification.ts";

const SELECTION_READINESS_SCOPE = "selection_readiness";

export function selectionReadinessScope(
  token: string,
  context: { resolved_category?: string; assistance_level?: number } = {},
): {
  kind: string;
  token: string;
  resolved_category?: string;
  assistance_level?: number;
} {
  const resolvedCategory = String(context.resolved_category ?? "").trim()
    .slice(0, 200);
  const assistanceLevel = Number.isInteger(context.assistance_level) &&
      Number(context.assistance_level) > 0
    ? Math.min(Number(context.assistance_level), 2)
    : 0;
  return {
    kind: SELECTION_READINESS_SCOPE,
    token: String(token ?? "").trim().slice(0, 500),
    ...(resolvedCategory ? { resolved_category: resolvedCategory } : {}),
    ...(assistanceLevel ? { assistance_level: assistanceLevel } : {}),
  };
}

/**
 * Rebuild a catalog continuation from a server-issued clarification while
 * preserving the exact live category that justified the question. A terse
 * answer therefore cannot lose either the product code or taxonomy scope.
 */
export function resolveScopedCatalogSelectionContinuation(
  currentMessage: string,
  slots: Record<string, unknown>,
): { message: string; category: string } | null {
  const current = String(currentMessage ?? "").trim();
  const pending = slots?.pending_clarification;
  if (!current || !pending || typeof pending !== "object") return null;
  const scope = (pending as { scope?: unknown }).scope;
  if (!scope || typeof scope !== "object") return null;
  const record = scope as {
    kind?: unknown;
    token?: unknown;
    resolved_category?: unknown;
  };
  if (
    record.kind !== SELECTION_READINESS_SCOPE ||
    typeof record.token !== "string" ||
    typeof record.resolved_category !== "string"
  ) return null;
  const original = record.token.trim().slice(0, 500);
  const category = record.resolved_category.trim().slice(0, 200);
  if (!original || !category) return null;
  return {
    message: `${original}\nУточнение клиента: ${current}`,
    category,
  };
}

export interface SelectionReadinessClarification
  extends ProposeClarificationInput {
  profile: string;
}

export interface SelectionReadinessAssistance
  extends ProposeClarificationInput {
  assistance_level: number;
}

interface PendingClarificationRecord {
  status?: unknown;
  question?: unknown;
  facet_key?: unknown;
  options?: unknown;
  scope?: unknown;
}

const UNCERTAIN_CLARIFICATION_REPLY =
  /(?:не\s+(?:знаю|понимаю|разбираюсь|уверен\p{L}*)|без\s+понятия|затрудняюсь|какие\s+(?:есть\s+)?варианты|что\s+лучше|посовет\p{L}*|подскаж\p{L}*|выбер\p{L}*\s+(?:сам\p{L}*|за\s+меня))/iu;
const REPEATED_SELECTION_REPLY =
  /^(?:подбер\p{L}*|покаж\p{L}*|найд\p{L}*)\s+(?:их|эти|такие|варианты)(?:\s+(?:в\s+каталог\p{L}*|пожалуйста))*[.!?]*$/iu;

const FACET_PLAIN_LANGUAGE: Record<string, string> = {
  supply_phase:
    "Посмотрите на паспорт оборудования или вводной щит: 220–230 В обычно означает одну фазу, 380–400 В — три фазы.",
  line_length:
    "Нужна примерная длина трассы от источника питания до оборудования; точность до метра не обязательна.",
  installation_method:
    "Важно только, будет ли кабель защищён трубой/ПНД или ляжет непосредственно в грунт.",
  motor_start_method:
    "Прямой пуск — двигатель подключается без частотника; частотник или софтстартер обычно указан в схеме или стоит рядом с двигателем.",
  pole_count:
    "Обозначения числа полюсов: 1P применяют для обычной однофазной линии; 2P одновременно отключает фазу и ноль; 3P предназначен для трёхфазной линии, 4P — для трёхфазной линии с отключением нейтрали. Для замены ориентируйтесь на маркировку существующего аппарата или проект.",
  trip_curve:
    "B выбирают для нагрузок с небольшими пусковыми токами, C — наиболее распространённый бытовой вариант, D — для больших пусковых токов. Если проекта нет, окончательный выбор лучше сверить с электриком.",
  installation_mode:
    "Подвижное подключение требует гибкого кабеля; для неподвижно закреплённой линии выбирают стационарную прокладку.",
  conductor_material:
    "Материал жилы обычно виден на срезе или указан в маркировке кабеля: медь имеет красноватый цвет, алюминий — серебристый.",
  camera_system:
    "IP-камера подключается к компьютерной сети (часто по Ethernet/PoE), аналоговая — коаксиальным или комбинированным кабелем к регистратору.",
  socket_type:
    "Маркировка цоколя обычно напечатана на старой лампе или патроне — например E27, E14 или GU10.",
  mounting_height:
    "Достаточно примерной высоты от земли до места крепления; точность до сантиметра не нужна.",
};

const FACET_OPTION_LABELS: Record<string, Record<string, string>> = {
  supply_phase: {
    "220 в, 1 фаза": "220 В — обычная однофазная сеть",
    "380 в, 3 фазы": "380 В — трёхфазная сеть",
  },
  pole_count: {
    "1p": "1P — обычная однофазная линия",
    "2p": "2P — отключать фазу и ноль",
    "3p": "3P — трёхфазная линия",
    "4p": "4P — три фазы и нейтраль",
  },
  trip_curve: {
    b: "B — небольшие пусковые токи",
    c: "C — типичный бытовой вариант",
    d: "D — большие пусковые токи",
  },
};

function normalizedClarificationOptions(
  value: unknown,
): ProposeClarificationInput["options"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string" && entry.trim()) {
      return [{ value: entry.trim(), label: entry.trim() }];
    }
    if (!entry || typeof entry !== "object") return [];
    const option = entry as { value?: unknown; label?: unknown };
    const optionValue = typeof option.value === "string"
      ? option.value.trim()
      : "";
    if (!optionValue) return [];
    return [{
      value: optionValue,
      label: typeof option.label === "string" && option.label.trim()
        ? option.label.trim()
        : optionValue,
    }];
  }).slice(0, 5);
}

/**
 * Turns an explicit "I do not know" reply into guided, observable choices.
 * The rule is scoped to any server-issued readiness clarification, so it does
 * not depend on a product category and cannot hijack an ordinary request for
 * more products.  The original selection scope is preserved for the next
 * turn, while a bounded assistance level prevents verbatim question loops.
 */
export function selectReadinessAssistance(
  currentMessage: string,
  slots: Record<string, unknown>,
): SelectionReadinessAssistance | null {
  const current = String(currentMessage ?? "").trim();
  if (
    !current ||
    (!UNCERTAIN_CLARIFICATION_REPLY.test(current) &&
      !REPEATED_SELECTION_REPLY.test(current))
  ) return null;
  const pending = slots?.pending_clarification as
    | PendingClarificationRecord
    | undefined;
  if (!pending || typeof pending !== "object") return null;
  if (pending.status != null && pending.status !== "pending") return null;
  const scope = pending.scope;
  if (!scope || typeof scope !== "object") return null;
  const scoped = scope as {
    kind?: unknown;
    token?: unknown;
    resolved_category?: unknown;
    assistance_level?: unknown;
  };
  if (
    scoped.kind !== SELECTION_READINESS_SCOPE ||
    typeof scoped.token !== "string" ||
    !scoped.token.trim()
  ) return null;
  const facetKey = typeof pending.facet_key === "string"
    ? pending.facet_key.trim()
    : "";
  const options = normalizedClarificationOptions(pending.options);
  const freeform = options.length === 0 &&
    (facetKey === "readiness_remaining" ||
      facetKey === "selection_prerequisite");
  if (!facetKey || (!freeform && options.length < 2)) return null;

  const currentLevel = Number.isInteger(scoped.assistance_level)
    ? Number(scoped.assistance_level)
    : 0;
  const assistanceLevel = Math.min(currentLevel + 1, 2);
  const terminal = assistanceLevel === 2;
  const helpKey = FACET_PLAIN_LANGUAGE[facetKey]
    ? facetKey
    : /количеств\p{L}*\s+полюс\p{L}*|полюсност/iu.test(
        String(pending.question ?? ""),
      )
    ? "pole_count"
    : facetKey;
  const explanation = FACET_PLAIN_LANGUAGE[helpKey] ??
    "Ориентируйтесь на надпись на оборудовании, упаковке или проекте — специальная терминология не требуется.";
  const labels = FACET_OPTION_LABELS[helpKey] ?? {};
  const guidedOptions = options.map((option) => {
    const key = helpKey === "pole_count" && /^[1-4]$/u.test(option.value)
      ? `${option.value}p`
      : option.value.toLocaleLowerCase("ru-RU");
    return { value: option.value, label: labels[key] ?? option.label };
  });
  const question = freeform
    ? !terminal
      ? "Не нужно угадывать технические параметры. Посмотрите маркировку оборудования или проект и пришлите хотя бы известные значения; если их нет, я могу объяснить типы решений, но не назвать безопасный конкретный товар."
      : "Не буду повторять вопрос: без данных с маркировки или проекта безопасный подбор конкретного товара пока невозможен. Пришлите их позже либо уточните у квалифицированного специалиста; я помогу сравнить варианты после этого."
    : !terminal
    ? `Разбираться в терминах не обязательно. ${explanation} Можно ответить текстом: ${
      guidedOptions.map((option) => `«${option.label}»`).join("; ")
    }. Если ни один вариант не подходит, напишите, что указано на оборудовании или в проекте.`
    : `Не буду повторять прежний вопрос. ${explanation} Если определить параметр не получается, безопаснее уточнить маркировку или проект у электрика/монтажника. Пришлите данные позже — тогда я продолжу подбор.`;

  return {
    assistance_level: assistanceLevel,
    question,
    // Keep the original selection scope while waiting for real facts. Ending
    // the question ladder must not discard the task when details arrive later.
    facet_key: terminal ? "readiness_remaining" : facetKey,
    options: terminal ? [] : guidedOptions,
    ...(freeform || terminal ? { freeform: true } : {}),
    scope: selectionReadinessScope(scoped.token, {
      resolved_category: typeof scoped.resolved_category === "string"
        ? scoped.resolved_category
        : undefined,
      assistance_level: assistanceLevel,
    }),
  };
}

interface ReadinessProfile {
  id: string;
  applies: RegExp;
  required: RegExp[];
  /** Requirement represented by the opening quick replies. */
  initial_requirement_index: number;
  /** Human-readable counterparts of `required`, in the same order. */
  missing_labels: string[];
  /**
   * Follow-up controls keyed by a still-missing requirement.  This lets one
   * generic readiness engine advance a multi-turn clarification instead of
   * repeating the profile's opening question or prematurely starting search.
   */
  follow_ups?: Array<{
    requirement_index: number;
    question: string;
    facet_key: string;
    options: ProposeClarificationInput["options"];
  }>;
  /** Resolve overlapping profiles without relying on declaration order. */
  priority?: number;
  question: string;
  facet_key: string;
  options: ProposeClarificationInput["options"];
}

export function selectionReadinessEvidenceFromHistory(
  history: Array<{ role: string; content: string }>,
): string {
  return history
    .filter((message) => message.role === "user")
    .map((message) => String(message.content ?? "").trim())
    .filter(Boolean)
    .join("\n");
}

function explicitCompactSpecificationTokens(value: string): string[] {
  const source = String(value ?? "");
  const matches = [
    ...(source.match(
      /(?<![\p{L}\p{N}])[\p{L}]{1,8}\s*\d{1,8}(?:[.,-]\d{1,8})*(?![\p{L}\p{N}])/gu,
    ) ?? []),
    ...(source.match(
      /(?<![\p{L}\p{N}])\d{1,8}(?:[.,-]\d{1,8})*\s*[\p{L}]{1,8}(?![\p{L}\p{N}])/gu,
    ) ?? []),
  ];
  const visual: Record<string, string> = {
    а: "a",
    в: "b",
    е: "e",
    к: "k",
    м: "m",
    н: "h",
    о: "o",
    р: "p",
    с: "c",
    т: "t",
    у: "y",
    х: "x",
  };
  return [
    ...new Set(
      matches.map((token) =>
        token.toLocaleLowerCase("ru-RU")
          .replace(/ё/gu, "е")
          .replace(/[авекмнорстух]/gu, (char) => visual[char] ?? char)
          .replace(/\s+/gu, "")
      ).filter(Boolean),
    ),
  ];
}

/**
 * A plain availability browse that already names several independently
 * checkable product specifications must not be blocked by optional preference
 * questions. Compatibility selections (`for/under/to another object`) remain
 * protected by their readiness profile because missing data there can change
 * safety or fit. This is grammatical and works for every product category.
 */
export function specifiedAvailabilityBrowseIsActionable(
  message: string,
): boolean {
  const source = String(message ?? "").trim();
  const availability =
    /(?:есть\s+ли|у\s+(?:вас|тебя)\s+есть|име(?:ется|ются)|прода(?:е(?:те|шь)|ются)|быва(?:ет|ют)\s+ли)/iu
      .test(source);
  if (!availability) return false;
  if (/(?:^|[\s,;])(?:для|под|к|ко)\s+\p{L}/iu.test(source)) return false;
  return explicitCompactSpecificationTokens(source).length >= 2;
}

/**
 * A measured engineering question is not the same interaction as an order to
 * select a purchasable SKU. When the customer explicitly supplies a load and
 * asks what is needed, the consultant must first expose the calculation and
 * its assumptions; demanding every final catalog attribute before that
 * reasoning hides useful information and can even ask for a value that the
 * supplied load is meant to derive. Explicit catalog imperatives remain under
 * the strict readiness profiles below.
 */
export function measuredLoadGuidanceCanProceed(message: string): boolean {
  const source = String(message ?? "").trim();
  if (!source) return false;
  const asksGuidance =
    /(?:какой|какая|какое|какие)[^.!?\n]{0,120}(?:нужен|нужна|нужно|нужны|подойдет|подойдут)/iu
      .test(source);
  const measuredLoad =
    /нагрузк\p{L}*[^.!?\n]{0,40}\d+(?:[.,]\d+)?\s*(?:к?вт|а)(?=$|[^\p{L}\p{N}])|\d+(?:[.,]\d+)?\s*(?:к?вт|а)(?=$|[^\p{L}\p{N}])[^.!?\n]{0,40}нагрузк\p{L}*/iu
      .test(source);
  const catalogImperative =
    /(?:^|[^\p{L}])(?:найд\p{L}*|подбер\p{L}*|покаж\p{L}*|предлож\p{L}*|выбер\p{L}*)(?=$|[^\p{L}])/iu
      .test(source);
  return asksGuidance && measuredLoad && !catalogImperative;
}

// These are reusable engineering-selection profiles, not catalog aliases or
// product values. A profile only decides whether the request contains enough
// input data to start a safe search; live discovery still owns all filters.
const PROFILES: ReadinessProfile[] = [
  {
    id: "electrical_distribution_plan",
    initial_requirement_index: 0,
    priority: 20,
    // A request for the quantity/composition of protection devices in a
    // distribution board is a project-sizing task, not a SKU search. Area by
    // itself cannot determine circuit topology, so collect the three inputs
    // that change the answer before any catalogue branch is allowed to run.
    applies:
      /(?:скольк\p{L}*|количеств\p{L}*|состав\p{L}*)[^.!?\n]{0,90}(?:автомат\p{L}*|дифавтомат\p{L}*|узо)[^.!?\n]{0,90}(?:щит\p{L}*|дом\p{L}*)|(?:щит\p{L}*|дом\p{L}*)[^.!?\n]{0,90}(?:скольк\p{L}*|количеств\p{L}*)[^.!?\n]{0,90}(?:автомат\p{L}*|дифавтомат\p{L}*|узо)/iu,
    required: [
      /(?:однофаз\p{L}*|трехфаз\p{L}*|трёхфаз\p{L}*|\b(?:220|230|380|400)\s*в?\b)/iu,
      /(?:мощн\p{L}*|выделен\p{L}*[^.!?\n]{0,20}\d+(?:[.,]\d+)?\s*к?вт|\d+(?:[.,]\d+)?\s*к?вт)/iu,
      /(?:плит\p{L}*|бойлер\p{L}*|котел\p{L}*|котёл\p{L}*|тепл\p{L}*\s+пол\p{L}*|тёпл\p{L}*\s+пол\p{L}*|кондиционер\p{L}*|насос\p{L}*|саун\p{L}*|электромобил\p{L}*)/iu,
    ],
    missing_labels: [
      "однофазный или трёхфазный ввод (220/380 В)",
      "выделенную/расчётную мощность",
      "перечень мощных нагрузок и отдельных линий",
    ],
    question:
      "Площадь дома сама по себе не определяет количество автоматов. Для расчёта щита уточните: ввод однофазный 220 В или трёхфазный 380 В; какая выделенная/расчётная мощность; какие мощные нагрузки нужны отдельными линиями — плита, бойлер/котёл, тёплый пол, кондиционеры, насос, сауна или зарядка электромобиля?",
    facet_key: "supply_phase",
    options: [
      { value: "220 В, 1 фаза", label: "220 В, 1 фаза" },
      { value: "380 В, 3 фазы", label: "380 В, 3 фазы" },
    ],
  },
  {
    id: "pump_cable",
    initial_requirement_index: 2,
    applies: /кабел\p{L}*[^.!?\n]{0,50}(?:для\s+)?насос\p{L}*/iu,
    required: [
      /(?:мощн\p{L}*|ток\p{L}*|\d+(?:[.,]\d+)?\s*(?:к?вт|а))/iu,
      /(?:длин\p{L}*|расстоян\p{L}*|\d+(?:[.,]\d+)?\s*м(?:етр\p{L}*)?)/iu,
      /(?:напряж\p{L}*|фаз\p{L}*|\b(?:220|230|380|400)\s*в?\b)/iu,
      /(?:улиц\p{L}*|помещен\p{L}*|перенос\p{L}*|стационар\p{L}*|проклад\p{L}*)/iu,
    ],
    missing_labels: [
      "мощность или рабочий ток насоса",
      "длину линии/расстояние",
      "напряжение и число фаз",
      "способ прокладки",
    ],
    follow_ups: [
      {
        requirement_index: 2,
        question: "Какое питание у насоса?",
        facet_key: "supply_phase",
        options: [
          { value: "220 В, 1 фаза", label: "220 В, 1 фаза" },
          { value: "380 В, 3 фазы", label: "380 В, 3 фазы" },
        ],
      },
      {
        requirement_index: 1,
        question: "Какая длина линии от источника питания до насоса?",
        facet_key: "line_length",
        options: [
          { value: "До 25 м", label: "До 25 м" },
          { value: "25–50 м", label: "25–50 м" },
          { value: "Более 50 м", label: "Более 50 м" },
        ],
      },
    ],
    question:
      "Чтобы безопасно подобрать кабель для насоса, уточните, пожалуйста: мощность или рабочий ток насоса; длину линии/расстояние; напряжение и число фаз; способ прокладки — в помещении, на улице, стационарно или как переносное подключение. С чего начнём?",
    facet_key: "supply_phase",
    options: [
      { value: "220 В, 1 фаза", label: "220 В, 1 фаза" },
      { value: "380 В, 3 фазы", label: "380 В, 3 фазы" },
    ],
  },
  {
    id: "underground_cable",
    initial_requirement_index: 0,
    applies:
      /кабел\p{L}*[^.!?\n]{0,80}(?:земл\p{L}*|подзем\p{L}*)|проклад\p{L}*[^.!?\n]{0,40}земл\p{L}*/iu,
    required: [
      /(?:труб\p{L}*|пнд|брон\p{L}*|(?:непосредственно|прямо)\s+в\s+(?:земл|грунт))/iu,
      /(?:мощн\p{L}*|ток\p{L}*|\d+(?:[.,]\d+)?\s*(?:к?вт|а))/iu,
      /(?:напряж\p{L}*|фаз\p{L}*|\b(?:220|230|380|400)\s*в?\b)/iu,
      /(?:жил\p{L}*|заземл\p{L}*)/iu,
    ],
    missing_labels: [
      "способ прокладки — в трубе/ПНД или прямо в земле",
      "мощность или ток нагрузки",
      "напряжение и число фаз",
      "число жил и наличие заземления",
    ],
    follow_ups: [
      {
        requirement_index: 2,
        question:
          "Если кабель лежит прямо в грунте, обычно рассматривают силовой бронированный кабель; для прокладки в трубе условия другие. Конкретную марку и сечение без нагрузки и схемы питания выбирать нельзя. У линии однофазное питание 220–230 В или трёхфазное 380–400 В?",
        facet_key: "supply_phase",
        options: [
          { value: "220 В, 1 фаза", label: "220 В, 1 фаза" },
          { value: "380 В, 3 фазы", label: "380 В, 3 фазы" },
        ],
      },
    ],
    question:
      "Для подземной линии нужно уточнить: кабель пойдёт прямо в землю (тогда обычно рассматривают бронированный) или в трубе/ПНД; мощность либо ток нагрузки; напряжение и число фаз; требуемое число жил и наличие заземления. Как планируется прокладка?",
    facet_key: "installation_method",
    options: [
      { value: "В трубе/ПНД", label: "В трубе/ПНД" },
      { value: "Прямо в земле", label: "Прямо в земле" },
    ],
  },
  {
    id: "motor_breaker",
    initial_requirement_index: 1,
    applies: /автомат\p{L}*[^.!?\n]{0,60}(?:для\s+)?двигател\p{L}*/iu,
    required: [
      /(?:мощн\p{L}*|ток\p{L}*|\d+(?:[.,]\d+)?\s*(?:к?вт|а))/iu,
      /(?:напряж\p{L}*|фаз\p{L}*|\b(?:220|230|380|400)\s*в?\b)/iu,
      /(?:пуск\p{L}*|характерист\p{L}*|крив\p{L}*)/iu,
    ],
    missing_labels: [
      "мощность либо номинальный рабочий ток по шильдику",
      "напряжение и число фаз",
      "условия пуска и требуемую характеристику срабатывания",
    ],
    follow_ups: [
      {
        requirement_index: 2,
        question:
          "Как запускается двигатель? Если известен номинальный рабочий ток по шильдику, укажите и его.",
        facet_key: "motor_start_method",
        options: [
          { value: "Прямой пуск", label: "Прямой пуск" },
          {
            value: "Через частотник/софтстартер",
            label: "Частотник/софтстартер",
          },
        ],
      },
    ],
    question:
      "Для выбора автомата двигателя нужны мощность или рабочий ток, напряжение и число фаз, а также условия пуска/требуемая характеристика срабатывания. Какое питание у двигателя?",
    facet_key: "supply_phase",
    options: [
      { value: "220 В, 1 фаза", label: "220 В, 1 фаза" },
      { value: "380 В, 3 фазы", label: "380 В, 3 фазы" },
    ],
  },
  {
    id: "apartment_breaker",
    initial_requirement_index: 0,
    applies:
      /автомат\p{L}*[^.!?\n]{0,80}(?:квартир\p{L}*|квартир\p{L}*[^.!?\n]{0,80}автомат\p{L}*)/iu,
    required: [
      /(?:полюс\p{L}*|\b[1234]\s*[pрп]\b|фаз\p{L}*)/iu,
      /(?:характерист\p{L}*|крив\p{L}*|(?:^|\s)[bcdвсд](?:\s|$))/iu,
    ],
    missing_labels: [
      "полюсность или число фаз",
      "характеристику B, C или D",
    ],
    follow_ups: [
      {
        requirement_index: 0,
        question: "Какая полюсность нужна?",
        facet_key: "pole_count",
        options: [
          { value: "1P", label: "1P" },
          { value: "2P", label: "2P" },
          { value: "3P", label: "3P" },
        ],
      },
      {
        requirement_index: 1,
        question: "Какая характеристика срабатывания указана в проекте?",
        facet_key: "trip_curve",
        options: [
          { value: "B", label: "B" },
          { value: "C", label: "C" },
          { value: "D", label: "D" },
        ],
      },
    ],
    question:
      "Номинал тока понятен. До подбора уточните полюсность/число фаз и характеристику (кривую B, C или D). Если проект задаёт отключающую способность в кА, также укажите её. Какая полюсность нужна?",
    facet_key: "pole_count",
    options: [
      { value: "1P", label: "1P" },
      { value: "2P", label: "2P" },
      { value: "3P", label: "3P" },
    ],
  },
  {
    id: "kg_cable_replacement",
    initial_requirement_index: 2,
    applies: /замен\p{L}*[^.!?\n]{0,50}(?:кабел\p{L}*\s+)?кг(?!\p{L})/iu,
    required: [
      /(?:услов\p{L}*|примен\p{L}*|назнач\p{L}*|подключ\p{L}*)/iu,
      /(?:сечен\p{L}*|\d+\s*[xх×*]\s*\d+(?:[.,]\d+)?|жил\p{L}*)/iu,
      /(?:гибк\p{L}*|стационар\p{L}*|подвиж\p{L}*)/iu,
    ],
    missing_labels: [
      "назначение и условия применения",
      "сечение и число жил",
      "подвижное или стационарное подключение",
    ],
    question:
      "Замена КГ зависит от условий применения и назначения подключения. Уточните сечение и число жил, а также нужна ли гибкость для подвижного подключения или кабель будет проложен стационарно. Как он используется?",
    facet_key: "installation_mode",
    options: [
      { value: "Подвижное подключение", label: "Подвижное" },
      { value: "Стационарная прокладка", label: "Стационарное" },
    ],
  },
  {
    id: "cable_lug",
    initial_requirement_index: 0,
    applies: /наконечник\p{L}*[^.!?\n]{0,80}кабел\p{L}*/iu,
    required: [
      /(?:мед\p{L}*|алюмин\p{L}*)/iu,
      /(?:болт\p{L}*|клемм\p{L}*|отверст\p{L}*|тип\p{L}*)/iu,
    ],
    missing_labels: [
      "материал жилы — медь или алюминий",
      "тип присоединения и размер болта/отверстия",
    ],
    question:
      "Сечение кабеля понятно. Для выбора наконечника уточните материал жилы — медь или алюминий — и тип присоединения: под болт/размер отверстия либо в клемму. Какой материал жилы?",
    facet_key: "conductor_material",
    options: [
      { value: "Медь", label: "Медь" },
      { value: "Алюминий", label: "Алюминий" },
    ],
  },
  {
    id: "surveillance_cable",
    initial_requirement_index: 0,
    applies: /кабел\p{L}*[^.!?\n]{0,80}видеонаблюден\p{L}*/iu,
    required: [
      /(?:цифров\p{L}*|аналог\p{L}*|ip[- ]?камер)/iu,
      /(?:улиц\p{L}*|помещен\p{L}*)/iu,
      /(?:poe|питан\p{L}*|расстоян\p{L}*|длин\p{L}*|трасс\p{L}*)/iu,
    ],
    missing_labels: [
      "тип системы — цифровая/IP или аналоговая",
      "место прокладки — улица или помещение",
      "PoE/способ питания и длину линии",
    ],
    question:
      "Уточните систему видеонаблюдения: цифровая/IP или аналоговая; прокладка на улице или в помещении; нужны ли PoE/питание по кабелю и какая длина линии/расстояние. Какая система камер?",
    facet_key: "camera_system",
    options: [
      { value: "Цифровая/IP", label: "Цифровая/IP" },
      { value: "Аналоговая", label: "Аналоговая" },
    ],
  },
  {
    id: "warm_led_lamp",
    initial_requirement_index: 0,
    applies:
      /светодиодн\p{L}*\s+ламп\p{L}*[^.!?\n]{0,100}(?:тепл\p{L}*|3000\s*к)|(?:тепл\p{L}*|3000\s*к)[^.!?\n]{0,100}светодиодн\p{L}*\s+ламп\p{L}*/iu,
    required: [
      /(?:цокол\p{L}*|\b(?:e|е|gu|gx)\s*\d+\b)/iu,
      /(?:форм\p{L}*|колб\p{L}*)/iu,
      /(?:мощн\p{L}*|\d+(?:[.,]\d+)?\s*(?:вт|w)\b)/iu,
    ],
    missing_labels: [
      "тип цоколя",
      "форму колбы",
      "желаемую мощность",
    ],
    question:
      "Тёплый свет 3000 К понятен. Чтобы выбрать лампу, уточните цоколь, форму колбы и желаемую мощность в ваттах. Какой цоколь нужен?",
    facet_key: "socket_type",
    options: [
      { value: "E27", label: "E27" },
      { value: "E14", label: "E14" },
      { value: "GU10", label: "GU10" },
    ],
  },
  {
    id: "outdoor_floodlight",
    initial_requirement_index: 1,
    applies:
      /прожектор\p{L}*[^.!?\n]{0,80}(?:ули[цч]\p{L}*|наруж\p{L}*)|(?:ули[цч]\p{L}*|наруж\p{L}*)[^.!?\n]{0,80}прожектор\p{L}*/iu,
    required: [
      /(?:площад\p{L}*|размер\p{L}*|территор\p{L}*|\d+(?:[.,]\d+)?\s*(?:м2|м²|кв(?:\.|\s)*м))/iu,
      /(?:высот\p{L}*|установ\p{L}*|монтаж\p{L}*|\d+(?:[.,]\d+)?\s*м(?:етр\p{L}*)?(?=$|[^\p{L}\p{N}²]))/iu,
    ],
    missing_labels: [
      "площадь или размеры территории",
      "высоту установки",
    ],
    question:
      "Чтобы подобрать уличный прожектор по задаче, уточните площадь или примерные размеры территории и высоту установки. Какая площадь двора и на какой высоте будет установлен прожектор?",
    facet_key: "mounting_height",
    options: [
      { value: "До 4 м", label: "До 4 м" },
      { value: "4–8 м", label: "4–8 м" },
      { value: "Выше 8 м", label: "Выше 8 м" },
    ],
  },
  {
    id: "parking_floodlight",
    initial_requirement_index: 1,
    priority: 10,
    applies:
      /прожектор\p{L}*[^.!?\n]{0,80}парковк\p{L}*|парковк\p{L}*[^.!?\n]{0,80}прожектор\p{L}*/iu,
    required: [
      /(?:площад\p{L}*|размер\p{L}*|территор\p{L}*|\d+(?:[.,]\d+)?\s*(?:м2|м²|кв(?:\.|\s)*м))/iu,
      /(?:высот\p{L}*|установ\p{L}*|\d+(?:[.,]\d+)?\s*м(?:етр\p{L}*)?(?=$|[^\p{L}\p{N}²]))/iu,
    ],
    missing_labels: [
      "площадь или размеры парковки",
      "высоту установки",
    ],
    question:
      "Для парковки сначала нужны площадь территории и высота установки. Для улицы также уточним требуемую защиту, обычно рассматривают IP65/IP66. Какая площадь и высота монтажа?",
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
  options: { progressive?: boolean } = {},
): SelectionReadinessClarification | null {
  const current = String(currentMessage ?? "").trim();
  if (!current) return null;
  const evidence = `${dialogueEvidence}\n${current}`;
  const profile = PROFILES
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => candidate.applies.test(current))
    .sort((left, right) =>
      (right.candidate.priority ?? 0) - (left.candidate.priority ?? 0) ||
      left.index - right.index
    )[0]?.candidate;
  if (!profile) return null;
  if (specifiedAvailabilityBrowseIsActionable(current)) return null;
  if (measuredLoadGuidanceCanProceed(current)) return null;
  const missing = profile.required
    .map((requirement, index) => requirement.test(evidence) ? -1 : index)
    .filter((index) => index >= 0);
  if (missing.length === 0) return null;
  const followUp = options.progressive
    ? profile.follow_ups?.find((candidate) =>
      missing.includes(candidate.requirement_index)
    )
    : undefined;
  // Once the opening facet has been answered, its quick replies are stale.
  // Numeric and other open-ended gaps cannot honestly be represented by those
  // same choices: keep the scoped conversation, but ask for free-form facts.
  const freeformRemaining = options.progressive === true && !followUp &&
    !missing.includes(profile.initial_requirement_index);
  const missingSummary = missing
    .map((index) => profile.missing_labels[index])
    .filter(Boolean)
    .join("; ");
  return {
    profile: profile.id,
    question: followUp
      ? `Осталось уточнить: ${missingSummary}. ${followUp.question}`
      : freeformRemaining
      ? `Указанный параметр учёл. Для точного подбора ещё нужны: ${missingSummary}. Напишите, что из этого известно; если не знаете, так и скажите — объясню, где посмотреть.`
      : profile.question,
    facet_key: followUp?.facet_key ??
      (freeformRemaining ? "readiness_remaining" : profile.facet_key),
    options: followUp?.options ?? (freeformRemaining ? [] : profile.options),
    ...(freeformRemaining ? { freeform: true } : {}),
    scope: selectionReadinessScope(current),
  };
}

/** Rebuilds one actionable selection request from the original scoped turn
 * and a free-form answer to its clarification. This avoids asking a useful
 * question and then making the model infer the product class from an answer
 * such as "120 m², height 4 m" alone. */
export function resolveSelectionReadinessRequest(
  currentMessage: string,
  slots: Record<string, unknown>,
): { message: string; scoped: boolean } {
  const current = String(currentMessage ?? "").trim();
  const pending = slots?.pending_clarification;
  if (!pending || typeof pending !== "object") {
    return { message: current, scoped: false };
  }
  const scope = (pending as { scope?: unknown }).scope;
  if (!scope || typeof scope !== "object") {
    return { message: current, scoped: false };
  }
  const record = scope as { kind?: unknown; token?: unknown };
  if (
    record.kind !== SELECTION_READINESS_SCOPE ||
    typeof record.token !== "string"
  ) {
    return { message: current, scoped: false };
  }
  const original = record.token.trim().slice(0, 500);
  if (!original || !current) return { message: current, scoped: false };
  return {
    message: `${original}\nУточнение клиента: ${current}`,
    scoped: true,
  };
}
