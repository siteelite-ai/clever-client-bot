import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const casesPath = path.join(here, 'customer-acceptance-cases.json');
const endpoint = 'https://yngoixmvmxdfxokuafjp.supabase.co/functions/v1/chat-consultant-v3';

const widget = fs.readFileSync(path.join(root, 'public/widget.js'), 'utf8');
const apiKey = widget.match(/supabaseKey:\s*'([^']+)'/)?.[1];
if (!apiKey) throw new Error('Public widget key was not found');

const suite = JSON.parse(fs.readFileSync(casesPath, 'utf8'));
const onlyId = process.argv.find((arg) => arg.startsWith('--case='))?.slice('--case='.length);
const repeatOverrideRaw = process.argv.find((arg) => arg.startsWith('--repeat='))?.slice('--repeat='.length);
const repeatOverride = repeatOverrideRaw ? Number(repeatOverrideRaw) : null;
const selected = onlyId ? suite.cases.filter((item) => item.id === onlyId) : suite.cases;
if (selected.length === 0) throw new Error(`Unknown case: ${onlyId}`);

function parseSse(body) {
  let text = '';
  let productsMarkdown = '';
  let logId = null;
  let completed = false;
  let serverProductsCount = null;
  let diagnosticError = null;
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
      productsMarkdown += `${productsMarkdown ? '\n\n' : ''}${event.markdown}`;
    }
    if (event?.type === 'diagnostic') {
      logId = event.log_id || logId;
      diagnosticError = event.error || diagnosticError;
      if (event.phase === 'complete' && typeof event.products_count === 'number') {
        serverProductsCount = event.products_count;
      }
    }
    const delta = parsed.choices?.[0]?.delta?.content;
    if (typeof delta === 'string') text += delta;
  }
  const links = [];
  const re = /- \*\*\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)\*\*/g;
  for (let match; (match = re.exec(productsMarkdown)) !== null;) {
    links.push({ title: match[1], url: match[2] });
  }
  return { text, productsMarkdown, links, logId, completed, serverProductsCount, diagnosticError };
}

function includesAny(haystack, needles) {
  const lower = haystack.toLocaleLowerCase('ru-RU');
  return needles.some((needle) => lower.includes(String(needle).toLocaleLowerCase('ru-RU')));
}

function evaluate(expect = {}, response) {
  const failures = [];
  const productTitles = response.links.map((link) => link.title).join('\n');
  const allOutput = `${response.text}\n${response.productsMarkdown}`;
  if (Number.isFinite(expect.min_products) && response.links.length < expect.min_products) {
    failures.push(`products ${response.links.length} < ${expect.min_products}`);
  }
  if (Number.isFinite(expect.max_products) && response.links.length > expect.max_products) {
    failures.push(`products ${response.links.length} > ${expect.max_products}`);
  }
  for (const phrase of expect.forbid_text ?? []) {
    if (includesAny(allOutput, [phrase])) failures.push(`forbidden text: ${phrase}`);
  }
  for (const phrase of expect.forbid_product_title ?? []) {
    if (includesAny(productTitles, [phrase])) failures.push(`forbidden product title: ${phrase}`);
  }
  if (Array.isArray(expect.require_any_text) && !includesAny(allOutput, expect.require_any_text)) {
    failures.push(`none of required text fragments found: ${expect.require_any_text.join(', ')}`);
  }
  if (Array.isArray(expect.require_product_title) && !includesAny(productTitles, expect.require_product_title)) {
    failures.push(`none of required product-title fragments found: ${expect.require_product_title.join(', ')}`);
  }
  if (!response.completed) failures.push('SSE did not complete');
  if (response.diagnosticError) failures.push(`diagnostic error: ${response.diagnosticError}`);
  const genericFailureText = [
    'Не получилось обработать запрос',
    'Попробуйте переформулировать',
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
    passed: failures.length === 0,
    failures,
  };
}

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
  }
  caseResult.passed = caseResult.repeats.every((run) => run.passed);
  report.cases.push(caseResult);
  process.stderr.write(`${testCase.id}: ${caseResult.passed ? 'PASS' : 'FAIL'}\n`);
}

report.finished_at = new Date().toISOString();
report.passed = report.cases.every((item) => item.passed);
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
