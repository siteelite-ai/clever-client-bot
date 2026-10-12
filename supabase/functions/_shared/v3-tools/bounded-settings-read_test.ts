import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { readSettingsRowWithRetry } from "./bounded-settings-read.ts";

Deno.test("transient settings error is retried without losing a valid row", async () => {
  let calls = 0;
  const result = await readSettingsRowWithRetry(async () => {
    calls++;
    return calls === 1
      ? { data: null, error: new Error("temporary database failure") }
      : { data: { model: "live" }, error: null };
  }, new AbortController().signal);
  assertEquals(result, {
    data: { model: "live" }, status: "ok", attempts: 2, failure: null,
  });
  assertEquals(calls, 2);
});

Deno.test("two failed reads remain unavailable, not a missing secret", async () => {
  const result = await readSettingsRowWithRetry(
    async () => ({ data: null, error: new Error("unavailable") }),
    new AbortController().signal,
  );
  assertEquals(result, {
    data: null, status: "unavailable", attempts: 2, failure: "query_error",
  });
});

Deno.test("a missing row is reported separately from a read error", async () => {
  const result = await readSettingsRowWithRetry(
    async () => ({ data: null, error: null }),
    new AbortController().signal,
  );
  assertEquals(result.failure, "missing_row");
  assertEquals(result.attempts, 2);
});

Deno.test("aborted turn does not issue a settings retry", async () => {
  const controller = new AbortController();
  controller.abort(new Error("turn ended"));
  let calls = 0;
  await assertRejects(() =>
    readSettingsRowWithRetry(async () => {
      calls++;
      return { data: { model: "unused" } };
    }, controller.signal)
  );
  assertEquals(calls, 0);
});

Deno.test("bounded timeout retries without waiting indefinitely", async () => {
  let calls = 0;
  const result = await readSettingsRowWithRetry(
    () => {
      calls++;
      return new Promise(() => {});
    },
    new AbortController().signal,
    5,
  );
  assertEquals(result.failure, "timeout");
  assertEquals(calls, 2);
});
