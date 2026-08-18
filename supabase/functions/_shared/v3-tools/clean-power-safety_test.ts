import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { CLEAN_POWER_SAFETY_ANSWER, isCleanPowerSafetyRequest } from "./clean-power-safety.ts";

Deno.test("clean-power safety router recognizes generator plus sensitive load", () => {
  assert(isCleanPowerSafetyRequest(
    "Генератор даёт грязную энергию. Для газового котла и циркуляционного насоса нужна чистая энергия.",
  ));
  assertEquals(isCleanPowerSafetyRequest("Подбери стабилизатор напряжения для дачи"), false);
  assertEquals(isCleanPowerSafetyRequest("Нужен генератор 3 кВт"), false);
});

Deno.test("clean-power safety answer requires waveform evidence and rejects a plain stabilizer", () => {
  const answer = CLEAN_POWER_SAFETY_ANSWER.toLowerCase();
  assert(answer.includes("чистую синусоиду"));
  assert(answer.includes("двойным преобразованием"));
  assert(answer.includes("не обычный стабилизатор"));
  assert(answer.includes("не могу подтвердить карточку"));
});
