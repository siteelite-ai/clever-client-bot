import {
  extractClientQuantities,
  isPhysicalMeasurementUnit,
  normalizeMeasurementText,
} from "./criteria-consistency.ts";
import {
  isAdditionalProductSelectionFollowup,
  isEvidenceOnlyFollowup,
} from "./recent-product-evidence.ts";
import { verifyReplacementDestinationFit } from "./selection-contract.ts";

export interface DestinationAreaMeasurementCoverageInput {
  /** The synthetic request passed to selection: exact base + newline + follow-up. */
  selectionRequest: string;
  /** The base recovered from the controlled product-batch history. */
  baseRequest: string;
  /** The independently retrieved original request of that completed batch. */
  serverVerifiedBaseRequest: string;
  /** Customer numbers from completed server logs, not browser history. */
  customerMeasurementEvidence: string;
  /** All completed server-log customer turns, newest first, before compaction. */
  serverVerifiedPriorQueriesNewestFirst: readonly string[];
}

export interface DestinationAreaMeasurementCoverage {
  covered: boolean;
  minimumAreaM2: number | null;
}

const NOT_COVERED: DestinationAreaMeasurementCoverage = {
  covered: false,
  minimumAreaM2: null,
};

function normalizedIdentity(value: string): string {
  return String(value ?? "").toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е").replace(/\s+/gu, " ").trim();
}

function verifiedInterveningQueries(
  serverVerifiedBaseRequest: string,
  priorQueriesNewestFirst: readonly string[],
): readonly string[] | null {
  // Text compacted for the model cannot establish whether a later customer
  // turn changed the target. Only the bounded completed server-log chain may
  // authorize inheritance of the previously rendered request.
  if (
    !Array.isArray(priorQueriesNewestFirst) ||
    priorQueriesNewestFirst.length === 0 ||
    priorQueriesNewestFirst.length > 8 ||
    priorQueriesNewestFirst.some((query) =>
      typeof query !== "string" || !query.trim()
    )
  ) return null;
  const baseIndex = priorQueriesNewestFirst.findIndex((query) =>
    normalizedIdentity(query) === normalizedIdentity(serverVerifiedBaseRequest)
  );
  return baseIndex < 0 ? null : priorQueriesNewestFirst.slice(0, baseIndex);
}

function hasServerVerifiedAreaEvidence(
  evidence: string,
  followup: string,
  serverVerifiedBaseRequest: string,
  minimumAreaM2: number,
  priorQueriesNewestFirst: readonly string[],
): boolean {
  // Numeric compaction drops a previous same-unit query *and* every unitless
  // query. It cannot prove that a later customer turn did not change the
  // destination. Recheck every full server-log turn from the controlled card
  // batch through the current request, not just the surviving number.
  const intervening = verifiedInterveningQueries(
    serverVerifiedBaseRequest,
    priorQueriesNewestFirst,
  );
  if (
    !intervening || intervening.some((query) =>
      !isNeutralContinuation(query) &&
      !isPureAreaReaffirmation(query, minimumAreaM2)
    )
  ) return false;
  // The composer keeps the most recent m² query from this exact bounded log
  // chain. Tie the compacted text back to that query; a missing log, changed
  // number, or second physical axis must never borrow the original proof.
  const latestAreaQuery = [...intervening, serverVerifiedBaseRequest]
    .find((query) =>
      extractClientQuantities(query).some(({ unit }) => unit === "м²")
    );
  return Boolean(
    latestAreaQuery &&
      containsOnlyRequiredArea(latestAreaQuery, minimumAreaM2) &&
      normalizedIdentity(evidence) ===
        normalizedIdentity(`${followup}\n${latestAreaQuery}`),
  );
}

function isNeutralContinuation(query: string): boolean {
  return /^(?:спасибо|благодарю|понятно|хорошо|ок|ладно)[!.,\s]*$/iu
    .test(query.trim()) ||
    isAdditionalProductSelectionFollowup(query) ||
    isNeutralRenderedEvidenceFollowup(query);
}

