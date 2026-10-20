/**
 * Default-off, service-only conversation-state gateway. The browser holds a
 * 32-byte random bearer; PostgreSQL sees only SHA-256(raw bytes) in hex.
 *
 * This module is intentionally NOT imported by index.ts. A later guarded
 * integration must construct snapshots exclusively from server-owned search,
 * completion and catalog evidence, never from browser history or slots. Do
 * not add bearer values to chat_request_logs, request diagnostics or console.
 */

export type ConversationStateMode = "off" | "on";
export type ConversationStateRpcName =
  | "create_chat_v3_conversation"
  | "resolve_chat_v3_conversation"
  | "begin_chat_v3_conversation_turn"
  | "finalize_chat_v3_conversation_turn"
  | "abort_chat_v3_conversation_turn"
  | "rotate_chat_v3_conversation_topic"
  | "claim_and_begin_chat_v3_conversation_turn"
  | "finish_chat_v3_conversation_turn";

export type ConversationStateRpc = (
  name: ConversationStateRpcName,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error?: unknown }>;

export type ConversationStateResult = {
  status: string;
  [key: string]: unknown;
};

export type CreatedConversation = ConversationStateResult & {
  status: "created";
  /** Secret. Return to the browser only through the intended response path. */
  bearer: string;
};
export type RotatedConversation = ConversationStateResult & {
  status: "rotated";
  bearer: string;
};

/** Only a `begun` result authorizes paid work. `recovered: true` is the
 * same Edge invocation retrying its one server-generated log ID after an
 * ambiguous transport response; `turn_in_progress` is a competing call. */
export type AtomicClaimResult =
  | {
    status: "begun";
    recovered: boolean;
    log_id: string;
    topic_id: string;
    version: number;
    fence: number;
    state: Record<string, unknown>;
  }
  | {
    status: "turn_in_progress";
    replayed: true;
    log_id: string;
    topic_id: string;
  }
  | {
    status: "finalized" | "failed";
    replayed: true;
    log_id: string;
    topic_id: string;
    version: number;
  }
  | { status: "stale_version"; version: number }
  | { status: "stale_turn"; log_id: string; topic_id: string }
  | {
    status:
      | "disabled"
      | "invalid_input"
      | "unavailable"
      | "not_found"
      | "inactive"
      | "turn_limit"
      | "busy"
      | "log_id_conflict"
      | "message_conflict"
      | "invalid_claim";
  };

export interface AtomicClaimInput {
  bearer: string;
  expectedVersion: number;
  sessionId: string;
  messageId: string;
  userQuery: string;
  /** Server-generated, JSON-only initial diagnostic steps. */
  steps: unknown;
}

export type AtomicFinishResult =
  | {
    status: "finalized" | "failed";
    replayed: boolean;
    topic_id: string;
    version: number;
  }
  | {
    status:
      | "disabled"
      | "invalid_input"
      | "invalid_events"
      | "invalid_state"
      | "unavailable"
      | "not_found"
      | "not_begun"
      | "stale_turn"
      | "invalid_claim"
      | "conflicting_replay";
  };

export interface AtomicFinishInput {
  bearer: string;
  /** Must be a begun log ID returned by this gateway, not the browser. */
  logId: string;
  topicId: string;
  fence: number;
  expectedVersion: number;
  outcome: "success" | "failure";
  responseEvents: unknown;
  /** Only a successful turn may advance this server-owned state. */
  state: unknown;
  steps: unknown;
  finalResponse: string;
  finalProductsCount: number;
  totalMs: number;
  error: string | null;
}

const HEX_256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MESSAGE_ID =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|msg_[0-9]{13}_[a-z0-9]{8})$/iu;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
// Operational hard cap is effectively unreachable within the 24-hour TTL;
// ordinary long conversations must not hit a 64-turn limit.
const MAX_TURNS = 1_000_000_000;
const MAX_STATE_BYTES = 16_384;
const MAX_STATE_DEPTH = 8;
const MAX_STATE_NODES = 1_000;
const MAX_STATE_STRING = 4_096;
const FORBIDDEN_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "token",
  "bearer",
  "authorization",
  "cookie",
  "password",
  "secret",
  "api_key",
  "history",
  "client_history",
  "browser_state",
  "local_storage",
  "session_storage",
  "slots",
]);

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  const result = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    result[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return result;
}

