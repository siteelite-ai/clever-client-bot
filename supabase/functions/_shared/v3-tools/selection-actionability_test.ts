import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { hasActionableSelectionContract } from "./selection-actionability.ts";

Deno.test("two independent measured axes make a selection actionable", () => {
  assertEquals(hasActionableSelectionContract("нужно 40 Вт и поток 4000 лм"), true);
});

Deno.test("two-sided fit reasoning with one unit makes a selection actionable", () => {
  assertEquals(
    hasActionableSelectionContract(
      "объект 12 мм: изделие должно быть больше 12 мм до преобразования и меньше 12 мм после него",
    ),
    true,
  );
});

Deno.test("an isolated measurement may still require an objective clarification", () => {
  assertEquals(hasActionableSelectionContract("нужен размер 12 мм"), false);
});

Deno.test("actionability policy contains no product vocabulary", () => {
  const source = Deno.readTextFileSync(new URL("./selection-actionability.ts", import.meta.url)).toLocaleLowerCase("ru-RU");
  for (const forbidden of ["термоус", "люстр", "ламп", "кабель", "korn", "corn"]) {
    assertEquals(source.includes(forbidden), false);
  }
});
