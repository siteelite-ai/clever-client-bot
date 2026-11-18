import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveCircuitProtection } from "./circuit-protection-dialogue.ts";

function pending(
  message: string,
  key: string,
  prior: Record<string, unknown> | null = null,
) {
  const decision = resolveCircuitProtection(message, prior);
  assert(decision?.status === "ask", JSON.stringify(decision));
  assertEquals(decision.clarification.facet_key, key);
  return { ...decision.clarification, status: "pending" };
}

Deno.test("circuit protection preserves measured load, compound supply and line facts", () => {
  const supply = pending(
    "Какой автомат мне нужен для квартиры на 7 кВт?",
    "circuit_supply",
  );
  const phaseOnly = pending("Одна фаза", "circuit_supply", supply);
  const line = pending("230 В", "circuit_line", phaseOnly);
  const project = pending(
    "Отдельная линия, медь 6 мм², в трубе",
    "circuit_project",
    line,
  );
  assert(project.question.includes("Данные о кабеле и прокладке сохранены"));
  const partial = pending("По проекту C32, 2P", "circuit_project", project);
  assert(!partial.question.includes("число полюсов"));
  const result = resolveCircuitProtection("Не менее 6 кА", partial);
  assert(result?.status === "ready", JSON.stringify(result));
  assertEquals(result.criteria.map(({ op, value }) => [op, value]), [
    ["eq", 32],
    ["eq", 2],
    ["eq", "C"],
    ["min", 6],
    ["eq", 230],
  ]);
});

Deno.test("circuit protection keeps new tasks and direct nominal orders out of measured design flow", () => {
  const prior = pending(
    "Нужен автомат для квартиры на 7 кВт, 1 фаза 230 В",
    "circuit_line",
  );
  for (
    const text of [
      "Новая тема. Подбери автомат 25 А, 1P, характеристика C",
      "Подбери кабель для насоса 7 кВт",
      "Какой кабель нужен для автомата на нагрузку 7 кВт?",
      "Автомат для двигателя 7 кВт",
      "Автомат 25 А для квартиры",
      "Покажи светильник на 12 В",
      "Светильник на 12 В",
    ]
  ) assertEquals(resolveCircuitProtection(text, prior), null, text);
});

Deno.test("circuit protection never turns speculative load figures or an unsupported nominal into filters", () => {
  const load = pending(
    "Нужен автомат для квартиры: 7 кВт или 9 кВт",
    "circuit_load",
  );
  const supply = pending("7 кВт", "circuit_supply", load);
  const line = pending("230 В, 1 фаза", "circuit_line", supply);
  const project = pending("Ввод квартиры", "circuit_project", line);
  pending("C32, 2P, 6 кА", "circuit_project", project);
  pending("По проекту не C32, 2P, 6 кА", "circuit_project", project);
  pending("По проекту C32, 2P, до 6 кА", "circuit_project", project);
  pending(
    "По проекту расчётный ток 32 А, характеристика C, 2P, 6 кА",
    "circuit_project",
    project,
  );
  assertEquals(
    resolveCircuitProtection("Нет проекта", project)?.status,
    "stop",
  );
  assertEquals(
    resolveCircuitProtection("По проекту C25, 2P, 6 кА", project)?.status,
    "stop",
  );
});

Deno.test("changing the supply after partial project input invalidates previous electrical specifications", () => {
  const project = pending(
    "Нужен автомат для квартиры с нагрузкой 7 кВт на отдельную линию, 1 фаза 230 В",
    "circuit_project",
  );
  const partial = pending("По проекту C32, 2P", "circuit_project", project);
  const changed = pending(
    "Уточнение: не 1 фаза, а 3 фазы",
    "circuit_supply",
    partial,
  );
  const next = pending("400 В", "circuit_project", changed);
  assert(
    next.question.includes("номинал") &&
      next.question.includes("число полюсов"),
  );
  const result = resolveCircuitProtection("По проекту C16, 3P, 6 кА", next);
  assert(result?.status === "ready");
  assertEquals(result.criteria[4].value, 400);
});

Deno.test("circuit dialogue is not limited to 7 kW or a particular nominal", () => {
  for (const [load, supply, specification, current, poles, volts] of [
    ["9 кВт", "400 В, три фазы", "По проекту C16, 3P, 10 кА", 16, 3, 400],
    ["5 кВт", "220 В, одна фаза", "Электрик подтвердил B25, 2P, 6 кА", 25, 2, 220],
  ] as const) {
    const power = pending(`Нужен автомат для отдельной линии с нагрузкой ${load}`, "circuit_supply");
    const project = pending(supply, "circuit_project", power);
    const result = resolveCircuitProtection(specification, project);
    assert(result?.status === "ready", JSON.stringify(result));
    assertEquals(result.criteria[0].value, current);
    assertEquals(result.criteria[1].value, poles);
    assertEquals(result.criteria[4].value, volts);
  }
});

Deno.test("an explicit project rating does not discharge a missing supply and cannot fabricate missing poles", () => {
  const supply = pending("Нужен автомат для квартиры на 7 кВт. По проекту C32, 2P, 6 кА", "circuit_supply");
  const line = pending("230 В, одна фаза", "circuit_line", supply);
  const result = resolveCircuitProtection("Ввод квартиры", line);
  assert(result?.status === "ready", JSON.stringify(result));
  assertEquals(result.criteria.map(({ value }) => value), [32, 2, "C", 6, 230]);
  const project = pending("Нужен автомат для отдельной линии на 7 кВт, одна фаза 230 В", "circuit_project");
  const incomplete = pending("По проекту C32, 6 кА", "circuit_project", project);
  assert(incomplete.question.includes("число полюсов"));
  assertEquals(resolveCircuitProtection("Не знаю", incomplete)?.status, "stop");
});
