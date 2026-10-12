import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { classifyOutdoorPoeIntent } from "../../supabase/functions/_shared/v3-tools/outdoor-poe-policy.ts";
import { resolveUnavailableProductReference } from "../../supabase/functions/_shared/v3-tools/unavailable-product-reference.ts";

const firstTurn =
  "Я нашёл дешёвый кабель для камеры на охраняемой парковке: Кабель витая пара U/UTP кат. 5 CCA 4 пары, GENERICA. Подойдёт или нет?";
const explanationTurn =
  "Да, PoE-камера, расстояние почти 100 метров, кабель будет идти на улице. Почему этот кабель нельзя использовать?";
const history = [
  { role: "user", content: firstTurn },
  { role: "assistant", content: "Нужно уточнить питание, расстояние и трассу." },
];

test("user-grounded PoE explanation takes precedence over missing-card fallback", () => {
  assert.equal(classifyOutdoorPoeIntent(firstTurn, []), "assessment");
  assert.equal(classifyOutdoorPoeIntent(explanationTurn, history), "explanation");
  assert.equal(
    resolveUnavailableProductReference(explanationTurn, history, 0)?.reason,
    "no_rendered_products",
  );

  // Both predicates match: the real dispatcher must choose the safety answer.
  const source = readFileSync(
    new URL("../../supabase/functions/chat-consultant-v3/index.ts", import.meta.url),
    "utf8",
  );
  const assessment = source.indexOf('step: "v3_outdoor_poe_assessment"');
  const explanation = source.indexOf('step: "v3_outdoor_poe_explanation"');
  const missingCards = source.indexOf('step: "v3_unavailable_product_reference"');
  const selection = source.indexOf(
    'outdoorPoeIntent === "selection" && outdoorPoeDirectAdmitted',
  );
  assert.ok(assessment > -1 && explanation > -1 && missingCards > -1);
  assert.ok(assessment < missingCards && explanation < missingCards);
  assert.ok(selection > missingCards, "product selection remains catalog-grounded");
});

test("unrelated deictic requests keep the missing-card safety boundary", () => {
  const unrelated = "Почему этот светильник нельзя использовать?";
  const unrelatedHistory = [
    { role: "user", content: "Покажи светильники" },
    { role: "assistant", content: "Поиск не завершился." },
  ];
  assert.equal(classifyOutdoorPoeIntent(unrelated, unrelatedHistory), null);
  assert.equal(
    resolveUnavailableProductReference(unrelated, unrelatedHistory, 0)?.reason,
    "no_rendered_products",
  );
});

test("assistant text cannot invent the PoE safety context", () => {
  assert.equal(
    classifyOutdoorPoeIntent("Почему этот кабель нельзя использовать?", [
      { role: "user", content: "Покажи лампы" },
      {
        role: "assistant",
        content: "Кабель CCA для PoE-камеры на улице почти 100 метров",
      },
    ]),
    null,
  );
});
