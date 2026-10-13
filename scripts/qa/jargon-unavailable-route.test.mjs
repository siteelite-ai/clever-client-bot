import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(
  new URL('../../supabase/functions/chat-consultant-v3/index.ts', import.meta.url),
  'utf8',
);
const recoverySource = readFileSync(
  new URL('../../supabase/functions/_shared/v3-tools/selection-search-recovery.ts', import.meta.url),
  'utf8',
);

test('an unavailable in-loop jargon recovery is recorded and cannot finish as an honest zero', () => {
  assert.match(source, /tc\.name === "jargon_recover_catalog" && !result\.ok &&\s*result\.error_code === "jargon_unavailable"/);
  assert.match(source, /step: "v3_jargon_recovery_unavailable"/);
  const noToolFinish = source.indexOf('// No tools → turn ends.');
  const ordinaryNoToolEnd = source.indexOf('meta: { reason: "ok", step_count:', noToolFinish);
  assert.ok(noToolFinish >= 0 && ordinaryNoToolEnd > noToolFinish);
  assert.match(source.slice(noToolFinish, ordinaryNoToolEnd),
    /if \(shouldReportJargonRecoveryUnavailable\(jargonRecoveryUnavailable, productsRendered\)\) \{\s*return finishWithCatalogTechnicalNotice\("in_loop", "jargon_recovery"\);/);
});

test('terminal helper failure is diagnostic, retryable, and not an empty result', () => {
  const recoveryStart = source.indexOf('const attemptTerminalJargonRecovery = async (');
  const recoveryEnd = source.indexOf('const renderJargonAxisSplit = async (', recoveryStart);
  assert.ok(recoveryStart >= 0 && recoveryEnd > recoveryStart);
  assert.match(source.slice(recoveryStart, recoveryEnd),
    /jargonResult\.error_code === "jargon_unavailable"\s*\? \{ kind: "unavailable", errorCode:/);

  const callerStart = source.indexOf('const recoveredJargon = await attemptTerminalJargonRecovery(');
  const callerEnd = source.indexOf('v3_terminal_jargon_recovery_empty', callerStart);
  assert.ok(callerStart >= 0 && callerEnd > callerStart);
  const caller = source.slice(callerStart, callerEnd);
  assert.match(caller, /recoveredJargon\?\.kind === "unavailable"/);
  assert.match(caller, /step: "v3_terminal_jargon_recovery_unavailable"/);
  assert.match(source.slice(callerEnd - 150, callerEnd + 120),
    /recoveredJargon\?\.kind !== "unavailable"/);
});

test('technical notice is finalized before empty synthesis or an empty-catalog claim', () => {
  const technicalGuard = source.indexOf('return finishWithCatalogTechnicalNotice("terminal", "jargon_recovery");');
  const emptySynthesis = source.indexOf('buildCatalogEmptySynthesisMessages(', technicalGuard);
  const emptyClaim = source.indexOf('Не нашёл подходящие товары по этому сочетанию параметров.', technicalGuard);
  assert.ok(technicalGuard >= 0 && emptySynthesis > technicalGuard && emptyClaim > emptySynthesis);
  assert.match(source.slice(technicalGuard - 150, technicalGuard),
    /shouldReportJargonRecoveryUnavailable\(jargonRecoveryUnavailable, productsRendered\)/);
  const helperStart = source.indexOf('const finishWithCatalogTechnicalNotice = (');
  const helperEnd = source.indexOf('let groundedCompoundSearchTerminal = false;', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helper = source.slice(helperStart, helperEnd);
  assert.match(helper, /const notice = TRANSIENT_CATALOG_FAILURE_NOTICE;/);
  assert.match(helper, /send\(\{ type: "delta", content: .*notice.* \}\);/);
  assert.match(helper, /steps\.push\(\{\s*step: source === "jargon_recovery"\s*\? "v3_jargon_recovery_technical_notice"/);
  assert.match(helper, /source === "jargon_recovery"\s*\? "jargon_recovery_unavailable"\s*: "catalog_tool_unavailable"/);
  assert.match(recoverySource,
    /TRANSIENT_CATALOG_FAILURE_NOTICE\s*=\s*"[^"]*Не могу подтвердить, что подходящих товаров нет\. Повторите запрос позже\."/);
});

test('model final prose is suppressed before streaming when an unavailable search has no rendered card', () => {
  const finalTurn = source.indexOf('} else if (isFinalTurn) {');
  const noToolFinish = source.indexOf('// No tools → turn ends.', finalTurn);
  assert.ok(finalTurn >= 0 && noToolFinish > finalTurn);
  const finalText = source.slice(finalTurn, noToolFinish);
  const suppress = finalText.indexOf('step: "v3_jargon_unavailable_final_text_suppressed"');
  const stream = finalText.search(/send\(\{\s*type: "delta",\s*content: outText(?:,\s*origin: "(?:model|server)")?\s*\}\);/u);
  assert.ok(suppress >= 0 && stream > suppress, 'unverified "not found" must be suppressed before SSE delta');
  assert.match(finalText.slice(0, suppress),
    /shouldReportJargonRecoveryUnavailable\(\s*jargonRecoveryUnavailable,\s*productsRendered,/);
  assert.match(finalText.slice(0, suppress), /outText = "";/);
});
