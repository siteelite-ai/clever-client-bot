import { type Criterion, normalizeKey } from "./criteria-gate.ts";
import type { Facet } from "./discover-category.ts";
import {
  hasExplicitNewTaskPreface,
  stripExplicitNewTaskPreface,
} from "./request-preface.ts";
import type { ProductFull } from "./types.ts";
import type { SelectionReadinessClarification } from "./selection-readiness.ts";
import { selectionReadinessScope } from "./selection-readiness.ts";

// A measured application is not an exact product order. Keep circuit design
// facts separate from catalogue specifications even when both use amperes.
const BREAKER =
  /(?<![\p{L}\p{N}])автомат(?:ическ\p{L}*\s+выключател\p{L}*|ами|ом|ов|ах|ам|а|у|е|ы)?(?![\p{L}\p{N}])/iu;
const LINE_CONTEXT =
  /квартир\p{L}*|проводк\p{L}*|электролин\p{L}*|ввод\p{L}*|лини\p{L}*|нагрузк\p{L}*|электрощит\p{L}*/iu;
const OTHER_TASK =
  /двигател\p{L}*|мотор\p{L}*|насос\p{L}*|узо|дифавтомат\p{L}*|выбива\p{L}*|сработа\p{L}*|(?:^|\s)аналог\p{L}*|замен\p{L}*|(?:сколько|количество)\s+автомат\p{L}*/iu;
const OTHER_PRIMARY_PRODUCT =
  /^(?:(?:како[йея]|хочу|нуж[еаы]\p{L}*|найди\p{L}*|подбери\p{L}*|покажи\p{L}*|предложи\p{L}*|мне)\s+)*(?:кабел\p{L}*|провод(?:а|ов|ы)?|удлинител\p{L}*|светильник\p{L}*|прожектор\p{L}*|розетк\p{L}*)(?!\p{L})/iu;
const POWER =
  /(?<![\p{L}\p{N}.,+−-])(\d{1,6}(?:[.,]\d{1,3})?)\s*(к?\s*вт)(?![\p{L}\p{N}])/giu;
const LOAD_CURRENT =
  /(?:ток\s+нагрузки|расч[её]тный\s+ток)\s*[:=]?\s*(\d{1,4}(?:[.,]\d{1,2})?)\s*[аa](?![\p{L}\p{N}])/giu;
const PREFIX = "Автомат для защиты линии · circuit-v1:";
const FACETS = [
  "circuit_load",
  "circuit_supply",
  "circuit_line",
  "circuit_project",
] as const;
type CircuitFacet = typeof FACETS[number];
type Line = "main" | "branch";
type Curve = "B" | "C" | "D";

type Circuit = {
  watts?: number;
  loadA?: number;
  phase?: 1 | 3;
  volts?: number;
  line?: Line;
  material?: "copper" | "aluminum";
  section?: number;
  installation?: "open" | "concealed" | "conduit";
  project?: true;
  ratedA?: number;
  poles?: number;
  curve?: Curve;
  minKa?: number;
};

export type CircuitProtectionDecision =
  | { status: "ask"; clarification: SelectionReadinessClarification }
  | { status: "stop"; reason: "unknown" | "inconsistent"; text: string }
  | { status: "ready"; criteria: Criterion[] };

const STOP =
  "Без подтверждённых параметров линии и защиты я не буду рекомендовать номинал или показывать автомат как подходящий. Попросите электрика проверить линию и указать параметры автомата; по ним я смогу подобрать товары.";
const PROJECT =
  /(?:по\s+проекту|в\s+проекте|электрик\s+(?:подтвердил\p{L}*|назначил\p{L}*|указал\p{L}*))/iu;
const UNKNOWN =
  /^(?:я\s+)?(?:не\s+знаю(?:\s+(?:марку|напряжение|сечение|параметры(?:\s+автомата)?))?|неизвестно|нет\s+(?:данных|проекта)|проект(?:а)?\s+нет|не\s+могу\s+уточнить)[.!?\s]*$/iu;
const FRESH_REQUEST =
  /^\s*(?:найди\p{L}*|подбери\p{L}*|покажи\p{L}*|предложи\p{L}*|купить|нуж[еаы]\p{L}*|како[йея]|хочу)\s+(?!по\s+проекту)/iu;

function singleNumber(
  text: string,
  pattern: RegExp,
  scale = (_: RegExpMatchArray) => 1,
): number | undefined {
  const numbers = [
    ...new Set([...text.matchAll(pattern)]
      .map((m) => Number(m[1].replace(",", ".")) * scale(m))),
  ];
  const [n] = numbers;
  return numbers.length === 1 && Number.isFinite(n) && n > 0 ? n : undefined;
}

