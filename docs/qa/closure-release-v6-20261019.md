# Functional release candidate v6 — 19 October 2026

Scope: the existing Lovable widget and Supabase `chat-consultant-v3`. No server3 migration, widget-loader change, database migration, or change to legacy endpoints is included.

## General corrections, not phrase-to-answer rules

- Replacement search separates **source identity** from the target's transferable requirements. A source brand/series or model code cannot become a required alias on every analogue. A compact source with a live ambiguous structural facet asks for that facet before showing cards; a server-owned clarification continues the same replacement scope.
- The visible list of mandatory facets is reconciled with the frozen search criteria. Optional engineering hypotheses are not presented as mandatory filters.
- Result-cardinality shortage notices state the number actually shown and offer to relax a condition, rather than silently broadening the product class. The user agreed that the strict household sensor/budget request may show one exact card plus this offer; other multi-card expectations remain unchanged.
- The UPS safety route now searches a bounded live catalog window and accepts only a card with independent proof of UPS class, pure sine on **output**, sufficient active **W** (not just VA), positive price, and availability. With insufficient catalog evidence it gives safety advice and an honest gap, never an invented SKU or a stabilizer/ATS substitute. This is a safety profile over catalog evidence, not a hard-coded item.
- Rendering returns IDs of the cards actually shown; a skipped zero-price or missing-cache card cannot be persisted as if displayed. Server-authored shortage prose retains its paragraph boundary through the shared price-output guard.

## Preview evidence and limits

Preview function `chat-consultant-v3-closure-preview` was updated in isolation; production remained at v465 (`ezbr_sha256` `0b4875ee4bccd6ab4dbb98ba80ccc561aff310a6ef75b3ff8c24a4f8dcc40570`) during these tests.

| Case | Result | Evidence |
| --- | --- | --- |
| Acti9 C16 analogue, then 1 pole | PASS: first asks poles, then four 1P C16 cards | [v58 Acti9](reports/closure-preview-v58-acti9-20261019.json) |
| Household motion sensor ≤4,000 ₸, several requested | PASS under the agreed rule: one source-verified exact-class card, actual count stated, offer to relax | [v58 household](reports/closure-preview-v58-household-20261019.json) |
| UPS for a 250 W boiler | PASS as a safe catalog-backed gap: seven cards inspected, none independently proved; no misleading recommendation | [v58 UPS](reports/closure-preview-v58-ups-20261019.json) |
| Generator/boiler safety | PASS: generator rating is not treated as boiler load | [v57 generator](reports/closure-preview-v57-generator-20261019.json) |
| Gallant assortment → double sockets | PASS with four same-series cards | [v57 Gallant](reports/closure-preview-v57-gallant-20261019.json) |
| TTU for 10 mm cable | PASS with four source-verified 12/6 cards | [v57 TTU](reports/closure-preview-v57-ttu-20261019.json) |
| DN027B full product identity and compact model code | PASS in both one-run checks: four analogue cards, source model excluded | [full identity](reports/closure-preview-v58-dn027b-20261019.json), [compact model](reports/closure-preview-v58-model-code-20261019.json) |

The earlier [v55 Acti9 failure](reports/closure-preview-v55-acti9-20261019.json) is retained as the counterexample: it showed mixed poles before clarification and lost the scope on the follow-up. The v58 result establishes the correction on the later build. These are deliberately one-run focused checks; the full 190-run/279-turn release matrix remains `NOT_RUN`, not silently counted as passed. The [v6 inventory](release-inventory-v6-20261019.json) pins the exact cases and expectations.

Local gate on this candidate: `deno check` production and closure-preview functions, 1,290/1,290 Deno tests, 251/251 Node QA tests, pinned ledger check, and `git diff --check` passed. GitHub CI on the initial PR commit also passed. PR merge, production deploy, and post-deploy browser smoke are still pending at the time of this note.

## Security and rollback boundary

This functional release does **not** claim that public paid APIs are fully protected. Production v3 was observed as a publicly callable function (`verify_jwt=false`); the repository's global admission guard is optional/off by default, and `observe` is not enforcement. The legacy `chat-consultant`, `chat-consultant-v2`, and `search-products` routes remain public. Turning on a project-wide cap without measured live traffic could deny real customers. Admission enforcement and legacy-route audit require a separate measured rollout; do not disable routes without consumer evidence.

The rollback anchor is main commit `e8dba584decb61262eb4d19fcfa5baf493370cf6` plus production v465/hash above. If a production regression appears after release, redeploy the prior `chat-consultant-v3` source from that commit and revert the new PR. No database reversal or widget-loader edit is involved.
