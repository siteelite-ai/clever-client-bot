import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../../supabase/functions/chat-consultant-v3/index.ts", import.meta.url),
  "utf8",
);
function section(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `missing source section ${start}`);
  return source.slice(first, last);
}

test("exact SKU and named-series model prose crosses the price egress guard", () => {
  const sku = section("async function answerVerifiedExactProductInquiry(", "async function answerMeasuredSourceClassRecovery(");
  const series = section("async function answerVerifiedNamedSeriesInquiry(", "async function selectVerifiedNamedSeriesRequest(");
  const handler = section("Deno.serve(async (req) => {", "// Open the SSE transport before any settings/database dependency.");
  assert.match(sku, /send\(\{ type: "delta", content: answer, origin: "model" \}\)/u);
  assert.match(series, /content: appendNamedSeriesClassCoverage\([\s\S]*?origin: "model"/u);
  assert.match(handler, /const origin = ev\.origin \?\? "model";[\s\S]*?guardPriceEgressText\(\{[\s\S]*?origin,/u);
  assert.match(handler, /requestedPriceExtreme && !priceScopeDisclosureSent &&[\s\S]*?type: "delta", content: notice[\s\S]*?emit\(disclosure\)/u);
  assert.ok(handler.indexOf("emit(disclosure)") < handler.indexOf("responseEvents.push(out)"), "unverified notice must precede cards");
});

test("complete-category VVG and recent-set proof register before their price claim/cards", () => {
  const vvg = section("async function selectVerifiedExactCompoundProducts(", "async function selectVerifiedSemanticCompoundProducts(");
  const recent = section("async function selectVerifiedRecentPriceFollowup(", "async function answerBroadAssortmentRequest(");
  assert.match(vvg, /const certificate = certificateFromCompleteCategory\(/u);
  assert.match(vvg, /if \(!certificate \|\| !registerPriceProof\(certificate\)\)/u);
  assert.ok(vvg.indexOf("registerPriceProof(certificate)") < vvg.indexOf('type: "products_block"'));
  assert.match(vvg, /price_winner_id: winner\.id/u);
  assert.match(recent, /const certificate = certificateFromRecentSet\(/u);
  assert.match(recent, /if \(!certificate \|\| !registerPriceProof\(certificate\)\)/u);
  assert.ok(recent.indexOf("registerPriceProof(certificate)") < recent.indexOf("Среди ${proof.compared_count}"));
  assert.match(recent, /price_winner_id: proof\.winner\.id/u);
  assert.match(source, /const registerPriceProof = \(certificate: PriceExtremeCertificate\): boolean => \{[\s\S]*?priceCertificateApplies\(/u);
  assert.match(source, /priceCertificateCoversCardBlock\(\{[\s\S]*?renderedCount: ev\.count,[\s\S]*?renderedWinnerId: ev\.price_winner_id \?\? null/u);
});
