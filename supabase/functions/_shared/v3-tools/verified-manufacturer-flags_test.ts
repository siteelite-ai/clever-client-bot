import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { verifiedManufacturerFactsEnabled } from "./verified-manufacturer-flags.ts";

Deno.test("verified manufacturer facts use the isolated access lane, not provider policy", () => {
  const readEnv = (name: string) =>
    ({
      VOLT220_VERIFIED_FACTS_PREVIEW_ENABLED: "true",
      VOLT220_VERIFIED_FACTS_PRODUCTION_ENABLED: "false",
    } as Record<string, string>)[name];
  assertEquals(verifiedManufacturerFactsEnabled("preview", readEnv), true);
  assertEquals(verifiedManufacturerFactsEnabled("production", readEnv), false);

  const productionOnly = (name: string) =>
    ({
      VOLT220_VERIFIED_FACTS_PRODUCTION_ENABLED: "true",
    } as Record<string, string>)[name];
  assertEquals(
    verifiedManufacturerFactsEnabled("preview", productionOnly),
    false,
  );
  assertEquals(
    verifiedManufacturerFactsEnabled("production", productionOnly),
    true,
  );
  assertEquals(
    verifiedManufacturerFactsEnabled("preview", () => undefined),
    false,
  );
  assertEquals(
    verifiedManufacturerFactsEnabled("production", () => undefined),
    false,
  );
  assertEquals(
    verifiedManufacturerFactsEnabled("preview", () => "TRUE"),
    false,
  );
});
