import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type ChatV3AdmissionRpc,
  checkChatV3Admission,
  releaseChatV3Admission,
} from "./chat-admission.ts";

const LOG_ID = "00000000-0000-4000-8000-000000000001";

function env(values: Record<string, string | undefined>) {
  return (name: string) => values[name];
}

function decision(overrides: Record<string, unknown> = {}) {
  return {
    allowed: true,
    reason: "admitted",
    mode: "enforce",
    replayed: false,
    would_reject: false,
    limit_reason: null,
    window_count_before: 2,
    in_flight_before: 1,
    retry_after_seconds: null,
    ...overrides,
  };
}

Deno.test("unset/off mode never calls either RPC, even with bad limits", async () => {
  let calls = 0;
  const rpc: ChatV3AdmissionRpc = () => {
    calls++;
    throw new Error("off mode must not reach database");
  };
  for (const mode of [undefined, "off"]) {
    const admission = await checkChatV3Admission(
      LOG_ID,
      rpc,
      env({
        CHAT_V3_ADMISSION_MODE: mode,
        CHAT_V3_ADMISSION_LIMIT_PER_MINUTE: "bad",
      }),
    );
    assertEquals(admission.allowed, true);
    assertEquals(admission.reason, "off");
    assertEquals(admission.rpcCalled, false);
    assertEquals(admission.releaseRequired, false);
    assertEquals(await releaseChatV3Admission(LOG_ID, admission, rpc), {
      attempted: false,
      released: false,
      failure: null,
    });
  }
  assertEquals(calls, 0);
});

Deno.test("observe passes only server limits and records would-reject telemetry", async () => {
  const calls: Array<
    { name: string; args: Record<string, string | number | null> }
  > = [];
  const rpc: ChatV3AdmissionRpc = (name, args) => {
    calls.push({ name, args });
    return Promise.resolve({
      data: decision({
        allowed: true,
        reason: "observed_limit",
        mode: "observe",
        would_reject: true,
        limit_reason: "minute_limit",
        retry_after_seconds: 7,
      }),
      error: null,
    });
  };
  const admission = await checkChatV3Admission(
    LOG_ID,
    rpc,
    env({
      CHAT_V3_ADMISSION_MODE: "observe",
      CHAT_V3_ADMISSION_LIMIT_PER_MINUTE: " 30 ",
      CHAT_V3_ADMISSION_LIMIT_IN_FLIGHT: "4",
    }),
  );
  assertEquals(calls, [{
    name: "check_chat_v3_admission",
    args: {
      p_log_id: LOG_ID,
      p_mode: "observe",
      p_limit_per_minute: 30,
      p_limit_in_flight: 4,
    },
  }]);
  assertEquals(admission.allowed, true);
  assertEquals(admission.wouldReject, true);
  assertEquals(admission.limitReason, "minute_limit");
  assertEquals(admission.retryAfterSeconds, 7);
  assertEquals(admission.windowCountBefore, 2);
  assertEquals(admission.inFlightBefore, 1);
  assertEquals(admission.releaseRequired, true);
});

Deno.test("observe permits absent thresholds but sends null, not assumed limits", async () => {
  let seenArgs: Record<string, string | number | null> | null = null;
  const rpc: ChatV3AdmissionRpc = (_, args) => {
    seenArgs = args;
    return Promise.resolve({
      data: decision({
        mode: "observe",
        reason: "observe_unconfigured",
      }),
      error: null,
    });
  };
  const result = await checkChatV3Admission(
    LOG_ID,
    rpc,
    env({ CHAT_V3_ADMISSION_MODE: "observe" }),
  );
  assertEquals(result.allowed, true);
  assertEquals(result.reason, "observe_unconfigured");
  assertEquals(seenArgs, {
    p_log_id: LOG_ID,
    p_mode: "observe",
    p_limit_per_minute: null,
    p_limit_in_flight: null,
  });
});

