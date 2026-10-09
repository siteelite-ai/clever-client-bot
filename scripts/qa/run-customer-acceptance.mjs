import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
// The Edge Function has a 32 s hard budget. Give its response/body time to arrive,
// but never let one customer turn hold a full-suite run indefinitely.
export const ACCEPTANCE_TURN_TIMEOUT_MS = 55_000;
export const PRODUCT_PAGE_TIMEOUT_MS = 10_000;
const PRODUCT_PAGE_MAX_HTML_BYTES = 2_000_000;
const PRODUCT_PAGE_CONCURRENCY = 6;
const casesFileArg = process.argv.find((arg) => arg.startsWith('--cases-file='))?.slice('--cases-file='.length).trim();
const casesPath = casesFileArg
  ? path.resolve(process.cwd(), casesFileArg)
  : path.join(here, 'customer-acceptance-cases.json');
const variantsFileArg = process.argv.find((arg) => arg.startsWith('--variants-file='))?.slice('--variants-file='.length).trim();
const variantsPath = variantsFileArg ? path.resolve(process.cwd(), variantsFileArg) : null;
export const DEFAULT_ENDPOINT = 'https://yngoixmvmxdfxokuafjp.supabase.co/functions/v1/chat-consultant-v3';

export function resolveEndpoint(argv = process.argv) {
  const argument = argv.find((arg) => arg.startsWith('--endpoint='));
  if (argument === undefined) return DEFAULT_ENDPOINT;
  const raw = argument.slice('--endpoint='.length).trim();
  if (!raw) throw new Error('--endpoint requires a non-empty URL');
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

const suiteBytes = fs.readFileSync(casesPath);
const variantsBytes = variantsPath ? fs.readFileSync(variantsPath) : null;
const suiteSha256 = createHash('sha256').update(suiteBytes).digest('hex');
const variationsSha256 = variantsBytes ? createHash('sha256').update(variantsBytes).digest('hex') : null;
const suite = JSON.parse(suiteBytes.toString('utf8'));
const variationSuite = variantsBytes ? JSON.parse(variantsBytes.toString('utf8')) : null;
const configuredVariants = variationSuite?.variants ?? [];
const onlyIds = process.argv.find((arg) => arg.startsWith('--case='))
  ?.slice('--case='.length)
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const onlyVariantIds = process.argv.find((arg) => arg.startsWith('--variant='))
  ?.slice('--variant='.length)
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const repeatOverrideRaw = process.argv.find((arg) => arg.startsWith('--repeat='))?.slice('--repeat='.length);
const repeatOverride = repeatOverrideRaw ? Number(repeatOverrideRaw) : null;
const compactOutput = process.argv.includes('--compact');
const minimalOutput = process.argv.includes('--minimal');
const failuresOnlyOutput = process.argv.includes('--failures-only');
const stopOnFailure = process.argv.includes('--stop-on-failure');
const strictFullSuite = process.argv.includes('--strict-full-suite');
const reportFileArg = process.argv.find((arg) => arg.startsWith('--report-file='))?.slice('--report-file='.length);
const reportFile = reportFileArg ? path.resolve(root, reportFileArg) : null;
const reportsRoot = path.join(root, 'docs/qa/reports');
if (reportFile && (!reportFile.endsWith('.json') || !reportFile.startsWith(`${reportsRoot}${path.sep}`))) {
  throw new Error('--report-file must be a .json path inside docs/qa/reports');
}
const selected = onlyIds?.length ? suite.cases.filter((item) => onlyIds.includes(item.id)) : suite.cases;
const missingIds = onlyIds?.filter((id) => !selected.some((item) => item.id === id)) ?? [];
if (missingIds.length > 0) throw new Error(`Unknown case: ${missingIds.join(', ')}`);

const knownCaseIds = new Set(suite.cases.map((item) => item.id));
const unknownVariantCases = [...new Set(configuredVariants.map((item) => item.case_id).filter((id) => !knownCaseIds.has(id)))];
if (unknownVariantCases.length > 0) throw new Error(`Unknown variation case: ${unknownVariantCases.join(', ')}`);

// An explicit, versioned inventory is intentionally independent of the JSON
// being tested: deleting a source case or a required September variation must
// not make a shortened run look like complete customer acceptance.
const FULL_SUITE_MANIFESTS = {
  'customer-acceptance-cases.json': {
    sha256: '111e1ca0ffdad1b4865a04e4594b98df1de0ecc71d179f6277aa6083abe4ed74',
    repeat: 3,
    turns: 42,
    ids: `customer-dn027b-analogs customer-chandelier-30m2 customer-household-motion-sensor customer-corn-lamp-jargon customer-automatic-topic-boundary customer-repeat-complete-request-boundary customer-vvg-exact-cheapest customer-vvgng-3x1_5-all customer-gallant-explain-and-show customer-breaker-replacement-under-1000 customer-breaker-filter-cheapest-followup customer-copper-fire-resistant-2x1_5 customer-generator-clean-power customer-poe-outdoor-100m customer-new-household-motion-without-mount customer-new-household-motion-joined-currency customer-new-motion-generic customer-new-chandelier-25m2 customer-new-outdoor-floodlight-warehouse-priority customer-new-heat-shrink-12mm customer-new-heat-shrink-10mm customer-new-gallant-broad-assortment customer-new-gallant-catalog-section-chip customer-new-black-double-sockets customer-new-schneider-breaker-3p-16a customer-new-ups-boiler-250w security-meta-prompt-injection`.split(' '),
  },
  'customer-audit-20260921-cases.json': {
    sha256: '38bd5615c3419f2399eef876a82523bb14e9d1ba725948048bd972e3d8a1bd28',
    repeat: 1,
    turns: 39,
    runs: 54,
    evaluatedTurns: 78,
    ids: `audit-01-vvg-3x1_5-cheapest audit-02-topic-boundary-cable-to-motion-light audit-03-living-room-25m2 audit-04-yard-floodlight-35m2 audit-05-breaker-1p-16a-c-under-1000 audit-06-corn-e14 audit-07-vvg-3x1_5-all audit-08-gx53-lamp-analogs audit-09-breaker-25a-apartment audit-10-pump-cable-7kw audit-11-motor-breaker-3kw audit-12-air-conditioner-cable-3kw audit-13-boiler-breaker-trip audit-14-underground-power-cable audit-15-analog-cctv-outdoor-cable audit-16-warm-e27-lamps audit-17-parking-floodlights audit-18-acti9-c16-analogs audit-19-apartment-breaker-7kw audit-20-vvgng-vs-nym audit-21-floodlight-1000-lumen audit-22-voltage-stabilizer-170v audit-23-welding-extension-30m audit-24-three-phase-motor-on-220v audit-25-black-hidden-sockets-white-followup audit-26-philips-office-cheapest audit-27-house-panel-180m2`.split(' '),
    variationFile: 'customer-audit-20260921-variations.json',
    variationSha256: '59b3554e0958463be979651744df82884110bcf584288eb8b8e1ba7869744ce4',
    variationIds: `word-order-and-cyrillic-size rephrased-independent-task area-unit-and-word-order explicit-installation-height compact-c16 latin-series-with-russian-alias exhaustive-command-first quoted-source-product compact-followup-specification load-before-environment natural-phase-answer selection-question trip-symptom-first ground-wording camera-and-route-wording compact-led-specification geometry-with-punctuation short-pole-followup explicit-single-phase comparison-command spaced-lumen-unit voltage-sag-wording length-before-purpose how-to-question installation-synonym-and-elliptical-color cardinality-before-price panel-planning-wording`.split(' '),
  },
  'notion-legacy-bug-cases.json': {
    sha256: '92d323e84399dce920e10b37575e20c67f71e6e6dfe7851adac3e3000fa7f367',
    repeat: 1,
    repeatById: {
      'bt925-corn-e27': 3,
      'bt922-breaker-replacement-under-1000': 3,
    },
    turns: 31,
    runs: 34,
    evaluatedTurns: 35,
    defaultTurnsPerCase: 1,
    turnsById: { 'bt924-acti9-followup-show': 2 },
    ids: `bt929-pump-cable-clarification bt929-outdoor-floodlight-clarification bt929-motor-breaker-clarification bt929-underground-cable-clarification bt929-heat-shrink-12mm bt929-lugs-35mm-clarification bt929-surveillance-cable-clarification bt929-warm-led-clarification bt929-parking-floodlight-clarification bt928-living-room-25m2 bt928-boiler-breaker-diagnostic bt927-copper-fire-resistant-2x1_5 bt927-led-floodlights-100w bt925-corn-e27 bt924-dn027b-analogs bt924-gx53-analogs bt924-apartment-breaker-25a bt924-schneider-cheaper-analogs bt924-replace-kg-cable bt924-conditioner-3kw bt924-acti9-followup-show bt923-battery-unit bt923-vvg-3x1_5-unit bt922-breaker-replacement-under-1000 bt821-dku-100w-replacement bt821-stabilizer-analogs bt746-extension-50m bt746-white-extension-3-sockets bt746-black-double-socket bt746-garmoniya-sockets`.split(' '),
  },
  'systemic-cardinality-cases.json': {
    sha256: 'b5583b3380c3e17680cb7f2e85407e301e7650754a879b098bc6bf2103c8a5b0',
    repeat: 3,
    turns: 5,
    runs: 15,
    evaluatedTurns: 15,
    defaultTurnsPerCase: 1,
    ids: `cardinality-multiple-sockets cardinality-multiple-breakers cardinality-multiple-extension-cords cardinality-single-superlative cardinality-plural-superlative`.split(' '),
  },
};

export function validateStrictFullSuite({ argv, suite, variationSuite, casesPath, variantsPath, suiteBytes, variantsBytes }) {
  if (!argv.includes('--strict-full-suite')) return null;
  if (!argv.some((arg) => arg.startsWith('--endpoint=') && arg.slice('--endpoint='.length).trim())) {
    throw new Error('--strict-full-suite requires an explicit --endpoint= URL; production is never an implicit target');
  }
  for (const flag of ['--case=', '--variant=', '--repeat=', '--stop-on-failure']) {
    if (argv.some((arg) => arg === flag || arg.startsWith(flag))) {
      throw new Error(`--strict-full-suite forbids ${flag} (a filtered or shortened run is not complete)`);
    }
  }
  const name = path.basename(casesPath);
  const manifest = FULL_SUITE_MANIFESTS[name];
  if (!manifest) throw new Error(`--strict-full-suite has no inventory for ${name}`);
  const actualSuiteHash = suiteBytes && createHash('sha256').update(suiteBytes).digest('hex');
  if (actualSuiteHash !== manifest.sha256) {
    throw new Error(`--strict-full-suite ${name} SHA256 mismatch: expected ${manifest.sha256}, actual ${actualSuiteHash ?? 'missing bytes'}`);
  }
  const ids = suite.cases?.map((item) => item.id) ?? [];
  const expected = new Set(manifest.ids);
  const actual = new Set(ids);
  const missing = manifest.ids.filter((id) => !actual.has(id));
  const unexpected = ids.filter((id) => !expected.has(id));
  if (ids.length !== manifest.ids.length || actual.size !== ids.length || missing.length || unexpected.length) {
    throw new Error(`Incomplete ${name}: expected ${manifest.ids.length} unique IDs; missing=${missing.join(',') || '-'} unexpected=${unexpected.join(',') || '-'} actual=${ids.length}`);
  }
  const turns = suite.cases.reduce((total, item) => total + (item.turns?.length ?? 0), 0);
  const invalidTurns = suite.cases.filter((item) =>
    !Array.isArray(item.turns) || item.turns.length === 0 ||
    (manifest.defaultTurnsPerCase !== undefined && item.turns.length !== (manifest.turnsById?.[item.id] ?? manifest.defaultTurnsPerCase))
  );
  const invalidRepeats = suite.cases.filter((item) => (item.repeat ?? 1) !== (manifest.repeatById?.[item.id] ?? manifest.repeat));
  let expectedRuns = suite.cases.reduce((total, item) => total + (manifest.repeatById?.[item.id] ?? manifest.repeat), 0);
  let expectedEvaluatedTurns = suite.cases.reduce((total, item) => total + (item.turns?.length ?? 0) * (manifest.repeatById?.[item.id] ?? manifest.repeat), 0);
  if (
    turns !== manifest.turns || invalidTurns.length || invalidRepeats.length
  ) {
    throw new Error(`Incomplete ${name}: expected ${manifest.turns} source turns, ${manifest.runs ?? expectedRuns} runs and ${manifest.evaluatedTurns ?? expectedEvaluatedTurns} evaluated turns; invalid turns=${invalidTurns.map((item) => item.id).join(',') || '-'} invalid repeats=${invalidRepeats.map((item) => item.id).join(',') || '-'}`);
  }
  if (manifest.variationFile) {
    if (path.basename(variantsPath ?? '') !== manifest.variationFile || variationSuite?.source_suite !== name) {
      throw new Error(`--strict-full-suite requires ${manifest.variationFile} linked to ${name}`);
    }
    const actualVariationHash = variantsBytes && createHash('sha256').update(variantsBytes).digest('hex');
    if (actualVariationHash !== manifest.variationSha256) {
      throw new Error(`--strict-full-suite ${manifest.variationFile} SHA256 mismatch: expected ${manifest.variationSha256}, actual ${actualVariationHash ?? 'missing bytes'}`);
    }
    const variants = variationSuite.variants ?? [];
    const variantIds = variants.map((item) => item.id);
    const expectedVariants = new Set(manifest.variationIds);
    const missingVariants = manifest.variationIds.filter((id) => !variantIds.includes(id));
    const unexpectedVariants = variantIds.filter((id) => !expectedVariants.has(id));
    if (variants.length !== manifest.variationIds.length || new Set(variantIds).size !== variants.length || missingVariants.length || unexpectedVariants.length) {
      throw new Error(`Incomplete ${manifest.variationFile}: expected ${manifest.variationIds.length} unique variations; missing=${missingVariants.join(',') || '-'} unexpected=${unexpectedVariants.join(',') || '-'}`);
    }
    for (let index = 0; index < manifest.ids.length; index++) {
      const expectedCaseId = manifest.ids[index];
      const expectedVariantId = manifest.variationIds[index];
      const match = variants.find((item) => item.id === expectedVariantId);
      if (match?.case_id !== expectedCaseId) {
        throw new Error(`Required variation ${expectedVariantId} must cover ${expectedCaseId}`);
      }
      resolveCaseExecutions(suite.cases.find((item) => item.id === expectedCaseId), variants);
    }
    expectedRuns += variants.reduce((total, item) => total + (manifest.repeatById?.[item.case_id] ?? manifest.repeat), 0);
    expectedEvaluatedTurns += variants.reduce((total, item) => total + (
      suite.cases.find((testCase) => testCase.id === item.case_id)?.turns.length ?? 0
    ) * (manifest.repeatById?.[item.case_id] ?? manifest.repeat), 0);
  } else if (variantsPath) {
    throw new Error(`--strict-full-suite does not allow an unregistered variation file for ${name}`);
  }
  if (
    (manifest.runs !== undefined && expectedRuns !== manifest.runs) ||
    (manifest.evaluatedTurns !== undefined && expectedEvaluatedTurns !== manifest.evaluatedTurns)
  ) {
    throw new Error(`Incomplete ${name}: expected ${manifest.runs} runs/${manifest.evaluatedTurns} turns, got ${expectedRuns}/${expectedEvaluatedTurns}`);
  }
  return {
    name,
    expected_cases: manifest.ids.length,
    expected_turns_per_base_suite: manifest.turns,
    expected_repeat: manifest.repeat,
    expected_runs: expectedRuns,
    expected_evaluated_turns: expectedEvaluatedTurns,
  };
}

export function resolveCaseExecutions(testCase, variants = []) {
  const executions = [{ id: 'base', messages: testCase.turns.map((turn) => turn.message) }];
  const relevant = variants.filter((item) => item.case_id === testCase.id);
  const seen = new Set(['base']);
  for (const variant of relevant) {
    if (typeof variant.id !== 'string' || !variant.id.trim() || seen.has(variant.id)) {
      throw new Error(`${testCase.id}: variation ids must be non-empty and unique`);
    }
    if (!Array.isArray(variant.messages) || variant.messages.length !== testCase.turns.length) {
      throw new Error(`${testCase.id}/${variant.id}: variation must provide one message per turn`);
    }
    if (variant.messages.some((message) => typeof message !== 'string' || !message.trim())) {
      throw new Error(`${testCase.id}/${variant.id}: variation messages must be non-empty strings`);
    }
    if (
      variant.expect_overrides !== undefined &&
      (!Array.isArray(variant.expect_overrides) || variant.expect_overrides.length !== testCase.turns.length ||
        variant.expect_overrides.some((value) => value !== null && (typeof value !== 'object' || Array.isArray(value))))
    ) {
      throw new Error(`${testCase.id}/${variant.id}: expect_overrides must provide one object or null per turn`);
    }
    seen.add(variant.id);
    executions.push({
      id: variant.id,
      messages: variant.messages,
      ...(variant.expect_overrides ? { expect_overrides: variant.expect_overrides } : {}),
    });
  }
  return executions;
}

export function selectCaseExecutions(testCase, variants = [], selectedVariantIds = null) {
  const executions = resolveCaseExecutions(testCase, variants);
  if (!selectedVariantIds?.length) return executions;
  const selectedExecutions = executions.filter((execution) => selectedVariantIds.includes(execution.id));
  const missing = selectedVariantIds.filter((id) => !executions.some((execution) => execution.id === id));
  if (missing.length > 0) throw new Error(`${testCase.id}: unknown variation ${missing.join(', ')}`);
  return selectedExecutions;
}

export function resolveExpectations(defaults = {}, expect = {}) {
  return { ...defaults, ...expect };
}

const strictManifest = validateStrictFullSuite({
  argv: process.argv,
  suite,
  variationSuite,
  casesPath,
  variantsPath,
  suiteBytes,
  variantsBytes,
});
if (repeatOverrideRaw !== undefined && (!Number.isSafeInteger(repeatOverride) || repeatOverride <= 0)) {
  throw new Error('--repeat must be a positive integer');
}

const runPlan = selected.map((testCase) => ({
  testCase,
  repeat: repeatOverride ?? testCase.repeat ?? 1,
  executions: selectCaseExecutions(testCase, configuredVariants, onlyVariantIds),
}));
const plannedRuns = runPlan.reduce((total, item) => total + item.executions.length * item.repeat, 0);
const plannedTurns = runPlan.reduce((total, item) => total + item.executions.length * item.repeat * item.testCase.turns.length, 0);
// Repetitions and related customer suites often return the same SKU URLs.
// Store one bounded verification promise per canonical URL for the process.
const productPageCache = new Map();

export function parseSse(body) {
  let text = '';
  let textBeforeProducts = '';
  let productsMarkdown = '';
  let productsStarted = false;
  let logId = null;
  let completed = false;
  let terminalDiagnosticSeen = false;
  let serverProductsCount = null;
  let diagnosticError = null;
  let conversationBoundary = null;
  let dialogSlots = null;
  let selectionContract = null;
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
      if (event.selection_contract && typeof event.selection_contract === 'object') {
        selectionContract = event.selection_contract;
      }
    }
    if (event?.type === 'diagnostic') {
      logId = event.log_id || logId;
      diagnosticError = event.error || diagnosticError;
      if (event.phase === 'complete' && typeof event.products_count === 'number') {
        terminalDiagnosticSeen = true;
        serverProductsCount = event.products_count;
      }
    }
    if (event?.type === 'conversation_boundary' && event.mode === 'new_task' && typeof event.session_id === 'string') {
      conversationBoundary = { mode: event.mode, sessionId: event.session_id };
    }
    if (event?.type === 'slot_update' && event.slots && typeof event.slots === 'object' && !Array.isArray(event.slots)) {
      dialogSlots = event.slots;
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
      cardText: block,
    });
  }
  return { text, textBeforeProducts, productsMarkdown, links, logId, completed, terminalDiagnosticSeen, serverProductsCount, diagnosticError, conversationBoundary, dialogSlots, selectionContract, toolEvents };
}

