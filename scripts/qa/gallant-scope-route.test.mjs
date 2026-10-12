import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(
  new URL('../../supabase/functions/chat-consultant-v3/index.ts', import.meta.url),
  'utf8',
);

function between(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing source section: ${start}`);
  return source.slice(from, to);
}

test('both active-scope log lookup paths have the same 30-minute database bound', () => {
  const lookup = between(
    'async function loadVerifiedActiveSelectionScope(',
    'async function loadVerifiedSelectionReadinessPending(',
  );
  assert.match(lookup, /activeSelectionScopeLookupCreatedAfter\(\)/);
  assert.equal(
    lookup.match(/\.gte\("created_at", earliestCreatedAt\)/g)?.length,
    2,
    'direct and rotated-session JSONB fallback must both be time-bounded',
  );
});

test('active scope lookup is server-owned despite stale client slots and routes before unscoped handlers', () => {
  const decision = between(
    'const activeScopeLookupNeeded =',
    'const sameSectionScope =',
  );
  assert.match(decision, /mayBeNominalRefinement\(userMessage\) \|\|\s*mayBeActivePrepositionalRefinement\(userMessage\) \|\|\s*isShortAttributeSelectionFollowup\(userMessage\) \|\|\s*Boolean\(verifiedReadinessState\.slot\)/);
  assert.doesNotMatch(decision, /!clientCatalogClarification/,
    'a browser-carried stale catalog slot must not suppress scope verification');
  assert.doesNotMatch(decision, /priorHistory/,
    'browser history must not authorize or bypass server scope verification');
  assert.match(decision, /activeScopeState\.lookupFailed/);
  assert.match(decision, /v3_selection_context_lookup_failed_closed/);
  assert.match(decision, /classifyActivePrepositionalRefinement\(/);
  assert.match(decision, /activePrepositionalRefinement === "ambiguous"[\s\S]*?v3_active_selection_prepositional_ambiguous[\s\S]*?return;/,
    'a brand-like dependent phrase must stop before an unscoped card route');
  assert.match(source, /const sameSectionScope = activeScopeState\.scope &&[\s\S]*?activePrepositionalRefinement === "continue"/,
    'short attribute and location phrases must retain the verified entity and leaf');
  assert.match(source, /const activeScopeEntityChanged = Boolean\([\s\S]*?explicitlyChangesActiveSelectionEntity\(/);
  assert.match(source, /const activeScopeClassChanged = Boolean\([\s\S]*?isIndependentNominalRequestOutsideActiveScope\(/);
  assert.match(source, /newTaskBoundary: Boolean\(\s*readinessNewTask \|\| activeScopeExplicitBoundary/,
    'a new entity or product noun must not be merged with old readiness');
  assert.match(source, /const startsNewTask = activeScopeExplicitBoundary \|\|/,
    'a verified old scope must be cleared before routing a different entity or noun');
  assert.match(source, /if \(!data\) \{[\s\S]*?lookupFailed: false \};/,
    'a genuinely fresh session must not be mistaken for a database error');
  assert.match(source, /\(!sameSectionScope &&\s*shouldResetUnverifiedBroadAssortmentTask\(/,
    'an unverified stale slot must not reset a completed active scope');
  assert.match(source, /!verifiedBroadChoiceState\.verifiedSlot && !startsNewTask &&\s*!sameSectionScope/,
    'the stale-slot error branch must not intercept a verified active scope');

  const scopedRoute = between(
    '} else if (sameSectionScope && !startsNewTask) {',
    '} else if (broadAssortmentRequest) {',
  );
  assert.match(scopedRoute, /runExpertLoop\(/);
  assert.match(scopedRoute, /effectiveSlots/);
  assert.match(scopedRoute, /v3_active_selection_scope_expert_route/);
  assert.match(
    source,
    /const broadAssortmentRequest = !activeSelectionScope &&\s*isBroadAssortmentRequest\(userMessage\)/,
    'the scoped expert route must not reopen broad-assortment clarification',
  );

  const broadPosition = source.indexOf('} else if (broadAssortmentRequest) {',
    source.indexOf(scopedRoute));
  const directPosition = source.indexOf('} else if (exactProductInquiryDirectAdmitted) {',
    broadPosition);
  assert.ok(broadPosition > source.indexOf(scopedRoute));
  assert.ok(directPosition > broadPosition);
});

test('final expert card gate intersects live leaf, active entity, and independent named token', () => {
  const guard = between('const guardFinalRenderIds = (',
    'const finalizeTerminalRenderIds = (');
  assert.match(guard, /productMatchesActiveSection\(\s*ctx\.cache\.get\(id\)\?\.leaf_category,/);
  assert.match(guard, /filterProductIdsByNamedSeries\(\s*sectionSafeIds,\s*ctx\.cache,\s*activeSelectionScope\.entity,/);
  assert.match(guard, /filterProductIdsByNamedSeries\(\s*guardVisibleCardinality\(scopeSafeIds, visibleContext\)\.ids,\s*ctx\.cache,\s*namedSeriesToken,/);
});
