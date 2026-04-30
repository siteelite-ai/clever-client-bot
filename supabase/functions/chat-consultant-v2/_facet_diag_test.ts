// Diagnostic one-off (НЕ ассерт, просто принт). Удалить после проверки.
import { FACET_BLACKLIST_KEYS } from "./catalog/facet-filter.ts";

Deno.test("DIAG: /categories/options?pagetitle=Розетки — before/after blacklist", async () => {
  const token = "a8f3d9c4b7e24c5fa1e6b0d8c92f4e7b6a1d5c9f2e0b8a4c7d3f6e9b2";
  const url = "https://220volt.kz/api/categories/options?pagetitle=" + encodeURIComponent("Розетки");
  const t0 = Date.now();
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  const text = await res.text();
  const ms = Date.now() - t0;
  console.log(`HTTP ${res.status} ${ms}ms ${(text.length/1024).toFixed(1)}KB`);
  if (!res.ok) { console.log("BODY:", text.slice(0,500)); return; }

  const json = JSON.parse(text);
  const data = json?.data?.data ?? json?.data ?? json;
  // deno-lint-ignore no-explicit-any
  const options: any[] = Array.isArray(data) ? data : (data?.options ?? data?.results ?? []);

  const removed = options.filter(o => FACET_BLACKLIST_KEYS.has(o?.key));
  const kept = options.filter(o => !FACET_BLACKLIST_KEYS.has(o?.key));

  const sizeBefore = JSON.stringify(options).length;
  const sizeAfter = JSON.stringify(kept).length;

  console.log(`\nFacets total: ${options.length}`);
  console.log(`Removed     : ${removed.length}`);
  console.log(`Kept        : ${kept.length}`);
  console.log(`Payload before: ${(sizeBefore/1024).toFixed(1)} KB`);
  console.log(`Payload after : ${(sizeAfter/1024).toFixed(1)} KB`);
  console.log(`Reduction     : ${(100 - sizeAfter/sizeBefore*100).toFixed(1)} %`);

  console.log("\n--- REMOVED ---");
  for (const o of removed) {
    const vals = Array.isArray(o?.values) ? o.values.length : 0;
    const sz = (JSON.stringify(o).length/1024).toFixed(1);
    console.log(`  - ${o.key}  «${o.caption_ru ?? o.caption ?? "?"}»  values=${vals}  size=${sz}KB`);
  }
  console.log("\n--- KEPT (top 20 by payload size) ---");
  const keptSized = kept.map(o => ({
    k: o.key, c: o.caption_ru ?? o.caption, n: Array.isArray(o.values)?o.values.length:0,
    sz: JSON.stringify(o).length,
  })).sort((a,b)=>b.sz-a.sz).slice(0,20);
  for (const o of keptSized) console.log(`  + ${o.k}  «${o.c}»  values=${o.n}  size=${(o.sz/1024).toFixed(1)}KB`);
});
