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
