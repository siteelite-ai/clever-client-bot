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
  assert.match(source, /const startsNewTask = !verifiedCutoutContinuation &&\s*!dependentCutoutReply && \(\s*activeScopeExplicitBoundary \|\|/,
    'a different entity or noun must clear the old scope, except a server-verified cut-out continuation');
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
    scopedRoute,
    /isShortAttributeSelectionFollowup\(userMessage\)\s*\? `\$\{scopedSelectionRequest\.message\} \$\{sameSectionScope\.leaf\}`\s*: scopedSelectionRequest\.message/,
    'only a short attribute request gets its missing product noun from the verified section',
  );
  assert.match(
    scopedRoute,
    /isShortAttributeSelectionFollowup\(userMessage\)\s*\? sameSectionScope\.leaf\s*: null/,
    'only a short attribute request may seed the first taxonomy lookup from the verified leaf',
  );
  assert.match(
    source,
    /const verifiedActiveLeafEvidence = verifiedInitialDiscoveryLeaf &&\s*activeSelectionScope\?\.leaf === verifiedInitialDiscoveryLeaf/,
    'only the matching server-owned scope may ground a short discovery noun',
  );
  assert.equal(
    source.match(/\$\{verifiedActiveLeafEvidence\}/g)?.length,
    3,
    'initial capture and both discovery guards must share that verified leaf evidence',
  );
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

