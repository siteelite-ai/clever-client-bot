/** Conversation guidance only. No cable specification or installation
 * suitability may be inferred from these facts. */
import { cableRouteLengthObservations } from "./cable-route-length.ts";
type Route = "water" | "dry" | "direct" | "duct";
export type CableConsultationState = {
  route?: Route;
  lengthM?: number;
  loadA?: number;
};
type Profile = "pump_cable" | "underground_cable";
type Stage = "route" | "length" | "load" | "handoff";
const CURRENT =
  /(?<![\p{L}\p{N}.,+−–—-])([+−-]?\d{1,4}(?:[.,]\d{1,2})?)\s*(?:а|ампер(?:а|ов)?)(?![\p{L}\p{N}])/giu;
const AMBIGUOUS =
  /(?<!\p{L})(?:или|либо|примерно|около|порядка|наверно\p{L}*|кажется|возможно|может\s+быть|если|не\s+уверен\p{L}*)(?!\p{L})|\d\s*[-–—]\s*\d|(?:[<>≈]|(?<!\p{L})до\s+)\s*\d/iu;
const MISSING_SPECIFICATION =
  /не\s+знаю|неизвестн\p{L}*|нет\s+(?:маркировк\p{L}*|проект\p{L}*|паспорт\p{L}*)|нужна\s+помощь/iu;
const SEPARATE_SELECTION =
  /^\s*(?:новая\s+тема|новый\s+вопрос|(?:(?:найд|подбер|подоб|покаж|предлож|посовет|нуж|хоч)\p{L}*\s+)?(?:розетк|удлинител|ламп|светильник|прожектор|автомат|стабилизатор|труб|муфт|наконечник)\p{L}*|(?:найд|подбер|подоб|покаж|предлож|посовет)\p{L}*\s+[^,.]*\b\d+\s*[xх×*])/iu;

function routeIn(profile: Profile, text: string): Route[] {
  // Remove a negated phrase before testing the positive alternative. A bare
  // «в земле» does not establish whether there is a conduit.
  const routeText = text.replace(
    /(?:не|без)\s+(?:в\s+)?(?:труб\p{L}*|пнд|вод\p{L}*|грунт\p{L}*|земл\p{L}*)/giu,
    "",
  );
  if (profile === "pump_cable") {
    const dry =
      /(?:не\s+(?:будет\s+)?в\s+воде|без\s+погружения|кабел\p{L}*\s+(?:не\s+погружа\p{L}*|сухой)|(?:вся\s+трасса|весь\s+кабель)\s+(?:по\s+сух\p{L}*|сух\p{L}*)|по\s+сух\p{L}*\s+части|^сух\p{L}*(?:\s+участок)?[.!]?\s*$)/iu
        .test(text);
    const water = /(?:в\s+воде|под\s+водой|в\s+воду|будет\s+погружен\p{L}*)/iu
      .test(
        routeText.replace(/не\s+(?:будет\s+)?в\s+воде/giu, ""),
      );
    return [
      ...(water ? ["water" as const] : []),
      ...(dry ? ["dry" as const] : []),
    ];
  }
  const direct =
    /(?:прямо|напрямую|непосредственно)\s+в\s+(?:грунт\p{L}*|земл\p{L}*)|(?:в\s+(?:грунт\p{L}*|земл\p{L}*)[^,.!?;]{0,18})?без\s+(?:защитной\s+)?труб\p{L}*/iu
      .test(
        text.replace(
          /не\s+(?:прямо|напрямую|непосредственно)\s+в\s+(?:грунт\p{L}*|земл\p{L}*)/giu,
          "",
        ),
      );
  const duct =
    /(?:в\s+(?:защитной\s+)?труб\p{L}*|в\s+(?:гофр\p{L}*|канал\p{L}*)|в\s+пнд|^пнд[.!]?\s*$)/iu
      .test(routeText);
  return [
    ...(direct ? ["direct" as const] : []),
    ...(duct ? ["duct" as const] : []),
  ];
}

