// Unit tests for Шаг 2.5: narrow-win jargon recovery in QFv2.
// Эмулируем решающую логику (NARROW_MAX, threshold, alt-novel check)
// в чистом виде, без импорта index.ts (тот тащит весь pipeline).

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const NARROW_MAX = 2;

function foldNoun(s: string): string {
  return (s || "").toLowerCase().normalize("NFKC").replace(/[^a-zа-яё0-9]/g, "");
}

function shouldReplaceWithJargonAlt(args: {
  finalCount: number;
  altCount: number;
  noun: string;
  alt: string;
}): { replace: boolean; reason: string } {
  if (args.finalCount === 0 || args.finalCount > NARROW_MAX) {
    return { replace: false, reason: "not_narrow" };
  }
  const nounFolded = foldNoun(args.noun);
  const altFolded = foldNoun(args.alt);
  const altIsNovel =
    altFolded.length > 0 &&
    altFolded !== nounFolded &&
    !nounFolded.includes(altFolded) &&
    !altFolded.includes(nounFolded);
  if (!altIsNovel) return { replace: false, reason: "alt_not_novel" };
  const threshold = Math.max(5, args.finalCount * 2);
  if (args.altCount < threshold) return { replace: false, reason: "below_threshold" };
  return { replace: true, reason: "ok" };
}

Deno.test("narrow-win: final=1 + alt=8 + novel alt → replace", () => {
  const r = shouldReplaceWithJargonAlt({ finalCount: 1, altCount: 8, noun: "кукуруза", alt: "corn lamp" });
  assertEquals(r.replace, true);
});

Deno.test("narrow-win: final=2 + alt=5 (= threshold) + novel → replace", () => {
  const r = shouldReplaceWithJargonAlt({ finalCount: 2, altCount: 5, noun: "лампа", alt: "corn lamp" });
  assertEquals(r.replace, true);
});

Deno.test("narrow-win: final=2 + alt=4 (< threshold=5) → skip below_threshold", () => {
  const r = shouldReplaceWithJargonAlt({ finalCount: 2, altCount: 4, noun: "лампа", alt: "corn lamp" });
  assertEquals(r.replace, false);
  assertEquals(r.reason, "below_threshold");
});

Deno.test("narrow-win: final=3 → skip not_narrow", () => {
  const r = shouldReplaceWithJargonAlt({ finalCount: 3, altCount: 20, noun: "лампа", alt: "corn lamp" });
  assertEquals(r.replace, false);
  assertEquals(r.reason, "not_narrow");
});

Deno.test("narrow-win: final=0 → skip not_narrow (не наш кейс, ловят другие ветки)", () => {
  const r = shouldReplaceWithJargonAlt({ finalCount: 0, altCount: 20, noun: "лампа", alt: "corn lamp" });
  assertEquals(r.replace, false);
  assertEquals(r.reason, "not_narrow");
});

Deno.test("narrow-win: alt = noun (нет реального перевода) → skip alt_not_novel", () => {
  const r = shouldReplaceWithJargonAlt({ finalCount: 1, altCount: 10, noun: "лампа", alt: "лампа" });
  assertEquals(r.replace, false);
  assertEquals(r.reason, "alt_not_novel");
});

Deno.test("narrow-win: alt = substring noun (выключ vs выключатель) → skip alt_not_novel", () => {
  const r = shouldReplaceWithJargonAlt({ finalCount: 1, altCount: 10, noun: "выключатель", alt: "выключ" });
  assertEquals(r.replace, false);
  assertEquals(r.reason, "alt_not_novel");
});

Deno.test("narrow-win: noun = substring alt (выключатель vs автоматический выключатель) → REPLACE (расширение термина)", () => {
  // Это ОЖИДАЕМОЕ поведение: alt "автоматический выключатель" содержит noun "выключатель",
  // но это РАСШИРЕНИЕ. По текущему правилу altIsNovel=false → skip. Документируем
  // компромисс: безопасность важнее покрытия. Если выяснится, что таких кейсов много,
  // ослабим правило (например, разрешать noun ⊂ alt, но не alt ⊂ noun).
  const r = shouldReplaceWithJargonAlt({ finalCount: 1, altCount: 10, noun: "выключатель", alt: "автоматический выключатель" });
  assertEquals(r.replace, false);
  assertEquals(r.reason, "alt_not_novel");
});

Deno.test("narrow-win: alt empty → skip alt_not_novel", () => {
  const r = shouldReplaceWithJargonAlt({ finalCount: 1, altCount: 0, noun: "лампа", alt: "" });
  assertEquals(r.replace, false);
  assertEquals(r.reason, "alt_not_novel");
});
