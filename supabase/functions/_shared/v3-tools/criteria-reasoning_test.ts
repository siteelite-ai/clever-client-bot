// Unit tests: Layer 5 — рассуждение модели как источник истины.
// Data-agnostic: абстрактные имена параметров.

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  alignCriteriaImportanceWithReasoning,
  alignCriteriaWithReasoning,
  compileMeasuredReasoningSearchContract,
  customerOwnsDerivedExactFacetValue,
  demoteUnfrozenRenderCriteria,
  extractReasoningBounds,
  hasMeasuredSelectionRequirement,
  projectLiteralMeasuredCriteria,
  projectReasoningRangeCriteria,
  promoteMeasuredReasoningCriteria,
  promoteProjectableMeasuredFallbackCriteria,
} from "./criteria-reasoning.ts";
import { checkCriterion, type Criterion } from "./criteria-gate.ts";
import type { ProductRef } from "./types.ts";

function product(id: string, traits: string[]): ProductRef {
  return {
    id,
    pagetitle: `P-${id}`,
    vendor: null,
    price: 100,
    stock: "unknown",
    short_traits: traits,
  };
}

Deno.test("extractReasoningBounds: направления и строгость", () => {
  assertEquals(extractReasoningBounds("нужен диаметр больше 12 мм"), [
    { op: "min", value: 12, unit: "мм", strict: true },
  ]);
  assertEquals(extractReasoningBounds("не менее 40 мм"), [
    { op: "min", value: 40, unit: "мм", strict: false },
  ]);
  assertEquals(extractReasoningBounds("не более 15 а"), [
    { op: "max", value: 15, unit: "а", strict: false },
  ]);
  assertEquals(extractReasoningBounds("нужно 12 штук"), []);
});

Deno.test("измеримое рассуждение требует машинного критерия, голая маркировка — нет", () => {
  assertEquals(
    hasMeasuredSelectionRequirement("нужен поток 3750–5000 лм для комнаты"),
    true,
  );
  assertEquals(
    hasMeasuredSelectionRequirement("трубка должна охватывать кабель 12 мм"),
    true,
  );
  assertEquals(
    hasMeasuredSelectionRequirement("покажи кабель ВВГ 2×1,5"),
    false,
  );
  assertEquals(
    hasMeasuredSelectionRequirement(
      "Обычно такие лампы имеют E27 или E14 и часто работают на 220 В.",
    ),
    false,
  );
  assertEquals(
    hasMeasuredSelectionRequirement(
      "Считаем: площадь 25 м² × 175 лк, итого 4375 лм.",
    ),
    true,
  );
  assertEquals(
    hasMeasuredSelectionRequirement(
      "ДКУ-LED-03-100W — исходная модель; подбираю замену.",
    ),
    false,
  );
  assertEquals(
    hasMeasuredSelectionRequirement(
      "Посмотрю несколько вариантов на любой кошелёк: от простых бытовых на 3–5 метров до усиленных.",
    ),
    false,
  );
  assertEquals(
    hasMeasuredSelectionRequirement("Покажи удлинители длиной 3–5 метров"),
    true,
  );
});

Deno.test("числовой диапазон из рассуждения проецируется на уникальный живой фасет", () => {
  const projected = projectReasoningRangeCriteria(
    [],
    "ориентир 3750–5000 люмен",
    [
      {
        key: "svetovoj_potok",
        caption: "Световой поток",
        type: "number",
        unit: "лм",
      },
      { key: "power", caption: "Мощность", type: "number", unit: "Вт" },
    ],
  );
  assertEquals(projected.added, [{
    key: "Световой поток",
    op: "range",
    value: [3750, 5000],
    unit: "лм",
    level: "A",
  }]);
});

Deno.test("распределённая суммарная потребность не становится параметром каждой карточки", () => {
  const reasoning =
    "Для площадки нужен суммарный световой поток 20000–25000 лм; его лучше равномерно распределить между несколькими приборами по периметру.";
  const projected = projectReasoningRangeCriteria([], reasoning, [
    { key: "flow", caption: "Световой поток", type: "number", unit: "лм" },
  ]);
  assertEquals(projected.added, []);
  assertEquals(hasMeasuredSelectionRequirement(reasoning), false);
});

Deno.test("область суммарного расчёта действует между соседними предложениями", () => {
  const reasoning =
    "Общий световой поток должен быть не менее 25000 лм. Это суммарная потребность всей системы: её нужно распределить между несколькими товарами.";
  const projected = projectReasoningRangeCriteria([], reasoning, [
    { key: "flow", caption: "Световой поток", type: "number", unit: "лм" },
  ]);
  assertEquals(projected.added, []);
  assertEquals(hasMeasuredSelectionRequirement(reasoning), false);
});

Deno.test("измеримый диапазон каждого отдельного товара остаётся обязательным", () => {
  const reasoning = "Каждый прибор должен давать 4000–5000 лм.";
  const projected = projectReasoningRangeCriteria([], reasoning, [
    { key: "flow", caption: "Световой поток", type: "number", unit: "лм" },
  ]);
  assertEquals(projected.added, [
    {
      key: "Световой поток",
      op: "range",
      value: [4000, 5000],
      unit: "лм",
      level: "A",
    },
  ]);
  assertEquals(hasMeasuredSelectionRequirement(reasoning), true);
});

Deno.test("словесная составная единица не конфликтует с производным диапазоном", () => {
  const projected = projectReasoningRangeCriteria(
    [],
    "Для комнаты нужен поток 3750–5000 лм (из расчёта 150–200 лм на м²).",
    [
      { key: "flow", caption: "Световой поток", type: "number", unit: "лм" },
      { key: "power", caption: "Мощность", type: "number", unit: "Вт" },
    ],
  );
  assertEquals(projected.added, [
    {
      key: "Световой поток",
      op: "range",
      value: [3750, 5000],
      unit: "лм",
      level: "A",
    },
  ]);
});

Deno.test("дефисы артикула не превращаются в диапазон измеримого фасета", () => {
  const projected = projectReasoningRangeCriteria(
    [],
    "ДКУ-LED-03-100W — исходная модель; подбираю замену.",
    [{
      key: "power",
      caption: "Мощность ламп, Вт",
      type: "number",
      unit: "Вт",
      values: [{ value: "3" }, { value: "100" }],
    }],
  );
  assertEquals(projected.added, []);
});

