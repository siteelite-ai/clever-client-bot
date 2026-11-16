import { extractBudgetCap } from "./budget-cap.ts";
import { checkCriterion, normalizeKey } from "./criteria-gate.ts";
import {
  hasExplicitNewTaskPreface,
  stripExplicitNewTaskPreface,
} from "./request-preface.ts";
import { isAdditionalProductSelectionFollowup } from "./recent-product-evidence.ts";
import { selectionReadinessScope } from "./selection-readiness.ts";
import { reviewedFixtureApplication } from "./reviewed-fixture-application.ts";
import type { ProductFull } from "./types.ts";

const FACET = "verified_residential_fixture";
const PREFIX = "residential-fixture-v1:";
export const RESIDENTIAL_FIXTURE_CATEGORY = "Светильники";
const head = /(?<!\p{L})светильник\p{L}*(?!\p{L})/iu;
const home =
  /(?<!\p{L})(?:бытов\p{L}*|для\s+(?:дома|квартиры|жил\p{L}*\s+помещен\p{L}*))(?!\p{L})/giu;
const motion =
  /(?<!\p{L})(?:с\s+)?(?:датчик\p{L}*|сенсор\p{L}*)\s+движен\p{L}*(?!\p{L})/giu;
const noUtility =
  /(?<!\p{L})(?:(?:без|не\s+для|не\s+надо|не|исключи\p{L}*)\s+(?:(?:светильник\p{L}*|вариант\p{L}*)\s+)?жкх|жкх\s+не\s+(?:предлагать|нужны?))(?!\p{L})/giu;
const allowUtility =
  /(?<!\p{L})(?:можно|подойдут|разрешаю|допускаю|покажи\p{L}*)\s+(?:(?:и|также|тоже|для|модел\p{L}*|вариант\p{L}*|светильник\p{L}*)\s+){0,4}жкх(?!\p{L})/giu;
const price =
  /(?:(?:с\s+ценой|по\s+цене)\s+)?(?:до|не\s+дороже|не\s+более|в\s+пределах|максимум|макс\.?|бюджет(?:\s+до)?)\s+\d[\d\s]{0,9}\s*(?:тг|тенге|₸|kzt)(?![\p{L}\p{N}])/giu;
const qty =
  /(?:дай(?:те)?|предложи(?:те)?|покажи(?:те)?)?\s*(?:несколько|[2-5])\s+(?:подходящ\p{L}*\s+)?вариант\p{L}*/giu;
const smallWords = new Set(
  "а вот бы мне нам вы нужен нужны нужна нужно ищу хочу подбери подберите предложи предложите покажи покажите найди найдите подойдёт подойдет посоветуй посоветуйте дайте дай какой какие что можете посоветовать пожалуйста можно и тоже ещё еще до по на для с в один вариант да нет такие точные подходящие лучше теперь тогда только светодиодный светодиодные led"
    .split(" "),
);
const ledHead = /(?<!\p{L})(?:светодиодн\p{L}*|led)(?!\p{L})/iu;

const places = {
  living: /жил\p{L}*\s+комнат\p{L}*/iu,
  living_room: /гостин\p{L}*/iu,
  bedroom: /спальн\p{L}*/iu,
  hall: /прихож\p{L}*/iu,
  balcony: /(?:крыт|закрыт)\p{L}*\s+балкон\p{L}*/iu,
  utility: /подсоб\p{L}*\s+помещен\p{L}*|кладов\p{L}*/iu,
  common:
    /подъезд\p{L}*|лестничн\p{L}*\s+(?:клетк|площадк)\p{L}*|входн\p{L}*\s+групп\p{L}*/iu,
} as const;
type Place = keyof typeof places;
const mounts = {
  surface: /накладн\p{L}*/iu,
  recessed: /встраива\p{L}*|встроенн\p{L}*(?=\s+светильник)/iu,
  pendant: /подвесн\p{L}*/iu,
} as const;
type Mount = keyof typeof mounts;
export type ResidentialFixtureSelection = {
  cap: number;
  led: boolean;
  utility: "excluded" | "not_confirmed" | "allowed";
  place?: Place;
  mount?: Mount;
  target: number;
  seen: string[];
};

function remove(text: string, pattern: RegExp): string {
  return text.replace(new RegExp(pattern.source, "giu"), " ");
}

function keyOf<T extends string>(
  input: string,
  map: Readonly<Record<T, RegExp>>,
): T[] {
  return (Object.keys(map) as T[]).filter((key) => map[key].test(input));
}

