# Anti-patterns

Failure modes observed in production. Each has a *symptom*, a *cause*, and a *fix*.

## 1. Negative rule lists ("DO NOT X, DO NOT Y")

**Symptom.** Prompt is half "don't"s. Model still does the forbidden thing (movie-bot effect from dair-ai guide: "DO NOT ASK FOR INTERESTS" → bot asks for interests).
**Cause.** LLMs latch onto the *concept* mentioned, regardless of negation polarity. Negative lists also crowd out positive guidance.
**Fix.** Restate every "don't" as a "do". Instead of "не повторяй запрос клиента" → "первая фраза — твоя инженерная интерпретация задачи". Instead of "БЕЗ канцелярита" → describe the voice in the positive ("speaks like an electrician with a customer at the counter").

## 2. Templated phrasing pattern forced on the model

**Symptom.** Every reply starts identically: `<type> for <task> — берём <param>=<value>`. Feels robotic, customer complains.
**Cause.** Prompt constrains the *internal phrasing*, not the output contract. Model learns the template and produces it verbatim.
**Fix.** Constrain the *output shape* (sections, length, channels), not the sentence pattern. Show 2–3 GOOD examples with *different* phrasings to demonstrate range.

## 3. Thin role, thick rules

**Symptom.** Role is one line ("you are a consultant"). Then 40 lines of behavioral rules. Output is generic and rule-shaped.
**Cause.** No domain grounding → model can't reason as an expert → rules try to compensate for missing context.
**Fix.** Invest in the role: concrete store, concrete categories, concrete things an expert in this field knows (brand series, IP codes, common customer mistakes). Then most rules become unnecessary.

## 4. BAD examples in few-shot

**Symptom.** Prompt includes a "BAD: ..." example. Model occasionally emits the BAD pattern.
**Cause.** Few-shot is pattern-matching. BAD examples are still patterns.
**Fix.** Show GOOD examples only. If you must contrast, do it in a single line of plain prose, not in an example block.

## 5. Hallucinated facts ungrounded by tools

**Symptom.** Model invents prices, URLs, contact info, product specs.
**Cause.** Prompt says "you have access to the catalog" but doesn't bind facts to tools.
**Fix.** Bind every fact class to a source by name: "Prices come from `search_catalog` results. URLs come from `search_catalog` results. Contacts come from `get_contacts`. If a tool didn't return it, you don't have it — say so."

## 6. Repeating the user's query as "identification"

**Symptom.** First sentence echoes the user verbatim. Sounds like a bad call-center script.
**Cause.** Prompt says "first acknowledge what the client asked".
**Fix.** Replace with "first state your *expert interpretation* of the real need" — interpretation, not echo.

## 7. Mixing system prompt with one-shot patches

**Symptom.** Prompt grows new "ИСКЛЮЧЕНИЕ:" / "ВАЖНО:" / "ЗАПРЕЩЕНО:" sections after every bug. Becomes unmaintainable.
**Cause.** Patching symptoms instead of restructuring.
**Fix.** When you'd add a patch section, instead refactor: identify the real category the patch belongs to (role, context, output contract, tool contract) and integrate it there. Prompts need refactoring like code does.

## 8. Specifying length poorly

**Symptom.** "Be concise" → 3-page replies. Or "explain in detail" → 1 sentence.
**Cause.** Vague length cues.
**Fix.** Give numbers and units: "2–3 sentences", "≤ 60 words", "one paragraph then a bulleted list of 3–5 items".

## 9. Mixing voice with contract

**Symptom.** Single section tries to specify tone AND output schema AND tool rules.
**Cause.** No section discipline.
**Fix.** One concern per section. `<role>`, `<domain>`, `<task>`, `<tools>`, `<output_contract>`, `<voice>`, `<examples>` — each does one thing.

## 10. "Be smart" as an instruction

**Symptom.** Prompt contains "think carefully", "be thoughtful", "use your intelligence".
**Cause.** Wishful thinking.
**Fix.** Replace with the actual reasoning step you want: "list the 2–3 selection criteria you'll use before searching" (CoT) or "decompose the request into subtasks then handle each" (decomposition).
