import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  deriveEnvironmentalProtectionRange,
} from "./environmental-protection-range.ts";

const protectionFacet = {
  key: "stepeny_zaschity__ip",
  caption: "Степень защиты",
  values: [
    { value: "IP20" },
    { value: "IP23" },
    { value: "IP44" },
    { value: "IP54" },
    { value: "IP65" },
    { value: "IPX4" },
    { value: "IP6X" },
    { value: "неизвестно" },
    { value: "IP44-IP20" },
  ],
};

Deno.test("weather exposure enumerates every eligible live IP value, not one model-picked value", () => {
  const result = deriveEnvironmentalProtectionRange(
    "Нужен прожектор для двора частного дома",
    [protectionFacet],
  );
  assertEquals(result, {
    status: "enumerated",
    reason: "live_exposure_floor",
    facetKey: protectionFacet.key,
    facetCaption: protectionFacet.caption,
    acceptedValues: ["IP44", "IP54", "IP65", "IPX4"],
  });
});

Deno.test("the same live range rule applies outside a particular product category", () => {
  const socket = deriveEnvironmentalProtectionRange(
    "Нужна розетка для улицы",
    [protectionFacet],
  );
  const camera = deriveEnvironmentalProtectionRange(
    "Подбери камеру для улицы",
    [protectionFacet],
  );
  assertEquals(socket, camera);
  assertEquals(socket.status, "enumerated");
});

Deno.test("numeric IP enums on an explicitly labelled live facet retain raw search values", () => {
  const facet = {
    key: "stepeny_zaschity__ip__Қorғanys_deңgeyі__ip",
    caption: "Степень защиты, IP",
    values: [
      { value: "20" },
      { value: "40" },
      { value: "44" },
      { value: "54" },
      { value: "65" },
      { value: "IPX4" },
      { value: "44-20" },
      { value: "IP44-IP20" },
      { value: "65 / 20" },
      { value: "7X" },
    ],
  };
  const result = deriveEnvironmentalProtectionRange(
    "Нужен прожектор для улицы",
    [facet],
  );
  assertEquals(result, {
    status: "enumerated",
    reason: "live_exposure_floor",
    facetKey: facet.key,
    facetCaption: facet.caption,
    acceptedValues: ["44", "54", "65", "IPX4"],
  });

  const dust = deriveEnvironmentalProtectionRange(
    "Нужен прибор для пыльного цеха",
    [facet],
  );
  assertEquals(dust.acceptedValues, ["54", "65"]);
});

Deno.test("bare protection numbers need an explicit IP token in facet caption or key", () => {
  const unlabeled = deriveEnvironmentalProtectionRange(
    "Нужен прибор для двора",
    [{
      key: "stepeny_zaschity",
      caption: "Степень защиты",
      values: [{ value: "44" }, { value: "IP54" }],
    }],
  );
  assertEquals(unlabeled.acceptedValues, ["IP54"]);

  const keyLabeled = deriveEnvironmentalProtectionRange(
    "Нужен прибор для двора",
    [{
      key: "ip_rating",
      caption: "Степень защиты",
      values: [{ value: "44" }, { value: "54-20" }],
    }],
  );
  assertEquals(keyLabeled.acceptedValues, ["44"]);

  const noEligible = deriveEnvironmentalProtectionRange(
    "Нужен прибор для двора",
    [{
      key: "stepeny_zaschity",
      caption: "Степень защиты",
      values: [{ value: "44" }],
    }],
  );
  assertEquals(noEligible.status, "unresolved");
  assertEquals(noEligible.reason, "no_eligible_values");
});

Deno.test("explicit dust and weather obligations check independent IP digits", () => {
  const dust = deriveEnvironmentalProtectionRange(
    "Нужен прибор для пыльного цеха",
    [protectionFacet],
  );
  assertEquals(dust.status, "enumerated");
  assertEquals(dust.acceptedValues, ["IP54", "IP65", "IP6X"]);

  const both = deriveEnvironmentalProtectionRange(
    "Нужен прибор для пыльной открытой площадки",
    [protectionFacet],
  );
  assertEquals(both.status, "enumerated");
  assertEquals(both.acceptedValues, ["IP54", "IP65"]);
});