function independentClauses(text: string): string[] {
  return text.split(/(?:\.(?!\d)|(?<!\d)\.|[;!\n]+)/u).flatMap((sentence) => {
    const groups: string[] = [];
    for (const raw of sentence.split(/(?:,(?!\d)|(?<!\d),)/u)) {
      const clause = raw.trim();
      if (!clause) continue;
      const previous = groups.at(-1);
      // A comma before «или» does not turn the first alternative into a fact.
      const dependent = /^(?:или|либо|а\s+может)(?!\p{L})/iu.test(clause) ||
        /^(?:кажется|наверно\p{L}*|возможно|не\s+уверен\p{L}*)$/iu.test(
          clause,
        ) ||
        (previous !== undefined && /^если(?!\p{L})/iu.test(previous) &&
          !previous.includes(","));
      if (previous && dependent) groups[groups.length - 1] += `, ${clause}`;
      else groups.push(clause);
    }
    return groups;
  });
}

function facts(
  profile: Profile,
  text: string,
  answeringLoad = false,
): {
  confirmed: CableConsultationState;
  uncertain: Set<keyof CableConsultationState>;
} {
  // Statements after a question are usable, but a candidate phrased as a
  // question («а если в трубе?») is not a declared change of route.
  text = text.replace(/[^.;!?\n]*[?？]/gu, "");
  const clean = text.replace(
    /(?<!\p{L})не\s+\d+(?:[.,]\d+)?\s*(?:м|а|метр\p{L}*|ампер\p{L}*)(?![\p{L}\p{N}²])/giu,
    "",
  );
  const loadContext =
    /шильдик|номинальн\p{L}*|расч[её]тн\p{L}*|рабоч\p{L}*\s+ток|(?<!\p{L})ток\s*[:—–-]?\s*\d/iu;
  const excludedCurrent =
    /автомат|предохранител|пусков\p{L}*\s+ток|при\s+пуске/iu;
  const uncertain = new Set<keyof CableConsultationState>();
  const routes = new Set<Route>(),
    lengths = new Set<number>(),
    loads = new Set<number>();
  for (const clause of independentClauses(clean)) {
    const ambiguous = AMBIGUOUS.test(clause);
    for (const route of routeIn(profile, clause)) {
      if (ambiguous) uncertain.add("route");
      else routes.add(route);
    }
    for (const { lower, bounded } of cableRouteLengthObservations(clause)) {
      if (ambiguous || bounded || lower <= 0 || lower >= 1e4) {
        uncertain.add("lengthM");
      } else lengths.add(lower);
    }
    for (const owner of clause.split(/\s+и\s+/u)) {
      if (
        excludedCurrent.test(owner) || !(loadContext.test(owner) ||
          (answeringLoad &&
            /^\s*\d{1,4}(?:[.,]\d{1,2})?\s*(?:а|ампер\p{L}*)\s*$/iu.test(
              owner,
            )))
      ) continue;
      for (const reading of owner.matchAll(CURRENT)) {
        const value = Number(reading[1].replace(",", ".").replace("−", "-"));
        if (ambiguous || value <= 0 || value >= 1e4) uncertain.add("loadA");
        else loads.add(value);
      }
    }
  }
  function one<T>(
    key: keyof CableConsultationState,
    values: Set<T>,
  ): T | undefined {
    if (values.size > 1) uncertain.add(key);
    return !uncertain.has(key) && values.size === 1
      ? [...values][0]
      : undefined;
  }
  const route = one("route", routes);
  const lengthM = one("lengthM", lengths);
  const loadA = one("loadA", loads);
  return {
    confirmed: {
      ...(route ? { route } : {}),
      ...(lengthM ? { lengthM } : {}),
      ...(loadA ? { loadA } : {}),
    },
    uncertain,
  };
}

function asProfile(profile: string): Profile | null {
  return profile === "pump_cable" || profile === "underground_cable"
    ? profile
    : null;
}

export function isCableConsultationReply(
  profile: string,
  message: string,
): boolean {
  const known = asProfile(profile);
  const text = message.trim();
  if (!known || !text || text.length > 350 || SEPARATE_SELECTION.test(text)) {
    return false;
  }
  const observed = facts(known, text, true);
  return MISSING_SPECIFICATION.test(text) ||
    Object.keys(observed.confirmed).length > 0 || observed.uncertain.size > 0 ||
    ((AMBIGUOUS.test(text) || /[?？]\s*$/u.test(text)) &&
      (routeIn(known, text).length > 0 ||
        /(?:труб|грунт|земл|вод|метр|ампер|\d\s*[ма](?!\p{L}))/iu.test(text)));
}

