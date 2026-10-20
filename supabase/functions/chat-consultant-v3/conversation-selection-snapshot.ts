/**
 * A proposed, default-off continuation projection for conversation-state.
 * A durable, successful v3 log row may advance it. The separate, default-off
 * atomic-finish path can propose the same state before its one SQL commit,
 * provided the caller supplies an already claimed server row and exact
 * server-rendered egress proofs. Browser history, slots, and model prose are
 * deliberately absent from both APIs. Neither is imported by the live handler.
 */
import { boundedServerSnapshot } from "./conversation-state.ts";
import {
  buildConversationEgressProof,
  type EgressProofResult,
} from "./conversation-egress-proof.ts";
import {
  type ServerDestinationFitProof,
  verifyReplacementDestinationFit,
} from "../_shared/v3-tools/selection-contract.ts";
import type { ProductCache, ProductFull } from "../_shared/v3-tools/types.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const CONTRACT_HASH = /^selection-[0-9a-f]{8}$/u;
const MAX_SELECTION_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_URLS = 40;
const MAX_CRITERIA = 20;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const CONTROLLED_CARD =
  /-\s+\*\*\[[^\]\r\n]{1,300}\]\((https:\/\/220volt\.kz\/catalog\/[^)\s]+)\)\*\*/gu;

/** An exclusion identity, never a render authorization. Keep this independent
 * of the catalog client so pure state tests cannot initialize a network SDK. */