/** No timestamp, Math.random, UUID truncation or fallback entropy. */
export function createConversationBearer(
  random: Pick<Crypto, "getRandomValues"> = globalThis.crypto,
): string {
  if (!random?.getRandomValues) throw new Error("secure_rng_unavailable");
  return bytesToHex(random.getRandomValues(new Uint8Array(32)));
}

export async function digestConversationBearer(
  bearer: string,
  subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle,
): Promise<string> {
  if (!HEX_256.test(bearer)) throw new Error("invalid_conversation_bearer");
  if (!subtle?.digest) throw new Error("sha256_unavailable");
  const digest = await subtle.digest("SHA-256", hexToBytes(bearer));
  return bytesToHex(new Uint8Array(digest));
}

/** Bounded, JSON-only value. Structural checks do NOT prove provenance: the
 * future integration must supply a typed snapshot assembled from server
 * evidence, never pass arbitrary browser history/slots to this function. */
export function boundedServerSnapshot(
  value: unknown,
  bearerToExclude?: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid_conversation_state");
  }
  let nodes = 0;
  const visit = (entry: unknown, depth: number): void => {
    nodes++;
    if (nodes > MAX_STATE_NODES || depth > MAX_STATE_DEPTH) {
      throw new Error("conversation_state_too_complex");
    }
    if (entry === null || typeof entry === "boolean") return;
    if (typeof entry === "string") {
      if (entry.length > MAX_STATE_STRING) {
        throw new Error("conversation_state_string_too_long");
      }
      if (bearerToExclude && entry.includes(bearerToExclude)) {
        throw new Error("conversation_bearer_in_state");
      }
      return;
    }
    if (typeof entry === "number" && Number.isFinite(entry)) return;
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item, depth + 1);
      return;
    }
    if (
      typeof entry !== "object" ||
      Object.getPrototypeOf(entry) !== Object.prototype
    ) {
      throw new Error("invalid_conversation_state_value");
    }
    for (const [key, item] of Object.entries(entry)) {
      if (
        key.length > 128 || FORBIDDEN_KEYS.has(key.toLowerCase()) ||
        (bearerToExclude && key.includes(bearerToExclude))
      ) {
        throw new Error("forbidden_conversation_state_key");
      }
      visit(item, depth + 1);
    }
  };
  visit(value, 0);
  const encoded = JSON.stringify(value);
  if (new TextEncoder().encode(encoded).length > MAX_STATE_BYTES) {
    throw new Error("conversation_state_too_large");
  }
  return JSON.parse(encoded) as Record<string, unknown>;
}

function invalid(): ConversationStateResult {
  return { status: "invalid_input" };
}

function validVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 &&
    (value as number) <= MAX_TURNS;
}

function validPositiveFence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 &&
    (value as number) <= MAX_TURNS;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** A strict JSON copy prevents functions, cycles, custom prototypes, bearer
 * strings and credentials from being silently persisted in replay events. */
