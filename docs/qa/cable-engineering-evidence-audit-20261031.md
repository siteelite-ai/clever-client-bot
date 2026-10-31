# Cable selection: evidence audit and safe next boundary

## Scope

Requested on 2026-10-31: work through blocker #2, pump and underground cable selection. Baseline is published main `ad2773a93b0c9daefc814af940a4f86e53922228`, public V3 v659. Changes are prepared only in `fix/engineering-evidence-boundary-20261031`; no deployment, database/secret update, model switch, frontend change or migration.

This is not a completed automatic cable-sizing feature. Do not label the blocker closed on the strength of the input-validation tests.

## Findings

1. `pump_cable` collects a customer current, supply, distance band and installation method. Those are planning inputs, not proof of a particular cable cross-section. An outdoor stationary choice does not by itself establish immersion/burial suitability. The distance bands are not exact length evidence for a completed voltage-drop calculation.
2. `underground_cable` previously treated method, load, supply, cores and PE as enough to leave input readiness. It did **not require line length**. Reproduced offline before editing. Therefore a completed clarification sequence could still lack a relevant calculation input.
3. The old pump distance regexp accepted `0 м` and unrelated dimensions. The common replacement owns the quantity by role, validates positive/ascending values, preserves individual customer-turn units and respects a later invalid/revoked length. It is shared by both route profiles rather than matching the wording of the two customer test questions.
4. Neither profile supplies a certified cable-sizing calculation. The recently released motor certificate relates a working current to an adjustable current-setting range. It must NOT be reused as a current-to-cross-section conversion, nor may a cable's nominal voltage be mistaken for ampacity.

## Bounded live catalog evidence (no LLM calls)

Public `search-products` was queried using the existing public widget credential; no integration key was read or copied. Category discovery returned HTTP 200 with 132 categories. Three exact, discovered cable-category facet requests followed:

| Category | Observed result | Permitted conclusion |
| --- | --- | --- |
| Кабель ВВГ | HTTP 502 | Facets unavailable in this attempt, not evidence of missing characteristics |
| Кабель КГ | HTTP 502 | Same; do not invent an empty catalog |
| Кабель и провод разного назначения | HTTP 200, 36 facets | Construction, material, core count, cross-section, voltage, insulation, temperature and purpose fields exist; this response has no ampacity/installation-derating/voltage-drop calculation fields |

[Sanitized inventory](reports/cable-facet-inventory-20261031.json) retains field identities and counts only, no product cards, restricted product details, file URLs or secret values. A `Файл` field exists: this may be a route to technical documentation, but its content and applicability have NOT been checked. These bounded results do not establish the absence of engineering data throughout the catalog or manufacturer documentation.

## Implemented, not published

- A common route-length ownership/validation rule for the two line profiles.
- Underground line length is now an explicit freeform `line_length` axis. After PE is answered, a missing length is asked rather than silently starting final selection.
- Already supplied line length is not asked again; range choices for pump planning remain accepted. A planning range is explicitly not a certificate for voltage drop.
- Height, depth, diameter, millimetres, zero/negative lengths, descending ranges, cross-turn borrowed units and later revoked values do not silently complete that axis.
- Existing exact catalog queries and unrelated product profiles remain outside this change. The final compatibility gates have not been weakened; no cable rating, cross-section table or fallback SKU was added.

Example newly corrected transition:

> Customer has already supplied: direct burial; 220 V / one phase; 16 A; three cores; PE included.
>
> Bot: «Осталось уточнить: длину кабельной линии в метрах. Укажите длину кабельной линии в метрах конкретным значением — без этих данных я не буду считать подбор подтверждённым. Можно ответить обычным сообщением.»

Providing that answer completes this input check only. It does **not** certify any purchasable cable.

## Decision required for closing blocker #2

The user was asked to choose between the following scopes. Neither is silently assumed by this patch.

### A. Bounded catalog MVP

