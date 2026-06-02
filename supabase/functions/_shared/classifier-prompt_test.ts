import { assert, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { DEFAULT_CLASSIFIER_PROMPT } from "./classifier-prompt.ts";

Deno.test("classifier prompt: sub_intent enum includes 'facets' and 'accessory_for'", () => {
  // JSON schema line at the bottom must list all valid sub_intent values
  assertStringIncludes(
    DEFAULT_CLASSIFIER_PROMPT,
    `"sub_intent":"availability"|"price"|"location"|"spec"|"facets"|"compare"|"accessory_for"|null`,
  );
});

Deno.test("classifier prompt: 'facets' sub_intent has narrative description", () => {
  assertStringIncludes(DEFAULT_CLASSIFIER_PROMPT, `"facets"`);
  assertStringIncludes(DEFAULT_CLASSIFIER_PROMPT, "характеристики/опции РАЗДЕЛА");
  assertStringIncludes(DEFAULT_CLASSIFIER_PROMPT, "has_product_name=FALSE");
});

Deno.test("classifier prompt: price_max / price_min in output schema", () => {
  assertStringIncludes(DEFAULT_CLASSIFIER_PROMPT, `"price_max":number|null`);
  assertStringIncludes(DEFAULT_CLASSIFIER_PROMPT, `"price_min":number|null`);
});

Deno.test("classifier prompt: price_max must be filled at is_replacement=TRUE", () => {
  // Critical: replacement queries like «не дороже 1000 тг» must produce price_max.
  assertStringIncludes(
    DEFAULT_CLASSIFIER_PROMPT,
    "при is_replacement=TRUE и фразе «не дороже 1000 тг»",
  );
});

Deno.test("classifier prompt: price_max distinct from price_intent extremum", () => {
  assertStringIncludes(DEFAULT_CLASSIFIER_PROMPT, "НЕ путать с price_intent");
});

Deno.test("classifier prompt: token-preservation self-check unchanged", () => {
  // Regression guard — mechanical search_modifiers contract from Core memory must stay intact.
  assertStringIncludes(
    DEFAULT_CLASSIFIER_PROMPT,
    "len(search_modifiers) == N_input − N_cat − N_wrap",
  );
});

Deno.test("classifier prompt: no real product/category examples (data-agnostic)", () => {
  // Spec §0: zero real 220volt categories/products/brands in the prompt body.
  const banned = ["IEK", "ИЭК", "220volt", "ДКУ-LED", "светильник ДКУ", "ВА47-29 IEK"];
  for (const term of banned) {
    assert(
      !DEFAULT_CLASSIFIER_PROMPT.includes(term),
      `Prompt must not contain real catalog term "${term}" (data-agnostic rule)`,
    );
  }
});

Deno.test("classifier prompt: 'цена за единицу' disambiguated as spec, not price", () => {
  // Disambiguation rule: "цена ЗА штуку/упаковку/метр/комплект" = spec (unit/packaging), not price.
  assertStringIncludes(DEFAULT_CLASSIFIER_PROMPT, "цена ЗА");
  assertStringIncludes(DEFAULT_CLASSIFIER_PROMPT, "за штуку");
  assertStringIncludes(DEFAULT_CLASSIFIER_PROMPT, "за упаковку");
  assertStringIncludes(DEFAULT_CLASSIFIER_PROMPT, "единица измерения");
});

Deno.test("classifier prompt: spec includes packaging/unit attributes", () => {
  assertStringIncludes(DEFAULT_CLASSIFIER_PROMPT, "количество в упаковке");
  assertStringIncludes(DEFAULT_CLASSIFIER_PROMPT, "комплектация");
});

// ─────────────────────────────────────────────────────────────────────────────
// accessory_for pattern (2026-06-02)
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("classifier prompt: accessory_for sub_intent has narrative description", () => {
  assertStringIncludes(DEFAULT_CLASSIFIER_PROMPT, `"accessory_for"`);
  assertStringIncludes(DEFAULT_CLASSIFIER_PROMPT, "СОВМЕСТИМЫЕ с конкретным товаром-якорем");
});

Deno.test("classifier prompt: accessory_for compatibility markers listed", () => {
  // Core linguistic markers — без них классификатор не сможет различить accessory_for от обычного catalog.
  const markers = ["подходит к", "совместим с", "в комплект к", "под", "для"];
  for (const m of markers) {
    assertStringIncludes(DEFAULT_CLASSIFIER_PROMPT, m);
  }
});

Deno.test("classifier prompt: accessory_for requires anchor concreteness", () => {
  // Защита от ложного срабатывания на «диск для болгарки» без якоря.
  assertStringIncludes(DEFAULT_CLASSIFIER_PROMPT, "ОБЯЗАТЕЛЬНОЕ условие конкретики якоря");
  assertStringIncludes(DEFAULT_CLASSIFIER_PROMPT, "бренд, маркировку, артикул");
});

Deno.test("classifier prompt: accessory_for sets has_product_name=FALSE and product_category=target", () => {
  assertStringIncludes(DEFAULT_CLASSIFIER_PROMPT, "has_product_name = FALSE (цель запроса — категория Y");
  assertStringIncludes(DEFAULT_CLASSIFIER_PROMPT, "product_category = target_noun");
});

Deno.test("classifier prompt: accessory_for vs replacement disambiguation", () => {
  // is_replacement имеет приоритет — иначе «подбери аналог к ХХХ» уйдёт не в ту ветку.
  assertStringIncludes(DEFAULT_CLASSIFIER_PROMPT, "is_replacement=TRUE имеет приоритет");
});

Deno.test("classifier prompt: anchor_product field documented", () => {
  assertStringIncludes(DEFAULT_CLASSIFIER_PROMPT, "ЯКОРЬ-ТОВАР (anchor_product)");
  assertStringIncludes(DEFAULT_CLASSIFIER_PROMPT, "anchor_product = null");
});

Deno.test("classifier prompt: anchor_product field present in JSON output schema", () => {
  assertStringIncludes(DEFAULT_CLASSIFIER_PROMPT, `"anchor_product":string|null`);
});

Deno.test("classifier prompt: search_modifiers for accessory_for from target fragment only", () => {
  // Защита от утечки токенов якоря в search_modifiers целевой категории.
  assertStringIncludes(DEFAULT_CLASSIFIER_PROMPT, "ТОЛЬКО target-фрагмента запроса");
  assertStringIncludes(DEFAULT_CLASSIFIER_PROMPT, "без anchor_phrase");
});
