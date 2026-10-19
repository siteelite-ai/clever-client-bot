# Lovable widget: targeted Gallant continuation, 2026-10-19

Environment: `https://220volt.testdevops.ru/`, published widget `widget-1eeab2ab4674ce43`. This was a browser check against the existing Lovable/Supabase stack, not the isolated server3 stack. The test used one fresh widget conversation.

| Turn | Input | Observed result | Request ID | Verdict |
| --- | --- | --- | --- | --- |
| 1 | `Покажи ассортимент Gallant на сайте` | Asked to narrow the assortment and offered `Выключатели`, `Розетки`, `Напишу свой вариант`. | `facc5642-26d9-4e51-bbc4-1625a354f7f4` | Pass: useful clarification. |
| 2 | Chose the `Розетки` chip. | Returned five Gallant socket cards, including double black/chrome `W5072135`, 6,343 ₸. | `b22ea8d1-e0c3-48f1-8806-bc605ea530a2` | Pass: series and selected class preserved. |
| 3 | `Нужны двойные черные розетки` | Widget inserted an automatic `Новая тема` divider before this follow-up. Instead of a product answer, returned the external-service-limit message. | `dcd56807-68f3-46f6-a5fb-413b36e6161a` | Fail: context boundary. Product selection cannot be assessed because the upstream call failed. |

For turn 3, a read-only query of the existing Supabase `chat_request_logs` row returned `model_upstream_http_402` and `limit_source: openrouter_credits` with the message `Insufficient credits`. This explains the unavailable-service answer and is distinct from the incorrect new-topic decision. No further live paid requests were attempted after this diagnosis.

The same row's `v3_conversation_boundary` step recorded `mode=new_task`, `reason=explicit_active_selection_entity_change`, `active_selection_entity_changed=true`, and `active_selection_class_changed=true`. The preceding `v3_admission_checked` step was in `observe` mode for this turn; it did not reject the request. These are server observations, not inferences from the UI.

Code investigation on `origin/main` `27957544` found that the verified active-section matcher strips `мне нужны` but not bare `Нужны`; it similarly mishandles conversational prefaces. This set `entityChanged=true` and reset the active scope. The candidate correction parses those prefaces only when matching an independently server-verified active section, rather than changing the general request parser or adding a Gallant-specific keyword rule.

An additional precedence gap exists when a verified pending readiness question and a verified active selection scope coexist: the readiness `new_task` precheck, or even a null precheck with an old pending slot, can override or concatenate a proven complete same-section request. The candidate correction lets that complete request supersede and consume the old question, while preserving explicit topic/entity/class changes and short answers to the question. Pure helper and route tests pass; a live preview result is still needed.

Independent review also identified a separate pre-existing ambiguity: a short free-form answer such as `Нужны 3 жилы` can be mistaken for a new product request when both a verified active section and a readiness question exist. The Gallant correction alone did not fix it; the additional local candidate below addresses this case without changing the general class detector.

The separate historical pre-acceptance transport error (`proxy: connect_timeout` plus `direct: Failed to fetch`) was **not** reproduced by this test and should not be conflated with this confirmed OpenRouter HTTP 402.

## Isolated preview check

The candidate from commit `3e5a4917` was deployed **only** to `chat-consultant-v3-closure-preview` version 39 (`ezbr_sha256=9075fd26fa784824c2fc9d66135916b323d56d6606ffc85a33c97c1b37da1f79`, `verify_jwt=true`). A subsequent function-list read showed production `chat-consultant-v3` still at version 459 with its earlier hash `22a252e58aca504ac75290770be7ac57ce989323f1f497bcf6f102728b4a0d63`.

The [one-run acceptance report](reports/gallant-topic-context-preview-v39-20261019.json) passed all three turns in 22.5 s: assortment clarification (`6834eeca-9387-4397-a776-95743b2cc95f`), verified `Розетки` selection (`27a1d919-cee1-46e5-b44e-983ef1810e02`), then `Нужны двойные черные розетки` (`4c06214b-11fe-4ffd-a726-363b08e729af`). The last turn returned HTTP 200 without diagnostic error and one matching Gallant `W5072135` black/chrome double socket at 6,343 ₸; its mandatory criteria retained Gallant, black, and two outlets. No new-topic boundary was reported by the acceptance runner. This is a **targeted 1× preview PASS**, not a full acceptance result. The minimal report did not independently verify product-page content, and it does not establish transport stability or fix the separate short numeric/free-form ambiguity above.

## Additional local readiness-boundary candidate

A server-verified free-text readiness slot now distinguishes a short answer from a different product class using the issued question, not a product dictionary. Dependent phrases (`Нужны с заземлением`), scalar measurements (`Нужны 120 м²`, `16 А`), and concise numbered facts sharing a stem with the question (`Нужны 3 жилы` after a question about the number of cores) may keep the current task. Short multi-fact answers (`3 жилы, 16 А`, `120 м² и высота 4 м`) are parsed as a sequence, so an unrelated second product clause cannot inherit the old scope. `Нужны 3 прожектора` after a question about cores, explicit `Новая тема`, and an explicit change of series retain their new-task precedence. Only a slot from the latest completed server response may activate this rule; the browser's copy is not trusted by itself.

Local checks: 40/40 active-scope and boundary tests, 7/7 Gallant route/widget tests, frontend typecheck and build pass. The selection-readiness test module imports a Deno-hosted dependency and could not be executed with the local Node shim; CI's Deno check and targeted preview results are recorded below. The v39 preview report above predates this additional change and must not be presented as its live verification. No production function or published widget has been changed by this candidate.

## PR #79 follow-up preview, 2026-10-19

Commit `0d650340` passed GitHub Actions `Type-check Edge Functions` run 1012, including the Deno function checks and safeguard tests. It was deployed **only** to `chat-consultant-v3-closure-preview` version 40 (`ezbr_sha256=df29fee75d4760704c996bc6a70a375d4272d5698fb72ea2899174ad194408a0`, `verify_jwt=true`). A function-list read after deployment still showed production `chat-consultant-v3` version 459 with its prior hash `22a252e58aca504ac75290770be7ac57ce989323f1f497bcf6f102728b4a0d63`.

Three single-run, three-turn targeted preview checks passed:

- [BT-924 base](reports/kg-freeform-preview-20261019.json): replacing КГ → mobile connection → `3×2,5` continued to the `usage_purpose` question.
- [BT-924 natural-language variant](reports/kg-natural-freeform-preview-20261019.json): the same path with `Мне нужны 3 жилы и сечение 1,5 мм²` also continued to `usage_purpose`, rather than starting a new task. The variant input is recorded in [`topic-context-freeform-variants-20261019.json`](../../scripts/qa/topic-context-freeform-variants-20261019.json).
- [Gallant scope control](reports/gallant-topic-context-preview-v40-20261019.json): assortment → `Розетки` → `Нужны двойные черные розетки` returned one matching Gallant double socket and no new-topic boundary.

These are scoped preview checks, not a full acceptance suite, transport-stability proof, or independent product-page verification. Production and the published Lovable widget remained untouched.