/** A comparison of already shown cards is not a new customer requirement.
 * It can sit between a verified selection and “other options”, but never
 * supply or alter the destination-area proof itself. Each clause must remain
 * evidence-only; a new site, number, or independent task ends this chain. */
function isNeutralRenderedEvidenceFollowup(query: string): boolean {
  if (query.length > 800) return false;
  const clauses = String(query ?? "").split(/[.!?;]+/u)
    .map((clause) => clause.trim()).filter(Boolean);
  if (
    clauses.length === 0 || clauses.length > 4 ||
    clauses.some((clause) => !isEvidenceOnlyFollowup(clause))
  ) return false;
  const normalized = normalizeMeasurementText(query).toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е");
  // A number may be a new budget, area, power or product count. Without a
  // fresh selection contract it is safer not to classify it as neutral.
  if (/\d/u.test(normalized)) return false;
  // Prepositions introducing a destination are intentionally fail-closed,
  // including a room stated without a measurement. “В чём разница” is an
  // evidence question, not a destination.
  if (
    /(?:^|\s)(?:для|в|во|на|под)\s+(?!ч[её]м(?:$|[^\p{L}]))\p{L}+/u.test(
      normalized,
    )
  ) {
    return false;
  }
  // This is a closed *dialogue-intent* vocabulary, not a product/category
  // dictionary. Unknown content words could be a new nonnumeric filter
  // (“red”, “brand X”, “outdoor”) and must use the normal selection route.
  const words = normalized.match(/\p{L}+/gu) ?? [];
  return words.length > 0 && words.length <= 40 &&
    words.every((word) =>
      /^(?:а|ну|тогда|пожалуйста|почему|чем|как|что|какие|какой|какая|какое|это|этот|эта|эти|этого|этих|этим|этими|они|их|ними|них|между|из|по|в|у|ли|не|точно|действительно|ранее|перв\p{L}*|втор\p{L}*|треть\p{L}*|показан\p{L}*|предложен\p{L}*|подтвержден\p{L}*|сравн\p{L}*|отлич\p{L}*|разниц\p{L}*|подход\p{L}*|вариант\p{L}*|товар\p{L}*|модел\p{L}*|карточ\p{L}*|характеристик\p{L}*|параметр\p{L}*|цен\p{L}*|стоимост\p{L}*)$/u
        .test(word)
    );
}

function isPureAreaReaffirmation(query: string, area: number): boolean {
  if (
    !isEvidenceOnlyFollowup(query) || !containsOnlyRequiredArea(query, area)
  ) {
    return false;
  }
  // A bounded anaphoric suitability question may reaffirm an area, but may
  // not introduce any new place, product or criterion. Unknown wording is
  // intentionally closed; "для спальни" and "на кухню" are not mere repeats.
  const normalized = normalizeMeasurementText(query).toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е").replace(/[?!.]+$/gu, "")
    .replace(/\s+/gu, " ").trim();
  const match = normalized.match(
    /^(?:а\s+)?(?:они|эти|он|она|это|этот|эта)\s+(?:(?:точно|действительно)\s+)?(?:подходят|подойдут|подходит|подойдет)\s+(?:для\s+освещения\s+)?(\d+(?:[.,]\d+)?)\s*м²$/u,
  );
  return Boolean(match && Number(match[1].replace(",", ".")) === area);
}

function containsOnlyRequiredArea(
  text: string,
  minimumAreaM2: number,
): boolean {
  const physical = extractClientQuantities(text)
    .filter(({ unit }) => isPhysicalMeasurementUnit(unit));
  // Even a second area of the same size could describe another room in a
  // previous turn. This optimization applies only to one unambiguous number.
  return physical.length === 1 && physical[0].unit === "м²" &&
    physical[0].value === minimumAreaM2;
}

