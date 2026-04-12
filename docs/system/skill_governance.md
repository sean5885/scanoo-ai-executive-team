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
- `/Users/seanhan/Documents/Playground/docs/system/skill_planner_visible_readiness.md`

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
- planner-visible promotion must go through `internal_only -> readiness_check -> planner_visible`
- direct jump from `internal_only` to `planner_visible` is rejected fail-closed

## Skill Surface Layers

Checked-in planner skill actions now carry an explicit surface layer:

- `internal_only`
  - deterministic planner-only access
  - hidden from strict user-input planner `target_catalog`
- `planner_visible`
  - planner-selectable skill-backed action surface
  - current checked-in examples: `search_and_summarize`, `document_summarize`
- `user_facing_capability`
  - reserved and disabled
  - no checked-in registry entry may use it

Current checked-in skills:

- `search_and_summarize`
  - `surface_layer = planner_visible`
  - `promotion_stage = planner_visible`
  - `previous_promotion_stage = readiness_check`
  - planner catalog admission is query-bounded and fail-closed
- `document_summarize`
  - `surface_layer = planner_visible`
  - `promotion_stage = planner_visible`
  - `previous_promotion_stage = readiness_check`
- `image_generate`
  - `surface_layer = internal_only`
  - `promotion_stage = internal_only`
  - current checked-in usage is bridge-only and stays outside the strict planner catalog

Current checked-in enforcement:

- `internal_only` skills must stay `deterministic_only`
- `readiness_check` skills must stay `internal_only`
- `readiness_check` skills must record `previous_promotion_stage = internal_only`
- `readiness_check` skills must remain `read_only`
- `readiness_check` skills must stay `read_runtime` only
- `readiness_check` skills must prove regression pass, answer-pipeline enforcement, observability evidence, raw-output blocking, stable output shape, and locked side-effect boundary before the stage metadata is accepted
- `planner_visible` skills must pass through `readiness_check`
- `planner_visible` skills must stay `deterministic_only`
- `planner_visible` skills must be `read_only`
- `planner_visible` skills must stay `read_runtime` only
- `planner_visible` skills must prove regression pass, answer-pipeline enforcement, observability evidence, raw-output blocking, stable output shape, and locked side-effect boundary
- `planner_visible` skills with broader query surfaces must define an explicit admission boundary; if the boundary cannot uniquely admit one skill, catalog admission fails closed
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
- `image_generate`
  - `skill_class = read_only`
  - `runtime_access = ["read_runtime"]`
  - allowed side effects:
    - none

Current v1 surface rule by class:

- `read_only`
  - allowed for `internal_only`
  - may become `planner_visible` only with explicit approval, regression coverage, and any required fail-closed admission boundary
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

For `readiness_check` and `planner_visible` candidates the bar is stricter:

- selector key conflict blocks promotion at registry build time
- overlapping deterministic selector task types block promotion at registry build time
- selector drift is treated as fail-closed readiness failure, not as a runtime tie-break

This keeps old behavior stable as long as a new skill uses a different selector key.
It also keeps current internal-only skills outside the strict planner catalog.
It also means only an explicitly promoted checked-in skill may enter the strict planner catalog, and any planner-visible skill with a broader query surface must still pass its own fail-closed admission boundary before it is shown to the user-input planner.

## Response Surface Boundary

Current checked-in answer:

- a skill may produce structured output for planner/runtime use
- a skill may not directly define the user-facing response surface
- planner success replies must still pass through `/Users/seanhan/Documents/Playground/src/user-response-normalizer.mjs`
- source rendering must still pass through `/Users/seanhan/Documents/Playground/src/answer-source-mapper.mjs`

Current checked-in effect:

- raw skill fields such as `bridge`, `side_effects`, selector metadata, and internal trace state are not rendered directly to users
- user-facing replies must come from canonical `execution_result.data.answer / sources / limitations`
- read-only skill contexts are hard-blocked from planner write actions (`send_message`, `update_doc`, `create_task`, `write_memory`, `update_record`) by checked guards in `planner/skill-bridge.mjs`, `planner/tool-loop.mjs`, and `planner/action-loop.mjs`, returning `error = read_only_skill_cannot_execute_write_action` with `blocked = true`

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
- planner-visible direct jump without `readiness_check` fails closed
- planner-visible candidate without regression pass fails closed
- planner-visible candidate without answer-pipeline enforcement fails closed
- readiness-check or planner-visible candidate without observability evidence fails closed
- planner-visible candidate with selector drift fails closed
- planner-visible candidate with unstable output or side-effect boundary fails closed
- skill input must be serializable
- skill output must be serializable
- skill chains are rejected
- checked-in skills do not import repo / DB side channels
- planner skill failures do not fall back into generic document search
- strict planner target catalog now admits `search_and_summarize` only when the query satisfies its checked-in search-plus-summarize admission boundary
- strict planner decision validation rejects `search_and_summarize` outside that admission boundary
- strict planner target catalog admits planner-visible `document_summarize`
- strict planner decision validation admits planner-visible `document_summarize`
- ambiguous overlap between `search_and_summarize` and `document_summarize` fails closed and leaves the original non-skill routing family available
- incomplete or malformed `readiness_check` metadata fails closed at planner skill registry build time
- planner-visible stage metadata mixed with `internal_only` surface fails closed at planner skill registry build time
- planner skill success replies still go through canonical answer-source mapping
- planner-visible skill watch now checks selector key hits, planner-visible/internal-only split, fail-closed negative probe, answer-boundary evidence, and non-skill routing stability through `npm run check:planner-visible-skill`

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
- every future planner-visible candidate must keep `npm run check:planner-visible-skill` green
- every future planner-visible candidate must define rollback conditions for selector drift, answer bypass, regression break, and routing mismatch in the same change

Current thread does not open a third skill.
If those conditions are not met, the checked-in governance model must remain at the current bounded surface of query-bounded planner-visible read skills only.
