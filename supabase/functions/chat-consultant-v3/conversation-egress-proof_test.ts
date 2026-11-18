import {
  assert,
  assertEquals,
  assertNotEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { executeRenderProducts } from "../_shared/v3-tools/render.ts";
import type { ProductCache, ProductFull } from "../_shared/v3-tools/types.ts";
import {
  buildConversationEgressProof,
  type EgressProductsBlock,
  publicProductsBlockEvent,
} from "./conversation-egress-proof.ts";

const REQUEST =
  "Хочу поменять дома люстру в зале 30 квадратов. Что предложишь?";
const HASH = "selection-12345678";

function product(
  id: string,
  overrides: Partial<ProductFull> = {},
): ProductFull {
  return {
    id,
    pagetitle: `Люстра светодиодная ${id}`,
    url: `https://220volt.kz/catalog/svetotexnika/lyustryi/${id}/`,
    vendor: "MODE",
    price: 5000,
    stock: "in_stock",
    short_traits: [
      "Назначение: Гостиная",
      "Максимальная площадь освещения: 35 м²",
    ],
    leaf_category: "Люстры",
    ...overrides,
  };
}

function fixture(products: ProductFull[]): {
  cache: ProductCache;
  event: EgressProductsBlock;
} {
  const cache = new Map(products.map((item) => [item.id, item]));
  const rendered = executeRenderProducts(
    { product_ids: products.map((item) => item.id) },
    cache,
  );
  assert(rendered.ok);
  return {
    cache,
    event: {
      type: "products_block",
      markdown: rendered.markdown,
      count: rendered.rendered_count,
      selection_contract: {
        hash: HASH,
        mandatory_criteria: [],
      },
    },
  };
}

Deno.test("certificate binds only exact displayed cards in visible order", () => {
  const homeA = product("home-a");
  const homeB = product("home-b");
  const hidden = product("hidden");
  const { cache, event } = fixture([homeB, homeA]);
  cache.set(hidden.id, hidden);
  const result = buildConversationEgressProof({
    event,
    cache,
    baseRequest: REQUEST,
    selectionHash: HASH,
  });
  assert(result);
  assertEquals(result.displayedProducts.map((item) => item.id), [
    "home-b",
    "home-a",
  ]);
  assertEquals(
    result.internalEvent.server_destination_fit_proof?.rendered_cards,
    [
      { id: "home-b", url: homeB.url },
      { id: "home-a", url: homeA.url },
    ],
  );
  assertEquals(
    buildConversationEgressProof({
      event,
      cache,
      baseRequest: REQUEST,
      selectionHash: HASH,
      requestedIds: [homeB.id, hidden.id, homeA.id],
    }),
    null,
    "an extra requested ID cannot be hidden by a renderer skip",
  );
});

Deno.test("zero-price or missing requested ID cannot be silently skipped", () => {
  const home = product("home");
  const { cache, event } = fixture([home]);
  cache.set("zero", product("zero", { price: 0 }));
  for (const requestedIds of [["home", "zero"], ["home", "missing"]]) {
    assertEquals(
      buildConversationEgressProof({
        event,
        cache,
        baseRequest: REQUEST,
        selectionHash: HASH,
        requestedIds,
      }),
      null,
    );
  }
  assert(
    buildConversationEgressProof({
      event,
      cache,
      baseRequest: REQUEST,
      selectionHash: HASH,
      requestedIds: ["home"],
    }),
  );
});

Deno.test("count, order, price and title must match deterministic render", () => {
  const a = product("a");
  const b = product("b");
  const { cache, event } = fixture([a, b]);
  const input = { cache, baseRequest: REQUEST, selectionHash: HASH };
  assertEquals(
    buildConversationEgressProof({
      ...input,
      event: { ...event, count: 1 },
    }),
    null,
  );
  assertEquals(
    buildConversationEgressProof({
      ...input,
      event: {
        ...event,
        markdown: fixture([b, a]).event.markdown,
      },
      requestedIds: [a.id, b.id],
    }),
    null,
    "requested renderer order cannot disagree with final visible order",
  );
  assertEquals(
    buildConversationEgressProof({
      ...input,
      event: { ...event, markdown: event.markdown.replace("5 000", "4 000") },
    }),
    null,
  );
  assertEquals(
    buildConversationEgressProof({
      ...input,
      event: {
        ...event,
        markdown: event.markdown.replace("Люстра светодиодная a", "Люстра b"),
      },
    }),
    null,
  );
});

Deno.test("wrong, duplicate and missing displayed URLs fail closed", () => {
  const a = product("a");
  const b = product("b");
  const { cache, event } = fixture([a, b]);
  const input = { cache, baseRequest: REQUEST, selectionHash: HASH };
  assertEquals(
    buildConversationEgressProof({
      ...input,
      event: { ...event, markdown: event.markdown.replace(b.url, a.url) },
    }),
    null,
  );
  assertEquals(
    buildConversationEgressProof({
      ...input,
      event: {
        ...event,
        markdown: event.markdown.replace(
          b.url,
          "https://220volt.kz/catalog/missing/",
        ),
      },
    }),
    null,
  );
  assertEquals(
    buildConversationEgressProof({
      ...input,
      event: {
        ...event,
        markdown: event.markdown.replace(
          b.url,
          "https://evil.invalid/catalog/b/",
        ),
      },
    }),
    null,
  );
  cache.set("alias", product("alias", { url: a.url }));
  assertEquals(buildConversationEgressProof({ ...input, event }), null);
});

Deno.test("one unsuitable measured-replacement card invalidates whole block", () => {
  const home = product("home");
  const office = product("office", {
    short_traits: [
      "Назначение: Офис",
      "Максимальная площадь освещения: 40 м²",
    ],
  });
  const tooSmall = product("small", {
    short_traits: [
      "Назначение: Гостиная",
      "Максимальная площадь освещения: 18 м²",
    ],
  });
  for (const unsuitable of [office, tooSmall]) {
    const { cache, event } = fixture([home, unsuitable]);
    assertEquals(
      buildConversationEgressProof({
        event,
        cache,
        baseRequest: REQUEST,
        selectionHash: HASH,
      }),
      null,
    );
  }
});

Deno.test("public live/replay projection cannot serialize internal proof", () => {
  const { cache, event } = fixture([product("home")]);
  const result = buildConversationEgressProof({
    event,
    cache,
    baseRequest: REQUEST,
    selectionHash: HASH,
  });
  assert(result);
  assertNotEquals(result.publicEvent, result.internalEvent);
  assertEquals(
    Object.hasOwn(result.publicEvent, "server_destination_fit_proof"),
    false,
  );
  assert(
    Object.hasOwn(result.internalEvent, "server_destination_fit_proof"),
  );
  assertEquals(
    JSON.stringify({ v3_event: result.publicEvent }).includes(
      "server_destination_fit_proof",
    ),
    false,
  );
  assertEquals(
    JSON.stringify({ v3_event: publicProductsBlockEvent(result.internalEvent) })
      .includes("server_destination_fit_proof"),
    false,
    "replay must re-project the logged event before encoding",
  );
  assertEquals(
    Object.hasOwn(result.publicEvent, "price_winner_id"),
    false,
  );
  const contaminatedCriterion = {
    key: "Назначение",
    op: "eq",
    value: "Гостиная",
    server_destination_fit_proof: { private: true },
  };
  result.internalEvent.selection_contract!.mandatory_criteria.push(
    contaminatedCriterion,
  );
  assertEquals(
    JSON.stringify(publicProductsBlockEvent(result.internalEvent)).includes(
      "server_destination_fit_proof",
    ),
    false,
    "a nested unexpected field is excluded from the public contract",
  );
});

Deno.test("ordinary blocks retain public content and carry no proof", () => {
  const { cache, event } = fixture([product("ordinary")]);
  event.total_available = 12;
  const result = buildConversationEgressProof({
    event,
    cache,
    baseRequest: "Покажи люстры",
    selectionHash: HASH,
  });
  assert(result);
  assertEquals(result.publicEvent, result.internalEvent);
  assertEquals(result.publicEvent, event);
  assertEquals(
    Object.hasOwn(result.internalEvent, "server_destination_fit_proof"),
    false,
  );
});