/** Whether the rendered selection is still the current customer task.
 * Unlike the sole-measurement optimization below, this accepts an original
 * request with additional physical criteria. It proves only provenance and
 * unchanged destination, never that any individual product is suitable. */
export function verifiedRenderedDestinationContextUnchanged(
  input: Pick<
    DestinationAreaMeasurementCoverageInput,
    | "selectionRequest"
    | "baseRequest"
    | "serverVerifiedBaseRequest"
    | "serverVerifiedPriorQueriesNewestFirst"
  >,
): boolean {
  const base = String(input.baseRequest ?? "");
  const verifiedBase = String(input.serverVerifiedBaseRequest ?? "");
  const selection = String(input.selectionRequest ?? "");
  if (
    !base || !verifiedBase || !selection.startsWith(`${base}\n`) ||
    normalizedIdentity(base) !== normalizedIdentity(verifiedBase)
  ) return false;
  const followup = selection.slice(base.length + 1).trim();
  if (!isAdditionalProductSelectionFollowup(followup)) return false;
  const baseFit = verifyReplacementDestinationFit(verifiedBase, []);
  const selectionFit = verifyReplacementDestinationFit(selection, []);
  const area = baseFit.minimum_area_m2;
  if (
    !baseFit.required || !selectionFit.required || area === null ||
    selectionFit.minimum_area_m2 !== area ||
    normalizedIdentity(selectionFit.place ?? "") !==
      normalizedIdentity(baseFit.place ?? "")
  ) return false;
  const intervening = verifiedInterveningQueries(
    verifiedBase,
    input.serverVerifiedPriorQueriesNewestFirst,
  );
  return intervening !== null &&
    intervening.every((query) =>
      isNeutralContinuation(query) || isPureAreaReaffirmation(query, area)
    );
}

/**
 * Only the destination-area obligation may be discharged by the independent
 * card-level replacement-fit gate. This does not certify a card or bypass
 * fresh catalog retrieval: callers must still run verifyReplacementDestinationFit
 * against every new candidate. Every missing or conflicting source fails closed.
 */
export function verifiedDestinationAreaCoversSoleMeasurement(
  input: DestinationAreaMeasurementCoverageInput,
): DestinationAreaMeasurementCoverage {
  const base = String(input.baseRequest ?? "");
  const verifiedBase = String(input.serverVerifiedBaseRequest ?? "");
  const selection = String(input.selectionRequest ?? "");
  const evidence = String(input.customerMeasurementEvidence ?? "");
  if (
    !base || !verifiedBase || !selection.startsWith(`${base}\n`) ||
    normalizedIdentity(base) !== normalizedIdentity(verifiedBase)
  ) return NOT_COVERED;

  const followup = selection.slice(base.length + 1).trim();
  if (!isAdditionalProductSelectionFollowup(followup)) return NOT_COVERED;

  const baseFit = verifyReplacementDestinationFit(base, []);
  const selectionFit = verifyReplacementDestinationFit(selection, []);
  const verifiedFit = verifyReplacementDestinationFit(verifiedBase, []);
  const area = verifiedFit.minimum_area_m2;
  const place = normalizedIdentity(verifiedFit.place ?? "");
  if (
    !baseFit.required || !selectionFit.required || !verifiedFit.required ||
    !place || area === null ||
    ![baseFit, selectionFit].every((fit) =>
      normalizedIdentity(fit.place ?? "") === place &&
      fit.minimum_area_m2 === area
    ) ||
    ![base, selection, verifiedBase, evidence].every((text) =>
      containsOnlyRequiredArea(text, area)
    ) ||
    !hasServerVerifiedAreaEvidence(
      evidence,
      followup,
      verifiedBase,
      area,
      input.serverVerifiedPriorQueriesNewestFirst,
    )
  ) return NOT_COVERED;

  return { covered: true, minimumAreaM2: area };
}
