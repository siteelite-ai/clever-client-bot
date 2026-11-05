# Operating point → live domain, 2026-11-05

## Factual reproduction, no new paid chat

Two read-only calls to the existing `search-products` API: category_facets for
«Автоматы защиты двигателя», then one product page (per_page=100, pages=1,
total=67, returned=67). No private key extraction, new QA secrets, OpenRouter
request or customer dialogue. Full capture remains in the local QA evidence.
The committed fixture is a numeric-field/card excerpt (six facets, nine cards),
not a capture of a real model's complete response.

The real voltage facet has `unit=null`, caption «Номин раб напряжение, В»,
values `660`, `690`, `230-690`. There is no exact scalar `380`. The old
literal-number projector admitted scalars only. A synthetic exact-380 fixture
therefore did not reproduce this catalog representation. This establishes a
data-shape defect, but does not establish the precise missing text/operator of
the previously rejected live model declaration.

## General correction

- A literal customer operating supply point is compiled against one live
  working/input-voltage axis using its unit and physical role, including an
  abbreviated public caption. No product/category/brand/SKU dictionary.
- Strict scalar/closed-interval parsing only. `380 ∈ [230,690]` is supported;
  scalar `660` or `690` does NOT imply 380 V support. No tolerance, rounding,
  open-maximum inference or hidden engineering norm is introduced.
- Customer operating-point obligations survive model omission/prose cleanup.
  The resulting exact live options constrain search; the same raw facet key,
  caption and complete accepted interval are independently rechecked on each
  final SKU. Search membership alone cannot prove compatibility.
- Exact customer scalars keep the existing literal preference; an existing
  exact enum is not silently broadened into all overlapping range enums.
- A unit mismatch, ambiguous working axis, unsupported point or over-limit
  family fails closed. Insulation/output/coil/control/test voltage cannot
  stand in for the main operating supply. A scope without a working-voltage
  axis keeps its pre-existing path; this is not a new universal circuit-design
  or product-classification algorithm.
- The original adjustable-current certificate, system-total and paired-fit
  mechanisms remain separate. Operating certificates reset with discovery
  and are checked again at final render.
- Enum-set inclusion is not sufficient for interval implications: the actual
  customer point is compared to the model operator too. One interval that
  contains both 380 and 400 cannot prove `380 >= 400`.

## Replay result: numeric defect corrected, acceptance still OPEN

The real-handler HTTP/SSE replay uses recorded raw field representations and
actual card titles/values. Catalog responses deliberately ignore supplied
filters. It proves the outbound query includes both current intervals and
the raw `230-690` option. Four captured candidates satisfy the numeric
requirements. Cards with only scalar 660/690 are not treated as compatible.

The full customer scenario still returns zero cards in this replay because
of a **separate class-identity rule**:

| Stage | Captured replay evidence |
|---|---|
| Numeric constraints | Four cards pass current and operating voltage |
| Title identity | Only one other card literally passes «автомат» |
| Intersection | No card passes both groups; zero cards rendered |

The four numerical candidates have titles starting «Пускатель NS2…». Their
actual descriptions say «Автоматические выключатели серии NS2…» and the
catalog leaf is «Автоматы защиты двигателя». The current one-token title
identity guard deliberately does not use descriptions to rename classes.
It has NOT been disabled or changed by this correction. The regression test
explicitly asserts this separate refusal; it is a diagnostic fail-closed test,
not a successful motor acceptance test.

Next work is a generic, source-owned primary product-type proof across title,
exact taxonomy and the same SKU's own description, with negative tests for
accessories, mere compatibility, negation and copied class descriptions. Do
not add a «пускатель = автомат» alias, waive the identity guard, claim the four
numeric candidates are fully suitable, or call the customer case closed.

## Release boundary

Local regression/type-check results and checked commit are recorded in the
QA status. No new live model call is used to reach this result. Keep PR146 a
draft. No production/model/working-key/MODX changes and no new QA pair.