function includesAny(haystack, needles) {
  const normalize = (value) => String(value).toLocaleLowerCase('ru-RU').replaceAll('ё', 'е');
  const lower = normalize(haystack);
  return needles.some((needle) => lower.includes(normalize(needle)));
}

function sameSourceLabel(left, right) {
  const normalize = (value) => String(value).toLocaleLowerCase('ru-RU')
    .replaceAll('ё', 'е').replace(/[:\s]+/gu, ' ').trim();
  return normalize(left) === normalize(right);
}

function sourceRuleFailures(rule, actual, location) {
  const failures = [];
  if (!actual) return [`${location}: source field is missing`];
  if (Array.isArray(rule.require_any) && rule.require_any.length > 0 && !includesAny(actual, rule.require_any)) {
    failures.push(`${location}: source does not contain any of ${rule.require_any.join(', ')}`);
  }
  if (Array.isArray(rule.exact_any) && rule.exact_any.length > 0 &&
      !rule.exact_any.some((value) => sameSourceLabel(actual, value))) {
    failures.push(`${location}: source value ${actual} is not one of ${rule.exact_any.join(', ')}`);
  }
  if (Array.isArray(rule.forbid_any)) {
    for (const value of rule.forbid_any) {
      if (includesAny(actual, [value])) failures.push(`${location}: forbidden source fragment ${value}`);
    }
  }
  if (Number.isFinite(rule.min_numeric) || Number.isFinite(rule.greater_than) || Number.isFinite(rule.less_than)) {
    const measured = Number(String(actual).match(/-?\d+(?:[.,]\d+)?/u)?.[0]?.replace(',', '.'));
    if (Number.isFinite(rule.min_numeric) && (!Number.isFinite(measured) || measured < rule.min_numeric)) {
      failures.push(`${location}: source numeric value ${actual} < ${rule.min_numeric}`);
    }
    if (Number.isFinite(rule.greater_than) && (!Number.isFinite(measured) || measured <= rule.greater_than)) {
      failures.push(`${location}: source numeric value ${actual} is not > ${rule.greater_than}`);
    }
    if (Number.isFinite(rule.less_than) && (!Number.isFinite(measured) || measured >= rule.less_than)) {
      failures.push(`${location}: source numeric value ${actual} is not < ${rule.less_than}`);
    }
  }
  return failures;
}

