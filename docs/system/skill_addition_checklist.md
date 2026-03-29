# Skill Addition Checklist

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

Use this checklist before adding any new checked-in skill.

## Definition

- define one bounded capability, not a workflow bundle
- set explicit `skill_class`
- set explicit `runtime_access`
- keep `failure_mode = fail_closed`
- declare only the minimal `allowed_side_effects`

## Boundaries

- do not add more than one skill execution to a single planner-dispatched run
- do not call `runSkill(...)` from inside another skill
- do not expose the skill to planner unless it has a deterministic selector key
- do not reuse an existing selector key
- do not add heuristic ranking or fallback between skills
- if a future promotion from `internal_only` to `planner_visible` is intended, follow `/Users/seanhan/Documents/Playground/docs/system/skill_planner_visible_readiness.md`

## Isolation

- input schema must accept JSON-serializable plain data only
- output schema must produce JSON-serializable plain data only
- do not depend on shared mutable module state
- do not import repo or DB side-channel dependencies inside `src/skills/*.mjs`
- go through governed runtimes such as `read-runtime` or `mutation-runtime`

## Planner Exposure

- decide whether the skill should stay:
  - registry-only
  - planner-visible
- if planner-visible:
  - add one deterministic selector entry in `/Users/seanhan/Documents/Playground/src/planner/skill-bridge.mjs`
  - add a unique `routing_reason`
  - add a stable `selection_reason`
  - prove old selector outputs do not drift

## Tests

- add skill runtime success coverage
- add fail-closed coverage for contract violations
- add side-effect validation coverage
- add selector regression coverage
- add conflict fail-closed coverage when another skill could compete
- add regression proving existing skill behavior remains unchanged

## Docs

- update `/Users/seanhan/Documents/Playground/docs/system/skill_spec.md`
- update `/Users/seanhan/Documents/Playground/docs/system/skill_governance.md`
- update any planner/module mirror that now describes the new skill
- if code and existing docs disagree, fix the mirror in the same change
