# Requirement coverage: confirmed gap and implementation boundary

Status: design grounded in preview 665 evidence; NOT implemented or accepted.

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