export function cableConsultation(input: {
  profile: string;
  message: string;
  prior?: CableConsultationState;
  continuation: boolean;
}): { state: CableConsultationState; stage: Stage; text: string; specificationUnavailable?: boolean } | null {
  const profile = asProfile(input.profile);
  if (!profile) return null;
  const oldRoute = input.prior?.route;
  const state: CableConsultationState = {
    ...(oldRoute &&
        (profile === "pump_cable" ? ["water", "dry"] : ["direct", "duct"])
          .includes(oldRoute)
      ? { route: oldRoute }
      : {}),
    ...(input.prior?.lengthM && Number.isFinite(input.prior.lengthM) &&
        input.prior.lengthM > 0 && input.prior.lengthM < 1e4
      ? { lengthM: input.prior.lengthM }
      : {}),
    ...(input.prior?.loadA && Number.isFinite(input.prior.loadA) &&
        input.prior.loadA > 0 && input.prior.loadA < 1e4
      ? { loadA: input.prior.loadA }
      : {}),
  };
  const observed = facts(
    profile,
    input.message,
    !!state.route && !!state.lengthM && state.loadA === undefined,
  );
  const explicitUnknown = /не\s+знаю|неизвестн\p{L}*|нет\s+данных/iu;
  for (const clause of input.message.split(/[,;.!?]\s*/u)) {
    if (!explicitUnknown.test(clause)) continue;
    if (/длин\p{L}*|расстоян\p{L}*/iu.test(clause)) delete state.lengthM;
    if (/(?<!\p{L})ток(?!\p{L})/iu.test(clause)) delete state.loadA;
    if (/способ\s+проклад\p{L}*|маршрут\p{L}*|погружен\p{L}*/iu.test(clause)) {
      delete state.route;
    }
  }
  for (const key of observed.uncertain) delete state[key];
  Object.assign(state, observed.confirmed);
  const handoff = (text: string) => ({
    state,
    stage: "handoff" as const,
    text,
  });
  const routeNote: Record<Route, string> = {
    water:
      "Для участка в воде проверяют, допускает ли паспорт конкретного кабеля длительное погружение.",
    dry:
      "Для сухого участка кабель проверяют по условиям трассы и паспорту насоса.",
    direct:
      "Для прямой укладки в грунт нужно явное разрешение в паспорте кабеля.",
    duct:
      "Подземная труба меняет условия прокладки, но сама по себе не подтверждает пригодность кабеля.",
  };
  if (
    input.continuation && MISSING_SPECIFICATION.test(input.message) &&
    !Object.keys(observed.confirmed).length && !observed.uncertain.size
  ) {
    // A missing specification is a terminal assistance choice, not a reason
    // to ask it again or to replace the already confirmed route/measurements.
    const note = state.route ? `${routeNote[state.route]} ` : "";
    return {
      ...handoff(`${note}Без маркировки менеджеру пригодится паспорт оборудования или проект линии. Указанные условия сохранены; марку и сечение наугад не рекомендую.`),
      specificationUnavailable: true,
    };
  }
  if (!state.route) {
    return {
      state,
      stage: "route",
      text: profile === "pump_cable"
        ? "Кабель к насосу будет погружён в воду или весь пройдёт по сухому участку?"
        : "Кабель планируете проложить прямо в грунте или в защитной трубе?",
    };
  }
  const note = routeNote[state.route];
  if (!state.lengthM) {
    return {
      state,
      stage: "length",
      text: `${note} Какова длина линии в метрах?`,
    };
  }
  if (!state.loadA) {
    return {
      state,
      stage: "load",
      text: profile === "pump_cable"
        ? `${note} Какой номинальный ток указан на шильдике насоса (А)?`
        : `${note} Какой расчётный ток линии в амперах указан в проекте?`,
    };
  }
  return handoff(
    profile === "pump_cable"
      ? `${note} Длина и ток уже есть. Для определения марки и сечения нужно сверить питание, условия трассы и требования из паспорта насоса. Менеджеру можно назвать модель насоса.`
      : `${note} Длина и ток уже есть. Для определения марки и сечения электрик сверит напряжение, число жил и защитное заземление по проекту.`,
  );
}