Deno.test("ключевые параметры замены обязательны, вероятная характеристика остаётся рекомендацией", () => {
  const aligned = alignCriteriaImportanceWithReasoning(
    [
      { key: "Количество полюсов", op: "eq", value: "1", level: "A" },
      { key: "Номинальный ток", op: "eq", value: "16", level: "A" },
      { key: "Характеристика", op: "eq", value: "C", level: "A" },
    ],
    "1-полюсный скорее всего. Ключевые параметры: номинальный ток 16 А, характеристика C.",
  );
  assertEquals(
    aligned.criteria.map((criterion) => [criterion.key, criterion.level]),
    [
      ["Количество полюсов", "B"],
      ["Номинальный ток", "A"],
      ["Характеристика", "A"],
    ],
  );
});

Deno.test("явно заявленная пригодность для применения остаётся обязательной", () => {
  const aligned = alignCriteriaImportanceWithReasoning(
    [
      { key: "Способ монтажа", op: "eq", value: "потолочный", level: "A" },
      { key: "Цвет", op: "eq", value: "белый", level: "A" },
    ],
    "Модель должна подходить для потолочного монтажа. Белый цвет — по желанию.",
  );
  assertEquals(
    aligned.criteria.map((criterion) => [criterion.key, criterion.level]),
    [
      ["Способ монтажа", "A"],
      ["Цвет", "B"],
    ],
  );
});

Deno.test("русский диапазон от X до Y проецируется так же, как запись через тире", () => {
  const projected = projectReasoningRangeCriteria(
    [],
    "нужно от 3500 до 5000 люмен",
    [
      { key: "flow", caption: "Поток", type: "number", unit: "лм" },
    ],
  );
  assertEquals(projected.added, [{
    key: "Поток",
    op: "range",
    value: [3500, 5000],
    unit: "лм",
    level: "A",
  }]);
});

Deno.test("явная производная нижняя граница проецируется без выдуманного максимума", () => {
  const projected = projectReasoningRangeCriteria(
    [],
    "Нужен световой поток не менее 3750 лм; около 5000 лм — лишь комфортный ориентир.",
    [
      { key: "flow", caption: "Световой поток", type: "number", unit: "лм" },
      { key: "power", caption: "Мощность", type: "number", unit: "Вт" },
    ],
  );
  assertEquals(projected.added, [
    { key: "Световой поток", op: "min", value: 3750, unit: "лм", level: "A" },
  ]);
});

Deno.test("явная нижняя граница побеждает комфортный диапазон с тем же началом", () => {
  const projected = projectReasoningRangeCriteria(
    [],
    "Расчётный ориентир — 3750–5000 лм. Светильник должен обеспечивать не менее 3750 лм; 5000 лм — комфортный уровень.",
    [{ key: "flow", caption: "Световой поток", type: "number", unit: "лм" }],
  );
  assertEquals(projected.added, [
    { key: "Световой поток", op: "min", value: 3750, unit: "лм", level: "A" },
  ]);
});

Deno.test("локальный оптимальный максимум не закрывает явно односторонний минимум", () => {
  const projected = projectReasoningRangeCriteria(
    [],
    "Световой поток = 25 м² × 150 лк = 3750 лм (минимум), оптимально до 5000 лм. Светильник должен обеспечивать не менее 3750 лм.",
    [{ key: "flow", caption: "Световой поток", type: "number", unit: "лм" }],
  );
  assertEquals(projected.added, [
    { key: "Световой поток", op: "min", value: 3750, unit: "лм", level: "A" },
  ]);
});

Deno.test("обязательный комфортный максимум сохраняется как граница", () => {
  assertEquals(
    extractReasoningBounds("Для комфортного света требуется не более 5000 лм."),
    [{ op: "max", value: 5000, unit: "лм", strict: false }],
  );
});

Deno.test("две явно названные границы сохраняют настоящий закрытый диапазон", () => {
  const projected = projectReasoningRangeCriteria(
    [],
    "Требуется диапазон 3750–5000 лм: не менее 3750 лм и не более 5000 лм.",
    [{ key: "flow", caption: "Световой поток", type: "number", unit: "лм" }],
  );
  assertEquals(projected.added, [
    {
      key: "Световой поток",
      op: "range",
      value: [3750, 5000],
      unit: "лм",
      level: "A",
    },
  ]);
});

Deno.test("проверенный средний расчёт сохраняет исходный диапазон результата", () => {
  const projected = projectReasoningRangeCriteria(
    [],
    "Ориентир 150–200 лк. Считаем: 25 м² × 175 лк (среднее) ≈ 4375 лм.",
    [{ key: "flow", caption: "Световой поток", type: "number", unit: "лм" }],
  );
  assertEquals(projected.added, [
    {
      key: "Световой поток",
      op: "range",
      value: [3750, 5000],
      unit: "лм",
      level: "A",
    },
  ]);
});

Deno.test("форматированный приблизительный результат сохраняет диапазон расчёта", () => {
  const projected = projectReasoningRangeCriteria(
    [],
    "Ориентир 150–200 лк: 25 м² × 175 лк ≈ **~4400 лм** — это целевой поток.",
    [{
      key: "svetovoy_potok",
      caption: "Световой поток, лм",
      type: "number",
      unit: "лм",
      values: [{ value: "3000" }, { value: "3750" }, { value: "4000" }, {
        value: "5000",
      }, { value: "6000" }],
    }],
  );
  assertEquals(projected.added, [
    {
      key: "Световой поток, лм",
      op: "range",
      value: [3750, 5000],
      unit: "лм",
      level: "A",
    },
  ]);
});

Deno.test("два диапазона одной единицы не проецируются на один фасет наугад", () => {
  const projected = projectReasoningRangeCriteria(
    [],
    "до установки 15–20 мм, после установки 6–8 мм",
    [
      { key: "size", caption: "Размер", type: "number", unit: "мм" },
    ],
  );
  assertEquals(projected.added, []);
});

Deno.test("локальное состояние диапазона не переносится на противоположный параметр", () => {
  const projected = projectReasoningRangeCriteria(
    [],
    "Для свободной посадки внутренний диаметр до усадки должен быть 12–20 мм, а после усадки — меньше 10 мм.",
    [
      {
        key: "before_diameter",
        caption: "Внутренний диаметр до термоусадки, мм",
        type: "checkbox",
        unit: "мм",
        values: [{ value: "12" }, { value: "20" }],
      },
      {
        key: "after_diameter",
        caption: "Внутренний диаметр после термоусадки, мм",
        type: "checkbox",
        unit: "мм",
        values: [{ value: "6" }, { value: "10" }],
      },
      {
        key: "wall_after",
        caption: "Толщина стенки после усадки, мм",
        type: "checkbox",
        unit: "мм",
        values: [{ value: "1" }, { value: "2" }],
      },
    ],
  );

  assertEquals(projected.added, [{
    key: "Внутренний диаметр до термоусадки, мм",
    op: "range",
    value: [12, 20],
    unit: "мм",
    level: "A",
  }]);
});

