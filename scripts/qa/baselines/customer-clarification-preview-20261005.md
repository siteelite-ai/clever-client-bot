# Preview audit — 2026-10-05

## Release decision

NOT READY FOR PRODUCTION. PR #67 remains a draft. Passing automated checks
are not equivalent to acceptance of the customer-visible answers.

Production `chat-consultant-v3` was verified at version 448, unchanged.
Preview 646 tested commit `3f4394ebe694b9ee8ff2473707ea65d2aefd8f4b`.
The subsequent text-only clarification compatibility change is commit
`5de61e4927bfeb27ddf6442c7f84e085b9317459`, deployed only to preview.
The customer's exact failing requests/environment in the latest message are
still unknown; these results concern our independently reproduced cases.

## Changes

- Advance past answered readiness facets; retain original request and ask only
  for the remaining inputs, including free-form answers.
- Preserve the product-type query alongside numeric facets instead of letting
  numeric filters erase it. Exact compound marking retains precedence.
- Explain a repeated catalog-selection request in an active clarification,
  preserving the live facet IDs and numeric choices.
- Include the available choices in assistant text. `public/widget.js` consumes
  but does not render `quick_replies`, so a promise of buttons below was unusable.
- Add an exact repeated-answer gate to acceptance checks.

## Verification

- Shared V3 tools: 843 tests passed on 3f4394eb.
- Edge Function type check: passed on 3f4394eb.
- Acceptance evaluator: 30 tests passed.
- Final readiness text change: all 43 readiness tests passed.
- GitHub type-check workflow 37287801851: success on 3f4394eb.
- Customer audit suite: 27 of 28 automated cases passed on preview 646.
  The failing case is `audit-15-analog-cctv-outdoor-cable`.
- Five new progress cases: pump, underground, surveillance class and floodlight
  progress passed their automated checks. Acti9 progressed correctly but failed
  a required wording fragment; final follow-up produced four 1P/16A/C cards.
  These automated checks have the manual limitations below.
- Browser with actual `public/widget.js` and preview harness: underground
  answer advances rather than repeating the installation-method question.
  Request IDs: `c0641b6f-cd63-404f-9e29-4dce04b5ecf0`,
  `1498bcea-a4b2-41b1-92b9-00f5f013587a`.

## Still open / release blockers

### Invalid structured reasoning

`audit-15` request `1ba64fcc-cbbd-4855-a73b-eebc144ed859` failed with
`derived_selection_reasoning_contract_invalid` after about 15 seconds.
The first declaration triggered measurement correction; the correction response
ended with `finish=length`, a `google:python_interpreter` tool call and no
`declare_selection_reasoning`. The server correctly rejected it, but the
customer receives `internal_error`. This is not a browser-cache explanation.
Do not bypass the contract or silently render unverified products.

### Application suitability is not fully proven

Four-turn surveillance request `1dd62965-147c-47ef-aedc-edd22ae2bc6e` now
returns coaxial products instead of UTP. However, the response does not prove
outdoor suitability of both returned products. The test checks product class,
not all application constraints, so its PASS is insufficient for release.

### System totals versus individual-product recommendations

Floodlight request `21cdb77c-6d87-4b56-bbb3-6bef9590c447` states a recommended
4000–5000 lm / 50–70 W product, then appends a system-total disclaimer and
renders a pool including a 10 W product. The automated test only checks that
there are several floodlights. It does not prove agreement with the explanation.
Need a consistent typed contract for aggregate demand and individual-product
requirements, not a product-specific exception or weaker assertion.

### Additional browser blocker: changing topic while clarification is pending

After the underground-cable dialogue, the actual widget was sent
`Новая тема. Есть ли аналог автомату Schneider Electric Acti9 C16?`.
It repeated the underground-cable clarification instead of switching to the
breaker. Request `c744331c-3910-4951-875a-2261cf731554` on the final preview
candidate reproduces this. An explicit new task must take precedence over a
pending readiness scope. This is a release blocker, not a passing browser test.
Resetting the local test chat was denied by the tool's approval gate; the reset
was cancelled, the history was preserved, and no alternate deletion was used.

### Final isolated Acti9 check

After the text compatibility change, all three turns passed: initial question,
plain-language explanation with visible choices, then four matching 1P/16A/C
cards. Request IDs: `d12ebba3-c994-40d8-a316-f9e326cd4552`,
`788907bc-ec3c-459a-a64d-d36f4629c911`,
`c14fc3fb-52b5-4b19-b2bc-fed963555107`. This is an API-dialogue pass, not a
successful browser topic-switch test.

## Next gates

1. Obtain the customer's failed transcripts and request IDs; verify the endpoint.
2. Add assertions for suitability evidence and explanation/card consistency.
3. Diagnose the structured-reasoning correction contract and total/per-item
   conversion on the recorded cases, without broadening unrelated routes.
4. Re-run targeted dialogs repeatedly and then the cross-category suite.
5. Repeat actual-widget browser checks before requesting production approval.

Ordinary Lovable preview currently targets the production function. The local
`scripts/qa/widget-preview-harness.html` explicitly routes chat requests to the
preview function. Do not identify a test environment from widget version alone.
