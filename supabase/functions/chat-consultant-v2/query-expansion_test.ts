/**
 * Stage 6 — Step 6B tests for Query Expansion (§9.2b).
 * Запуск: supabase--test_edge_functions { functions: ["chat-consultant-v2"], pattern: "qe:" }
 *
 * Все тесты — data-agnostic: lexicon и translateToEnglish инжектируются
 * мок-функциями, никаких реальных терминов 220volt в коде.
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  applyLexicon,
  expandQuery,
  type ExpansionDeps,
} from "./query-expansion.ts";

// ─── helpers ─────────────────────────────────────────────────────────────────

interface MockState {
  lexicon: Record<string, string>;
  translateImpl: (q: string) => Promise<string | null>;
  translateCalls: number;
  lexiconCalls: number;
}

function makeDeps(over: Partial<MockState> = {}): {
  deps: ExpansionDeps;
  state: MockState;
} {
  const state: MockState = {
    lexicon: {},
    translateImpl: async () => null,
    translateCalls: 0,
    lexiconCalls: 0,
    ...over,
  };
  const deps: ExpansionDeps = {
    enableEnTranslation: true,
    enableKkTranslation: false,
    getLexicon: async () => {
      state.lexiconCalls += 1;
      return state.lexicon;
    },
    translateToEnglish: async (q) => {
      state.translateCalls += 1;
      return state.translateImpl(q);
    },
  };
  return { deps, state };
}

// ─── 1. as_is_ru всегда первый ───────────────────────────────────────────────

Deno.test("qe: as_is_ru — всегда первая попытка, даже при пустом lexicon и без LLM", async () => {
  const { deps } = makeDeps({ translateImpl: async () => null });
  const r = await expandQuery({ query: "term-A модификатор-B", traceId: "t1" }, deps);
  assertEquals(r.attempts[0].form, "as_is_ru");
  assertEquals(r.attempts[0].text, "term-A модификатор-B");
  // lexicon_empty + (translation failed) + kk_off
  assert(r.skipped.includes("lexicon_empty"));
  assert(r.skipped.includes("kk_off"));
});

// ─── 2. Lexicon: пустой → skip lexicon_empty ────────────────────────────────

Deno.test("qe: lexicon пуст → skipped 'lexicon_empty', одна попытка as_is_ru", async () => {
  const { deps } = makeDeps({ lexicon: {} });
  const r = await expandQuery({ query: "alpha beta", traceId: "t" }, deps);
  assert(r.skipped.includes("lexicon_empty"));
  assertEquals(r.attempts.filter((a) => a.form === "lexicon_canonical").length, 0);
});

// ─── 3. Lexicon: применилась замена → добавлен attempt ───────────────────────

Deno.test("qe: lexicon применил замену → добавлен attempt lexicon_canonical с meta", async () => {
  const { deps } = makeDeps({
    lexicon: { "term-x": "term-y" },
    translateImpl: async () => null,
  });
  const r = await expandQuery({ query: "term-x модификатор", traceId: "t" }, deps);
  const lex = r.attempts.find((a) => a.form === "lexicon_canonical");
  assert(lex, "должен появиться lexicon_canonical attempt");
  assertEquals(lex!.text, "term-y модификатор");
  const repl = (lex!.meta as { replacements: Array<{ from: string; to: string }> })
    .replacements;
  assertEquals(repl.length, 1);
  assertEquals(repl[0], { from: "term-x", to: "term-y" });
});

// ─── 4. Lexicon: word-boundary с кириллицей (не задевает подстроки) ─────────

Deno.test("qe: applyLexicon — кириллический word-boundary, не цепляет подстроки", () => {
  // 'кот' не должен заменяться внутри 'котёл'.
  const out = applyLexicon("котёл и кот", { "кот": "феникс" });
  assertEquals(out.text, "котёл и феникс");
  assertEquals(out.appliedReplacements.length, 1);
});

// ─── 5. Lexicon: многословные ключи имеют приоритет над однословными ────────

Deno.test("qe: applyLexicon — длинные фразы матчатся раньше однословных", () => {
  const out = applyLexicon("alpha beta gamma", {
    "alpha": "X",            // короткий
    "alpha beta": "PHRASE",  // длинный → должен победить
  });
  // Длинный ключ применяется первым: «alpha beta» → «PHRASE», 'alpha' уже не остаётся.
  assertStringIncludes(out.text, "PHRASE");
  assert(!out.text.includes("alpha"));
  assertEquals(out.text, "PHRASE gamma");
});

// ─── 6. Lexicon: no_match → корректный skip ──────────────────────────────────

Deno.test("qe: lexicon есть, но ни одного матча → skipped 'lexicon_no_match'", async () => {
  const { deps } = makeDeps({ lexicon: { "foo": "bar" } });
  const r = await expandQuery({ query: "alpha beta", traceId: "t" }, deps);
  assert(r.skipped.includes("lexicon_no_match"));
  assertEquals(r.attempts.filter((a) => a.form === "lexicon_canonical").length, 0);
});

// ─── 7. en_translation: успешный перевод добавляется ────────────────────────

Deno.test("qe: en_translation добавлен когда LLM вернул валидный перевод", async () => {
  const { deps, state } = makeDeps({
    translateImpl: async () => "translated text",
  });
  const r = await expandQuery({ query: "запрос-А", traceId: "t" }, deps);
  assertEquals(state.translateCalls, 1);
  const en = r.attempts.find((a) => a.form === "en_translation");
  assert(en);
  assertEquals(en!.text, "translated text");
});

// ─── 8. en_translation: identity (LLM вернул тот же текст) → skip ──────────

Deno.test("qe: en_translation идентичен оригиналу → skipped 'en_translation_identity'", async () => {
  const { deps } = makeDeps({
    translateImpl: async () => "Same Text", // case-insensitive сравнение
  });
  const r = await expandQuery({ query: "same text", traceId: "t" }, deps);
  assert(r.skipped.includes("en_translation_identity"));
  assertEquals(r.attempts.filter((a) => a.form === "en_translation").length, 0);
});

// ─── 9. en_translation: LLM null → skipped failed ───────────────────────────

Deno.test("qe: en_translation null → skipped 'en_translation_failed'", async () => {
  const { deps } = makeDeps({ translateImpl: async () => null });
  const r = await expandQuery({ query: "запрос", traceId: "t" }, deps);
  assert(r.skipped.includes("en_translation_failed"));
});

// ─── 10. en_translation: throw → не падает, корректный skip ─────────────────

Deno.test("qe: en_translation throw → перехвачен, skipped 'en_translation_failed'", async () => {
  const { deps } = makeDeps({
    translateImpl: async () => {
      throw new Error("network down");
    },
  });
  const r = await expandQuery({ query: "запрос", traceId: "t" }, deps);
  assert(r.skipped.includes("en_translation_failed"));
  // as_is_ru обязан остаться
  assertEquals(r.attempts[0].form, "as_is_ru");
});

// ─── 11. en_translation off через флаг ──────────────────────────────────────

Deno.test("qe: enableEnTranslation=false → translate НЕ вызван, skipped 'en_translation_off'", async () => {
  const { deps, state } = makeDeps({
    translateImpl: async () => "translated",
  });
  (deps as ExpansionDeps).enableEnTranslation = false;
  const r = await expandQuery({ query: "запрос", traceId: "t" }, deps);
  assertEquals(state.translateCalls, 0);
  assert(r.skipped.includes("en_translation_off"));
});

// ─── 12. kk_off — всегда skipped (§9.2b) ────────────────────────────────────

Deno.test("qe: kk ступень всегда skipped 'kk_off' (§9.2b)", async () => {
  const { deps } = makeDeps({});
  const r = await expandQuery({ query: "запрос", traceId: "t" }, deps);
  assert(r.skipped.includes("kk_off"));
  assertEquals(r.attempts.filter((a) => a.form === "kk_off").length, 0);
});

// ─── 13. Полный happy-path: 3 attempts (as_is + lexicon + en) ───────────────

Deno.test("qe: happy-path с lexicon-match и переводом → 3 attempts в правильном порядке", async () => {
  const { deps } = makeDeps({
    lexicon: { "term-x": "term-y" },
    translateImpl: async (q) => `EN: ${q}`,
  });
  const r = await expandQuery({ query: "term-x модификатор", traceId: "t" }, deps);
  assertEquals(r.attempts.length, 3);
  assertEquals(r.attempts[0].form, "as_is_ru");
  assertEquals(r.attempts[1].form, "lexicon_canonical");
  assertEquals(r.attempts[2].form, "en_translation");
});

// ─── 14. Lexicon error → graceful, не ломает пайплайн ───────────────────────

Deno.test("qe: getLexicon throw → пайплайн не падает, skipped 'lexicon_empty'", async () => {
  const deps: ExpansionDeps = {
    getLexicon: async () => {
      throw new Error("DB down");
    },
    translateToEnglish: async () => null,
    enableEnTranslation: false,
  };
  const r = await expandQuery({ query: "запрос", traceId: "t" }, deps);
  assertEquals(r.attempts[0].form, "as_is_ru");
  assert(r.skipped.includes("lexicon_empty"));
});

// ─── 15. Пустой query → as_is_ru с пустой строкой ──────────────────────────

Deno.test("qe: пустой query → as_is_ru с '', не падает", async () => {
  const { deps } = makeDeps({});
  const r = await expandQuery({ query: "   ", traceId: "t" }, deps);
  assertEquals(r.attempts[0].text, "");
});

// ─── 16. §9.2b §3 — traits заменяют сырую реплику в as_is_ru ───────────────

Deno.test("qe §9.2b §3: traits override raw query for as_is_ru", async () => {
  const { deps } = makeDeps({});
  const r = await expandQuery(
    {
      query: "найди черные двухгнёздые розетки пожалуйста",
      traceId: "t",
      traits: ["черные", "двухгнёздые", "розетки"],
    },
    deps,
  );
  assertEquals(r.attempts[0].form, "as_is_ru");
  // Шумовые слова "найди", "пожалуйста" должны быть отброшены — в attempt
  // только трейты, иначе word-boundary post-filter §9.2c обнулит выдачу.
  assertEquals(r.attempts[0].text, "черные двухгнёздые розетки");
  assertEquals(r.attempts[0].meta?.source, "traits");
});

Deno.test("qe §9.2b §3: пустой traits → fallback на raw query", async () => {
  const { deps } = makeDeps({});
  const r = await expandQuery(
    { query: "сырой запрос", traceId: "t", traits: [] },
    deps,
  );
  assertEquals(r.attempts[0].text, "сырой запрос");
  assertEquals(r.attempts[0].meta?.source, "raw_query");
});

Deno.test("qe §9.2b §3: undefined traits → fallback на raw query (бекcompat)", async () => {
  const { deps } = makeDeps({});
  const r = await expandQuery(
    { query: "обратная совместимость", traceId: "t" },
    deps,
  );
  assertEquals(r.attempts[0].text, "обратная совместимость");
});
