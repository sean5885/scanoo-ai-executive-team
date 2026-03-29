# Skill Governance

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Purpose

This document mirrors the checked-in governance boundary for planner-integrated skills.

Current code anchors:

- `/Users/seanhan/Documents/Playground/src/skill-governance.mjs`
- `/Users/seanhan/Documents/Playground/src/skill-contract.mjs`
- `/Users/seanhan/Documents/Playground/src/skill-runtime.mjs`
- `/Users/seanhan/Documents/Playground/src/planner/skill-bridge.mjs`
- `/Users/seanhan/Documents/Playground/src/executive-planner.mjs`
- `/Users/seanhan/Documents/Playground/src/user-response-normalizer.mjs`
- `/Users/seanhan/Documents/Playground/src/read-runtime.mjs`
- `/Users/seanhan/Documents/Playground/tests/skill-runtime.test.mjs`
- `/Users/seanhan/Documents/Playground/tests/executive-planner.test.mjs`

Related mirror:

- `/Users/seanhan/Documents/Playground/docs/system/skill_surface_policy.md`

## Current Global Limits

- max skills per planner-dispatched run:
  - `1`
- skill chaining:
  - `false`
- selector mode for planner-visible skills:
  - deterministic only
- selector conflict behavior:
  - fail closed

Current checked-in meaning:

- adding a second or third skill does not automatically make planner use them
- the current thread does not authorize a third skill
- planner-visible skill selection must still resolve to exactly one skill action
- if two skills claim the same deterministic selector key, selection returns no skill path instead of choosing heuristically

## Skill Surface Layers

Checked-in planner skill actions now carry an explicit surface layer:

- `internal_only`
  - deterministic planner-only access
  - hidden from strict user-input planner `target_catalog`
- `planner_visible`
  - reserved for future planner-selectable skill-backed actions
  - no checked-in skill currently uses it
- `user_facing_capability`
  - reserved and disabled
  - no checked-in registry entry may use it

Current checked-in skills:

- `search_and_summarize`
  - `surface_layer = internal_only`
- `document_summarize`
  - `surface_layer = internal_only`

Current checked-in enforcement:

- `internal_only` skills must stay `deterministic_only`
- `planner_visible` skills cannot stay `deterministic_only`
- `planner_visible` skills must be `read_only`
- `user_facing_capability` is rejected fail-closed at registry build time

## Skill Classes

Every checked-in skill definition must now declare:

- `skill_class`
  - `read_only`
  - `write`
  - `hybrid`
- `runtime_access`
  - `read_runtime`
  - `mutation_runtime`

Current validation rules:

- `skill_class` is required
- `runtime_access` is required
- declared class must match `allowed_side_effects`
- invalid or mismatched governance metadata throws `invalid_skill_definition`

Current checked-in examples:

- `search_and_summarize`
  - `skill_class = read_only`
  - `runtime_access = ["read_runtime"]`
  - allowed side effects:
    - `read:search_knowledge_base`
- `document_summarize`
  - `skill_class = read_only`
  - `runtime_access = ["read_runtime"]`
  - allowed side effects:
    - `read:get_company_brain_doc_detail`

Current v1 surface rule by class:

- `read_only`
  - allowed for `internal_only`
  - may become `planner_visible` only in future with explicit approval and regression coverage
- `write`
  - may exist only as internal helper in future
  - must not become `planner_visible` in current policy
- `hybrid`
  - may exist only as internal helper in future
  - must not become `planner_visible` in current policy

## Skill Vs Tool Vs Agent

Current checked-in choice rule is intentionally narrow:

- use a planner tool:
  - when one existing action already models the task directly
- use a skill:
  - only when the caller explicitly requests a bounded reusable capability through a deterministic selector input such as `taskType=skill_read`
  - planner still dispatches a planner action first, then reaches the skill only through `planner/skill-bridge.mjs`
- use an agent / preset:
  - when the work is multi-step, role-oriented, or not representable as one bounded deterministic skill action