function boundedRpcArray(
  value: unknown,
  maxItems: number,
  maxBytes: number,
  bearer: string,
): unknown[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const seen = new Set<object>();
  let nodes = 0;
  let approximateBytes = 0;
  const privateKeys = new Set([
    "token",
    "bearer",
    "authorization",
    "cookie",
    "password",
    "secret",
    "api_key",
    "__proto__",
    "constructor",
    "prototype",
  ]);
  const visit = (entry: unknown, depth: number): boolean => {
    nodes++;
    if (nodes > 10_000 || depth > 16) return false;
    approximateBytes += 2;
    if (approximateBytes > maxBytes) return false;
    if (entry === null || typeof entry === "boolean") return true;
    if (typeof entry === "number") return Number.isFinite(entry);
    if (typeof entry === "string") {
      approximateBytes += utf8Bytes(entry);
      return approximateBytes <= maxBytes && entry.length <= 65_536 &&
        !entry.includes(bearer);
    }
    if (!entry || typeof entry !== "object" || seen.has(entry)) return false;
    if (
      !Array.isArray(entry) && Object.getPrototypeOf(entry) !== Object.prototype
    ) {
      return false;
    }
    seen.add(entry);
    const valid = Array.isArray(entry)
      ? entry.every((item) => visit(item, depth + 1))
      : Object.entries(entry).every(([key, item]) => {
        approximateBytes += utf8Bytes(key);
        return approximateBytes <= maxBytes && key.length <= 128 &&
          !key.includes(bearer) && !privateKeys.has(key.toLowerCase()) &&
          visit(item, depth + 1);
      });
    seen.delete(entry);
    return valid;
  };
  if (!visit(value, 0)) return null;
  const encoded = JSON.stringify(value);
  if (utf8Bytes(encoded) > maxBytes) return null;
  return JSON.parse(encoded) as unknown[];
}

function parsedAtomicClaimResult(
  result: Record<string, unknown>,
): ConversationStateResult {
  const { status } = result;
  if (status === "begun") {
    if (
      typeof result.recovered !== "boolean" ||
      typeof result.log_id !== "string" || !UUID.test(result.log_id) ||
      typeof result.topic_id !== "string" || !UUID.test(result.topic_id) ||
      !validVersion(result.version) || !validPositiveFence(result.fence)
    ) {
      return { status: "unavailable" };
    }
    try {
      return {
        status,
        recovered: result.recovered,
        log_id: result.log_id,
        topic_id: result.topic_id,
        version: result.version,
        fence: result.fence,
        state: boundedServerSnapshot(result.state),
      };
    } catch {
      return { status: "unavailable" };
    }
  }
  if (
    status === "turn_in_progress" || status === "finalized" ||
    status === "failed" || status === "stale_turn"
  ) {
    if (
      typeof result.log_id !== "string" || !UUID.test(result.log_id) ||
      typeof result.topic_id !== "string" || !UUID.test(result.topic_id)
    ) {
      return { status: "unavailable" };
    }
    if (status === "stale_turn") {
      return { status, log_id: result.log_id, topic_id: result.topic_id };
    }
    if (result.replayed !== true) return { status: "unavailable" };
    if (status === "turn_in_progress") {
      return {
        status,
        replayed: true,
        log_id: result.log_id,
        topic_id: result.topic_id,
      };
    }
    if (!validVersion(result.version)) return { status: "unavailable" };
    return {
      status,
      replayed: true,
      log_id: result.log_id,
      topic_id: result.topic_id,
      version: result.version,
    };
  }
  if (status === "stale_version") {
    return validVersion(result.version)
      ? { status, version: result.version }
      : { status: "unavailable" };
  }
  if (
    [
      "invalid_input",
      "not_found",
      "inactive",
      "turn_limit",
      "busy",
      "log_id_conflict",
      "message_conflict",
      "invalid_claim",
    ].includes(
      String(status),
    )
  ) return { status: status as string };
  return { status: "unavailable" };
}

function parsedAtomicFinishResult(
  result: Record<string, unknown>,
): ConversationStateResult {
  const { status } = result;
  if (status === "finalized" || status === "failed") {
    if (
      typeof result.replayed !== "boolean" ||
      typeof result.topic_id !== "string" || !UUID.test(result.topic_id) ||
      !validVersion(result.version)
    ) return { status: "unavailable" };
    return {
      status,
      replayed: result.replayed,
      topic_id: result.topic_id,
      version: result.version,
    };
  }
  if (
    [
      "invalid_input",
      "invalid_events",
      "invalid_state",
      "not_found",
      "not_begun",
      "stale_turn",
      "invalid_claim",
      "conflicting_replay",
    ].includes(
      String(status),
    )
  ) return { status: status as string };
  return { status: "unavailable" };
}

