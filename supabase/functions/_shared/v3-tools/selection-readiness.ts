import type { ProposeClarificationInput } from "./propose-clarification.ts";

const SELECTION_READINESS_SCOPE = "selection_readiness";

export interface CompletedSelectionReadinessLog {
  session_id: unknown;
  error: unknown;
  response_events: unknown;
}

/**
 * Client slots are only a transport echo. A readiness continuation may inherit
 * its original request only when the immediately preceding completed server
 * response issued that exact pending slot. The caller must supply the latest
 * prior log, not search older logs for a matching UUID.
 */
export function resolveServerIssuedSelectionReadinessPending(
  clientSlots: Record<string, unknown>,
  latestCompletedLog: CompletedSelectionReadinessLog | null,
  sessionId: string,
): Record<string, unknown> | null {
  const client = clientSlots?.pending_clarification;
  if (!client || typeof client !== "object" || Array.isArray(client)) {
    return null;
  }
  const clientRecord = client as Record<string, unknown>;
  const clientScope = clientRecord.scope;
  if (
    clientRecord.status !== "pending" ||
    typeof clientRecord.slot_id !== "string" ||
    !clientRecord.slot_id.trim() ||
    !clientScope || typeof clientScope !== "object" ||
    Array.isArray(clientScope)
  ) return null;
  const clientScopeRecord = clientScope as Record<string, unknown>;
  if (
    clientScopeRecord.kind !== SELECTION_READINESS_SCOPE ||
    typeof clientScopeRecord.token !== "string" ||
    !clientScopeRecord.token.trim()
  ) return null;
  if (!latestCompletedLog || latestCompletedLog.error != null) return null;
  const events = latestCompletedLog.response_events;
  if (!Array.isArray(events)) return null;
  const issuedIntoSession = latestCompletedLog.session_id === sessionId ||
    events.some((event) =>
      event && typeof event === "object" &&
      event.type === "conversation_boundary" && event.mode === "new_task" &&
      event.session_id === sessionId
    );
  if (!issuedIntoSession) return null;
  const complete = events.some((event) =>
    event && typeof event === "object" && event.type === "diagnostic" &&
    event.phase === "complete" && !event.error
  );
  const done = events.some((event) =>
    event && typeof event === "object" && event.type === "done"
  );
  if (!complete || !done) return null;
  const lastSlotUpdate = [...events].reverse().find((event) =>
    event && typeof event === "object" && event.type === "slot_update"
  );
  const issued = lastSlotUpdate?.slots?.pending_clarification;
  if (!issued || typeof issued !== "object" || Array.isArray(issued)) {
    return null;
  }
  const issuedRecord = issued as Record<string, unknown>;
  const issuedScope = issuedRecord.scope;
  if (
    issuedRecord.status !== "pending" ||
    issuedRecord.slot_id !== clientRecord.slot_id ||
    issuedRecord.facet_key !== clientRecord.facet_key ||
    !issuedScope || typeof issuedScope !== "object" ||
    Array.isArray(issuedScope)
  ) return null;
  const issuedScopeRecord = issuedScope as Record<string, unknown>;
  if (
    issuedScopeRecord.kind !== SELECTION_READINESS_SCOPE ||
    issuedScopeRecord.token !== clientScopeRecord.token ||
    typeof issuedScopeRecord.token !== "string" ||
    !issuedScopeRecord.token.trim() ||
    issuedScopeRecord.resolved_category !==
      clientScopeRecord.resolved_category
  ) return null;
  return issuedRecord;
}

