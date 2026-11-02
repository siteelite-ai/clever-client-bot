# One server candidate is still an actionable clarification

## Live evidence: exactly three messages, no repeats

Closed preview runtime a08b6522, frontend widget-bdc222dbbd5c4e7f:

1. `d1880688-9bf3-409d-b1e6-b9c54725a6e6`: request for a concrete bore,
   8 mm, SDS-plus. HTTP200 in4.192s. Server emitted a matching quick_replies
   event and pending slot with the single actual type `бур по бетону`.
   **Browser failed to render the choice.** Do not count this as a chip PASS.
2. `9e0aa64c-6c03-442c-9f09-0cc800fcb8a6`: typed that exact issued value
   manually, explicitly recording the UI workaround. HTTP200 in15.105s,
   error=null. Server verified the persisted readiness continuation, retained
   concrete/8mm/SDS-plus, applied diameter, shank and type criteria, and rendered
   one matching KRANZ8x110x50 SDS PLUS card (893₸). This proves this backend
   continuation, not universal correctness or complete catalog assortment.
3. `c2048c66-91f8-4697-a1a7-860041f3314a`: explicit new topic, cheapest
   ВВГ3*1,5. HTTP200 in4.698s, error=null. Separate new-task boundary and
   complete-category per-metre price proof;18 matching available products,
   winner301₸/м. No bore context leaked into the cable selection.

No fourth upstream request. QA relay stopped. The named pair
`1793631452_9ef56af9fb7ba22ce2493ad0ffa7e503` was deleted only after the
user confirmed the exact two names. Metadata lists no QA secrets; old access
returns403 on a malformed-body probe (no model call); local credential file
removed. Public function version692, unchanged bundle
522237f2a785aee9adbcacf3a54ca6954c05f1d78904ceb9707840b68e7a6f69,
JWT=false. Preview306 retains bundle234354453f8ec91f9a285a981c7ba800c6d94dc8eda1d3cd33ba9249a0263a9f,
JWT=true. Version increments here are secret propagation, not public deploys.
Permanent secret metadata unchanged.

## Root cause and shared correction

The server protocol can issue one verified candidate with allowSingleChoice;
the widget normalizer still rejected every quick_replies array shorter than2.
That same normalizer is used for live SSE, final unterminated SSE events and
persisted choice state. The mismatch hid an actionable question.

The widget now accepts1–5 options. No product/category vocabulary, invented
alternative, automatic confirmation or selection exception was introduced.
Exact pending facet, ordered values and labels, active slot, completed visible
turn/session, stale-choice protections and server-side authority remain intact.
Zero-option freeform questions still use their separate protocol. Styling is
unchanged (existing volt-quick-reply classes); design-continuity-guard guided
reuse, not a redesign.

## Verification and limitations

- New category-neutral test failed before the fix (0 chips instead of1).
- New tests cover1/2/5 options, persistence/reload, exact selected value and
  double-click suppression. Single-option negatives cover facet/value/label/
  cardinality mismatch and partial streams; existing limits reject0/6 options.
- An old fixture which classified any one-option array as invalid now explicitly
  supplies a mismatched two-option pending slot. Its security assertion remains.
- Initial concurrent local run had timing-sensitive transport failures under
  browser/build load and the stale one-option fixture. It is retained as failed
  evidence, not counted as a PASS. After fixing that fixture, the bounded serial
  widget/loader/Gallant run passed **93/93,0 failures**,12.103s. The final
  serial run without forced process exit also passed93/93 in8.299s and exited
  normally with the same60s per-test timeout now used in CI.
- Syntax, content-hash release contract and Vite build passed. Existing warnings:
  old Browserslist data and large admin bundle; no dependency upgrades here.
- CI now runs widget state and scope regressions, not just loader/build checks.
- Real recorded SSE was replayed locally with external connections blocked:
  updated widget26ebaed1b19f076d visibly rendered the single chip; clicking it
  sent exactly the same value and original slot as live turn2; product and new
  topic/cable responses rendered. **This is offline UI evidence, not a new live
  backend run or a production release.**
- The backend2197-test result belongs to a08b6522; no backend code changed here.
  It is not misreported as an additional2197-run on this frontend correction.
- The Gemini fallback's new required-first wire grammar was not exercised by
  this successful primary-provider turn. Broader source-role/critical-input
  coverage, catalog assortment breadth and active-unit chip redundancy remain
  outside this three-message acceptance. No claim that all client bugs closed.

This correction is only in draft PR145 until explicitly merged and published.
The rollback point for the frontend is4915b873 (old widget hash); do not roll
back or edit the public backend to undo an unpublished frontend change.
