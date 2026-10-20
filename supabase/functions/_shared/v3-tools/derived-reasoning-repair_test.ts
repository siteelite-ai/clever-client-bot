import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  chooseDerivedReasoningRepair,
  INVALID_DERIVED_DECLARATION_CORRECTION,
} from "./derived-reasoning-repair.ts";
import { resolveDerivedSelectionReasoning } from "./selection-actionability.ts";

Deno.test("a rejected declaration gets one bounded retry without a safety-specific gap", () => {
  const unresolved = resolveDerivedSelectionReasoning(
    {
      reasoning: "Нужен прожектор.",
      measurement_scope: "system_total",
    },
    [],
    "Прожектор для двора площадью до 50 м²",
    "Прожекторы",
  );
  assertEquals(unresolved, null);
  assertEquals(
    chooseDerivedReasoningRepair({
      resolvedText: unresolved?.text,
      environmentalProtectionMissing: false,
      pairedFitMissing: false,
      productMeasurementMissing: false,
      providerAttempts: 1,
    }),
    "invalid_declaration",
  );
  // A provider can return hundreds of prose characters yet omit the forced
  // tool call entirely. It has the same unresolved contract at this gate.
  assertEquals(
    chooseDerivedReasoningRepair({
      resolvedText: null,
      environmentalProtectionMissing: false,
      pairedFitMissing: false,
      productMeasurementMissing: false,
      providerAttempts: 1,
    }),
    "invalid_declaration",
  );
  assertEquals(
    chooseDerivedReasoningRepair({
      resolvedText: unresolved?.text,
      environmentalProtectionMissing: false,
      pairedFitMissing: true,
      productMeasurementMissing: false,
      providerAttempts: 1,
    }),
    "paired_fit",
  );
  assertEquals(
    chooseDerivedReasoningRepair({
      resolvedText: unresolved?.text,
      environmentalProtectionMissing: false,
      pairedFitMissing: false,
      productMeasurementMissing: false,
      providerAttempts: 2,
    }),
    null,
  );
});

Deno.test("the handler wires invalid repair to its own telemetry and a safe terminal", async () => {
  const source = await Deno.readTextFile(
    new URL("../../chat-consultant-v3/index.ts", import.meta.url),
  );
  assertStringIncludes(
    source,
    "const repairReason = chooseDerivedReasoningRepair({",
  );
  assertStringIncludes(
    source,
    "? INVALID_DERIVED_DECLARATION_CORRECTION",
  );
  assertStringIncludes(
    source,
    '"v3_derived_selection_reasoning_contract_retry"',
  );
  assertStringIncludes(
    source,
    "Не буду показывать неподтверждённые варианты; повторите запрос",
  );
});

Deno.test("a failed invalid-declaration retry is logged and fails closed without swallowing cancellation", async () => {
  const source = await Deno.readTextFile(
    new URL("../../chat-consultant-v3/index.ts", import.meta.url),
  );
  const catchStart = source.indexOf("} catch (correctionError) {");
  const catchEnd = source.indexOf(
    "derivedReasoningProviderAttempts += 1;",
    catchStart,
  );
  assertEquals(catchStart >= 0 && catchEnd > catchStart, true);
  const retryFailureBranch = source.slice(catchStart, catchEnd);
  assertStringIncludes(retryFailureBranch, "turnController.signal.aborted");
  assertStringIncludes(
    retryFailureBranch,
    'correctionFailure.kind === "request_aborted"',
  );
  assertStringIncludes(
    retryFailureBranch,
    'if (repairReason === "invalid_declaration")',
  );
  assertStringIncludes(
    retryFailureBranch,
    'step: "v3_derived_selection_reasoning_contract_retry_failed"',
  );
  assertStringIncludes(retryFailureBranch, "error_category: correctionFailure.kind");
  assertStringIncludes(
    retryFailureBranch,
    "return stopForInvalidDerivedDeclaration();",
  );
  // The same terminal is used when the retry returns an unusable declaration;
  // both paths emit one honest notice and never expose unverified cards.
  assertEquals(
    source.match(/return stopForInvalidDerivedDeclaration\(\);/gu)?.length,
    2,
  );
});

Deno.test("valid declarations keep the existing environment, pair and measurement priority", () => {
  const base = {
    resolvedText: "Проверю обязательные параметры товара.",
    environmentalProtectionMissing: false,
    pairedFitMissing: false,
    productMeasurementMissing: false,
    providerAttempts: 1,
  };
  assertEquals(chooseDerivedReasoningRepair(base), null);
  assertEquals(
    chooseDerivedReasoningRepair({
      ...base,
      environmentalProtectionMissing: true,
      pairedFitMissing: true,
      productMeasurementMissing: true,
    }),
    "environmental_protection",
  );
  assertEquals(
    chooseDerivedReasoningRepair({
      ...base,
      pairedFitMissing: true,
      productMeasurementMissing: true,
    }),
    "paired_fit",
  );
  assertEquals(
    chooseDerivedReasoningRepair({ ...base, productMeasurementMissing: true }),
    "product_measurement",
  );
});

Deno.test("invalid-declaration correction requests schema fields without inventing product criteria", () => {
  for (
    const field of [
      "declare_selection_reasoning",
      "reasoning",
      "measurement_scope",
      "compatible_classifications",
      "excluded_classifications",
      "required_facet_values",
      "explicit_customer_classifications",
    ]
  ) assertStringIncludes(INVALID_DERIVED_DECLARATION_CORRECTION, field);
  assertStringIncludes(
    INVALID_DERIVED_DECLARATION_CORRECTION,
    "Не добавляй числовой порог только ради заполнения контракта.",
  );
  assertStringIncludes(
    INVALID_DERIVED_DECLARATION_CORRECTION,
    "убери неподтверждённые измерения, значения и классификации",
  );
});
