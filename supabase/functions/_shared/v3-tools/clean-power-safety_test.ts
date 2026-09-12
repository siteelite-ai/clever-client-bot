import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildSensitiveBackupPowerAnswer, CLEAN_POWER_SAFETY_ANSWER, isCleanPowerSafetyRequest, isSensitiveBackupPowerRequest } from "./clean-power-safety.ts";

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

Deno.test("sensitive backup-power routing is structural across common product terms", () => {
  assert(isSensitiveBackupPowerRequest("Какой ИБП подойдет для газового котла мощностью 250 ватт?"));
  assert(isSensitiveBackupPowerRequest("Нужен UPS для циркуляционного насоса 180 W"));
  assert(isSensitiveBackupPowerRequest("Подбери источник бесперебойного питания для котла"));
  assertEquals(isSensitiveBackupPowerRequest("Нужен ИБП для компьютера"), false);
  assertEquals(isSensitiveBackupPowerRequest("Какой стабилизатор подойдет для котла"), false);
});

Deno.test("sensitive backup-power answer derives sizing and preserves every safety axis", () => {
  const answer = buildSensitiveBackupPowerAnswer("ИБП для газового котла 250 Вт");
  assert(answer.includes("чистой синусоидой"));
  assert(answer.includes("250 Вт"));
  assert(answer.includes("400 Вт"));
  assert(answer.includes("600 ВА"));
  assert(answer.includes("пусковой ток"));
  assert(answer.includes("формы выходного сигнала"));
});
