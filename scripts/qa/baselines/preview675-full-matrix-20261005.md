# Full customer matrix — candidate f5f82c58

Preview only. Runner session 74078 completed with exit 1. All 28 cases were executed once on the same deployment. No production deployment.

**18 PASS / 10 FAIL. Regression relative to the earlier 25/28 baseline; not ready.**

Failed IDs: audit-02, audit-03, audit-05, audit-09, audit-09b, audit-12, audit-15, audit-16, audit-17, audit-25.
Passed IDs: audit-01, audit-04, audit-06, audit-07, audit-08, audit-10, audit-11, audit-13, audit-14, audit-18, audit-19, audit-20, audit-21, audit-22, audit-23, audit-24, audit-26, audit-27.

The minimal runner output was truncated at observation; this file does not claim to preserve all response text or request IDs. Server error details were retrieved separately and saved completely in preview675-obligation-errors-20261005.json.

## Root causes now evidenced across cases

- New obligation schema rejected short legitimate enums (C, да). This is an introduced regression, not catalog absence.
- Unitless count axes were rejected as physical quantities with missing units; a shared live-schema count resolver already exists and should be reused.
- Explicit customer choices such as E27 / 3000 K were rejected for lacking necessity wording in explanatory prose. Customer evidence must remain authoritative without requiring the model to repeat a modal verb.
- A sentence containing both a system total and a per-item requirement was rejected wholesale by the aggregate marker. Needs scope-sensitive attribution; never infer that arbitrary division is valid.
- Socket declaration had no raw property errors but was still rejected later: investigate sentence cleanup/other resolver constraints using request 2c48270f-6226-4453-a6ea-ef687161fc8a.
- Living room request f2307447-6e74-497f-80fc-73ce01fb20e4 returned zero cards after 46222 ms; separate retrieval/deadline diagnosis required.
- CCTV necessity/class/suitability contract remains incomplete.

## Changes since this deployed candidate

Local-only follow-up allows exact short enums and unitless counts only when grounded by the existing live-schema count resolver; adds cross-category positive and negative tests. 886 shared tests and Edge check passed. Not deployed yet, not a complete remedy for all failures. Postfix full matrix and browser validation still required.
