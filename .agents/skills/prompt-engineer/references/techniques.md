# Techniques

Condensed from dair-ai Prompt Engineering Guide. Pick by task shape.

## The 4 elements of a prompt

Every prompt is some mix of:
1. **Instruction** — what to do (verb-first: classify, extract, rewrite, recommend).
2. **Context** — background that lets the model reason (domain, who the user is, prior turns).
3. **Input data** — the specific thing to act on (the user message, the document, the row).
4. **Output indicator** — the shape of the answer (JSON schema, sections, length, channel).

Missing any element = predictable failure mode. Missing instruction → vague. Missing context → generic. Missing input separation → confused. Missing output indicator → unparseable.

## Technique selection

| Task shape | Technique |
| --- | --- |
| Single fact extraction / classification | Zero-shot + strict output schema |
| Stylistic transformation, persona, voice | Role prompting + 2–3 GOOD few-shot examples |
| Multi-step reasoning | Chain-of-Thought ("first list the criteria, then ..."). For modern models, often implicit — request structured reasoning instead of "think step by step" |
| Task too big for one call | Prompt chaining / decomposition |
| Needs external facts | RAG — bind every fact to its retrieved source |
| Needs to act on the world | ReAct — interleave thought, tool call, observation |
| Brittle outputs across runs | Self-consistency: sample N, majority-vote |

## Role prompting — how to do it well

A weak role: `You are a helpful assistant.`
A strong role: names the **domain**, the **type of expert**, the **kind of user they serve**, the **categories of things they actually know from the field**.

Example skeleton:
```
You are a senior <ROLE> at <SPECIFIC PLACE>. You serve <USER TYPE>
on <TYPICAL TASKS>. From years in the field you know <CONCRETE
DOMAIN KNOWLEDGE: brands, units, common pitfalls, jargon>.
Your job in this conversation: <ONE SENTENCE>.
```

Grounding the role with concrete domain knowledge lets the model reason as that expert. Without it, role prompting is decorative.

## Few-shot — how many and what kind

- 2–5 examples is usually the sweet spot.
- Cover the *range* of inputs, not just the easy case.
- GOOD examples only. BAD examples leak.
- Examples should be diverse in *surface form* but consistent in *output shape* — this teaches the contract without teaching a template.

## Output contract — the part most people skip

State explicitly:
- **Channel**: tool call vs free text vs JSON.
- **Schema** (if structured): field names, types, required vs optional.
- **Length**: numeric bounds.
- **Sections** (if free text): what sections in what order.
- **Edge case behavior**: what to emit if no answer is possible.

Do NOT state:
- A required sentence pattern for the model's prose.
- Required opening or closing phrases (unless legally required).

## Specificity beats cleverness

From dair-ai: "Use 2–3 sentences to explain prompt engineering to a high school student" beats "Explain prompt engineering, keep it short, don't be too descriptive."

Numbers, units, audience, format — every dimension you leave vague will be filled by the model's prior, which is usually generic.

## Iteration

Prompts are code. Treat them like code:
- Version them.
- Test them on a fixed input set before shipping.
- When a bug appears, ask "is this a missing element, or a wrong constraint?" before adding a new rule.
- Refactor when patches accumulate.