function parsedResult(
  name: ConversationStateRpcName,
  data: unknown,
): ConversationStateResult {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { status: "unavailable" };
  }
  const result = data as Record<string, unknown>;
  if (typeof result.status !== "string" || result.status.length > 40) {
    return { status: "unavailable" };
  }
  if (name === "claim_and_begin_chat_v3_conversation_turn") {
    return parsedAtomicClaimResult(result);
  }
  if (name === "finish_chat_v3_conversation_turn") {
    return parsedAtomicFinishResult(result);
  }
  const validStatus: Record<ConversationStateRpcName, ReadonlySet<string>> = {
    create_chat_v3_conversation: new Set([
      "created",
      "invalid_digest",
      "digest_conflict",
    ]),
    resolve_chat_v3_conversation: new Set([
      "resolved",
      "invalid_digest",
      "not_found",
    ]),
    begin_chat_v3_conversation_turn: new Set([
      "begun",
      "turn_in_progress",
      "finalized",
      "stale_turn",
      "stale_version",
      "turn_limit",
      "busy",
      "invalid_claim",
      "unbound_claim",
      "log_already_bound",
      "not_found",
      "inactive",
      "invalid_input",
    ]),
    finalize_chat_v3_conversation_turn: new Set([
      "finalized",
      "conflicting_replay",
      "stale_turn",
      "not_begun",
      "claim_not_successful",
      "invalid_input",
      "not_found",
    ]),
    abort_chat_v3_conversation_turn: new Set([
      "aborted",
      "stale_turn",
      "not_begun",
      "invalid_input",
      "not_found",
    ]),
    rotate_chat_v3_conversation_topic: new Set([
      "rotated",
      "inactive",
      "stale_version",
      "busy",
      "topic_limit",
      "invalid_input",
      "not_found",
    ]),
    claim_and_begin_chat_v3_conversation_turn: new Set(),
    finish_chat_v3_conversation_turn: new Set(),
  };
  if (!validStatus[name].has(result.status)) return { status: "unavailable" };
  if (result.status === "created" || result.status === "rotated") {
    if (
      typeof result.topic_id !== "string" || !UUID.test(result.topic_id) ||
      typeof result.root_id !== "string" || !UUID.test(result.root_id) ||
      !validVersion(result.version) ||
      typeof result.expires_at !== "string"
    ) {
      return { status: "unavailable" };
    }
  }
  if (
    result.status === "resolved" &&
    (typeof result.topic_id !== "string" || !UUID.test(result.topic_id) ||
      !validVersion(result.version))
  ) {
    return { status: "unavailable" };
  }
  if (result.status === "begun") {
    if (
      result.replayed !== false ||
      typeof result.topic_id !== "string" || !UUID.test(result.topic_id) ||
      !validVersion(result.version) ||
      !Number.isSafeInteger(result.fence) ||
      (result.fence as number) < 1 || (result.fence as number) > MAX_TURNS
    ) {
      return { status: "unavailable" };
    }
    try {
      boundedServerSnapshot(result.state);
    } catch {
      return { status: "unavailable" };
    }
  }
  return result as ConversationStateResult;
}

export class ConversationStateGateway {
  private readonly rpc: ConversationStateRpc;
  private readonly mode: ConversationStateMode;
  /** An atomic finish may use only a begin granted by this server instance. */
  private readonly atomicBegun = new Map<string, {
    tokenDigest: string;
    topicId: string;
    fence: number;
    expectedVersion: number;
    finishPayload?: string;
  }>();

  constructor(
    rpc: ConversationStateRpc,
    /** Deliberately off unless the server explicitly opts in. */
    mode: ConversationStateMode = "off",
  ) {
    this.rpc = rpc;
    this.mode = mode;
  }

  private async call(
    name: ConversationStateRpcName,
    args: Record<string, unknown>,
  ): Promise<ConversationStateResult> {
    if (this.mode !== "on") return { status: "disabled" };
    try {
      const { data, error } = await this.rpc(name, args);
      return error ? { status: "unavailable" } : parsedResult(name, data);
    } catch {
      // Never stringify an RPC error: headers/transport errors may carry the
      // bearer if a future caller accidentally includes it in a URL.
      return { status: "unavailable" };
    }
  }

