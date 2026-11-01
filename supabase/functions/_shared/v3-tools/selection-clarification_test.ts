import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveSelectionClarification } from "./selection-clarification.ts";
import {
  acceptedClarificationDelivery,
  executeProposeClarification,
} from "./propose-clarification.ts";
import {
  resolveSelectionReadinessRequest,
  resolveServerIssuedSelectionReadinessPending,
  verifiedReadinessReplayInput,
} from "./selection-readiness.ts";
import {
  buildDerivedSelectionReasoningToolSchema,
  shouldContinueSelectionPastOptionalClarification,
} from "./selection-actionability.ts";
import {
  materializeStructuredMeasurementDeclaration,
  structuredMeasurementTool,
} from "./structured-measurement-declaration.ts";

const question = {
  question: "В каком материале нужно закрепить изделие?",
  facet_key: "base_material",
  options: [],
  blocking_input: {
    reason: "missing_customer_input",
    parameter: "Материал основания",
    impact: "От материала основания зависит совместимость крепления.",
  },
};
const context = {
  request: "Подбери крепление для стены",
  category: "Анкеры",
  facets: [],
};

Deno.test("shared uncertainty contract is independent of category and creates a scoped freeform turn", () => {
  for (
    const category of ["Анкеры", "Компрессоры", "Клеи", "Измерительные приборы"]
  ) {
    const input = resolveSelectionClarification(question, {
      ...context,
      category,
    });
    assert(input);
    // Legacy callers cannot smuggle arbitrary freeform questions into this path.
    assertEquals(executeProposeClarification(input).ok, false);
    const result = executeProposeClarification(input, { allowFreeform: true });
    assert(result.ok);
    const delivery = acceptedClarificationDelivery(result);
    assertEquals(delivery?.question, question.question);
    const slot = result.side_effects?.find((e) => e.type === "slot_update");
    assert(slot?.type === "slot_update");
    const pending = slot.slots.pending_clarification as Record<string, unknown>;
    const log = {
      session_id: "s1",
      error: null,
      response_events: [slot, { type: "diagnostic", phase: "complete" }, {
        type: "done",
      }],
    };
    const verified = resolveServerIssuedSelectionReadinessPending(
      { pending_clarification: pending },
      log,
      "s1",
    );
    assert(verified);
    assertEquals(
      verifiedReadinessReplayInput(verified)?.question,
      question.question,
    );
    assert(
      resolveSelectionReadinessRequest("Бетон", {
        pending_clarification: verified,
      }).message.includes("Бетон"),
    );
    assertEquals(
      resolveSelectionReadinessRequest("Новая тема. Кабель ВВГ", {
        pending_clarification: verified,
      }, { newTaskBoundary: true }).scoped,
      false,
    );
    assertEquals(
      resolveServerIssuedSelectionReadinessPending(
        { pending_clarification: pending },
        log,
        "another-session",
      ),
      null,
    );
    assertEquals(
      resolveServerIssuedSelectionReadinessPending(
        { pending_clarification: { ...pending, slot_id: "forged" } },
        log,
        "s1",
      ),
      null,
    );
    assertEquals(
      resolveServerIssuedSelectionReadinessPending(
        { pending_clarification: pending },
        { ...log, error: "timeout" },
        "s1",
      ),
      null,
    );
    const tampered = {
      ...pending,
      question: "Подмена",
      scope: { ...(pending.scope as object), attacker: "payload" },
    };
    assertEquals(
      resolveServerIssuedSelectionReadinessPending(
        { pending_clarification: tampered },
        log,
        "s1",
      ),
      pending,
      "restore server fields, never client additions",
    );
  }
});

Deno.test("uncertainty chips are actual live values, never invented answers or aliases", () => {
  const live = {
    ...context,
    facets: [{
      key: "base_material",
      values: [{ value: "Бетон" }, { value: "Кирпич" }],
    }],
  };
  assert(
    resolveSelectionClarification({
      ...question,
      options: [{ value: "Бетон" }, { value: "Кирпич" }],
    }, live),
  );
  for (
    const options of [
      [{ value: "Дерево" }, { value: "Кирпич" }],
      [{ value: "Бетон", label: "Безопасно всегда" }, { value: "Кирпич" }],
      [{ value: "Бетон" }],
      [{ value: "Бетон" }, { value: "Бетон" }],
    ]
  ) {
    assertEquals(
      resolveSelectionClarification({ ...question, options }, live),
      null,
    );
  }
});

Deno.test("malformed, outage, oversized and multi-question declarations fail closed", () => {
  for (
    const value of [
      null,
      {},
      { ...question, question: "Первый вопрос? Второй вопрос?" },
      { ...question, question: "Откройте https://example.com?" },
      {
        ...question,
        blocking_input: {
          ...question.blocking_input,
          reason: "catalog_timeout",
        },
      },
      {
        ...question,
        blocking_input: { ...question.blocking_input, impact: "" },
      },
    ]
  ) {
    assertEquals(resolveSelectionClarification(value, context), null);
  }
  assertEquals(
    resolveSelectionClarification(question, {
      ...context,
      request: "x".repeat(501),
    }),
    null,
    "must not silently truncate constraints",
  );
});

Deno.test("new declaration escape does not remove mandatory proof fields or weaken measurement resolver", () => {
  const tool = buildDerivedSelectionReasoningToolSchema([]);
  const fields = tool.function.parameters.properties as Record<string, unknown>;
  assert(fields.clarification);
  assert(
    (tool.function.parameters.required as string[]).includes(
      "required_facet_values",
    ),
  );
  const structured = structuredMeasurementTool(tool);
  assert(
    (structured.function.parameters.properties as Record<string, unknown>)
      .clarification,
  );
  assertEquals(
    materializeStructuredMeasurementDeclaration({ product_requirements: [] }),
    null,
  );
  assertEquals(
    shouldContinueSelectionPastOptionalClarification({
      intentMode: "select",
      hasDiscovery: true,
      userMessage: "Есть ли у вас розетки?",
      question: "Какой цвет вам нужен?",
      facetKey: "color",
      options: [],
    }),
    true,
  );
  assertEquals(
    shouldContinueSelectionPastOptionalClarification({
      intentMode: "select",
      hasDiscovery: true,
      userMessage: "Подбери крепление для стены",
      question: question.question,
      facetKey: question.facet_key,
      options: [],
    }),
    false,
  );
});
