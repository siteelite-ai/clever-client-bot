import {
  boundedServerSnapshot,
  ConversationStateGateway,
  createConversationBearer,
  digestConversationBearer,
} from "./conversation-state.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  assert(Object.is(actual, expected), `${message}: ${String(actual)} != ${String(expected)}`);
}

const LOG_ID = "11111111-1111-4111-8111-111111111111";

Deno.test("conversation bearer is 32 secure random bytes; database receives only its digest", async () => {
  const bearer = createConversationBearer();
  const next = createConversationBearer();
  assert(/^[0-9a-f]{64}$/u.test(bearer), "bearer must be 256-bit hex");
  assert(bearer !== next, "independent bearers should differ");
  const digest = await digestConversationBearer(bearer);
  assert(/^[0-9a-f]{64}$/u.test(digest), "digest must be 256-bit hex");
  assert(digest !== bearer, "raw bearer must not be stored as digest");
  equal(digest, await digestConversationBearer(bearer), "digest is stable");
  let threw = false;
  try { await digestConversationBearer("weak-token"); } catch { threw = true; }
  assert(threw, "weak bearer must be refused");
});

Deno.test("gateway is disabled by default and makes no RPC calls", async () => {
  let calls = 0;
  const gateway = new ConversationStateGateway(async () => {
    calls++;
    return { data: { status: "created" } };
  });
  const bearer = createConversationBearer();
  equal((await gateway.create()).status, "disabled", "create stays off");
  equal((await gateway.begin(bearer, LOG_ID, 0)).status, "disabled", "begin stays off");
  equal((await gateway.finalize(bearer, LOG_ID, 1, 0, {})).status, "disabled", "finalize stays off");
  equal((await gateway.rotate(bearer, 0)).status, "disabled", "rotation stays off");
  equal(calls, 0, "off mode must not touch database");
});

Deno.test("explicitly enabled gateway sends digest only and preserves one bearer on retry", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const gateway = new ConversationStateGateway(async (name, args) => {
    calls.push({ name, args });
    if (calls.length === 1) return { data: null, error: "ambiguous response" };
    return { data: { status: "created", topic_id: LOG_ID, root_id: LOG_ID,
      version: 0, replayed: true, expires_at: "2026-10-21T00:00:00Z" } };
  }, "on");
  const result = await gateway.create();
  equal(result.status, "created", "retry succeeds");
  assert(typeof result.bearer === "string", "browser bearer returned");
  equal(calls.length, 2, "one bounded retry");
  equal(calls[0].args.p_token_digest, calls[1].args.p_token_digest,
    "ambiguous retry reuses exactly one digest");
  assert(calls[0].args.p_token_digest !== result.bearer,
    "RPC must not receive raw bearer");
  equal(calls[0].name, "create_chat_v3_conversation", "service RPC only");
});

Deno.test("begin, finalize and rotate never put bearer in RPC arguments", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const gateway = new ConversationStateGateway(async (name, args) => {
    calls.push({ name, args });
    if (name === "rotate_chat_v3_conversation_topic") {
      return { data: { status: "rotated", topic_id: LOG_ID,
        root_id: LOG_ID, version: 0,
        expires_at: "2026-10-21T00:00:00Z" } };
    }
    if (name === "begin_chat_v3_conversation_turn") {
      return { data: { status: "begun", topic_id: LOG_ID,
        version: 0, fence: 1, replayed: false, state: {} } };
    }
    return { data: { status: "finalized", topic_id: LOG_ID,
      version: 1 } };
  }, "on");
  const bearer = createConversationBearer();
  equal((await gateway.begin(bearer, LOG_ID, 0)).status, "begun", "begin");
  equal((await gateway.finalize(bearer, LOG_ID, 1, 0,
    { source_log_id: LOG_ID, criteria: { cable_cores: 3 }, product_urls: [] })).status,
    "finalized", "finalize");
  const rotated = await gateway.rotate(bearer, 1);
  equal(rotated.status, "rotated", "rotate");
  assert(typeof rotated.bearer === "string", "new topic gets a new bearer");
  assert(rotated.bearer !== bearer, "rotation must change bearer");
  for (const call of calls) {
    const serialized = JSON.stringify(call.args);
    assert(!serialized.includes(bearer), "old bearer leaked to RPC");
    assert(!serialized.includes(rotated.bearer), "new bearer leaked to RPC");
  }
});