export function selectionReadinessScope(
  token: string,
  context: { resolved_category?: string } = {},
): { kind: string; token: string; resolved_category?: string } {
  const resolvedCategory = String(context.resolved_category ?? "").trim()
    .slice(0, 200);
  return {
    kind: SELECTION_READINESS_SCOPE,
    token: String(token ?? "").trim().slice(0, 500),
    ...(resolvedCategory ? { resolved_category: resolvedCategory } : {}),
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

interface ReadinessProfile {
  id: string;
  applies: RegExp;
  required: Array<RegExp | ((evidence: string) => boolean)>;
  /** Requirement answered by the opening chip axis, not by the whole prose. */
  primary_requirement_index: number;
  /** Human-readable counterparts of `required`, in the same order. */
  missing_labels: string[];
  /** Stable identity for exact facts that cannot honestly be represented by chips. */
  freeform_facets?: Record<number, string>;
  /** Prefer an actionable exact measurement before an open-ended purpose. */
  freeform_order?: number[];
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
    /** Do not reissue a type chip when the customer already chose that type. */
    when?: (evidence: string) => boolean;
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
  const breaker = /автомат\p{L}*/iu.test(source);
  const asksGuidance =
    /(?:какой|какая|какое|какие)[^.!?\n]{0,120}(?:нужен|нужна|нужно|нужны|подойдет|подойдут)/iu
      .test(source) ||
    (breaker &&
      /(?:какой|какая|какое|какие)[^.!?\n]{0,120}(?:поставить|ставить|установить|выбрать|посовет\p{L}*|рекоменд\p{L}*)/iu
        .test(source));
  // Keep the existing measured-load rule for other product domains. Breaker
  // guidance also accepts a bare kW/A value, which the calculation router can
  // actually parse, without relaxing readiness for cable or equipment picks.
  const measuredLoad = breaker
    ? /\d+(?:[.,]\d+)?\s*(?:к\s*вт|а)(?=$|[^\p{L}\p{N}])/iu.test(source)
    : /нагрузк\p{L}*[^.!?\n]{0,40}\d+(?:[.,]\d+)?\s*(?:к?вт|а)(?=$|[^\p{L}\p{N}])|\d+(?:[.,]\d+)?\s*(?:к?вт|а)(?=$|[^\p{L}\p{N}])[^.!?\n]{0,40}нагрузк\p{L}*/iu
      .test(source);
  const catalogImperative =
    /(?:^|[^\p{L}])(?:найд\p{L}*|подбер\p{L}*|покаж\p{L}*|предлож\p{L}*|выбер\p{L}*|купи\p{L}*)(?=$|[^\p{L}])/iu
      .test(source);
  return asksGuidance && measuredLoad && !catalogImperative;
}

function hasUndergroundCoreCount(evidence: string): boolean {
  return /(?<!\p{N})[1-9]\d?\s*(?:жил\p{L}*|[xх×*]\s*\d+(?:[.,]\d+)?)/iu
    .test(evidence) ||
    /(?:двух|трех|трёх|четырех|четырёх|пяти)жильн\p{L}*/iu.test(evidence);
}

function hasGroundingDecision(evidence: string): boolean {
  return /(?:с|без|есть|нет)\s+(?:защитн\p{L}*\s+жил\p{L}*|заземл\p{L}*|PE)(?=$|[^\p{L}\p{N}])|(?:PE|PEN)\s+(?:есть|нет|предусмотрен\p{L}*)/iu
    .test(evidence);
}

function hasKgPurpose(evidence: string): boolean {
  // A mounting-mode chip saying "Подвижное подключение" is not the purpose
  // of the cable. Require an actual object/usage after a relation instead.
  const targets = evidence.matchAll(
    /(?:для|к|подключа\p{L}*|пита\p{L}*)\s+(?:подключен\p{L}*\s+)?(\p{L}{3,})/giu,
  );
  return [...targets].some((match) =>
    !/^(?:кабел|кг|замен|подключ|проклад|подвиж|стационар|гибк|использован|чего|какого|этого|него)/iu
      .test(match[1])
  );
}

function hasKgCoreAndSection(evidence: string): boolean {
  return /(?<!\p{N})[1-9]\d?\s*[xх×*]\s*\d+(?:[.,]\d+)?/iu.test(evidence) ||
    (/(?<!\p{N})[1-9]\d?\s*жил\p{L}*/iu.test(evidence) &&
      /\d+(?:[.,]\d+)?\s*мм\s*(?:²|2)(?=$|[^\p{L}\p{N}])/iu.test(evidence));
}

function hasLugConnectionType(evidence: string): boolean {
  return /(?:болт\p{L}*|клемм\p{L}*|отверст\p{L}*|(?<![\p{L}\p{N}])[мm]\s*\d{1,2}(?=$|[^\p{L}\p{N}]))/iu
    .test(evidence);
}

function hasLugConnectionAndSize(evidence: string): boolean {
  if (/(?:в\s+клемм\p{L}*|клеммн\p{L}*\s+соедин\p{L}*)/iu.test(evidence)) {
    return true;
  }
  const mSize = /(?<![\p{L}\p{N}])[мm]\s*\d{1,2}(?=$|[^\p{L}\p{N}])/iu
    .test(evidence);
  const diameter = /(?<![\p{L}\p{N}])\d{1,2}\s*мм(?=$|[^\p{L}\p{N}²])/iu
    .test(evidence);
  return mSize ||
    (diameter && /(?:болт\p{L}*|отверст\p{L}*)/iu.test(evidence));
}

function hasMountingHeight(evidence: string): boolean {
  const labeled = /(?:высот\p{L}*|монтаж\p{L}*\s+на|установ\p{L}*\s+на|креп\p{L}*\s+на)[^,;.!?\n]{0,36}\d+(?:[.,]\d+)?\s*м(?:етр\p{L}*)?(?=$|[^\p{L}\p{N}²])/iu;
  if (labeled.test(evidence)) return true;
  // A standalone answer to the height question is valid; another dimension
  // mentioned in a sentence (such as cable length) is never height evidence.
  return evidence.split("\n").some((line) =>
    /^(?:Уточнение клиента:\s*)?(?:(?:до|выше|более|около|примерно)\s*)?\d+(?:[.,]\d+)?(?:\s*[–-]\s*\d+(?:[.,]\d+)?)?\s*м(?:етр\p{L}*)?\s*$/iu
      .test(line.trim())
  );
}

function hasBulbShapeDecision(evidence: string): boolean {
  if (/(?:груш\p{L}*|свеч\p{L}*|шар\p{L}*|капсул\p{L}*|таблетк\p{L}*|рефлектор\p{L}*|трубк\p{L}*)/iu
    .test(evidence)) return true;
  // The customer may explicitly waive a shape preference. This fills only
  // the optional shape axis; it must not stand in for socket or wattage.
  return /(?:форм\p{L}*(?:\s+колб\p{L}*)?\s+(?:не\s+(?:принципиальн\p{L}*|важн\p{L}*)|люб\p{L}*)|люб\p{L}*\s+форм\p{L}*)(?=$|[^\p{L}])/iu
    .test(evidence);
}

// These are reusable engineering-selection profiles, not catalog aliases or
// product values. A profile only decides whether the request contains enough
// input data to start a safe search; live discovery still owns all filters.
const PROFILES: ReadinessProfile[] = [
  {
    id: "electrical_distribution_plan",
    priority: 20,
    // A request for the quantity/composition of protection devices in a
    // distribution board is a project-sizing task, not a SKU search. Area by
    // itself cannot determine circuit topology, so collect the three inputs
    // that change the answer before any catalogue branch is allowed to run.
    applies:
      /(?:скольк\p{L}*|количеств\p{L}*|состав\p{L}*)[^.!?\n]{0,90}(?:автомат\p{L}*|дифавтомат\p{L}*|узо)[^.!?\n]{0,90}(?:щит\p{L}*|дом\p{L}*)|(?:щит\p{L}*|дом\p{L}*)[^.!?\n]{0,90}(?:скольк\p{L}*|количеств\p{L}*)[^.!?\n]{0,90}(?:автомат\p{L}*|дифавтомат\p{L}*|узо)/iu,
    required: [
      /(?:однофаз\p{L}*|трехфаз\p{L}*|трёхфаз\p{L}*|[13]\s*фаз\p{L}*|\b(?:220|230|380|400)\s*в(?=$|[^\p{L}\p{N}]))/iu,
      /\d+(?:[.,]\d+)?\s*к?вт(?=$|[^\p{L}\p{N}])/iu,
      /(?:плит\p{L}*|бойлер\p{L}*|котел\p{L}*|котёл\p{L}*|тепл\p{L}*\s+пол\p{L}*|тёпл\p{L}*\s+пол\p{L}*|кондиционер\p{L}*|насос\p{L}*|саун\p{L}*|электромобил\p{L}*)/iu,
    ],
    primary_requirement_index: 0,
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
    applies: /кабел\p{L}*[^.!?\n]{0,50}(?:для\s+)?насос\p{L}*/iu,
    required: [
      /\d+(?:[.,]\d+)?\s*(?:к?вт|а)(?=$|[^\p{L}\p{N}])/iu,
      /\d+(?:[.,]\d+)?\s*м(?:етр\p{L}*)?(?=$|[^\p{L}\p{N}²])|\d+(?:[.,]\d+)?\s*[–-]\s*\d+(?:[.,]\d+)?\s*м(?=$|[^\p{L}\p{N}²])/iu,
      /(?:однофаз\p{L}*|трехфаз\p{L}*|трёхфаз\p{L}*|[13]\s*фаз\p{L}*|\b(?:220|230|380|400)\s*в(?=$|[^\p{L}\p{N}]))/iu,
      /(?:на\s+улиц\p{L}*|в\s+помещен\p{L}*|перенос\p{L}*|стационар\p{L}*|подзем\p{L}*|в\s+(?:труб\p{L}*|земл\p{L}*))/iu,
    ],
    primary_requirement_index: 2,
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
      {
        requirement_index: 3,
        question: "Как будет проложен кабель к насосу?",
        facet_key: "installation_method",
        options: [
          { value: "Стационарно в помещении", label: "В помещении" },
          { value: "Стационарно на улице", label: "На улице" },
          { value: "Переносное подключение", label: "Переносное" },
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
    applies:
      /кабел\p{L}*[^.!?\n]{0,80}(?:земл\p{L}*|подзем\p{L}*)|проклад\p{L}*[^.!?\n]{0,40}земл\p{L}*/iu,
    required: [
      /(?:труб\p{L}*|пнд|брон\p{L}*|(?:непосредственно|прямо)\s+в\s+земл)/iu,
      /\d+(?:[.,]\d+)?\s*(?:к?вт|а)(?=$|[^\p{L}\p{N}])/iu,
      /(?:однофаз\p{L}*|трехфаз\p{L}*|трёхфаз\p{L}*|[13]\s*фаз\p{L}*|\b(?:220|230|380|400)\s*в(?=$|[^\p{L}\p{N}]))/iu,
      hasUndergroundCoreCount,
      hasGroundingDecision,
    ],
    primary_requirement_index: 0,
    missing_labels: [
      "способ прокладки — в трубе/ПНД или прямо в земле",
      "мощность или ток нагрузки",
      "напряжение и число фаз",
      "число жил",
      "наличие защитной жилы/заземления",
    ],
    freeform_facets: { 1: "load_power", 3: "core_count", 4: "grounding_presence" },
    follow_ups: [{
      requirement_index: 2,
      question: "Какое питание у подземной линии?",
      facet_key: "supply_phase",
      options: [
        { value: "220 В, 1 фаза", label: "220 В, 1 фаза" },
        { value: "380 В, 3 фазы", label: "380 В, 3 фазы" },
      ],
    }],
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
    applies: /автомат\p{L}*[^.!?\n]{0,60}(?:для\s+)?двигател\p{L}*/iu,
    required: [
      /\d+(?:[.,]\d+)?\s*(?:к?вт|а)(?=$|[^\p{L}\p{N}])/iu,
      /(?:однофаз\p{L}*|трехфаз\p{L}*|трёхфаз\p{L}*|[13]\s*фаз\p{L}*|\b(?:220|230|380|400)\s*в(?=$|[^\p{L}\p{N}]))/iu,
      /(?:прям\p{L}*\s+пуск|частотник\p{L}*|софтстартер\p{L}*|плавн\p{L}*\s+пуск|(?:характерист\p{L}*|крив\p{L}*)\s*[:–-]?\s*[bcdвсд](?=$|[^\p{L}\p{N}]))/iu,
    ],
    primary_requirement_index: 1,
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
    applies:
      /автомат\p{L}*[^.!?\n]{0,80}(?:квартир\p{L}*|квартир\p{L}*[^.!?\n]{0,80}автомат\p{L}*)/iu,
    required: [
      /(?:[1234]\s*[pрп](?=$|[^\p{L}\p{N}])|(?:одно|двух|трех|трёх|четырех|четырёх)полюс\p{L}*|[1234]\s*полюс\p{L}*|(?:одно|трех|трёх)фаз\p{L}*)/iu,
      /(?:характерист\p{L}*|крив\p{L}*|тип\p{L}*)\s*[:–-]?\s*[bcdвсд](?=$|[^\p{L}\p{N}])|(?<![\p{L}\p{N}])[bcdвсд]\d{1,3}(?=$|[^\p{L}\p{N}])/iu,
    ],
    primary_requirement_index: 0,
    missing_labels: [
      "полюсность или число фаз",
      "характеристику B, C или D",
    ],
    follow_ups: [{
      requirement_index: 1,
      question: "Какая характеристика срабатывания нужна: B, C или D? Если она неизвестна, напишите назначение линии и что указано в проекте.",
      facet_key: "trip_curve",
      options: [
        { value: "Характеристика B", label: "B" },
        { value: "Характеристика C", label: "C" },
        { value: "Характеристика D", label: "D" },
      ],
    }],
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
    applies: /замен\p{L}*[^.!?\n]{0,50}(?:кабел\p{L}*\s+)?кг(?!\p{L})/iu,
    required: [
      hasKgPurpose,
      hasKgCoreAndSection,
      /(?:гибк\p{L}*|стационар\p{L}*|подвиж\p{L}*)/iu,
    ],
    primary_requirement_index: 2,
    missing_labels: [
      "назначение и подключаемое оборудование",
      "сечение и число жил",
      "подвижное или стационарное подключение",
    ],
    freeform_facets: { 0: "usage_purpose", 1: "core_and_section" },
    freeform_order: [1, 0],
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
    applies: /наконечник\p{L}*[^.!?\n]{0,80}кабел\p{L}*/iu,
    required: [
      /(?:мед\p{L}*|алюмин\p{L}*)/iu,
      hasLugConnectionAndSize,
    ],
    primary_requirement_index: 0,
    missing_labels: [
      "материал жилы — медь или алюминий",
      "тип присоединения и, если под болт, точный размер отверстия (например, M8)",
    ],
    freeform_facets: { 1: "hole_size" },
    follow_ups: [{
      requirement_index: 1,
      question: "Как присоединяется наконечник? Для болтового соединения после выбора понадобится точный размер отверстия.",
      facet_key: "connection_type",
      options: [
        { value: "Под болт", label: "Под болт" },
        { value: "В клемму", label: "В клемму" },
      ],
      when: (evidence) => !hasLugConnectionType(evidence),
    }],
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
    applies: /кабел\p{L}*[^.!?\n]{0,80}видеонаблюден\p{L}*/iu,
    required: [
      /(?:цифров\p{L}*|аналог\p{L}*|ip[- ]?камер)/iu,
      /(?:улиц\p{L}*|помещен\p{L}*)/iu,
      /(?:\bpoe\b|отдельн\p{L}*\s+питан\p{L}*|питан\p{L}*\s+(?:отдельн\p{L}*|по\s+кабел\p{L}*))/iu,
      /\d+(?:[.,]\d+)?\s*м(?:етр\p{L}*)?(?=$|[^\p{L}\p{N}²])/iu,
    ],
    primary_requirement_index: 0,
    missing_labels: [
      "тип системы — цифровая/IP или аналоговая",
      "место прокладки — улица или помещение",
      "PoE или отдельное питание",
      "точную длину линии",
    ],
    freeform_facets: { 3: "line_length" },
    follow_ups: [{
      requirement_index: 1,
      question: "Кабель будет проложен на улице или в помещении?",
      facet_key: "installation_location",
      options: [
        { value: "На улице", label: "На улице" },
        { value: "В помещении", label: "В помещении" },
      ],
    }, {
      requirement_index: 2,
      question: "Как будет подано питание на камеры?",
      facet_key: "power_mode",
      options: [
        { value: "Питание PoE", label: "PoE" },
        { value: "Отдельное питание", label: "Отдельное питание" },
      ],
    }],
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
    applies:
      /светодиодн\p{L}*\s+ламп\p{L}*[^.!?\n]{0,100}(?:тепл\p{L}*|3000\s*к)|(?:тепл\p{L}*|3000\s*к)[^.!?\n]{0,100}светодиодн\p{L}*\s+ламп\p{L}*/iu,
    required: [
      /(?<![\p{L}\p{N}])(?:e|е|gu|gx|g)\s*\d+(?=$|[^\p{L}\p{N}])/iu,
      hasBulbShapeDecision,
      /\d+(?:[.,]\d+)?\s*(?:вт|w)(?=$|[^\p{L}\p{N}])/iu,
    ],
    primary_requirement_index: 0,
    missing_labels: [
      "тип цоколя",
      "форму колбы",
      "желаемую мощность",
    ],
    follow_ups: [{
      requirement_index: 1,
      question: "Какая форма колбы нужна? Если форма не принципиальна, напишите об этом отдельно.",
      facet_key: "bulb_shape",
      options: [
        { value: "Форма груша", label: "Груша" },
        { value: "Форма свеча", label: "Свеча" },
        { value: "Форма шар", label: "Шар" },
      ],
    }],
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
    applies:
      /прожектор\p{L}*[^.!?\n]{0,80}(?:ули[цч]\p{L}*|наруж\p{L}*)|(?:ули[цч]\p{L}*|наруж\p{L}*)[^.!?\n]{0,80}прожектор\p{L}*/iu,
    required: [
      /\d+(?:[.,]\d+)?\s*(?:м2|м²|кв(?:\.|\s)*м|квадрат\p{L}*)|\d+(?:[.,]\d+)?\s*[xх×*]\s*\d+(?:[.,]\d+)?\s*м(?=$|[^\p{L}\p{N}²])/iu,
      hasMountingHeight,
    ],
    primary_requirement_index: 1,
    missing_labels: [
      "площадь или размеры территории",
      "высоту установки",
    ],
    follow_ups: [{
      requirement_index: 0,
      question: "Какая примерная площадь освещаемой части двора? Можно написать точное значение в м² или выбрать диапазон.",
      facet_key: "illuminated_area",
      options: [
        { value: "До 50 м²", label: "До 50 м²" },
        { value: "50–150 м²", label: "50–150 м²" },
        { value: "Более 150 м²", label: "Более 150 м²" },
      ],
    }],
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
    priority: 10,
    applies:
      /прожектор\p{L}*[^.!?\n]{0,80}парковк\p{L}*|парковк\p{L}*[^.!?\n]{0,80}прожектор\p{L}*/iu,
    required: [
      /\d+(?:[.,]\d+)?\s*(?:м2|м²|кв(?:\.|\s)*м|квадрат\p{L}*)|\d+(?:[.,]\d+)?\s*[xх×*]\s*\d+(?:[.,]\d+)?\s*м(?=$|[^\p{L}\p{N}²])/iu,
      hasMountingHeight,
    ],
    primary_requirement_index: 1,
    missing_labels: [
      "площадь или размеры парковки",
      "высоту установки",
    ],
    follow_ups: [{
      requirement_index: 0,
      question: "Какая примерная площадь освещаемой парковки? Можно написать точное значение в м² или выбрать диапазон.",
      facet_key: "illuminated_area",
      options: [
        { value: "До 100 м²", label: "До 100 м²" },
        { value: "100–500 м²", label: "100–500 м²" },
        { value: "Более 500 м²", label: "Более 500 м²" },
      ],
    }],
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
  // A label in a customer's question is not a supplied value.  In particular,
  // "площадь не знаю, высота 4 м" must not make both geometry axes complete.
  const evidence = `${dialogueEvidence}\n${current}`.replace(
    /(?:площад\p{L}*|размер\p{L}*|высот\p{L}*|мощн\p{L}*|ток\p{L}*|длин\p{L}*|расстоян\p{L}*|напряж\p{L}*|фаз\p{L}*|проклад\p{L}*|жил\p{L}*|заземл\p{L}*|цокол\p{L}*|форм\p{L}*|питан\p{L}*)[^,;.!?\n]{0,30}(?:не\s+знаю|неизвестн\p{L}*|нет\s+данных|не\s+определ\p{L}*)/giu,
    "",
  );
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
    .map((requirement, index) => {
      // Two side lengths are area evidence, never mounting-height evidence.
      const axisEvidence = index === 1 &&
          (profile.id === "outdoor_floodlight" ||
            profile.id === "parking_floodlight")
        ? evidence.replace(
          /\d+(?:[.,]\d+)?\s*[xх×*]\s*\d+(?:[.,]\d+)?\s*м(?=$|[^\p{L}\p{N}²])/giu,
          "",
        )
        : evidence;
      return (typeof requirement === "function"
          ? requirement(axisEvidence)
          : requirement.test(axisEvidence))
        ? -1
        : index;
    })
    .filter((index) => index >= 0);
  if (missing.length === 0) return null;
  // A clarification's control must correspond to a requirement that is STILL
  // missing. Reissuing the opening chips after the customer selected them is
  // both a stale-facet loop and a false signal that their answer was ignored.
  const followUp = profile.follow_ups?.find((candidate) =>
    missing.includes(candidate.requirement_index) &&
    (candidate.when?.(evidence) ?? true) &&
    (options.progressive ||
      !missing.includes(profile.primary_requirement_index))
  );
  const openingStillMissing = missing.includes(
    profile.primary_requirement_index,
  );
  const useOpening = !followUp && openingStillMissing;
  const nextFreeform = !followUp && !useOpening
    ? profile.freeform_order?.find((index) => missing.includes(index)) ??
      missing[0]
    : -1;
  const missingSummary = missing
    .map((index) => profile.missing_labels[index])
    .filter(Boolean)
    .join("; ");
  return {
    profile: profile.id,
    question: followUp
      ? `Осталось уточнить: ${missingSummary}. ${followUp.question}`
      : useOpening
      ? options.progressive
        ? `Осталось уточнить: ${missingSummary}. Уточните ${profile.missing_labels[profile.primary_requirement_index]}. Можно выбрать вариант или написать свой ответ.`
        : profile.question
      : `Осталось уточнить: ${missingSummary}. Укажите ${profile.missing_labels[nextFreeform]} конкретным значением — без этих данных я не буду считать подбор подтверждённым. Можно ответить обычным сообщением.`,
    facet_key: followUp?.facet_key ??
      (useOpening
        ? profile.facet_key
        : profile.freeform_facets?.[nextFreeform] ??
          `selection_requirement_${nextFreeform}`),
    // An arbitrary numeric value or engineering fact must not be fabricated
    // as an exact chip. The terminal free-text slot is explicit and server
    // verified, so a terse customer answer still retains the original task.
    options: followUp?.options ?? (useOpening ? profile.options : []),
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
  options: { newTaskBoundary?: boolean } = {},
): { message: string; scoped: boolean } {
  const current = String(currentMessage ?? "").trim();
  if (options.newTaskBoundary) {
    return { message: current, scoped: false };
  }
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
