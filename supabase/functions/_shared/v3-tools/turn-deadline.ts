/**
 * An accepted turn must be able to finish its SSE protocol even when a remote
 * dependency never settles. The signal is passed to cooperative I/O, while the
 * race is the last line of defence for a promise that ignores cancellation.
 */
export async function runWithDeadline<T>(
  task: (signal: AbortSignal) => PromiseLike<T> | T,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new DOMException("turn_deadline_exceeded", "TimeoutError");
      controller.abort(error);
      try {
        onTimeout?.();
      } catch {
        // A timeout callback cannot prevent the terminal protocol.
      }
      reject(error);
    }, Math.max(1, timeoutMs));
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => task(controller.signal)),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Supabase JS 2.45 lacks a per-query abort API; its HTTP transport can still
 * be bounded without changing callers or their query semantics. */
export function createDeadlineFetch(
  fetchImpl: typeof fetch,
  timeoutMs: number,
): typeof fetch {
  return (input, init) => {
    const deadlineSignal = AbortSignal.timeout(Math.max(1, timeoutMs));
    return fetchImpl(input, {
      ...init,
      signal: init?.signal
        ? AbortSignal.any([init.signal, deadlineSignal])
        : deadlineSignal,
    });
  };
}

/** The terminal replay write is idempotent and may be retried when its HTTP
 * response is lost. Failure never prevents the live SSE from terminating. */
export async function retryBoundedTerminalWrite(
  write: () => PromiseLike<void> | void,
  timeoutMs: number,
  onFailure: (error: unknown, attempt: number) => void,
): Promise<boolean> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await runWithDeadline(() => write(), timeoutMs);
      return true;
    } catch (error) {
      onFailure(error, attempt);
    }
  }
  return false;
}
