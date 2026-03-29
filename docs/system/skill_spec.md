# Skill Spec

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Purpose

This document mirrors the checked-in minimal `agent skill` runtime baseline.

Current code anchors:

- `/Users/seanhan/Documents/Playground/src/skill-governance.mjs`
- `/Users/seanhan/Documents/Playground/src/skill-contract.mjs`
- `/Users/seanhan/Documents/Playground/src/skill-runtime.mjs`
- `/Users/seanhan/Documents/Playground/src/skill-registry.mjs`
- `/Users/seanhan/Documents/Playground/src/skills/search-and-summarize-skill.mjs`
- `/Users/seanhan/Documents/Playground/src/planner/skill-bridge.mjs`

This baseline is intentionally narrow:

- it defines what a skill is
- it gives one checked-in read-only example
- it keeps planner, read-runtime, and mutation-runtime boundaries explicit
- it does not add a new public route
- it does not change mutation/read/answer contracts
- it keeps deterministic routing explicit and bounded

## Skill Concept

### What a skill is

A skill is a bounded reusable capability with:

- explicit `input_schema`
- explicit `output_schema`
- explicit `skill_class`
- explicit `runtime_access`
- declared `allowed_side_effects`
- fixed `failure_mode`

Current checked-in meaning:

- a skill is not a task owner
- a skill is not a planner action
- a skill is not a raw tool
- a skill is a small runtime wrapper that may orchestrate one or more already-governed runtime calls under a stricter contract

### Input / Output / Side Effects

- input:
  - structured object validated before execution
- output:
  - structured object validated after execution
- side effects:
  - explicitly declared as `read` or `write`
  - checked after execution
  - undeclared effects fail closed
- governance:
  - fixed `max_skills_per_run=1`
  - fixed `allow_skill_chain=false`
  - input/output must be JSON-serializable plain data

### Relationship With Planner Action And Tool

- planner action:
  - planner routing unit
  - selects what the planner should dispatch
- tool:
  - one concrete bounded route/runtime action such as `search_knowledge_base`
- skill:
  - reusable wrapper over bounded tools/runtime calls
  - may be adapted into a planner-consumable envelope
  - does not become a new routing target unless planner routing is explicitly updated later

Current checked-in planner bridge:

- `/Users/seanhan/Documents/Playground/src/planner/skill-bridge.mjs`

Boundary:

- planner may consume a skill result only through `planner/skill-bridge.mjs`
- planner does not call `skill-runtime` directly
- a skill does not bypass planner action governance just because the skill exists
- v1 uses one explicit planner action to keep routing deterministic and auditable:
  - planner action: `search_and_summarize`
  - backing skill: `search_and_summarize`
  - planner visibility: `deterministic_only`
  - selector path: only chosen by deterministic runtime conditions such as `taskType=skill_read`
  - LLM `target_catalog` does not expose this action in the normal strict user-input planner prompt

### Read / Write Runtime Boundary

- read-only skill:
  - must go through `/Users/seanhan/Documents/Playground/src/read-runtime.mjs`
- write-capable skill:
  - must go through the existing mutation runtime chain
- skill runtime itself:
  - is not a direct write/read escape hatch
  - cannot claim write completion without mutation-runtime evidence

Current checked-in example:

- `search_and_summarize`
  - read-only
  - uses `read-runtime`
  - allowed effect is only `read:search_knowledge_base`
  - declared `skill_class=read_only`
  - declared `runtime_access=["read_runtime"]`

## Minimal Checked-In Contract

Current contract shape:

```json
{
  "name": "string",
  "input_schema": "object",
  "output_schema": "object",
  "skill_class": "read_only|write|hybrid",
  "runtime_access": ["read_runtime|mutation_runtime"],
  "allowed_side_effects": {
    "read": ["string"],
    "write": ["string"]
  },
  "failure_mode": "fail_closed"
}
```

Current runtime rules:

- missing or mismatched governance metadata:
  - throws `invalid_skill_definition`
- input validation failure:
  - returns `contract_violation`
- non-serializable input:
  - returns `contract_violation`
- undeclared side effect:
  - returns `contract_violation`
- nested skill execution:
  - returns `contract_violation`
- invalid output shape:
  - returns `contract_violation`
- non-serializable output:
  - returns `contract_violation`
- runtime failure:
  - returns controlled failure such as `runtime_exception`
- no path is allowed to silently continue after contract drift

## Implicit Skills Already Present In Existing Workflows

These capabilities existed before the checked-in skill runtime, but were embedded inside workflows rather than exposed through a shared skill contract.