function catalogUrlIdentity(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" || parsed.hostname !== "220volt.kz" ||
      !parsed.pathname.startsWith("/catalog/") ||
      parsed.pathname === "/catalog/"
    ) return null;
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/u, "")}/`;
  } catch {
    return null;
  }
}

export interface ServerSelectionCriterion {
  key: string;
  op: "eq" | "min" | "max" | "range";
  value: string | number | [number, number];
  unit?: string | null;
  exclusive?: boolean;
  evidence?: "user_explicit" | "derived_required";
}

export interface ServerSelectionContinuation {
  /** A substantive request from a completed server log, not browser history. */
  base_request: string;
  selected_from_log_id: string;
  selected_at: string;
  selection_hash: string;
  mandatory_criteria: ServerSelectionCriterion[];
  /** Server egress proof for exact measured-replacement cards, not a facet. */
  destination_fit_proof?: ServerDestinationFitProof;
  /** Exclusion hints only; every new card must pass a fresh catalog search. */
  shown_product_urls: string[];
}

export interface ServerSelectionSnapshot {
  source_log_id: string;
  topic_id: string;
  selection: ServerSelectionContinuation | null;
}

export interface CompletedSelectionLogRow {
  id: unknown;
  chat_v3_topic_id: unknown;
  pipeline: unknown;
  user_query: unknown;
  error: unknown;
  created_at: unknown;
  response_events: unknown;
}

/** A service-role read of the log after atomic claim-and-begin returned
 * `begun`. The provenance marker is a runtime assertion, not a credential:
 * the caller must obtain this from its server-owned claim, never request JSON.
 * `created_at` is the database row timestamp, not a browser clock. */
export interface ServerClaimedSelectionLogRow {
  provenance: "server_atomic_claim_v1";
  id: string;
  chat_v3_topic_id: string;
  session_id: string;
  user_query: string;
  created_at: string;
  pipeline: "v3";
  error: "in_progress";
}

export type PrecommitSelectionSnapshotInput =
  | { mode: "off" }
  | {
    mode: "on";
    previous: unknown;
    claim: ServerClaimedSelectionLogRow;
    topicId: string;
    /** The final server-owned log events, ending in complete + done. */
    responseEvents: readonly unknown[];
    /** One exact egress result per products_block, in event order. */
    egressProofs: readonly EgressProofResult[];
    continuationApproved: boolean;
    continuationKind: "none" | "evidence" | "additional";
    now?: number;
  };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validCriterion(input: unknown): ServerSelectionCriterion | null {
  const item = record(input);
  if (
    !item || typeof item.key !== "string" || !item.key.trim() ||
    item.key.length > 160 ||
    !["eq", "min", "max", "range"].includes(String(item.op)) ||
    (item.unit !== undefined && item.unit !== null &&
      (typeof item.unit !== "string" || item.unit.length > 32)) ||
    (item.exclusive !== undefined && typeof item.exclusive !== "boolean") ||
    (item.evidence !== undefined && item.evidence !== "user_explicit" &&
      item.evidence !== "derived_required")
  ) return null;
  const value = item.value;
  if (item.op === "range") {
    if (
      !Array.isArray(value) || value.length !== 2 ||
      !value.every((number) =>
        typeof number === "number" &&
        Number.isFinite(number)
      ) || value[0] > value[1]
    ) return null;
  } else if (
    !(
      (typeof value === "string" && value.length > 0 && value.length <= 200) ||
      (typeof value === "number" && Number.isFinite(value))
    )
  ) return null;
  return {
    key: item.key,
    op: item.op as ServerSelectionCriterion["op"],
    value: value as ServerSelectionCriterion["value"],
    ...(item.unit !== undefined ? { unit: item.unit as string | null } : {}),
    ...(item.exclusive !== undefined
      ? { exclusive: item.exclusive as boolean }
      : {}),
    ...(item.evidence !== undefined
      ? { evidence: item.evidence as ServerSelectionCriterion["evidence"] }
      : {}),
  };
}

function parsedDestinationFitProof(
  value: unknown,
  baseRequest: string,
  selectionHash: string,
  expectedUrls: string[],
): ServerDestinationFitProof | null {
  const item = record(value);
  const requestFit = verifyReplacementDestinationFit(baseRequest, []);
  if (
    !item || !requestFit.required ||
    item.kind !== "replacement_destination_fit_v1" ||
    item.selection_hash !== selectionHash ||
    item.customer_request !== baseRequest ||
    item.place !== requestFit.place ||
    item.minimum_area_m2 !== requestFit.minimum_area_m2 ||
    !Array.isArray(item.rendered_cards) ||
    item.rendered_cards.length !== expectedUrls.length ||
    expectedUrls.length === 0 || expectedUrls.length > MAX_URLS
  ) return null;
  const cards = item.rendered_cards.map((value) => {
    const card = record(value);
    if (
      !card || typeof card.id !== "string" ||
      !card.id.trim() || card.id.length > 128 ||
      typeof card.url !== "string" ||
      catalogUrlIdentity(card.url) !== card.url
    ) return null;
    return { id: card.id, url: card.url };
  });
  if (
    cards.some((card) => !card) ||
    cards.some((card, index) => card?.url !== expectedUrls[index]) ||
    new Set(cards.map((card) => card?.id)).size !== cards.length
  ) return null;
  return {
    kind: "replacement_destination_fit_v1",
    selection_hash: selectionHash,
    customer_request: baseRequest,
    place: requestFit.place as string,
    minimum_area_m2: requestFit.minimum_area_m2 as number,
    rendered_cards: cards as Array<{ id: string; url: string }>,
  };
}

function parsedSelection(
  value: unknown,
  now: number,
): ServerSelectionContinuation | null {
  const item = record(value);
  if (
    !item || typeof item.base_request !== "string" ||
    !item.base_request.trim() || item.base_request.length > 2_000 ||
    typeof item.selected_from_log_id !== "string" ||
    !UUID.test(item.selected_from_log_id) ||
    typeof item.selected_at !== "string" ||
    typeof item.selection_hash !== "string" ||
    !CONTRACT_HASH.test(item.selection_hash) ||
    !Array.isArray(item.mandatory_criteria) ||
    item.mandatory_criteria.length > MAX_CRITERIA ||
    !Array.isArray(item.shown_product_urls) ||
    item.shown_product_urls.length === 0 ||
    item.shown_product_urls.length > MAX_URLS
  ) return null;
  const selectedAt = Date.parse(item.selected_at);
  if (
    !Number.isFinite(selectedAt) || selectedAt > now + 60_000 ||
    now - selectedAt > MAX_SELECTION_AGE_MS
  ) return null;
  const criteria = item.mandatory_criteria.map(validCriterion);
  if (criteria.some((criterion) => criterion === null)) return null;
  const rawUrls = item.shown_product_urls as unknown[];
  const urls = rawUrls.map((url) =>
    typeof url === "string" ? catalogUrlIdentity(url) : null
  );
  if (
    urls.some((url, index) => url === null || url !== rawUrls[index]) ||
    new Set(urls).size !== urls.length
  ) return null;
  const destinationRequired = verifyReplacementDestinationFit(
    item.base_request,
    [],
  ).required;
  const destinationProof = item.destination_fit_proof === undefined
    ? null
    : parsedDestinationFitProof(
      item.destination_fit_proof,
      item.base_request,
      item.selection_hash,
      urls as string[],
    );
  if (
    (destinationRequired && !destinationProof) ||
    (item.destination_fit_proof !== undefined && !destinationProof) ||
    (criteria.length === 0 && !destinationProof)
  ) return null;
  return {
    base_request: item.base_request,
    selected_from_log_id: item.selected_from_log_id,
    selected_at: item.selected_at,
    selection_hash: item.selection_hash,
    mandatory_criteria: criteria as ServerSelectionCriterion[],
    ...(destinationProof ? { destination_fit_proof: destinationProof } : {}),
    shown_product_urls: urls as string[],
  };
}

function priorSelection(
  previous: unknown,
  topicId: string,
  now: number,
): ServerSelectionContinuation | null {
  if (
    previous == null ||
    (record(previous) && Object.keys(previous as object).length === 0)
  ) {
    return null;
  }
  const state = record(previous);
  if (
    !state || state.topic_id !== topicId ||
    typeof state.source_log_id !== "string" ||
    !UUID.test(state.source_log_id)
  ) {
    throw new Error("invalid_prior_server_selection_state");
  }
  if (state.selection === null) return null;
  // A malformed or expired prior contract may never become an inherited hard
  // filter. Reset it while preserving the conversation itself.
  return parsedSelection(state.selection, now);
}

function completedEvents(row: CompletedSelectionLogRow): unknown[] {
  if (
    typeof row.id !== "string" || !UUID.test(row.id) ||
    row.pipeline !== "v3" || row.error !== null ||
    typeof row.user_query !== "string" || !row.user_query.trim() ||
    row.user_query.length > 2_000 || !Array.isArray(row.response_events) ||
    row.response_events.length < 2
  ) {
    throw new Error("invalid_completed_selection_log");
  }
  const events = row.response_events;
  const complete = record(events[events.length - 2]);
  const done = record(events[events.length - 1]);
  if (
    complete?.type !== "diagnostic" || complete.phase !== "complete" ||
    complete.log_id !== row.id || complete.error !== null ||
    done?.type !== "done"
  ) {
    throw new Error("unfinished_selection_log");
  }
  return events;
}

function currentSelection(
  events: unknown[],
  baseRequest: string,
  logId: string,
  createdAt: string,
): ServerSelectionContinuation | null {
  const blocks = events.filter((event) =>
    record(event)?.type === "products_block"
  );
  if (blocks.length === 0) return null;
  const urls: string[] = [];
  const destinationRequired = verifyReplacementDestinationFit(
    baseRequest,
    [],
  ).required;
  let hash: string | null = null;
  let criteria: ServerSelectionCriterion[] | null = null;
  let destinationProof: ServerDestinationFitProof | null = null;
  for (const blockValue of blocks) {
    const block = record(blockValue)!;
    const contract = record(block.selection_contract);
    if (
      typeof block.markdown !== "string" || block.markdown.length > 32_000 ||
      !Number.isSafeInteger(block.count) || (block.count as number) < 1 ||
      (block.count as number) > 10 || !contract ||
      typeof contract.hash !== "string" ||
      !CONTRACT_HASH.test(contract.hash) ||
      !Array.isArray(contract.mandatory_criteria) ||
      contract.mandatory_criteria.length > MAX_CRITERIA
    ) return null;
    const parsedCriteria = contract.mandatory_criteria.map(validCriterion);
    if (parsedCriteria.some((criterion) => criterion === null)) return null;
    if (
      hash !== null && (hash !== contract.hash ||
        JSON.stringify(criteria) !== JSON.stringify(parsedCriteria))
    ) return null;
    hash = contract.hash;
    criteria = parsedCriteria as ServerSelectionCriterion[];
    const blockUrls = [...block.markdown.matchAll(CONTROLLED_CARD)]
      .map((match) => catalogUrlIdentity(match[1]));
    if (blockUrls.length !== block.count || blockUrls.some((url) => !url)) {
      return null;
    }
    const blockProof = block.server_destination_fit_proof === undefined
      ? null
      : parsedDestinationFitProof(
        block.server_destination_fit_proof,
        baseRequest,
        contract.hash,
        blockUrls as string[],
      );
    if (
      (destinationRequired && !blockProof) ||
      (!destinationRequired &&
        block.server_destination_fit_proof !== undefined) ||
      (block.server_destination_fit_proof !== undefined && !blockProof) ||
      (parsedCriteria.length === 0 && !blockProof) ||
      (destinationProof && !blockProof)
    ) return null;
    if (blockProof) {
      if (
        destinationProof && (
          destinationProof.place !== blockProof.place ||
          destinationProof.minimum_area_m2 !== blockProof.minimum_area_m2 ||
          destinationProof.selection_hash !== blockProof.selection_hash
        )
      ) return null;
      const previousCards: Array<{ id: string; url: string }> = destinationProof
        ? (destinationProof as ServerDestinationFitProof).rendered_cards
        : [];
      destinationProof = {
        ...blockProof,
        rendered_cards: [
          ...previousCards,
          ...blockProof.rendered_cards,
        ],
      };
    }
    for (const url of blockUrls) {
      if (!url || urls.includes(url)) return null;
      urls.push(url);
    }
    if (urls.length > MAX_URLS) return null;
  }
  if (!hash || !criteria || urls.length === 0) return null;
  if (
    destinationProof &&
    !parsedDestinationFitProof(destinationProof, baseRequest, hash, urls)
  ) return null;
  return {
    base_request: baseRequest,
    selected_from_log_id: logId,
    selected_at: createdAt,
    selection_hash: hash,
    mandatory_criteria: criteria,
    ...(destinationProof ? { destination_fit_proof: destinationProof } : {}),
    shown_product_urls: urls,
  };
}

/**
 * `row` must be fetched by the server from chat_request_logs after the durable
 * terminal UPDATE. `continuationApproved` and `continuationKind` come from
 * server-owned boundary/classifier decisions, never browser slots. This
 * function cannot itself prove the row's DB provenance and must not be called
 * with parsed request JSON.
 */
export function advanceServerSelectionSnapshot(input: {
  previous: unknown;
  row: CompletedSelectionLogRow;
  topicId: string;
  continuationApproved: boolean;
  continuationKind: "none" | "evidence" | "additional";
  now?: number;
}): ServerSelectionSnapshot {
  const { row, topicId, continuationApproved, continuationKind } = input;
  const now = input.now ?? Date.now();
  if (
    !UUID.test(topicId) || row.chat_v3_topic_id !== topicId ||
    typeof row.created_at !== "string"
  ) {
    throw new Error("selection_topic_binding_mismatch");
  }
  const createdAt = Date.parse(row.created_at);
  if (
    !Number.isFinite(createdAt) || createdAt > now + 60_000 ||
    now - createdAt > MAX_SELECTION_AGE_MS
  ) {
    throw new Error("invalid_selection_log_time");
  }
  const events = completedEvents(row);
  const explicitNewTopic = events.some((event) => {
    const item = record(event);
    return item?.type === "conversation_boundary" &&
      item.mode === "new_task";
  });
  const dependent = continuationApproved && continuationKind !== "none";
  const previous = continuationApproved && dependent && !explicitNewTopic
    ? priorSelection(input.previous, topicId, now)
    : null;
  const baseRequest = previous?.base_request ?? row.user_query as string;
  const current = currentSelection(
    events,
    baseRequest,
    row.id as string,
    row.created_at,
  );
  const hasProductBlocks = events.some((event) =>
    record(event)?.type === "products_block"
  );
  let selection: ServerSelectionContinuation | null = null;
  if (current) {
    if (dependent) {
      // "Other options" is not a standalone search contract. Preserve the
      // base only when a fresh server render carries the exact same frozen
      // criteria and, for measured replacement, independently proves every
      // newly displayed card. The same applies to evidence turns with cards.
      if (
        previous && current.selection_hash === previous.selection_hash &&
        JSON.stringify(current.mandatory_criteria) ===
          JSON.stringify(previous.mandatory_criteria) &&
        !current.shown_product_urls.some((url) =>
          previous.shown_product_urls.includes(url)
        ) &&
        Boolean(current.destination_fit_proof) ===
          Boolean(previous.destination_fit_proof)
      ) {
        const oldProof = previous.destination_fit_proof;
        const newProof = current.destination_fit_proof;
        const combinedUrls = [
          ...new Set([
            ...previous.shown_product_urls,
            ...current.shown_product_urls,
          ]),
        ];
        const proofCompatible = !oldProof || !newProof || (
          oldProof.place === newProof.place &&
          oldProof.minimum_area_m2 === newProof.minimum_area_m2 &&
          oldProof.customer_request === newProof.customer_request &&
          !newProof.rendered_cards.some((card) =>
            oldProof.rendered_cards.some((oldCard) =>
              oldCard.url === card.url && oldCard.id !== card.id
            )
          )
        );
        const combinedCards = oldProof && newProof
          ? [...oldProof.rendered_cards, ...newProof.rendered_cards]
            .filter((card, index, cards) =>
              cards.findIndex((other) => other.url === card.url) === index
            )
          : [];
        const combinedProof = oldProof && newProof
          ? { ...oldProof, rendered_cards: combinedCards }
          : null;
        if (
          proofCompatible && combinedUrls.length <= MAX_URLS &&
          (!combinedProof || parsedDestinationFitProof(
            combinedProof,
            previous.base_request,
            previous.selection_hash,
            combinedUrls,
          ))
        ) {
          selection = {
            ...previous,
            shown_product_urls: combinedUrls,
            ...(combinedProof ? { destination_fit_proof: combinedProof } : {}),
          };
        }
      }
    } else {
      selection = current;
    }
  } else if (dependent && !hasProductBlocks) {
    // A rendered but malformed block must not be silently ignored while the
    // old selection continues; no-card informational turns may preserve it.
    selection = previous;
  }
  return boundedServerSnapshot({
    source_log_id: row.id,
    topic_id: topicId,
    selection,
  }) as unknown as ServerSelectionSnapshot;
}

/** Build the state proposed to atomic finish, before that RPC commits the
 * terminal log and state together. This is intentionally stricter than the
 * durable projector: every displayed block must be re-certified against its
 * exact renderer output, even when no measured-destination proof is needed.
 * The pure function cannot establish database provenance; its caller must
 * have obtained `claim` with service role after a successful atomic begin. */
export function prepareServerSelectionSnapshotForAtomicFinish(
  input: PrecommitSelectionSnapshotInput,
): ServerSelectionSnapshot | null {
  if (input.mode === "off") return null;
  const {
    claim,
    topicId,
    responseEvents,
    egressProofs,
    continuationApproved,
    continuationKind,
  } = input;
  if (
    !record(claim) ||
    Object.keys(claim).sort().join(",") !==
      "chat_v3_topic_id,created_at,error,id,pipeline,provenance,session_id,user_query" ||
    claim.provenance !== "server_atomic_claim_v1" ||
    claim.pipeline !== "v3" || claim.error !== "in_progress" ||
    !UUID.test(claim.id) || !UUID.test(claim.chat_v3_topic_id) ||
    claim.chat_v3_topic_id !== topicId ||
    typeof claim.session_id !== "string" ||
    claim.session_id.length < 1 || claim.session_id.length > 128 ||
    !SESSION_ID.test(claim.session_id) ||
    typeof claim.user_query !== "string" ||
    !claim.user_query.trim() || claim.user_query !== claim.user_query.trim() ||
    claim.user_query.length > 2_000 ||
    typeof claim.created_at !== "string" ||
    !Array.isArray(responseEvents) || !Array.isArray(egressProofs)
  ) throw new Error("invalid_server_selection_claim");

  // The claimed row is still in_progress. A synthetic successful row is
  // valid only as a proposed atomic-finish payload, never as a durable read.
  const proposedRow: CompletedSelectionLogRow = {
    id: claim.id,
    chat_v3_topic_id: claim.chat_v3_topic_id,
    pipeline: claim.pipeline,
    user_query: claim.user_query,
    error: null,
    created_at: claim.created_at,
    response_events: [...responseEvents],
  };
  const events = completedEvents(proposedRow);
  for (let index = 0; index < events.length - 1; index++) {
    const event = record(events[index]);
    if (
      event?.type === "done" ||
      (index < events.length - 2 && event?.type === "diagnostic" &&
        event.phase === "complete")
    ) throw new Error("early_selection_terminal_event");
  }

  const now = input.now ?? Date.now();
  const explicitNewTopic = events.some((event) => {
    const item = record(event);
    return item?.type === "conversation_boundary" && item.mode === "new_task";
  });
  const dependent = continuationApproved && continuationKind !== "none";
  const previous = dependent && !explicitNewTopic
    ? priorSelection(input.previous, topicId, now)
    : null;
  const baseRequest = previous?.base_request ?? claim.user_query;
  const blocks = events.filter((event) =>
    record(event)?.type === "products_block"
  );
  if (blocks.length !== egressProofs.length) {
    throw new Error("selection_egress_proof_count_mismatch");
  }
  for (let index = 0; index < blocks.length; index++) {
    const proof = egressProofs[index];
    const displayedProducts: unknown = proof?.displayedProducts;
    if (
      !proof || !Array.isArray(displayedProducts) ||
      displayedProducts.length === 0 ||
      !record(proof.internalEvent) || !record(proof.publicEvent) ||
      JSON.stringify(blocks[index]) !== JSON.stringify(proof.internalEvent)
    ) throw new Error("invalid_selection_egress_proof");
    const ids = proof.displayedProducts.map((product: ProductFull) =>
      product.id
    );
    const cache: ProductCache = new Map(
      proof.displayedProducts.map((
        product: ProductFull,
      ) => [product.id, product]),
    );
    const certified = buildConversationEgressProof({
      event: proof.publicEvent,
      cache,
      baseRequest,
      selectionHash: proof.publicEvent.selection_contract?.hash ?? "",
      requestedIds: ids,
    });
    if (
      !certified ||
      JSON.stringify(certified.publicEvent) !==
        JSON.stringify(proof.publicEvent) ||
      JSON.stringify(certified.internalEvent) !==
        JSON.stringify(proof.internalEvent)
    ) throw new Error("invalid_selection_egress_proof");
  }
  return advanceServerSelectionSnapshot({
    previous: input.previous,
    row: proposedRow,
    topicId,
    continuationApproved,
    continuationKind,
    now,
  });
}
