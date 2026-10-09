import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createDeadlineFetch,
  retryBoundedTerminalWrite,
  runWithDeadline,
} from "./turn-deadline.ts";

Deno.test("accepted turn deadline rejects a dependency that never settles and aborts its I/O", async () => {
  let observedSignal: AbortSignal | undefined;
  let timeoutCalled = false;
  await assertRejects(
    () =>
      runWithDeadline(
        (signal) => {
          observedSignal = signal;
          return new Promise<never>(() => {});
        },
        10,
        () => {
          timeoutCalled = true;
        },
      ),
    DOMException,
    "turn_deadline_exceeded",
  );
  assertEquals(timeoutCalled, true);
  assertEquals(observedSignal?.aborted, true);
});

Deno.test("completed work does not spuriously expire later", async () => {
  let timeoutCalled = false;
  const value = await runWithDeadline(
    async () => "completed",
    100,
    () => {
      timeoutCalled = true;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 110));
  assertEquals(value, "completed");
  assertEquals(timeoutCalled, false);
});

Deno.test("a late result cannot replace a deadline failure", async () => {
  let finish!: (value: string) => void;
  const late = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const work = runWithDeadline(() => late, 10);
  await assertRejects(() => work, DOMException, "turn_deadline_exceeded");
  finish("late product result");
  await Promise.resolve();
  assert(true);
});

Deno.test("a late settings load cannot start paid work after the turn deadline", async () => {
  let finishSettings!: () => void;
  const settings = new Promise<void>((resolve) => {
    finishSettings = resolve;
  });
  let paidWorkStarted = false;
  const work = runWithDeadline(async (signal) => {
    await settings;
    if (signal.aborted) return;
    paidWorkStarted = true;
  }, 10);
  await assertRejects(() => work, DOMException, "turn_deadline_exceeded");
  finishSettings();
  await Promise.resolve();
  assertEquals(paidWorkStarted, false);
});

Deno.test("bounded Supabase transport aborts a hanging HTTP request", async () => {
  let observedAbort = false;
  const hangingFetch: typeof fetch = (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        observedAbort = true;
        reject(init.signal?.reason);
      }, { once: true });
    });
  await assertRejects(
    () => createDeadlineFetch(hangingFetch, 10)("https://example.test"),
    DOMException,
  );
  assertEquals(observedAbort, true);
});

Deno.test("the database fetch signal remains active while the response body hangs", async () => {
  const streamingFetch: typeof fetch = async (_input, init) =>
    new Response(
      new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => {
            controller.error(init.signal?.reason);
          }, { once: true });
        },
      }),
    );
  const response = await createDeadlineFetch(streamingFetch, 10)(
    "https://example.test",
  );
  await assertRejects(() => response.text(), DOMException);
});

Deno.test("a stuck first terminal log write retries once and does not hang SSE closure", async () => {
  let attempts = 0;
  const failures: number[] = [];
  const written = await retryBoundedTerminalWrite(
    () => {
      attempts++;
      return attempts === 1 ? new Promise<void>(() => {}) : Promise.resolve();
    },
    10,
    (_error, attempt) => failures.push(attempt),
  );
  assertEquals(written, true);
  assertEquals(attempts, 2);
  assertEquals(failures, [1]);
});

Deno.test("two stuck terminal writes return failure within the bounded window", async () => {
  let attempts = 0;
  const written = await retryBoundedTerminalWrite(
    () => {
      attempts++;
      return new Promise<void>(() => {});
    },
    10,
    () => {},
  );
  assertEquals(written, false);
  assertEquals(attempts, 2);
});
