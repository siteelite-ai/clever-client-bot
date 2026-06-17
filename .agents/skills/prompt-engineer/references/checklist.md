# Pre-ship checklist

Run before handing a prompt to the user for approval. Every item must pass.

## 1. Role & domain
- [ ] Role names the **specific domain** (not "you are a helpful assistant"). For a store consultant: store name, product categories, typical clients, what an expert in this field actually knows.
- [ ] Role gives the model *grounding to reason from*, not just a label.

## 2. Task
- [ ] The job-to-be-done is stated in one sentence at the top.
- [ ] Success criterion is observable (what does a good answer look like?).

## 3. Positive framing
- [ ] No "не делай X / DO NOT Y / БЕЗ Z" lists for stylistic things.
- [ ] Every behavioral rule is phrased as what the model *does*.
- [ ] Hard prohibitions exist only for real contract invariants (data sources, tool boundaries, safety) — and even then, prefer "prices come from tool X" over "never invent prices".

## 4. Output contract
- [ ] The *output shape* is specified (channels, sections, JSON schema, length).
- [ ] The *internal phrasing pattern* is NOT specified. The model picks its own words.
- [ ] No mandatory template like `<type> — <param>=<value>` unless the output is genuinely machine-parsed.

## 5. Examples (if any)
- [ ] Few-shot examples show variety, not just the easy case.
- [ ] Examples are GOOD only — avoid BAD examples unless contrasting a very specific error pattern (BAD examples leak into outputs).
- [ ] Examples are domain-realistic.

## 6. Tools (if agent)
- [ ] Each tool has: what it does, when to call it, what to do with the result.
- [ ] Chaining rules are stated (e.g. "after search_catalog returns empty, call jargon_recover").
- [ ] What the model is allowed to say *between* tool calls is explicit.

## 7. Anti-hallucination contracts
- [ ] Every fact that must come from a tool/source is bound to that source by name.
- [ ] No "you know the catalog" — the model knows nothing the prompt doesn't ground.

## 8. Testability
- [ ] You can name 3 concrete user inputs and predict the response shape.
- [ ] You can name 1 input that *should fail gracefully* and the prompt says how.

## 9. Length sanity
- [ ] Removed every sentence that doesn't change behavior.
- [ ] Removed duplicated rules (same constraint stated in 2+ sections).

## 10. Approval
- [ ] Diff posted to user with explanation of *why* each section is there.
- [ ] No silent edits to a prompt the user is reviewing.
