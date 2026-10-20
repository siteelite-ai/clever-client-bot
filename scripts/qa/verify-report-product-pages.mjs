#!/usr/bin/env node

// Recheck already-recorded product cards against their live detail pages.
// This deliberately makes no model or catalog API requests and does not
// reinterpret the customer's requested product attributes.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  productUrlIdentity,
  verifyProductLinks,
  PRODUCT_PAGE_TIMEOUT_MS,
} from './run-customer-acceptance.mjs';

const inStock = /^https?:\/\/schema\.org\/InStock$/iu;

function exactName(value) {
  return typeof value === 'string' ? value.normalize('NFC').replace(/\s+/gu, ' ').trim() : '';
}

function completedResponse(turn) {
  return turn?.status === 200 && turn.completed === true && !turn.diagnostic_error;
}

export function extractCompletedProductCards(report, source = '<report>') {
  if (!report || typeof report !== 'object' || !Array.isArray(report.cases)) {
    throw new Error(`${source}: full acceptance report with cases[] required`);
  }
  const cards = [];
  let completedTurns = 0;
  for (const testCase of report.cases) {
    if (!Array.isArray(testCase.repeats)) throw new Error(`${source}: case ${testCase.id ?? '?'} has no repeats[]`);
    for (const repeat of testCase.repeats) {
      if (!Array.isArray(repeat.turns)) {
        throw new Error(`${source}: case ${testCase.id ?? '?'} run ${repeat.run ?? '?'} has no full turns[]`);
      }
      for (const [index, turn] of repeat.turns.entries()) {
        if (!completedResponse(turn)) continue;
        completedTurns++;
        const location = `${source}: ${testCase.id ?? '?'} / ${repeat.variant ?? 'base'} / run ${repeat.run ?? '?'} / turn ${index + 1}`;
        if (!Array.isArray(turn.products)) throw new Error(`${location}: products[] missing; use the full report, not compact/minimal output`);
        if (Number.isInteger(turn.products_count) && turn.products_count !== turn.products.length) {
          throw new Error(`${location}: products_count ${turn.products_count} != products.length ${turn.products.length}`);
        }
        for (const [productIndex, product] of turn.products.entries()) {
          cards.push({ source, location: `${location} / card ${productIndex + 1}`, product });
        }
      }
    }
  }
  return { cards, completedTurns };
}

function cardFailures(product, proof, identity) {
  const failures = [];
  if (!proof?.verified) return [proof?.reason ?? 'product page could not be verified'];
  if (proof.identity !== identity) failures.push('page identity does not match card URL');
  if (productUrlIdentity(proof.canonicalUrl) !== identity) failures.push('canonical product URL not confirmed');
  if (typeof proof.sku !== 'string' || !proof.sku.trim() || proof.sku.trim() === '0') {
    failures.push('source SKU not confirmed');
  }
  if (!exactName(product.title) || !exactName(proof.name)) failures.push('card or live product name missing');
  if (!Number.isFinite(product.price) || product.price <= 0 ||
      !Number.isFinite(proof.offerPrice) || proof.offerPrice <= 0 ||
      product.price !== proof.offerPrice) {
    failures.push(`card price ${String(product.price)} differs from live KZT price ${String(proof.offerPrice)}`);
  }
  if (!inStock.test(proof.availability ?? '')) failures.push('live product not marked InStock');
  if (typeof product.stockLine !== 'string' || !product.stockLine.trim()) {
    failures.push('card has no stock line');
  }
  return failures;
}

export async function verifyReportsProductPages(reports, {
  fetchImpl = fetch,
  timeoutMs = PRODUCT_PAGE_TIMEOUT_MS,
} = {}) {
  if (!Array.isArray(reports) || reports.length === 0) throw new Error('at least one report is required');
  const inventories = reports.map(({ source, report }) => extractCompletedProductCards(report, source));
  const allCards = inventories.flatMap((inventory) => inventory.cards);
  const validLinks = allCards
    .filter(({ product }) => product && productUrlIdentity(product.url))
    .map(({ product }) => ({ url: product.url }));
  const verified = await verifyProductLinks(validLinks, { fetchImpl, timeoutMs });
  const failures = [];
  const nameDifferences = [];
  for (const { source, report } of reports) {
    if (report.passed !== true) {
      failures.push({ location: source, reason: 'acceptance report did not pass' });
    }
  }
  for (const { location, product } of allCards) {
    const identity = productUrlIdentity(product?.url);
    if (!identity) {
      failures.push({ location, reason: 'invalid or missing 220volt.kz catalog product URL' });
      continue;
    }
    const proof = verified.get(identity);
    for (const reason of cardFailures(product, proof, identity)) failures.push({ location, reason });
    // The catalog API and live product detail page can use legitimate aliases
    // for the same canonical SKU (e.g. «х-ка» / «характеристика»). Report this
    // editorial difference without confusing it with a wrong product identity.
    if (proof?.verified && exactName(product.title) && exactName(proof.name) &&
        exactName(product.title) !== exactName(proof.name)) {
      nameDifferences.push({ location, card_title: product.title, live_name: proof.name });
    }
  }
  if (allCards.length === 0) failures.push({ location: 'reports', reason: 'no completed product cards to verify' });
  return {
    passed: failures.length === 0,
    reports: reports.map(({ source, report }, index) => ({
      source,
      acceptance_passed: report.passed === true,
      completed_turns: inventories[index].completedTurns,
      cards: inventories[index].cards.length,
    })),
    cards_checked: allCards.length,
    unique_pages_checked: verified.size,
    pages_verified: [...verified.values()].filter((proof) => proof.verified).length,
    failures,
    name_differences: nameDifferences,
    limits: 'Checks current canonical page identity, SKU, existence of product names, KZT price and general InStock marker. Exact catalog-card/page name differences are advisory; this does not prove requested facets, city-level stock, or historical price/stock at answer time.',
  };
}

export async function main(paths = process.argv.slice(2), options = {}) {
  if (paths.length === 1 && paths[0] === '--help') {
    console.log('Usage: node scripts/qa/verify-report-product-pages.mjs <full-acceptance-report.json> [more-report.json ...]');
    return;
  }
  if (paths.length === 0 || paths.some((item) => item.startsWith('-') || !item.endsWith('.json'))) {
    throw new Error('Pass one or more full acceptance report .json paths; no API endpoint or AI request is used');
  }
  const reports = await Promise.all(paths.map(async (filePath) => {
    const source = path.resolve(filePath);
    return { source, report: JSON.parse(await readFile(source, 'utf8')) };
  }));
  const result = await verifyReportsProductPages(reports, options);
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(String(error?.message ?? error));
    process.exitCode = 1;
  }
}
