// Unit test for escalate short-circuit overlap-checker logic.
// Mirrors the inline helper in index.ts (lines ~8858-8877).
// Goal: data-agnostic — no dictionaries, substring match against bootstrap.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

type Bucket = { caption: string; values: Set<string> };

function hasAnyBootstrapOverlap(
  mods: string[],
  bootstrap: Map<string, Bucket>,
): boolean {
  if (mods.length === 0) return false;
  const lcMods = mods.map((m) => m.toLowerCase().trim()).filter((m) => m.length >= 2);
  if (lcMods.length === 0) return false;
  for (const [, bucket] of bootstrap.entries()) {
    const cap = (bucket.caption || "").toLowerCase();
    for (const m of lcMods) {
      if (cap.includes(m) || m.includes(cap)) return true;
    }
    for (const v of bucket.values) {
      const lv = String(v).toLowerCase();
      for (const m of lcMods) {
        if (lv.includes(m) || m.includes(lv)) return true;
      }
    }
  }
  return false;
}

function mkBootstrap(entries: Array<[string, string, string[]]>): Map<string, Bucket> {
  const m = new Map<string, Bucket>();
  for (const [k, cap, vals] of entries) {
    m.set(k, { caption: cap, values: new Set(vals) });
  }
  return m;
}

Deno.test("escalate-shortcircuit: full value match → overlap=true", () => {
  const bs = mkBootstrap([
    ["brend__brend", "Бренд", ["IEK", "Legrand", "Schneider Electric"]],
  ]);
  // modifier "legrand" matches value "Legrand" (case-insensitive substring)
  assertEquals(hasAnyBootstrapOverlap(["Legrand"], bs), true);
});

Deno.test("escalate-shortcircuit: caption substring → overlap=true", () => {
  const bs = mkBootstrap([
    ["kolichestvo_polyusov__polyuster_sany", "Количество полюсов", ["1", "2", "3", "4"]],
  ]);
  // modifier "полюсов" is substring of caption "Количество полюсов"
  assertEquals(hasAnyBootstrapOverlap(["полюсов"], bs), true);
});

Deno.test("escalate-shortcircuit: context word with zero overlap → false (THIS IS THE FIX)", () => {
  // Real case: "автомат 25А для квартиры" → resolved=ток=25, unresolved=[квартиры]
  // bootstrap has facets like Бренд, Полюсов, Характеристика, Напряжение — none contain "квартир".
  const bs = mkBootstrap([
    ["brend__brend", "Бренд", ["IEK", "Legrand"]],
    ["nominalynyy_tok", "Номинальный ток", ["25", "16", "63"]],
    ["kolichestvo_polyusov", "Количество полюсов", ["1", "2", "3"]],
    ["harakteristika_srabatyvaniya", "Характеристика срабатывания", ["B", "C", "D"]],
    ["nominalynoe_rabochee_napryaghenie", "Номинальное рабочее напряжение", ["230", "400"]],
  ]);
  assertEquals(hasAnyBootstrapOverlap(["квартиры"], bs), false);
  assertEquals(hasAnyBootstrapOverlap(["для", "квартиры"], bs), false);
  assertEquals(hasAnyBootstrapOverlap(["дома"], bs), false);
});

Deno.test("escalate-shortcircuit: empty mods → false", () => {
  const bs = mkBootstrap([["brend__brend", "Бренд", ["IEK"]]]);
  assertEquals(hasAnyBootstrapOverlap([], bs), false);
});

Deno.test("escalate-shortcircuit: short mod (<2 chars) → ignored", () => {
  const bs = mkBootstrap([["brend__brend", "Бренд", ["A"]]]);
  // single-char modifier "А" would otherwise match — but we filter <2 chars to avoid noise
  assertEquals(hasAnyBootstrapOverlap(["А"], bs), false);
});

Deno.test("escalate-shortcircuit: partial value substring → overlap=true", () => {
  const bs = mkBootstrap([
    ["strana_proishoghdeniya", "Страна происхождения", ["РОССИЯ", "КИТАЙ"]],
  ]);
  // modifier "росс" is substring of value "РОССИЯ" — escalate should still try
  assertEquals(hasAnyBootstrapOverlap(["росс"], bs), true);
});

Deno.test("escalate-shortcircuit: mixed unresolved — one matches → overlap=true (escalate runs)", () => {
  const bs = mkBootstrap([
    ["brend__brend", "Бренд", ["Legrand"]],
  ]);
  // "квартиры" no match, but "legrand" matches — keep escalate alive
  assertEquals(hasAnyBootstrapOverlap(["квартиры", "Legrand"], bs), true);
});
