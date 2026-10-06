import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  compareIpProtectionMinimum,
  extractIpProtectionBounds,
  isIpProtectionCode,
  isIpProtectionPropertyKey,
} from "./ip-protection-order.ts";

Deno.test("IP minimum is a partial order, never a two-digit number", () => {
  for (
    const actual of ["IP65", "IP66", "IP65/IP67", "IP66/68", "ip65 / ip69"]
  ) {
    assertEquals(compareIpProtectionMinimum(actual, "IP65"), "pass", actual);
  }
  for (const actual of ["IP54", "IP55", "IP56", "IP64"]) {
    assertEquals(compareIpProtectionMinimum(actual, "IP65"), "fail", actual);
  }
  for (
    const actual of [
      "IP67",
      "IP68",
      "IP69",
      "IP69K",
      "IPX5",
      "IP6X",
      "IP7A",
      "IP650",
      "IK65",
      "IP65/IP7A",
      "IP65, IP67",
      "защита IP65",
    ]
  ) {
    assertEquals(compareIpProtectionMinimum(actual, "IP65"), "unknown", actual);
  }
});

Deno.test("strict IP bound and independent axes retain their meanings", () => {
  assertEquals(compareIpProtectionMinimum("IP65", "IP65", true), "fail");
  assertEquals(compareIpProtectionMinimum("IP66", "IP65", true), "pass");
  assertEquals(compareIpProtectionMinimum("IP56", "IP65", true), "fail");
  assertEquals(compareIpProtectionMinimum("IP67", "IP65", true), "unknown");
  assertEquals(compareIpProtectionMinimum("IP65", "IP66"), "fail");
  assertEquals(compareIpProtectionMinimum("IP66", "IP67"), "unknown");
  assertEquals(compareIpProtectionMinimum("IP68", "IP67"), "unknown");
  assertEquals(compareIpProtectionMinimum("IP65", "IP7A"), "unknown");
});

Deno.test("IP declaration requires a whole code, protection key and adjacent direction", () => {
  assertEquals(isIpProtectionCode("IP65"), true);
  for (const value of ["IPX5", "IP69K", "IP650", "IP65/IP67", "65"]) {
    assertEquals(isIpProtectionCode(value), false);
  }
  assertEquals(isIpProtectionPropertyKey("Степень защиты"), true);
  assertEquals(isIpProtectionPropertyKey("IP-рейтинг"), true);
  assertEquals(isIpProtectionPropertyKey("Ingress protection"), true);
  assertEquals(isIpProtectionPropertyKey("Модель"), false);
  assertEquals(isIpProtectionPropertyKey("Класс электрической защиты"), false);
  assertEquals(
    extractIpProtectionBounds("Обязательна степень защиты не ниже IP65."),
    [
      { op: "min", value: "IP65", strict: false },
    ],
  );
  assertEquals(
    extractIpProtectionBounds("Обязательна степень защиты выше IP65."),
    [
      { op: "min", value: "IP65", strict: true },
    ],
  );
  assertEquals(
    extractIpProtectionBounds("Обязательна степень защиты не выше IP65."),
    [
      { op: "max", value: "IP65", strict: false },
    ],
  );
  assertEquals(
    extractIpProtectionBounds("Обязательна степень защиты IP65."),
    [],
  );
  assertEquals(extractIpProtectionBounds("Не нужен IP65A; не ниже IP650."), []);
});