function parseTerms(
  message: string,
):
  | Omit<ResidentialFixtureSelection, "seen" | "cap"> & { cap: number | null }
  | null {
  const text = message.normalize("NFKC").toLocaleLowerCase("ru");
  if (
    !text || text.length > 420 ||
    /(?<!\p{L})(?:или|либо|вместо|аналог\p{L}*|замен\p{L}*|не\s+нуж\p{L}*)(?!\p{L})/iu
      .test(text)
  ) return null;
  const thesePlaces = keyOf(text, places);
  const theseMounts = keyOf(text, mounts);
  if (thesePlaces.length > 1 || theseMounts.length > 1) return null;
  if ([...text.matchAll(price)].length > 1) return null;
  const exclude = remove(text, noUtility) !== text;
  const allow = remove(text, allowUtility) !== text;
  if (exclude && allow) return null;
  const requested = [...text.matchAll(qty)];
  const target = requested.length
    ? Number(requested[0][0].match(/[2-5]/u)?.[0] ?? 3)
    : 3;
  let rest = text;
  for (
    const pattern of [
      noUtility,
      allowUtility,
      home,
      motion,
      price,
      qty,
      head,
      ledHead,
      ...Object.values(places),
      ...Object.values(mounts),
      /(?:наличи\p{L}*|со\s+встроенным|встроенн\p{L}*\s+(?=$|[,.!?]))/iu,
    ]
  ) {
    rest = remove(rest, pattern);
  }
  if (
    (rest.match(/[\p{L}\p{N}]+/gu) ?? []).some((word) => !smallWords.has(word))
  ) return null;
  return {
    cap: extractBudgetCap(text),
    led: ledHead.test(text),
    utility: exclude ? "excluded" : allow ? "allowed" : "not_confirmed",
    ...(thesePlaces[0] ? { place: thesePlaces[0] } : {}),
    ...(theseMounts[0] ? { mount: theseMounts[0] } : {}),
    target,
  };
}

export function startResidentialFixtureSelection(
  message: string,
): ResidentialFixtureSelection | null {
  const raw = stripExplicitNewTaskPreface(message);
  if (
    !head.test(raw) || remove(raw, home) === raw || remove(raw, motion) === raw
  ) return null;
  const conditions = parseTerms(raw);
  if (!conditions?.cap) return null;
  return { ...conditions, cap: conditions.cap, seen: [] };
}

export function isResidentialFixtureSlot(
  slot: Record<string, unknown>,
): boolean {
  const scope = slot.scope as { token?: unknown } | undefined;
  return slot.facet_key === FACET ||
    (typeof scope?.token === "string" && scope.token.startsWith(PREFIX));
}

export function verifiedResidentialFixtureState(
  slot: Record<string, unknown> | null,
): ResidentialFixtureSelection | null {
  const scope = slot?.scope as { kind?: unknown; token?: unknown } | undefined;
  if (
    slot?.facet_key !== FACET || scope?.kind !== "selection_readiness" ||
    typeof scope.token !== "string" || !scope.token.startsWith(PREFIX)
  ) return null;
  try {
    const state = JSON.parse(
      scope.token.slice(PREFIX.length),
    ) as ResidentialFixtureSelection;
    return state && Number.isSafeInteger(state.cap) && state.cap > 0 &&
        typeof state.led === "boolean" &&
        ["excluded", "not_confirmed", "allowed"].includes(state.utility) &&
        (!state.place || Object.hasOwn(places, state.place)) &&
        (!state.mount || Object.hasOwn(mounts, state.mount)) &&
        Number.isSafeInteger(state.target) && state.target >= 2 &&
        state.target <= 5 &&
        Array.isArray(state.seen) && state.seen.length <= 12 &&
        state.seen.every((id) => /^[a-z0-9_-]{1,24}$/iu.test(id))
      ? state
      : null;
  } catch {
    return null;
  }
}

export function continueResidentialFixtureSelection(
  message: string,
  slot: Record<string, unknown> | null,
): ResidentialFixtureSelection | null {
  if (
    hasExplicitNewTaskPreface(message) ||
    startResidentialFixtureSelection(message)
  ) return null;
  const previous = verifiedResidentialFixtureState(slot);
  if (!previous) return null;
  if (
    isAdditionalProductSelectionFollowup(message) ||
    /^\s*(?:(?:покаж\p{L}*|дай\p{L}*|предлож\p{L}*|давай\p{L}*)\s+)?ещ[её][.!?\s]*$/iu
      .test(message)
  ) return previous;
  const added = parseTerms(message);
  if (
    !added ||
    !(added.place || added.mount || added.cap || added.led ||
      added.utility !== "not_confirmed")
  ) return null;
  return {
    ...previous,
    cap: added.cap ?? previous.cap,
    led: previous.led || added.led,
    utility: added.utility === "not_confirmed"
      ? previous.utility
      : added.utility,
    place: added.place ?? previous.place,
    mount: added.mount ?? previous.mount,
    seen: [],
  };
}