- Explicitly distinguish catalog lookup of a specification from calculating a suitable specification.
- If a customer has a project/passport cable designation and cross-section, search the live catalog against those explicit constraints. Do not describe a successful lookup as an independent design certification.
- Otherwise explain what is unverified and ask for the specification or a specialist calculation. Do not ask repeatedly for already known load/supply/length, invent a cross-section or return «ничего не найдено» as if the catalog were empty.
- A proposed question is: «У вас есть марка, число жил и сечение кабеля из паспорта насоса или проекта? Напишите их — проверю подходящие позиции в каталоге. Если расчёта нет, сечение должен подтвердить специалист с учётом условий линии.»
- Existing exact-SKU/catalog paths should remain separate from engineering-fit claims. A generic approval string such as «я согласен» must not bypass mandatory proof.

This scope reduces automation; it requires explicit product agreement before changing the completed-input behavior.

### B. Automatic engineering selection

Build one server-side evidence pipeline, not per-question exceptions:

1. Typed, role-owned customer inputs (load current, supply/phases, line length/bounds, installation environment, cable construction, loaded conductors and protection context). Missing/ambiguous inputs remain questions, not model assumptions.
2. Approved technical reference data with source, edition, applicability and operating conditions. It may be an applicable construction-specific normative table or manufacturer data; absence of an ampacity facet on every SKU does not make automation intrinsically impossible. Applicable national rules must be established before treating a reference as the release criterion.
3. Deterministic, versioned calculation/verification for current capacity and correction factors, voltage drop including relevant motor-start conditions, and protection/short-circuit checks within the explicitly supported scope. LLM prose does not issue the certificate.
4. Translate the validated specification to exact live catalog filters; recheck identity, construction, cross-section, customer criteria, visibility, price and positive stock on every final card. A calculated area alone is not final installation suitability.
5. Explicit outcome types: `missing_customer_input`, `missing_reference_data`, `catalog_unavailable`, `no_matching_product`, `verified_candidate`. Different outcomes must not collapse into one empty result or connection error. A missing source cannot be fixed by another paid model retry.

Primary technical basis: Schneider Electric's [conductor-sizing methodology](https://www.electrical-installation.org/enwiki/Conductor_sizing%3A_methodology_and_definition) and [general cable-sizing method](https://www.electrical-installation.org/enwiki/General_method_for_cable_sizing). These describe the engineering distinction; this draft does not adopt a numeric table or legal standard from those pages.

## Checks and honest limits

- Before fix: 3/6 initial targeted checks failed, reproducing missing underground length and invalid pump length acceptance.
- After fix: focused ownership, readiness and actual mocked HTTP/SSE dialogue checks cover the underground choices through PE and a length question with **zero** model/catalog requests, then verify that the exact `25 м` answer advances with PE/context preserved. A synthetic outage prevents any real model/catalog request after readiness; this tests routing, not cable compatibility. Existing motor range/card tests and stale-card denial remain in the same test file.
- An intermediate full run failed only because the reused test harness assumed every terminal freeform question was about current. The assertion was extended to check the explicitly expected length axis, without removing the freeform/content or zero-external-call assertions. Earlier 2,104-pass run precedes the final revocation test; record the final result separately.
- Final unchanged runtime candidate: **2,106/2,106** full offline Deno tests passed in 38 s; focused set **85/85**, public entrypoint Deno type check and `git diff --check` passed. No source edits followed this final run.
- No live paid chatbot test has been performed for this draft. The live API facet inventory is not a live end-to-end cable selection PASS.
- Automatic sizing, manufacturer-file validation, source population and complete pump/underground SKU acceptance remain NOT_IMPLEMENTED/NOT_RUN, pending the selected scope. Public v659 has not been changed.
- Independent post-work metadata still shows public v659 / `verify_jwt=false` / SHA `2d6d7e35271487fd34da3d637087f8c84253223be1396b3e0fb53f025164369b`. No runtime was deployed for this draft.
