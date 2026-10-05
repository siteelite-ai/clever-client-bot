# Requirement coverage: confirmed gap and implementation boundary

Status: declaration, search criteria, checkpoint and correction integration
implemented locally; live acceptance remains unproved. NOT ready for production.

## Integration checkpoint

`0645dcd9` live checkpoint: `0688e5bb-28fe-42e4-bc5c-1e390772af89` now completes
without an internal error, preserving three mandatory criteria. Still FAIL:
zero cards, 13.895 s. Full raw evidence in `obligations-preview671-20261005.json`.
Unique live descriptive values can ground a caption absent from prose;
unknown/ambiguous keys, bare codes and numeric values cannot take that path.

Direct read-only catalog check: all three records classified as radio-frequency
cables have PVC sheaths (two in stock, one out of stock). Two GENERICA descriptions
explicitly describe indoor use. Their PE/FPE trait is INSULATION, not outer
SHEATH. No UV suitability was established by this check; it is not proof that
no suitable product exists elsewhere/misclassified in the entire catalog.
The free query `КВК` returned zero. Do not force a product-count PASS by showing
these records as outdoor-suitable without evidence.

Local next change: examples in parentheses (“обычно…”, “например…”) no longer
inherit a neighboring functional property's necessity. Both ordinary exact
criteria and independent properties use this importance alignment; explicit
customer and independently mandatory properties stay A. 877 shared tests pass;
not live-verified/deployed at this checkpoint. Generic retrieval/category scope
and honest unavailable-evidence response remain open. Current retrieval excludes
the relevant miscellaneous-cable leaf and searches an over-specific full phrase;
even repairing retrieval must not remove outdoor-evidence checks.

Latest: `6cefd0e0` adds one bounded format repair sharing the existing maximum
two reasoning attempts. It preserves every property's typed key/op/value/unit/
scope, all other original fields and the complete original visible reasoning;
only appended grounding sentences and source-span formatting may change.
`ccd1159a` adds conservative inflection/token-order matching and splits rejection
diagnostics. 875 shared tests and Edge check passed before diagnostic-only edit.
Live probe `c27d873a-8c02-4019-9869-8c2eca3282e9` is still FAIL/internal_error.
The now-exact diagnostic is `key_not_grounded`: catalog caption `Назначение`
is absent from prose describing a necessary coaxial radio-frequency cable.
Inflection alone did not fix this rejection, and the bounded repair did not
recover. Do not report it as resolved. The source also labels 75 ohm merely as
recommended, so semantic completeness is a separate issue.
Next integration boundary: legitimate live-facet caption/value mapping versus
literal prose key ownership. A catalog key need not occur literally when its
validated live value is semantically grounded; unknown free keys still need
source ownership. Do not blanket-disable key validation or infer synonyms.
Evidence: `obligation-repair-preview670-20261005.json`.

Live follow-up (still FAIL): preview 667 rejected a copied customer fragment
`расстояние 30 метров` declared as minimum product length, not a visible derived
requirement. Evidence `f6f4d80f-0372-4115-907a-0d7a069059ae`.
Policy commit `303c7e56` explicitly separates task inputs and product properties,
and requires complete source sentences from reasoning. 873 tests and Edge
typecheck pass; deployed to preview only.
Next live request `be27fe9e-6ab2-4365-8fbe-7211d41f1600` no longer made that length
claim, but failed because a semantic class caption `Назначение` and value
`Кабели радиочастотные` did not occur literally in the source sentence, which
said `радиочастотный коаксиальный кабель`. Do not treat prompt improvement as
acceptance. Source validation is unchanged; do not accept arbitrary ungrounded
keys/values just to remove the internal error. Need a bounded declaration
format repair preserving original obligations, or a single canonical typed
representation rather than inconsistent parallel prose/fields. Any repair must
share the existing two-attempt/time budget, not add an unbounded model loop.
The same request also did not demonstrate coverage of 75 ohm. Coverage remains
an independent acceptance gap even after format repair.
Evidence files: `obligation-declaration-rejection-preview667-20261005.json` and
`obligation-declaration-preview668-20261005.json`.

- Forced reasoning schema now includes independent `mandatory_properties`.
- Resolver rejects malformed/unproven property declarations instead of dropping
  individual obligations. Previously saved declarations without the field remain
  compatible. Clarification-only outcomes do not freeze conditional properties.
- Validated properties enter both mandatory selection criteria and post-filter
  criteria; query projection still uses available facets only.
- Configuration checkpoints preserve the properties. Optional correction must
  preserve key, operator, value, unit and strictness of every prior property.