Deno.test("duplicate, malformed and unknown live values cannot enter a projected range", () => {
  const result = deriveEnvironmentalProtectionRange("Для двора", [{
    key: "ip",
    caption: "Степень защиты IP",
    values: [
      { value: "IP44" },
      { value: " IP44 " },
      { value: "IP6X" },
      { value: "IP??" },
      { value: "IP44-IP20" },
      { value: "IP44; IP20" },
      { value: "IP44 лишний текст" },
      { value: "" },
      {},
    ],
  }]);
  assertEquals(result.acceptedValues, ["IP44"]);
});

Deno.test("no exposure needs no synthetic protection filter", () => {
  const result = deriveEnvironmentalProtectionRange(
    "Нужен светильник для гостиной",
    [protectionFacet],
  );
  assertEquals(result.status, "not_applicable");
  assertEquals(result.reason, "no_exposure");
  assertEquals(result.acceptedValues, []);
});

Deno.test("exposure without a unique named live IP facet remains unresolved", () => {
  const noFacet = deriveEnvironmentalProtectionRange(
    "Нужен прибор для двора",
    [{ key: "color", caption: "Цвет", values: [{ value: "черный" }] }],
  );
  assertEquals(noFacet.status, "unresolved");
  assertEquals(noFacet.reason, "no_live_facet");
  assertEquals(noFacet.acceptedValues, []);

  const ambiguous = deriveEnvironmentalProtectionRange(
    "Нужен прибор для двора",
    [
      protectionFacet,
      { key: "ingress protection", caption: "IP", values: [{ value: "IP65" }] },
    ],
  );
  assertEquals(ambiguous.status, "unresolved");
  assertEquals(ambiguous.reason, "ambiguous_live_facet");
  assertEquals(ambiguous.acceptedValues, []);
});

Deno.test("a matched facet needs its live machine key and at least one eligible code", () => {
  const missingKey = deriveEnvironmentalProtectionRange(
    "Нужен прибор для двора",
    [{ caption: "Степень защиты", values: [{ value: "IP65" }] }],
  );
  assertEquals(missingKey.status, "unresolved");
  assertEquals(missingKey.reason, "facet_missing_key");

  const noEligible = deriveEnvironmentalProtectionRange(
    "Нужен прибор для двора",
    [{
      key: "ip",
      caption: "IP",
      values: [{ value: "IP20" }, { value: "IP6X" }],
    }],
  );
  assertEquals(noEligible.status, "unresolved");
  assertEquals(noEligible.reason, "no_eligible_values");
});

Deno.test("more than the downstream 12-value OR capacity fails closed without truncation", () => {
  const values = Array.from({ length: 13 }, (_, index) => ({
    value: `IP${Math.floor(index / 6)}${4 + index % 6}`,
  }));
  const result = deriveEnvironmentalProtectionRange(
    "Нужен прибор для улицы",
    [{ key: "ip", caption: "IP", values }],
  );
  assertEquals(result.status, "unresolved");
  assertEquals(result.reason, "too_many_values");
  assertEquals(result.acceptedValues, values.map(({ value }) => value));
});

Deno.test("customer-mentioned exact or minimum IP is left to the explicit customer contract", () => {
  for (
    const request of [
      "Для улицы нужна степень защиты IP65",
      "Для двора нужен прибор не ниже IP54",
    ]
  ) {
    const result = deriveEnvironmentalProtectionRange(request, [
      protectionFacet,
    ]);
    assertEquals(result.status, "not_applicable");
    assertEquals(result.reason, "customer_ip_mentioned");
    assertEquals(result.acceptedValues, []);
  }
});