Deno.test("существующий критерий модели разрешает неоднозначность фасетов с одной единицей", () => {
  const projected = projectReasoningRangeCriteria(
    [{
      key: "Световой поток, Лм",
      op: "min",
      value: 3750,
      unit: "лм",
      level: "A",
    }],
    "Нужен световой поток 3750–5000 лм",
    [
      {
        key: "lamp_flow",
        caption: "Световой поток, Лм",
        type: "number",
        unit: "лм",
      },
      {
        key: "module_flow",
        caption: "Поток светодиодного модуля",
        type: "number",
        unit: "лм",
      },
    ],
  );
  assertEquals(projected.added, [
    {
      key: "Световой поток, Лм",
      op: "range",
      value: [3750, 5000],
      unit: "лм",
      level: "A",
    },
  ]);
});

Deno.test("числовые live-значения компенсируют строковый тип фасета каталога", () => {
  const projected = projectReasoningRangeCriteria(
    [{ key: "Световой поток", op: "min", value: 3750, unit: "лм", level: "A" }],
    "Нужен световой поток 3750–5000 лм",
    [{
      key: "flow",
      caption: "Световой поток",
      type: "checkbox",
      unit: "лм",
      values: [{ value: "3000" }, { value: "4000" }, { value: "5000" }],
    }],
  );
  assertEquals(projected.added, [
    {
      key: "Световой поток",
      op: "range",
      value: [3750, 5000],
      unit: "лм",
      level: "A",
    },
  ]);
});

Deno.test("слова рядом с диапазоном разрешают неоднозначность live-фасетов", () => {
  const projected = projectReasoningRangeCriteria(
    [],
    "Для комнаты нужен суммарный световой поток 3750–5000 лм.",
    [
      {
        key: "lamp_flow",
        caption: "Световой поток",
        type: "checkbox",
        unit: "лм",
        values: [{ value: "4000" }],
      },
      {
        key: "module_flow",
        caption: "Поток светодиодного модуля",
        type: "checkbox",
        unit: "лм",
        values: [{ value: "4100" }],
      },
    ],
  );
  assertEquals(projected.added, [
    {
      key: "Световой поток",
      op: "range",
      value: [3750, 5000],
      unit: "лм",
      level: "A",
    },
  ]);
});

Deno.test("единица из live-подписи компенсирует пустое поле unit", () => {
  const projected = projectReasoningRangeCriteria(
    [],
    "Нужен световой поток 3750–5000 лм",
    [{
      key: "flow_lm",
      caption: "Световой поток, Лм",
      type: "checkbox",
      unit: null,
      values: [{ value: "4000" }],
    }],
  );
  assertEquals(projected.added, [
    {
      key: "Световой поток, Лм",
      op: "range",
      value: [3750, 5000],
      unit: "лм",
      level: "A",
    },
  ]);
});

Deno.test("часть длинного слова в подписи не выдаётся за физическую единицу", () => {
  const temperatureOnly = projectReasoningRangeCriteria(
    [],
    "Требуется длительный ток не менее 17 А.",
    [{
      key: "installation_temperature",
      caption: "Температура монтажа",
      type: "string",
      unit: null,
      values: [{ value: "-15+50 °C" }],
    }],
  );
  assertEquals(temperatureOnly.added, []);

  const withCurrent = projectReasoningRangeCriteria(
    [],
    "Требуется длительный ток не менее 17 А.",
    [
      {
        key: "installation_temperature",
        caption: "Температура монтажа",
        type: "string",
        unit: null,
        values: [{ value: "-15+50 °C" }],
      },
      {
        key: "rated_current",
        caption: "Допустимый ток, А",
        type: "string",
        unit: null,
        values: [{ value: "16" }, { value: "25" }],
      },
    ],
  );
  assertEquals(withCurrent.added, [{
    key: "Допустимый ток, А",
    op: "min",
    value: 17,
    unit: "а",
    level: "A",
  }]);
});

Deno.test("machine-key suffix cannot override the public physical unit", () => {
  const projected = projectReasoningRangeCriteria(
    [],
    "Для стабилизатора нужен диапазон входного напряжения 140–260 В.",
    [
      {
        key: "moschnosty__vt__quat__v",
        caption: "Мощность, Вт",
        type: "number",
        unit: null,
        values: [{ value: "8000-9000" }],
      },
      {
        key: "vhodnoe_napryaghenie__v__kirmeli_kerneui__v",
        caption: "Входное напряжение, В",
        type: "checkbox",
        unit: null,
        values: [{ value: "140-260" }],
      },
    ],
  );
  assertEquals(projected.added, [{
    key: "Входное напряжение, В",
    op: "range",
    value: [140, 260],
    unit: "в",
    level: "A",
  }]);
});

Deno.test("точное число клиента проецируется на разделенный live-фасет", () => {
  const projected = projectLiteralMeasuredCriteria(
    [],
    "Нужен аппарат 16 А",
    "Подбираю аппарат на 16 А.",
    [{
      key: "rated_current",
      caption: "Номинальный ток, А",
      type: "checkbox",
      unit: "А",
      values: [{ value: "6" }, { value: "16" }],
    }],
  );
  assertEquals(projected.added, [{
    key: "Номинальный ток, А",
    op: "eq",
    value: "16",
    unit: "А",
    level: "A",
  }]);
});

Deno.test("Latin and Cyrillic unit glyphs preserve one exact live measurement", () => {
  const projected = projectLiteralMeasuredCriteria(
    [],
    "Покажи лампы с тёплым светом 3000 K",
    "Проверяю точное значение 3000 K.",
    [{
      key: "colour_temperature",
      caption: "Цветовая температура, К",
      type: "checkbox",
      unit: "К",
      values: [{ value: "2700" }, { value: "3000" }, { value: "4000" }],
    }],
  );
  assertEquals(projected.added, [{
    key: "Цветовая температура, К",
    op: "eq",
    value: "3000",
    unit: "К",
    level: "A",
  }]);
  assertEquals(projected.matched, projected.added);
});

