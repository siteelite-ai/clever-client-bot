import {
  guardSearchFilters,
  projectExplicitCompactFacetValues,
  projectExplicitReasoningFacetValues,
} from "../../supabase/functions/_shared/v3-tools/search-filter-guard.ts";
import { buildVisibleRequestContract } from "../../supabase/functions/_shared/v3-tools/visible-request-contract.ts";

const snapshot = JSON.parse(
  await Deno.readTextFile(
    new URL(
      "../../docs/external/220volt-facets-snapshot.json",
      import.meta.url,
    ),
  ),
);
const query = "Есть ли светодиодные лампы с теплым светом 3000К? на цоколь Е27";
const reasoning =
  "Ищу товары в разделе «Лампы». По обязательным условиям проверяю «Цветовая температура, К: 3000»; «Цвет свечения: теплый»; «Тип цоколя: E27»; «Вид лампы (принцип работы): светодиодная».";
const req = buildVisibleRequestContract(query);
const facets = snapshot.categories["Лампы"].options.map((
  f: {
    key: string;
    caption_ru: string;
    unit: string | null;
    values: { value_ru: string }[];
  },
) => ({
  key: f.key,
  caption: f.caption_ru,
  unit: f.unit,
  values: (f.values ?? []).map((v) => ({
    value: String(v.value_ru ?? "").trim(),
  })).filter((v) => v.value),
}));
console.log(
  "snapshot",
  facets.length,
  facets.reduce(
    (n: number, f: { values: unknown[] }) => n + f.values.length,
    0,
  ),
);
if (Deno.args[0]) {
  const baseline = await import(Deno.args[0]) as {
    guardSearchFilters: typeof guardSearchFilters;
  };
  for (
    const [stage, prose, inference] of [
      ["after_discovery", query, ""],
      ["after_reasoning", reasoning, reasoning],
    ]
  ) {
    const apply = (fn: typeof guardSearchFilters) =>
      fn({ mode: "by_filter" }, facets, prose, query, inference, req);
    const oldResult = JSON.stringify(apply(baseline.guardSearchFilters));
    const newResult = JSON.stringify(apply(guardSearchFilters));
    if (oldResult !== newResult) throw Error(`Different result in ${stage}`);
    const sample = (fn: typeof guardSearchFilters) => {
      const start = performance.now();
      for (let i = 0; i < 8; i++) apply(fn);
      return (performance.now() - start) / 8;
    };
    const before = [], after = [];
    for (let i = 0; i < 20; i++) {
      if (i % 2) {
        before.push(sample(baseline.guardSearchFilters));
        after.push(sample(guardSearchFilters));
      } else {
        after.push(sample(guardSearchFilters));
        before.push(sample(baseline.guardSearchFilters));
      }
    }
    const median = (xs: number[]) => {
      xs.sort((a, b) => a - b);
      return (xs[9] + xs[10]) / 2;
    };
    console.log(JSON.stringify({
      stage,
      beforeMedianMs: median(before),
      afterMedianMs: median(after),
    }));
  }
  Deno.exit(0);
}
for (
  const [phase, work] of Object.entries({
    guardAfterDiscovery: () =>
      guardSearchFilters({ mode: "by_filter" }, facets, query, query, "", req),
    explicitReasoning: () =>
      projectExplicitReasoningFacetValues(facets, reasoning, query),
    compactCodes: () => projectExplicitCompactFacetValues(facets, query),
    guardAfterReasoning: () =>
      guardSearchFilters(
        { mode: "by_filter" },
        facets,
        reasoning,
        query,
        reasoning,
        req,
      ),
  })
) {
  const times = [];
  let result: unknown;
  for (let i = 0; i < 7; i++) {
    const start = performance.now();
    result = work();
    times.push(Math.round((performance.now() - start) * 10) / 10);
  }
  console.log(JSON.stringify({ phase, times, result }));
}
