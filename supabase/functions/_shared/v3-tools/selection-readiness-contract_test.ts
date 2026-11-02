import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  customerOwnsReadinessQuote,
  mandatorySelectionReadinessEnabled,
  resolveMandatorySelectionReadiness,
  selectionReadinessInputDiagnostics,
} from "./selection-readiness-contract.ts";
import {
  buildDerivedSelectionReasoningMessages,
  buildDerivedSelectionReasoningToolSchema,
} from "./selection-actionability.ts";
import { structuredMeasurementTool } from "./structured-measurement-declaration.ts";

const context = {
  request: "Подбери крепление для стены",
  customerEvidence: "Подбери крепление для стены",
  requiresApplicationInputs: true,
  category: "Крепления",
  facets: [],
};
const unknown = {
  parameter: "Материал основания",
  customer_quote: "",
  question: "Из какого материала сделано основание?",
  impact: "От материала зависит физическая совместимость крепления.",
};
const args = (decision: string, critical_inputs: unknown[]) => ({
  selection_readiness: { decision, critical_inputs },
});
Deno.test("readiness diagnostics show declared input ownership without logging private reasoning", () => {
  const value = { ...args("ready", [{ parameter: "Материал", customer_quote: "стены", question: "" }, { parameter: "Соединение", customer_quote: "SDS Plus", question: "" }]), reasoning: "private planning must not be logged" };
  assertEquals(selectionReadinessInputDiagnostics(value, context.customerEvidence), [
    { parameter: "Материал", customer_quote: "стены", quote_owned: true, question: "" },
    { parameter: "Соединение", customer_quote: "SDS Plus", quote_owned: false, question: "" },
  ]);
  assertEquals(selectionReadinessInputDiagnostics({}, ""), []);
  const bounded = selectionReadinessInputDiagnostics(args("ready", Array(12).fill({ parameter: "x".repeat(200), customer_quote: "<quote>\n", question: "q".repeat(500) })), "");
  assertEquals(bounded.length, 8);
  assertEquals(bounded[0].parameter?.length, 100);
  assertEquals(bounded[0].question?.length, 400);
  assertEquals(bounded[0].customer_quote?.includes("<"), false);
});

Deno.test("mandatory decision cannot be omitted or bypassed by a ready label and an unknown input", () => {
  assertEquals(resolveMandatorySelectionReadiness({}, context), {
    status: "invalid",
    reason: "missing_readiness_decision",
  });
  const decision = resolveMandatorySelectionReadiness(
    args("ready", [unknown]),
    context,
  );
  assertEquals(decision.status, "needs_input");
  if (decision.status !== "needs_input") return;
  assertEquals(decision.clarification.question, unknown.question);
  assertEquals(decision.clarification.scope?.token, context.request);
  assertEquals(decision.clarification.options, []);
  assertEquals(decision.missing, 1);
});

Deno.test("catalog/model assumptions are not customer facts even when plausible", () => {
  assertEquals(
    resolveMandatorySelectionReadiness(
      args("ready", [{ ...unknown, customer_quote: "Бетон" }]),
      context,
    ),
    { status: "invalid", reason: "unowned_customer_quote" },
  );
  assertEquals(resolveMandatorySelectionReadiness(args("ready", []), context), {
    status: "invalid",
    reason: "application_inputs_omitted",
  });
  for (const quote of ["8", "бетон", "220 В"]) {
    assertEquals(
      customerOwnsReadinessQuote(quote, "380 мм, газобетон, 1220 В"),
      false,
      quote,
    );
  }
});

Deno.test("verified customer answers unlock the same product task without inventing new criteria", () => {
  const completed = {
    ...context,
    request: context.request + "\nУточнение клиента: Бетон",
    customerEvidence: context.request + "\nУточнение клиента: Бетон",
  };
  const decision = resolveMandatorySelectionReadiness(
    args("ready", [{ ...unknown, customer_quote: "Бетон", question: "" }]),
    completed,
  );
  assertEquals(decision, { status: "ready", known: 1, missing: 0 });
  assertEquals(customerOwnsReadinessQuote("бетон", "БЕТОН"), true);
  assertEquals(customerOwnsReadinessQuote("8 мм", "диаметр 8  мм"), true);
});

Deno.test("one missing axis per turn and previously answered axes are not asked again", () => {
  const known = { ...unknown, customer_quote: "Бетон", question: "" };
  const missing = {
    ...unknown,
    parameter: "Диаметр",
    question: "Какой диаметр вам нужен?",
  };
  const later = {
    ...unknown,
    parameter: "Тип подключения",
    question: "Какой тип подключения нужен?",
  };
  const decision = resolveMandatorySelectionReadiness(
    args("needs_input", [known, missing, later]),
    {
      ...context,
      request: context.request + " Бетон",
      customerEvidence: context.request + " Бетон",
    },
  );
  assertEquals(decision.status, "needs_input");
  if (decision.status !== "needs_input") return;
  assertEquals(decision.known, 1);
  assertEquals(decision.missing, 2);
  assertEquals(decision.clarification.question, missing.question);
});

Deno.test("plain assortment and exact lookup need no invented customer questionnaire", () => {
  assertEquals(
    resolveMandatorySelectionReadiness(args("ready", []), {
      ...context,
      requiresApplicationInputs: false,
    }),
    { status: "ready", known: 0, missing: 0 },
  );
  assertEquals(
    resolveMandatorySelectionReadiness(args("needs_input", []), {
      ...context,
      requiresApplicationInputs: false,
    }),
    { status: "invalid", reason: "needs_input_without_missing_fact" },
  );
});

