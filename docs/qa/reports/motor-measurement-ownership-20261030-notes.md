# Measurement ownership experiment — 2026-10-30

Status: FAIL. Do not merge/promote this draft as a verified motor-selection fix.

Code commit: `6794dfe9`. The change aligns original and repair instructions, distinguishes customer conditions from unverified model hypotheses, and supplies the existing server-compiled load/range relation to both calls. It does not remove, waive or replace a product proof gate. It is an instruction/data-handoff improvement, not the completed architectural separation of requirements from prose.

## One live request

Motor: 3 kW, 380 V, three phases, direct start, 6 A nameplate load current. Request ID `2f7f635b-82bd-4e7c-be41-c70ce4e5c76e`.

- All four catalog preflight checks passed (HTTP 200).
- Chat completed HTTP 200 in 17,770 ms; zero products; safe refusal, no connection error.
- Before repair: the model again declared setting range `4-6.3` and exact nominal current `6.3`; neither was an explicit customer mapping. Generic mandatory scalar projection remained empty. Range coverage rejected the independent nominal equality with `separate_numeric_facet` at facet index 1.
- Private retrieval found four candidates; no shared cache and no public rendering.
- Repair returned three required-facet IDs and three classification IDs. The newly added resolver diagnostic reports `unsupported_per_product_claims`. This locates rejection inside the existing per-product claim scrubber, but does not identify the particular sentence or demonstrate that each individual declared condition was invalid. Do not infer an exact rejected sentence from this code alone.

The prompt improvement did not solve acceptance. Further prompt-only retries are not evidence of a systemic fix. The next implementation must give independently enforceable product obligations their own compiled representation/provenance, separate from customer-object facts and tentative model prose. It must preserve independently requested conditions, exact customer constraints and final-card checks. Do not simply ignore nominal-current conditions or mark a range certificate as proof of another property.

## Verification and safety

- Focused offline tests: 21 passed. Full V3/shared suite: 2,084 passed. Type check passed. Offline success does not override live failure.
- New offline coverage: repaired incomplete relation reaches public cards only after the existing strict range proof; incompatible 7–10 A remains rejected. A separate unresolved product-voltage obligation still refuses cards.
- After cleanup: 23 existing secrets, zero `V3_CLOSURE_ACCESS_*` / `V3_CLOSURE_CATALOG_*` secrets. UI harness and independent CLI metadata both confirmed absence.
- Public code remained SHA `0dbe89ff568a467b0b0d6fb12e226f312ba3bb7742fee154cf58a50597d281de`. Version counter moved from 643 to 646 following shared secret refreshes, not a public code deployment.
- Protected preview only: v247, JWT verified, bundle SHA `013f27dedb856d958dde96ec210eb9dce10d76740b15625fc9ec69a89952223e`.
- No main merge, public function deployment, Lovable publication or server3 change.

Diagnostics were retrieved with the existing CLI credential through Supabase's documented `/database/query/read-only` endpoint. This avoids depending on Chrome for reading these logs. Lovable's database query connector cannot access this externally managed database. Native browser control reported the Mac locked; no unlock or lock bypass was attempted.