Deno.test("guarded exact criterion disambiguates an otherwise ambiguous literal measurement", () => {
  const existing: Criterion = {
    key: "Цветовая температура, К",
    op: "eq",
    value: "3000",
    level: "A",
  };
  const projected = projectLiteralMeasuredCriteria(
    [existing],
    "Есть ли варианты 3000К?",
    "Проверяю точно 3000К.",
    [
      {
        key: "colour_temperature",
        caption: "Цветовая температура, К",
        type: "string",
        unit: null,
        values: [{ value: "3000" }, { value: "4000" }],
      },
      {
        key: "opaque_number",
        caption: "Внутренний код",
        type: "string",
        unit: null,
        values: [{ value: "3000" }],
      },
    ],
  );

  assertEquals(projected.added, []);
  assertEquals(projected.matched, [existing]);
});

Deno.test("explicit schema unit wins over unrelated unitless facets with the same live value", () => {
  const projected = projectLiteralMeasuredCriteria(
    [],
    "Покажи LED-лампы E27 с тёплым светом 3000 K",
    "Ищу лампы с тёплым светом.",
    [
      {
        key: "colour_temperature",
        caption: "Цветовая температура, К",
        type: "string",
        unit: null,
        values: [{ value: "2700" }, { value: "3000" }, { value: "4000" }],
      },
      {
        key: "average_lifetime",
        caption: "Средний номинальный срок службы, ч",
        type: "string",
        unit: null,
        values: [{ value: "3000" }, { value: "15000" }],
      },
      {
        key: "opaque_number",
        caption: "Внутренний код",
        type: "string",
        unit: null,
        values: [{ value: "3000" }],
      },
    ],
  );

  assertEquals(projected.added, [{
    key: "Цветовая температура, К",
    op: "eq",
    value: "3000",
    unit: "к",
    level: "A",
  }]);
  assertEquals(projected.matched, projected.added);
});

Deno.test("visible reasoning may disambiguate but cannot invent a customer-owned exact value", () => {
  const criterion: Criterion = {
    key: "Цветовая температура, К",
    op: "eq",
    value: "3000",
    level: "A",
  };
  const facets = [
    {
      key: "colour_temperature",
      caption: "Цветовая температура, К",
      type: "string",
      unit: null,
      values: [{ value: "2700" }, { value: "3000" }],
    },
    {
      key: "working_temperature",
      caption: "Рабочая температура, К",
      type: "string",
      unit: null,
      values: [{ value: "3000" }],
    },
  ];

  assertEquals(
    customerOwnsDerivedExactFacetValue(
      criterion,
      "Покажи LED-лампы E27 с тёплым светом 3000 K",
      "Обязательная цветовая температура — 3000 K.",
      facets,
    ),
    true,
  );
  assertEquals(
    customerOwnsDerivedExactFacetValue(
      criterion,
      "Покажи LED-лампы E27 с тёплым светом",
      "Обязательная цветовая температура — 3000 K.",
      facets,
    ),
    false,
  );
});

Deno.test("unitless live-фасет выбирается только после исключения явно другой шкалы", () => {
  const projected = projectLiteralMeasuredCriteria(
    [],
    "Нужен аппарат с номинальным током 16 А",
    "Подбираю аппарат на 16 А.",
    [
      {
        key: "cable_section",
        caption: "Макс. сечение кабеля, мм2",
        type: "checkbox",
        unit: null,
        values: [{ value: "6" }, { value: "16" }],
      },
      {
        key: "rated_current",
        caption: "Номинальный ток",
        type: "checkbox",
        unit: null,
        values: [{ value: "6" }, { value: "16" }],
      },
    ],
  );
  assertEquals(projected.added, [{
    key: "Номинальный ток",
    op: "eq",
    value: "16",
    unit: "а",
    level: "A",
  }]);
});

Deno.test("a typical model range remains advisory instead of becoming mandatory", () => {
  const projected = projectReasoningRangeCriteria(
    [],
    "Для квартиры 4,5–6 кА отключающей способности обычно хватает, но проверю выборку.",
    [{
      key: "breaking_capacity",
      caption: "Номинальная отключающая способность, кА",
      type: "checkbox",
      unit: "кА",
      values: [{ value: "4.5" }, { value: "6" }],
    }],
  );
  assertEquals(projected.added, []);
});

Deno.test("an ordinary illustrative range is not promoted by the word usually alone", () => {
  const projected = projectReasoningRangeCriteria(
    [],
    "Сечение вспомогательных жил обычно 0,5–0,75 мм².",
    [{
      key: "section",
      caption: "Сечение кабеля, мм2",
      type: "checkbox",
      unit: "мм²",
      values: [{ value: "0.5" }, { value: "0.75" }],
    }],
  );
  assertEquals(projected.added, []);
});

Deno.test("an unqualified engineering range cannot bind a qualified capability facet", () => {
  const contract = compileMeasuredReasoningSearchContract(
    [],
    "Номинальный ток 25 А соответствует защите линии сечением 2,5–4 мм².",
    [],
    [{
      key: "max_connected_section",
      caption: "Макс. сечение подключаемого кабеля, мм2",
      type: "checkbox",
      unit: "мм²",
      values: [{ value: "16" }, { value: "25" }, { value: "35" }],
    }],
  );

  assertEquals(contract.projected_criteria, []);
  assertEquals(contract.mandatory_criteria, []);
  assertEquals(contract.options, {});
});

Deno.test("direct product measurement can bind one otherwise unitless live facet", () => {
  const projected = projectLiteralMeasuredCriteria(
    [],
    "Мне нужен аппарат на 25 А",
    "Мне нужен аппарат на 25 А",
    [{
      key: "rated_current",
      caption: "Номинальный ток",
      type: "checkbox",
      unit: null,
      values: [{ value: "16" }, { value: "25" }, { value: "32" }],
    }],
  );
  assertEquals(projected.added, [{
    key: "Номинальный ток",
    op: "eq",
    value: "25",
    unit: "а",
    level: "A",
  }]);
});

Deno.test("bare measurement in an anchored product-spec list binds the unique live facet", () => {
  const projected = projectLiteralMeasuredCriteria(
    [{
      key: "Количество полюсов",
      op: "eq",
      value: "1",
      level: "A",
      evidence: "user_explicit",
    }],
    "Найди аппарат до 1000 тенге 1 полюсной, 16 А характеристика С",
    "Найди аппарат до 1000 тенге 1 полюсной, 16 А характеристика С",
    [
      {
        key: "pole_count",
        caption: "Количество полюсов",
        type: "checkbox",
        unit: null,
        values: [{ value: "1" }, { value: "2" }],
      },
      {
        key: "cable_section",
        caption: "Макс. сечение кабеля, мм2",
        type: "checkbox",
        unit: null,
        values: [{ value: "6" }, { value: "16" }],
      },
      {
        key: "rated_current",
        caption: "Номинальный ток",
        type: "checkbox",
        unit: null,
        values: [{ value: "6" }, { value: "16" }],
      },
    ],
  );
  assertEquals(projected.added, [{
    key: "Номинальный ток",
    op: "eq",
    value: "16",
    unit: "а",
    level: "A",
  }]);
});