Deno.test("malformed and contradictory declarations cannot reopen search", () => {
  const invalids = [
    args("unknown", []),
    args("ready", [{ ...unknown, impact: "" }]),
    args("needs_input", [unknown, unknown]),
    args("needs_input", [{ ...unknown, question: "Первый? Второй?" }]),
    {
      selection_readiness: {
        decision: "ready",
        critical_inputs: [],
        extra: true,
      },
    },
  ];
  for (const input of invalids) {
    assertEquals(
      resolveMandatorySelectionReadiness(input, context).status,
      "invalid",
    );
  }
  assertEquals(
    resolveMandatorySelectionReadiness({
      ...args("ready", []),
      clarification: {},
    }, { ...context, requiresApplicationInputs: false }),
    { status: "invalid", reason: "ready_with_clarification" },
  );
});

Deno.test("question renderer retains live chips only for the same missing axis", () => {
  const proposal = {
    question: unknown.question,
    facet_key: "material",
    options: [{ value: "Бетон" }, { value: "Кирпич" }],
    blocking_input: {
      reason: "missing_customer_input",
      parameter: unknown.parameter,
      impact: unknown.impact,
    },
  };
  const live = {
    ...context,
    facets: [{
      key: "material",
      values: [{ value: "Бетон" }, { value: "Кирпич" }],
    }],
  };
  const accepted = resolveMandatorySelectionReadiness({
    ...args("needs_input", [unknown]),
    clarification: proposal,
  }, live);
  assert(accepted.status === "needs_input");
  assertEquals(accepted.clarification.options.length, 2);
  const wrongAxis = resolveMandatorySelectionReadiness({
    ...args("needs_input", [unknown]),
    clarification: {
      ...proposal,
      blocking_input: { ...proposal.blocking_input, parameter: "Цвет" },
    },
  }, live);
  assert(wrongAxis.status === "needs_input");
  assertEquals(wrongAxis.clarification.question, unknown.question);
  assertEquals(wrongAxis.clarification.options, []);
});

Deno.test("mandatory schema is opt-in and survives the existing structured measurement adapter", () => {
  const legacy = buildDerivedSelectionReasoningToolSchema([]);
  assertEquals(
    (legacy.function.parameters.required as string[]).includes(
      "selection_readiness",
    ),
    false,
  );
  const strict = buildDerivedSelectionReasoningToolSchema([], "", null, {
    requireReadiness: true,
  });
  assert(
    (strict.function.parameters.required as string[]).includes(
      "selection_readiness",
    ),
  );
  assert(
    (structuredMeasurementTool(strict).function.parameters.required as string[])
      .includes("selection_readiness"),
  );
  assert(
    (strict.function.parameters.required as string[]).includes(
      "required_facet_values",
    ),
  );
  const oldPrompt =
    buildDerivedSelectionReasoningMessages(context.request, "Крепления", [])[0]
      .content;
  const strictPrompt = buildDerivedSelectionReasoningMessages(
    context.request,
    "Крепления",
    [],
    null,
    { requireReadiness: true },
  )[0].content;
  assert(oldPrompt.includes("выбери один обоснованный рекомендуемый вариант"));
  assert(
    !strictPrompt.includes("выбери один обоснованный рекомендуемый вариант"),
  );
  assert(strictPrompt.includes("ОБЯЗАТЕЛЬНО заполни selection_readiness"));
});

Deno.test("an explicit statement of not knowing a fact is not readiness evidence", () => {
  const decision = resolveMandatorySelectionReadiness(
    args("ready", [{ ...unknown, customer_quote: "не знаю" }]),
    { ...context, customerEvidence: context.request + ". Материал не знаю" },
  );
  assertEquals(decision.status, "needs_input");
});

Deno.test("mandatory rollout cannot be enabled by a request or an unrelated QA marker", () => {
  const previousGet = Deno.env.get;
  const globals = globalThis as typeof globalThis & {
    __VOLT220_SELECTION_READINESS_CONTRACT__?: string;
    __VOLT220_CLOSURE_TEST_SCOPE__?: string;
  };
  const previousMarker = globals.__VOLT220_SELECTION_READINESS_CONTRACT__,
    previousClosure = globals.__VOLT220_CLOSURE_TEST_SCOPE__;
  try {
    Deno.env.get = () => undefined;
    delete globals.__VOLT220_SELECTION_READINESS_CONTRACT__;
    globals.__VOLT220_CLOSURE_TEST_SCOPE__ = "closure_preview";
    assertEquals(
      (mandatorySelectionReadinessEnabled as (...args: unknown[]) => boolean)({
        selection_readiness_required: true,
        __VOLT220_SELECTION_READINESS_CONTRACT__: "required",
      }),
      false,
    );
    globals.__VOLT220_SELECTION_READINESS_CONTRACT__ = "required";
    assertEquals(mandatorySelectionReadinessEnabled(), true);
    delete globals.__VOLT220_SELECTION_READINESS_CONTRACT__;
    Deno.env.get = (key) =>
      key === "VOLT220_SELECTION_READINESS_REQUIRED" ? "true" : undefined;
    assertEquals(mandatorySelectionReadinessEnabled(), true);
  } finally {
    Deno.env.get = previousGet;
    if (previousMarker === undefined) {
      delete globals.__VOLT220_SELECTION_READINESS_CONTRACT__;
    } else globals.__VOLT220_SELECTION_READINESS_CONTRACT__ = previousMarker;
    if (previousClosure === undefined) {
      delete globals.__VOLT220_CLOSURE_TEST_SCOPE__;
    } else globals.__VOLT220_CLOSURE_TEST_SCOPE__ = previousClosure;
  }
});
