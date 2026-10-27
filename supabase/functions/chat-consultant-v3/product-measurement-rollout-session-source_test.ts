import {
  assert,
  assertMatch,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("new-task session rotation does not randomize the Pro rollout bucket", () => {
  const incoming = source.indexOf(
    "const sessionId = body.sessionId ?? crypto.randomUUID();",
  );
  const rotated = source.indexOf(
    "const effectiveSessionId = startsNewTask",
    incoming,
  );
  const context = source.indexOf("const ctx: ToolContext = {", rotated);
  const rollout = source.indexOf("productMeasurementProCorrectionEnabled({");
  assert(
    incoming >= 0 && rotated > incoming && context > rotated && rollout >= 0,
  );

  assertMatch(
    source.slice(rotated, context),
    /const effectiveSessionId = startsNewTask\s*\? `session_\$\{crypto\.randomUUID\(\)\}`\s*: sessionId;/u,
  );
  assertMatch(
    source.slice(context, source.indexOf("};", context)),
    /sessionId: effectiveSessionId,\s*rolloutSessionId: sessionId,/u,
  );
  assertMatch(
    source.slice(rollout, source.indexOf("});", rollout)),
    /sessionId: ctx\.rolloutSessionId,/u,
  );
});
