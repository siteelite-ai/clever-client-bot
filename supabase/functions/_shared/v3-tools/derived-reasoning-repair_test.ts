import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  chooseDerivedReasoningRepair,
  classifyRequiredProductMeasurementGap,
  INVALID_DERIVED_DECLARATION_CORRECTION,
} from "./derived-reasoning-repair.ts";
import {
  compileMeasuredReasoningSearchContract,
  filterPerProductMeasuredCriteria,
  projectSingleRecommendedMeasuredCriterion,
} from "./criteria-reasoning.ts";
import {
  classifyPublicFailure,
  retryConfirmedUpstreamHttp5xxOnce,
  UpstreamHttpError,
} from "./public-failure.ts";
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

Deno.test("initial reasoning retains timeout recovery but never retries an HTTP 200 synthetic 502", async () => {
  const source = await Deno.readTextFile(
    new URL("../../chat-consultant-v3/index.ts", import.meta.url),
  );
  const start = source.indexOf("} catch (reasoningError) {");
  const end = source.indexOf("const cleanDeclarationCall = (", start);
  assertEquals(start >= 0 && end > start, true);
  const retryBranch = source.slice(start, end);
  assertStringIncludes(retryBranch, 'name === "TimeoutError"');
  assertStringIncludes(retryBranch, 'includes("llm_call_timeout:")');
  assertStringIncludes(
    retryBranch,
    "!(reasoningError instanceof UpstreamHttpError)",
  );
  assertStringIncludes(
    retryBranch,
    "isConfirmedTransientUpstreamHttp5xx(reasoningError)",
  );
  assertEquals(retryBranch.includes("reasoningError.status >= 500"), false);
});

Deno.test("only product-measurement real-HTTP recovery may use a third logical model call", async () => {
  const repairInput = {
    resolvedText: "Рекомендованный минимум товара ещё не спроецирован.",
    environmentalProtectionMissing: false,
    pairedFitMissing: false,
    productMeasurementMissing: true,
    providerAttempts: 1,
  };
  assertEquals(
    chooseDerivedReasoningRepair(repairInput),
    "product_measurement",
  );
  let providerAttempts = 1;
  const firstCorrectionFailure = new UpstreamHttpError(503, "provider outage", {
    origin: "http_response",
    observedHttpStatus: 503,
  });
  const result = await retryConfirmedUpstreamHttp5xxOnce({
    attempt: async () => {
      providerAttempts += 1;
      if (providerAttempts === 2) throw firstCorrectionFailure;
      return "corrected";
    },
    initialTimeoutMs: 8_000,
    retryTimeoutMs: () => 3_000,
    signal: new AbortController().signal,
    now: () => 0,
  });
  assertEquals(result, "corrected");
  assertEquals(providerAttempts, 3);
  assertEquals(
    chooseDerivedReasoningRepair({ ...repairInput, providerAttempts }),
    null,
  );
});

