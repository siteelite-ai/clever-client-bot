# Shared conjunction rejection diagnostics — 2026-11-05

## Why this is needed

The bounded live PR147 test at `7051eb00` ended in a voltage refusal (own request
`e6f4f469-4cdf-4e98-b503-c5a755511eaa`). Current and readiness were confirmed,
but `compileMeasuredRequirementConjunction` returned null. The old outer log
reported empty domains/criteria for every null result, erasing the distinction
between an unresolved source point and a *later* independent clause failure.
The raw model clause was deliberately not logged. Its exact operator/wording
cannot be recovered or invented from the quantity 380 V alone.

## Change boundary

This change adds observation, **not a voltage workaround**. Existing return
contracts, branch predicates, catalog filters, SKU checks and safe refusals
remain unchanged. There is no new product/brand/query alias, tolerance, voltage
substitution, prompt or model change. In particular, preliminary candidates
cannot render without their independent obligations passing.

The shared compiler reports one final fixed rejection/acceptance code, with:

- Resolved/unresolved/projected operating-domain counts, retained even if a
  later clause fails (each capped at 16).
- Failing clause index (capped at 255).
- Existing allowlisted physical quantity diagnostics (at most 16); numeric
  overlap is not labelled ownership.
- Fixed min/max + inclusive/exclusive operator tags (at most 16).
- Counts of mandatory/proven/unmatched projected criteria and option facets
  (each capped at 64), not their arbitrary keys or values.
- Where relevant, the existing fixed source-coverage rejection code.

No customer/model sentences, emails, secrets, facet names, raw unknown units or
arbitrary provider strings are added to telemetry. Observation is optional;
production callers without an observer retain the same return interface.
The expert handler records this diagnostic inside the already existing bounded
measurement projection diagnostic, at the same stages as before.

## Codes and what they distinguish

| Code | Meaning |
|---|---|
| `unsupported_scope` / `invalid_load_relation` | No valid relation contract for this path |
| `unresolved_customer_operating_point` | Source operating-point resolution failed |
| `operating_domain_projection_mismatch` | A resolved point could not compile to the same complete live domain |
| `unscoped_comparison` / `uncovered_context_clause` | A non-projectable comparison/context clause remains |
| `compound_measured_clause` | Several obligations cannot borrow proof from one scalar |
| `unprojected_measured_clause` | The independent model clause has no complete live projection |
| `ambiguous_desired_facet` | The desired projection does not identify one independent axis |
| `customer_implication_not_proven` | The stronger customer contract does not prove the model condition |
| `missing_coverage_relation` | The source/current relation was not actually covered |
| `covered` | The original complete conjunction succeeded |

These codes are not mapped to new user-facing advice. Diagnostics cannot
authorise rendering or weaken a criterion.

## Offline verification

Four new unit regressions cover retained domain evidence on a later failure,
distinct rejection branches, unchanged acceptance/rejection with and without
the observer, and privacy/array bounds. Existing real HTTP/SSE handler fixture
tests now also assert diagnostic wiring on both refusal and four-card success.
All handler fixtures deny external network access; no paid/provider or live
catalog calls are needed for this implementation.

Targeted conjunction/domain tests: 22 passed, 0 failed.
Handler suite: 23 passed, 0 failed (including the new diagnostic assertions).
Full-suite and exact-head CI results are recorded in the PR after completion.

## Remaining gate

The real voltage refusal is still unresolved. After offline checks and exact-head
CI, a separately authorised fresh closed-preview run is needed to record the
new branch reason. Do not reuse deleted QA credentials, infer exact provider
wording from old logs, or call the product ready because offline fixtures pass.
