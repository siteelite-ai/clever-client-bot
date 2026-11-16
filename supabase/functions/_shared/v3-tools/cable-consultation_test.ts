import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  cableConsultation,
  isCableConsultationReply,
} from "./cable-consultation.ts";

Deno.test("cable consultation keeps exact facts from a reply with a different approximate parameter", () => {
  const profile = "pump_cable";
  const result = cableConsultation({
    profile,
    message: "Марку не знаю, кабель будет в воде, длина примерно 30 м",
    continuation: true,
  });
  assertEquals(result?.stage, "length");
  assertEquals(result?.state, { route: "water" });
  const corrected = cableConsultation({
    profile,
    message: "Длина примерно 50 м, ток по шильдику 8 А",
    prior: { route: "water", lengthM: 38 },
    continuation: true,
  });
  assertEquals(corrected?.stage, "length");
  assertEquals(corrected?.state, { route: "water", loadA: 8 });
});

Deno.test("route alternatives and hypotheticals do not become grounds to continue selection", () => {
  const profile = "underground_cable";
  for (
    const message of [
      "В трубе, или прямо в грунт; длина 25 м",
      "Не уверен: в трубе или прямо в грунт, длина 25 м",
      "Если в трубе, ток по проекту 20 А; длина 25 м",
    ]
  ) {
    assert(isCableConsultationReply(profile, message));
    const result = cableConsultation({
      profile,
      message,
      prior: { route: "duct" },
      continuation: true,
    });
    assertEquals(result?.stage, "route", message);
    assertEquals(result?.state, { lengthM: 25 }, message);
  }
});

Deno.test("independent measurements still preserve decimals and separate load ownership", () => {
  const result = cableConsultation({
    profile: "underground_cable",
    message:
      "В трубе ПНД, длина 25,5 м; глубина 0,8 м; расчётный ток 12,5 А и автомат 16 А",
    continuation: true,
  });
  assertEquals(result?.stage, "handoff");
  assertEquals(result?.state, { route: "duct", lengthM: 25.5, loadA: 12.5 });
});

Deno.test("a question about a different route does not withdraw the previously stated route", () => {
  const result = cableConsultation({
    profile: "underground_cable",
    message: "Длина 25 м; а если в трубе?",
    prior: { route: "direct" },
    continuation: true,
  });
  assertEquals(result?.stage, "load");
  assertEquals(result?.state, { route: "direct", lengthM: 25 });
});
