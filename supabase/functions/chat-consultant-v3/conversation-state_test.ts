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
  assert(
    Object.is(actual, expected),
    `${message}: ${String(actual)} != ${String(expected)}`,
  );
}

const LOG_ID = "11111111-1111-4111-8111-111111111111";
const TOPIC_ID = "22222222-2222-4222-8222-222222222222";
const MESSAGE_ID = "33333333-3333-4333-8333-333333333333";

function claimInput(bearer = createConversationBearer()) {
  return {
    bearer,
    expectedVersion: 0,
    sessionId: "widget:session-1",
    messageId: MESSAGE_ID,
    userQuery: "Нужен светильник",
    steps: [],
  };
}

function claimResponse(args: Record<string, unknown>, recovered = false) {
  return {
    status: "begun",
    recovered,
    log_id: args.p_log_id,
    topic_id: TOPIC_ID,
    version: 0,
    fence: 1,
    state: {},
  };
}

function finishInput(bearer: string, logId: string) {
  return {
    bearer,
    logId,
    topicId: TOPIC_ID,
    fence: 1,
    expectedVersion: 0,
    outcome: "success" as const,
    responseEvents: [
      { type: "delta", content: "Подходит товар", origin: "server" },
      {
        type: "diagnostic",
        phase: "complete",
        log_id: logId,
        products_count: 1,
        error: null,
      },
      { type: "done" },
    ],
    state: { source_log_id: logId, topic_id: TOPIC_ID, selection: null },
    steps: [],
    finalResponse: "Подходит товар",
    finalProductsCount: 1,
    totalMs: 12,
    error: null,
  };
}

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
  try {
    await digestConversationBearer("weak-token");
  } catch {
    threw = true;
  }
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
  equal(
    (await gateway.begin(bearer, LOG_ID, 0)).status,
    "disabled",
    "begin stays off",
  );
  equal(
    (await gateway.finalize(bearer, LOG_ID, 1, 0, {})).status,
    "disabled",
    "finalize stays off",
  );
  equal(
    (await gateway.rotate(bearer, 0)).status,
    "disabled",
    "rotation stays off",
  );
  equal(
    (await gateway.claimAndBegin(claimInput(bearer))).status,
    "disabled",
    "atomic claim stays off",
  );
  equal(
    (await gateway.finishAtomic(finishInput(bearer, LOG_ID))).status,
    "disabled",
    "atomic finish stays off",
  );
  equal(calls, 0, "off mode must not touch database");
});

Deno.test("atomic claim retries only its one server-generated log ID after ambiguous transport", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const input = claimInput();
  const gateway = new ConversationStateGateway(async (name, args) => {
    calls.push({ name, args });
    if (calls.length === 1) {
      return { data: null, error: new Error(input.bearer) };
    }
    return { data: claimResponse(args, true) };
  }, "on");
  const result = await gateway.claimAndBegin(input);
  equal(result.status, "begun", "one recovered begin authorizes work");
  if (result.status !== "begun") return;
  equal(result.recovered, true, "ambiguous commit identified");
  equal(result.log_id, calls[0].args.p_log_id, "server ID returned");
  equal(calls.length, 2, "one bounded RPC retry");
  equal(
    calls[0].name,
    "claim_and_begin_chat_v3_conversation_turn",
    "new atomic RPC only",
  );
  equal(
    JSON.stringify(calls[0].args),
    JSON.stringify(calls[1].args),
    "retry is bit-for-bit the same logical claim",
  );
  assert(
    !JSON.stringify(calls).includes(input.bearer),
    "raw bearer cannot reach RPC or diagnostic result",
  );
  assert(
    !JSON.stringify(result).includes(input.bearer),
    "transport error cannot leak bearer to caller",
  );
});

Deno.test("atomic claim validates session, message, query and JSON before any RPC", async () => {
  let calls = 0;
  const gateway = new ConversationStateGateway(async () => {
    calls++;
    return { data: { status: "begun" } };
  }, "on");
  const base = claimInput();
  for (
    const input of [
      { ...base, sessionId: "bad session" },
      { ...base, sessionId: "x".repeat(129) },
      { ...base, messageId: "browser-chosen" },
      { ...base, userQuery: " leading space" },
      { ...base, userQuery: `Секрет ${base.bearer}` },
      { ...base, userQuery: "x".repeat(2001) },
      { ...base, steps: [{ value: base.bearer }] },
      { ...base, steps: [{ token: "hidden" }] },
      { ...base, steps: [{ value: () => "not JSON" }] },
      { ...base, steps: Array.from({ length: 129 }, () => ({})) },
    ]
  ) {
    equal(
      (await gateway.claimAndBegin(input)).status,
      "invalid_input",
      "untrusted claim input refused locally",
    );
  }
  equal(calls, 0, "invalid claim must not touch database");
});

