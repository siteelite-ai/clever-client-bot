# Numeric projection diagnostic QA — 2026-10-30

Status: FAIL (customer acceptance), successful diagnostic capture. No production promotion.

Code commit: `2ca2c54b` (includes isolated candidate experiment `6db900db`). After QA secret cleanup, closure preview v243 has bundle SHA `98be2a8ce57c1eda194b22c94b713c8ed319a34419c4fb3bfc6de9606f6d9ed6` and JWT verification remains enabled.

One paid chat turn: motor 3 kW / 380 V / three phases / direct start / verified nameplate current 6 A. Catalog preflight passed all four HTTP 200 checks. Chat returned HTTP 200 in 16,274 ms, completed, with zero products. Request ID: `f6b669ab-ccfa-4853-89d8-bf4abbb3704e`.

## Confirmed primary failure

- Model declaration required exact live setting range `4-6.3` AND exact nominal-current facet value `6.3`.
- The nominal-current equality was model-declared, not explicitly mapped from a customer requirement. This does not by itself prove that the model's engineering choice is wrong; it requires independent justification and product proof.
- The range certificate rejected coverage of that second property: `separate_numeric_facet`, facet index 1. A load-point/range relation cannot prove a distinct nominal-current equality.
- Scalar projection produced zero mandatory measured criteria (`mandatory_projected_count=0`, recommended projection `not_recommended`). The declaration therefore hit `unprojectable_criterion` before a publishable search.
- Private candidate probe still retrieved four candidates. Its cache remained isolated and no candidate was rendered.
- The correction returned a declaration rejected by the existing resolver (one required facet, three compatible classifications). Its exact rejection reason is NOT established by the current bounded contract metadata. Do not claim a missing field or transport failure.

## Verification and cleanup

- 2,081 local V3/shared tests passed. Diagnostics include parity checks with a missing or throwing observer, privacy limits, and before/after/terminal integration coverage.
- Both temporary QA secrets were independently verified absent; 23 existing secrets remain. The UI cleanup harness reported uncertainty, but subsequent UI and CLI metadata checks confirmed absence; no values were displayed.
- Public function code stayed at SHA `0dbe89ff568a467b0b0d6fb12e226f312ba3bb7742fee154cf58a50597d281de` (v643 after shared secret refresh), JWT setting unchanged. No merge or public function deployment.

Next correction should distinguish the model-added nominal-current equality from the verified load/range relation and validate each mandatory property independently. Do not simply waive the second obligation or weaken the final-card gate.
