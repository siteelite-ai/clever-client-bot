import {assert, assertEquals} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {independentSelectionRequestBody} from "./request-preface.ts";

Deno.test("independent request frame recognizes grammatical orders without enumerating product classes", () => {
  for (const text of ["Ищу кабель для подземной линии", "Нам нужны датчики на 12 В",
    "Мне нужен инструмент для линии", "Подберите светильник для гаража",
    "Какой кабель подойдёт для прокладки в земле?"]) {
    assert(independentSelectionRequestBody(text), text);
  }
});

Deno.test("measurement answers and dependent order frames do not claim an independent subject", () => {
  for (const text of ["230 В, 1 фаза", "На входе 150 В", "Поправка: 150 В", "В трубе ПНД, длина 25 м",
    "По проекту C32, 2P, 6 кА", "Подберите по проекту C32, 2P, 6 кА", "Подберите для насоса",
    "Мне нужен для этой линии"]) assertEquals(independentSelectionRequestBody(text), null, text);
});