Deno.test("an unrelated facet anchor cannot turn a named installation height into a product scalar", () => {
  const projected = projectLiteralMeasuredCriteria(
    [{
      key: "Цвет корпуса",
      op: "eq",
      value: "черный",
      level: "A",
      evidence: "user_explicit",
    }],
    "Нужен черный прожектор, высота установки примерно 1,5 м",
    "Нужен черный прожектор, высота установки примерно 1,5 м",
    [
      {
        key: "colour",
        caption: "Цвет корпуса",
        type: "checkbox",
        unit: null,
        values: [{ value: "черный" }],
      },
      {
        key: "weight",
        caption: "Вес",
        type: "checkbox",
        unit: null,
        values: [{ value: "1.5" }, { value: "2" }],
      },
    ],
  );
  assertEquals(projected.added, []);
  assertEquals(projected.matched, []);
});

Deno.test("application load after for-clause cannot bind a unitless product facet", () => {
  const projected = projectLiteralMeasuredCriteria(
    [],
    "Нужен аппарат для нагрузки на 25 А",
    "Нужен аппарат для нагрузки на 25 А",
    [{
      key: "rated_current",
      caption: "Номинальный ток",
      type: "checkbox",
      unit: null,
      values: [{ value: "16" }, { value: "25" }, { value: "32" }],
    }],
  );
  assertEquals(projected.added, []);
});

Deno.test("application height cannot become a unitless product facet with the same scalar", () => {
  const projected = projectLiteralMeasuredCriteria(
    [],
    "Двор 35 м², высота установки примерно 1,5 м",
    "Двор 35 м², высота установки примерно 1,5 м",
    [{
      key: "ves__salmaғy",
      caption: "Вес",
      type: "checkbox",
      unit: null,
      values: [{ value: "1.5" }, { value: "2" }],
    }],
  );
  assertEquals(projected.added, []);
  assertEquals(projected.matched, []);
});

Deno.test("natural customer area projects onto an ASCII-square live facet", () => {
  const projected = projectLiteralMeasuredCriteria(
    [],
    "Зал 30 квадратов",
    "Подбираю современный вариант для зала.",
    [{
      key: "max_area",
      caption: "Максимальная площадь освещения, м2",
      type: "checkbox",
      unit: null,
      values: [{ value: "25" }, { value: "30" }, { value: "35" }],
    }],
  );
  assertEquals(projected.added, [{
    key: "Максимальная площадь освещения, м2",
    op: "min",
    value: "30",
    unit: "м²",
    level: "A",
  }]);
});

Deno.test("направленная величина клиента не сужается до точного равенства", () => {
  const projected = projectLiteralMeasuredCriteria(
    [],
    "Нужна мощность от 100 Вт",
    "Требуется не менее 100 Вт.",
    [{
      key: "power",
      caption: "Мощность, Вт",
      type: "number",
      unit: "Вт",
      values: [{ value: "100" }, { value: "150" }],
    }],
  );
  assertEquals(projected.added, []);
});

Deno.test("противоположные направления одного размера не превращаются в eq", () => {
  const projected = projectLiteralMeasuredCriteria(
    [],
    "Размер детали 10 мм",
    "До установки нужен размер больше 10 мм, после установки — меньше 10 мм.",
    [
      {
        key: "before",
        caption: "Размер до установки",
        type: "number",
        unit: "мм",
        values: [{ value: "10" }],
      },
      {
        key: "after",
        caption: "Размер после установки",
        type: "number",
        unit: "мм",
        values: [{ value: "10" }],
      },
    ],
  );
  assertEquals(projected.added, []);
});

Deno.test("два равноправных live-фасета одной единицы не выбираются наугад", () => {
  const projected = projectLiteralMeasuredCriteria(
    [],
    "Нужен параметр 10 мм",
    "Подбираю значение 10 мм.",
    [
      {
        key: "alpha",
        caption: "Параметр альфа",
        type: "number",
        unit: "мм",
        values: [{ value: "10" }],
      },
      {
        key: "beta",
        caption: "Параметр бета",
        type: "number",
        unit: "мм",
        values: [{ value: "10" }],
      },
    ],
  );
  assertEquals(projected.added, []);
});

Deno.test("числовой критерий из рассуждения повышается с B до обязательного A", () => {
  const result = promoteMeasuredReasoningCriteria([
    { key: "Световой поток", op: "min", value: 3750, unit: "лм", level: "B" },
    { key: "Цвет", op: "eq", value: "белый", level: "B" },
  ], "Для задачи нужен поток 3750–5000 лм");
  assertEquals(result.criteria, [
    { key: "Световой поток", op: "min", value: 3750, unit: "лм", level: "A" },
    { key: "Цвет", op: "eq", value: "белый", level: "B" },
  ]);
  assertEquals(result.promoted, ["Световой поток"]);
});

Deno.test("составная входная единица не конфликтует с производной товарной единицей", () => {
  const projected = projectReasoningRangeCriteria(
    [],
    "25 м² × 150–200 лм/м² = 3750–5000 лм",
    [{
      key: "output_flow",
      caption: "Выходной поток, лм",
      type: "number",
      unit: "лм",
      values: [{ value: "3750" }, { value: "4000" }, { value: "5000" }],
    }],
  );
  assertEquals(projected.added, [{
    key: "Выходной поток, лм",
    op: "range",
    value: [3750, 5000],
    unit: "лм",
    level: "A",
  }]);
});

Deno.test("живой фасет восстанавливает пропущенную моделью единицу обязательного критерия", () => {
  const result = promoteMeasuredReasoningCriteria(
    [{ key: "output_flow", op: "range", value: [3750, 5000], level: "B" }],
    "Нужен диапазон 3750–5000 лм",
    [{
      key: "output_flow",
      caption: "Выходной поток, лм",
      unit: "лм",
      values: [{ value: "4000" }],
    }],
  );
  assertEquals(result.criteria, [{
    key: "output_flow",
    op: "range",
    value: [3750, 5000],
    unit: "лм",
    level: "A",
  }]);
  assertEquals(result.promoted, ["output_flow"]);
});