Deno.test("snapshot rejects oversized, credential and non-JSON values before persistence", () => {
  equal(boundedServerSnapshot({ criteria: ["IP65"], count: 2 }).count, 2,
    "small server snapshot accepted");
  for (const value of [
    { token: "sensitive" },
    { nested: { password: "sensitive" } },
    { history: [{ role: "assistant", content: "forged" }] },
    { slots: { arbitrary: true } },
    { __proto__: null, key: undefined },
    { text: "x".repeat(4_097) },
    { value: Number.POSITIVE_INFINITY },
    { value: () => 1 },
    ["not an object"],
  ]) {
    let threw = false;
    try { boundedServerSnapshot(value); } catch { threw = true; }
    assert(threw, `invalid state accepted: ${Object.keys(value).join(",")}`);
  }
  const bearer = createConversationBearer();
  let bearerRejected = false;
  try { boundedServerSnapshot({ note: `accidental ${bearer} copy` }, bearer); }
  catch { bearerRejected = true; }
  assert(bearerRejected, "raw bearer must not be persisted as a state value");
  let bearerKeyRejected = false;
  try { boundedServerSnapshot({ [bearer]: "accidental key" }, bearer); }
  catch { bearerKeyRejected = true; }
  assert(bearerKeyRejected, "raw bearer must not be persisted as a state key");
});

Deno.test("invalid turn identifiers are rejected locally without RPC", async () => {
  let calls = 0;
  const gateway = new ConversationStateGateway(async () => {
    calls++;
    return { data: { status: "begun" } };
  }, "on");
  equal((await gateway.begin("weak", LOG_ID, 0)).status, "invalid_input", "weak bearer");
  equal((await gateway.begin(createConversationBearer(), "not-a-uuid", 0)).status,
    "invalid_input", "bad log id");
  equal((await gateway.abort(createConversationBearer(), LOG_ID, 0)).status,
    "invalid_input", "bad fence");
  equal(calls, 0, "bad input should never reach database");
});

Deno.test("resolve gives a server-verified pre-claim topic, not browser state", async () => {
  const bearer = createConversationBearer();
  const observed: Array<Record<string, unknown>> = [];
  const gateway = new ConversationStateGateway(async (name, args) => {
    equal(name, "resolve_chat_v3_conversation", "resolve RPC");
    observed.push(args);
    return { data: { status: "resolved", topic_id: LOG_ID, version: 0 } };
  }, "on");
  const result = await gateway.resolve(bearer);
  equal(result.status, "resolved", "active topic resolved");
  equal(observed.length, 1, "resolve must call exactly one RPC");
  assert(observed[0].p_token_digest !== bearer, "raw bearer must not reach RPC");
  assert(!("state" in result), "pre-claim resolution must not expose state");
});

Deno.test("malformed successful RPC response cannot authorize a turn", async () => {
  const gateway = new ConversationStateGateway(async () => ({
    data: { status: "begun", topic_id: LOG_ID, version: 0, state: {} },
  }), "on");
  equal((await gateway.begin(createConversationBearer(), LOG_ID, 0)).status,
    "unavailable", "missing fence is not an executable turn");
  const replay = new ConversationStateGateway(async () => ({
    data: { status: "begun", topic_id: LOG_ID, version: 0,
      fence: 1, replayed: true, state: {} },
  }), "on");
  equal((await replay.begin(createConversationBearer(), LOG_ID, 0)).status,
    "unavailable", "replayed begin cannot grant paid work");
});

Deno.test("default-off foundation is not imported into the live v3 handler", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assert(!source.includes('from "./conversation-state.ts"') &&
    !source.includes('from "./conversation-state"'),
  "live handler must remain unchanged until typed server-evidence integration");
});
