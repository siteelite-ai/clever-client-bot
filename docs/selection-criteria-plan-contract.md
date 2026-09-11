# Selection criteria plan contract

The consultant must search and render against one monotonically growing
mandatory contract for each selection turn. The model may explain, discover,
search, retry, and render in several calls, but those calls must not define
independent versions of the customer's requirements.

## Invariants

1. Only proof-qualified level-A criteria enter the plan. Customer-backed
   criteria and requirements explicitly marked necessary in the consultant's
   reasoning are eligible; advice and preferences remain level B.
2. Once a criterion enters the plan, later search, render, and recovery paths
   may add requirements but cannot remove or weaken it.
3. Every plan has a deterministic trace hash. Recovery logs include that hash
   so a result can be tied to the contract that governed it.
4. Search options are projections of the plan onto live catalog facets. A
   conflicting later model option loses to the frozen plan.
5. A compatibility request uses its separate directional relation contract.
   The object's measurement must not be frozen as an exact product facet.
6. Application context becomes a hard criterion only when it was declared by
   the customer/initial reasoning and can be mapped to real catalog evidence.
   The server must not invent a suitability field.
7. A card attribute can be proven by either its title or its structured catalog
   traits. Model prose alone is never product evidence.

## Release gate

Changes to this contract ship from an isolated branch. Deno type-check and all
shared safeguard tests, Node widget/evaluator tests, the production build, and
the customer acceptance matrix must pass before merge. Production deployment
is a separate reversible step after review; this branch does not change the
widget asset or loader version.

