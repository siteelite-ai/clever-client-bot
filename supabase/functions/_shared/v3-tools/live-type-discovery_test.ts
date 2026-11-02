import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveLiveTypeDiscovery } from "./live-type-discovery.ts";
import type { SubjectChoice } from "./selection-subject.ts";
const choices: SubjectChoice[] = [
  { id: "f0v0", key: "kind", facet: "Тип изделия", value: "бур по бетону" },
  { id: "f0v1", key: "kind", facet: "Тип изделия", value: "сверло по металлу" },
];
const resolve = (message: string, values = choices) =>
  resolveLiveTypeDiscovery({
    currentMessage: message,
    request: message,
    category: "Материалы для сверления",
    choices: values,
  });
Deno.test("live type: partial literal head asks one real choice without approving category or cards", () => {
  const d = resolve("Подбери бур для бетонной стены, диаметр 8 мм");
  assertEquals(d.status, "needs_input");
  if (d.status !== "needs_input") return;
  assertEquals(d.clarification.options, [{
    value: "бур по бетону",
    label: "бур по бетону",
  }]);
  assertEquals(
    d.clarification.scope?.token,
    "Подбери бур для бетонной стены, диаметр 8 мм",
  );
});
Deno.test("live type: full literal selecting identity binds the exact type criterion", () => {
  const d = resolve("бур по бетону");
  assertEquals(d.status, "literal_type");
  if (d.status !== "literal_type") return;
  assertEquals(d.subject.target, "бур по бетону");
  assertEquals(d.subject.criterion?.value, "бур по бетону");
});
Deno.test("live type: same head policy works across unrelated live categories without product exceptions", () => {
  for (
    const [head, value] of [["щит", "щит распределительный"], [
      "LED",
      "LED модуль",
    ], ["компрессор", "компрессор поршневой"]]
  ) {
    const cs = [{ id: "f0v0", key: "kind", facet: "Вид товара", value }];
    assertEquals(
      resolve("Мне нужен " + head + " для мастерской", cs).status,
      "needs_input",
    );
    assertEquals(resolve(value, cs).status, "literal_type");
  }
});
Deno.test("live type: application, brand, negation and substrings cannot nominate a different product", () => {
  const pumps = [{
    id: "f0v0",
    key: "kind",
    facet: "Тип изделия",
    value: "насос",
  }];
  for (
    const s of [
      "Нужен кабель для насос",
      "Найди кабель Насос",
      "для насоса нужен кабель",
      "не насос",
      "насос не нужен",
      "Найди насосный кабель",
      "Найди насос-кабель",
      "Найди насос_кабель",
      "Нужен насос или кабель",
    ]
  ) assertEquals(resolve(s, pumps).status, "unproven", s);
  assertEquals(resolve("замени насос на кабель", pumps).status, "unproven");
  assertEquals(
    resolve(
      "Подбери бур",
      choices.map((c) => ({ ...c, facet: "Материал обработки" })),
    ).status,
    "unproven",
  );
  assertEquals(
    resolve("Подбери бур", [...choices, {
      ...choices[0],
      id: "f1v0",
      key: "second",
    }]).status,
    "unproven",
  );
});
Deno.test("live type: a parameter answer cannot acquire type authority from browser history or a different verified facet", () => {
  const c = {
    currentMessage: "бур по бетону",
    request: "Подбери бур для стены --- Уточнение клиента: бур по бетону",
    category: "Материалы для сверления",
    choices,
  };
  assertEquals(resolveLiveTypeDiscovery(c).status, "unproven");
  assertEquals(
    resolveLiveTypeDiscovery({ ...c, verifiedChoiceFacet: "base_material" })
      .status,
    "unproven",
  );
  assertEquals(
    resolveLiveTypeDiscovery({ ...c, verifiedChoiceFacet: "kind" }).status,
    "literal_type",
  );
});
