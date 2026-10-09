# Preview checkpoint: short taxonomy codes

- Candidate: `4cff5fb0`; pushed to draft PR #67, deployed only to `chat-consultant-v3-preview`.
- Production was not deployed or merged.
- Local validation: 879 shared tests passed; Edge function type check passed.
- General change: short taxonomy modifiers no longer disappear from leaf-category grounding. Complete, positively affirmed live labels are required; replacement-source and negated mentions do not qualify. Tests cover cable codes, module codes, and one-letter codes versus conjunctions.
- This deployment also includes the earlier advisory-parenthetical correction from `17e267d6`.

## Live acceptance failure remains

Case `audit-15-analog-cctv-outdoor-cable`:

- Initial clarification passed: `8ae5e6ad-d1c3-4f59-9783-8c992cba84b3`, 2943 ms.
- Follow-up failed: `3c650f80-818d-43b4-9aab-5bf5df638a70`, 10855 ms, zero products, internal error.
- Database diagnostic: `derived_selection_reasoning_contract_invalid`; obligation `source_not_visible`; bounded repair did not recover.
- Declared reasoning contained “Для уличной прокладки обязательна светостабилизированная оболочка из полиэтилена (ПЭ) черного цвета, устойчивая к ультрафиолету и осадкам.”
- Quoted source instead ended after “черного цвета.” This was not the exact visible sentence, so validation correctly rejected it. The user-facing internal error remains unacceptable.
- Search was not reached; this run does not validate the live retrieval effect of the short-code fix.

Next: repair source attribution without deleting requirements or introducing facts; then repeat this scenario and cross-category controls. Full acceptance/browser regression remains outstanding. No production readiness claim.
