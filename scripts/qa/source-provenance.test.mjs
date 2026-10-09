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

test('all 30 legacy cases have a ticket-page attribution without claiming block-level proof', () => {
  const index = JSON.parse(fs.readFileSync(
    new URL('../../docs/qa/notion-source-index-20261009.json', import.meta.url), 'utf8'));
  const suite = JSON.parse(fs.readFileSync(
    new URL('./notion-legacy-bug-cases.json', import.meta.url), 'utf8'));
  assert.equal(index.tickets.length, 9);
  assert.equal(suite.cases.length, 30);
  const ticketIds = new Set();
  for (const ticket of index.tickets) {
    assert(!ticketIds.has(ticket.ticket));
    ticketIds.add(ticket.ticket);
    assert.match(ticket.page_url, /^https:\/\/app\.notion\.com\/p\/[a-f0-9]{32}$/u);
    const casePrefix = ticket.ticket.toLowerCase().replace('-', '');
    assert.equal(suite.cases.filter((item) => item.id.startsWith(casePrefix)).length, ticket.case_count);
  }
  assert.equal(index.tickets.reduce((count, ticket) => count + ticket.case_count, 0), 30);
  for (const testCase of suite.cases) {
    const ticket = testCase.id.match(/^(bt\d+)/u)?.[1];
    assert(ticketIds.has(ticket?.replace(/^bt/u, 'BT-')), `${testCase.id}: no ticket page`);
  }
  assert.deepEqual(Object.keys(index.comment_only_cases).sort(),
    ['bt746-black-double-socket', 'bt746-garmoniya-sockets']);
});
