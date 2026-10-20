# Final mandatory-facet guard — release evidence, 20 October 2026

## Candidate and boundary

Commit `3f6f6eae` adds a category-independent final contradiction check after
recovery has assembled product cards. Each frozen level-A criterion is checked
against the final card's own explicit traits and catalog facets; first-class
price and the existing live-sibling title guard remain in force. OR values on
one facet stay alternatives. Missing compact traits alone do not negate an
earlier search proof. No category, product, model or customer phrase is
allowlisted. The frontend, search routes, settings, and schema are unchanged.

The acceptance matrix is re-pinned as V5 for one source-text correction:
BT-746 uses the customer's exact «Найди двойные черные розетки
электрические». Short API titles need not spell out the connector count; the
live product page must independently prove two connectors, black/graphite
colour and electrical subtype. V4 stays available as historical evidence.

## Checks completed

- Local: `deno check` passed for the Edge function and new test; 1,424 shared
  v3-tool tests passed, including seven new cross-category final-card tests.
  145 Node QA tests and the V8 inventory consistency check passed.
- Before this backend candidate, the exact BT-746 production prompt passed a
  targeted run with four independently verified product pages:
  [report](reports/production-v5-black-socket-exact-client-retry-20261020.json).
  An earlier same-prompt run failed only because two independent page fetches
  were transiently unavailable; those pages subsequently verified. The older
  synthetic paraphrase, which omitted «электрические», must not be used as a
  claim about the customer's exact request.
- Closed preview `chat-consultant-v3-preview` deployed at v769, bundle SHA-256
  `8ef763c9e7678396f25939cf03358b63171deb749a7374bb0fc2b696ec30205d`.
  Its missing-secret request returned HTTP 403. A temporary independent QA
  secret, never recorded in Git or test output, authorized three selected
  customer scenarios / five turns. DN027B analogues, Acti9 clarification and
  the exact BT-746 prompt all passed; all nine returned product pages were
  verified: [preview report](reports/preview-v769-facet-targeted-20261020.json).
  The temporary QA secret was removed and its absence confirmed. Preview
  later shows v771 after secret propagation, with the same bundle hash and
  `verify_jwt=true`.
- Production v3 remained on bundle SHA-256
  `d51d1308f3425b40438dbc2c225c69c9b5dce9770070b349a05ec0f9ace525f9`
  throughout preview checks. Its version counter advanced with project-wide
  secret propagation, not a code deploy; v533 still has that same hash.

## Release gates and rollback

This targeted proof is not a pass for the full 190-dialogue acceptance matrix;
V8 retains `NOT_RUN` for the full inventory. Public API admission is in
`observe`, not `enforce`; the separate security gate remains open. Before
production, require GitHub CI success on this commit and a PR diff review.
Deploy only `chat-consultant-v3`, verify its new bundle hash and a targeted
browser request. The widget JavaScript did not change, so no Lovable frontend
publication is required for this backend-only candidate.

If the candidate regresses, redeploy `chat-consultant-v3` from the previous
PR #109 source (`origin/main` before this merge) and revert the new PR. Do not
roll back the unrelated additive admission schema or change its mode as part
of this functional rollback.