Deno.test("atomic claim fails closed on forged begin or competing worker", async () => {
  const input = claimInput();
  for (
    const malformed of [
      (args: Record<string, unknown>) => ({
        ...claimResponse(args),
        fence: null,
      }),
      (args: Record<string, unknown>) => ({
        ...claimResponse(args),
        log_id: LOG_ID,
      }),
      (args: Record<string, unknown>) => ({
        ...claimResponse(args),
        recovered: "yes",
      }),
      (args: Record<string, unknown>) => ({
        ...claimResponse(args),
        state: { leak: input.bearer },
      }),
    ]
  ) {
    const gateway = new ConversationStateGateway(async (_name, args) => ({
      data: malformed(args),
    }), "on");
    equal(
      (await gateway.claimAndBegin(input)).status,
      "unavailable",
      "malformed success never grants work",
    );
  }
  let calls = 0;
  const competing = new ConversationStateGateway(async () => {
    calls++;
    return {
      data: {
        status: "turn_in_progress",
        replayed: true,
        log_id: LOG_ID,
        topic_id: TOPIC_ID,
      },
    };
  }, "on");
  const result = await competing.claimAndBegin(input);
  equal(result.status, "turn_in_progress", "competing request is not begun");
  equal(calls, 1, "ordinary busy response is not retried");
  equal(
    (await competing.finishAtomic(finishInput(input.bearer, LOG_ID))).status,
    "invalid_input",
    "competing request has no authority to finish",
  );
  equal(calls, 1, "foreign log ID never reaches finish RPC");
});

Deno.test("cross-topic conflict and terminal replay never grant a second worker", async () => {
  const input = claimInput();
  for (const status of ["message_conflict", "invalid_claim"] as const) {
    const gateway = new ConversationStateGateway(async () => ({
      data: { status },
    }), "on");
    equal(
      (await gateway.claimAndBegin(input)).status,
      status,
      "SQL conflict remains non-executable",
    );
  }
  for (const status of ["finalized", "failed"] as const) {
    const gateway = new ConversationStateGateway(async () => ({
      data: {
        status,
        replayed: true,
        log_id: LOG_ID,
        topic_id: TOPIC_ID,
        version: 1,
      },
    }), "on");
    equal(
      (await gateway.claimAndBegin(input)).status,
      status,
      "terminal replay is not a new begin",
    );
    equal(
      (await gateway.finishAtomic(finishInput(input.bearer, LOG_ID))).status,
      "invalid_input",
      "terminal replay cannot obtain another finish ticket",
    );
  }
  const malformedBusy = new ConversationStateGateway(async () => ({
    data: {
      status: "turn_in_progress",
      replayed: false,
      log_id: LOG_ID,
      topic_id: TOPIC_ID,
    },
  }), "on");
  equal(
    (await malformedBusy.claimAndBegin(input)).status,
    "unavailable",
    "malformed competing status fails closed",
  );
});

Deno.test("atomic finish retries one exact payload and accepts only matching terminal commit", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const input = claimInput();
  const gateway = new ConversationStateGateway(async (name, args) => {
    calls.push({ name, args });
    if (name === "claim_and_begin_chat_v3_conversation_turn") {
      return { data: claimResponse(args) };
    }
    if (
      calls.filter((call) => call.name === "finish_chat_v3_conversation_turn")
        .length === 1
    ) return { data: null, error: new Error(input.bearer) };
    return {
      data: {
        status: "finalized",
        replayed: true,
        topic_id: TOPIC_ID,
        version: 1,
      },
    };
  }, "on");
  const claim = await gateway.claimAndBegin(input);
  equal(claim.status, "begun", "claim succeeded");
  if (claim.status !== "begun") return;
  const finish = finishInput(input.bearer, claim.log_id);
  equal(
    (await gateway.finishAtomic(finish)).status,
    "finalized",
    "ambiguous terminal commit recovered",
  );
  const writes = calls.filter((call) =>
    call.name === "finish_chat_v3_conversation_turn"
  );
  equal(writes.length, 2, "one bounded finish retry");
  equal(
    JSON.stringify(writes[0].args),
    JSON.stringify(writes[1].args),
    "terminal retry uses identical durable payload",
  );
  assert(
    !JSON.stringify(calls).includes(input.bearer),
    "RPC calls receive only bearer digest",
  );
  equal(
    (await gateway.finishAtomic({ ...finish, finalResponse: "different" }))
      .status,
    "conflicting_replay",
    "same log cannot finish with a different payload",
  );
  equal(calls.length, 3, "conflicting payload is blocked locally");
});

