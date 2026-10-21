import {
  extractClientQuantities,
  isPhysicalMeasurementUnit,
} from "./criteria-consistency.ts";
import { isAdditionalProductSelectionFollowup } from "./recent-product-evidence.ts";
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

function hasCompleteServerEvidence(
  evidence: string,
  serverVerifiedBaseRequest: string,
): boolean {
  const verified = normalizedIdentity(serverVerifiedBaseRequest);
  if (!verified) return false;
  // The evidence composer joins *whole* logged user queries with newlines.
  // A substring of a different request must not authorize inherited scope.
  return String(evidence ?? "").split(/\n/u)
    .some((query) => normalizedIdentity(query) === verified);
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
    normalizedIdentity(base) !== normalizedIdentity(verifiedBase) ||
    !hasCompleteServerEvidence(evidence, verifiedBase)
  ) return NOT_COVERED;

  const followup = selection.slice(base.length + 1).trim();
  if (!isAdditionalProductSelectionFollowup(followup)) return NOT_COVERED;

  const baseFit = verifyReplacementDestinationFit(base, []);
  const selectionFit = verifyReplacementDestinationFit(selection, []);
  const verifiedFit = verifyReplacementDestinationFit(verifiedBase, []);
  const evidenceFit = verifyReplacementDestinationFit(evidence, []);
  const area = verifiedFit.minimum_area_m2;
  const place = normalizedIdentity(verifiedFit.place ?? "");
  if (
    !baseFit.required || !selectionFit.required || !verifiedFit.required ||
    !evidenceFit.required || !place || area === null ||
    ![baseFit, selectionFit, evidenceFit].every((fit) =>
      normalizedIdentity(fit.place ?? "") === place &&
      fit.minimum_area_m2 === area
    ) ||
    ![base, selection, verifiedBase, evidence].every((text) =>
      containsOnlyRequiredArea(text, area)
    )
  ) return NOT_COVERED;

  return { covered: true, minimumAreaM2: area };
}
