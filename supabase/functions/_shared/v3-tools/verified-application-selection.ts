import type { Criterion } from "./criteria-gate.ts";
import { CUSTOMER_TURN_BOUNDARY } from "./criteria-consistency.ts";
import type { ProductFull } from "./types.ts";

interface LiveFacet {
  key: string;
  caption?: string | null;
  unit?: string | null;
  values?: Array<{ value: string }>;
}

export interface VerifiedApplicationSelectionPlan {
  rule: string;
  reasoning: string;
  criteria: Criterion[];
  facetProofs: Array<{ key: string; value: string }>;
}

// Connected equipment owns the input current; the product being selected
// owns its rating. A verified application rule must name the former before
// its catalog criteria may be used.
interface ApplicationLoadPolicy {
  rule: string;
  applies: (request: string) => boolean;
  maxCoveredAmps: number;
  question: string;
}

const extension = /(?<!\p{L})удлинител\p{L}*/iu;
const welder =
  /(?<!\p{L})(?:свароч\p{L}*\s+(?:аппарат|инвертор)\p{L}*|сварочник\p{L}*)/iu;
const outdoor =
  /ули[цч]\p{L}*|наруж\p{L}*|вне\s+помещени\p{L}*|открыт\p{L}*\s+воздух\p{L}*/iu;
const loadRelation = /(?<!\p{L})(?:для|под|к)(?!\p{L})/iu;
const APPLICATION_LOAD_POLICIES: readonly ApplicationLoadPolicy[] = [{
  rule: "outdoor_welding_extension_16a",
  applies: (request) =>
    request.split(/\n|[!?;]/u).some((clause) => {
      const target = clause.search(extension);
      const load = clause.search(welder);
      if (target < 0 || load < 0) return false;
      return load > target
        ? loadRelation.test(clause.slice(target, load))
        : /(?<!\p{L})(?:для|под|к)(?:\s+моего|\s+моему)?\s*$/iu.test(
          clause.slice(0, load),
        );
    }),
  maxCoveredAmps: 16,
    question:
      "Какой входной ток указан на шильдике аппарата? Напишите значение в амперах (I₁max, если он указан). Сварочный ток на выходе для этого подбора не подходит. Если знаете только модель, проверьте входной ток в паспорте аппарата.",
}];

export const APPLICATION_INPUT_CURRENT_FACET = "equipment_input_current";
const ampValue = String
  .raw`(\d{1,3}(?:[.,]\d{1,3})?)\s*(?:[аa]|ампер\p{L}*)(?![\p{L}\p{N}])`;
const exactAnswer = new RegExp(
  String
    .raw`^\s*(?:(?:по\s+шильдик\p{L}*|точнее)\s*[:=–—-]?\s*)?${ampValue}(?:\s+по\s+шильдик\p{L}*)?[.!]?\s*$`,
  "iu",
);

function explicitInputCurrent(
  message: string,
): { amps: number; catalogText: string } | null {
  // Preserve every other selection condition. Never pull a number across
  // turns or substitute I1eff, output amperage, a breaker or the reel rating.
  if (
    /(?:^|[^\p{L}])(?:примерно|около|наверное|не\s+знаю|не\s+уверен\p{L}*|не\s+указан\p{L}*)(?!\p{L})/iu
      .test(message)
  ) return null;
  const label = String
    .raw`(?<![\p{L}\p{N}])(?:входн\p{L}*\s+ток\p{L}*(?:\s+(?:свароч\p{L}*\s+)?(?:аппарат|инвертор|сварочник)\p{L}*)?|[iі][1₁]\s*max)(?:\s+по\s+шильдик\p{L}*)?`;
  const reading = new RegExp(
    String
      .raw`${label}\s*[:=–—]?\s*${ampValue}(?!\s*(?:[?？–—/-]|(?:или|до)(?!\p{L})|и\s+\d))`,
    "giu",
  );
  const matches = [...message.matchAll(reading)];
  if (matches.length !== 1) return null;
  const match = matches[0];
  const before = message.slice(0, match.index!);
  if (
    /(?:^|[^\p{L}])(?:не|до|от|при)\s*$/iu.test(before) ||
    /(?:^|[^\p{L}])(?:не\s+более|не\s+менее)\s*$/iu.test(before)
  ) return null;
  const amps = Number(match[1].replace(",", "."));
  if (!(amps > 0)) return null;
  const catalogText =
    (before + " " + message.slice(match.index! + match[0].length))
      .trim().replace(/^[\s,;:.]+|[\s,;:.]+$/gu, "");
  return { amps, catalogText };
}