Current non-goals:

- no generic multi-skill planner runtime
- no heuristic skill ranking
- no skill chain
- no automatic tool-to-skill promotion

## Deterministic Selector

Planner-visible skills now declare selector metadata in `planner/skill-bridge.mjs`:

- `selector_mode`
- `selector_key`
- `selector_task_types`
- `routing_reason`
- `selection_reason`

Current selection rules:

1. normalize `taskType`
2. collect deterministic skill entries whose `selector_task_types` contain that value
3. zero match:
   - return `routing_no_match`
4. one match:
   - return that skill action only if its `selector_key` is unique inside the registry
5. multiple matches:
   - return `selector_skill_conflict`
   - do not choose by insertion order, score, or heuristic
6. duplicate `selector_key`:
   - return `selector_skill_conflict`
   - do not treat key collisions as aliases or fallback candidates

This keeps old behavior stable as long as a new skill uses a different selector key.
It also keeps current internal-only skills outside the strict planner catalog.

## Response Surface Boundary

Current checked-in answer:

- a skill may produce structured output for planner/runtime use
- a skill may not directly define the user-facing response surface
- planner success replies must still pass through `/Users/seanhan/Documents/Playground/src/user-response-normalizer.mjs`
- source rendering must still pass through `/Users/seanhan/Documents/Playground/src/answer-source-mapper.mjs`

Current checked-in effect:

- raw skill fields such as `bridge`, `side_effects`, selector metadata, and internal trace state are not rendered directly to users
- deterministic skill summaries are adapted into canonical `answer / sources / limitations`

## Isolation Rules

### No implicit shared state

Current runtime isolation is:

- `runSkill(...)` only passes:
  - `input`
  - `logger`
  - `signal`
- input is validated as JSON-serializable plain data before execution
- input is cloned before reaching `skill.run(...)`
- successful output is validated as JSON-serializable plain data and cloned before returning
- nested `runSkill(...)` calls are rejected as `contract_violation` with `message=skill_chain_not_allowed`

This means checked-in skills cannot share caller object references through input/output mutation.

### No side-channel repo / DB path

Current checked-in enforcement is bounded, not a full sandbox:

- governance metadata only allows declared runtime surfaces such as `read_runtime` / `mutation_runtime`
- checked-in tests assert repo skills do not import:
  - `node:fs`
  - `fs`
  - `node:path`
  - `better-sqlite3`
  - `*/db.mjs`

Current code truth:

- this is a checked-in governance guard for repo skills
- it is not a VM-level sandbox for arbitrary future code
- therefore new skills still require review and regression tests before they are added to the default registry

## Testing Baseline

Current regression coverage includes:

- deterministic selector still picks `search_and_summarize` for `skill_read`
- deterministic selector picks `document_summarize` for `document_summary_skill`
- a second non-overlapping skill does not change that result
- selector task-type conflicts fail closed
- selector key conflicts fail closed
- planner-visible and deterministic-only cannot be mixed in one skill action entry
- skill input must be serializable
- skill output must be serializable
- skill chains are rejected
- checked-in skills do not import repo / DB side channels
- planner skill failures do not fall back into generic document search
- strict planner target catalog keeps internal-only skill actions hidden
- strict planner decision validation rejects internal-only skill actions
- planner skill success replies still go through canonical answer-source mapping

## Future Expansion Guard

Current answer:

- keep `max_skills_per_run = 1`
- keep `allow_skill_chain = false`
- each deterministic selector entry must have a unique selector key and non-overlapping selection semantics
- every new skill must declare `skill_class` and `runtime_access`
- every new skill must declare a surface layer explicitly
- every new skill must stay on governed runtime surfaces
- every new skill must add regression tests proving existing selector outputs do not drift
- every new skill must prove it does not bypass `user-response-normalizer.mjs`

Current thread does not open a third skill.
If those conditions are not met, the checked-in governance model must remain exactly at the current two internal-only read skills.