function validSourceRule(rule) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return false;
  if (rule.min_numeric !== undefined && !Number.isFinite(rule.min_numeric)) return false;
  if (rule.greater_than !== undefined && !Number.isFinite(rule.greater_than)) return false;
  if (rule.less_than !== undefined && !Number.isFinite(rule.less_than)) return false;
  const groups = [rule.require_any, rule.forbid_any, rule.exact_any].filter((group) => group !== undefined);
  return (groups.length > 0 || Number.isFinite(rule.min_numeric) ||
    Number.isFinite(rule.greater_than) || Number.isFinite(rule.less_than)) && groups.every((group) =>
    Array.isArray(group) && group.length > 0 &&
    group.every((value) => typeof value === 'string' && value.trim())
  );
}

function validProductPageRules(rules) {
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) return false;
  const facets = rules.facets ?? [];
  if (!Array.isArray(facets) || facets.some((rule) =>
    typeof rule?.name !== 'string' || !rule.name.trim() || !validSourceRule(rule)
  )) return false;
  if (rules.description !== undefined && !validSourceRule(rules.description)) return false;
  if (rules.name !== undefined && !validSourceRule(rules.name)) return false;
  for (const operator of ['all_of', 'any_of']) {
    if (rules[operator] !== undefined &&
        (!Array.isArray(rules[operator]) || rules[operator].length === 0 ||
          rules[operator].some((branch) => !validProductPageRules(branch)))) return false;
  }
  return facets.length > 0 || rules.description !== undefined || rules.name !== undefined ||
    rules.all_of !== undefined || rules.any_of !== undefined;
}

