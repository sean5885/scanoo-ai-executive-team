# Skill Surface Policy

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Purpose

This document defines how checked-in repo skills may surface outward without changing the public response boundary.

Current code anchors:

- `/Users/seanhan/Documents/Playground/src/skill-governance.mjs`
- `/Users/seanhan/Documents/Playground/src/planner/skill-bridge.mjs`
- `/Users/seanhan/Documents/Playground/src/executive-planner.mjs`
- `/Users/seanhan/Documents/Playground/src/user-response-normalizer.mjs`
- `/Users/seanhan/Documents/Playground/tests/skill-runtime.test.mjs`
- `/Users/seanhan/Documents/Playground/tests/executive-planner.test.mjs`
- `/Users/seanhan/Documents/Playground/tests/user-response-normalizer.test.mjs`

## Current Surface Layers

### 1. `internal_only`

Meaning:

- skill may exist in the repo
- skill may be reachable from planner deterministic routing
- skill must stay outside strict user-input planner `target_catalog`
- skill must not be selectable by free planner JSON output

Current checked-in examples:

- `search_and_summarize`
- `document_summarize`

Required rules:

- selector mode must stay `deterministic_only`
- raw skill output must not be rendered directly to user
- final user-facing reply must still pass through the existing answer / normalization pipeline

### 2. `planner_visible`

Meaning:

- reserved for future planner-selectable skill-backed actions
- would allow a skill-backed action to appear in strict planner `target_catalog`
- still must go through planner contract validation, `planner/skill-bridge.mjs`, and the existing answer pipeline

Current checked-in status:

- no checked-in skill uses this layer

Current policy gate:

- only `read_only` skills may enter this layer
- `deterministic_only` selector mode is not allowed here
- this layer is policy-defined but not activated by any current skill

### 3. `user_facing_capability`

Meaning:

- a future capability family where a skill-like module might become part of an explicit user-facing product surface

Current checked-in status:

- disabled
- no checked-in registry entry may use this layer

## Exposure Rules

### What may enter planner catalog

Only skills that satisfy all of the following may be considered in future:

- surface layer is `planner_visible`
- skill class is `read_only`
- planner contract explicitly allows catalog visibility
- planner dispatch still goes through `planner/skill-bridge.mjs`
- user-facing reply still goes through `user-response-normalizer.mjs`

Current checked-in answer:

- none

### What must remain deterministic-only

The following must stay `internal_only` in the current baseline:

- `search_and_summarize`
- `document_summarize`
- any future `write` skill
- any future `hybrid` skill
- any skill whose output has not yet been normalized into the existing answer pipeline

## Response Boundary

Checked-in invariant:

- skill must not directly change the response surface
- strict planner still owns outward action selection
- `user-response-normalizer.mjs` still owns user-facing rendering
- canonical source rendering still goes through `answer-source-mapper.mjs`

Current implementation effect:

- internal planner skill actions can execute
- their result is normalized into canonical `answer/sources/limitations`
- raw fields such as `bridge`, `side_effects`, selector metadata, and internal trace data are not directly rendered to the user

## Read / Write Policy

Current v1 answer:

- `read_only` skills are allowed in checked-in runtime
- `write` and `hybrid` skill definitions are allowed at the contract/governance layer
- `write` and `hybrid` skills are not allowed to become `planner_visible`
- no skill may bypass existing mutation governance or confirmation boundaries

This means:

- repo may define a write-capable skill in the future only as an internal helper
- it must still go through the existing controlled mutation path
- this thread does not authorize adding such a skill

## Current Open vs Closed List

### Currently open

- deterministic planner access to `search_and_summarize`
- deterministic planner access to `document_summarize`

### Currently not open

- third checked-in skill
- skill chaining
- planner-visible skill-backed actions
- user-facing capability layer
- raw skill output rendered directly to user
- write / hybrid skills in planner catalog

## Future Expansion Strategy

Expansion remains blocked until all of the following are done in the same change:

1. define the candidate skill's surface layer explicitly
2. prove planner catalog eligibility with regression tests
3. prove no bypass of `user-response-normalizer.mjs`
4. prove no drift in existing API behavior
5. update `docs/system` mirrors and `planner_contract.json` together

Current thread outcome:

- policy only
- no new skill added
- no skill chain added
- no new public capability enabled