export type ApplicationLoadDecision =
  | { status: "ask"; question: string; rule: string }
  | { status: "unsupported"; rule: string }
  | { status: "ready"; rule: string; amps: number; catalogRequest: string };

export function resolveApplicationLoadReadiness(
  request: string,
  currentMessage = request,
  answeringVerifiedCurrentQuestion = false,
): ApplicationLoadDecision | null {
  const policy = APPLICATION_LOAD_POLICIES.find(({ applies }) =>
    applies(request)
  );
  if (!policy) return null;
  // Only the current customer turn may own this operating point. A bare
  // value can be assigned to it only when the server issued that exact slot.
  const explicit = explicitInputCurrent(currentMessage);
  const bare = answeringVerifiedCurrentQuestion && !explicit
    ? currentMessage.match(exactAnswer)?.[1]
    : undefined;
  const amps = explicit?.amps ?? (bare ? Number(bare.replace(",", ".")) : 0);
  if (!(amps > 0)) {
    return { status: "ask", rule: policy.rule, question: policy.question };
  }
  if (amps > policy.maxCoveredAmps) {
    return { status: "unsupported", rule: policy.rule };
  }
  const suffix = `Уточнение клиента: ${currentMessage.trim()}`;
  const base = request.endsWith(CUSTOMER_TURN_BOUNDARY + suffix)
    ? request.slice(0, -suffix.length - CUSTOMER_TURN_BOUNDARY.length)
    : request === currentMessage
    ? ""
    : request;
  const catalogRequest = [base, explicit?.catalogText ?? ""].filter(Boolean)
    .join(CUSTOMER_TURN_BOUNDARY);
  return { status: "ready", rule: policy.rule, amps, catalogRequest };
}

export const APPLICATION_LOAD_UNSUPPORTED =
  "По указанному входному току я не могу подтвердить подходящий удлинитель. Обратитесь к менеджеру с моделью аппарата и данными с шильдика.";
export const APPLICATION_CARDS_UNVERIFIED =
  "Не удалось подтвердить по каталогу все характеристики удлинителя для этих условий. Непроверенные варианты не показываю.";

function normalize(value: string): string {
  return String(value ?? "")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е")
    .replace(/[×х*]/gu, "x")
    .replace(/,/gu, ".")
    .replace(/[^\p{L}\p{N}.]+/gu, " ")
    .trim();
}

function exactLiveCriterion(
  facets: LiveFacet[],
  caption: RegExp,
  expected: RegExp,
): { criterion: Criterion; facetProof: { key: string; value: string } } | null {
  const candidates = facets.filter((facet) =>
    caption.test(normalize(`${facet.caption ?? ""} ${facet.key}`))
  );
  const matches = candidates.flatMap((facet) =>
    (facet.values ?? [])
      .filter(({ value }) => expected.test(normalize(value)))
      .map(({ value }) => ({ facet, value }))
  );
  if (matches.length !== 1) return null;
  const { facet, value } = matches[0];
  return {
    facetProof: { key: facet.key, value },
    criterion: {
      key: facet.caption || facet.key,
      op: "eq",
      value,
      unit: facet.unit ?? undefined,
      level: "A",
      evidence: "derived_required",
    },
  };
}