function choose<T>(
  text: string,
  options: ReadonlyArray<readonly [RegExp, T]>,
): T | undefined {
  const matches = options.filter(([pattern]) => pattern.test(text));
  return matches.length === 1 ? matches[0][1] : undefined;
}

function readFacts(
  raw: string,
  facet: CircuitFacet | null,
  establishedProject = false,
): Circuit {
  const text = raw.replace(/^(?:уточнение клиента:\s*)/iu, "")
    .replace(/(?<!\p{L})не\s+[^,;.!?]{1,60},\s*а\s+/giu, "")
    .replace(
      /(?<!\p{L})не\s+(?:менее|ниже)\s+(?=\d+(?:[.,]\d+)?\s*[кk]\s*[аa](?!\p{L}))/giu,
      "от ",
    );
  // Do not promote alternatives, ranges or negative examples to exact facts.
  if (
    /\d\s*[/±–—-]\s*\d|(?<!\p{L})(?:либо|или|возможно|наверное|не|без|неизвест\p{L}*)(?!\p{L})/iu
      .test(text)
  ) {
    return {};
  }
  const supplyPart = text.split(PROJECT)[0];
  const phase = choose<1 | 3>(supplyPart, [
    [
      /(?<![\p{L}\p{N}])(?:(?:1|одна|одной)\s*фаз\p{L}*|однофаз\p{L}*)(?![\p{L}\p{N}])/iu,
      1,
    ],
    [
      /(?<![\p{L}\p{N}])(?:(?:3|три|тр[её]х)\s*фаз\p{L}*|тр[её]хфаз\p{L}*)(?![\p{L}\p{N}])/iu,
      3,
    ],
  ]);
  const volts = singleNumber(
    supplyPart,
    /(?<![\p{L}\p{N}.,+−\/-])(\d{2,3})\s*[вv](?![\p{L}\p{N}])/giu,
  );
  const line = choose<Line>(text, [
    [
      /(?<![\p{L}\p{N}])ввод(?:ной|ный)?(?:\s+квартиры|\s+дома|(?=\s*[,.;!?]|$))|(?:защит\p{L}*|на)\s+ввод[а-яё]*/iu,
      "main",
    ],
    [
      /(?<![\p{L}\p{N}])(?:отдельн\p{L}*|группов\p{L}*)\s+лини\p{L}*/iu,
      "branch",
    ],
  ]);
  const material = choose<NonNullable<Circuit["material"]>>(text, [
    [/(?<![\p{L}\p{N}])(?:медь|медн\p{L}*)(?!\p{L})/iu, "copper"],
    [/(?<![\p{L}\p{N}])алюмини\p{L}*/iu, "aluminum"],
  ]);
  const section = singleNumber(
    text,
    /(?<![\p{L}\p{N}.,+−\/-])(\d{1,3}(?:[.,]\d{1,2})?)\s*мм\s*[²2](?![\p{L}\p{N}])/giu,
  );
  const installation = choose<NonNullable<Circuit["installation"]>>(text, [
    [/(?<!\p{L})(?:открыто|открытая прокладка)(?!\p{L})/iu, "open"],
    [
      /(?<!\p{L})(?:скрыто|скрытая прокладка|в стене|под штукатуркой)(?!\p{L})/iu,
      "concealed",
    ],
    [/(?<!\p{L})(?:в гофре|в трубе|в кабель-канале)(?!\p{L})/iu, "conduit"],
  ]);
  const watts = singleNumber(
    text,
    POWER,
    (m) => m[2].toLowerCase().startsWith("к") ? 1000 : 1,
  );
  const loadA = singleNumber(text, LOAD_CURRENT);
  const facts: Circuit = {
    ...(watts ? { watts } : {}),
    ...(loadA ? { loadA } : {}),
    ...(phase ? { phase } : {}),
    ...(volts &&
        (facet === "circuit_supply" || phase ||
          /питан\p{L}*|напряж\p{L}*|ввод\p{L}*/iu.test(supplyPart))
      ? { volts }
      : {}),
    ...(line ? { line } : {}),
    ...(material ? { material } : {}),
    ...(section ? { section } : {}),
    ...(installation ? { installation } : {}),
  };
  // Only the project/qualified installation specification owns the breaker
  // rating. A load current, the old breaker or a chip never becomes a rating.
  const projectAnchor = text.search(PROJECT);
  if (
    projectAnchor < 0 && !(establishedProject && facet === "circuit_project")
  ) return facts;
  const spec = projectAnchor >= 0
    ? text.slice(projectAnchor).replace(PROJECT, "").trim()
    : text;
  if (/(?:старый|прежний|сейчас стоит|вместо|не\s+нуж\p{L}*)/iu.test(spec)) {
    return facts;
  }
  const compact = [
    ...spec.matchAll(
      /(?<![\p{L}\p{N}])([BCDВСД])\s*(\d{1,3})(?![\p{L}\p{N}]|[.,]\d)/giu,
    ),
  ];
  const ratedA = singleNumber(
    spec,
    /(?:номинал(?:ьный\s+ток)?\s*[:=]?\s*|(?:^|[,;]\s*)\s*[:=]?\s*)(\d{1,3})\s*[аa](?![\p{L}\p{N}])/giu,
  );
  const poles = singleNumber(
    spec,
    /(?<![\p{L}\p{N}.,+−\/-])([1-4])\s*(?:[pрп]|полюс\p{L}*)(?![\p{L}\p{N}])/giu,
  );
  const minKa =
    /(?<!\p{L})(?:до|максимум)\s+\d+(?:[.,]\d+)?\s*[кk]\s*[аa](?!\p{L})/iu.test(
        spec,
      )
      ? undefined
      : singleNumber(
        spec,
        /(?<![\p{L}\p{N}.,+−\/-])(\d{1,2}(?:[.,]\d{1,2})?)\s*[кk]\s*[аa](?![\p{L}\p{N}])/giu,
      );
  const letter = spec.match(
    /(?:характеристик[аиу](?:\s+(?:срабатывания|расцепления))?|крив[аяую])\s*[:=]?\s*([BCDВСД])(?![\p{L}\p{N}])/iu,
  )?.[1];
  const curve = (value: string): Curve =>
    value.toUpperCase().replace("В", "B").replace("С", "C").replace(
      "Д",
      "D",
    ) as Curve;
  const compactA = compact.length === 1 ? Number(compact[0][2]) : undefined;
  const compactCurve = compact.length === 1 ? curve(compact[0][1]) : undefined;
  const labelCurve = letter ? curve(letter) : undefined;
  if (
    compact.length > 1 || (compactA && ratedA && compactA !== ratedA) ||
    (compactCurve && labelCurve && compactCurve !== labelCurve)
  ) return facts;
  return {
    ...facts,
    project: true,
    ...((ratedA ?? compactA) ? { ratedA: ratedA ?? compactA } : {}),
    ...(poles ? { poles } : {}),
    ...((labelCurve ?? compactCurve)
      ? { curve: labelCurve ?? compactCurve }
      : {}),
    ...(minKa ? { minKa } : {}),
  };
}

