// V3 tool: expand_search_to_pool
//
// Minimal wrapper used когда `search_catalog` дал 0 или эксперт хочет «широкий»
// промпт-зависимый поиск. По спеке §3.2 — это должно делегировать в QFv2
// (noun→pool→Self-Bootstrap→options→final).
//
// Текущая реализация (Commit #3): pragmatic — собираем `query = noun + modifiers`
// и идём через executeSearchCatalog. Сохраняем тот же кэш товаров для render.
// Полное портирование QFv2 — отдельный коммит (TODO §11 spec).

import type {
  CatalogClientDeps,
} from "./search-catalog.ts";
import { executeSearchCatalog } from "./search-catalog.ts";
import type {
  ExpandPoolOk,
  ProductCache,
  ToolError,
} from "./types.ts";

export interface ExpandPoolInput {
  noun: string;
  modifiers?: string[];
  price_intent?: "cheapest" | "most_expensive" | null;
  min_price?: number;
  max_price?: number;
  brand?: string;
}

export async function executeExpandSearchToPool(
  input: ExpandPoolInput,
  deps: CatalogClientDeps,
  cache: ProductCache,
): Promise<(ExpandPoolOk & { tool: "expand_search_to_pool" }) | (ToolError & { tool: "expand_search_to_pool" })> {
  const noun = (input.noun ?? "").trim();
  if (!noun) {
    return {
      tool: "expand_search_to_pool",
      ok: false,
      error_code: "bad_input",
      message: "noun required",
    };
  }

  const modifiers = (input.modifiers ?? []).filter((m) => m && m.trim()).map((m) => m.trim());
  const queryParts = [noun, ...modifiers, input.brand ?? ""].filter(Boolean);
  const query = queryParts.join(" ");

  const sortCheapest = input.price_intent === "cheapest";
  // TODO Commit #4: подключить настоящий QFv2 (Pool Rescue, Self-Bootstrap,
  // Jargon Recovery, Honest-Empty с alternative_values).
  const r = await executeSearchCatalog(
    {
      mode: "by_query",
      query,
      min_price: input.min_price,
      max_price: input.max_price,
      per_page: 20,
      sort_cheapest: sortCheapest,
    },
    deps,
    cache,
  );

  if (!r.ok) {
    return { ...r, tool: "expand_search_to_pool" };
  }

  const branch_tag: ExpandPoolOk["branch_tag"] = r.total === 0
    ? "qfv2_honest_empty"
    : r.total <= 7
      ? "qfv2_pool_rescue"
      : "qfv2_final";

  return {
    tool: "expand_search_to_pool",
    ok: true,
    total: r.total,
    results: r.results,
    branch_tag,
  };
}
