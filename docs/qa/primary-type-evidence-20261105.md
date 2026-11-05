# Primary catalog type evidence — PR146, 2026-11-05

## Scope and cause

This follows `operating-point-live-domain-20261105.md`. The captured real
catalog has four cards that independently prove the customer's 6 A point in a
trip-setting interval and 380 V in an explicitly stated operating-voltage
interval. Their commercial titles say «Пускатель», while their exact live leaf
says «Автоматы защиты двигателя» and their own descriptions begin
«Автоматические выключатели серии NS2 предназначены…».

The previous title-only identity check discarded these numeric matches. Also,
the measured-conjunction route did not expose its completed proof to the
existing complete-contract class verifier (which knew only application-rule
contracts). Neither is a reason to equate every starter with a circuit breaker.

## Shared rule

The ordinary visible-title verifier remains unchanged. The complete-contract
verifier can additionally accept a one-word class in a richer exact live leaf
only if all these hold for the same card:

1. The mandatory contract is nonempty, complete, valid and A-level, and that
   card passes it.
2. The card's leaf equals the discovered live leaf, whose text proves the class.
3. Its own sanitized catalog description starts with a positive primary class
   assertion, not an arbitrary mention or a compatibility statement.
4. That assertion declares a series/model identifier bound at token boundaries
   to the card's visible title. A different series or longer unrelated code
   cannot satisfy it.
5. Accessory/relational subjects and titles, explicit negation, missing or
   ambiguous evidence fail closed.

The terminal measured route may use this rule only after the independent
measurement conjunction is complete and the discovery scope is unchanged.
Current-range and operating-voltage proofs are rechecked on raw cached SKU
fields before class admission and again at existing card egress. Search-result
membership and model prose alone cannot establish these facts.

`v3_catalog_primary_type_verified` records the admitted IDs, class, live leaf
and evidence route. No product IDs, brand names, category names or
«пускатель = автомат» substitutions are encoded in the rule. An unrelated
lighting fixture unit test checks reuse outside motor protection.

## Offline evidence and limits

- Full real-handler replay uses the committed real catalog excerpt with
  intercepted catalog/model transports; it makes **zero live LLM calls**.
- Positive replay must render exactly 28903, 28913, 29287, 29288; every other
  captured candidate is checked absent, including scalar 660/690 V ratings and
  a current-setting interval that does not contain 6 A.
- Negative real-handler replays remove own descriptions or make the titles
  accessories while retaining the copied descriptions and numerical fields.
  Both must render zero cards.
- Unit checks cover missing/incomplete contracts, failed criteria, wrong leaf,
  wrong series, code substrings, negatives, accessories and sibling subjects.

This is a conservative source-evidence grammar, not universal natural-language
type recognition. Unsupported description forms still fail closed. Correctness
of the catalog's own primary assertions is a data-quality prerequisite; this
does not certify an electrical installation or manufacturer coordination.

Final local result: **2,232 passed, 0 failed** (57 seconds), including the
positive and both negative real-handler replays. `deno check --no-lock` for the
public handler and replay suite and `git diff --check` passed. The full free
regression command was:

```sh
deno test --no-lock --allow-read supabase/functions/_shared/v3-tools/*_test.ts supabase/functions/chat-consultant-v3/*_test.ts
```

The commit and CI result are recorded in the PR follow-up. This phase
does not establish live customer acceptance: no new QA access pair, preview
deployment, production change, merge or paid request is performed here.
