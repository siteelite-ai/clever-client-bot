import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { verifiedOutputOutcome } from "./verified-output-outcome.ts";

Deno.test("verified results, provider failure and output failure are distinct", () => {
  assertEquals(verifiedOutputOutcome({ catalogUnavailable: true, selected: 0, rendered: false }), "catalog_unavailable");
  assertEquals(verifiedOutputOutcome({ catalogUnavailable: false, selected: 0, rendered: false }), "no_verified_cards");
  assertEquals(verifiedOutputOutcome({ catalogUnavailable: false, selected: 2, rendered: false }), "render_unavailable");
  assertEquals(verifiedOutputOutcome({ catalogUnavailable: false, selected: 2, rendered: true }), "shown");
  assertEquals(verifiedOutputOutcome({ catalogUnavailable: true, selected: 1, rendered: true }), "shown");
});