function productPageRuleFailures(rules, proof) {
  const failures = [];
  for (const facetRule of rules.facets ?? []) {
    const field = Object.entries(proof.facets ?? {})
      .find(([name]) => sameSourceLabel(name, facetRule.name));
    failures.push(...sourceRuleFailures(
      facetRule,
      field?.[1] ?? '',
      `product ${proof.sku} facet ${facetRule.name}`,
    ));
  }
  if (rules.description) {
    failures.push(...sourceRuleFailures(
      rules.description,
      proof.description,
      `product ${proof.sku} description`,
    ));
  }
  if (rules.name) {
    failures.push(...sourceRuleFailures(
      rules.name,
      proof.name,
      `product ${proof.sku} name`,
    ));
  }
  for (const branch of rules.all_of ?? []) {
    failures.push(...productPageRuleFailures(branch, proof));
  }
  if (rules.any_of) {
    const alternatives = rules.any_of.map((branch) => productPageRuleFailures(branch, proof));
    if (alternatives.every((branchFailures) => branchFailures.length > 0)) {
      failures.push(`product ${proof.sku}: no source-backed alternative matched: ${alternatives.map((branchFailures) => branchFailures.join('; ')).join(' | ')}`);
    }
  }
  return failures;
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

export function productUrlIdentity(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
  try {
    const url = new URL(rawUrl);
    const rawSegments = url.pathname.split('/').filter(Boolean);
    if (
      url.protocol !== 'https:' ||
      !['220volt.kz', 'www.220volt.kz'].includes(url.hostname.toLowerCase()) ||
      url.username || url.password || url.port ||
      rawSegments[0]?.toLowerCase() !== 'catalog' || rawSegments.length < 4 ||
      rawSegments.some((segment) => !segment || /%2f|%5c/iu.test(segment))
    ) return null;
    // URL shape is only a candidate identity. A nested category can have the
    // exact same shape, so strict acceptance also verifies the live Product
    // JSON-LD and SKU at this URL before counting it as a product.
    // Tracking parameters, fragments, www and a trailing slash do not create
    // another SKU. The canonical path remains the evidence identity.
    const pathname = decodeURIComponent(url.pathname).normalize('NFC').replace(/\/+$/u, '').toLowerCase();
    return `220volt.kz${pathname}`;
  } catch {
    return null;
  }
}

function productNodes(json) {
  if (Array.isArray(json)) return json.flatMap(productNodes);
  if (!json || typeof json !== 'object') return [];
  const nested = Array.isArray(json['@graph']) ? json['@graph'].flatMap(productNodes) : [];
  const types = Array.isArray(json['@type']) ? json['@type'] : [json['@type']];
  return types.some((type) => typeof type === 'string' && /(?:^|\/)Product$/iu.test(type))
    ? [json, ...nested]
    : nested;
}

export function productProofFromHtml(html, requestedIdentity) {
  if (typeof html !== 'string' || !requestedIdentity) return null;
  const dom = new JSDOM(html);
  try {
    const document = dom.window.document;
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      let parsed;
      try { parsed = JSON.parse(script.textContent ?? ''); } catch { continue; }
      for (const product of productNodes(parsed)) {
        const sku = typeof product.sku === 'number' && Number.isFinite(product.sku)
          ? String(product.sku)
          : product.sku;
        if (
          productUrlIdentity(product['@id']) !== requestedIdentity ||
          typeof product.name !== 'string' || product.name.trim().length < 3 ||
          typeof sku !== 'string' || !sku.trim() || sku.trim() === '0'
        ) continue;
        // These are the product's own detail fields, not the category's
        // ItemList or related-product carousel. A facet may be inaccurate,
        // so a requested motion trigger can demand independent prose proof.
        const facets = {};
        for (const item of document.querySelectorAll('.product__tab-description-item')) {
          const label = item.querySelector('.product__description-title')?.textContent?.replace(/:\s*$/u, '').trim();
          const value = item.querySelector('.product__tab-description-text')?.textContent?.replace(/\s+/gu, ' ').trim();
          if (label && value) facets[label] = value;
        }
        const description = document
          .querySelector('.product-item__tab-content[data-tab-content="description"]')
          ?.textContent?.replace(/\s+/gu, ' ').trim() ?? '';
        const offers = Array.isArray(product.offers) ? product.offers : [product.offers];
        const offer = offers.find((entry) => entry && typeof entry === 'object' &&
          entry.priceCurrency === 'KZT' && Number.isFinite(Number(entry.price)) && Number(entry.price) > 0);
        return {
          sku: sku.trim(), name: product.name.trim(), facets, description,
          offerPrice: offer ? Number(offer.price) : null,
          availability: typeof offer?.availability === 'string' ? offer.availability : null,
        };
      }
    }
    return null;
  } finally {
    dom.window.close();
  }
}

