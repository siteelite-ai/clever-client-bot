import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { productManagerPhoneFromRecords } from "./lookup-contacts.ts";
Deno.test("manager phone uses labelled product contact ahead of retail and corporate", () => {
  assertEquals(
    productManagerPhoneFromRecords([{
      title: "Контакты",
      content:
        "Корпоративный отдел: +7 (721) 230-35-51\nРозничный отдел: +7 (701) 302-97-62\nТелефон для вопросов по товарам и офлайн-продажам: +7 (776) 220-62-20",
    }]),
    "+77762206220",
  );
});
Deno.test("a missing product contact may use labelled retail, never arbitrary branch/corporate text", () => {
  assertEquals(
    productManagerPhoneFromRecords([{
      title: "Контакты",
      content: "Розничный отдел: 8 (701) 302-97-62",
    }]),
    "+77013029762",
  );
  for (
    const content of [
      "Позвоните +7 (776) 220-62-20",
      "Корпоративный отдел: +7 (721) 230-35-51",
      "Телефон для вопросов по товарам: javascript:alert(1)",
      "Розничный отдел: +1 234 567 8900",
    ]
  ) {
    assertEquals(
      productManagerPhoneFromRecords([{ title: "Контакты", content }]),
      null,
    );
  }
});
