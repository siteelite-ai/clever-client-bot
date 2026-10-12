import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { extractBudgetCap } from "../../supabase/functions/_shared/v3-tools/budget-cap.ts";
import { admitDirectSelectionRoute } from "../../supabase/functions/chat-consultant-v3/selection-jargon-policy.ts";

const breakerRequest =
  "Автомат 1P ВА 47-29 16 А 4,5кА характеристика C GENERICA ИЭК предложи равноценную замену этому автомату по цене не дороже 1000 тг";

test("source-first technical replacement with one upper budget uses the bounded direct route", () => {
  assert.equal(extractBudgetCap(breakerRequest), 1000);
  assert.equal(
    admitDirectSelectionRoute({
      route: "replacement",
      userMessage: breakerRequest,
      coversBudgetCap: true,
    }),
    true,
  );
  assert.equal(
    admitDirectSelectionRoute({
      route: "replacement",
      userMessage: breakerRequest,
    }),
    false,
    "a caller that cannot enforce the budget must not enter this route",
  );
  assert.equal(
    admitDirectSelectionRoute({
      route: "replacement",
      userMessage:
        "Лампа ECO75 6Вт 230В предложи аналог этой лампе до 5000 тг",
      coversBudgetCap: true,
    }),
    true,
    "the grammar is not tied to breakers or a specific brand",
  );
});

test("independent fit, ambiguous prices and exact-price demands are not admitted", () => {
  for (const extra of [
    "для дома",
    "с IP65",
    "с диаметром 25 мм",
    "и до 2000 тг",
  ]) {
    assert.equal(
      admitDirectSelectionRoute({
        route: "replacement",
        userMessage: `${breakerRequest} ${extra}`,
        coversBudgetCap: true,
      }),
      false,
      extra,
    );
  }
  assert.equal(
    admitDirectSelectionRoute({
      route: "replacement",
      userMessage: breakerRequest.replace("не дороже", "ровно"),
      coversBudgetCap: true,
    }),
    false,
  );
});

test("direct preflight enforces budget and technical axes without source-brand matching", () => {
  const source = readFileSync(
    new URL("../../supabase/functions/chat-consultant-v3/index.ts", import.meta.url),
    "utf8",
  );
  const dispatcher = source.slice(
    source.indexOf("} else if (replacementSourceRequest) {"),
    source.indexOf("} else {\n              const out = await runExpertLoop(",
      source.indexOf("} else if (replacementSourceRequest) {")),
  );
  assert.match(dispatcher, /coversBudgetCap:\s*extractBudgetCap\(replacementSourceRequest\) !== null/u);

  const begin = source.indexOf("async function selectVerifiedOrdinaryReplacement(");
  const end = source.indexOf("async function selectVerifiedExactCompoundProducts(", begin);
  assert.ok(begin > -1 && end > begin);
  const preflight = source.slice(begin, end);
  assert.match(preflight, /max_price:\s*budgetCap/u);
  assert.match(preflight, /product\.price <= budgetCap/u);
  assert.match(preflight, /productProvesDirectReplacementAxes\s*\(/u);
  assert.doesNotMatch(preflight, /productTitleSupportsMandatoryAxes\s*\(/u);
  assert.match(preflight, /productContainsSourceModel\s*\(/u);
  assert.doesNotMatch(preflight, /directProductProvesLiteralWords\s*\(/u);
});
