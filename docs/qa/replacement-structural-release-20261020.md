# Verified structural replacement release — 2026-10-20

## Scope and release boundary

The direct replacement route now distinguishes a uniquely verified source product from independent customer requirements. For a source-only analogue request it derives a conservative shortlist from the *live* catalog facet schema and source detail: product kind, mounting, diameter, power, luminous flux and voltage are required to admit this route; other confirmed properties (including socket, driver, IP and light color) are enforced when present. Every returned product is checked against its own detailed catalog values. This is a candidate shortlist, **not** a guarantee of interchangeability or cut-out fit.

No product ID, model, category name, or customer wording is allowlisted. Categories without the complete technical signature keep the previous route. Contradictory source evidence fails closed. The widget frontend, routing, settings, database schema, and public admission were not changed.

## Evidence before production

- Local: 1,475 shared/function Deno tests, 286 Node QA/widget tests, v3 and private-preview type-check, and `git diff --check` passed.
- Closed preview, exact DN027B customer message: [final report](reports/preview-structural-dn027b-color-20261020.json) PASS. One Philips MESON 40K neutral downlight survived full live-page proof; the 65K cold-white variant was excluded. The selection contract contains the source-backed `Цвет свечения=нейтральный` obligation and ten other structural obligations.
- Adjacent closed-preview tests: [GX53 and Acti9 PASS](reports/preview-structural-neighbors-20261020.json). The black double-socket case is marked FAIL by a title-only oracle, **identically** on [current production baseline](reports/prod-baseline-black-socket-20261020.json). All four returned product pages have `Количество разъемов=2`, black color and electrical socket type; three short API titles omit the word “двойная”. This is not introduced by this change. Keep the pinned v4 acceptance matrix unchanged until its title-vs-live-facet rule is reviewed and re-pinned separately.

## Remaining limits

- This is not a universal analogue guarantee: incomplete catalog specifications can prevent the structural route; staff or product passports must confirm electrical and physical interchangeability.
- Existing public-admission exposure is unchanged: direct Supabase fallback remains available and the shared admission mode is off. Do not label this functional release a full security sign-off. The structural route may inspect up to five catalog pages on a source-only request, so monitor its request rate and cost. Harden admission across direct/proxy and legacy entrypoints in a separate measured release.
- Production verification, version and rollback reference must be recorded after merge and deploy.
