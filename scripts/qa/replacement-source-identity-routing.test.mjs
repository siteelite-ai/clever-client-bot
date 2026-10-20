import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  admitDirectSelectionRoute,
  directProductProvesLiteralWords,
} from "../../supabase/functions/chat-consultant-v3/selection-jargon-policy.ts";
import {
  extractReplacementSourceDescription,
  provisionalReplacementCandidateText,
} from "../../supabase/functions/_shared/v3-tools/replacement-preflight.ts";

const request =
  "предложи аналоги на Светильник DN027B G2 LED6/NW 7W 220-240V D90 R; 929002070102/871869967897500";
const candidate = {
  pagetitle: "Светильник встраиваемый LED 7W 220-240V D90",
  short_traits: ["Мощность, Вт: 7", "Напряжение, В: 220-240"],
  description_excerpt: "",
};

test("source title and article are lookup identity, not analogue literals", () => {
  assert.equal(
    admitDirectSelectionRoute({ route: "replacement", userMessage: request }),
    true,
  );
  assert.equal(
    directProductProvesLiteralWords(
      extractReplacementSourceDescription(request),
      candidate,
      ["Philips", "DN027B"],
    ),
    false,
    "the former source-title lexical gate wrongly rejects a compatible cross-model card",
  );

  const source = readFileSync(
    new URL("../../supabase/functions/chat-consultant-v3/index.ts", import.meta.url),
    "utf8",
  );
  const begin = source.indexOf("async function selectVerifiedOrdinaryReplacement(");
  const end = source.indexOf("async function selectVerifiedExactCompoundProducts(", begin);
  assert.ok(begin > -1 && end > begin);
  const preflight = source.slice(begin, end);
  assert.doesNotMatch(preflight, /directProductProvesLiteralWords\s*\(/u);
  assert.match(preflight, /productProvesDirectReplacementAxes\s*\(/u);
  assert.doesNotMatch(preflight, /productTitleSupportsMandatoryAxes\s*\(/u);
  assert.match(preflight, /productContainsSourceModel\s*\(/u);
  assert.match(preflight, /sourceIdentityVerified = found\.total === 1 &&\s*exactArticleMatches\.length === 1 &&\s*exactArticleMatches\[0\]\.id === anchor\.id/u);
  const cards = preflight.indexOf('type: "products_block"');
  assert.ok(cards > -1, "direct replacement still renders product cards");
  // Disclosure now belongs to the common SSE proof boundary, not this one
  // preflight branch: direct/model/fallback cards must share the same caption.
  const egress = source.slice(source.indexOf("const send = (ev: SseEvent) => {"));
  const proof = egress.indexOf("const caption = replacementProofCaption(replacementLastProof)");
  const proofSent = egress.indexOf("responseEvents.push(disclosure)", proof);
  const publicBlock = egress.indexOf("responseEvents.push(out)", proofSent);
  assert.ok(proof > -1 && proofSent > proof && publicBlock > proofSent,
    "server-owned replacement proof must precede product cards on every render path");
  assert.match(preflight, /replacement_evidence:\s*"provisional"/u);

  const axes = [{ caption: "Мощность", value: "7 Вт" }];
  for (const sourceIdentityVerified of [false, true]) {
    const text = provisionalReplacementCandidateText(axes, sourceIdentityVerified);
    assert.match(text, /кандидатов для замены/u);
    assert.match(text, /Мощность: 7 Вт/u);
    assert.match(text, /взаимозаменяемость не подтверждена/u);
    assert.match(text, /паспортн\p{L}* и монтажн\p{L}* характеристик\p{L}*/u);
    assert.doesNotMatch(text, /совместимые аналоги|подтверждённые аналоги/iu);
    if (!sourceIdentityVerified) assert.match(text, /точный артикул исходного изделия/u);
  }
});

test("independent fit constraints still leave the direct replacement route", () => {
  for (const extra of [
    "для гостиной 25 м²",
    "с монтажным диаметром 90 мм",
    "до 5000 тенге",
  ]) {
    assert.equal(
      admitDirectSelectionRoute({
        route: "replacement",
        userMessage: `${request} ${extra}`,
      }),
      false,
      extra,
    );
  }
});

test("ordinary direct searches retain their literal colour gate", () => {
  assert.equal(
    directProductProvesLiteralWords("найди чёрный кабель ВВГ", {
      pagetitle: "Кабель ВВГ",
      short_traits: ["Цвет: белый"],
      description_excerpt: "",
    }),
    false,
  );
});
