import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveVerifiedEngineeringInquiry } from "./verified-engineering-inquiry.ts";

Deno.test("verified cable comparison covers construction, apartment use and fire/UV conditions", () => {
  for (const message of [
    "Чем отличается кабель ВВГнг от NYM и какой лучше для проводки в квартире?",
    "Сравни ВВГнг и NYM: что лучше для квартирной проводки?",
  ]) {
    const result = resolveVerifiedEngineeringInquiry(message);
    assertEquals(result?.rule, "cable_vvgng_nym_comparison");
    assertStringIncludes(result?.answer ?? "", "ВВГнг");
    assertStringIncludes(result?.answer ?? "", "NYM");
    assert(/квартир|помещ/u.test(result?.answer ?? ""));
    assert(/УФ|пожар|оболоч/u.test(result?.answer ?? ""));
  }
});

Deno.test("verified floodlight estimate derives watts, lux and area from compact or spaced lumens", () => {
  for (const message of [
    "Какая мощность у светодиодного прожектора на 1000 люмен и какую площадь он освещает?",
    "Сколько ватт обычно у LED-прожектора на 1 000 лм и какую площадь он освещает?",
  ]) {
    const result = resolveVerifiedEngineeringInquiry(message);
    assertEquals(result?.rule, "floodlight_lumen_power_area_estimate");
    assert(/Вт/u.test(result?.answer ?? ""));
    assert(/лк/u.test(result?.answer ?? ""));
    assert(/м²/u.test(result?.answer ?? ""));
  }
});

Deno.test("verified stabilizer guidance preserves low input voltage and asks for load", () => {
  for (const message of [
    "Мне нужен стабилизатор напряжения для дома, если напряжение часто падает до 170 вольт. Что посоветуете?",
    "Посоветуйте стабилизатор для дома: входное напряжение проседает до 170 В",
  ]) {
    const result = resolveVerifiedEngineeringInquiry(message);
    assertEquals(result?.rule, "stabilizer_low_input_guidance");
    assertStringIncludes(result?.answer ?? "", "170 В");
    assert(/мощност|нагруз|кВт/u.test(result?.answer ?? ""));
    assert(/входн|диапазон/u.test(result?.answer ?? ""));
  }
});

Deno.test("verified motor answer is conditional on nameplate winding data and quantifies derating", () => {
  for (const message of [
    "Можно ли подключить трехфазный двигатель к однофазной сети 220 В?",
    "Как подключить трёхфазный двигатель к бытовой однофазной сети 220 В?",
  ]) {
    const result = resolveVerifiedEngineeringInquiry(message);
    assertEquals(result?.rule, "three_phase_motor_single_phase_supply");
    assert(/конденсатор/u.test(result?.answer ?? ""));
    assert(/треугольник|звезд/u.test(result?.answer ?? ""));
    assert(/30–50/u.test(result?.answer ?? ""));
    assert(/шильдик|220\/380|обмот/u.test(result?.answer ?? ""));
  }
});

Deno.test("verified layer stays narrow and does not intercept catalog selection", () => {
  assertEquals(resolveVerifiedEngineeringInquiry("Покажи прожектор на 1000 люмен"), null);
  assertEquals(resolveVerifiedEngineeringInquiry("Найди кабель NYM 3×1,5"), null);
  assertEquals(resolveVerifiedEngineeringInquiry("Нужен двигатель 3 кВт"), null);
  assertEquals(resolveVerifiedEngineeringInquiry("Покажи стабилизаторы дешевле 50000 тенге"), null);
});
