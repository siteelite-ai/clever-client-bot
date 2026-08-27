import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const casesFileArg = process.argv.find((arg) => arg.startsWith('--cases-file='))?.slice('--cases-file='.length).trim();
const casesPath = casesFileArg
  ? path.resolve(process.cwd(), casesFileArg)
  : path.join(here, 'customer-acceptance-cases.json');
export const DEFAULT_ENDPOINT = 'https://yngoixmvmxdfxokuafjp.supabase.co/functions/v1/chat-consultant-v3';

export function resolveEndpoint(argv = process.argv) {
  const raw = argv.find((arg) => arg.startsWith('--endpoint='))?.slice('--endpoint='.length).trim();
  if (!raw) return DEFAULT_ENDPOINT;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid acceptance endpoint: ${raw}`);
  }
  const localHttp = parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !localHttp) {
    throw new Error('Acceptance endpoint must use HTTPS (HTTP is allowed only for localhost)');
  }
  if (!/^\/functions\/v1\/[a-z0-9-]+\/?$/i.test(parsed.pathname)) {
    throw new Error(`Acceptance endpoint must target one Edge Function: ${parsed.pathname}`);
  }
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

const endpoint = resolveEndpoint();

const widget = fs.readFileSync(path.join(root, 'public/widget.js'), 'utf8');
const apiKey = widget.match(/supabaseKey:\s*'([^']+)'/)?.[1];
if (!apiKey) throw new Error('Public widget key was not found');

const suite = JSON.parse(fs.readFileSync(casesPath, 'utf8'));
const onlyIds = process.argv.find((arg) => arg.startsWith('--case='))
  ?.slice('--case='.length)
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const repeatOverrideRaw = process.argv.find((arg) => arg.startsWith('--repeat='))?.slice('--repeat='.length);
const repeatOverride = repeatOverrideRaw ? Number(repeatOverrideRaw) : null;
const compactOutput = process.argv.includes('--compact');
const minimalOutput = process.argv.includes('--minimal');
const failuresOnlyOutput = process.argv.includes('--failures-only');
const stopOnFailure = process.argv.includes('--stop-on-failure');
const selected = onlyIds?.length ? suite.cases.filter((item) => onlyIds.includes(item.id)) : suite.cases;
const missingIds = onlyIds?.filter((id) => !selected.some((item) => item.id === id)) ?? [];
if (missingIds.length > 0) throw new Error(`Unknown case: ${missingIds.join(', ')}`);

export function parseSse(body) {
  let text = '';
  let textBeforeProducts = '';
  let productsMarkdown = '';
  let productsStarted = false;
  let logId = null;
  let completed = false;
  let serverProductsCount = null;
  let diagnosticError = null;
  let conversationBoundary = null;
  const toolEvents = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (payload === '[DONE]') {
      completed = true;
      continue;
    }
    let parsed;
    try { parsed = JSON.parse(payload); } catch { continue; }
    const event = parsed.v3_event;
    if (event?.type === 'products_block' && typeof event.markdown === 'string') {
      productsStarted = true;
      productsMarkdown += `${productsMarkdown ? '\n\n' : ''}${event.markdown}`;
    }
    if (event?.type === 'diagnostic') {
      logId = event.log_id || logId;
      diagnosticError = event.error || diagnosticError;
      if (event.phase === 'complete' && typeof event.products_count === 'number') {
        serverProductsCount = event.products_count;
      }
    }
    if (event?.type === 'conversation_boundary' && event.mode === 'new_task' && typeof event.session_id === 'string') {
      conversationBoundary = { mode: event.mode, sessionId: event.session_id };
    }
    if (event?.type === 'tool_event') {
      toolEvents.push({
        tool: typeof event.tool === 'string' ? event.tool : null,
        phase: typeof event.phase === 'string' ? event.phase : null,
        summary: typeof event.summary === 'string' ? event.summary : null,
        duration_ms: Number.isFinite(event.duration_ms) ? event.duration_ms : null,
      });
    }
    const delta = parsed.choices?.[0]?.delta?.content;
    if (typeof delta === 'string') {
      text += delta;
      if (!productsStarted) textBeforeProducts += delta;
    }
  }
  const links = [];
  const re = /- \*\*\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)\*\*(?:\r?\n\s+Цена:\s+\*([\d\s]+)\*\s+₸[^\r\n]*)?/g;
  for (let match; (match = re.exec(productsMarkdown)) !== null;) {
    const parsedPrice = Number(String(match[3] ?? '').replace(/\s+/g, ''));
    const nextBlock = productsMarkdown.indexOf('\n\n- **[', match.index + match[0].length);
    const block = productsMarkdown.slice(match.index, nextBlock >= 0 ? nextBlock : undefined);
    const stockLine = block.match(/\r?\n\s+Наличие:\s*([^\r\n]+)/u)?.[1]?.trim() ?? null;
    links.push({
      title: match[1],
      url: match[2],
      price: Number.isFinite(parsedPrice) && parsedPrice > 0 ? parsedPrice : null,
      stockLine,
    });
  }
  return { text, textBeforeProducts, productsMarkdown, links, logId, completed, serverProductsCount, diagnosticError, conversationBoundary, toolEvents };
}

function includesAny(haystack, needles) {
  const lower = haystack.toLocaleLowerCase('ru-RU');
  return needles.some((needle) => lower.includes(String(needle).toLocaleLowerCase('ru-RU')));
}

function matchesEveryGroup(value, groups) {
  return groups.every((group) => Array.isArray(group) && group.length > 0 && includesAny(value, group));
}

function includesStandalonePhrase(haystack, phrase) {
  const escaped = String(phrase).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(haystack);
}

function parseTitleNumericPair(title) {
  const match = String(title ?? '').match(/(\d+(?:[.,]\d+)?)\s*\/\s*(\d+(?:[.,]\d+)?)/u);
  if (!match) return null;
  const first = Number(match[1].replace(',', '.'));
  const second = Number(match[2].replace(',', '.'));
  if (!Number.isFinite(first) || !Number.isFinite(second) || first <= 0 || second <= 0 || first === second) return null;
  return { high: Math.max(first, second), low: Math.min(first, second) };
}

function titleMeasurements(title, units, allowCompactNumeric = false) {
  const aliases = (Array.isArray(units) ? units : [])
    .map((unit) => String(unit).trim())
    .filter(Boolean)
    .map((unit) => unit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (aliases.length === 0) return [];
  const values = [];
  const pattern = new RegExp(`(-?\\d+(?:[.,]\\d+)?)\\s*(?:${aliases.join('|')})(?![\\p{L}\\p{N}])`, 'giu');
  for (let match; (match = pattern.exec(String(title ?? ''))) !== null;) {
    const value = Number(match[1].replace(',', '.'));
    if (Number.isFinite(value)) values.push(value);
  }
  if (values.length > 0 || !allowCompactNumeric) return values;
  const source = String(title ?? '');
  const multiplication = /(\d+(?:[.,]\d+)?)\s*[xх×*]\s*(\d+(?:[.,]\d+)?)/giu;
  for (let match; (match = multiplication.exec(source)) !== null;) {
    const left = Number(match[1].replace(',', '.'));
    const right = Number(match[2].replace(',', '.'));
    if (Number.isFinite(left) && Number.isFinite(right)) values.push(left * right);
  }
  const compact = /-(\d{2,5})(?=$|[\s/),])/gu;
  for (let match; (match = compact.exec(source)) !== null;) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) values.push(value);
  }
  return values;
}

export function evaluate(expect = {}, response) {
  const failures = [];
  const productTitles = response.links.map((link) => link.title).join('\n');
  const allOutput = `${response.text}\n${response.productsMarkdown}`;
  if (expect.conversation_boundary === 'new_task' && response.conversationBoundary?.mode !== 'new_task') {
    failures.push('expected automatic new_task conversation boundary');
  }
  if (expect.conversation_boundary === 'continuation' && response.conversationBoundary) {
    failures.push(`unexpected conversation boundary: ${response.conversationBoundary.mode}`);
  }
  if (Number.isFinite(expect.min_products) && response.links.length < expect.min_products) {
    failures.push(`products ${response.links.length} < ${expect.min_products}`);
  }
  if (Number.isFinite(expect.max_products) && response.links.length > expect.max_products) {
    failures.push(`products ${response.links.length} > ${expect.max_products}`);
  }
  for (const phrase of expect.forbid_text ?? []) {
    if (includesAny(allOutput, [phrase])) failures.push(`forbidden text: ${phrase}`);
  }
  for (const phrase of expect.forbid_assistant_text ?? []) {
    if (includesAny(response.text, [phrase])) failures.push(`forbidden assistant text: ${phrase}`);
  }
  for (const phrase of expect.forbid_product_title ?? []) {
    if (response.links.some((link) => includesStandalonePhrase(link.title, phrase))) {
      failures.push(`forbidden product title: ${phrase}`);
    }
  }
  if (Array.isArray(expect.require_any_text) && !includesAny(allOutput, expect.require_any_text)) {
    failures.push(`none of required text fragments found: ${expect.require_any_text.join(', ')}`);
  }
  if (Array.isArray(expect.require_text_groups) && !matchesEveryGroup(response.text, expect.require_text_groups)) {
    failures.push(`assistant text misses one or more required groups: ${expect.require_text_groups.map((group) => `[${group.join(', ')}]`).join(' ')}`);
  }
  if (Array.isArray(expect.require_product_title) && !includesAny(productTitles, expect.require_product_title)) {
    failures.push(`none of required product-title fragments found: ${expect.require_product_title.join(', ')}`);
  }
  if (Array.isArray(expect.require_every_product_title_any) && response.links.some((link) => !includesAny(link.title, expect.require_every_product_title_any))) {
    failures.push(`some product titles miss every required fragment: ${expect.require_every_product_title_any.join(', ')}`);
  }
  if (Array.isArray(expect.require_every_product_title_groups)) {
    const invalidTitles = response.links
      .filter((link) => !matchesEveryGroup(link.title, expect.require_every_product_title_groups))
      .map((link) => link.title);
    if (invalidTitles.length > 0) failures.push(`product titles violate required groups: ${invalidTitles.join(' | ')}`);
  }
  if (expect.require_exact_or_split && typeof expect.require_exact_or_split === 'object') {
    const contract = expect.require_exact_or_split;
    const exact = Array.isArray(contract.exact_title_groups) && response.links.some((link) =>
      matchesEveryGroup(link.title, contract.exact_title_groups)
    );
    const splitTitles = Array.isArray(contract.split_title_groups) && contract.split_title_groups.every((group) =>
      Array.isArray(group) && group.length > 0 && response.links.some((link) => includesAny(link.title, group))
    );
    const splitText = Array.isArray(contract.split_text_groups) && matchesEveryGroup(response.text, contract.split_text_groups);
    if (!exact && !(splitTitles && splitText)) {
      failures.push('neither exact product nor evidence-labelled split alternatives were returned');
    }
  }
  if (Array.isArray(expect.forbid_every_product_title_any)) {
    const invalidTitles = response.links
      .filter((link) => includesAny(link.title, expect.forbid_every_product_title_any))
      .map((link) => link.title);
    if (invalidTitles.length > 0) failures.push(`product titles contain forbidden class fragments: ${invalidTitles.join(' | ')}`);
  }
  if (Number.isFinite(expect.require_every_product_pair_around)) {
    const reference = Number(expect.require_every_product_pair_around);
    const invalidTitles = response.links.filter((link) => {
      const pair = parseTitleNumericPair(link.title);
      return !pair || !(pair.high > reference && pair.low < reference);
    }).map((link) => link.title);
    if (invalidTitles.length > 0) {
      failures.push(`product title pair does not strictly surround ${reference}: ${invalidTitles.join(' | ')}`);
    }
  }
  if (expect.require_every_product_measurement && typeof expect.require_every_product_measurement === 'object') {
    const contract = expect.require_every_product_measurement;
    const invalidTitles = response.links.filter((link) => {
      const values = titleMeasurements(link.title, contract.units, contract.allow_compact_numeric === true);
      return values.length === 0 || !values.some((value) =>
        (!Number.isFinite(contract.min) || value >= contract.min) &&
        (!Number.isFinite(contract.max) || value <= contract.max)
      );
    }).map((link) => link.title);
    if (invalidTitles.length > 0) {
      failures.push(`product title measurement violates contract: ${invalidTitles.join(' | ')}`);
    }
  }
  if (Array.isArray(expect.deprioritized_warehouses)) {
    for (const link of response.links) {
      if (!link.stockLine) continue;
      const parts = link.stockLine.split(',').map((part) => part.trim()).filter(Boolean);
      let deprioritizedSeen = false;
      for (const part of parts) {
        const isDeprioritized = expect.deprioritized_warehouses.some((warehouse) => includesAny(part, [warehouse]));
        if (isDeprioritized) deprioritizedSeen = true;
        else if (deprioritizedSeen) failures.push(`deprioritized warehouse shown before ordinary warehouse: ${link.stockLine}`);
      }
    }
  }
  if (Number.isFinite(expect.max_product_price)) {
    const missingPrices = response.links.filter((link) => !Number.isFinite(link.price));
    const overBudget = response.links.filter((link) => Number.isFinite(link.price) && link.price > expect.max_product_price);
    if (missingPrices.length > 0) failures.push(`missing parsed price for ${missingPrices.length} product(s)`);
    if (overBudget.length > 0) failures.push(`product price exceeds ${expect.max_product_price}: ${overBudget.map((link) => `${link.title}=${link.price}`).join(' | ')}`);
  }
  if (Number.isFinite(expect.min_text_chars) && response.text.trim().length < expect.min_text_chars) {
    failures.push(`assistant text ${response.text.trim().length} chars < ${expect.min_text_chars}`);
  }
  if (Number.isFinite(expect.min_text_before_products_chars) && response.textBeforeProducts.trim().length < expect.min_text_before_products_chars) {
    failures.push(`assistant text before products ${response.textBeforeProducts.trim().length} chars < ${expect.min_text_before_products_chars}`);
  }
  if (Number.isFinite(response.serverProductsCount) && response.serverProductsCount !== response.links.length) {
    failures.push(`server products_count ${response.serverProductsCount} != parsed products ${response.links.length}`);
  }
  if (
    expect.forbid_unrendered_catalog_facts === true &&
    /(?:\bарт\.?\s*[A-ZА-ЯЁ0-9-]{3,}|\bналичие\s*:|\bцена\s*:\s*\d|₸\s*\/|₸\/)/iu.test(response.text)
  ) {
    failures.push('unrendered catalog facts in assistant text');
  }
  if (!response.completed) failures.push('SSE did not complete');
  if (response.diagnosticError) failures.push(`diagnostic error: ${response.diagnosticError}`);
  const genericFailureText = [
    'Не получилось обработать запрос',
    'Попробуйте переформулировать',
    'Часть ответа содержала служебные сведения',
  ];
  for (const phrase of genericFailureText) {
    if (includesAny(allOutput, [phrase])) failures.push(`generic failure fallback: ${phrase}`);
  }
  return failures;
}

async function runTurn({ message, expect }, state) {
  const startedAt = Date.now();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      apikey: apiKey,
    },
    body: JSON.stringify({
      message,
      messageId: crypto.randomUUID(),
      sessionId: state.sessionId,
      history: state.history.slice(-10),
      stream: true,
      dialogSlots: {},
    }),
  });
  const raw = await response.text();
  const parsed = parseSse(raw);
  const failures = response.ok ? evaluate(expect, parsed) : [`HTTP ${response.status}`];
  const combined = [parsed.text, parsed.productsMarkdown].filter(Boolean).join('\n\n');
  if (parsed.conversationBoundary?.sessionId) {
    state.sessionId = parsed.conversationBoundary.sessionId;
    state.history = [];
  }
  state.history.push({ role: 'user', content: message }, { role: 'assistant', content: combined });
  return {
    message,
    status: response.status,
    duration_ms: Date.now() - startedAt,
    log_id: parsed.logId,
    diagnostic_error: parsed.diagnosticError,
    products_count: parsed.links.length,
    products: parsed.links,
    text: parsed.text,
    completed: parsed.completed,
    conversation_boundary: parsed.conversationBoundary,
    tool_events: parsed.toolEvents,
    passed: failures.length === 0,
    failures,
  };
}

export async function main() {
  const report = {
    suite_version: suite.schema_version,
    started_at: new Date().toISOString(),
    endpoint,
    cases: [],
  };

  for (const testCase of selected) {
    const repeat = Number.isFinite(repeatOverride) && repeatOverride > 0 ? repeatOverride : testCase.repeat ?? 1;
    const caseResult = { id: testCase.id, title: testCase.title, repeats: [] };
    for (let run = 1; run <= repeat; run++) {
      const state = {
        sessionId: `customer_acceptance_${testCase.id.replace(/[^a-z0-9_-]/gi, '_')}_${Date.now()}_${run}`.slice(0, 120),
        history: [],
      };
      const turns = [];
      for (const turn of testCase.turns) turns.push(await runTurn(turn, state));
      caseResult.repeats.push({ run, session_id: state.sessionId, turns, passed: turns.every((turn) => turn.passed) });
      if (stopOnFailure && !caseResult.repeats.at(-1).passed) break;
    }
    caseResult.passed = caseResult.repeats.every((run) => run.passed);
    report.cases.push(caseResult);
    process.stderr.write(`${testCase.id}: ${caseResult.passed ? 'PASS' : 'FAIL'}\n`);
    if (stopOnFailure && !caseResult.passed) break;
  }

  report.finished_at = new Date().toISOString();
  report.passed = report.cases.every((item) => item.passed);
  const output = minimalOutput
    ? {
        endpoint: report.endpoint,
        passed: report.passed,
        cases: report.cases.map((testCase) => ({
          id: testCase.id,
          passed: testCase.passed,
          repeats: testCase.repeats.map((repeat) => ({
            run: repeat.run,
            passed: repeat.passed,
            duration_ms: repeat.turns.reduce((total, turn) => total + turn.duration_ms, 0),
            products: repeat.turns.flatMap((turn) => turn.products.map((product) => product.title)),
            failures: repeat.turns.flatMap((turn) => turn.failures),
            log_ids: repeat.turns.map((turn) => turn.log_id).filter(Boolean),
          })),
        })),
      }
    : compactOutput
    ? {
        endpoint: report.endpoint,
        passed: report.passed,
        cases: report.cases.map((testCase) => ({
          id: testCase.id,
          passed: testCase.passed,
          repeats: testCase.repeats.map((repeat) => ({
            run: repeat.run,
            passed: repeat.passed,
            turns: repeat.turns.map((turn) => ({
              passed: turn.passed,
              duration_ms: turn.duration_ms,
              log_id: turn.log_id,
              products_count: turn.products_count,
              products: turn.products.map((product) => product.title),
              text: turn.text,
              failures: turn.failures,
              diagnostic_error: turn.diagnostic_error,
              tool_events: turn.tool_events,
            })),
          })),
        })),
      }
    : report;
  if (failuresOnlyOutput) {
    output.cases = output.cases
      .filter((testCase) => !testCase.passed)
      .map((testCase) => ({
        ...testCase,
        repeats: testCase.repeats.filter((repeat) => !repeat.passed),
      }));
  }
  console.log(JSON.stringify(output, null, 2));
  if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
