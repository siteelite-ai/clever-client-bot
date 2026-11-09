# Dialogue constraints and compound refinements — candidate only

Base: main `3944bb95b4466a884db7a73270222c5edbce9ba6`. Separate from deferred PR148 and PR149. This change does not publish production, alter models or keys, change frontend/MODX, or migrate the database.

## Shared behavior

- Restore selection obligations only from completed, verified server context. Treat the current customer turn as an axis-specific update, not an OR-union with all historical values. Preserve independent conditions and same-turn alternatives.
- Keep a current authoritative budget across search and final checks. Do not turn price into a nonexistent category facet or invent new product thresholds from historical application measurements.
- Retain the existing monotonic within-turn contract: model correction and recovery cannot resurrect a superseded customer value. Preserve card/class/compatibility/price/availability gates.
- Recognize bounded compound refinements by dialogue syntax, not product/brand/test-case dictionaries. A verified dependent head can carry multiple labelled conditions or a budget. The missing product head still requires server verification.
- Independent tasks and explicit topic changes discard the old scope, including preflight card proof. Unknown/explanatory prose is not forcibly converted into a selection.

Syntax limits: 800 characters, 6 clauses, 180 characters per clause. This is not a guarantee of understanding every possible natural-language sentence.

## Offline verification

Final combined suite: **2290 passed, 0 failed**, no network permission, cached dependencies only. Latest typed targeted run: **70 passed, 0 failed**. Earlier state-only typed run: 72 passed.

A first parallel run reported 2289/2290 because an unchanged exact-leaf timeout test with a 20 ms deadline was preempted before setting its mock signal. That file passed 4/4 in isolation; the final sequential combined suite passed 2290/2290. The timeout implementation and that test were not changed.

Real HTTP/SSE handler fixtures verify shape and budget replacement, preservation of IP65, an additional temperature condition, rejection of wrong-shape/IP/temperature/over-budget cards, rejection of fabricated browser history, and separation of a second independent product request. They are synthetic catalog fixtures, not live customer acceptance.

## One planned closed-preview dialogue

Only after exact-commit CI and preview source attestation:

1. `Нужна круглая люстра для гостиной со степенью защиты IP65, бюджет до 5000 тенге. Покажи варианты.`
2. `А есть овальные? Бюджет до 6000 тенге`.

Exactly two customer messages in one fresh session; no repeats. Confirm continuity, updated shape/budget, preservation of independent conditions, actual catalog retrieval and each card's proof/rejection. A verified empty result is not a successful product recommendation. Do not weaken eligibility to manufacture cards. Stop after this dialogue, inspect logs, remove only its newly created QA pair, and attest unchanged production/other-function source and JWT metadata.

This document records the plan, not a live PASS. Runtime evidence is recorded separately after the one authorized run.
