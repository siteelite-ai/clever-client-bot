# Measurement ownership after clarification — 2026-11-05

## Status and scope

Initial implementation and offline verification at `7051eb00` are recorded below.
Subsequent authorised live preview QA **failed**; this document is not a green
acceptance or release claim. See the update at the end and
`conjunction-rejection-diagnostics-20261105.md`.

Base: `7d6571b4c7a155377ff74164d46336473fb3b47f` (merged PR146).
The previous complete-message production smoke passed, but did not cover the
same facts delivered through several clarification answers.

## Customer failure and evidence limits

Reported request: `97d0b955-9d00-493b-8f68-44e55cfe1c00`, final answer `6А`.
Read-only diagnostics show a completed continuation, not a connection failure:

- Server history retained motor selection, `380 В, 3 фазы`, direct start and `6А`.
- Readiness had no missing input; a customer-load current certificate was issued.
- Discovery found the motor protection category and its live facets.
- Measurement projection rejected a separate nominal-current obligation before
  `search_catalog`; no products were searched or shown.
- Diagnostic code: `separate_nominal_current`.

The rejected raw model declaration was not retained. The regression below is a
reconstruction of the confirmed guard failure, not an exact replay of unknown
model wording. Actual live-provider behavior still requires bounded preview QA.

## Causes and shared correction

1. The coverage guard treated every occurrence of “номинальный ток” as a separate
   selected-product rating, including an explicit, already-certified motor/load
   current. The correction reuses the existing load-current ownership parser:
   only one explicit source-side fact matching the server certificate can be
   discharged. It does not create a new current or certify a product rating.
2. A full real-handler dialogue regression exposed another gap: the bare answer
   `380 В, 3 фазы` did not retain its supply role when the independent voltage
   obligation was compiled. A strict standalone voltage-and-phase fact now
   retains that role across verified customer turns. Arbitrary product prose,
   output/coil/insulation values and conflicting answers are not promoted.

No request-specific branch, SKU, brand, voltage choice or current value was added
to runtime code. This is shared physical-role interpretation, not a promise that
all possible natural-language formulations are now supported.

## Safety invariants

- A current range must still be certified against live facets and contain the
  exact customer load point; each final SKU must prove its own accepted value.
- Product nominal current remains an independent obligation, even if its number
  equals the customer's current. Bare/unknown ownership is not accepted.
- Wrong current, kA instead of A, inrush/maximum current, negative coverage,
  repeated source claims and extra unproved numbers do not borrow the certificate.
- Independent voltage and other numeric requirements remain conjunctive.
- Supply coverage still needs the same live facet and raw value on each SKU.
  Scalar 690 V alone does not establish support for 380 V.
- Conflicting or corrected standalone supply answers remain unresolved.
- Missing primary product identity and accessory-only evidence remain refusals.
- Diagnostic addition is a bounded count, not raw customer or model prose.

## Offline verification

Red-before-green: the new ownership/conjunction regressions failed on the old
guard (39 passed, 2 failed). After its correction, the real four-turn handler
replay exposed lost supply ownership (1 rather than 4 products); the complete
message remained successful. Both issues were corrected before the full suite.

Final full suite: **2,239 passed, 0 failed** (55 seconds).

```sh
deno test --no-lock --allow-read \
  supabase/functions/_shared/v3-tools/*_test.ts \
  supabase/functions/chat-consultant-v3/*_test.ts

deno check --no-lock \
  supabase/functions/chat-consultant-v3/index.ts \
  supabase/functions/chat-consultant-v3-closure-preview/index.ts \
  supabase/functions/chat-consultant-v3/load-current-readiness-real-handler_test.ts

git diff --check
```

Type-check and whitespace checks passed. Handler tests have network disabled;
they use the existing real-catalog fixture and deterministic provider responses.
The following two paths each return the same four fixture SKUs (28903, 28913,
29287, 29288), excluding unmatched products:

- Complete motor request with 380 V, 3 phases, direct start and nameplate 6А.
- Motor request → `380 В, 3 фазы` → `Прямой пуск` → `6А`.

Other source owners (pump, load, compressor), 10 A and decimal 2.5 A are covered
by lower-level regressions. These are test values, not runtime exemptions.

## Remaining release gate

1. Draft PR and exact-head CI.
2. With approval, update only the closed preview and create a new short-lived QA
   pair. Run one four-message dialogue, without a broad paid rerun.
3. Stop the QA relay, remove precisely that new pair with exact-name confirmation,
   and record absence. No old QA credentials may be reused.
4. Only after live results, decide on merge/publication separately. Preserve the
   current public version and its rollback evidence until then.

## Live QA update — acceptance FAILED

The authorised four-message browser dialogue ran on the exact `7051eb00`
preview (official download: 120/120 files matched). All replies returned HTTP
200 with no transport error. The final `6А` reply reached readiness with no
missing inputs and a certified current range, but the independent measurement
contract rejected a voltage clause. Final request:
`e6f4f469-4cdf-4e98-b503-c5a755511eaa`; zero rendered products.

The private probe found four preliminary candidates; these are not accepted
cards. Exact rejected model wording is unavailable. Empty operating domains in
the old failure diagnostic cannot establish whether source-point resolution
failed, because any later conjunction rejection also clears the reported result.

Relay stopped at four messages. The exact new temporary QA pair was deleted
after user confirmation; absence was independently verified and the local
credential file removed. Public source hash/auth stayed unchanged. Secret
writes/deletions caused the documented restarts and raised deployment counters
(public v707, preview v323), without publishing new public code.

PR147 remains draft. No additional paid test, preview update, merge or public
deployment is implied by the subsequent diagnostic-only implementation.
