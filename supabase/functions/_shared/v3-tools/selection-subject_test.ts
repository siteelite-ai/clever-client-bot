import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  resolveSelectionSubject,
  selectionSubjectSchema,
  type SubjectChoice,
} from "./selection-subject.ts";
import { resolveSelectionClarification } from "./selection-clarification.ts";
import { executeProposeClarification } from "./propose-clarification.ts";
import { buildDerivedSelectionReasoningToolSchema } from "./selection-actionability.ts";
import { structuredMeasurementTool } from "./structured-measurement-declaration.ts";

const choices: SubjectChoice[] = [
  { id: "f0v0", key: "kind", facet: "Вид изделия", value: "Анкер" },
  { id: "f0v1", key: "kind", facet: "Вид изделия", value: "Заклёпка" },
];
const context = {
  request: "Подбери крепления для стены. Бетон",
  category: "Монтажная оснастка",
  choices,
};
const declaration = {
  customer_phrase: "крепления",
  catalog_classification_id: "f0v0",
};

Deno.test("subject: a live classification cannot declare its own equivalence to the customer noun", () => {
  const result = resolveSelectionSubject(declaration, context);
  assertEquals(result.status, "needs_input");
  assertEquals(
    resolveSelectionSubject(declaration, {
      ...context,
      request: context.request + ". псевдоАнкер, не Анкер",
    }).status,
    "needs_input",
  );
  if (result.status !== "needs_input") return;
  assertEquals(result.clarification.options.map((o) => o.value), [
    "Анкер",
    "Заклёпка",
  ]);
  assertEquals(result.clarification.scope?.token, context.request);
});
Deno.test("subject: confirmation uses the actual customer class and retains its exact facet obligation", () => {
  const result = resolveSelectionSubject({
    ...declaration,
    customer_phrase: "Анкер",
  }, {
    ...context,
    request: context.request + " --- Уточнение клиента: Анкер",
  });
  assertEquals(result.status, "ready");
  if (result.status !== "ready") return;
  assertEquals(result.subject.target, "Анкер");
  assertEquals(result.subject.criterion?.value, "Анкер");
  assertEquals(result.subject.criterion?.evidence, "user_explicit");
});
Deno.test("subject: no live classification permits literal customer extraction, not taxonomy self-authorization", () => {
  assertEquals(
    resolveSelectionSubject({
      customer_phrase: "крепления",
      catalog_classification_id: "",
    }, { ...context, choices: [] }).status,
    "ready",
  );
  assertEquals(
    resolveSelectionSubject({
      customer_phrase: "Монтажная оснастка",
      catalog_classification_id: "",
    }, { ...context, choices: [] }).status,
    "invalid",
  );
});
Deno.test("subject: invented quotes, arbitrary IDs, markup and hidden fields are rejected", () => {
  for (
    const value of [
      null,
      { ...declaration, customer_phrase: "кабель" },
      { ...declaration, catalog_classification_id: "f99v0" },
      { ...declaration, customer_phrase: "<крепления>" },
      { ...declaration, trusted: true },
    ]
  ) {
    assertEquals(resolveSelectionSubject(value, context).status, "invalid");
  }
  assert(
    selectionSubjectSchema(choices).properties.catalog_classification_id.enum
      .includes("f0v0"),
  );
});
Deno.test("subject: an omitted model ID cannot turn purpose prose into a catalog class when live product types exist", () => {
  const result = resolveSelectionSubject({ customer_phrase: "крепления для стены", catalog_classification_id: "" }, context);
  assertEquals(result.status, "needs_input");
  if (result.status === "needs_input") assertEquals(result.clarification.options.map(o => o.value), ["Анкер", "Заклёпка"]);
  const exact = resolveSelectionSubject({ customer_phrase: "Анкер", catalog_classification_id: "" }, { ...context, request: "Подбери Анкер" });
  assertEquals(exact.status, "ready");
  if (exact.status === "ready") assertEquals(exact.subject.criterion?.value, "Анкер");
  // A technical property is not a product identity slot.
  assertEquals(resolveSelectionSubject({ customer_phrase: "крепления", catalog_classification_id: "" }, { ...context, choices: [{ id: "p0", key: "shank", facet: "Тип хвостовика", value: "SDS Plus" }] }).status, "ready");
});
Deno.test("subject: a rejected class in customer wording is not affirmative identity evidence", () => {
  const result = resolveSelectionSubject(declaration, {
    ...context,
    request: context.request + ". Не Анкер",
  });
  assertEquals(result.status, "needs_input");
  assertEquals(
    resolveSelectionSubject({ ...declaration, customer_phrase: "Анкер" }, {
      ...context,
      request: "Нужна заклёпка вместо Анкер",
    }).status,
    "invalid",
  );
});
Deno.test("subject: one actual live chip is restricted to the server-owned policy; ordinary tools stay unchanged", () => {
  const result = resolveSelectionSubject(declaration, {
    ...context,
    choices: choices.slice(0, 1),
  });
  assertEquals(result.status, "needs_input");
  if (result.status !== "needs_input") return;
  const live = {
    request: context.request,
    facets: [{ key: "kind", values: [{ value: "Анкер" }] }],
  };
  assertEquals(resolveSelectionClarification(result.clarification, live), null);
  const verified = resolveSelectionClarification(result.clarification, {
    ...live,
    allowSingleLiveChoice: true,
  });
  assert(verified);
  assertEquals(executeProposeClarification(verified).ok, false);
  assertEquals(
    executeProposeClarification(verified, { allowSingleChoice: true }).ok,
    true,
  );
  assertEquals(
    resolveSelectionClarification({
      ...result.clarification,
      options: [{ value: "Выдуманный тип" }],
    }, { ...live, allowSingleLiveChoice: true }),
    null,
  );
});

Deno.test("subject: unknown terminology from other domains follows the same confirmation contract", () => {
  for (
    const [customer, canonical] of [["колодка", "клеммный блок"], [
      "источник света",
      "линейный модуль",
    ], ["fixing", "expansion anchor"]]
  ) {
    const context = {
      request: `Нужен ${customer}`,
      choices: [{
        id: "f0v0",
        key: "kind",
        facet: "Тип изделия",
        value: canonical,
      }],
    };
    const proposed = {
      customer_phrase: customer,
      catalog_classification_id: "f0v0",
    };
    assertEquals(
      resolveSelectionSubject(proposed, context).status,
      "needs_input",
    );
    assertEquals(
      resolveSelectionSubject(proposed, {
        ...context,
        request: context.request + " --- Уточнение клиента: " + canonical,
      }).status,
      "ready",
    );
  }
});
Deno.test("subject: new schema is server opt-in and survives the existing measurement adapter", () => {
  const facets = [{
    key: "kind",
    caption: "Тип изделия",
    values: [{ value: "Анкер" }],
  }];
  const old = buildDerivedSelectionReasoningToolSchema(facets);
  assert(
    !("selection_subject" in
      (old.function.parameters.properties as Record<string, unknown>)),
  );
  const enabled = buildDerivedSelectionReasoningToolSchema(facets, "", null, {
    requireReadiness: true,
    requireSubject: true,
  });
  assert(
    (enabled.function.parameters.required as string[]).includes(
      "selection_subject",
    ),
  );
  const adapted = structuredMeasurementTool(enabled);
  assert(
    (adapted.function.parameters.required as string[]).includes(
      "selection_subject",
    ),
  );
});
