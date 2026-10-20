import {
  assertEquals,
  assertNotEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

function responseEventsFilter(value: string | Record<string, string>[]): string {
  const client = createClient("https://example.invalid", "test-key", {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  try {
    const query = client.from("chat_request_logs")
      .select("response_events")
      .contains("response_events", value);
    return (query as unknown as { url: URL }).url.searchParams.get(
      "response_events",
    ) ?? "";
  } finally {
    client.auth.stopAutoRefresh();
  }
}

Deno.test("rotated-session JSONB boundary has a valid PostgREST filter", () => {
  const boundary = {
    type: "conversation_boundary",
    mode: "new_task",
    session_id: "68ea1999-b0e9-4fe3-b881-6a7e8e86fa4b",
  };
  const serialized = responseEventsFilter(JSON.stringify([boundary]));
  assertEquals(serialized, `cs.${JSON.stringify([boundary])}`);
  assertEquals(JSON.parse(serialized.slice(3)), [boundary]);

  // Supabase's array overload is for PostgreSQL arrays, not JSONB arrays.
  // This was the actual 22P02-producing filter on the fresh-session fallback.
  const wrong = responseEventsFilter([boundary]);
  assertEquals(wrong, "cs.{[object Object]}");
  assertNotEquals(serialized, wrong);
});

Deno.test("every rotated-boundary lookup serializes the same JSONB argument", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const all = [...source.matchAll(/\.contains\(\s*"response_events"/g)];
  const serialized = [...source.matchAll(
    /\.contains\(\s*"response_events",\s*conversationBoundaryJsonbContainment\(sessionId\),?\s*\)/g,
  )];
  // Includes the server-issued replacement-cutout recovery lookup.
  assertEquals(all.length, 4);
  assertEquals(serialized.length, all.length);
  assertEquals(source.includes("return JSON.stringify([{"), true);
});
