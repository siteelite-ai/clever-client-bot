import {
  hasExplicitNewTaskPreface,
  stripExplicitNewTaskPreface,
} from "./request-preface.ts";
import {
  type SelectionReadinessClarification,
  selectionReadinessScope,
} from "./selection-readiness.ts";

const PREFIX = "stabilizer-load-v1:";
const FACET = "stabilizer_application_load";
const TARGET = /(?<!\p{L})стабилизатор\p{L}*(?!\p{L})/iu;
const LOW_INPUT =
  /просад|пада|проседа|снижа|низк\p{L}*\s+напряж|понижен\p{L}*\s+напряж|входн\p{L}*\s+напряж|на\s+входе/iu;
const SPECIAL =
  /генератор|\bups\b|(?<!\p{L})ибп(?!\p{L})|газов\p{L}*\s+кот|медицинск\p{L}*\s+оборудован|замен\p{L}*|аналоги|на\s+складе|подключить\s+к\s+щит|не\s+дороже|доставк|цен[ауе]|бюджет|\d\s*(?:₸|тенге)/iu;
const FRESH =
  /^\s*(?:найд\p{L}*|подбер\p{L}*|покаж\p{L}*|предлож\p{L}*|нуж\p{L}*|хочу|како[йея])\s+/iu;
const OTHER_PRODUCT =
  /^\s*(?:кабел\p{L}*|ламп\p{L}*|розетк\p{L}*|автомат\p{L}*|удлинител\p{L}*)(?!\p{L})/iu;
const UNCERTAIN =
  /(?<!\p{L})(?:или|либо|наверное|кажется|примерно|не\s+уверен\p{L}*)(?!\p{L})|\d\s*[–—\/-]\s*\d|(?<!\p{L})не\s+(?=\d|одна\s+фаза|три\s+фазы|однофаз|тр[её]хфаз)/iu;
const EXPLICIT_PRODUCT_FILTER =
  /настенн|напольн|инвертор|релейн|электронн|дали\s+артикул|марка\s|бренд\s|ресанта|широк\p{L}*\s+диапазон|в\s+наличии|в\s+городе|(?:стабилизатор\p{L}*\s+(?:на\s+)?\d+\s*к?\s*в[ат])/iu;
const UNKNOWN =
  /^(?:я\s+)?(?:не\s+знаю|неизвестно|нет\s+данных|не\s+могу\s+уточнить)(?:\s+(?:мощность|нагрузку|фазность|пусковую мощность|пусковой ток))?[.!?\s]*$/iu;
const PENDING_FACTS =
  /нагруз|к?\s*в[тaа]|фаз|пуск|резистив|двигател|компрессор|нагревател|свароч|\d\s*(?:в|вольт)(?!\p{L})/iu;
const INPUT =
  /(?<![\p{L}\p{N}.,+−-])(\d{2,3})\s*(?:в|вольт(?:а|ов)?)(?![\p{L}\p{N}])/giu;
const POWER =
  /(?<![\p{L}\p{N}.,+−-])(\d{1,6}(?:[.,]\d{1,3})?)\s*(к\s*)?(ва|вт)(?![\p{L}\p{N}])/giu;
type LoadKind = "steady" | "resistive" | "motor";
type State = {
  inputV?: number;
  phases?: 1 | 3;
  loadVa?: number;
  loadWatts?: number;
  kind?: LoadKind;
  peakVa?: number;
};

export type StabilizerApplication = {
  inputV: number;
  phases: 1 | 3;
  loadVa: number;
  peakVa: number;
  kind: LoadKind;
};

type Decision =
  | { status: "ask"; clarification: SelectionReadinessClarification }
  | {
    status: "stop";
    reason: "unknown" | "unsupported_load" | "three_phase";
    text: string;
  }
  | { status: "ready"; application: StabilizerApplication };

function scopedState(slot: Record<string, unknown> | null): State | null {
  const scope = slot?.scope as { kind?: unknown; token?: unknown } | undefined;
  if (
    slot?.facet_key !== FACET || scope?.kind !== "selection_readiness" ||
    typeof scope.token !== "string" || !scope.token.startsWith(PREFIX)
  ) return null;
  try {
    const state: unknown = JSON.parse(scope.token.slice(PREFIX.length));
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      return null;
    }
    const s = state as State;
    const within = (v: number | undefined, min: number, max: number) =>
      v === undefined ||
      (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max);
    return within(s.inputV, 60, 210) && within(s.loadVa, 1, 1e7) &&
        within(s.loadWatts, 1, 1e7) && within(s.peakVa, 1, 1e7) &&
        (s.phases === undefined || s.phases === 1 || s.phases === 3) &&
        (s.kind === undefined ||
          ["steady", "resistive", "motor"].includes(s.kind))
      ? s
      : null;
  } catch {
    return null;
  }
}

