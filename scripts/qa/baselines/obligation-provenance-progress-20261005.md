# Obligation provenance and classifier cleanup

Latest full matrix remains 18/28 on f5f82c58. Do not substitute the partial checks below for full acceptance. Production untouched.

## Implemented and locally checked

- `5116ac03`: authoritative customer-owned live-facet proof can establish an exact obligation without a repeated necessity verb in model prose. Wrong values/units and model-only defaults remain rejected.
- `5d3948d9`: count-label statements and count units such as `шт` reuse the existing schema count resolver and canonicalize to dimensionless counts. Rejection diagnostics distinguish original property validation from later classification cleanup.
- `60c14bbe`: a live facet's own label is not a distinctive token of one sibling value. Live catalog included `Тип цоколя` / `без цоколя`; the previous discriminator treated `цоколь` alone as proof of that sibling and deleted the valid E27 requirement. Red/green regression reproduces this exact mechanism. 890 shared tests and Edge type check pass.

## Live evidence before 60c14bbe

- Sockets, candidate 5116ac03: PASS for black then white, hidden mounting retained. Requests `30a5ecf7-0c99-48eb-8a78-efd9f8922c28` (6285 ms), `dd7f8577-7492-4a75-9f87-12ee3ce5f8ce` (4081 ms).
- Motion-light case: no internal errors, but first turn asked an additional location question; subsequent output still included acoustic products. Case FAIL and sensor conflict remains unresolved. Requests `8a36430c-0d95-490b-b267-926776e85392`, `8ba07ef0-0edc-4f3f-8765-f2e2620f4944`.
- Breaker initial rerun still rejected `1 шт`: `fe76649f-cb23-4574-8106-618f0ee9ad3b`; prompted count-unit normalization.
- Probe overlapping the end of the 5d3948d9 deployment returned four correct-looking breaker cards (automated PASS, `e2d3ebe8-524d-472c-9b54-19932bb0eafb`, 11470 ms). Because runner launch preceded CLI completion observation, repeat after a confirmed deployment before treating this as version-pinned acceptance.
- Lamps still failed: `1287d5f5-2285-4dae-83a8-6b293ec9cfb7`; diagnostic stage `classification_cleanup`, `source_not_visible`. The E27 sentence was present and valid before cleanup but absent afterwards. Live facet read identified `без цоколя` as the false sibling signal.

Open work remains: complete preview regression/browser tests, numerical/per-item scope, necessary-class consistency, retrieval/deadlines, sensor metadata conflicts and context boundaries. No merge/deploy authorization for production.

## Confirmed preview 678 checks (60c14bbe)

Management API confirms preview version 678 and unchanged production 448. These tests started after CLI deployment completion:

- Breaker 1P / 16 A / C under 1000: PASS, four cards, 8679 ms, request `057f5e60-138b-46df-a62c-1d0e2a64cdce`.
- Warm E27 / 3000 K lamps: PASS, four cards, 6999 ms, request `fac15bce-3289-470a-a05f-d2a5e293a896`. E27 source survives classifier cleanup; output contract includes E27, 3000 K and LED type.
- Both outputs still contain verbose “working hypothesis” boilerplate; technical success does not certify UX quality or full semantic coverage.
- Full 28-case rerun started on this same preview after these checks. It must finish before another deploy; results pending, not a new overall pass count.