Deno.test("alignCriteriaWithReasoning: eq на числе клиента → min по прозе", () => {
  const criteria: Criterion[] = [
    { key: "Параметр альфа", op: "eq", value: 12, unit: "мм", level: "A" },
  ];
  const r = alignCriteriaWithReasoning(
    criteria,
    "Диаметр должен быть больше 12 мм с запасом.",
  );
  assertEquals(r.alignments.length, 1);
  assertEquals(r.criteria[0].op, "min");
  assertEquals(r.criteria[0].exclusive, true);
});

Deno.test("строгость задаёт только проза системы, а не совпадение с числом клиента", () => {
  const criteria: Criterion[] = [
    { key: "Параметр альфа", op: "min", value: 12, unit: "мм", level: "A" },
  ];
  const strict = alignCriteriaWithReasoning(
    criteria,
    "нужен размер больше 12 мм",
  );
  const inclusive = alignCriteriaWithReasoning(
    criteria,
    "нужен размер не менее 12 мм",
  );
  assertEquals(strict.criteria[0].exclusive, true);
  assertEquals(inclusive.criteria[0].exclusive === true, false);
});

Deno.test("alignCriteriaWithReasoning: порог не выдумывается без совпадения числа", () => {
  const criteria: Criterion[] = [
    { key: "Параметр альфа", op: "eq", value: 12, unit: "мм", level: "A" },
  ];
  const r = alignCriteriaWithReasoning(criteria, "нужен запас не менее 40 мм");
  assertEquals(r.alignments.length, 0);
  assertEquals(r.criteria[0].op, "eq");
});

Deno.test("alignCriteriaWithReasoning: уровень B не трогаем", () => {
  const criteria: Criterion[] = [
    { key: "Параметр бета", op: "eq", value: 12, unit: "мм", level: "B" },
  ];
  const r = alignCriteriaWithReasoning(criteria, "больше 12 мм");
  assertEquals(r.alignments.length, 0);
});

Deno.test("гейт: строгое неравенство отсеивает границу", () => {
  const p = product("1", ["Параметр альфа: 12/6 мм"]);
  const strict: Criterion = {
    key: "Параметр альфа",
    op: "min",
    value: 12,
    unit: "мм",
    exclusive: true,
  };
  const loose: Criterion = {
    key: "Параметр альфа",
    op: "min",
    value: 12,
    unit: "мм",
  };
  assertEquals(checkCriterion(p, strict).verdict, "fail");
  assertEquals(checkCriterion(p, loose).verdict, "pass");
});

Deno.test("строгая формулировка побеждает нестрогую по тому же числу", () => {
  const criteria: Criterion[] = [
    { key: "Параметр альфа", op: "min", value: 12, unit: "мм", level: "A" },
  ];
  const r = alignCriteriaWithReasoning(
    criteria,
    "нужен диаметр больше 12 мм; то есть ≥ 12 мм; беру типоразмеры от 12 мм",
  );
  assertEquals(r.alignments.length, 1);
  assertEquals(r.criteria[0].op, "min");
  assertEquals(r.criteria[0].exclusive, true);
  assertEquals(r.ambiguities.length, 0);
});

Deno.test("противоположные направления: направление берём машинное, строгость — из прозы", () => {
  const criteria: Criterion[] = [
    { key: "Параметр альфа", op: "min", value: 12, unit: "мм", level: "A" },
  ];
  const r = alignCriteriaWithReasoning(
    criteria,
    "до усадки больше 12 мм, после усадки меньше 12 мм",
  );
  assertEquals(r.criteria[0].op, "min");
  assertEquals(r.criteria[0].exclusive, true);
  assertEquals(r.ambiguities.length, 0);
});

Deno.test("противоположные направления без совпадения с машинным op → ambiguity", () => {
  const criteria: Criterion[] = [
    { key: "Параметр альфа", op: "eq", value: 12, unit: "мм", level: "A" },
  ];
  const r = alignCriteriaWithReasoning(
    criteria,
    "до усадки больше 12 мм, после усадки меньше 12 мм",
  );
  assertEquals(r.alignments.length, 0);
  assertEquals(r.criteria[0].op, "eq");
  assertEquals(r.ambiguities.length, 2);
});

Deno.test("регресс fd817c18: трубка 12/6 не проходит после выравнивания", () => {
  const reasoning = [
    "ищу трубки с исходным диаметром (до усадки) больше 12 мм — чтобы надеть кабель, — и усаженным диаметром меньше 12 мм",
    "внутренний диаметр до усадки ≥ 12 мм",
    "иду смотреть типоразмеры с внутренним диаметром от 12 мм",
  ].join("\n");
  const criteria: Criterion[] = [
    {
      key: "Внутр диаметр до термоусадки, мм",
      op: "min",
      value: 12,
      unit: "мм",
      level: "A",
    },
  ];
  const r = alignCriteriaWithReasoning(criteria, reasoning);
  assertEquals(r.criteria[0].exclusive, true);
  const p = product("1", ["Внутр диаметр до термоусадки, мм: 12"]);
  assertEquals(checkCriterion(p, r.criteria[0]).verdict, "fail");
});

Deno.test("регресс 3f72aef8: направление max не переворачивается прозой «больше 10 мм»", () => {
  // Проза модели: «до усадки чуть больше 10 мм … после усадки — меньше 10
  // (чтобы обжать)». Второе число без единицы, парсер его отбрасывает —
  // остаётся одна граница min:10 strict. Она НЕ должна перевернуть критерий
  // «после усадки max 10», иначе требование становится невыполнимым.
  const reasoning =
    "внутренний диаметр до усадки чуть больше 10 мм (чтобы надеть), а после усадки — меньше 10 (чтобы плотно обжать)";
  const criteria: Criterion[] = [
    {
      key: "Внутр диаметр до термоусадки",
      op: "min",
      value: 10,
      unit: "мм",
      level: "A",
    },
    {
      key: "Внутр диаметр после термоусадки",
      op: "max",
      value: 10,
      unit: "мм",
      level: "A",
    },
  ];
  const r = alignCriteriaWithReasoning(criteria, reasoning);
  assertEquals(r.criteria[0].op, "min");
  assertEquals(r.criteria[0].exclusive, true);
  assertEquals(r.criteria[1].op, "max");
  assertEquals(r.criteria[1].exclusive, undefined);
  assertEquals(r.alignments.length, 1);
  assertEquals(r.ambiguities.length, 1);
  // Трубка 12/6 проходит оба критерия.
  const p = product("1", [
    "Внутр диаметр до термоусадки: 12",
    "Внутр диаметр после термоусадки: 6",
  ]);
  assertEquals(checkCriterion(p, r.criteria[0]).verdict, "pass");
  assertEquals(checkCriterion(p, r.criteria[1]).verdict, "pass");
});

