import { CUSTOMER_TURN_BOUNDARY } from "./criteria-consistency.ts";
import { canonicalMeasurementUnit } from "./criteria-reasoning.ts";

export interface DialogueTurnState {
  kind: "new_request" | "pending_answer" | "rendered_evidence" | "continuation";
  request: string;
  /** Current customer facts with only a server-issued dimension label added. */
  currentCustomerEvidence: string;
  /** Customer conditions from an authenticated server question, NOT SKU facts. */
  priorCustomerTurns: string[];
  requiresRenderedCards: boolean;
}

export const MAX_TASK_TURNS = 16;
export const MAX_TASK_CHARS = 8_000;
/** Scope must come from the latest authenticated server question. A legacy
 * token is a compatibility input only; new snapshots never truncate facts. */
export function readReadinessTaskTurns(
  scope: Record<string, unknown>,
): string[] | null {
  if (scope.context_overflow === true) return null;
  const turns = scope.customer_turns === undefined
    ? typeof scope.token === "string"
      ? scope.token.split(CUSTOMER_TURN_BOUNDARY)
      : []
    : scope.customer_turns;
  if (
    !Array.isArray(turns) || !turns.length || turns.length > MAX_TASK_TURNS ||
    turns.some((turn) => typeof turn !== "string" || !turn.trim()) ||
    turns.join(CUSTOMER_TURN_BOUNDARY).length > MAX_TASK_CHARS
  ) return null;
  return [...turns];
}

/** Compiles scope once, after the boundary and latest issued question were
 * verified. Browser history, cards, slots and stale caches are not authorities.
 * A pending answer authorises a fresh search, never a suitability claim. */
export function compileDialogueTurnState(input: {
  current: string;
  newTask: boolean;
  referencesRenderedCards: boolean;
  verifiedPendingSlot: Record<string, unknown> | null;
  scopedRequest: { message: string; scoped: boolean };
}): DialogueTurnState {
  const base = { request: input.current, currentCustomerEvidence: input.current, priorCustomerTurns: [] as string[] };
  if (input.newTask) {
    return { ...base, kind: "new_request", requiresRenderedCards: false };
  }
  // A genuine question about old SKUs still needs the completed server batch.
  if (input.referencesRenderedCards) {
    return { ...base, kind: "rendered_evidence", requiresRenderedCards: true };
  }
  const slot = input.verifiedPendingSlot;
  const scope = slot?.scope;
  if (
    input.scopedRequest.scoped && slot?.status === "pending" &&
    typeof slot.slot_id === "string" && slot.slot_id &&
    scope && typeof scope === "object" && !Array.isArray(scope) &&
    (scope as Record<string, unknown>).kind === "selection_readiness" &&
    typeof (scope as Record<string, unknown>).token === "string"
  ) {
    const turns = readReadinessTaskTurns(scope as Record<string, unknown>);
    if (turns) {
      return {
        kind: "pending_answer",
        request: input.scopedRequest.message,
        currentCustomerEvidence: projectVerifiedReadinessAnswer(input.current, slot),
        priorCustomerTurns: turns,
        requiresRenderedCards: false,
      };
    }
  }
  return { ...base, kind: "continuation", requiresRenderedCards: false };
}

export interface ClarificationAnswerAxis {
  key: string;
  label: string;
  unit: string;
}
const PHYSICAL_UNIT =
  /^(?:мм|см|м|км|мм²|см²|м²|мм³|см³|м³|ма|а|ка|в|кв|вт|квт|лм|лк|к|с|°с|гц|кг|г|л|мл)$/u;

function quantities(text: string) {
  return [...text.matchAll(
    /(?<![\p{L}\p{N}.,+-])(\d+(?:[.,]\d+)?)\s*([\p{L}°]{1,12}(?:[²³]|[23])?)(?![\p{L}\p{N}²³])/giu,
  )];
}

/** Derive an answer dimension from the issued schema, not a product/domain
 * dictionary. Mixed-unit/ambiguous options cannot supply a dimension. */
export function clarificationAnswerAxis(
  key: string,
  label: string,
  options: readonly { value: string }[],
): ClarificationAnswerAxis | undefined {
  const units = options.map(({ value }) =>
    quantities(value).map((match) => canonicalMeasurementUnit(match[2]))
  );
  if (
    !units.length ||
    units.some((row) => row.length !== 1 || !PHYSICAL_UNIT.test(row[0])) ||
    new Set(units.flat()).size !== 1
  ) return undefined;
  return { key, label, unit: units[0][0] };
}

/** A compact mixed-unit reply supplies separate facts. Bind its single value
 * of the asked dimension only to an authenticated, server-issued answer axis.
 * Prose naming another property, competing values, ranges, signs or units
 * omitted by the customer are never guessed. Original evidence is retained. */
export function projectVerifiedReadinessAnswer(
  current: string,
  slot: { facet_key?: unknown; scope?: unknown },
): string {
  const scope = slot.scope;
  const axis = scope && typeof scope === "object" && !Array.isArray(scope)
    ? (scope as Record<string, unknown>).answer_axis
    : null;
  if (!axis || typeof axis !== "object" || Array.isArray(axis)) return current;
  const { key, label, unit } = axis as Record<string, unknown>;
  if (
    key !== slot.facet_key || typeof label !== "string" || !label.trim() ||
    label.length > 160 || /[\r\n]/u.test(label) || typeof unit !== "string" ||
    !unit
  ) return current;
  const parsed = quantities(current);
  const matching = parsed.filter((match) =>
    canonicalMeasurementUnit(match[2]) === unit
  );
  if (
    matching.length !== 1 ||
    parsed.some((match) =>
      Number(match[1].replace(",", ".")) <= 0 ||
      !PHYSICAL_UNIT.test(canonicalMeasurementUnit(match[2]))
    )
  ) return current;
  let residue = current;
  for (const match of [...parsed].reverse()) {
    residue = residue.slice(0, match.index) + " " +
      residue.slice(match.index! + match[0].length);
  }
  if (
    residue.replace(/(?:^|[^\p{L}])и(?=$|[^\p{L}])/giu, " ")
      .replace(/[\s,:;.]/gu, "")
  ) return current;
  return `${current}\n${label}: ${matching[0][0]}`;
}