export function isReservedStabilizerApplicationSlot(
  slot: Record<string, unknown>,
): boolean {
  const scope = slot.scope as { token?: unknown } | undefined;
  return slot.facet_key === FACET ||
    (typeof scope?.token === "string" && scope.token.startsWith(PREFIX));
}

/** This recognizes only continuation wording. The caller still must verify
 * the actual issued slot against the latest completed server log. */
export function isStabilizerApplicationReply(
  message: string,
  slot: Record<string, unknown> | null,
): boolean {
  const raw = message.trim();
  return !!scopedState(slot) && !hasExplicitNewTaskPreface(raw) &&
    raw.length <= 500 &&
    !OTHER_PRODUCT.test(raw) && !SPECIAL.test(raw) &&
    (UNKNOWN.test(raw) || PENDING_FACTS.test(raw) && !FRESH.test(raw));
}

function one(values: number[]): number | undefined {
  const unique = new Set(values);
  return unique.size === 1 ? values[0] : undefined;
}

function inputAtLowPoint(raw: string, allowBare: boolean): number | undefined {
  if (!allowBare && !LOW_INPUT.test(raw)) return undefined;
  // «Падает с 220 до 170 В» / «измерили: минимум 170 В» are grounded points.
  const text = raw.match(
    /(?:до|минимум|не\s+ниже)\s+(\d{2,3}\s*(?:в|вольт\p{L}*))(?!\p{L})/iu,
  )?.[1] ?? raw;
  const value = one([...text.matchAll(INPUT)].map((match) => Number(match[1])));
  return value !== undefined && value >= 60 && value <= 210 ? value : undefined;
}

function parse(raw: string, prior: State | null): State | null {
  const onePhase = /(?<![\p{L}\p{N}])(?:(?:1|одна)\s*фаз\p{L}*|однофаз\p{L}*)/iu
    .test(raw);
  const threePhase =
    /(?<![\p{L}\p{N}])(?:(?:3|три)\s*фаз\p{L}*|тр[её]хфаз\p{L}*)/iu.test(raw);
  if (onePhase && threePhase) return null;
  const phase = onePhase === threePhase ? undefined : onePhase ? 1 : 3;
  const facts: State = { ...(phase ? { phases: phase } : {}) };
  const input = inputAtLowPoint(raw, !!prior && prior.inputV === undefined);
  if (input) facts.inputV = input;

  // Demand explicit load context on the first turn: <найди стабилизатор
  // на 5 кВт> is a requested nameplate, not measured customer load.
  if (
    !prior &&
    !/нагруз\p{L}*|потребля\p{L}*|потреблен\p{L}*|пиков\p{L}*|пусков\p{L}*/iu
      .test(raw)
  ) return facts;
  const watts: number[] = [], va: number[] = [], peaks: number[] = [];
  for (const clause of raw.split(/[,.;\n!?](?!\d)/u)) {
    const peak = /пиков\p{L}*|пусков\p{L}*|при\s+пуске|на\s+старте/iu.test(
      clause,
    );
    for (const match of clause.matchAll(POWER)) {
      const amount = Number(match[1].replace(",", ".")) * (match[2] ? 1000 : 1);
      if (!(amount > 0 && amount <= 1e7)) return null;
      if (match[3].toLocaleLowerCase("ru") === "ва") {
        (peak ? peaks : va).push(amount);
      } else if (!peak) watts.push(amount);
    }
  }
  if ([watts, va, peaks].some((values) => new Set(values).size > 1)) {
    return null;
  }
  facts.loadWatts = one(watts);
  facts.loadVa = one(va);
  facts.peakVa = one(peaks);
  const withoutMotor =
    /без\s+(?:двигател\p{L}*|мотор\p{L}*|насос\p{L}*|компрессор\p{L}*)/iu;
  const typedMotor =
    /(?<!\p{L})(?:двигател|мотор|насос|компрессор|холодильник)\p{L}*/iu.test(
      raw.replace(withoutMotor, ""),
    );
  if (typedMotor) facts.kind = "motor";
  else if (
    /(?:только|чисто)\s+(?:резистивн\p{L}*|омическ\p{L}*)\s+нагруз\p{L}*/iu
      .test(raw)
  ) facts.kind = "resistive";
  else if (
    /без\s+(?:пусков\p{L}*\s+(?:ток\p{L}*|нагруз\p{L}*|скач\p{L}*)|пуск\p{L}*)/iu
      .test(raw) && !typedMotor
  ) facts.kind = "steady";
  return facts;
}

function ask(state: State, question: string): Decision {
  return {
    status: "ask",
    clarification: {
      profile: "stabilizer_application_load",
      facet_key: FACET,
      question,
      options: [],
      scope: selectionReadinessScope(PREFIX + JSON.stringify(state)),
    },
  };
}

