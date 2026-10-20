import { z } from "https://esm.sh/zod@3.23.8";
import { MAX_REQUEST_BODY_READ_MS, readRequestTextBounded } from "../_shared/v3-tools/request-validation.ts";

// The retired widget route is still callable directly. Keep its published
// request schema, but bound excessive input before DB/LLM work. This cap is
// intentionally larger than v3's: v2 accepted up to 100 untrimmed messages.
export const MAX_V2_REQUEST_BODY_BYTES = 512 * 1024;

const HistoryMsgSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
});

export const RequestSchema = z.object({
  conversationId: z.string().min(1).max(200),
  query: z.string().trim().min(1).max(2000),
  history: z.array(HistoryMsgSchema).max(100).optional(),
  messages: z.array(HistoryMsgSchema).max(100).optional(),
  dialogSlots: z.record(z.string(), z.unknown()).optional(),
  state: z.unknown().optional(),
});

export type V2Request = z.infer<typeof RequestSchema>;

type V2RequestError = {
  ok: false;
  status: 400 | 408 | 413;
  error: "invalid_json" | "invalid_request" | "payload_too_large" | "request_timeout";
  details?: Record<string, string[] | undefined>;
};

export type V2RequestResult =
  | { ok: true; value: V2Request }
  | V2RequestError;

export async function parseV2Request(
  req: Request,
  readTimeoutMs = MAX_REQUEST_BODY_READ_MS,
): Promise<V2RequestResult> {
  const contentLength = Number(req.headers.get("content-length"));
  if (
    Number.isFinite(contentLength) && contentLength > MAX_V2_REQUEST_BODY_BYTES
  ) {
    return { ok: false, status: 413, error: "payload_too_large" };
  }

  // Content-Length is untrusted: stream bytes are bounded even if absent or
  // forged. The shared reader is also used by the active v3 route.
  const readResult = await readRequestTextBounded(
    req,
    MAX_V2_REQUEST_BODY_BYTES,
    readTimeoutMs,
  );
  if (!readResult.ok) {
    return readResult.reason === "too_large"
      ? { ok: false, status: 413, error: "payload_too_large" }
      : readResult.reason === "timeout" || readResult.reason === "aborted"
      ? { ok: false, status: 408, error: "request_timeout" }
      : { ok: false, status: 400, error: "invalid_json" };
  }

  let body: unknown;
  try {
    body = readResult.text ? JSON.parse(readResult.text) : {};
  } catch {
    return { ok: false, status: 400, error: "invalid_json" };
  }

  const validation = RequestSchema.safeParse(body);
  if (!validation.success) {
    return {
      ok: false,
      status: 400,
      error: "invalid_request",
      details: validation.error.flatten().fieldErrors,
    };
  }
  return { ok: true, value: validation.data };
}