export async function verifyProductPage(rawUrl, {
  fetchImpl = fetch,
  timeoutMs = PRODUCT_PAGE_TIMEOUT_MS,
} = {}) {
  const identity = productUrlIdentity(rawUrl);
  if (!identity) return { identity: null, verified: false, reason: 'invalid 220volt.kz catalog URL' };
  const parsed = new URL(rawUrl);
  const fetchUrl = `https://220volt.kz${parsed.pathname}`;
  const controller = new AbortController();
  let timer;
  try {
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`product page exceeded ${timeoutMs}ms deadline`));
      }, timeoutMs);
    });
    const request = (async () => {
      // Do not follow a redirect to another origin (or a category landing
      // page). Product URLs on 220volt.kz currently return a direct 200.
      const response = await fetchImpl(fetchUrl, {
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        headers: { Accept: 'text/html' },
        signal: controller.signal,
      });
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      if (!/^text\/html(?:\s*;|$)/iu.test(response.headers?.get('content-type') ?? '')) {
        throw new Error('response is not HTML');
      }
      const contentLength = Number(response.headers?.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > PRODUCT_PAGE_MAX_HTML_BYTES) {
        throw new Error('product page exceeds HTML size limit');
      }
      const html = await response.text();
      if (Buffer.byteLength(html) > PRODUCT_PAGE_MAX_HTML_BYTES) {
        throw new Error('product page exceeds HTML size limit');
      }
      const proof = productProofFromHtml(html, identity);
      if (!proof) throw new Error('matching JSON-LD Product/@id/name/sku not found');
      return { identity, verified: true, ...proof };
    })();
    return await Promise.race([request, deadline]);
  } catch (error) {
    return { identity, verified: false, reason: String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyProductLinks(links = [], {
  fetchImpl = fetch,
  cache = new Map(),
  timeoutMs = PRODUCT_PAGE_TIMEOUT_MS,
} = {}) {
  const urls = new Map();
  for (const link of links) {
    const identity = productUrlIdentity(link.url);
    if (identity && !urls.has(identity)) urls.set(identity, link.url);
  }
  const entries = [...urls];
  const verified = new Map();
  for (let start = 0; start < entries.length; start += PRODUCT_PAGE_CONCURRENCY) {
    const batch = entries.slice(start, start + PRODUCT_PAGE_CONCURRENCY);
    const results = await Promise.all(batch.map(async ([identity, url]) => {
      if (!cache.has(identity)) cache.set(identity, verifyProductPage(url, { fetchImpl, timeoutMs }));
      return [identity, await cache.get(identity)];
    }));
    for (const [identity, result] of results) verified.set(identity, result);
  }
  return verified;
}

export function productLinkEvidence(links = [], { verifiedPages = null, requireVerifiedPages = false } = {}) {
  const seen = new Set();
  const duplicates = [];
  const invalid = [];
  const unverified = [];
  let uniqueCount = 0;
  for (const link of links) {
    // Synthetic unit-test cards sometimes omit a URL. Real parsed cards never do.
    if (link.url === undefined) {
      if (requireVerifiedPages) unverified.push('(missing URL)');
      else uniqueCount++;
      continue;
    }
    const identity = productUrlIdentity(link.url);
    if (!identity) {
      invalid.push(link.url);
      continue;
    }
    if (seen.has(identity)) duplicates.push(link.url);
    else if (requireVerifiedPages && verifiedPages?.get(identity)?.verified !== true) {
      seen.add(identity);
      const reason = verifiedPages?.get(identity)?.reason ?? 'not checked';
      unverified.push(`${link.url} (${reason})`);
    } else {
      seen.add(identity);
      uniqueCount++;
    }
  }
  return { uniqueCount, duplicates, invalid, unverified };
}

function nameTokenRecall(displayed, source) {
  const words = (value) => String(value ?? '').toLocaleLowerCase('ru-RU').replaceAll('ё', 'е')
    .match(/[\p{L}\p{N}]+/gu)?.filter((part) => part.length > 1) ?? [];
  const displayedWords = new Set(words(displayed));
  const sourceWords = new Set(words(source));
  if (displayedWords.size < 2) return 0;
  let shared = 0;
  for (const word of displayedWords) if (sourceWords.has(word)) shared++;
  return shared / displayedWords.size;
}

export function evaluate(expect = {}, response, { requireVerifiedPages = false, previousVerifiedSkus = new Set() } = {}) {
  const failures = [];
  const requireSourceProof = Boolean(expect.require_every_product_page);
  const linkEvidence = productLinkEvidence(response.links, {
    verifiedPages: response.verifiedProductPages,
    requireVerifiedPages: requireVerifiedPages || requireSourceProof,
  });
  const productTitles = response.links.map((link) => link.title).join('\n');
  const allOutput = `${response.text}\n${response.productsMarkdown}`;
  if (linkEvidence.invalid.length > 0) {
    failures.push(`invalid 220volt.kz product URL(s): ${linkEvidence.invalid.join(' | ')}`);
  }
  if (linkEvidence.duplicates.length > 0) {
    failures.push(`duplicate product URL(s): ${linkEvidence.duplicates.join(' | ')}`);
  }
  if (linkEvidence.unverified.length > 0) {
    failures.push(`unverified product page(s): ${linkEvidence.unverified.join(' | ')}`);
  }
  if (expect.require_new_product_skus === true) {
    for (const link of response.links) {
      const proof = response.verifiedProductPages?.get(productUrlIdentity(link.url));
      if (proof?.verified && previousVerifiedSkus.has(proof.sku)) {
        failures.push(`previously shown SKU repeated as a new alternative: ${proof.sku}`);
      }
    }
  }
  if (requireVerifiedPages) {
    const seenSkus = new Set();
    for (const link of response.links) {
      const proof = response.verifiedProductPages?.get(productUrlIdentity(link.url));
      if (!proof?.verified) continue;
      if (seenSkus.has(proof.sku)) failures.push(`duplicate verified SKU: ${proof.sku}`);
      seenSkus.add(proof.sku);
      if (nameTokenRecall(link.title, proof.name) < 0.6) {
        failures.push(`rendered product name disagrees with source SKU ${proof.sku}`);
      }
      if (!Number.isFinite(link.price) || !Number.isFinite(proof.offerPrice) ||
          Math.abs(link.price - proof.offerPrice) > 0.51) {
        failures.push(`rendered price disagrees with source SKU ${proof.sku}: ${link.price} vs ${proof.offerPrice}`);
      }
      if (!/\/InStock$/iu.test(proof.availability ?? '')) {
        failures.push(`source SKU ${proof.sku} is not confirmed in stock`);
      }
      if (!link.stockLine) failures.push(`rendered stock is missing for source SKU ${proof.sku}`);
    }
    if (!response.terminalDiagnosticSeen) failures.push('terminal diagnostic is missing');
    if (!response.logId) failures.push('request log ID is missing');
  }
  if (requireSourceProof) {
    const rules = expect.require_every_product_page;
    if (!validProductPageRules(rules)) {
      failures.push('invalid product-page source evidence contract');
    } else {
      for (const link of response.links) {
        const proof = response.verifiedProductPages?.get(productUrlIdentity(link.url));
        if (!proof?.verified) continue; // The unverified-page failure above is authoritative.
        failures.push(...productPageRuleFailures(rules, proof));
      }
    }
  }
  if (expect.conversation_boundary === 'new_task' && response.conversationBoundary?.mode !== 'new_task') {
    failures.push('expected automatic new_task conversation boundary');
  }
  if (expect.conversation_boundary === 'continuation' && response.conversationBoundary) {
    failures.push(`unexpected conversation boundary: ${response.conversationBoundary.mode}`);
  }
  if (Number.isFinite(expect.min_products) && linkEvidence.uniqueCount < expect.min_products) {
    failures.push(`products ${linkEvidence.uniqueCount} < ${expect.min_products}`);
  }
  if (Number.isFinite(expect.max_products) && linkEvidence.uniqueCount > expect.max_products) {
    failures.push(`products ${linkEvidence.uniqueCount} > ${expect.max_products}`);
  }
  if (expect.require_products_or_text_groups && typeof expect.require_products_or_text_groups === 'object') {
    const contract = expect.require_products_or_text_groups;
    if (
      !Number.isSafeInteger(contract.min_products) || contract.min_products <= 0 ||
      !Array.isArray(contract.text_groups) || !contract.text_groups.length
    ) {
      failures.push('invalid products-or-explicit-gap contract');
    } else if (
      linkEvidence.uniqueCount < contract.min_products &&
      !matchesEveryGroup(response.text, contract.text_groups)
    ) {
      failures.push(`products ${linkEvidence.uniqueCount} < ${contract.min_products} without an explicit evidence gap`);
    }
  }
  if (Array.isArray(expect.require_product_groups_or_gap)) {
    for (const contract of expect.require_product_groups_or_gap) {
      const matchedProduct = Array.isArray(contract?.title_groups) && contract.title_groups.length > 0 && response.links.some((link) =>
        matchesEveryGroup(link.title, contract.title_groups)
      );
      const explicitGap = Array.isArray(contract?.gap_text_groups) && contract.gap_text_groups.length > 0 &&
        matchesEveryGroup(response.text, contract.gap_text_groups);
      if (!matchedProduct && !explicitGap) {
        failures.push(`missing product class or explicit gap: ${JSON.stringify(contract?.title_groups ?? [])}`);
      }
    }
  }
  if (Number.isFinite(expect.max_duration_ms) && Number.isFinite(response.durationMs) && response.durationMs > expect.max_duration_ms) {
    failures.push(`duration ${response.durationMs}ms > ${expect.max_duration_ms}ms`);
  }
  for (const phrase of expect.forbid_text ?? []) {
    if (includesAny(allOutput, [phrase])) failures.push(`forbidden text: ${phrase}`);
  }
  for (const phrase of expect.forbid_assistant_text ?? []) {
    if (includesAny(response.text, [phrase])) failures.push(`forbidden assistant text: ${phrase}`);
  }
  for (const phrase of expect.forbid_tool_summary ?? []) {
    if ((response.toolEvents ?? []).some((event) => includesAny(event.summary ?? '', [phrase]))) {
      failures.push(`forbidden tool summary: ${phrase}`);
    }
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
  if (Array.isArray(expect.require_every_product_card_groups)) {
    const invalidCards = response.links
      .filter((link) => !matchesEveryGroup(link.cardText ?? link.title, expect.require_every_product_card_groups))
      .map((link) => link.title);
    if (invalidCards.length > 0) failures.push(`product cards violate required groups: ${invalidCards.join(' | ')}`);
  }
  if (Array.isArray(expect.require_selection_criteria_groups)) {
    const criteriaText = JSON.stringify(response.selectionContract ?? {});
    if (!matchesEveryGroup(criteriaText, expect.require_selection_criteria_groups)) {
      failures.push(`selection contract misses required groups: ${expect.require_selection_criteria_groups.map((group) => `[${group.join(', ')}]`).join(' ')}`);
    }
  }
  if (Array.isArray(expect.forbid_selection_criteria_any)) {
    const criteriaText = JSON.stringify(response.selectionContract ?? {});
    for (const phrase of expect.forbid_selection_criteria_any) {
      if (includesAny(criteriaText, [phrase])) failures.push(`forbidden selection criterion: ${phrase}`);
    }
  }
  if (expect.require_selection_criteria_evidence === true && response.links.length > 0) {
    const criteria = response.selectionContract?.mandatory_criteria;
    if (!Array.isArray(criteria)) {
      failures.push('rendered products have no machine-readable selection contract');
    } else {
      const invalid = criteria.filter((criterion) =>
        !['user_explicit', 'derived_required'].includes(criterion?.evidence)
      );
      if (invalid.length > 0) {
        failures.push(`mandatory selection criteria have invalid evidence: ${invalid.map((criterion) =>
          `${criterion?.key ?? 'unknown'}=${criterion?.evidence ?? 'missing'}`
        ).join(' | ')}`);
      }
    }
  }
  if (expect.require_result_cardinality && typeof expect.require_result_cardinality === 'object') {
    const actual = response.selectionContract?.result_cardinality;
    if (!actual || typeof actual !== 'object') {
      failures.push('rendered products have no machine-readable result cardinality contract');
    } else {
      for (const key of ['target', 'minimum', 'mode', 'explicit']) {
        if (key in expect.require_result_cardinality && actual[key] !== expect.require_result_cardinality[key]) {
          failures.push(`result cardinality ${key}=${JSON.stringify(actual[key])} != ${JSON.stringify(expect.require_result_cardinality[key])}`);
        }
      }
    }
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

const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function isTransientNetworkError(error) {
  const code = error?.code ?? error?.cause?.code;
  return TRANSIENT_NETWORK_CODES.has(code) || /(?:terminated|fetch failed|socket|timeout)/iu.test(String(error?.message ?? ''));
}

export async function fetchAcceptanceTurn(payload, {
  fetchImpl = fetch,
  maxAttempts = 2,
  retryDelayMs = 500,
  timeoutMs = ACCEPTANCE_TURN_TIMEOUT_MS,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be a positive integer');
  const controller = new AbortController();
  let lastError;
  let attempts = 0;
  const timeoutError = () => Object.assign(
    new Error(`Acceptance turn exceeded ${timeoutMs}ms network deadline`),
    { code: 'ACCEPTANCE_TURN_TIMEOUT', attempts },
  );
  let deadlineTimer;
  const deadline = new Promise((_, reject) => {
    deadlineTimer = setTimeout(() => {
      controller.abort();
      reject(timeoutError());
    }, timeoutMs);
  });
  const request = async () => {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      attempts = attempt;
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            apikey: apiKey,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        const raw = await response.text();
        if (controller.signal.aborted) throw timeoutError();
        return { response, raw, attempts: attempt };
      } catch (error) {
        lastError = error;
        if (controller.signal.aborted) throw timeoutError();
        if (attempt >= maxAttempts || !isTransientNetworkError(error)) {
          error.attempts = attempt;
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
      }
    }
    throw lastError;
  };
  try {
    // AbortSignal controls native fetch; Promise.race also bounds a custom
    // fetch/body reader that ignores abort, so CI always emits a result.
    return await Promise.race([request(), deadline]);
  } finally {
    clearTimeout(deadlineTimer);
  }
}

async function runTurn({ message, expect }, state) {
  const startedAt = Date.now();
  const payload = {
    message,
    messageId: crypto.randomUUID(),
    sessionId: state.sessionId,
    history: state.history.slice(-10),
    stream: true,
    dialogSlots: state.dialogSlots,
  };
  let fetched;
  try {
    fetched = await fetchAcceptanceTurn(payload, {
      maxAttempts: 2,
      retryDelayMs: 500,
    });
  } catch (error) {
    const timedOut = error?.code === 'ACCEPTANCE_TURN_TIMEOUT';
    const failure = timedOut
      ? `network deadline exceeded (${ACCEPTANCE_TURN_TIMEOUT_MS}ms)`
      : `network error: ${String(error?.message ?? error)}`;
    return {
      message,
      status: null,
      duration_ms: Date.now() - startedAt,
      network_attempts: error?.attempts ?? null,
      log_id: null,
      diagnostic_error: failure,
      products_count: 0,
      unique_products_count: 0,
      products: [],
      text: '',
      completed: false,
      conversation_boundary: null,
      selection_contract: null,
      tool_events: [],
      passed: false,
      failures: [failure],
    };
  }
  const { response, raw, attempts } = fetched;
  const parsed = parseSse(raw);
  parsed.durationMs = Date.now() - startedAt;
  const requiresLiveProductProof = strictFullSuite || Boolean(expect.require_every_product_page) ||
    expect.require_new_product_skus === true;
  parsed.verifiedProductPages = response.ok && requiresLiveProductProof
    ? await verifyProductLinks(parsed.links, { cache: productPageCache })
    : null;
  const linkEvidence = productLinkEvidence(parsed.links, {
    verifiedPages: parsed.verifiedProductPages,
    requireVerifiedPages: requiresLiveProductProof,
  });
  const failures = response.ok
    ? evaluate(expect, parsed, {
        requireVerifiedPages: requiresLiveProductProof,
        previousVerifiedSkus: state.previousVerifiedSkus,
      })
    : [`HTTP ${response.status}`];
  const combined = [parsed.text, parsed.productsMarkdown].filter(Boolean).join('\n\n');
  if (parsed.conversationBoundary?.sessionId) {
    state.sessionId = parsed.conversationBoundary.sessionId;
    state.history = [];
    state.dialogSlots = {};
    state.previousVerifiedSkus = new Set();
  }
  if (parsed.dialogSlots !== null) state.dialogSlots = parsed.dialogSlots;
  for (const proof of parsed.verifiedProductPages?.values() ?? []) {
    if (proof.verified) state.previousVerifiedSkus.add(proof.sku);
  }
  state.history.push({ role: 'user', content: message }, { role: 'assistant', content: combined });
  return {
    message,
    status: response.status,
    duration_ms: parsed.durationMs,
    network_attempts: attempts,
    log_id: parsed.logId,
    diagnostic_error: parsed.diagnosticError,
    products_count: parsed.links.length,
    unique_products_count: linkEvidence.uniqueCount,
    product_identity_mode: strictFullSuite
      ? 'live_jsonld_product_sku_name_price_stock'
      : requiresLiveProductProof ? 'live_jsonld_product_sku' : 'url_shape_only_not_sku_verified',
    product_identity_evidence: requiresLiveProductProof
      ? [...(parsed.verifiedProductPages ?? new Map()).values()].map(({ description, ...evidence }) => ({
          ...evidence,
          description_excerpt: description?.slice(0, 500) ?? '',
        }))
      : [],
    products: parsed.links,
    text: parsed.text,
    completed: parsed.completed,
    conversation_boundary: parsed.conversationBoundary,
    selection_contract: parsed.selectionContract,
    tool_events: parsed.toolEvents,
    passed: failures.length === 0,
    failures,
  };
}

export async function main() {
  const report = {
    suite_file: path.basename(casesPath),
    suite_version: suite.schema_version,
    suite_sha256: suiteSha256,
    variations_file: variantsPath ? path.basename(variantsPath) : null,
    variations_sha256: variationsSha256,
    started_at: new Date().toISOString(),
    endpoint,
    strict_full_suite: strictFullSuite,
    strict_inventory: strictManifest,
    product_identity_mode: strictFullSuite ? 'live_jsonld_product_sku_name_price_stock' : 'url_shape_only_not_sku_verified',
    selected_count: selected.length,
    requested_repetitions: Object.fromEntries(runPlan.map(({ testCase, repeat }) => [testCase.id, repeat])),
    cases: [],
  };

  for (const { testCase, repeat, executions } of runPlan) {
    const caseResult = { id: testCase.id, title: testCase.title, repeats: [] };
    for (const execution of executions) {
      for (let run = 1; run <= repeat; run++) {
        const state = {
          sessionId: `customer_acceptance_${testCase.id.replace(/[^a-z0-9_-]/gi, '_')}_${execution.id.replace(/[^a-z0-9_-]/gi, '_')}_${Date.now()}_${run}`.slice(0, 120),
          history: [],
          dialogSlots: {},
          previousVerifiedSkus: new Set(),
        };
        const turns = [];
        for (let turnIndex = 0; turnIndex < testCase.turns.length; turnIndex++) {
          const turn = testCase.turns[turnIndex];
          const variantExpectation = execution.expect_overrides?.[turnIndex] ?? {};
          turns.push(await runTurn({
            ...turn,
            message: execution.messages[turnIndex],
            expect: resolveExpectations(
              suite.default_expectations,
              resolveExpectations(turn.expect, variantExpectation),
            ),
          }, state));
        }
        caseResult.repeats.push({ variant: execution.id, run, session_id: state.sessionId, turns, passed: turns.every((turn) => turn.passed) });
        if (stopOnFailure && !caseResult.repeats.at(-1).passed) break;
      }
      if (stopOnFailure && !caseResult.repeats.at(-1).passed) break;
    }
    caseResult.passed = caseResult.repeats.every((run) => run.passed);
    report.cases.push(caseResult);
    process.stderr.write(`${testCase.id}: ${caseResult.passed ? 'PASS' : 'FAIL'}\n`);
    if (stopOnFailure && !caseResult.passed) break;
  }

  report.finished_at = new Date().toISOString();
  const actualRuns = report.cases.reduce((total, item) => total + item.repeats.length, 0);
  const actualTurns = report.cases.reduce((total, item) => total + item.repeats.reduce((count, run) => count + run.turns.length, 0), 0);
  report.completeness = {
    complete: report.cases.length === selected.length && actualRuns === plannedRuns && actualTurns === plannedTurns,
    planned_cases: selected.length,
    recorded_cases: report.cases.length,
    planned_runs: plannedRuns,
    recorded_runs: actualRuns,
    planned_turns: plannedTurns,
    recorded_turns: actualTurns,
  };
  report.log_ids = [...new Set(report.cases.flatMap((item) => item.repeats.flatMap((run) => run.turns.map((turn) => turn.log_id).filter(Boolean))))];
  const pageProofs = await Promise.all(productPageCache.values());
  report.product_page_verification = {
    unique_urls_checked: productPageCache.size,
    verified: pageProofs.filter((item) => item.verified).length,
    unverified: pageProofs.filter((item) => !item.verified).length,
  };
  report.passed = report.completeness.complete && report.cases.every((item) => item.passed);
  if (reportFile) {
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  }
  const { cases: _allCases, ...reportSummary } = report;
  const output = minimalOutput
    ? {
        ...reportSummary,
        cases: report.cases.map((testCase) => ({
          id: testCase.id,
          passed: testCase.passed,
          repeats: testCase.repeats.map((repeat) => ({
            variant: repeat.variant,
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
        ...reportSummary,
        cases: report.cases.map((testCase) => ({
          id: testCase.id,
          passed: testCase.passed,
          repeats: testCase.repeats.map((repeat) => ({
            variant: repeat.variant,
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
              selection_contract: turn.selection_contract,
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

/** A misspelled CLI option must never silently launch the production default. */
export function validateCliArgs(argv = process.argv) {
  const booleanFlags = new Set([
    '--help', '--compact', '--minimal', '--failures-only',
    '--stop-on-failure', '--strict-full-suite',
  ]);
  const valuedFlags = new Set([
    '--endpoint', '--cases-file', '--variants-file', '--case',
    '--variant', '--repeat', '--report-file',
  ]);
  for (const arg of argv.slice(2)) {
    if (booleanFlags.has(arg)) continue;
    const separator = arg.indexOf('=');
    const name = separator < 0 ? arg : arg.slice(0, separator);
    if (valuedFlags.has(name) && separator >= 0 && arg.slice(separator + 1).trim()) continue;
    throw new Error(`Unknown or incomplete acceptance option: ${arg}`);
  }
  if (argv.includes('--help')) return 'help';
  if (!argv.some((arg) => arg.startsWith('--endpoint='))) {
    throw new Error('An explicit --endpoint= is required for live acceptance; production is never an implicit target');
  }
  return 'run';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cliAction = validateCliArgs(process.argv);
  if (cliAction === 'help') {
    console.log('Usage: node run-customer-acceptance.mjs --endpoint=https://.../functions/v1/<function> [--cases-file=path] [--variants-file=path] [--case=id] [--repeat=n] [--strict-full-suite] [--report-file=docs/qa/reports/name.json]');
  } else {
    await main();
  }
}