  async create(): Promise<ConversationStateResult | CreatedConversation> {
    if (this.mode !== "on") return { status: "disabled" };
    const bearer = createConversationBearer();
    const digest = await digestConversationBearer(bearer);
    const args = { p_token_digest: digest };
    let result = await this.call("create_chat_v3_conversation", args);
    if (result.status === "unavailable") {
      // Same digest: a committed first call is recognized by the SQL RPC.
      result = await this.call("create_chat_v3_conversation", args);
    }
    return result.status === "created" ? { ...result, bearer } : result;
  }

  /** Resolve before creating the unique message-id log claim. The returned
   * topic_id must be written by the server into that NEW log INSERT; begin
   * refuses old/replayed/unbound logs. Never accept a client-supplied ID. */
  async resolve(bearer: string): Promise<ConversationStateResult> {
    if (this.mode !== "on") return { status: "disabled" };
    if (!HEX_256.test(bearer)) return invalid();
    return this.call("resolve_chat_v3_conversation", {
      p_token_digest: await digestConversationBearer(bearer),
    });
  }

  /** Atomically create the replay log and acquire the turn lease. The log ID
   * is generated here, never accepted from a browser request. Only this one
   * invocation may retry its own ID after an ambiguous transport response.
   * A `begun` result (including recovered=true) authorizes one worker; a
   * competing `turn_in_progress` or any other status does not. */
  async claimAndBegin(input: AtomicClaimInput): Promise<AtomicClaimResult> {
    if (this.mode !== "on") return { status: "disabled" };
    const { bearer, expectedVersion, sessionId, messageId, userQuery } = input;
    if (
      !HEX_256.test(bearer) || !validVersion(expectedVersion) ||
      expectedVersion >= MAX_TURNS ||
      typeof sessionId !== "string" || sessionId.length < 1 ||
      sessionId.length > 128 || !SESSION_ID.test(sessionId) ||
      typeof messageId !== "string" || !MESSAGE_ID.test(messageId) ||
      typeof userQuery !== "string" || userQuery.length < 1 ||
      userQuery.length > 2_000 || userQuery.trim() !== userQuery ||
      userQuery.includes(bearer)
    ) {
      return { status: "invalid_input" };
    }
    const steps = boundedRpcArray(input.steps, 128, 32_000, bearer);
    if (!steps) return { status: "invalid_input" };
    if (!globalThis.crypto?.randomUUID) return { status: "unavailable" };
    const logId = globalThis.crypto.randomUUID();
    const tokenDigest = await digestConversationBearer(bearer);
    const args = {
      p_token_digest: tokenDigest,
      p_log_id: logId,
      p_expected_version: expectedVersion,
      p_session_id: sessionId,
      p_message_id: messageId,
      p_user_query: userQuery,
      p_steps: steps,
    };
    let result = await this.call(
      "claim_and_begin_chat_v3_conversation_turn",
      args,
    );
    if (result.status === "unavailable") {
      // A committed first RPC comes back as begun/recovered=true. A new ID
      // here would be a competing worker and could not resolve ambiguity.
      result = await this.call(
        "claim_and_begin_chat_v3_conversation_turn",
        args,
      );
    }
    if (result.status === "begun") {
      if (
        result.log_id !== logId || result.version !== expectedVersion ||
        (Object.keys(result.state as object).length > 0 &&
          (result.state as Record<string, unknown>).topic_id !==
            result.topic_id)
      ) {
        return { status: "unavailable" };
      }
      try {
        boundedServerSnapshot(result.state, bearer);
      } catch {
        return { status: "unavailable" };
      }
      this.atomicBegun.set(logId, {
        tokenDigest,
        topicId: result.topic_id as string,
        fence: result.fence as number,
        expectedVersion,
      });
    }
    return result as AtomicClaimResult;
  }