function outdoorWeldingExtensionPlan(
  message: string,
  productClass: string,
  facets: LiveFacet[],
  load: Extract<ApplicationLoadDecision, { status: "ready" }>,
): VerifiedApplicationSelectionPlan | null {
  const source = normalize(message);
  if (
    load.rule !== "outdoor_welding_extension_16a" ||
    !outdoor.test(source) || !extension.test(productClass)
  ) return null;

  const lengths = [
    ...message.toLowerCase().matchAll(
      /(?<![\p{L}\p{N}.,+\-−–—])(\d+(?:[.,]\d+)?)(?:\s*([-−–—]|до)\s*(\d+(?:[.,]\d+)?))?\s*м(?:етр\p{L}*)?(?![\p{L}\p{N}²³])/gu,
    ),
  ];
  if (
    lengths.some((match) =>
      match[2] ||
      /(?:^|[^\p{L}])(?:от|до|более|менее)\s*$/iu.test(
        message.slice(0, match.index!),
      )
    )
  ) return null;
  const exactLengths = [
    ...new Set(lengths.map((match) => Number(match[1].replace(",", ".")))),
  ];
  const requestedLength = exactLengths.length === 1 && exactLengths[0] > 0
    ? String(exactLengths[0])
    : null;
  // The rule describes a length-specific engineering selection. Never fill a
  // missing length or silently accept a nearby live value: the exact value
  // must be both customer-owned and uniquely represented by the category
  // schema.
  if (!requestedLength) return null;
  const escapedLength = requestedLength.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const lengthCriterion = exactLiveCriterion(
    facets,
    /длин\p{L}*\s+(?:кабел|провод|шнур)\p{L}*/u,
    new RegExp(`^${escapedLength}(?:\\.0+)?(?:\\s*м)?$`, "u"),
  );

  const requirements = [
    lengthCriterion,
    exactLiveCriterion(
      facets,
      /сечен\p{L}*\s+жил/u,
      /^(?:2\.5|2\.50)(?:\s*мм2)?$/u,
    ),
    exactLiveCriterion(facets, /количеств\p{L}*\s+жил/u, /^3$/u),
    exactLiveCriterion(
      facets,
      /степен\p{L}*\s+защит/u,
      /^(?:ip\s*)?44$/u,
    ),
    exactLiveCriterion(
      facets,
      /номинальн\p{L}*\s+ток/u,
      /^16(?:\.0)?(?:\s*а)?$/u,
    ),
    exactLiveCriterion(
      facets,
      /тип\p{L}*\s+кабел/u,
      /^кг$/u,
    ),
  ];
  if (!requirements.every((criterion) => criterion !== null)) return null;
  return {
    rule: "outdoor_welding_extension_16a",
    reasoning: `Входной ток аппарата — ${
      String(load.amps).replace(".", ",")
    } А. В каталоге проверяю длину кабеля — ${requestedLength} м, тип КГ, 3 жилы, сечение жилы 2,5 мм², номинальный ток удлинителя 16 А и степень защиты IP44. Перед подключением сверьте разъёмы и указания в паспорте аппарата и удлинителя. Кабель на катушке при работе нужно полностью размотать.`,
    criteria: requirements.map((requirement) => requirement!.criterion),
    facetProofs: requirements.map((requirement) => requirement!.facetProof),
  };
}

/** The catalog search result and text title are not raw SKU proof. Reject
 * missing and conflicting values on each exact live axis independently. */
export function productProvesVerifiedApplication(
  product: ProductFull | undefined,
  plan: VerifiedApplicationSelectionPlan | null,
): boolean {
  if (!product?.facet_values || !plan) return false;
  return plan.facetProofs.every(({ key, value }) => {
    const actual = product.facet_values?.[key];
    return Boolean(
      actual?.length &&
        actual.every((item) => normalize(item) === normalize(value)),
    );
  });
}

const RULES = [outdoorWeldingExtensionPlan] as const;

/**
 * Returns a complete live-schema-backed suitability contract or null.  A rule
 * is fail-closed: if even one mandatory facet/value is absent or ambiguous,
 * no partial criteria are returned and the caller must not recommend a card
 * for the verified application.
 */
export function resolveVerifiedApplicationSelection(
  message: string,
  productClass: string,
  facets: LiveFacet[],
  load: Extract<ApplicationLoadDecision, { status: "ready" }> | null,
): VerifiedApplicationSelectionPlan | null {
  if (!load) return null;
  for (const rule of RULES) {
    const plan = rule(message, productClass, facets, load);
    if (plan) return plan;
  }
  return null;
}
