import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

const provenance = JSON.parse(fs.readFileSync(
  new URL('../../docs/qa/source-provenance-20261009.json', import.meta.url), 'utf8'));

const promptHash = (text) => createHash('sha256')
  .update(text.normalize('NFKC').trim().replace(/ +/g, ' '), 'utf8')
  .digest('hex');

test('recorded source-paragraph hashes still match the first prompt in the pinned QA matrices', () => {
  assert.equal(provenance.source_document.id, '1EeEUI3uRCk3kyBhAy4p8eTJT2S9mT9xDQI69RMPd1JU');
  assert.equal(provenance.source_document.tab_id, 't.0');
  assert.equal(provenance.source_document.provider_revision_id, null);
  assert.equal(provenance.exact_first_prompt_matches.length, 29);

  const suites = new Map();
  const seen = new Set();
  const counts = new Map();
  for (const [suiteName, caseId, ordinal, startIndex, sourceHash] of provenance.exact_first_prompt_matches) {
    assert.match(suiteName, /^(?:customer-audit-20260921|customer-acceptance)-cases\.json$/u);
    assert(!seen.has(`${suiteName}/${caseId}`), `duplicate source claim for ${caseId}`);
    seen.add(`${suiteName}/${caseId}`);
    assert(Number.isSafeInteger(ordinal) && ordinal > 0);
    assert(Number.isSafeInteger(startIndex) && startIndex > 0);
    assert.match(sourceHash, /^[a-f0-9]{64}$/u);
    if (!suites.has(suiteName)) {
      suites.set(suiteName, JSON.parse(fs.readFileSync(new URL(`./${suiteName}`, import.meta.url), 'utf8')));
    }
    const testCase = suites.get(suiteName).cases.find((item) => item.id === caseId);
    assert(testCase, `source claim refers to missing case ${caseId}`);
    assert.equal(promptHash(testCase.turns[0].message), sourceHash,
      `${caseId}: local first prompt no longer matches the recorded source-paragraph hash`);
    counts.set(suiteName, (counts.get(suiteName) ?? 0) + 1);
  }
  assert.equal(counts.get('customer-audit-20260921-cases.json'), 27);
  assert.equal(counts.get('customer-acceptance-cases.json'), 2);
});

test('all 30 legacy cases have ticket attribution and both BT-923 prompts match the ticket text', () => {
  const index = JSON.parse(fs.readFileSync(
    new URL('../../docs/qa/notion-source-index-20261009.json', import.meta.url), 'utf8'));
  const suites = ['notion-legacy-bug-cases.json', 'notion-legacy-bug-cases-v2.json']
    .map((file) => JSON.parse(fs.readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')));
  assert.equal(index.tickets.length, 9);
  assert(suites.every((suite) => suite.cases.length === 30));
  assert.deepEqual(suites[1].cases.map((item) => item.id), suites[0].cases.map((item) => item.id));
  for (const oldCase of suites[0].cases) {
    if (oldCase.id.startsWith('bt923-')) continue;
    const nextCase = suites[1].cases.find((item) => item.id === oldCase.id);
    assert.deepEqual(nextCase.turns.map((turn) => turn.message), oldCase.turns.map((turn) => turn.message));
  }
  const ticketIds = new Set();
  for (const ticket of index.tickets) {
    assert(!ticketIds.has(ticket.ticket));
    ticketIds.add(ticket.ticket);
    assert.match(ticket.page_url, /^https:\/\/app\.notion\.com\/p\/[a-f0-9]{32}$/u);
    const casePrefix = ticket.ticket.toLowerCase().replace('-', '');
    for (const suite of suites) {
      assert.equal(suite.cases.filter((item) => item.id.startsWith(casePrefix)).length, ticket.case_count);
    }
  }
  assert.equal(index.tickets.reduce((count, ticket) => count + ticket.case_count, 0), 30);
  for (const suite of suites) {
    for (const testCase of suite.cases) {
      const ticket = testCase.id.match(/^(bt\d+)/u)?.[1];
      assert(ticketIds.has(ticket?.replace(/^bt/u, 'BT-')), `${testCase.id}: no ticket page`);
    }
  }
  assert.deepEqual(Object.keys(index.comment_only_cases).sort(),
    ['bt746-black-double-socket', 'bt746-garmoniya-sockets']);
  assert.deepEqual(index.observed_instability_comments.map((item) => item.ticket),
    ['BT-928', 'BT-923', 'BT-924']);
  for (const item of index.observed_instability_comments) {
    assert.match(item.comment_id, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
    assert(item.observation.length > 30);
    assert(item.qa_policy.length > 30);
  }
  for (const item of index.observed_instability_comments.slice(0, 2)) {
    assert.match(item.observation, /once in three/u);
    assert.match(item.qa_policy, /team reliability criterion/u);
  }
  assert.match(index.observed_instability_comments[2].observation, /no stated number/u);
  const unitFact = index.clarified_source_facts.find((item) => item.ticket === 'BT-923' && item.expected_catalog_unit === 'шт');
  assert.equal(unitFact.page_url, index.tickets.find((item) => item.ticket === 'BT-923').page_url);
  assert.equal(unitFact.expected_catalog_unit, 'шт');
  assert.match(unitFact.source_product_url, /nbt-cr2025-bp5-94-764-navigator\/$/u);
  assert.match(unitFact.source_meaning, /does not establish how many battery cells/u);
  const cableFact = index.clarified_source_facts.find((item) => item.ticket === 'BT-923' && item.expected_catalog_unit === 'м');
  assert.match(cableFact.source_product_url, /kabel-vvg-3\*1,5\/$/u);
  for (const [caseId, fact] of [
    ['bt923-battery-unit', unitFact],
    ['bt923-vvg-3x1_5-unit', cableFact],
  ]) {
    const testCase = suites[1].cases.find((item) => item.id === caseId);
    assert.equal(testCase.turns[0].message, fact.source_prompt);
    assert.equal(testCase.turns[0].expect.require_every_product_page.facets[0].name, 'Единица измерения');
  }
  assert.equal(suites[1].cases.find((item) => item.id === 'bt923-vvg-3x1_5-unit')
    .turns[0].expect.require_every_product_stock_unit, 'м');
});
