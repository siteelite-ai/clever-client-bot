---
name: prompt-engineer
description: Use when writing, rewriting, reviewing, or refactoring an LLM system prompt or user prompt — including consultant/agent personas, tool-using agents, classifiers, RAG instructions, and any "напиши/перепиши промпт" requests. Triggers on phrases like "system prompt", "системный промпт", "перепиши промт", "оцени промпт", "tone of voice для LLM", "роль для модели".
---

# Prompt Engineer

A discipline for designing LLM prompts. Based on dair-ai Prompt Engineering Guide + lessons from production failures on this project.

## When to use

- Author or refactor a `system` prompt (role, tone, behavior).
- Review an existing prompt that produces bad outputs (templated, robotic, off-topic, hallucinating).
- Decide between zero-shot / few-shot / CoT / decomposition for a new task.

## The non-negotiables

Read `references/checklist.md` and pass every item before shipping a prompt. Read `references/anti-patterns.md` before writing — the most common failure modes on this project are listed there with the fix.

## Workflow

1. **Clarify the job-to-be-done.** What is the LLM the *expert at*? Who is the user? What does success look like in one sentence? If you can't answer, ask the user — don't guess.
2. **Pick the shape** (see `references/techniques.md`):
   - Single-turn classification/extraction → zero-shot + strict output schema.
   - Stylistic / persona-heavy → role prompting + 2–3 few-shot GOOD examples (no BAD examples unless absolutely necessary — see anti-patterns).
   - Multi-step reasoning → CoT or decomposition into tool calls.
   - Tool-using agent → ReAct-style: describe tools, when to call them, how to chain.
3. **Draft using the 4 elements** (instruction, context, input, output indicator — `references/techniques.md`).
4. **Write in the positive.** Describe what the model *does*, not what it *must not do*. Negative lists ("не делай X, не делай Y") are a smell — see `references/anti-patterns.md`. Use a prohibition only when there is a hard safety/contract invariant and it cannot be expressed positively.
5. **Give context, not commands.** A consultant prompt needs the *domain* (what store, what catalog, what kinds of clients, what the expert actually knows from the field), not a list of rules about how to phrase sentences. Domain context lets the model reason; rule lists make it parrot.
6. **Show, don't tell.** One concrete GOOD example beats ten paragraphs of guidance. Few-shot examples must reflect the *range* of inputs, not just the easy case.
7. **Specify output, not format-of-thought.** Constrain the *output contract* (JSON schema, sections, length, channel: tool call vs text). Do NOT constrain the *internal phrasing pattern* the model uses to think — that produces templated robotic answers ("type=X, param=Y — берём").
8. **Review against `references/checklist.md`.** Hand the draft to the user for approval before applying.

## Output of this skill

A prompt that:
- Is structured: role → domain context → task → output contract → (optional) few-shot.
- Uses positive instructions.
- Has zero "echo templates" forced on the model's voice.
- Has explicit invariants only where they are real contract (e.g. "prices come from `search_catalog` tool, never from your own knowledge").
- Is testable: you can name 3 inputs and predict the shape of the output.

## References

- `references/checklist.md` — pre-ship checklist. Run every time.
- `references/anti-patterns.md` — failure modes seen on this project, with fixes.
- `references/techniques.md` — when to use zero-shot / few-shot / CoT / role / ReAct, and the 4 prompt elements.
