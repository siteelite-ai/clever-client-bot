import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyExactCompoundMarkingRequest,
  extractExplicitCompoundMarking,
  requiresSemanticCompoundEvidence,
} from "./exact-compound-marking-policy.ts";
import { admitDirectSelectionRoute } from "../../chat-consultant-v3/selection-jargon-policy.ts";
import {
  mustStopUnprovenSemanticCompoundSuperlative,
  semanticCompoundSuperlativeIntent,
  unprovenSemanticCompoundSuperlativeNotice,
} from "./semantic-compound-superlative-policy.ts";

Deno.test("semantic same-size cheapest request cannot use a bounded recovered pool as global minimum", () => {
  const query = "найди самый дешевый негорючий кабель ВВГ 3*1,5";
  const marking = extractExplicitCompoundMarking(query);
  assert(marking);
  assertEquals(classifyExactCompoundMarkingRequest(query), null);
  assertEquals(requiresSemanticCompoundEvidence(query), true);
  assertEquals(admitDirectSelectionRoute({
    route: "compound", userMessage: query, coveredCompound: marking,
  }), true);
  assertEquals(mustStopUnprovenSemanticCompoundSuperlative(
    true, requiresSemanticCompoundEvidence(query), { kind: "superlative", direction: "cheaper" },
  ), true);
  const notice = unprovenSemanticCompoundSuperlativeNotice({
    kind: "superlative", direction: "cheaper",
  });
  assert(notice?.includes("Не могу подтвердить минимальную цену"));
  assert(notice?.includes("не назову одну карточку самой дешёвой"));
});

Deno.test("non-admitted semantic superlative is stopped before the expert loop", () => {
  const query = "найди самый дешевый негорючий кабель ВВГ 3*1,5 для улицы";
  const marking = extractExplicitCompoundMarking(query);
  assert(marking);
  assertEquals(requiresSemanticCompoundEvidence(query), true);
  assertEquals(admitDirectSelectionRoute({
    route: "compound", userMessage: query, coveredCompound: marking,
  }), false);
  assertEquals(mustStopUnprovenSemanticCompoundSuperlative(
    true, requiresSemanticCompoundEvidence(query), { kind: "superlative", direction: "cheaper" },
  ), true);
  const capped = `${query} до 1000 тенге`;
  // The ordinary detector returns null for budget-capped requests. The
  // semantic safety route still recognizes the customer's explicit extreme.
  const cappedIntent = semanticCompoundSuperlativeIntent(capped, null);
  assertEquals(cappedIntent, { kind: "superlative", direction: "cheaper" });
  assertEquals(mustStopUnprovenSemanticCompoundSuperlative(
    true, requiresSemanticCompoundEvidence(capped), cappedIntent,
  ), true);
  assertEquals(mustStopUnprovenSemanticCompoundSuperlative(
    true, true, { kind: "comparative", direction: "cheaper" },
  ), false);
});

Deno.test("only semantic superlatives are blocked; ordinary and comparative routes stay intact", () => {
  assertEquals(unprovenSemanticCompoundSuperlativeNotice(null), null);
  assertEquals(unprovenSemanticCompoundSuperlativeNotice({
    kind: "comparative", direction: "cheaper",
  }), null);
  const expensive = unprovenSemanticCompoundSuperlativeNotice({
    kind: "superlative", direction: "more_expensive",
  });
  assert(expensive?.includes("максимальную цену"));
  assert(expensive?.includes("самой дорогой"));
});