Deno.test("«не менее» не сбивает уже строгий min", () => {
  const criteria: Criterion[] = [
    {
      key: "Параметр альфа",
      op: "min",
      value: 10,
      unit: "мм",
      level: "A",
      exclusive: true,
    },
  ];
  const r = alignCriteriaWithReasoning(criteria, "нужен размер не менее 10 мм");
  assertEquals(r.criteria[0].exclusive, true);
  assertEquals(r.alignments.length, 0);
});

Deno.test("advisory model defaults do not become mandatory filters", () => {
  const criteria: Criterion[] = [
    {
      key: "Параметр альфа",
      op: "range",
      value: [30, 40],
      unit: "ед",
      level: "A",
    },
    { key: "Параметр бета", op: "eq", value: "нейтральный", level: "A" },
    { key: "Параметр гамма", op: "eq", value: "внутренний", level: "A" },
  ];
  const aligned = alignCriteriaImportanceWithReasoning(
    criteria,
    "Значит, нужен параметр альфа 30–40 ед. Параметр бета логичнее нейтральный. Параметр гамма — внутренний.",
  );
  assertEquals(aligned.criteria.map((criterion) => criterion.level), [
    "A",
    "B",
    "B",
  ]);
  assertEquals(aligned.demoted, ["Параметр бета", "Параметр гамма"]);
});

Deno.test("user-backed criterion stays mandatory without necessity wording", () => {
  const criterion: Criterion = {
    key: "Параметр дельта",
    op: "eq",
    value: "точный",
    level: "A",
  };
  const aligned = alignCriteriaImportanceWithReasoning(
    [criterion],
    "Параметр дельта — точный.",
    [criterion],
  );
  assertEquals(aligned.criteria[0].level, "A");
  assertEquals(aligned.demoted, []);
});

Deno.test("calculated result remains mandatory without a modal verb", () => {
  const criterion: Criterion = {
    key: "Параметр результата",
    op: "range",
    value: [3750, 5000],
    unit: "ед",
    level: "A",
  };
  const aligned = alignCriteriaImportanceWithReasoning(
    [criterion],
    "25 ед × 150–200 ед = 3750–5000 ед суммарного результата.",
  );
  assertEquals(aligned.criteria[0].level, "A");
  assertEquals(aligned.demoted, []);
});

Deno.test("projected measured range keeps one contract across equivalent reasoning wording", () => {
  const facets = [{
    key: "measured_output",
    caption: "Measured output, lm",
    type: "number",
    unit: "lm",
    values: [{ value: "3000" }, { value: "3750" }, { value: "4000" }, {
      value: "5000",
    }, { value: "6000" }],
  }];
  const softFilters: Criterion[] = [
    { key: "Mounting", op: "eq", value: "ceiling", level: "A" },
  ];
  const contract = compileMeasuredReasoningSearchContract(
    softFilters,
    "For the stated area this gives the required measured output of approximately 3750-5000 lm. Mounting is preferably ceiling.",
    [],
    facets,
  );
  assertEquals(contract.projected_criteria, [
    {
      key: "Measured output, lm",
      op: "range",
      value: [3750, 5000],
      unit: "lm",
      level: "A",
    },
  ]);
  assertEquals(contract.mandatory_criteria, contract.projected_criteria);
  assertEquals(contract.options, { measured_output: ["3750", "4000", "5000"] });
  assertEquals(contract.demoted, ["Mounting"]);
});

Deno.test("projected measured range is not demoted by comfort wording", () => {
  const facets = [{
    key: "svetovoy_potok",
    caption: "Световой поток, лм",
    type: "number",
    unit: "лм",
    values: [{ value: "3000" }, { value: "3750" }, { value: "4000" }, {
      value: "5000",
    }],
  }];
  const contract = compileMeasuredReasoningSearchContract(
    [],
    "Для комфортного освещения это даёт потребный световой поток примерно 3750–5000 лм.",
    [],
    facets,
  );
  assertEquals(
    contract.mandatory_criteria.map((criterion) => criterion.level),
    ["A"],
  );
  assertEquals(contract.options, { svetovoy_potok: ["3750", "4000", "5000"] });
});

Deno.test("a bare derived up-to capability does not become a product maximum", () => {
  const facets = [{
    key: "rated_voltage",
    caption: "Номинальное напряжение, кВ",
    type: "string",
    unit: null,
    values: [{ value: "≤ 0.66" }, { value: "≤ 1" }, { value: "≤ 10" }],
  }];
  const derived = compileMeasuredReasoningSearchContract(
    [],
    "Изделие должно относиться к классу, рассчитанному на напряжение до 1 кВ.",
    [],
    facets,
  );
  assertEquals(derived.projected_criteria, []);
  assertEquals(derived.mandatory_criteria, []);

  const explicit = compileMeasuredReasoningSearchContract(
    [],
    "По условию клиента номинальное напряжение должно быть не более 1 кВ.",
    [],
    facets,
  );
  assertEquals(explicit.projected_criteria, [{
    key: "Номинальное напряжение, кВ",
    op: "max",
    value: 1,
    unit: "кв",
    level: "A",
  }]);
});

Deno.test("an exact live application class remains mandatory while colour stays advisory", () => {
  const contract = compileMeasuredReasoningSearchContract(
    [
      {
        key: "Вид исполнения",
        op: "eq",
        value: "Внутренний класс",
        level: "A",
      },
      { key: "Цвет", op: "eq", value: "Нейтральный", level: "A" },
    ],
    "Для указанного помещения рекомендую категорию «Внутренний класс» с нейтральным цветом.",
    [],
    [
      {
        key: "kind",
        caption: "Вид исполнения",
        type: "checkbox",
        unit: null,
        values: [{ value: "Внутренний класс" }],
      },
      {
        key: "colour",
        caption: "Цвет",
        type: "checkbox",
        unit: null,
        values: [{ value: "Нейтральный" }],
      },
    ],
  );

  assertEquals(contract.mandatory_criteria, [
    { key: "Вид исполнения", op: "eq", value: "Внутренний класс", level: "A" },
  ]);
  assertEquals(contract.options, { kind: ["Внутренний класс"] });
  assertEquals(contract.demoted, ["Цвет"]);
});

