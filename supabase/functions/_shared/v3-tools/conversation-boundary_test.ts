import {
  classifyConversationBoundary,
  parseConversationBoundaryDecision,
  shouldStartNewConversation,
  stripCurrentUserEcho,
  type ConversationMessage,
} from "./conversation-boundary.ts";

function assertEquals(actual: unknown, expected: unknown, message?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const prior: ConversationMessage[] = [
  { role: "assistant", content: "Что ищете?" },
  { role: "user", content: "Покажи настенные светильники" },
  { role: "assistant", content: "Вот три варианта. Какой сравнить?" },
];

Deno.test("transport echo of current user turn is removed exactly once", () => {
  const echoed = [...prior, { role: "user" as const, content: "  А второй дешевле?  " }];
  assertEquals(stripCurrentUserEcho(echoed, "а второй дешевле?"), prior);
  assertEquals(stripCurrentUserEcho(prior, "другой запрос"), prior);
});

Deno.test("boundary JSON parser validates mode and confidence", () => {
  assertEquals(
    parseConversationBoundaryDecision('```json\n{"mode":"new_task","confidence":0.91,"reason":"self contained"}\n```'),
    { mode: "new_task", confidence: 0.91, reason: "self contained" },
  );
  assertEquals(parseConversationBoundaryDecision('{"mode":"unknown","confidence":1}'), null);
  assertEquals(parseConversationBoundaryDecision('{"mode":"new_task","confidence":2}'), null);
});

Deno.test("new topic requires a high-confidence semantic decision", () => {
  assertEquals(shouldStartNewConversation({ mode: "new_task", confidence: 0.72, reason: "" }), true);
  assertEquals(shouldStartNewConversation({ mode: "new_task", confidence: 0.71, reason: "" }), false);
  assertEquals(shouldStartNewConversation({ mode: "continuation", confidence: 1, reason: "" }), false);
});

Deno.test("classifier prompt treats a complete new product request as a new task", async () => {
  let requestBody = "";
  const result = await classifyConversationBoundary(
    "а у тебя есть лампы кукуруза?",
    prior,
    {},
    {
      apiKey: "test",
      model: "test-model",
      fetchImpl: async (_input, init) => {
        requestBody = String(init?.body ?? "");
        return new Response(JSON.stringify({
          choices: [{ message: { content: '{"mode":"new_task","confidence":0.96,"reason":"complete independent request"}' } }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    },
  );
  assertEquals(result.mode, "new_task");
  assertEquals(shouldStartNewConversation(result), true);
  if (!requestBody.includes("self-contained") || !requestBody.includes("а у тебя есть лампы кукуруза?")) {
    throw new Error("Classifier did not receive the boundary policy and current message");
  }
});

Deno.test("classifier keeps a genuine follow-up and pending clarification context", async () => {
  const result = await classifyConversationBoundary(
    "второй",
    prior,
    { pending_clarification: { status: "pending", question: "Какой вариант?", options: ["первый", "второй"] } },
    {
      apiKey: "test",
      model: "test-model",
      fetchImpl: async () => new Response(JSON.stringify({
        choices: [{ message: { content: '{"mode":"continuation","confidence":0.99,"reason":"answers pending choice"}' } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    },
  );
  assertEquals(result.mode, "continuation");
  assertEquals(shouldStartNewConversation(result), false);
});

Deno.test("classifier failure preserves context instead of causing a regression", async () => {
  const result = await classifyConversationBoundary(
    "а дешевле?",
    prior,
    {},
    {
      apiKey: "test",
      model: "test-model",
      fetchImpl: async () => new Response("unavailable", { status: 503 }),
    },
  );
  assertEquals(result, {
    mode: "continuation",
    confidence: 0,
    reason: "classifier_http_503",
    source: "fallback",
  });
});
