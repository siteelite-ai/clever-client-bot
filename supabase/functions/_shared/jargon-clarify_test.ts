import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildJargonClarifyContent, tryResolveJargonChoice } from "./jargon-clarify.ts";

Deno.test("buildJargonClarifyContent: corn + лампа", () => {
  const { content, slot } = buildJargonClarifyContent({
    matchedAlternative: "corn",
    noun: "лампа",
    originalQuery: "лампа кукуруза E27",
    jargonCount: 10,
  });
  assertEquals(slot.matchedAlternative, "corn");
  assertEquals(slot.noun, "лампа");
  assertEquals(slot.jargonCount, 10);
  if (!content.includes("corn") || !content.includes("любые лампа") || !content.includes("10 вариантов")) {
    throw new Error("Unexpected content: " + content);
  }
});

Deno.test("buildJargonClarifyContent: plural 1 → вариант", () => {
  const { content } = buildJargonClarifyContent({
    matchedAlternative: "corn",
    noun: "лампа",
    originalQuery: "x",
    jargonCount: 1,
  });
  if (!content.includes("1 вариант)")) throw new Error("expected '1 вариант)' got: " + content);
});

Deno.test("buildJargonClarifyContent: plural 3 → варианта", () => {
  const { content } = buildJargonClarifyContent({
    matchedAlternative: "corn",
    noun: "лампа",
    originalQuery: "x",
    jargonCount: 3,
  });
  if (!content.includes("3 варианта)")) throw new Error("expected '3 варианта)' got: " + content);
});

const slot = {
  matchedAlternative: "corn",
  noun: "лампа",
  originalQuery: "лампа кукуруза E27",
  jargonCount: 10,
  ts: Date.now(),
};

Deno.test("resolve: user picks jargon — direct word", () => {
  assertEquals(tryResolveJargonChoice("corn", slot), "jargon");
  assertEquals(tryResolveJargonChoice("давай corn", slot), "jargon");
  assertEquals(tryResolveJargonChoice("Нужен CORN формат", slot), "jargon");
});

Deno.test("resolve: user picks noun — direct word", () => {
  assertEquals(tryResolveJargonChoice("лампа", slot), "noun");
  assertEquals(tryResolveJargonChoice("давай лампы", slot), "noun");
});

Deno.test("resolve: user picks noun — generic marker", () => {
  assertEquals(tryResolveJargonChoice("любые подойдут", slot), "noun");
  assertEquals(tryResolveJargonChoice("обычные", slot), "noun");
  assertEquals(tryResolveJargonChoice("без специального формата", slot), "noun");
});

Deno.test("resolve: ambiguous → null", () => {
  assertEquals(tryResolveJargonChoice("да", slot), null);
  assertEquals(tryResolveJargonChoice("хочу", slot), null);
  assertEquals(tryResolveJargonChoice("спасибо", slot), null);
  assertEquals(tryResolveJargonChoice("", slot), null);
});

Deno.test("resolve: topic change → null", () => {
  assertEquals(tryResolveJargonChoice("кабель 3х2.5", slot), null);
});
