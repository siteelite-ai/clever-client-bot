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

Independent review also identified a separate pre-existing ambiguity: a short free-form answer such as `Нужны 3 жилы` can be mistaken for a new product request when both a verified active section and a readiness question exist. This candidate does not change that broader class detector; it is not counted as fixed by the Gallant correction.

The separate historical pre-acceptance transport error (`proxy: connect_timeout` plus `direct: Failed to fetch`) was **not** reproduced by this test and should not be conflated with this confirmed OpenRouter HTTP 402.
