import type { ChatV3AdmissionScope } from "./chat-admission.ts";

/** Feature rollout follows the server-owned access lane, not the model provider
 * variant: closure-preview intentionally uses production provider behavior. */
export function verifiedManufacturerFactsEnabled(
  scope: ChatV3AdmissionScope,
  readEnv: (name: string) => string | undefined = (name) => Deno.env.get(name),
): boolean {
  const name = scope === "preview"
    ? "VOLT220_VERIFIED_FACTS_PREVIEW_ENABLED"
    : "VOLT220_VERIFIED_FACTS_PRODUCTION_ENABLED";
  return readEnv(name) === "true";
}

/** A direct-analog certificate needs the separately enabled manufacturer-fact
 * lane. Both switches are server-owned and default off for every access lane. */
export function directAnalogProofEnabled(
  scope: ChatV3AdmissionScope,
  readEnv: (name: string) => string | undefined = (name) => Deno.env.get(name),
): boolean {
  const name = scope === "preview"
    ? "VOLT220_DIRECT_ANALOG_PROOF_PREVIEW_ENABLED"
    : "VOLT220_DIRECT_ANALOG_PROOF_PRODUCTION_ENABLED";
  return verifiedManufacturerFactsEnabled(scope, readEnv) &&
    readEnv(name) === "true";
}
