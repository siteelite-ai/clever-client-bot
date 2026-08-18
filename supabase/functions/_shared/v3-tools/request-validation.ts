export const MAX_REQUEST_BODY_BYTES = 64 * 1024;

const MAX_MESSAGE_CHARS = 2_000;
const MAX_HISTORY_ITEMS = 20;
const MAX_USER_HISTORY_CHARS = 2_000;
const MAX_ASSISTANT_HISTORY_CHARS = 8_000;
const MAX_HISTORY_TOTAL_CHARS = 32_000;
const MAX_SESSION_ID_CHARS = 128;
const MAX_SLOTS_JSON_CHARS = 16_000;
const MAX_JSON_DEPTH = 12;
const MAX_JSON_NODES = 1_000;
const MAX_OBJECT_KEYS = 100;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Compatibility window for the public widget released before UUID validation.
// Keep this exact and bounded: messageId is an idempotency key, not an auth token.
const LEGACY_WIDGET_MESSAGE_ID_RE = /^msg_[0-9]{13}_[a-z0-9]{8}$/i;
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const TOP_LEVEL_FIELDS = new Set([
  "message",
  "messageId",
  "sessionId",
  "history",
  "stream",
  "slots",
  "dialogSlots",
]);

export interface ChatHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export type JsonRecord = Record<string, unknown>;

export interface ValidatedChatRequest {
  message: string;
  messageId: string;
  sessionId?: string;
  history: ChatHistoryMessage[];
  stream: boolean;
  slots?: JsonRecord;
  dialogSlots?: JsonRecord;
}

export interface ValidationIssue {
  field: string;
  code: string;
}

export type ChatRequestValidationResult =
  | { ok: true; value: ValidatedChatRequest }
  | { ok: false; issues: ValidationIssue[] };

function isPlainRecord(value: unknown): value is JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function addIssue(
  issues: ValidationIssue[],
  field: string,
  code: string,
): void {
  issues.push({ field, code });
}

function validateJsonRecord(
  value: unknown,
  field: string,
  issues: ValidationIssue[],
): value is JsonRecord {
  if (!isPlainRecord(value)) {
    addIssue(issues, field, "expected_object");
    return false;
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    addIssue(issues, field, "invalid_json_value");
    return false;
  }
  if (serialized.length > MAX_SLOTS_JSON_CHARS) {
    addIssue(issues, field, "too_large");
    return false;
  }

  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let visited = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    visited += 1;
    if (visited > MAX_JSON_NODES) {
      addIssue(issues, field, "too_complex");
      return false;
    }
    if (current.depth > MAX_JSON_DEPTH) {
      addIssue(issues, field, "too_deep");
      return false;
    }

    if (Array.isArray(current.value)) {
      for (const child of current.value) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
      continue;
    }
    if (current.value !== null && typeof current.value === "object") {
      if (!isPlainRecord(current.value)) {
        addIssue(issues, field, "invalid_object");
        return false;
      }
      const entries = Object.entries(current.value);
      if (entries.length > MAX_OBJECT_KEYS) {
        addIssue(issues, field, "too_many_keys");
        return false;
      }
      for (const [key, child] of entries) {
        if (FORBIDDEN_KEYS.has(key)) {
          addIssue(issues, `${field}.${key}`, "forbidden_key");
          return false;
        }
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return true;
}

export function validateChatRequestBody(
  input: unknown,
): ChatRequestValidationResult {
  const issues: ValidationIssue[] = [];
  if (!isPlainRecord(input)) {
    return { ok: false, issues: [{ field: "$", code: "expected_object" }] };
  }

  for (const field of Object.keys(input)) {
    if (!TOP_LEVEL_FIELDS.has(field)) addIssue(issues, field, "unknown_field");
  }

  const rawMessage = input.message;
  let message = "";
  if (typeof rawMessage !== "string") {
    addIssue(issues, "message", "expected_string");
  } else {
    message = rawMessage.trim();
    if (message.length === 0) addIssue(issues, "message", "empty");
    else if (message.length > MAX_MESSAGE_CHARS) {
      addIssue(issues, "message", "too_long");
    }
  }

  const messageId = input.messageId;
  if (typeof messageId !== "string") {
    addIssue(issues, "messageId", "expected_string");
  } else if (
    !UUID_RE.test(messageId) && !LEGACY_WIDGET_MESSAGE_ID_RE.test(messageId)
  ) {
    addIssue(issues, "messageId", "invalid_format");
  }

  const sessionId = input.sessionId;
  if (sessionId !== undefined) {
    if (typeof sessionId !== "string") {
      addIssue(issues, "sessionId", "expected_string");
    } else if (
      sessionId.length === 0 ||
      sessionId.length > MAX_SESSION_ID_CHARS ||
      !SESSION_ID_RE.test(sessionId)
    ) {
      addIssue(issues, "sessionId", "invalid_format");
    }
  }

  const history: ChatHistoryMessage[] = [];
  let historyTotalChars = 0;
  if (input.history !== undefined) {
    if (!Array.isArray(input.history)) {
      addIssue(issues, "history", "expected_array");
    } else if (input.history.length > MAX_HISTORY_ITEMS) {
      addIssue(issues, "history", "too_many_items");
    } else {
      input.history.forEach((item, index) => {
        const field = `history[${index}]`;
        if (!isPlainRecord(item)) {
          addIssue(issues, field, "expected_object");
          return;
        }
        const itemKeys = Object.keys(item);
        if (itemKeys.some((key) => key !== "role" && key !== "content")) {
          addIssue(issues, field, "unknown_field");
        }
        if (item.role !== "user" && item.role !== "assistant") {
          addIssue(issues, `${field}.role`, "invalid_role");
          return;
        }
        if (typeof item.content !== "string") {
          addIssue(issues, `${field}.content`, "expected_string");
          return;
        }
        const content = item.content.trim();
        const maxChars = item.role === "user"
          ? MAX_USER_HISTORY_CHARS
          : MAX_ASSISTANT_HISTORY_CHARS;
        if (content.length === 0) addIssue(issues, `${field}.content`, "empty");
        else if (content.length > maxChars) {
          addIssue(issues, `${field}.content`, "too_long");
        }
        historyTotalChars += content.length;
        history.push({ role: item.role, content });
      });
    }
  }
  if (historyTotalChars > MAX_HISTORY_TOTAL_CHARS) {
    addIssue(issues, "history", "total_too_long");
  }

  const stream = input.stream;
  if (stream !== undefined && typeof stream !== "boolean") {
    addIssue(issues, "stream", "expected_boolean");
  }

  let slots: JsonRecord | undefined;
  let dialogSlots: JsonRecord | undefined;
  if (input.slots !== undefined && input.dialogSlots !== undefined) {
    addIssue(issues, "slots", "mutually_exclusive");
  }
  if (
    input.slots !== undefined &&
    validateJsonRecord(input.slots, "slots", issues)
  ) {
    slots = input.slots;
  }
  if (
    input.dialogSlots !== undefined &&
    validateJsonRecord(input.dialogSlots, "dialogSlots", issues)
  ) {
    dialogSlots = input.dialogSlots;
  }

  if (issues.length > 0 || typeof messageId !== "string") {
    return { ok: false, issues };
  }

  return {
    ok: true,
    value: {
      message,
      messageId,
      ...(typeof sessionId === "string" ? { sessionId } : {}),
      history,
      stream: typeof stream === "boolean" ? stream : true,
      ...(slots ? { slots } : {}),
      ...(dialogSlots ? { dialogSlots } : {}),
    },
  };
}