Deno.test("enforce preserves an admitted decision and a bounded denial", async () => {
  let calls = 0;
  const rpc: ChatV3AdmissionRpc = () => {
    calls++;
    return Promise.resolve({
      data: calls === 1 ? decision() : decision({
        allowed: false,
        reason: "limit_exceeded",
        would_reject: true,
        limit_reason: "minute_and_in_flight_limit",
        retry_after_seconds: 12,
      }),
      error: null,
    });
  };
  const readEnv = env({
    CHAT_V3_ADMISSION_MODE: "enforce",
    CHAT_V3_ADMISSION_LIMIT_PER_MINUTE: "10",
    CHAT_V3_ADMISSION_LIMIT_IN_FLIGHT: "2",
  });
  const allowed = await checkChatV3Admission(LOG_ID, rpc, readEnv);
  const denied = await checkChatV3Admission(LOG_ID, rpc, readEnv);
  assertEquals(allowed.allowed, true);
  assertEquals(denied.allowed, false);
  assertEquals(denied.reason, "limit_exceeded");
  assertEquals(denied.retryAfterSeconds, 12);
  assertEquals(denied.releaseRequired, false);
  assertEquals(
    await releaseChatV3Admission(LOG_ID, denied, () => {
      throw new Error("a denied decision has no reservation to release");
    }),
    { attempted: false, released: false, failure: null },
  );
});

Deno.test("invalid configured mode and limits deny without RPC", async () => {
  let calls = 0;
  const rpc: ChatV3AdmissionRpc = () => {
    calls++;
    return Promise.resolve({ data: decision(), error: null });
  };
  const cases: Array<[Record<string, string | undefined>, string]> = [
    [{ CHAT_V3_ADMISSION_MODE: "monitor" }, "invalid_mode"],
    [{ CHAT_V3_ADMISSION_MODE: "" }, "invalid_mode"],
    [{
      CHAT_V3_ADMISSION_MODE: "observe",
      CHAT_V3_ADMISSION_LIMIT_PER_MINUTE: "0",
    }, "invalid_limit_per_minute"],
    [{
      CHAT_V3_ADMISSION_MODE: "enforce",
      CHAT_V3_ADMISSION_LIMIT_PER_MINUTE: "2147483648",
      CHAT_V3_ADMISSION_LIMIT_IN_FLIGHT: "2",
    }, "invalid_limit_per_minute"],
    [{
      CHAT_V3_ADMISSION_MODE: "enforce",
      CHAT_V3_ADMISSION_LIMIT_PER_MINUTE: "10",
      CHAT_V3_ADMISSION_LIMIT_IN_FLIGHT: "-1",
    }, "invalid_limit_in_flight"],
    [{
      CHAT_V3_ADMISSION_MODE: "enforce",
      CHAT_V3_ADMISSION_LIMIT_PER_MINUTE: "10",
    }, "missing_enforcement_limit"],
  ];
  for (const [values, failure] of cases) {
    const result = await checkChatV3Admission(LOG_ID, rpc, env(values));
    assertEquals(result.allowed, false);
    assertEquals(result.reason, "invalid_configuration");
    assertEquals(result.failure, failure);
    assertEquals(result.releaseRequired, false);
  }
  assertEquals(calls, 0);
});

Deno.test("RPC replay returns the committed decision without another local retry", async () => {
  let calls = 0;
  const rpc: ChatV3AdmissionRpc = () => {
    calls++;
    return Promise.resolve({
      data: decision({
        mode: "observe",
        replayed: true,
        reason: "observed_limit",
      }),
      error: null,
    });
  };
  const result = await checkChatV3Admission(
    LOG_ID,
    rpc,
    env({
      CHAT_V3_ADMISSION_MODE: "enforce",
      CHAT_V3_ADMISSION_LIMIT_PER_MINUTE: "10",
      CHAT_V3_ADMISSION_LIMIT_IN_FLIGHT: "2",
    }),
  );
  assertEquals(calls, 1);
  assertEquals(result.allowed, true);
  assertEquals(result.mode, "observe");
  assertEquals(result.replayed, true);
  assertEquals(result.releaseRequired, true);
});