Deno.test("the handler wires invalid repair to its own telemetry and a safe terminal", async () => {
  const source = await Deno.readTextFile(
    new URL("../../chat-consultant-v3/index.ts", import.meta.url),
  );
  const repairStart = source.indexOf("const repairReason =");
  const repairEnd = source.indexOf("if (repairReason) {", repairStart);
  assertEquals(repairStart >= 0 && repairEnd > repairStart, true);
  const repairGate = source.slice(repairStart, repairEnd);
  assertStringIncludes(repairGate, "chooseDerivedReasoningRepair({");
  assertEquals(
    /DERIVED_REASONING_LOVABLE_RETRY_ENABLED\s*&&\s*derivedReasoningProviderAttempts\s*>=\s*2\s*\?\s*null\s*:\s*chooseDerivedReasoningRepair\(\{/u
      .test(repairGate),
    true,
  );
  assertStringIncludes(
    repairGate,
    "providerAttempts: derivedReasoningProviderAttempts,",
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
    "declarationCall = cleanDeclarationCall(",
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
  assertStringIncludes(
    retryFailureBranch,
    "error_category: correctionFailure.kind",
  );
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

Deno.test("a valid declaration without an enforceable product measurement stays unverified", () => {
  const facets = [{
    key: "rated",
    caption: "Номинальная мощность, Вт",
    type: "number",
    unit: "Вт",
    values: [{ value: "250" }, { value: "300" }],
  }];
  const customer = "Нужен прибор для оборудования мощностью 250 Вт";
  const args = {
    reasoning:
      "Для применения проверяю подходящее значение характеристики каждого товара по живому каталогу.",
    measurement_scope: "per_product",
    compatible_classifications: [],
    excluded_classifications: [],
    required_facet_values: [],
    explicit_customer_classifications: [],
  };
  const unresolved = resolveDerivedSelectionReasoning(
    args,
    facets,
    customer,
    "Приборы",
  );
  assertEquals(Boolean(unresolved?.text), true);
  const projected = compileMeasuredReasoningSearchContract(
    [],
    unresolved!.measurementEvidence,
    [],
    facets,
    { measurementScope: unresolved!.measurementScope, customerText: customer },
  );
  assertEquals(projected.mandatory_criteria, []);
  const base = {
    required: true,
    measurementScope: unresolved!.measurementScope,
    pairedFitProven: false,
    scalarProjectionAllowed: true,
    mandatoryMeasuredCriterionProjected: false,
    competingThresholds: false,
  };
  assertEquals(
    classifyRequiredProductMeasurementGap(base),
    "unprojectable_criterion",
  );
  assertEquals(
    chooseDerivedReasoningRepair({
      resolvedText: unresolved!.text,
      environmentalProtectionMissing: false,
      pairedFitMissing: false,
      productMeasurementMissing: true,
      providerAttempts: 1,
    }),
    "product_measurement",
  );

  // A corrected, customer-authorized recommendation that resolves to a live
  // facet may proceed. The model cannot satisfy the gate with prose alone.
  const corrected = resolveDerivedSelectionReasoning(
    {
      ...args,
      reasoning:
        "Рекомендуется номинальная мощность 250 Вт для оборудования мощностью 250 Вт.",
    },
    facets,
    customer,
    "Приборы",
  );
  assertEquals(Boolean(corrected?.text), true);
  const recommendation = projectSingleRecommendedMeasuredCriterion(
    corrected!.measurementEvidence,
    facets,
  );
  assertEquals(
    filterPerProductMeasuredCriteria(
      recommendation.criterion ? [recommendation.criterion] : [],
      corrected!.measurementEvidence,
      customer,
      corrected!.measurementScope,
      facets,
    ).criteria.length,
    1,
  );
  assertEquals(
    classifyRequiredProductMeasurementGap({
      ...base,
      mandatoryMeasuredCriterionProjected: true,
    }),
    null,
  );
});

Deno.test("competing product thresholds fail closed without affecting totals or certified pairs", () => {
  const crossSentence = projectSingleRecommendedMeasuredCriterion(
    "Минимальная номинальная мощность не менее 250 Вт. Рекомендуется номинальная мощность 300 Вт.",
    [{
      key: "rated",
      caption: "Номинальная мощность, Вт",
      type: "number",
      unit: "Вт",
      values: [{ value: "250" }, { value: "300" }],
    }],
  );
  assertEquals(crossSentence.reason, "competing_values");
  const base = {
    required: true,
    measurementScope: "per_product",
    pairedFitProven: false,
    scalarProjectionAllowed: true,
    mandatoryMeasuredCriterionProjected: true,
    competingThresholds: crossSentence.reason === "competing_values",
  };
  assertEquals(
    classifyRequiredProductMeasurementGap(base),
    "competing_thresholds",
  );
  assertEquals(
    classifyRequiredProductMeasurementGap({
      ...base,
      competingThresholds: false,
    }),
    null,
  );
  assertEquals(
    classifyRequiredProductMeasurementGap({
      ...base,
      mandatoryMeasuredCriterionProjected: false,
      competingThresholds: false,
      scalarProjectionAllowed: false,
    }),
    "unprojectable_criterion",
  );
  assertEquals(
    classifyRequiredProductMeasurementGap({
      ...base,
      mandatoryMeasuredCriterionProjected: false,
      competingThresholds: false,
      independentCardProofCoversRequiredMeasurement: true,
    }),
    null,
  );
  assertEquals(
    classifyRequiredProductMeasurementGap({
      ...base,
      independentCardProofCoversRequiredMeasurement: true,
    }),
    "competing_thresholds",
  );
  assertEquals(
    classifyRequiredProductMeasurementGap({
      ...base,
      measurementScope: "system_total",
    }),
    null,
  );
  assertEquals(
    classifyRequiredProductMeasurementGap({ ...base, pairedFitProven: true }),
    null,
  );
  assertEquals(
    classifyRequiredProductMeasurementGap({ ...base, required: false }),
    null,
  );
});

Deno.test("measurement terminal precedes search and correction failure preserves cancellation", async () => {
  const source = await Deno.readTextFile(
    new URL("../../chat-consultant-v3/index.ts", import.meta.url),
  );
  const catchStart = source.indexOf("} catch (correctionError) {");
  const catchEnd = source.indexOf(
    "declarationCall = cleanDeclarationCall(",
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
    'if (repairReason === "product_measurement")',
  );
  assertStringIncludes(
    retryFailureBranch,
    'step: "v3_product_measurement_correction_failed"',
  );
  assertStringIncludes(
    retryFailureBranch,
    "return stopForUnverifiedProductMeasurement(",
  );
  assertStringIncludes(retryFailureBranch, "correctionFailure,");
  assertStringIncludes(source, "correctionFailure?.customer_message");
  assertStringIncludes(source, "correction_service_failure");
  assertStringIncludes(source, "public_error: correctionFailure.public_code");
  const terminalStart = source.indexOf(
    "const productMeasurementGap = requiredProductMeasurementGap();",
    catchEnd,
  );
  const searchStart = source.indexOf(
    "const directSearchBase:",
    terminalStart,
  );
  assertEquals(terminalStart > catchEnd && searchStart > terminalStart, true);
  assertStringIncludes(
    source.slice(terminalStart, searchStart),
    "return stopForUnverifiedProductMeasurement(productMeasurementGap);",
  );
  assertStringIncludes(source, 'step: "v3_product_measurement_unverified"');
  assertStringIncludes(
    source,
    "replacementIntent || isReplacementProofRequest(userMessage)",
  );
});

Deno.test("real HTTP retry is confined to product-measurement correction and the same proof call", async () => {
  const source = await Deno.readTextFile(
    new URL("../../chat-consultant-v3/index.ts", import.meta.url),
  );
  const correctionStart = source.indexOf(
    "const correctionAttempt = (timeoutMs: number) => {",
  );
  const correctionEnd = source.indexOf(
    "} catch (correctionError) {",
    correctionStart,
  );
  assertEquals(correctionStart >= 0 && correctionEnd > correctionStart, true);
  const correctionCall = source.slice(correctionStart, correctionEnd);
  assertStringIncludes(correctionCall, "runProductMeasurementCorrection({");
  assertEquals(
    /retryEnabled:\s*PRODUCT_MEASUREMENT_HTTP_RETRY_ENABLED\s*&&\s*!DERIVED_REASONING_LOVABLE_RETRY_ENABLED\s*,/u
      .test(correctionCall),
    true,
  );
  assertStringIncludes(correctionCall, "attempt: correctionAttempt,");
  assertStringIncludes(correctionCall, "initialTimeoutMs: correctionTimeout,");
  assertStringIncludes(correctionCall, "DERIVED_REASONING_SOFT_DEADLINE_MS,");
  assertStringIncludes(correctionCall, "MIN_AGENT_STEP_BUDGET_MS,");
  assertStringIncludes(correctionCall, "signal: turnController.signal,");
  const optInStart = source.indexOf(
    "export function runProductMeasurementCorrection<T>(input:",
  );
  const optInEnd = source.indexOf(
    "const LOVABLE_AGENT_FAILOVER_ENABLED",
    optInStart,
  );
  assertEquals(optInStart >= 0 && optInEnd > optInStart, true);
  const optIn = source.slice(optInStart, optInEnd);
  assertStringIncludes(
    optIn,
    'input.repairReason === "product_measurement" && input.retryEnabled',
  );
  assertStringIncludes(optIn, "retryConfirmedUpstreamHttp5xxOnce(input)");
  assertStringIncludes(optIn, "input.attempt(input.initialTimeoutMs)");
  for (
    const mandatoryArg of [
      "correctionMessages,",
      "turnController.signal,",
      '"derived_reasoning",',
      '["declare_selection_reasoning"],',
      '"declare_selection_reasoning",',
      "[reasoningToolSchema],",
      "GENERAL_INQUIRY_MODEL_ROUTING,",
    ]
  ) {
    assertStringIncludes(correctionCall, mandatoryArg);
  }
  assertEquals(
    source.match(/retryConfirmedUpstreamHttp5xxOnce\(input\)/gu)?.length,
    1,
  );
});

Deno.test("failed correction reports temporary service trouble rather than blaming catalog data", () => {
  for (const status of [402, 429, 503]) {
    const failure = classifyPublicFailure(
      new UpstreamHttpError(status, "private provider diagnostic"),
    );
    assertEquals(failure.customer_message.includes("каталог"), false);
    assertEquals(failure.customer_message.includes("повторите"), true);
    assertEquals(failure.public_code.includes("upstream_"), true);
    assertEquals(failure.customer_message.includes("private provider"), false);
  }
});
