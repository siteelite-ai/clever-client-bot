# Structured measurement obligations — targeted preview QA, 2026-10-30

Status: PASS for the single specified live motor case on commit `3fade1a1`. NOT a full customer acceptance pass or permission to release all draft changes.

## Implemented changes

- `9bc7b336`: decimal scalars are compared atomically. Lexical punctuation normalization no longer turns `6.3` into independent numbers `6` and `3`, or makes a load point authorize an exact enclosing interval. Exact physical choices additionally use the existing product-side provenance projector. A model-supplied ID cannot override that boundary. Explicit exact decimal customer requests remain supported, including both separators. Existing count/morphology paths are preserved.
- `5be210f0`: a category-neutral adapter splits model product requirements into individual entries. Source-object facts stay in server request state. It retains all supplied entries, rejects malformed/oversized input instead of truncating conditions, and runs the materialized obligations through existing proof gates.
- `8570b194`: independently certified load/range evidence is carried into materialization rather than depending on the model to repeat it.
- `3fade1a1`: the exact evidence span compiled from the validated server certificate retains server provenance through model-claim cleanup. Equal numbers in other model-declared properties are not certified by this span. The existing per-product setting-range check still gates card egress.

The structured adapter is enabled ONLY for closed closure-preview derivations with an existing certified measured-point relation, excluding replacements and paired-fit derivations. Public and other entrypoints do not opt in. This is a bounded first migration of the obligation handoff, not a claim that all reasoning branches have been converted to a fully typed numeric AST.

## Live checks: failures retained, not hidden

Four targeted chat requests were made in this iteration, not a broad repeated benchmark. Each had successful catalog preflight.

| Code | Request ID | Result | Evidence |
| --- | --- | --- | --- |
| `9bc7b336` | `b380016d-8484-454b-a4fb-7126b536fbca` | FAIL, 17,408 ms, zero cards | False exact nominal requirement disappeared. Mixed coverage prose still failed `other_number_in_coverage_clause`. |
| `5be210f0` | `93d09cf5-951d-4427-9a12-709839a334de` | FAIL, 14,505 ms, zero cards | Structured declarations were used (four then three entries), but resolved measurement evidence was empty; `coverage_relation_missing`. |
| `8570b194` | `8f264986-46f6-4614-9bc5-01b437e157bd` | FAIL, 14,996 ms, zero cards | Server relation was present at materialization, then disappeared in downstream cleanup; `coverage_relation_missing`. |
| `3fade1a1` | `14cf5afe-0280-432b-9acb-e89ca13f1544` | PASS, 14,393 ms, one card | Terminal gap is null, independent coverage `covered`, both live setting ranges enforced in search, final card returned. |

All requests used the same message: motor 3 kW, 380 V, three phases, direct start, nameplate load current 6 A. These were real closed-preview HTTP/SSE tests, not browser-widget UI acceptance tests.

The final response returned `Автомат защиты двигателя ВА-431 3P 4,0-6,3A 100кА /21228DEK/`, 5,895 KZT, Astana one unit. Its stated setting interval includes 6 A. The response disclosed that the performed search confirmed one variant; it did not claim an exhaustive catalog-wide result or three fully interchangeable alternatives.

## Verification and release boundary

- Full offline V3/shared suite: 2,096 passed, zero failed. Final focused provenance tests: eight passed, including baseline reproduction where cleanup removes the same evidence without server provenance.
- Negative controls preserve independent nominal-current, voltage and power obligations; server range proof cannot certify them. Explicit customer decimals remain available. Incompatible point/range cards remain rejected by the existing gate.
- Final closed preview: v260 after cleanup, JWT verification enabled, SHA `f16a12ff71e95e3c9cede60d90044941217142c952dadc556cff8a3d0a018b1d`.
- Public function code unchanged: SHA `0dbe89ff568a467b0b0d6fb12e226f312ba3bb7742fee154cf58a50597d281de`. Counter v655 reflects shared secret refreshes, not a public code deployment.
- Temporary QA pairs were removed; independent metadata confirms 23 pre-existing secrets and zero `V3_CLOSURE_*` names. The process bridge used private temporary files (directories 0700, files 0600) containing only generated disposable QA credentials, then removed those exact files/directories after each child. No production secret value was copied into them or displayed.
- No main merge, public function deploy, Lovable publish, loader change or server3 change.

Before public rollout, test the bounded multi-turn continuation/negative controls with the new mode actually enabled on the intended release entrypoint; the unchanged legacy/public offline paths alone do not certify that rollout. The pump and underground-cable live scenarios were NOT retested in this iteration. Keep the broad release goal open.
