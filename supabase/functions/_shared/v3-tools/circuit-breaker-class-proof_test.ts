import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { circuitCardProvesFilters } from "./circuit-protection-dialogue.ts";
import { proveOrdinaryCircuitBreakerClass } from "./circuit-breaker-class-proof.ts";
import type { ProductFull } from "./types.ts";

const options = {
  current: ["32"],
  poles: ["2"],
  curve: ["C"],
  breaking: ["6"],
  voltage: ["230"],
};
function card(title = "Автоматический выключатель 2P C32"): ProductFull {
  return {
    id: "offline-candidate",
    article: "not-a-runtime-allowlist",
    pagetitle: title,
    url: "https://220volt.kz/catalog/electric/breakers/offline-candidate/",
    vendor: null,
    price: 1500,
    stock: "in_stock",
    warehouse_evidence: "positive",
    warehouses: [{ city: "Караганда", qty: 2 }],
    leaf_category: "Автоматические выключатели",
    short_traits: [],
    facet_values: Object.fromEntries(
      Object.entries(options).map(([key, values]) => [key, [...values]]),
    ),
    facet_captions: {
      current: "Номинальный ток",
      poles: "Количество полюсов",
      curve: "Характеристика срабатывания",
      breaking: "Номинальная откл способность",
      voltage: "Номинальное рабочее напряжение",
    },
  };
}

Deno.test("ordinary circuit breaker gate rejects the live AFDD subtype despite five matching numeric fields", () => {
  const afdd = card(
    "Устройство защиты от дугового пробоя NB4LE-AFD 2P C32 Тип А 30мА CHINT 335359",
  );
  assertEquals(circuitCardProvesFilters(afdd, options), false);
});

Deno.test("ordinary circuit breaker gate rejects other combined and different device classes without a SKU dictionary", () => {
  for (
    const title of [
      "Дифавтомат XZ-4 2P C32 30мА",
      "Автоматический дифференциальный выключатель 2P C32",
      "RCBO 2P C32 type A 30mA",
      "AFDD with circuit breaker 2P C32",
      "УЗО 2P 32А",
      "Автомат АВДТ-32 C32",
      "Автомат АВДТ32 C32",
      "Автомат с УЗДП-М 2P C32",
      "Диф. автомат 2P C32",
      "AFDD-32 автомат C32",
      "Контактор для автомата 2P C32",
      "Крышка для автоматического выключателя C32",
      "Модуль без указанного типа 2P C32",
    ]
  ) assertEquals(circuitCardProvesFilters(card(title), options), false, title);
});

Deno.test("ordinary class needs positive owned identity, not category, seller, article or compatible accessory text", () => {
  for (
    const title of [
      "Модуль XZ-4 2P C32",
      "Для автоматического выключателя C32",
      "Крышка MCB 2P",
    ]
  ) {
    const product = card(title);
    product.article = "MCB";
    product.vendor = "Автоматический выключатель";
    assertEquals(
      proveOrdinaryCircuitBreakerClass(product).verified,
      false,
      title,
    );
  }
  const typed = card("Модуль XZ-4 2P C32");
  typed.short_traits = ["Тип устройства: Автоматический выключатель"];
  assertEquals(proveOrdinaryCircuitBreakerClass(typed), {
    verified: true,
    source: "device_type",
  });
  typed.facet_values!.own_type = ["Контактор"];
  typed.facet_captions!.own_type = "Вид изделия";
  assertEquals(proveOrdinaryCircuitBreakerClass(typed), {
    verified: false,
    reason: "ambiguous_device_type",
  });
});

Deno.test("own integrated functions veto an ordinary title even when nominal, brand and spelling change", () => {
  for (
    const title of ["Автомат MCB 1P B16", "Miniature circuit breaker 3P D63"]
  ) {
    for (
      const [caption, value] of [["Встр. защита от замыканий на землю", "Да"], [
        "Тип устройства",
        "RCBO",
      ], ["Защита от дугового пробоя", "неизвестно"]]
    ) {
      const product = card(title);
      product.short_traits = [`${caption}: ${value}`];
      assertEquals(
        proveOrdinaryCircuitBreakerClass(product).verified,
        false,
        `${title}: ${caption}`,
      );
    }
    for (
      const description of [
        "Данный аппарат имеет защиту от токов утечки и перегрузки.",
        "Автоматический выключатель оснащён защитой от дугового пробоя.",
      ]
    ) {
      assertEquals(
        proveOrdinaryCircuitBreakerClass({
          ...card(title),
          description_excerpt: description,
        }).verified,
        false,
        description,
      );
    }
  }
});

Deno.test("absence of additional protection and external compatibility do not turn an ordinary MCB into a combined device", () => {
  for (
    const title of [
      "Автоматический выключатель C32 без УЗО",
      "Автоматический выключатель C32 совместим с УЗДП",
      "MCB C32 compatible with AFDD",
      "Автомат C32, защита от дугового пробоя: нет",
    ]
  ) {
    assertEquals(
      proveOrdinaryCircuitBreakerClass(card(title)).verified,
      true,
      title,
    );
  }
  const ordinary = card();
  ordinary.short_traits = ["Встроенная дифференциальная защита: Нет"];
  ordinary.description_excerpt = "Данный аппарат работает совместно с УЗО.";
  assertEquals(proveOrdinaryCircuitBreakerClass(ordinary).verified, true);
  assertEquals(
    proveOrdinaryCircuitBreakerClass(
      card("Автомат без УЗО, с защитой от дугового пробоя"),
    ).verified,
    false,
  );
});

Deno.test("ordinary circuit breaker identity cannot override contradictory own type or integrated protection fields", () => {
  for (
    const [caption, value] of [
      ["Тип устройства", "УЗДП"],
      ["Вид изделия", "Автоматический дифференциальный выключатель"],
      ["Встроенная дифференциальная защита", "Да"],
      ["Защита от дугового пробоя", "есть"],
    ]
  ) {
    const product = card();
    product.facet_values!.own_type = [value];
    product.facet_captions!.own_type = caption;
    assertEquals(circuitCardProvesFilters(product, options), false, caption);
  }
});

Deno.test("ordinary circuit breaker gate still accepts an ordinary MCB and preserves all five numeric and stock checks", () => {
  const ordinary = card();
  assert(circuitCardProvesFilters(ordinary, options));
  for (const key of Object.keys(options)) {
    assertEquals(
      circuitCardProvesFilters({
        ...ordinary,
        facet_values: { ...ordinary.facet_values, [key]: ["wrong"] },
      }, options),
      false,
      key,
    );
    const values = { ...ordinary.facet_values };
    delete values[key];
    assertEquals(
      circuitCardProvesFilters({ ...ordinary, facet_values: values }, options),
      false,
      key,
    );
  }
  assertEquals(
    circuitCardProvesFilters({
      ...ordinary,
      warehouse_evidence: "explicit_zero",
      warehouses: [],
    }, options),
    false,
  );
});
