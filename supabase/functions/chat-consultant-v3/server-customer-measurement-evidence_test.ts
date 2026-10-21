import {
  assert,
  assertEquals,
  assertFalse,
  assertMatch,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createClient,
  type SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { filterPerProductMeasuredCriteria } from "../_shared/v3-tools/criteria-reasoning.ts";

// Import the real pure/DB-bound helpers without opening an HTTP socket.
const originalServe = Deno.serve;
const originalEnvGet = Deno.env.get;
Deno.serve = (() => ({
  finished: Promise.resolve(),
  shutdown() {},
})) as unknown as typeof Deno.serve;
// CI deliberately grants no environment access to safeguards tests. Importing
// the handler must not require production credentials just to exercise these
// exported helpers; restore both process APIs before any test runs.
Deno.env.get = (() => undefined) as typeof Deno.env.get;
const {
  composeVerifiedCustomerMeasurementEvidence,
  loadVerifiedCustomerMeasurementEvidence,
} = await import("./index.ts").finally(() => {
  Deno.serve = originalServe;
  Deno.env.get = originalEnvGet;
});

interface LogRow {
  id: string;
  session_id: string;
  user_query: string;
  error: string | null;
  created_at: string;
  response_events?: unknown;
}

function serverLogClient(
  sessionRows: LogRow[],
  boundary: LogRow | null,
  fail = false,
): { client: SupabaseClient; calls: () => number } {
  let calls = 0;
  const client = {
    from(table: string) {
      assertEquals(table, "chat_request_logs");
      const boundaryQuery = ++calls === 2;
      const builder = {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        neq() {
          return this;
        },
        gte() {
          return this;
        },
        lt() {
          return this;
        },
        order() {
          return this;
        },
        limit() {
          return this;
        },
        filter(column: string, operator: string, serialized: string) {
          assertEquals(column, "response_events");
          assertEquals(operator, "cs");
          assertEquals(JSON.parse(serialized), [{
            type: "conversation_boundary",
            mode: "new_task",
            session_id: "session-current",
          }]);
          return this;
        },
        maybeSingle() {
          return Promise.resolve({
            data: boundary,
            error: fail ? { message: "unavailable" } : null,
          });
        },
        then(resolve: (value: unknown) => void) {
          return Promise.resolve({
            data: boundaryQuery ? [] : sessionRows,
            error: fail ? { message: "unavailable" } : null,
          }).then(resolve);
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  return { client, calls: () => calls };
}

function row(
  id: string,
  query: string,
  sessionId = "session-current",
  responseEvents: unknown = [],
): LogRow {
  return {
    id,
    session_id: sessionId,
    user_query: query,
    error: null,
    created_at: new Date(Date.now() - 1_000).toISOString(),
    response_events: responseEvents,
  };
}

const boundaryEvent = {
  type: "conversation_boundary",
  mode: "new_task",
  session_id: "session-current",
};

Deno.test("rotated-session evidence lookup serializes a JSONB containment filter", () => {
  const client = createClient("https://example.invalid", "test-key", {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  try {
    const query = client.from("chat_request_logs")
      .select("user_query")
      .filter("response_events", "cs", JSON.stringify([boundaryEvent]));
    const value = (query as unknown as { url: URL }).url.searchParams.get(
      "response_events",
    );
    assertEquals(value, `cs.${JSON.stringify([boundaryEvent])}`);
  } finally {
    client.auth.stopAutoRefresh();
  }
});

Deno.test("initial request and a new topic never read or inherit prior measurements", async () => {
  const { client, calls } = serverLogClient([
    row("old", "не менее 4000 лм"),
  ], null);
  const result = await loadVerifiedCustomerMeasurementEvidence(
    client,
    "session-current",
    "current-log",
    "Новая тема. Нужен светильник на 3000 лм",
    true,
    Date.now(),
  );
  assertEquals(result, {
    text: "Новая тема. Нужен светильник на 3000 лм",
    sourceCount: 0,
    lookupFailed: false,
    priorQueriesNewestFirst: [],
  });
  assertEquals(calls(), 0);
});

Deno.test("same-topic follow-up inherits customer numbers from completed server logs", async () => {
  const { client, calls } = serverLogClient([
    row("prior", "Нужен светильник не менее 3000 лм"),
  ], null);
  const result = await loadVerifiedCustomerMeasurementEvidence(
    client,
    "session-current",
    "current-log",
    "А ещё варианты?",
    false,
    Date.now(),
  );
  assertEquals(calls(), 2);
  assertEquals(result.sourceCount, 1);
  assertEquals(result.priorQueriesNewestFirst, [
    "Нужен светильник не менее 3000 лм",
  ]);
  assertMatch(result.text, /Нужен светильник не менее 3000 лм/u);
  assertFalse(result.lookupFailed);
});

Deno.test("repeated follow-ups retain the initial number across a rotated session", async () => {
  const { client } = serverLogClient(
    [row("intermediate", "А ещё?")],
    row("origin", "Нужен светильник на 3000 лм", "old-session", [
      boundaryEvent,
    ]),
  );
  const result = await loadVerifiedCustomerMeasurementEvidence(
    client,
    "session-current",
    "current-log",
    "А ещё?",
    false,
    Date.now(),
  );
  assertEquals(result.sourceCount, 1);
  assertEquals(result.priorQueriesNewestFirst, [
    "А ещё?",
    "Нужен светильник на 3000 лм",
  ]);
  assertMatch(result.text, /Нужен светильник на 3000 лм/u);
  assertFalse(result.lookupFailed);
});

Deno.test("current explicit value overrides older value on the same physical scale", () => {
  const result = composeVerifiedCustomerMeasurementEvidence(
    "Нет, теперь не менее 3000 люмен",
    ["Нужно не менее 4000 лм", "Площадь гостиной 25 м²"],
  );
  assertFalse(result.text.includes("4000"));
  assertMatch(result.text, /25 м²/u);
  assertEquals(result.sourceCount, 1);
});

Deno.test("failed server-log read never upgrades client history to numeric authority", async () => {
  const { client } = serverLogClient([], null, true);
  const result = await loadVerifiedCustomerMeasurementEvidence(
    client,
    "session-current",
    "current-log",
    "А ещё?",
    false,
    Date.now(),
  );
  assertEquals(result.text, "А ещё?");
  assertEquals(result.sourceCount, 0);
  assert(result.lookupFailed);
});

Deno.test("unitless exact live facet cannot bypass measured source authority", async () => {
  const facet = {
    key: "power",
    caption: "Мощность",
    type: "number",
    unit: "Вт",
    values: [{ value: "100" }],
  };
  const criterion = {
    key: "Мощность",
    op: "eq" as const,
    value: "100",
    level: "A" as const,
    evidence: "derived_required" as const,
  };
  const modelOnly = filterPerProductMeasuredCriteria(
    [criterion],
    "Возьму модель мощностью 100 Вт",
    "Покажи варианты",
    null,
    [facet],
  );
  assertEquals(modelOnly.criteria.length, 0);
  assertEquals(modelOnly.removed.length, 1);
  const source = await Deno.readTextFile(
    new URL("./index.ts", import.meta.url),
  );
  assertMatch(
    source,
    /const scopedDerivedMandatory = filterPerProductMeasuredCriteria\([\s\S]*?effectiveDeclaredMeasurementScope,\s*lastDiscover\?\.facets \?\? \[\]/u,
  );
});
