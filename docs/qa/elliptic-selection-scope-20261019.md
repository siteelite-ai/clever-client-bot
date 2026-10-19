# Short same-section attribute refinement — 2026-10-19

## Observed production gap

On `220volt.testdevops.ru`, the sequence `Покажи ассортимент Gallant на сайте` → the server-issued `Розетки` choice → `нужны двойные` ended with zero cards, even though the preceding response included a double Gallant socket. Request `c56701ec-3876-409d-a5fc-f368258c4ece` completed without a transport error. Its discovery guard rejected the inferred noun `розетки` because the final message omitted that noun. The older acceptance fixture used the different, complete message `Нужны двойные черные розетки` and therefore did not cover this gap.

## General correction and boundaries

The short-attribute grammar now recognizes a bounded selection preface plus a single adjectival attribute, without a socket or Gallant-specific dictionary. A continuation can use the latest completed, same-session server-issued active selection scope only; client slots, older history, explicit new topics, another product class, and another named series cannot authorize it. For such a short turn, the verified section supplies the missing product noun to the expert route and initial taxonomy lookup. The existing category grounding, named-series filter, mandatory criteria, and final product-card gates remain in force. Complete requests do not take the new path.

## Verification

- Related Deno scope/boundary tests: 40/40 passed, including new-class, new-brand, explicit-topic, and unverified-scope negatives.
- Route contract tests: 6/6 passed; acceptance evaluator tests: 101/101 passed; v3 and preview Deno type checks passed.
- Isolated closure-preview one-run acceptance: [`gallant-elliptic-preview-v44-20261019.json`](reports/gallant-elliptic-preview-v44-20261019.json) passed three turns. The last turn returned four double Gallant sockets and a mandatory two-outlet criterion. This is a targeted preview result, not a full customer-suite or independently verified product-page audit.
- Two earlier preview attempts exposed the separate discovery-grounding and model-planning limits; they were not published to production.

Production needs a post-merge browser smoke of this exact wording and one unchanged topic-boundary control. If either fails, redeploy the pre-merge v3 function from a clean checkout and revert the PR before further Lovable synchronization.