  /** Commit the terminal replay protocol and the selection state together.
   * Do not emit `done` on the live SSE stream until this returns finalized or
   * failed. A failure response never advances conversation version. */
  async finishAtomic(input: AtomicFinishInput): Promise<AtomicFinishResult> {
    if (this.mode !== "on") return { status: "disabled" };
    const {
      bearer,
      logId,
      topicId,
      fence,
      expectedVersion,
      outcome,
      finalResponse,
      finalProductsCount,
      totalMs,
      error,
    } = input;
    if (
      !HEX_256.test(bearer) || !UUID.test(logId) || !UUID.test(topicId) ||
      !validPositiveFence(fence) || !validVersion(expectedVersion) ||
      expectedVersion >= MAX_TURNS ||
      (outcome !== "success" && outcome !== "failure") ||
      typeof finalResponse !== "string" ||
      utf8Bytes(finalResponse) > 65_536 || finalResponse.includes(bearer) ||
      !Number.isSafeInteger(finalProductsCount) || finalProductsCount < 0 ||
      finalProductsCount > 100 || !Number.isSafeInteger(totalMs) ||
      totalMs < 0 || totalMs > 900_000
    ) return { status: "invalid_input" };
    const ticket = this.atomicBegun.get(logId);
    if (
      !ticket || ticket.topicId !== topicId || ticket.fence !== fence ||
      ticket.expectedVersion !== expectedVersion ||
      ticket.tokenDigest !== await digestConversationBearer(bearer)
    ) {
      return { status: "invalid_input" };
    }
    const responseEvents = boundedRpcArray(
      input.responseEvents,
      256,
      250_000,
      bearer,
    );
    const steps = boundedRpcArray(input.steps, 1_024, 60_000, bearer);
    if (!responseEvents || responseEvents.length < 2 || !steps) {
      return { status: "invalid_input" };
    }
    const last = responseEvents.at(-1);
    const complete = responseEvents.at(-2);
    if (
      !last || typeof last !== "object" || Array.isArray(last) ||
      JSON.stringify(last) !== '{"type":"done"}' ||
      !complete || typeof complete !== "object" ||
      Array.isArray(complete)
    ) return { status: "invalid_events" };
    const diagnostic = complete as Record<string, unknown>;
    if (
      diagnostic.type !== "diagnostic" ||
      diagnostic.phase !== "complete" || diagnostic.log_id !== logId ||
      diagnostic.products_count !== finalProductsCount ||
      !("error" in diagnostic) ||
      responseEvents.slice(0, -1).some((event, index) => {
        if (!event || typeof event !== "object" || Array.isArray(event)) {
          return false;
        }
        const item = event as Record<string, unknown>;
        return item.type === "done" || (index < responseEvents.length - 2 &&
          item.type === "diagnostic" && item.phase === "complete");
      })
    ) return { status: "invalid_events" };
    let state: Record<string, unknown> | null = null;
    if (outcome === "success") {
      if (error !== null || diagnostic.error !== null) {
        return { status: "invalid_input" };
      }
      try {
        state = boundedServerSnapshot(input.state, bearer);
      } catch {
        return { status: "invalid_state" };
      }
      if (
        state.source_log_id !== logId || state.topic_id !== topicId ||
        !("selection" in state) ||
        (state.selection !== null &&
          (typeof state.selection !== "object" ||
            Array.isArray(state.selection))) ||
        Object.keys(state).some((key) =>
          !["source_log_id", "topic_id", "selection"].includes(key)
        )
      ) return { status: "invalid_state" };
    } else if (
      input.state !== null || typeof error !== "string" ||
      error.length < 1 || utf8Bytes(error) > 2_048 ||
      error === "in_progress" || error.includes(bearer) ||
      diagnostic.error !== error
    ) {
      return { status: "invalid_input" };
    }
    const args = {
      p_token_digest: ticket.tokenDigest,
      p_log_id: logId,
      p_fence: fence,
      p_expected_version: expectedVersion,
      p_outcome: outcome,
      p_response_events: responseEvents,
      p_state: state,
      p_steps: steps,
      p_final_response: finalResponse,
      p_final_products_count: finalProductsCount,
      p_total_ms: totalMs,
      p_error: error,
    };
    const payload = JSON.stringify(args);
    if (ticket.finishPayload && ticket.finishPayload !== payload) {
      return { status: "conflicting_replay" };
    }
    ticket.finishPayload = payload;
    let result = await this.call("finish_chat_v3_conversation_turn", args);
    if (result.status === "unavailable") {
      result = await this.call("finish_chat_v3_conversation_turn", args);
    }
    if (
      (result.status === "finalized" || result.status === "failed") &&
      (result.topic_id !== topicId ||
        result.version !== expectedVersion + (outcome === "success" ? 1 : 0) ||
        result.status !== (outcome === "success" ? "finalized" : "failed"))
    ) {
      return { status: "unavailable" };
    }
    return result as AtomicFinishResult;
  }