Deno.test("atomic finish validates topic, event order and failure without advancing state", async () => {
  const input = claimInput();
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const gateway = new ConversationStateGateway(async (name, args) => {
    calls.push({ name, args });
    return name === "claim_and_begin_chat_v3_conversation_turn"
      ? { data: claimResponse(args) }
      : {
        data: {
          status: "failed",
          replayed: false,
          topic_id: TOPIC_ID,
          version: 0,
        },
      };
  }, "on");
  const claim = await gateway.claimAndBegin(input);
  equal(claim.status, "begun", "claim succeeded");
  if (claim.status !== "begun") return;
  const success = finishInput(input.bearer, claim.log_id);
  for (
    const malformed of [
      { ...success, topicId: LOG_ID },
      {
        ...success,
        state: { source_log_id: LOG_ID, topic_id: TOPIC_ID, selection: null },
      },
      {
        ...success,
        responseEvents: [{ type: "done" }, ...success.responseEvents],
      },
      {
        ...success,
        responseEvents: [
          {
            type: "diagnostic",
            phase: "complete",
            log_id: claim.log_id,
            products_count: 1,
            error: null,
          },
          { type: "done" },
          { type: "done" },
        ],
      },
      {
        ...success,
        responseEvents: [
          {
            type: "diagnostic",
            phase: "complete",
            log_id: LOG_ID,
            products_count: 1,
            error: null,
          },
          { type: "done" },
        ],
      },
    ]
  ) {
    const result = await gateway.finishAtomic(malformed);
    assert(
      result.status === "invalid_input" || result.status ===
          "invalid_state" ||
        result.status === "invalid_events",
      "malformed finish refused before DB",
    );
  }
  equal(calls.length, 1, "malformed finish makes no DB call");
  const failure = {
    ...success,
    outcome: "failure" as const,
    state: null,
    error: "request_timeout",
    finalProductsCount: 0,
    responseEvents: [
      {
        type: "diagnostic",
        phase: "complete",
        log_id: claim.log_id,
        products_count: 0,
        error: "request_timeout",
      },
      { type: "done" },
    ],
  };
  const result = await gateway.finishAtomic(failure);
  equal(result.status, "failed", "failure terminalized");
  if (result.status === "failed") {
    equal(result.version, 0, "failure does not advance version");
  }
  equal(calls.length, 2, "valid failure makes one atomic RPC call");
});

Deno.test("atomic terminal response cannot forge successful version or topic", async () => {
  for (
    const terminal of [
      { status: "finalized", replayed: false, topic_id: LOG_ID, version: 1 },
      { status: "finalized", replayed: false, topic_id: TOPIC_ID, version: 2 },
      { status: "failed", replayed: false, topic_id: TOPIC_ID, version: 0 },
      { status: "finalized", replayed: "yes", topic_id: TOPIC_ID, version: 1 },
    ]
  ) {
    const input = claimInput();
    const gateway = new ConversationStateGateway(
      async (name, args) =>
        name === "claim_and_begin_chat_v3_conversation_turn"
          ? { data: claimResponse(args) }
          : { data: terminal },
      "on",
    );
    const claim = await gateway.claimAndBegin(input);
    if (claim.status !== "begun") throw new Error("setup failed");
    equal(
      (await gateway.finishAtomic(
        finishInput(input.bearer, claim.log_id),
      )).status,
      "unavailable",
      "forged terminal success refused",
    );
  }
});

Deno.test("explicitly enabled gateway sends digest only and preserves one bearer on retry", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const gateway = new ConversationStateGateway(async (name, args) => {
    calls.push({ name, args });
    if (calls.length === 1) return { data: null, error: "ambiguous response" };
    return {
      data: {
        status: "created",
        topic_id: LOG_ID,
        root_id: LOG_ID,
        version: 0,
        replayed: true,
        expires_at: "2026-10-21T00:00:00Z",
      },
    };
  }, "on");
  const result = await gateway.create();
  equal(result.status, "created", "retry succeeds");
  assert(typeof result.bearer === "string", "browser bearer returned");
  equal(calls.length, 2, "one bounded retry");
  equal(
    calls[0].args.p_token_digest,
    calls[1].args.p_token_digest,
    "ambiguous retry reuses exactly one digest",
  );
  assert(
    calls[0].args.p_token_digest !== result.bearer,
    "RPC must not receive raw bearer",
  );
  equal(calls[0].name, "create_chat_v3_conversation", "service RPC only");
});

