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
  if (
    !Array.isArray(priorQueriesNewestFirst) ||
    priorQueriesNewestFirst.length === 0 ||
    priorQueriesNewestFirst.length > 8 ||
    priorQueriesNewestFirst.some((query) =>
      typeof query !== "string" || !query.trim()
    )
  ) return false;
  const baseIndex = priorQueriesNewestFirst.findIndex((query) =>
    normalizedIdentity(query) === normalizedIdentity(serverVerifiedBaseRequest)
  );
  if (baseIndex < 0) return false;
  const intervening = priorQueriesNewestFirst.slice(0, baseIndex);
  if (
    intervening.some((query) =>
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
    .test(query.trim()) || isAdditionalProductSelectionFollowup(query);
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