Deno.test("classification wording cannot promote an adjacent exact colour value", () => {
  const contract = compileMeasuredReasoningSearchContract(
    [
      {
        key: "Вид светильника",
        op: "eq",
        value: "бытовые светильники накладные",
        level: "A",
      },
      { key: "Цвет корпуса", op: "eq", value: "белый", level: "A" },
    ],
    "По классу «Вид светильника» выбираю «бытовые светильники накладные», цвет корпуса — белый.",
    [],
    [
      {
        key: "kind",
        caption: "Вид светильника",
        type: "checkbox",
        unit: null,
        values: [{ value: "бытовые светильники накладные" }],
      },
      {
        key: "colour",
        caption: "Цвет корпуса",
        type: "checkbox",
        unit: null,
        values: [{ value: "белый" }],
      },
    ],
  );

  assertEquals(contract.mandatory_criteria, [
    {
      key: "Вид светильника",
      op: "eq",
      value: "бытовые светильники накладные",
      level: "A",
    },
  ]);
  assertEquals(contract.options, { kind: ["бытовые светильники накладные"] });
  assertEquals(contract.demoted, ["Цвет корпуса"]);
});

Deno.test("a compound canonical class containing semicolons remains one obligation", () => {
  const contract = compileMeasuredReasoningSearchContract(
    [{
      key: "Вид исполнения",
      op: "eq",
      value: "первый; второй; третий",
      level: "A",
    }],
    "По классу «Вид исполнения» выбираю «первый; второй; третий».",
    [],
    [{
      key: "kind",
      caption: "Вид исполнения",
      type: "checkbox",
      unit: null,
      values: [{ value: "первый; второй; третий" }],
    }],
  );

  assertEquals(contract.mandatory_criteria, [
    {
      key: "Вид исполнения",
      op: "eq",
      value: "первый; второй; третий",
      level: "A",
    },
  ]);
  assertEquals(contract.options, { kind: ["первый; второй; третий"] });
});

Deno.test("advisory catalog filters are removed even when no measured range can be projected", () => {
  const contract = compileMeasuredReasoningSearchContract(
    [
      { key: "Protection", op: "eq", value: "IP65", level: "A" },
      { key: "Material", op: "eq", value: "aluminium", level: "A" },
    ],
    "For this use I first look at protection IP65. Aluminium is a useful housing material.",
    [],
    [
      {
        key: "protection",
        caption: "Protection",
        type: "checkbox",
        unit: null,
        values: [{ value: "IP65" }],
      },
      {
        key: "material",
        caption: "Material",
        type: "checkbox",
        unit: null,
        values: [{ value: "aluminium" }],
      },
    ],
  );
  assertEquals(contract.projected_criteria, []);
  assertEquals(contract.mandatory_criteria, []);
  assertEquals(contract.options, {});
  assertEquals(contract.demoted, ["Protection", "Material"]);
});

Deno.test("an otherwise unbounded selection promotes only projectable measured criteria", () => {
  const aligned = promoteProjectableMeasuredFallbackCriteria([
    { key: "Measured output", op: "min", value: 3750, unit: "lm", level: "B" },
    { key: "Colour", op: "eq", value: "neutral", level: "B" },
  ], [{
    key: "measured_output",
    caption: "Measured output",
    unit: "lm",
    values: [{ value: "3000" }, { value: "4000" }],
  }]);
  assertEquals(aligned.criteria.map((criterion) => criterion.level), [
    "A",
    "B",
  ]);
  assertEquals(aligned.promoted, ["Measured output"]);
});

Deno.test("a measured preference already demoted as advisory cannot be promoted again", () => {
  const criteria: Criterion[] = [
    { key: "Measured output", op: "min", value: 3750, unit: "lm", level: "A" },
  ];
  const importance = alignCriteriaImportanceWithReasoning(
    criteria,
    "Measured output 3750 lm is one possible reference point.",
  );
  const aligned = promoteProjectableMeasuredFallbackCriteria(
    importance.criteria,
    [{
      key: "measured_output",
      caption: "Measured output",
      unit: "lm",
      values: [{ value: "4000" }],
    }],
    importance.demoted,
  );
  assertEquals(importance.demoted, ["Measured output"]);
  assertEquals(aligned.criteria.map((criterion) => criterion.level), ["B"]);
  assertEquals(aligned.promoted, []);
});

Deno.test("render-only model criteria cannot retroactively strengthen an ordinary search", () => {
  const frozen: Criterion[] = [
    {
      key: "Measured output",
      op: "range",
      value: [3750, 5000],
      unit: "lm",
      level: "A",
    },
  ];
  const aligned = demoteUnfrozenRenderCriteria([
    ...frozen,
    { key: "Implementation count", op: "eq", value: 5, level: "A" },
  ], frozen);
  assertEquals(aligned.criteria, [
    frozen[0],
    { key: "Implementation count", op: "eq", value: 5, level: "B" },
  ]);
  assertEquals(aligned.demoted, ["Implementation count"]);
});

Deno.test("render-only replacement criteria cannot strengthen a compiled retrieval contract", () => {
  const frozen: Criterion[] = [
    { key: "Номинальный ток", op: "eq", value: 16, unit: "А", level: "A" },
    {
      key: "Характеристика срабатывания",
      op: "eq",
      value: "Тип C",
      level: "A",
    },
  ];
  const aligned = demoteUnfrozenRenderCriteria([
    ...frozen,
    { key: "Вес", op: "max", value: 1, unit: "кг", level: "A" },
  ], frozen);
  assertEquals(
    aligned.criteria.map((criterion) => [criterion.key, criterion.level]),
    [
      ["Номинальный ток", "A"],
      ["Характеристика срабатывания", "A"],
      ["Вес", "B"],
    ],
  );
  assertEquals(aligned.demoted, ["Вес"]);
});

Deno.test("fallback promotion preserves an existing mandatory contract", () => {
  const aligned = promoteProjectableMeasuredFallbackCriteria([
    { key: "Exact class", op: "eq", value: "declared", level: "A" },
    { key: "Measured output", op: "min", value: 3750, unit: "lm", level: "B" },
  ], [{
    key: "measured_output",
    caption: "Measured output",
    unit: "lm",
    values: [{ value: "4000" }],
  }]);
  assertEquals(aligned.criteria.map((criterion) => criterion.level), [
    "A",
    "B",
  ]);
  assertEquals(aligned.promoted, []);
});