Deno.test("begin, finalize and rotate never put bearer in RPC arguments", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const gateway = new ConversationStateGateway(async (name, args) => {
    calls.push({ name, args });
    if (name === "rotate_chat_v3_conversation_topic") {
      return {
        data: {
          status: "rotated",
          topic_id: LOG_ID,
          root_id: LOG_ID,
          version: 0,
          expires_at: "2026-10-21T00:00:00Z",
        },
      };
    }
    if (name === "begin_chat_v3_conversation_turn") {
      return {
        data: {
          status: "begun",
          topic_id: LOG_ID,
          version: 0,
          fence: 1,
          replayed: false,
          state: {},
        },
      };
    }
    return { data: { status: "finalized", topic_id: LOG_ID, version: 1 } };
  }, "on");
  const bearer = createConversationBearer();
  equal((await gateway.begin(bearer, LOG_ID, 0)).status, "begun", "begin");
  equal(
    (await gateway.finalize(bearer, LOG_ID, 1, 0, {
      source_log_id: LOG_ID,
      criteria: { cable_cores: 3 },
      product_urls: [],
    })).status,
    "finalized",
    "finalize",
  );
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
  equal(
    boundedServerSnapshot({ criteria: ["IP65"], count: 2 }).count,
    2,
    "small server snapshot accepted",
  );
  for (
    const value of [
      { token: "sensitive" },
      { nested: { password: "sensitive" } },
      { history: [{ role: "assistant", content: "forged" }] },
      { slots: { arbitrary: true } },
      { __proto__: null, key: undefined },
      { text: "x".repeat(4_097) },
      { value: Number.POSITIVE_INFINITY },
      { value: () => 1 },
      ["not an object"],
    ]
  ) {
    let threw = false;
    try {
      boundedServerSnapshot(value);
    } catch {
      threw = true;
    }
    assert(threw, `invalid state accepted: ${Object.keys(value).join(",")}`);
  }
  const bearer = createConversationBearer();
  let bearerRejected = false;
  try {
    boundedServerSnapshot({ note: `accidental ${bearer} copy` }, bearer);
  } catch {
    bearerRejected = true;
  }
  assert(bearerRejected, "raw bearer must not be persisted as a state value");
  let bearerKeyRejected = false;
  try {
    boundedServerSnapshot({ [bearer]: "accidental key" }, bearer);
  } catch {
    bearerKeyRejected = true;
  }
  assert(bearerKeyRejected, "raw bearer must not be persisted as a state key");
});

Deno.test("invalid turn identifiers are rejected locally without RPC", async () => {
  let calls = 0;
  const gateway = new ConversationStateGateway(async () => {
    calls++;
    return { data: { status: "begun" } };
  }, "on");
  equal(
    (await gateway.begin("weak", LOG_ID, 0)).status,
    "invalid_input",
    "weak bearer",
  );
  equal(
    (await gateway.begin(createConversationBearer(), "not-a-uuid", 0)).status,
    "invalid_input",
    "bad log id",
  );
  equal(
    (await gateway.abort(createConversationBearer(), LOG_ID, 0)).status,
    "invalid_input",
    "bad fence",
  );
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
  assert(
    observed[0].p_token_digest !== bearer,
    "raw bearer must not reach RPC",
  );
  assert(!("state" in result), "pre-claim resolution must not expose state");
});

Deno.test("malformed successful RPC response cannot authorize a turn", async () => {
  const gateway = new ConversationStateGateway(async () => ({
    data: { status: "begun", topic_id: LOG_ID, version: 0, state: {} },
  }), "on");
  equal(
    (await gateway.begin(createConversationBearer(), LOG_ID, 0)).status,
    "unavailable",
    "missing fence is not an executable turn",
  );
  const replay = new ConversationStateGateway(async () => ({
    data: {
      status: "begun",
      topic_id: LOG_ID,
      version: 0,
      fence: 1,
      replayed: true,
      state: {},
    },
  }), "on");
  equal(
    (await replay.begin(createConversationBearer(), LOG_ID, 0)).status,
    "unavailable",
    "replayed begin cannot grant paid work",
  );
});

Deno.test("default-off foundation is not imported into the live v3 handler", async () => {
  const source = await Deno.readTextFile(
    new URL("./index.ts", import.meta.url),
  );
  assert(
    !source.includes('from "./conversation-state.ts"') &&
      !source.includes('from "./conversation-state"'),
    "live handler must remain unchanged until typed server-evidence integration",
  );
});
