# Preview 673: attribution and conditional class proof

Production API version verified 448 (unchanged); preview version verified 673, candidate `fca7ce4f`.

Local checks: 881 shared tests passed; Edge type check passed. Source attribution now expands a unique exact sentence prefix to its complete existing source, then checks the full sentence. It does not invent words or discard trailing conditions/negation.

## Live runs: acceptance still failed

| Case | Follow-up request ID | ms | Result |
|---|---|---:|---|
| CCTV 1 | e3ac645b-3e51-451c-ab71-2e6e288ea378 | 12889 | No internal error, zero cards, requirements incomplete |
| CCTV 2 | 43e39ce4-806e-496c-b80c-6be0c71ad40c | 10944 | No internal error, zero cards, requirements incomplete |
| CCTV 3 | 49a99d59-8f72-4e1e-b2af-3cef1d05ad42 | 16784 | Four wrong retro power-cable cards; FAIL |
| Yard light | befdff51-384b-4bb8-aad5-17e55d60ccac | 9483 | internal_error: key_not_grounded |

The CCTV runs all clarified first. Live search found three candidates, unlike earlier zero-retrieval runs; this does not prove suitability or acceptance.

### Proven mechanisms and next candidate

- Yard declaration used “со световым потоком” for caption “Световой поток, Лм”. The obligation tokenizer missed instrumental adjective endings `ым`/`им`. Added morphology support and an exact regression fixture; thresholds/units remain checked.
- CCTV terminal cardinality supplements could escape the class proof required by an earlier sparse-property recovery. That class proof was not retained when the frozen plan removed an unverified suitability property. Candidate `24980a7c` retains this conditional proof separately with original provenance and rechecks subsequent final IDs. It does not promote a model assumption to a user requirement.
- 883 shared tests and Edge type check passed for `24980a7c`; live recheck required.

Still unresolved: grounding every necessary class/property in the original reasoning, distinguishing advice from necessity consistently across projection paths, truthful unverified-suitability responses, sensor metadata conflicts, broader numerical/context cases and full browser/customer regression. No production readiness claim.

## Post-fix live check: candidate 24980a7c

- Yard request `8ddfd258-7f8e-4d58-ba2c-84b905af672b`: automated PASS, 6183 ms, 3 cards; 3500 lm minimum and IP65 retained. Semantic review still flags a recommended 40–50 W range incorrectly frozen as mandatory. Do not equate automated PASS with full semantic acceptance.
- CCTV request `df882587-ec81-4bee-bf88-95c69c0ecc59`: FAIL, 13985 ms, no internal error, zero cards. Search found three candidates. Required outdoor/75-ohm contract remains incomplete; descriptive PE advice still appears as mandatory. The wrong-card branch did not occur in this run, so its live fix is not yet proven by reproduction.
- Preview deploy succeeded for candidate 24980a7c; production not deployed. Full regression and browser validation remain outstanding.