export function resolveStabilizerApplication(
  message: string,
  verifiedSlot: Record<string, unknown> | null,
): Decision | null {
  const raw = stripExplicitNewTaskPreface(message).trim();
  const prior = isStabilizerApplicationReply(message, verifiedSlot)
    ? scopedState(verifiedSlot)
    : null;
  if (
    !prior && (!TARGET.test(raw) || !LOW_INPUT.test(raw) || SPECIAL.test(raw) ||
      EXPLICIT_PRODUCT_FILTER.test(raw))
  ) return null;
  if (prior && UNKNOWN.test(raw)) {
    return {
      status: "stop",
      reason: "unknown",
      text:
        "Без параметров нагрузки не смогу подтвердить подходящую модель. Посмотрите мощность на шильдиках или попросите электрика определить суммарную нагрузку и пусковые параметры.",
    };
  }
  if (/свароч\p{L}*/iu.test(raw)) {
    return {
      status: "stop",
      reason: "unsupported_load",
      text:
        "Для сварочного аппарата обычный бытовой стабилизатор не подбираю: нужен паспорт аппарата и отдельное подтверждение допуска производителя стабилизатора.",
    };
  }
  if (UNCERTAIN.test(raw)) {
    return ask(
      prior ?? {},
      "Укажите одно измеренное минимальное напряжение и фактические параметры нагрузки по паспортам. По приблизительным или противоречивым данным не буду рекомендовать модель.",
    );
  }
  const observed = parse(raw, prior);
  if (!observed) {
    return ask(
      prior ?? {},
      "Укажите по одному подтверждённому значению для каждого параметра: число фаз, суммарную и, если есть пуск, пиковую нагрузку.",
    );
  }
  const facts = Object.fromEntries(
    Object.entries(observed).filter(([, value]) => value !== undefined),
  );
  const base = { ...prior };
  const loadChanged =
    (observed.loadVa !== undefined && prior?.loadVa !== undefined &&
      observed.loadVa !== prior.loadVa) ||
    (observed.loadWatts !== undefined && prior?.loadWatts !== undefined &&
      observed.loadWatts !== prior.loadWatts);
  if (loadChanged) {
    if (!observed.loadVa) delete base.loadVa;
    if (!observed.loadWatts) delete base.loadWatts;
  }
  // Resolving an unknown load type is an addition, not a replacement of
  // the separately confirmed running load. A changed running load or
  // changed known type does invalidate the old peak measurement.
  if (
    !observed.peakVa && (loadChanged ||
      prior?.kind && observed.kind && observed.kind !== prior.kind)
  ) delete base.peakVa;
  const state: State = { ...base, ...facts };
  if (!state.inputV) {
    return ask(
      state,
      "Какое минимальное напряжение измерено на входе стабилизатора? Укажите значение в вольтах.",
    );
  }
  if (state.phases === 3) {
    return {
      status: "stop",
      reason: "three_phase",
      text:
        "Для трёхфазного ввода важно знать, где измерена просадка — между фазой и нейтралью или между фазами, — и нагрузку каждой фазы. Однофазные модели для всего трёхфазного ввода не рекомендую. Эти данные лучше сверить с электриком.",
    };
  }
  if (!state.phases || !state.loadVa && !state.loadWatts) {
    return ask(
      state,
      `Минимум ${state.inputV} В учёл. ${
        [
          !state.phases ? "Сеть однофазная или трёхфазная?" : null,
          !state.loadVa && !state.loadWatts
            ? "Какая максимальная суммарная нагрузка (по паспортам, лучше в кВА), и есть ли насосы, холодильники или другие двигатели?"
            : null,
        ].filter(Boolean).join(" ")
      }`,
    );
  }
  if (!state.kind) {
    return ask(
      state,
      "Есть ли в этой нагрузке двигатели или другие приборы с пусковым скачком? Если нагрузка только резистивная или пусковых токов нет, так и напишите.",
    );
  }
  const loadVa = state.loadVa ??
    (state.kind === "resistive" ? state.loadWatts : undefined);
  if (!loadVa || (state.loadWatts ?? 0) > loadVa) {
    return ask(
      state,
      "Укажите полную суммарную мощность нагрузки в ВА или кВА по паспортам. Для этой нагрузки нельзя считать, что ватты равны вольт-амперам.",
    );
  }
  if (state.kind === "motor" && (!state.peakVa || state.peakVa < loadVa)) {
    return ask(
      state,
      "Укажите полную пиковую нагрузку при пуске в ВА или кВА, включая приборы, которые уже работают. Без неё не буду подбирать модель для двигателей.",
    );
  }
  return {
    status: "ready",
    application: {
      inputV: state.inputV,
      phases: state.phases,
      loadVa,
      peakVa: Math.max(loadVa, state.peakVa ?? loadVa),
      kind: state.kind,
    },
  };
}
