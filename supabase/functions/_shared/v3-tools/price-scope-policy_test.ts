import {
  classifyCatalogPriceExtreme,
  classifyPriceSearchCoverage,
  detectPriceDirection,
  guardGenericExpertFinalPriceText,
  stripUnprovenPriceClaimSentences,
  unprovenCatalogPriceNotice,
} from "./price-scope-policy.ts";
import {
  admitDirectSelectionRoute,
  isPureNamedSeriesBrowse,
} from "../../chat-consultant-v3/selection-jargon-policy.ts";
import { admitMeasuredSourceClassDirectRoute } from "./measured-source-class-recovery.ts";

function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("catalog price extreme keeps budget and absolute order as separate constraints", () => {
  equal(
    classifyCatalogPriceExtreme("найди самый дешёвый кабель до 5 000 тенге"),
    "cheapest",
  );
  equal(
    classifyCatalogPriceExtreme("Покажи розетку с минимальной ценой до 1000 ₸"),
    "cheapest",
  );
  equal(
    classifyCatalogPriceExtreme("самую низкую цену на прожектор"),
    "cheapest",
  );
  equal(
    classifyCatalogPriceExtreme(
      "Нужен самый дорогой выключатель не дороже 5000 тенге",
    ),
    "expensive",
  );
  equal(
    classifyCatalogPriceExtreme("Покажи максимальную стоимость в категории"),
    "expensive",
  );
  equal(classifyCatalogPriceExtreme("кабель до 5000 тенге"), null);
  equal(classifyCatalogPriceExtreme("бюджетный кабель"), null);
  equal(classifyCatalogPriceExtreme("дешевле этой модели"), null);
  equal(classifyCatalogPriceExtreme("не самый дешёвый кабель"), null);
  equal(
    classifyCatalogPriceExtreme("не обязательно самый дешёвый кабель"),
    null,
  );
  equal(
    classifyCatalogPriceExtreme("не нужен именно самый дорогой вариант"),
    null,
  );
  equal(classifyCatalogPriceExtreme("самый дешёвый или самый дорогой"), null);
  equal(detectPriceDirection("найди самый дешёвый кабель до 5 000 тенге"), {
    kind: "superlative",
    direction: "cheaper",
  });
  equal(detectPriceDirection("самый дорогой автомат не дороже 5000 ₸"), {
    kind: "superlative",
    direction: "more_expensive",
  });
  equal(detectPriceDirection("розетка до 5000 ₸"), null);
  equal(detectPriceDirection("не самый дешёвый кабель"), null);
  equal(detectPriceDirection("дешевле этой модели"), {
    kind: "comparative",
    direction: "cheaper",
  });
});

Deno.test("bounded or apparently complete search results never prove catalog-wide price", () => {
  equal(classifyPriceSearchCoverage(null), "not_attempted");
  equal(classifyPriceSearchCoverage({ ok: false }), "failed");
  equal(
    classifyPriceSearchCoverage({
      ok: true,
      warnings: ["sort_truncated:640>200"],
    }),
    "truncated",
  );
  // Even a single materialized row can omit other taxonomy branches or units.
  equal(classifyPriceSearchCoverage({ ok: true, warnings: [] }), "unverified");
  equal(
    classifyPriceSearchCoverage({
      ok: true,
      warnings: ["option_alternatives_fanout:2"],
    }),
    "unverified",
  );
});

Deno.test("neighboring direct routes cannot silently bypass the generic price guard", () => {
  equal(
    admitDirectSelectionRoute({
      route: "replacement",
      userMessage:
        "предложи самый дешевый аналог на Светильник DN027B G2 LED6/NW 7W 220-240V D90 R; 929002070102",
    }),
    false,
  );
  equal(
    isPureNamedSeriesBrowse(
      "покажи самый дешевый товар серии Gallant",
      "Gallant",
    ),
    false,
  );
  equal(
    admitMeasuredSourceClassDirectRoute(
      "Хочу заменить люстру на светодиодное освещение в гостиной 25 м² самое дешёвое",
    ),
    false,
  );
  // The one direct exception is intentionally handled by complete category
  // enumeration, not by the generic expert's bounded sorted pool.
  equal(
    admitDirectSelectionRoute({
      route: "compound",
      userMessage: "найди самый дешевый кабель ВВГ 3*1,5",
      coveredCompound: { first: 3, second: 1.5 },
    }),
    true,
  );
});

