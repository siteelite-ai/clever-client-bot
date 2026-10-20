import {
  assert,
  assertMatch,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * These source-order tests guard the production handler wiring. The range
 * calculator has separate value-level tests, but a correct calculator alone
 * cannot prevent an earlier model-repair branch from stopping the search.
 */
const handler = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

function position(marker: string, after = 0): number {
  const at = handler.indexOf(marker, after);
  assert(at >= 0, `production handler is missing ${marker}`);
  return at;
}

Deno.test("a certified live IP range is known before deciding whether to repair model reasoning", () => {
  const range = position(
    "const environmentalRange = deriveEnvironmentalProtectionRange(",
  );
  const repairGuard = position(
    "const missingEnvironmentalProtection = () =>",
    range,
  );
  const repairDecision = position(
    "const needsEnvironmentalProtectionRetry =",
    repairGuard,
  );
  const correctionAttempt = position(
    "const correctionAttempt = (timeoutMs: number) =>",
    repairDecision,
  );
  const repairCall = position("return callOpenRouter(", correctionAttempt);
  const repairAssignment = position(
    'structuredReasoning = repairReason === "product_measurement"',
    repairCall,
  );
  assert(range < repairGuard && repairGuard < repairDecision);
  assert(repairDecision < correctionAttempt && correctionAttempt < repairCall);
  assert(repairCall < repairAssignment);

  // A range is the *only* new exception: the existing obligation checker
  // still owns ambiguous/no-live-facet cases and customer-exact IP requests.
  const guard = handler.slice(
    repairGuard,
    position("const stopForUnverifiedProtection =", repairGuard),
  );
  assertMatch(
    guard,
    /environmentalRange\.status !== "enumerated"\s*&&\s*hasUnresolvedEnvironmentalProtectionObligation\(\s*userMessage,/u,
  );

  // If the live schema cannot certify a complete range, no card may escape
  // merely because the model happened to name one plausible IP value.
  const unresolved = position(
    'if (environmentalRange.status === "unresolved")',
    repairCall,
  );
  const searchPlan = position("const environmentalRangeCriteria:", unresolved);
  const failClosed = handler.slice(unresolved, searchPlan);
  assert(failClosed.includes("return stopForUnverifiedProtection()"));
});

Deno.test("an IP range remains an exact live OR through the final catalog call", () => {
  const searchGuard = position(
    'tc.name === "search_catalog" && certifiedEnvironmentalRange &&',
  );
  const execution = position(
    "await runTool(tc.name, runArgs, ctx)",
    searchGuard,
  );
  const guard = handler.slice(searchGuard, execution);

  assert(guard.includes("deriveEnvironmentalProtectionRange("));
  assert(guard.includes('liveRange.status !== "enumerated"'));
  assert(guard.includes("sameValues(liveRange.acceptedValues)"));
  assert(guard.includes("sameValues(frozenProtection)"));
  assert(guard.includes("overlayMandatoryFacetOptions("));
  assert(guard.includes("expandOptionAlternatives("));
  assert(guard.includes("v3_environmental_protection_range_capacity_rejected"));
  assert(guard.includes("gateShortCircuit = {"));
});
