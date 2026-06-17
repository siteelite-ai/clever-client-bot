---
name: V3 Render/Escalate Guard (Step 6)
description: Server-side guards in chat-consultant-v3 that prevent LLM silent-drop of fresh search results — render auto-complement, escalate cancel, catalog_timeout retry hint, fresh-pool reminder.
type: feature
---

Server-side guards in `runExpertLoop` of `supabase/functions/chat-consultant-v3/index.ts`:

- Track `freshSearch = { tool, ids[], total }` after every successful `search_catalog` / `jargon_recover_catalog` (ids with `price>0` only).
- Track `shownIds: Set<string>` after every successful `render_products`.
- Track `triedLadderQueries: Set<string>` for `query` arg of search/jargon tools.

Guards (server-only, no hardcoded dictionaries):
- **6a Render auto-complement**: if LLM calls `render_products` with `product_ids` having `<min(3, freshUnshown)` valid cached items, merge fresh-unshown ids up to 8. Logs `v3_guard_render_autocomplement`.
- **6b Escalate cancel**: if LLM calls `escalate_to_manager` and fresh unshown pool ≥3 → cancel, auto-render top 8. Logs `v3_guard_escalate_cancelled` + turn_end `escalate_cancelled_autorender`.
- **6d Timeout retry**: on `error_code=catalog_timeout`, augment tool reply with `_retryable: true`, `_server_hint`, `_tried_queries` so LLM picks next ladder candidate instead of escalating.
- **6e Render-empty hint**: on `render_products` error with non-empty fresh pool, inject `_fresh_pool_ids` + `_server_hint` to push LLM toward correct ids.

Prompt hard_rules updated (schemas.ts): added rules 10 (source of id), 11 (catalog_timeout retry), 12 (clarify before ambiguous device queries), 13 (ladder before render/escalate).

## Step C — Honest-Split Fallback (added 2026-06-17)
**When:** `search_catalog` with `mode=by_filter`, ≥2 axes in `options`, `total=0`, Step 2 (inferred-filter) didn't already rescue.
**Action:** run each axis independently in parallel (`per_page=5`, same category, `options={axis:[values]}`). If ≥1 axis returns items → inject into tool reply:
- `_intersection_empty: true`
- `_split_axes: [{axis, value, ids, total}, ...]`
- `_server_hint` instructing LLM to admit honestly and render union of ids.
Also feeds `freshSearch` so Step 6a/6b can auto-render if LLM ignores hint.
Log step: `v3_guard_split_fallback`.
**Hard rule 14** in schemas.ts enforces the honest acknowledgement + single render call.
**Closes:** "кукуруза + E27" intersection case and any "X для Y" with empty intersection.