export function encodeResidentialFixtureSlot(
  state: ResidentialFixtureSelection,
  question: string,
) {
  return {
    status: "pending" as const,
    slot_id: crypto.randomUUID(),
    facet_key: FACET,
    question,
    options: [],
    scope: selectionReadinessScope(PREFIX + JSON.stringify(state)),
  };
}

type CatalogProof = {
  source: "catalog_facet" | "product_description" | "manufacturer";
  url?: string;
};

const residential =
  /(?<!\p{L})(?:бытов\p{L}*|жил\p{L}*\s+(?:комнат|помещен)\p{L}*|квартир\p{L}*|domestic|residential)(?!\p{L})/iu;
const utilityLabel = /жкх|светильник\p{L}*\s+(?:подъездн|антивандальн)\p{L}*/iu;
const otherUse =
  /промышленн|производствен|уличн|офисн|для\s+офис|торгов\p{L}*\s+зал/iu;
const disposition =
  /предназнач|применя|подход|рекоменд|использу|для\s+освещен/iu;
const denies =
  /(?:^|[^\p{L}])(?:не\s+(?:предназнач|подход|рекоменд|допуска|применя)\p{L}*|не\s+для|нельзя)/iu;
const vagueVariants =
  /другие\s+модели|отдельные\s+модели|в\s+(?:серии|линейке)\s+есть|в\s+ассортименте\s+есть/iu;

function traitValues(product: ProductFull, key: RegExp): string[] {
  const values: string[] = [];
  for (const trait of product.short_traits ?? []) {
    const i = trait.indexOf(":");
    if (i > 0 && key.test(normalizeKey(trait.slice(0, i)))) {
      values.push(trait.slice(i + 1).trim());
    }
  }
  for (const [name, entries] of Object.entries(product.facet_values ?? {})) {
    if (key.test(normalizeKey(product.facet_captions?.[name] ?? ""))) {
      values.push(...entries);
    }
  }
  return [...new Set(values)];
}

