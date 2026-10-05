# Preview 681 progress — 2026-10-05

- Production API version verified 448; preview 681, deployed code 4ab3400e.
- Draft PR 67 stays unmerged.
- Local regression: 893 passed; main function type-check passed.

## Changes and causal checks
1. Preview679 scope clarification displayed text but did not persist state: freeform=true with nonempty options violated executeProposeClarification. Integration test reproduced the rejection; discriminated clarification type and freeform=false now preserve slot state.
2. Preview680 living-room continuation returned 3 ceiling fixtures after one-item choice (8159f6ab-f87d-42d4-ba90-a864f2e83a44).
3. Confirmed customer criteria now feed the obligation validator directly from the server-frozen plan. Equality, property name, value, units and user_explicit provenance must match. Derived model criteria cannot use this proof. No catalog-specific dictionary or numeric relaxation introduced.
4. Preview681 targeted controls: four of four passed (see frozen-proof-preview681-20261005.json): novice25A/1P/C,16Aunder1000,E27warm,black→white sockets.
5. Browser preview681: initial request2d7d098c-f349-499e-ba44-27db4b4a3d45; one-item replyd853c5ce-cb63-4d24-9278-89e4d64a780d. Three cards ARIS-B60W, BLISS-B45W, DAINERIS-B48W visible. Screenshot /private/tmp/220volt-preview681-living-room.png.

## Remaining failures and caveats
- Parking continuation still fails, log9c47ee5b-f640-40bc-80f8-074691958cc4. Scope now retained, but model recomputed total from10000lm to50000lm without a justified new premise. Per-item quote starts mid-sentence; IP65 lower-bound wording rejected as unestablished necessity. Do not address only quote validation: preserve/validate demand across configuration transitions.
- Original living-room single-turn acceptance is NOT closed by passing an additional clarification path.
- Motion sensor acoustic contradiction, AC cable scope/proof, outdoor CCTV evidence and reasoning-vs-contract prose remain open.
- Last FULL matrix was preview678:22/28. Four targeted passes do not establish new full-matrix score or production readiness.