Deno.test("model prose cannot make an unproven global-price claim before or after cards", () => {
  const intro =
    "Нужен кабель ВВГ 3×1,5. Ищу самый дешёвый товар. Проверю маркировку и наличие.";
  equal(
    stripUnprovenPriceClaimSentences(intro),
    "Нужен кабель ВВГ 3×1,5. Проверю маркировку и наличие.",
  );
  equal(
    stripUnprovenPriceClaimSentences("Нашёл минимальную цену на сайте."),
    "",
  );
  equal(stripUnprovenPriceClaimSentences("Это самый дорогой товар."), "");
  equal(
    stripUnprovenPriceClaimSentences(
      "Проверяю категорию и наличие; точные цены сверю по карточкам.",
    ),
    "Проверяю категорию и наличие; точные цены сверю по карточкам.",
  );
  const disclosure = unprovenCatalogPriceNotice("cheapest", true);
  if (
    !disclosure.includes("Полнота поиска не подтверждена") ||
    !disclosure.includes("минимальную цену")
  ) {
    throw new Error(`missing fail-closed scope disclosure: ${disclosure}`);
  }
  const empty = unprovenCatalogPriceNotice("expensive", false);
  if (!empty.includes("Не удалось подтвердить максимальную цену")) {
    throw new Error(`missing failed-search disclosure: ${empty}`);
  }
});

Deno.test("generic price guard preserves non-price paragraphs and list formatting", () => {
  const ordinary =
    "Подходят два варианта:\n\n- Накладной\n- Подвесной\n\nКакой монтаж нужен?";
  equal(stripUnprovenPriceClaimSentences(ordinary), ordinary);
  const mixed =
    "Проверю монтаж. Это самый дешёвый товар. Уточню наличие.\n\n- Накладной\n- Подвесной";
  equal(
    stripUnprovenPriceClaimSentences(mixed),
    "Проверю монтаж. Уточню наличие.\n\n- Накладной\n- Подвесной",
  );
});

Deno.test("generic model cannot volunteer a global minimum on a budget-only or ordinary request", () => {
  // Neither customer request asks for a global minimum. The same output guard
  // still applies to model-authored prose in the generic expert route.
  for (
    const customerMessage of [
      "Покажи кабель до 5000 тенге",
      "Подбери розетку для квартиры",
    ]
  ) {
    equal(classifyCatalogPriceExtreme(customerMessage), null);
    equal(
      stripUnprovenPriceClaimSentences(
        "Вот подходящие варианты. Это самый дешёвый товар во всём каталоге. Уточните цвет.",
      ),
      "Вот подходящие варианты. Уточните цвет.",
    );
  }
});

Deno.test("generic final text always strips volunteered extreme but discloses only explicit request", () => {
  const volunteered =
    "Под бюджет подходят несколько вариантов. Это самый дешёвый во всём каталоге.";
  const budgetOnly = guardGenericExpertFinalPriceText({
    modelText: volunteered,
    requestedExtreme: null,
    noticeAlreadySent: false,
    catalogSearchAttempted: true,
    renderedCandidates: 2,
  });
  equal(budgetOnly, {
    text: "Под бюджет подходят несколько вариантов.",
    noticeAdded: false,
  });

  const explicit = guardGenericExpertFinalPriceText({
    modelText: volunteered,
    requestedExtreme: "cheapest",
    noticeAlreadySent: false,
    catalogSearchAttempted: true,
    renderedCandidates: 2,
  });
  if (
    !explicit.noticeAdded ||
    !explicit.text.startsWith("Под бюджет подходят несколько вариантов.\n\n") ||
    !explicit.text.includes("Полнота поиска не подтверждена") ||
    explicit.text.includes("самый дешёвый")
  ) {
    throw new Error(
      `generic final price contract violated: ${JSON.stringify(explicit)}`,
    );
  }
  const alreadyDisclosed = guardGenericExpertFinalPriceText({
    modelText: volunteered,
    requestedExtreme: "cheapest",
    noticeAlreadySent: true,
    catalogSearchAttempted: true,
    renderedCandidates: 2,
  });
  equal(alreadyDisclosed, budgetOnly);
});