export function proveResidentialFixture(
  product: ProductFull,
  selection: ResidentialFixtureSelection,
  verifiedCategoryTitles?: ReadonlySet<string>,
):
  | {
    ok: true;
    application: CatalogProof;
    sensor: CatalogProof;
    utility: boolean;
  }
  | {
    ok: false;
    reason:
      | "class"
      | "stock"
      | "budget"
      | "mount"
      | "led"
      | "sensor"
      | "purpose"
      | "utility_consent";
  } {
  if (
    !head.test(product.pagetitle) ||
    /^(?:датчик|сенсор|комплектующ|лампа|аксессуар)\p{L}*/iu.test(
      product.pagetitle.trim(),
    ) ||
    (verifiedCategoryTitles
      ? !verifiedCategoryTitles.has(product.leaf_category?.trim() ?? "")
      : normalizeKey(product.leaf_category ?? "") !==
        normalizeKey(RESIDENTIAL_FIXTURE_CATEGORY))
  ) {
    return { ok: false, reason: "class" };
  }
  if (
    product.warehouse_evidence !== "positive" ||
    !product.warehouses?.some((row) =>
      !!row.city.trim() && Number.isFinite(row.qty) && row.qty > 0
    )
  ) {
    return { ok: false, reason: "stock" };
  }
  if (
    !Number.isFinite(product.price) || product.price <= 0 ||
    product.price > selection.cap
  ) return { ok: false, reason: "budget" };
  const use = traitValues(
    product,
    /^(?:вид светильника|назначение|область применения|класс применения)$/u,
  );
  const mountsOnCard = traitValues(
    product,
    /^(?:способ монтажа|тип монтажа|монтаж)$/u,
  );
  if (
    selection.mount &&
    !(mountsOnCard.length
      ? mountsOnCard.every((value) => mounts[selection.mount!].test(value))
      : mounts[selection.mount].test(product.pagetitle))
  ) return { ok: false, reason: "mount" };
  const lampType = traitValues(
    product,
    /^(?:тип лампы|источник света|тип источника света)$/u,
  );
  if (
    selection.led &&
    !(lampType.length
      ? lampType.every((value) => ledHead.test(value))
      : ledHead.test(product.pagetitle))
  ) return { ok: false, reason: "led" };

  const reviewed = reviewedFixtureApplication(product);
  const fields = traitValues(
    product,
    /^(?:с )?(?:датчик|датчиком|сенсор|сенсором) движения$/u,
  );
  const description = (product.description_excerpt ?? "").split(/[.!?;\n]+/u)
    .filter((part) => !vagueVariants.test(part));
  const affirmative = /^(?:да|есть|true|yes)$/iu;
  const explicitNo = /^(?:нет|без|false|no)$/iu;
  const sensorText = [product.pagetitle, ...description].join(" ");
  if (
    fields.some((field) => explicitNo.test(field)) ||
    /(?:без|не\s+име\p{L}*)\s+(?:встроенн\p{L}*\s+)?(?:датчик|сенсор)\p{L}*\s+движен\p{L}*/iu
      .test(sensorText) ||
    checkCriterion(product, {
        key: "С датчиком движения",
        op: "eq",
        value: "да",
        level: "A",
      }).verdict === "fail"
  ) {
    return { ok: false, reason: "sensor" };
  }
  const sensor: CatalogProof | null = reviewed?.sensor
    ? { source: "manufacturer", url: reviewed.url }
    : fields.some((field) => affirmative.test(field))
    ? { source: "catalog_facet" }
    : /(?:с|оснащ\p{L}*|встроенн\p{L}*)\s+(?:\p{L}+\s+){0,2}(?:датчик|сенсор)\p{L}*\s+движен\p{L}*|(?:датчик|сенсор)\p{L}*[^.!?;]{0,45}(?:реагиру\p{L}*\s+на\s+движени|при\s+появлен\p{L}*\s+движущ\p{L}*\s+объект)/iu
        .test(sensorText)
    ? { source: "product_description" }
    : null;
  if (!sensor) return { ok: false, reason: "sensor" };

  const isUtility = reviewed?.utility === true ||
    [product.pagetitle, ...use].some((value) => utilityLabel.test(value)) ||
    description.some((value) =>
      disposition.test(value) && utilityLabel.test(value)
    );
  if (isUtility && (selection.utility !== "allowed" || !selection.place)) {
    return { ok: false, reason: "utility_consent" };
  }
  if ([product.pagetitle, ...use].some((value) => otherUse.test(value))) {
    return { ok: false, reason: "purpose" };
  }
  const expected =
    selection.place === "living_room" || selection.place === "bedroom"
      ? new RegExp(
        `${places[selection.place].source}|${places.living.source}`,
        "iu",
      )
      : selection.place
      ? places[selection.place]
      : residential;
  if (description.some((value) => expected.test(value) && denies.test(value))) {
    return { ok: false, reason: "purpose" };
  }
  if (reviewed) {
    return selection.place && reviewed.places.includes(selection.place)
      ? {
        ok: true,
        application: { source: "manufacturer", url: reviewed.url },
        sensor,
        utility: isUtility,
      }
      : { ok: false, reason: "purpose" };
  }
  if (use.some((value) => expected.test(value) && !denies.test(value))) {
    return {
      ok: true,
      application: { source: "catalog_facet" },
      sensor,
      utility: isUtility,
    };
  }
  if (
    description.some((value) =>
      expected.test(value) && disposition.test(value) && !denies.test(value)
    )
  ) {
    return {
      ok: true,
      application: { source: "product_description" },
      sensor,
      utility: isUtility,
    };
  }
  return { ok: false, reason: "purpose" };
}

export function residentialFixtureShortfall(
  state: ResidentialFixtureSelection,
  count: number,
  searched: boolean,
): { text: string; question: string } {
  const question = !state.place
    ? "Где будет светильник: в жилой комнате, прихожей или в другом месте?"
    : state.utility === "not_confirmed"
    ? "Что изменить: бюджет или допустить модели ЖКХ для указанного места? Для второго варианта напишите «можно ЖКХ»."
    : "Какой новый верхний предел цены можно рассмотреть?";
  const lead = !searched
    ? "Не удалось проверить каталог."
    : count === 1
    ? `В проверенных карточках до ${state.cap} ₸ подтвердился один вариант со встроенным датчиком движения.`
    : count > 1
    ? `В проверенных карточках до ${state.cap} ₸ подтвердились ${count} варианта со встроенным датчиком движения.`
    : `В проверенной части каталога не удалось подтвердить ${
      state.seen.length ? "новые " : ""
    }варианты до ${state.cap} ₸ с нужным назначением и встроенным датчиком движения.`;
  const relax = searched && !state.place
    ? " Если нужно больше вариантов, можно указать новый бюджет. Модели ЖКХ без вашего согласия не добавлю."
    : "";
  return { text: lead + relax, question };
}
