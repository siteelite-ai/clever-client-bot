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
  | "rotate_chat_v3_conversation_topic";

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

const HEX_256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
// Operational hard cap is effectively unreachable within the 24-hour TTL;
// ordinary long conversations must not hit a 64-turn limit.
const MAX_TURNS = 1_000_000_000;
const MAX_STATE_BYTES = 16_384;
const MAX_STATE_DEPTH = 8;
const MAX_STATE_NODES = 1_000;
const MAX_STATE_STRING = 4_096;
const FORBIDDEN_KEYS = new Set([
  "__proto__", "constructor", "prototype", "token", "bearer",
  "authorization", "cookie", "password", "secret", "api_key",
  "history", "client_history", "browser_state", "local_storage",
  "session_storage", "slots",
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
    if (typeof entry !== "object" || Object.getPrototypeOf(entry) !== Object.prototype) {
      throw new Error("invalid_conversation_state_value");
    }
    for (const [key, item] of Object.entries(entry)) {
      if (key.length > 128 || FORBIDDEN_KEYS.has(key.toLowerCase()) ||
        (bearerToExclude && key.includes(bearerToExclude))) {
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
  const validStatus: Record<ConversationStateRpcName, ReadonlySet<string>> = {
    create_chat_v3_conversation: new Set([
      "created", "invalid_digest", "digest_conflict",
    ]),
    resolve_chat_v3_conversation: new Set([
      "resolved", "invalid_digest", "not_found",
    ]),
    begin_chat_v3_conversation_turn: new Set([
      "begun", "turn_in_progress", "finalized", "stale_turn",
      "stale_version", "turn_limit", "busy", "invalid_claim",
      "unbound_claim", "log_already_bound", "not_found", "inactive",
      "invalid_input",
    ]),
    finalize_chat_v3_conversation_turn: new Set([
      "finalized", "conflicting_replay", "stale_turn", "not_begun",
      "claim_not_successful", "invalid_input", "not_found",
    ]),
    abort_chat_v3_conversation_turn: new Set([
      "aborted", "stale_turn", "not_begun", "invalid_input", "not_found",
    ]),
    rotate_chat_v3_conversation_topic: new Set([
      "rotated", "inactive", "stale_version", "busy", "topic_limit",
      "invalid_input", "not_found",
    ]),
  };
  if (!validStatus[name].has(result.status)) return { status: "unavailable" };
  if (result.status === "created" || result.status === "rotated") {
    if (typeof result.topic_id !== "string" || !UUID.test(result.topic_id) ||
      typeof result.root_id !== "string" || !UUID.test(result.root_id) ||
      !validVersion(result.version) ||
      typeof result.expires_at !== "string") {
      return { status: "unavailable" };
    }
  }
  if (result.status === "resolved" &&
    (typeof result.topic_id !== "string" || !UUID.test(result.topic_id) ||
      !validVersion(result.version))) {
    return { status: "unavailable" };
  }
  if (result.status === "begun") {
    if (result.replayed !== false ||
      typeof result.topic_id !== "string" || !UUID.test(result.topic_id) ||
      !validVersion(result.version) ||
      !Number.isSafeInteger(result.fence) ||
      (result.fence as number) < 1 || (result.fence as number) > MAX_TURNS) {
      return { status: "unavailable" };
    }
    try { boundedServerSnapshot(result.state); } catch {
      return { status: "unavailable" };
    }
  }
  return result as ConversationStateResult;
}

export class ConversationStateGateway {
  private readonly rpc: ConversationStateRpc;
  private readonly mode: ConversationStateMode;

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
    return result.status === "created"
      ? { ...result, bearer }
      : result;
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

  async begin(
    bearer: string,
    logId: string,
    expectedVersion: number,
  ): Promise<ConversationStateResult> {
    if (this.mode !== "on") return { status: "disabled" };
    if (!HEX_256.test(bearer) || !UUID.test(logId) ||
      !Number.isSafeInteger(expectedVersion) ||
      expectedVersion < 0 || expectedVersion > MAX_TURNS) return invalid();
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
    if (!HEX_256.test(bearer) || !UUID.test(logId) ||
      !Number.isSafeInteger(fence) || fence < 1 || fence > MAX_TURNS ||
      !Number.isSafeInteger(expectedVersion) ||
      expectedVersion < 0 || expectedVersion >= MAX_TURNS) return invalid();
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
    if (!HEX_256.test(bearer) || !UUID.test(logId) ||
      !Number.isSafeInteger(fence) || fence < 1 || fence > MAX_TURNS) return invalid();
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
    if (!HEX_256.test(bearer) ||
      !Number.isSafeInteger(expectedVersion) ||
      expectedVersion < 0 || expectedVersion > MAX_TURNS) return invalid();
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