- A later rewrite of visible reasoning cannot erase their source sentences.
- Diagnostics include independent obligations for inspection.
- Integration test covers no-facet declaration, checkpoint, correction and
  actual criteria gate: proven card passes, wrong quantity and missing evidence
  do not. Live model output coverage, product evidence adequacy and conflicting
  semantic data still need verification; no claim of full client acceptance.

## Isolated implementation checkpoint

`reasoning-obligations.ts` validates bounded typed per-product declarations
against their complete visible source sentence, without taking catalog facets
as an input. Invalid or unsupported entries remain in `unresolved`; callers
must not ignore this list. Positive necessary properties and exact/range-bound
quantities are supported; preferences, conditional configurations, aggregate
claims and negative-property declarations remain unresolved.

Tests cover two independent properties without search facets, cross-category
numeric bounds, changed units/values/operators, fabricated evidence, omitted
negation, substring property collisions and string-based numeric bypasses.
This validates declaration provenance only, NOT complete extraction of all
requirements. Product verification uses the existing mandatory criteria gate;
its semantic-evidence limitations below remain open.

## Reproduction

Browser request `1b51c7c1-a949-4078-b4d3-0c276fdc08fe`:
analog CCTV, outdoors, 30 m. Visible reasoning requires 75 ohm impedance and
UV-resistant sheath. `v3_derived_selection_reasoning_requested` projects zero
criteria; `v3_terminal_criteria_evidence_audit` checks zero criteria. Two cards
are rendered with `mandatory_criteria: []` and a statement that they passed
the same mandatory criteria. Neither the title-only old test nor a successful
HTTP response proves suitability.

## Current code boundary

- `selection-actionability.ts`, `buildDerivedSelectionReasoningToolSchema`:
  `required_facet_values` can contain only IDs of available live facet values.
  There is no independent field for obligations absent from the facet schema.
- `chat-consultant-v3/index.ts`, derived declaration compilation:
  `derivedMandatoryCriteria` combines selected live classes, exact live values,
  and measured projections. A requirement that none of these represent is
  absent, not marked unresolved.
- `criteria-gate.ts` correctly distinguishes pass/fail/unknown for criteria
  it receives. It cannot reject an omitted obligation. Changing its generic
  missing-data policy alone therefore cannot repair this failure.
- `criteria-gate.ts` string evidence does not establish every engineering
  synonym, implication or contradiction. A catalog boolean that conflicts
  with a title (motion versus acoustic activation) needs explicit conflict
  handling, not a stronger claim based on that same boolean.

## Required architecture change

1. Extend the forced declaration with bounded structured product obligations
   independently of live search facets. Each has a visible source span,
   scope (per-product versus total), typed comparison and provenance.
   Preserve unknown/unmapped obligations; never silently discard them.
2. Keep existing facet IDs as retrieval optimizations. A query projection is
   not the full requirement set and is not evidence that a product complies.
3. Resolve obligations against product traits and attributable title/description
   evidence. Reuse deterministic gates for represented quantities and values.
   A missing facet alone must not disqualify a product with adequate evidence.
4. For semantic properties, permit only evidence-grounded, bounded resolution;
   retain exact product-source spans and conflicts. Model assertion alone
   must not create a fact. Uncertain / contradictory evidence is not PASS.
5. Carry the full obligation ledger through clarification, correction,
   supplementary search and terminal rendering. Removing a requirement needs
   an explicit user change, not an empty search or optional model correction.
6. If evidence remains unavailable, distinguish unverified suitability from
   no stock. Continue permitted evidence retrieval, or disclose the precise
   missing proof. A zero-card refusal alone is not customer-case completion.

## Tests before integration / acceptance

- Same mechanism across cable environmental suitability, fixture activation
  type and another non-lighting product; no category/SKU special cases.
- Missing search facet + positive attributable product evidence can pass.
- Missing search facet + no product evidence remains unresolved.
- Structured positive + contradictory title cannot silently pass.
- Correct product class but missing mandatory property cannot pass.
- Measured value preserves unit, direction and per-item scope; incidental
  numbers cannot prove a property.
- Evidence cannot be borrowed from a different product or an earlier topic.
- Untrusted catalog text cannot change obligations or invoke tools.
- Existing exact marking, jargon, analog, price, series, pagination and
  clarification branches retain their current verified behavior.
- Full client matrix and actual browser conversations, including follow-ups,
  must be rerun. Keyword or card-count PASS is insufficient.

## Rollout constraint

Draft PR / preview only. Production 448 unchanged. No production merge until
the complete client scope and cross-category regression are proved.