Deno.test("observe opens only on failed RPC; an explicit claim denial stays denied", async () => {
  const readEnv = env({ CHAT_V3_ADMISSION_MODE: "observe" });
  const failed: ChatV3AdmissionRpc = () =>
    Promise.resolve({ data: null, error: new Error("secret database detail") });
  const failure = await checkChatV3Admission(LOG_ID, failed, readEnv);
  assertEquals(failure.allowed, true);
  assertEquals(failure.failure, "rpc_error");
  assertEquals(failure.reason, "rpc_error_open");
  assertEquals(failure.releaseRequired, true);
  let releaseCalls = 0;
  const releaseRpc: ChatV3AdmissionRpc = (name) => {
    assertEquals(name, "release_chat_v3_admission");
    releaseCalls++;
    return Promise.resolve({ data: false, error: null });
  };
  assertEquals(await releaseChatV3Admission(LOG_ID, failure, releaseRpc), {
    attempted: true,
    released: false,
    failure: null,
  });
  assertEquals(releaseCalls, 1);

  const explicitDenial: ChatV3AdmissionRpc = () =>
    Promise.resolve({
      data: decision({
        allowed: false,
        mode: "observe",
        reason: "claim_not_in_progress",
      }),
      error: null,
    });
  const denied = await checkChatV3Admission(LOG_ID, explicitDenial, readEnv);
  assertEquals(denied.allowed, false);
  assertEquals(denied.reason, "claim_not_in_progress");
  assertEquals(denied.failure, null);
});

Deno.test("enforce closes on thrown RPC or malformed response", async () => {
  const readEnv = env({
    CHAT_V3_ADMISSION_MODE: "enforce",
    CHAT_V3_ADMISSION_LIMIT_PER_MINUTE: "10",
    CHAT_V3_ADMISSION_LIMIT_IN_FLIGHT: "2",
  });
  const thrown = await checkChatV3Admission(
    LOG_ID,
    () => {
      throw new Error("secret database detail");
    },
    readEnv,
  );
  assertEquals(thrown.allowed, false);
  assertEquals(thrown.failure, "rpc_error");
  assertEquals(thrown.reason, "rpc_error_closed");
  assertEquals(thrown.releaseRequired, true);

  const malformed = await checkChatV3Admission(
    LOG_ID,
    () => Promise.resolve({ data: { allowed: true }, error: null }),
    readEnv,
  );
  assertEquals(malformed.allowed, false);
  assertEquals(malformed.failure, "invalid_rpc_response");
  assertEquals(malformed.releaseRequired, true);

  const contradictory = await checkChatV3Admission(
    LOG_ID,
    () =>
      Promise.resolve({
        data: decision({ allowed: true, reason: "limit_exceeded" }),
        error: null,
      }),
    readEnv,
  );
  assertEquals(contradictory.allowed, false);
  assertEquals(contradictory.failure, "invalid_rpc_response");
});

Deno.test("release is idempotent and reports ambiguous failures safely", async () => {
  const readEnv = env({
    CHAT_V3_ADMISSION_MODE: "enforce",
    CHAT_V3_ADMISSION_LIMIT_PER_MINUTE: "10",
    CHAT_V3_ADMISSION_LIMIT_IN_FLIGHT: "2",
  });
  let releases = 0;
  const rpc: ChatV3AdmissionRpc = (name, args) => {
    assertEquals(args.p_log_id, LOG_ID);
    if (name === "check_chat_v3_admission") {
      return Promise.resolve({ data: decision(), error: null });
    }
    releases++;
    return Promise.resolve({ data: releases === 1, error: null });
  };
  const admission = await checkChatV3Admission(LOG_ID, rpc, readEnv);
  assertEquals(await releaseChatV3Admission(LOG_ID, admission, rpc), {
    attempted: true,
    released: true,
    failure: null,
  });
  assertEquals(await releaseChatV3Admission(LOG_ID, admission, rpc), {
    attempted: true,
    released: false,
    failure: null,
  });
  assertEquals(releases, 2);

  const failing: ChatV3AdmissionRpc = () =>
    Promise.resolve({ data: null, error: new Error("secret database detail") });
  assertEquals(await releaseChatV3Admission(LOG_ID, admission, failing), {
    attempted: true,
    released: false,
    failure: "rpc_error",
  });
});