test('verified complete same-section request outranks stale readiness and consumes its slot', () => {
  const activeDecision = between(
    'const activePrepositionalRefinement =',
    'const sameSectionScope =',
  );
  assert.ok(
    activeDecision.indexOf('const activeScopeExplicitBoundary =') <
      activeDecision.indexOf('activePrepositionalRefinement === "ambiguous"'),
    'explicit entity/class change must be checked before ambiguous relation handling',
  );
  assert.match(activeDecision, /activeScopeState\.scope && !activeScopeExplicitBoundary/,
    'a request excluding the selected entity must not reissue its old scope');

  const boundary = between('const sameSectionScope =', 'const cache: ProductCache =');
  assert.match(boundary, /isReadinessQuestionSupersededByVerifiedSection\(\s*userMessage,\s*readinessNewTask,\s*Boolean\(verifiedReadinessState\.slot\),\s*Boolean\(sameSectionScope\),\s*sameSectionNominalRefinement \|\|\s*activePrepositionalRefinement === "continue",\s*activeScopeExplicitBoundary/);
  assert.match(boundary, /const startsNewTask = !verifiedCutoutContinuation &&\s*!dependentCutoutReply && \(\s*activeScopeExplicitBoundary \|\|\s*Boolean\(effectiveReadinessNewTask\)/);
  assert.match(boundary, /newTaskBoundary: Boolean\(\s*readinessNewTask \|\| activeScopeExplicitBoundary \|\|\s*readinessQuestionSuperseded/,
    'superseded readiness must not prepend the old question to this same-section request');
  assert.match(boundary, /readinessQuestionSuperseded\s*\? \{ \.\.\.boundarySlots, pending_clarification: undefined \}/,
    'the old pending question must not reach the current expert route');
  assert.match(boundary, /scopedSelectionRequest\.scoped \|\| readinessQuestionSuperseded[\s\S]*?send\(\{ type: "slot_update", slots: \{\} \}\)/,
    'the browser must not carry the consumed readiness question into a later turn');
});

test('a verified free-form readiness answer suppresses only a nominal class change', () => {
  const readinessOverride = between(
    'const verifiedFreeformReadinessAnswer =',
    '// The browser\'s history and pending slot are hints',
  );
  assert.match(readinessOverride, /const rawReadinessNewTask =\s*classifyPendingSelectionReadinessNewTaskLocally\(/);
  assert.match(readinessOverride,
    /const readinessNewTask = verifiedFreeformReadinessAnswer &&\s*rawReadinessNewTask\?\.reason ===\s*"local_verified_readiness_independent_selection"\s*\? null\s*: rawReadinessNewTask/,
    'only the verified answer may override a lexical independent-selection decision, never an explicit topic boundary');
  const entityChange = source.match(
    /const activeScopeEntityChanged = Boolean\(([\s\S]*?)\n\s*\);/,
  )?.[1];
  assert.ok(entityChange, 'the entity boundary must be present');
  const classChange = between(
    'const activeScopeClassChanged =',
    'const activeScopeExplicitBoundary =',
  );
  assert.match(entityChange, /explicitlyChangesActiveSelectionEntity\(/);
  assert.doesNotMatch(entityChange, /isVerifiedFreeformReadinessAnswer|verifiedFreeformReadinessAnswer/,
    'a named entity change remains authoritative even if a pending question exists');
  assert.match(classChange, /isIndependentNominalRequestOutsideActiveScope\(/);
  assert.match(classChange, /!\s*(?:isVerifiedFreeformReadinessAnswer\(|verifiedFreeformReadinessAnswer)/,
    'only a verified free-form answer can suppress a nominal class boundary');
  assert.match(source, /const activeScopeExplicitBoundary = activeScopeEntityChanged \|\|\s*activeScopeClassChanged/,
    'an explicit entity change must continue to create a new task');
  const sameSection = between(
    'const sameSectionScope =',
    'const readinessQuestionSuperseded =',
  );
  assert.match(sameSection, /!activeScopeExplicitBoundary/);
  assert.match(sameSection, /verifiedFreeformReadinessAnswer/,
    'a verified short answer must retain the active scope for the next route');
});

test('final expert card gate intersects live leaf, active entity, and independent named token', () => {
  const guard = between('const guardFinalRenderIds = (',
    'const finalizeTerminalRenderIds = (');
  assert.match(guard, /productMatchesActiveSection\(\s*ctx\.cache\.get\(id\)\?\.leaf_category,/);
  assert.match(guard, /filterProductIdsByNamedSeries\(\s*sectionSafeIds,\s*ctx\.cache,\s*activeSelectionScope\.entity,/);
  assert.match(guard, /filterProductIdsByNamedSeries\(\s*guardVisibleCardinality\(scopeSafeIds, visibleContext\)\.ids,\s*ctx\.cache,\s*namedSeriesToken,/);
});

test('generic freeform assortment fallback verifies a live leaf, keeps compound criteria, and fails closed', () => {
  const preflight = between(
    'async function answerBroadAssortmentRequest(',
    '// PostgREST treats an array argument',
  );
  assert.match(preflight, /catalogError = result\.error_code/);
  assert.match(preflight, /catalog_error: catalogError/);
  assert.match(preflight, /buildBroadAssortmentFreeformSlot\([\s\S]*?originalRequest/);

  const decision = between(
    'const freeformCandidate = verifiedBroadChoiceState.freeformCandidate;',
    'const clientSelectionReadinessScope =',
  );
  assert.match(decision, /verifyServerIssuedBroadAssortmentFreeformLeaf\(/);
  assert.match(decision, /verifyExactCatalogLeaf\(leaf, deps\)/,
    'an exact typed leaf should not require the catalog options endpoint');
  assert.match(decision, /executeDiscoverCategory\(\{ noun: leaf \}/);
  assert.match(decision, /exact\.reason !== "absent"/,
    'ambiguous and parent identities must not fall back to the prior resolver');
  assert.match(decision, /timeoutMs: 6_000/);
  assert.match(decision, /taxonomy cache may be reused/);
  assert.doesNotMatch(decision, /openrouterApiKey:/,
    'freeform section discovery must not need a model to invent a category');
  assert.match(decision, /verifiedFreeformChoice\?\.exact/,
    'only a bare exact section may bypass the criteria-aware expert');
  assert.match(decision, /verifiedFreeformScope/);

  const routes = between(
    'if (verifiedBroadChoice && !startsNewTask) {',
    '} else if (isMetaSelfQuestion(userMessage)) {',
  );
  const failurePosition = routes.indexOf('v3_broad_assortment_freeform_unverified');
  const constrainedPosition = routes.indexOf('v3_broad_assortment_constrained_chip_expert_route');
  assert.ok(failurePosition > 0 && constrainedPosition > failurePosition);
  assert.match(routes, /buildBroadAssortmentFreeformSlot\([\s\S]*?freeformCandidate\.original_request/);
  assert.match(routes, /freeformVerification\?\.status === "indeterminate"/);
  assert.match(routes, /Это не означает, что товаров нет/);
  assert.match(routes, /verifiedFreeformChoice && freeformCandidate/);
  assert.match(
    routes,
    /effective_request:\s*joinCustomerTurns\(\[\s*freeformCandidate\.original_request,/,
    'the verified original and current criteria must remain separate customer turns',
  );
  assert.match(routes, /Текущие критерии клиента: \$\{userMessage\}/);

  const selected = between(
    'async function answerVerifiedBroadAssortmentChoice(',
    'async function',
  );
  assert.match(selected, /if \(qualified\.length === 0\) \{[\s\S]*?type: "active_selection_scope"/);
  assert.match(selected, /catalog_error/);
});