| Existing capability | Why it is an implicit skill | Current boundary |
| --- | --- | --- |
| `meeting-agent.mjs` meeting summarization | structured transcript/notes to `summary/decisions/action_items/...` conversion is a reusable bounded capability | summarization is skill-like; final writeback still stays in meeting workflow and mutation runtime |
| `doc-comment-rewrite.mjs` rewrite proposal | reads document + comments and outputs a bounded rewrite proposal | preview/rewrite is skill-like; final apply still stays in confirmation + mutation runtime |
| `answer-service.mjs` retrieval-answer helper | performs read-runtime search and turns results into a bounded answer/summary | helper is skill-like; public `/answer` remains planner-first |
| `planner/knowledge-bridge.mjs` planner answer helper | rewrites query, retrieves, and builds summary for planner-side knowledge use | helper is skill-like; still not a generic skill runtime |

Current checked-in skill baseline does not replace those flows.
It only introduces a shared contract and one minimal sample implementation.

## Checked-In Example Skill

### `search_and_summarize`

Code:

- `/Users/seanhan/Documents/Playground/src/skills/search-and-summarize-skill.mjs`

Contract:

```json
{
  "name": "search_and_summarize",
  "input_schema": {
    "type": "object",
    "required": ["account_id", "query"],
    "properties": {
      "account_id": { "type": "string" },
      "query": { "type": "string" },
      "limit": { "type": ["number", "null"] },
      "pathname": { "type": ["string", "null"] },
      "reader_overrides": { "type": ["object", "null"] }
    }
  },
  "output_schema": {
    "type": "object",
    "required": ["query", "summary", "hits", "found", "sources", "limitations"]
  },
  "allowed_side_effects": {
    "read": ["search_knowledge_base"],
    "write": []
  },
  "skill_class": "read_only",
  "runtime_access": ["read_runtime"],
  "failure_mode": "fail_closed"
}
```

Behavior:

1. validates `account_id` and `query`
2. validates input is JSON-serializable plain data
3. calls `read-runtime` with canonical `search_knowledge_base`
4. records actual side effect as `read-runtime / index / search_knowledge_base`
5. builds a deterministic summary from retrieved snippets
6. adapts cleanly into a planner envelope through `planner/skill-bridge.mjs`

Boundary:

- does not read the repository directly
- does not call mutation runtime
- input/output are cloned by runtime, so the skill does not share caller object references
- does not add heuristic fallback or multi-skill planning
- does not change answer-service output contract

## Planner-Consumable Shape

`/Users/seanhan/Documents/Playground/src/planner/skill-bridge.mjs` converts a skill result into:

```json
{
  "ok": true,
  "action": "skill:search_and_summarize",
  "data": {
    "skill": "search_and_summarize",
    "query": "string|null",
    "summary": "string|null",
    "hits": "number",
    "found": "boolean",
    "sources": ["object"],
    "limitations": ["string"],
    "side_effects": ["object"]
  },
  "trace_id": "string|null"
}
```

This shape is planner-usable but does not register a new planner action.

For planner runtime integration, the same bridge now also exposes one checked-in planner-facing action result:

```json
{
  "ok": true,
  "action": "search_and_summarize",
  "data": {
    "skill": "search_and_summarize",
    "query": "string|null",
    "summary": "string|null",
    "hits": "number",
    "found": "boolean",
    "sources": ["object"],
    "limitations": ["string"],
    "side_effects": ["object"],
    "bridge": "skill_bridge",
    "max_skills_per_run": 1,
    "allow_skill_chain": false,
    "skill_class": "read_only",
    "runtime_access": ["read_runtime"],
    "selector_mode": "deterministic_only",
    "selector_task_types": ["knowledge_read_skill", "skill_read"]
  },
  "trace_id": "string|null"
}
```

This keeps the integration explicit:

- planner action selection stays deterministic
- planner dispatch still goes through one bounded registry entry
- skill execution still stays behind `skill-bridge`
- the bridge does not expose a generic `run any skill` route

## Planner Integration Rules

Current v1 rules:

- planner -> skill path is `planner action -> skill-bridge -> skill-runtime -> read-runtime`
- direct planner -> skill-runtime calls are not allowed
- each planner execution may use at most one skill-backed action
- skill chaining is not allowed
- planner-visible skills must have unique deterministic selector keys
- selector conflicts fail closed instead of choosing heuristically
- current checked-in planner skill action is read-only only
- declared side effects must stay within:
  - `read: ["search_knowledge_base"]`
  - `write: []`
- any skill failure remains `fail_closed`
- planner does not fall back from a failed skill-backed action into another tool/preset path inside the same execution

## Failure Model

Current checked-in failure policy is `fail_closed`.

Examples:

- empty `query`:
  - `contract_violation`
- read-runtime failure:
  - `runtime_exception`
- skill reports undeclared write effect:
  - `contract_violation`
- output shape drift:
  - `contract_violation`

Tests:

- `/Users/seanhan/Documents/Playground/tests/skill-runtime.test.mjs`

## Relationship Graph

See:

- [agent_graph.mmd](/Users/seanhan/Documents/Playground/docs/system/agent_graph.mmd)
