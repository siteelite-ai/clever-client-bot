import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { replayableSseEvents } from "./sse-replay.ts";

Deno.test("exact price/unit evidence survives completed-request replay", () => {
  const evidence = {
    type: "price_unit_evidence",
    product_url: "https://220volt.kz/catalog/example/",
    price: 123,
    unit: "шт",
    basis: "piece",
  };
  const original = [
    evidence,
    { type: "delta", content: "Цена 123 ₸ за одну штуку." },
    { type: "products_block", content: "card" },
    { type: "diagnostic", log_id: "request-1" },
    { type: "done" },
  ];
  assertEquals(replayableSseEvents(original), original);
  assertEquals(
    replayableSseEvents([{ type: "unrecognized" }, ...original]),
    original,
  );
  assertEquals(replayableSseEvents(null), []);
});