  async begin(
    bearer: string,
    logId: string,
    expectedVersion: number,
  ): Promise<ConversationStateResult> {
    if (this.mode !== "on") return { status: "disabled" };
    if (
      !HEX_256.test(bearer) || !UUID.test(logId) ||
      !Number.isSafeInteger(expectedVersion) ||
      expectedVersion < 0 || expectedVersion > MAX_TURNS
    ) return invalid();
    return this.call("begin_chat_v3_conversation_turn", {
      p_token_digest: await digestConversationBearer(bearer),
      p_log_id: logId,
      p_expected_version: expectedVersion,
    });
  }

  async finalize(
    bearer: string,
    logId: string,
    fence: number,
    expectedVersion: number,
    serverState: unknown,
  ): Promise<ConversationStateResult> {
    if (this.mode !== "on") return { status: "disabled" };
    if (
      !HEX_256.test(bearer) || !UUID.test(logId) ||
      !Number.isSafeInteger(fence) || fence < 1 || fence > MAX_TURNS ||
      !Number.isSafeInteger(expectedVersion) ||
      expectedVersion < 0 || expectedVersion >= MAX_TURNS
    ) return invalid();
    const state = boundedServerSnapshot(serverState, bearer);
    if (state.source_log_id !== logId) return invalid();
    return this.call("finalize_chat_v3_conversation_turn", {
      p_token_digest: await digestConversationBearer(bearer),
      p_log_id: logId,
      p_fence: fence,
      p_expected_version: expectedVersion,
      p_state: state,
    });
  }

  async abort(
    bearer: string,
    logId: string,
    fence: number,
  ): Promise<ConversationStateResult> {
    if (this.mode !== "on") return { status: "disabled" };
    if (
      !HEX_256.test(bearer) || !UUID.test(logId) ||
      !Number.isSafeInteger(fence) || fence < 1 || fence > MAX_TURNS
    ) return invalid();
    return this.call("abort_chat_v3_conversation_turn", {
      p_token_digest: await digestConversationBearer(bearer),
      p_log_id: logId,
      p_fence: fence,
    });
  }

  async rotate(
    bearer: string,
    expectedVersion: number,
  ): Promise<ConversationStateResult | RotatedConversation> {
    if (this.mode !== "on") return { status: "disabled" };
    if (
      !HEX_256.test(bearer) ||
      !Number.isSafeInteger(expectedVersion) ||
      expectedVersion < 0 || expectedVersion > MAX_TURNS
    ) return invalid();
    const nextBearer = createConversationBearer();
    const args = {
      p_token_digest: await digestConversationBearer(bearer),
      p_new_token_digest: await digestConversationBearer(nextBearer),
      p_expected_version: expectedVersion,
    };
    let result = await this.call("rotate_chat_v3_conversation_topic", args);
    if (result.status === "unavailable") {
      result = await this.call("rotate_chat_v3_conversation_topic", args);
    }
    return result.status === "rotated"
      ? { ...result, bearer: nextBearer }
      : result;
  }
}
