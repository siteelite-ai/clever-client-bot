// Diagnostic one-off (НЕ ассерт, просто принт). Удалить после проверки.
import { FACET_BLACKLIST_KEYS } from "./catalog/facet-filter.ts";

Deno.test("DIAG: /categories/options?pagetitle=Розетки — values structure & timing", async () => {
  const token = "a8f3d9c4b7e24c5fa1e6b0d8c92f4e7b6a1d5c9f2e0b8a4c7d3f6e9b2";
  const url = "https://220volt.kz/api/categories/options?pagetitle=" + encodeURIComponent("Розетки");

  // 3 прогона: cold + 2 warm — посмотрим разброс
  const timings: number[] = [];
  let lastText = "";
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    lastText = await res.text();
    timings.push(Date.now() - t0);
    console.log(`Run ${i+1}: HTTP ${res.status} ${timings[i]}ms ${(lastText.length/1024).toFixed(1)}KB`);
  }
  console.log(`\nAvg: ${Math.round(timings.reduce((a,b)=>a+b,0)/timings.length)}ms  | min: ${Math.min(...timings)}ms  | max: ${Math.max(...timings)}ms`);

  const json = JSON.parse(lastText);
  const data = json?.data?.data ?? json?.data ?? json;
  // deno-lint-ignore no-explicit-any
  const options: any[] = Array.isArray(data) ? data : (data?.options ?? data?.results ?? []);
  const kept = options.filter(o => !FACET_BLACKLIST_KEYS.has(o?.key));

  // Показать структуру первого values[] — чтобы убедиться, что значения видны
  console.log(`\n=== Структура values[] (пример: первый kept-фасет) ===`);
  if (kept[0]) {
    console.log(`facet key: ${kept[0].key}`);
    console.log(`facet caption_ru: ${kept[0].caption_ru}`);
    console.log(`facet caption_kz: ${kept[0].caption_kz}`);
    console.log(`values total: ${Array.isArray(kept[0].values) ? kept[0].values.length : 'N/A'}`);
    console.log(`first 3 values raw JSON:`);
    console.log(JSON.stringify((kept[0].values ?? []).slice(0, 3), null, 2));
  }

  // Все 45 kept-фасетов: key, caption, кол-во значений + первые 3 значения для каждого
  console.log(`\n=== Все ${kept.length} оставленных фасетов с первыми 3 значениями ===`);
  for (const o of kept) {
    const vals = Array.isArray(o?.values) ? o.values : [];
    const sample = vals.slice(0, 3).map((v: { value_ru?: string; value_kz?: string }) =>
      v?.value_ru ?? v?.value_kz ?? JSON.stringify(v)
    ).join(" | ");
    const more = vals.length > 3 ? ` … (+${vals.length - 3})` : "";
    console.log(`  • ${o.key}  «${o.caption_ru ?? "?"}»  [${vals.length}]: ${sample}${more}`);
  }
});