export function isCircuitProtectionSlot(
  slot: Record<string, unknown> | null,
): boolean {
  const scope = slot?.scope as
    | { kind?: unknown; token?: unknown }
    | null
    | undefined;
  return !!slot && FACETS.includes(slot.facet_key as CircuitFacet) &&
    scope?.kind === "selection_readiness" && typeof scope.token === "string" &&
    scope.token.startsWith(PREFIX);
}

// Call only after the ordinary latest-completed-server-slot verification.
// The compact token preserves typed facts, without carrying browser history,
// model prose, arbitrary traits or a growing concatenation of user messages.
function readSlot(slot: Record<string, unknown> | null): Circuit | null {
  if (!isCircuitProtectionSlot(slot)) return null;
  try {
    const token = (slot!.scope as { token: string }).token;
    const state = JSON.parse(token.slice(PREFIX.length)) as Circuit;
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

export function isCircuitProtectionReply(
  message: string,
  verifiedSlot: Record<string, unknown> | null,
): boolean {
  const raw = message.trim();
  if (
    !isCircuitProtectionSlot(verifiedSlot) || !raw || raw.length > 500 ||
    FRESH_REQUEST.test(raw) || hasExplicitNewTaskPreface(raw)
  ) return false;
  if (UNKNOWN.test(raw)) return true;
  if (
    OTHER_TASK.test(raw) || OTHER_PRIMARY_PRODUCT.test(raw) ||
    BREAKER.test(raw) && !PROJECT.test(raw)
  ) {
    return false;
  }
  return Object.keys(
        readFacts(
          raw,
          verifiedSlot!.facet_key as CircuitFacet,
          readSlot(verifiedSlot)?.project,
        ),
      ).length > 0 ||
    /^(?:да(?:лее|вайте)?|не знаю|продолжай|дальше|подбирай)[.!?\s]*$/iu.test(
      raw,
    ) ||
    /\d\s*(?:фаз|мм|к?[ав]|[pр])|характеристик|номинал|проект|электрик|ввод|лини[яию]/iu
      .test(raw);
}

export function resolveCircuitProtection(
  message: string,
  verifiedSlot: Record<string, unknown> | null,
): CircuitProtectionDecision | null {
  const raw = stripExplicitNewTaskPreface(message).trim();
  const continued = isCircuitProtectionReply(message, verifiedSlot);
  const prior = continued ? readSlot(verifiedSlot) : null;
  if (continued && !prior) {
    return { status: "stop", reason: "unknown", text: STOP };
  }
  if (
    !prior &&
    (!BREAKER.test(raw) || !LINE_CONTEXT.test(raw) || OTHER_TASK.test(raw) ||
      OTHER_PRIMARY_PRODUCT.test(raw))
  ) return null;
  if (prior && UNKNOWN.test(raw)) {
    return { status: "stop", reason: "unknown", text: STOP };
  }
  if (
    !prior && !Array.from(raw.matchAll(POWER)).length &&
    !Array.from(raw.matchAll(LOAD_CURRENT)).length
  ) return null;
  const facet = prior ? verifiedSlot!.facet_key as CircuitFacet : null;
  let facts = readFacts(raw, facet, prior?.project);
  const changedLine = prior &&
    ([
      "line",
      "phase",
      "volts",
      "material",
      "section",
      "installation",
      "watts",
      "loadA",
    ] as const).some((key) =>
      prior[key] !== undefined && facts[key] !== undefined &&
      facts[key] !== prior[key]
    );
  const base = { ...prior };
  if (changedLine) {
    delete base.project;
    delete base.ratedA;
    delete base.poles;
    delete base.curve;
    delete base.minKa;
    if (facts.phase && facts.phase !== prior.phase && !facts.volts) {
      delete base.volts;
    }
    if (!PROJECT.test(raw)) facts = readFacts(raw, facet);
  }
  const state: Circuit = { ...base, ...facts };
  const scope = selectionReadinessScope(PREFIX + JSON.stringify(state));
  const ask = (
    facet: CircuitFacet,
    question: string,
    values: string[] = [],
  ): CircuitProtectionDecision => ({
    status: "ask",
    clarification: {
      profile: "circuit_protection",
      question,
      facet_key: facet,
      options: values.map((value) => ({ value, label: value })),
      scope,
    },
  });
  if (!state.watts && !state.loadA) {
    return ask(
      "circuit_load",
      "Уточните одним значением мощность нагрузки (Вт или кВт) либо укажите «ток нагрузки» и значение в амперах.",
    );
  }
  if (!state.phase || !state.volts) {
    return ask(
      "circuit_supply",
      !state.phase && !state.volts
        ? "Чтобы подобрать автомат, уточните питание линии: сколько фаз и какое напряжение? Можно выбрать вариант или написать свои данные."
        : !state.phase
        ? "Напряжение учтено. Сколько фаз у линии?"
        : "Число фаз учтено. Какое напряжение у линии?",
      !state.phase && !state.volts
        ? ["220 В, 1 фаза", "230 В, 1 фаза", "380 В, 3 фазы", "400 В, 3 фазы"]
        : [],
    );
  }
  if (!state.line) {
    return ask(
      "circuit_line",
      "Это ввод квартиры/дома или отдельная линия? Если спецификации нет, укажите также материал и сечение жил и способ прокладки кабеля.",
      ["Ввод квартиры", "Отдельная линия"],
    );
  }
  const missing = [
    !state.ratedA ? "номинал" : "",
    !state.curve ? "характеристику срабатывания" : "",
    !state.poles ? "число полюсов" : "",
    !state.minKa ? "минимальную отключающую способность в кА" : "",
  ].filter(Boolean);
  if (!state.project || missing.length > 0) {
    const cableKnown =
      !!(state.material && state.section && state.installation);
    return ask(
      "circuit_project",
      (cableKnown ? "Данные о кабеле и прокладке сохранены. " : "") +
        "Чтобы искать модели, укажите " + missing.join(", ") +
        " по проекту или подтверждению электрика. Если этих данных нет, напишите «не знаю»: по одной мощности безопасный номинал не определяю.",
    );
  }
  // A physical lower bound is only a conflict check, never a recommendation
  // or a substitute for designer-confirmed sizing, topology and short circuit.
  const lowerBound = Math.max(
    state.loadA ?? 0,
    (state.watts ?? 0) /
      (state.volts * (state.phase === 3 ? Math.sqrt(3) : 1)),
  );
  if (
    state.ratedA! < lowerBound || (state.phase === 3 && state.poles! < 3) ||
    (state.phase === 1 && state.poles! > 2)
  ) {
    return {
      status: "stop",
      reason: "inconsistent",
      text:
        "Параметры защиты противоречат указанной нагрузке или числу фаз. Проверьте данные по проекту с электриком. Неподтверждённые товары не показываю.",
    };
  }
  return {
    status: "ready",
    criteria: [
      { key: "Номинальный ток", op: "eq", value: state.ratedA!, unit: "А" },
      { key: "Количество полюсов", op: "eq", value: state.poles! },
      { key: "Характеристика срабатывания", op: "eq", value: state.curve! },
      {
        key: "Номинальная откл способность",
        op: "min",
        value: state.minKa!,
        unit: "кА",
      },
      {
        key: "Номинальное рабочее напряжение",
        op: "eq",
        value: state.volts,
        unit: "В",
      },
    ].map((
      criterion,
    ): Criterion => ({
      ...criterion,
      level: "A",
      evidence: "user_explicit",
    } as Criterion)),
  };
}

export const CIRCUIT_BREAKER_CATEGORY = "Автоматические выключатели";

const AXES: ReadonlyArray<readonly [string, RegExp, RegExp]> = [
  [
    "Номинальный ток",
    /^номинальн\p{L}*\s+ток(?:\s*[аa])?$/iu,
    /^([0-9]+(?:[.,][0-9]+)?)\s*[аa]?$/iu,
  ],
  [
    "Количество полюсов",
    /^(?:количество|число)\s+полюсов$/iu,
    /^([1-4])\s*(?:[pрп]|полюс\p{L}*)?$/iu,
  ],
  [
    "Характеристика срабатывания",
    /^характеристик\p{L}*\s+(?:срабатывания|расцепления)$/iu,
    /^([BCDВСД])$/iu,
  ],
  [
    "Номинальная откл способность",
    /^(?:номинальн\p{L}*\s+)?откл(?:ючающая)?\s+способность(?:\s*[кk][аa])?$/iu,
    /^([0-9]+(?:[.,][0-9]+)?)\s*(?:[кk]\s*[аa])?$/iu,
  ],
  [
    "Номинальное рабочее напряжение",
    /^(?:номинальн\p{L}*\s+)?(?:рабочее\s+)?напряжение(?:\s*[вv])?$/iu,
    /^([0-9]+)\s*[вv]?$/iu,
  ],
];

function proves(criterion: Criterion, value: string): boolean {
  const expression = AXES.find(([key]) => key === criterion.key)?.[2];
  const scalar = expression?.exec(value.trim())?.[1];
  if (!scalar) return false;
  if (typeof criterion.value === "number") {
    const number = Number(scalar.replace(",", "."));
    return criterion.op === "min"
      ? number >= criterion.value
      : number === criterion.value;
  }
  return scalar.toUpperCase().replace("В", "B").replace("С", "C").replace(
    "Д",
    "D",
  ) === criterion.value;
}

export function circuitCatalogFilters(
  criteria: Criterion[],
  facets: Facet[],
): Record<string, string[]> | null {
  const options: Record<string, string[]> = Object.create(null);
  for (const criterion of criteria) {
    const axis = AXES.find(([key]) => key === criterion.key);
    if (!axis) return null;
    const matches = facets.filter(({ caption, key }) =>
      axis[1].test(normalizeKey(caption)) || axis[1].test(normalizeKey(key))
    );
    if (matches.length !== 1 || Object.hasOwn(options, matches[0].key)) {
      return null;
    }
    const values = matches[0].values.map(({ value }) => String(value)).filter((
      value,
    ) => proves(criterion, value));
    if (!values.length) return null;
    options[matches[0].key] = values;
  }
  return Object.keys(options).length === AXES.length ? options : null;
}

export function circuitCardProvesFilters(
  product: ProductFull,
  options: Record<string, string[]>,
): boolean {
  return Object.keys(options).length === AXES.length &&
    normalizeKey(product.leaf_category ?? "") ===
      normalizeKey(CIRCUIT_BREAKER_CATEGORY) &&
    (product.stock === "in_stock" || product.stock === "low") &&
    product.warehouse_evidence === "positive" &&
    Number.isFinite(product.price) && product.price > 0 &&
    Object.entries(options).every(([key, accepted]) => {
      const observed = product.facet_values?.[key];
      return observed?.length === 1 && accepted.includes(observed[0]);
    });
}
