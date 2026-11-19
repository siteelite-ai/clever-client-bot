import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type DialogueAction,
  planDialogueAction,
} from "./dialogue-action-plan.ts";

const actions: Exclude<DialogueAction, "expert">[] = [
  "acknowledge",
  "fixture_scope_unverified",
  "fixture_selection",
  "fixture_pending",
  "cutout_continuation",
  "catalog_choice",
  "catalog_choice_unresolved",
  "catalog_choice_unverified",
  "application_unsupported",
  "clarify",
  "application_selection",
  "constrained_catalog_choice",
  "meta",
  "engineering",
  "clean_power",
  "electrical_diagnostic",
  "load_guidance",
  "active_selection",
  "assortment",
  "exact_item",
  "series_inquiry",
  "series_browse",
  "poe_assessment",
  "poe_explanation",
  "unavailable_reference",
  "recent_show",
  "recent_price",
  "semantic_compound",
  "exact_compound",
  "poe_selection",
  "batch_evidence",
  "store_policy",
  "general_inquiry",
  "measured_replacement",
  "replacement",
];

Deno.test("each supported adapter can be selected without vocabulary or SKU input", () => {
  for (const action of actions) {
    const result = planDialogueAction({
      newTask: false,
      independentItemInquiry: false,
      capabilities: { [action]: true },
    });
    assertEquals(result.action, action);
    assertEquals(result.suppressed, []);
    assertEquals(
      result.requiresRenderedCards,
      ["recent_show", "recent_price", "batch_evidence"].includes(action),
    );
  }
  assertEquals(
    planDialogueAction({
      newTask: true,
      independentItemInquiry: false,
      capabilities: {},
    }).action,
    "expert",
  );
});

Deno.test("all pairwise route intersections have exactly one explicit stable winner", () => {
  for (let i = 0; i < actions.length; i++) {
    for (let j = i + 1; j < actions.length; j++) {
      const first = actions[i], second = actions[j];
      const result = planDialogueAction({
        newTask: false,
        independentItemInquiry: false,
        capabilities: { [second]: true, [first]: true },
      });
      assertEquals(result.action, first);
      assertEquals(result.suppressed, [second]);
    }
  }
});

Deno.test("a new task cannot inherit dependent adapters even if stale signals are true", () => {
  for (
    const stale of [
      "catalog_choice",
      "active_selection",
      "recent_show",
      "recent_price",
      "batch_evidence",
      "unavailable_reference",
    ] as const
  ) {
    const result = planDialogueAction({
      newTask: true,
      independentItemInquiry: false,
      capabilities: { [stale]: true, replacement: true },
    });
    assertEquals(result.action, "replacement");
    assert(!result.eligible.includes(stale));
    assertEquals(result.requiresRenderedCards, false);
  }
});

Deno.test("independent item facts take precedence over selection and stale clarification", () => {
  const result = planDialogueAction({
    newTask: true,
    independentItemInquiry: true,
    capabilities: {
      clarify: true,
      application_selection: true,
      exact_item: true,
      active_selection: true,
    },
  });
  assertEquals(result.action, "exact_item");
  assertEquals(result.operation, "item_facts");
  assertEquals(result.requiresRenderedCards, false);
});

Deno.test("independence cannot authorise an exact adapter that did not prove capability", () => {
  assertEquals(
    planDialogueAction({
      newTask: true,
      independentItemInquiry: true,
      capabilities: { clarify: true },
    }).action,
    "clarify",
  );
});
