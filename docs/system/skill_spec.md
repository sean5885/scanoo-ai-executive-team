# Skill Spec

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Purpose

This document mirrors the checked-in minimal `agent skill` runtime baseline.

Current code anchors:

- `/Users/seanhan/Documents/Playground/src/skill-governance.mjs`
- `/Users/seanhan/Documents/Playground/src/skill-contract.mjs`
- `/Users/seanhan/Documents/Playground/src/skill-runtime.mjs`
- `/Users/seanhan/Documents/Playground/src/skill-registry.mjs`
- `/Users/seanhan/Documents/Playground/src/skills/document-fetch.mjs`
- `/Users/seanhan/Documents/Playground/src/skills/document-summarize-skill.mjs`
- `/Users/seanhan/Documents/Playground/src/skills/search-and-summarize-skill.mjs`
- `/Users/seanhan/Documents/Playground/src/planner/skill-bridge.mjs`
- `/Users/seanhan/Documents/Playground/src/user-response-normalizer.mjs`

Related mirror:

- `/Users/seanhan/Documents/Playground/docs/system/skill_surface_policy.md`
- `/Users/seanhan/Documents/Playground/docs/system/skill_planner_visible_readiness.md`

This baseline is intentionally narrow:

- it defines what a skill is
- it gives two checked-in read-only examples
- it also has one checked-in read-only helper under `src/skills/` that is not a registered skill definition
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
- a skill does not create a new outward response surface just because the skill exists
- v1 uses explicit planner actions to keep routing deterministic and auditable:
  - planner action: `search_and_summarize`
  - backing skill: `search_and_summarize`
  - surface layer: `planner_visible`
  - planner visibility: `deterministic_only`
  - selector path: chosen only by deterministic runtime conditions such as `taskType=skill_read`
  - strict planner catalog admission: only when the query matches the checked-in search-plus-summarize admission boundary; ambiguity fails closed
  - planner action: `document_summarize`
  - backing skill: `document_summarize`
  - surface layer: `planner_visible`
  - planner visibility: `deterministic_only`
  - selector path: chosen only by deterministic runtime conditions such as `taskType=document_summary_skill`
  - strict planner catalog admission: only on the non-overlapping single-document summary boundary
  - even when planner can call either skill directly, output still stays behind `planner/skill-bridge.mjs`, `user-response-normalizer.mjs`, and canonical source mapping

### Read / Write Runtime Boundary

- read-only skill:
  - must go through `/Users/seanhan/Documents/Playground/src/read-runtime.mjs`
- write-capable skill:
  - must go through the existing mutation runtime chain
- skill runtime itself:
  - is not a direct write/read escape hatch
  - cannot claim write completion without mutation-runtime evidence
- skill outward rendering:
  - must still pass through `/Users/seanhan/Documents/Playground/src/user-response-normalizer.mjs`
  - must still use canonical source rendering from `/Users/seanhan/Documents/Playground/src/answer-source-mapper.mjs`
  - must not directly expose raw `bridge`, `side_effects`, or trace-oriented fields to the user

Current checked-in examples:

- `search_and_summarize`
  - read-only
  - uses `read-runtime`
  - allowed effect is only `read:search_knowledge_base`
  - declared `skill_class=read_only`
  - declared `runtime_access=["read_runtime"]`
- `document_summarize`
  - read-only
  - uses `read-runtime`
  - allowed effect is only `read:get_company_brain_doc_detail`
  - declared `skill_class=read_only`
  - declared `runtime_access=["read_runtime"]`
- `document-fetch` helper
  - read-only helper module only
  - resolves `document_id` from direct input or raw card payload
  - reads plain text through the existing Lark read connector/auth boundary
  - returns bounded `missing_access_token | not_found | permission_denied`
  - current checked-in executor integration is through `runPlannerMultiStep(...)` in `/Users/seanhan/Documents/Playground/src/executive-planner.mjs`
  - executor uses it for internal `fetch_document` pre-read and fail-closes the plan when document retrieval fails
  - is not currently registered in `skill-registry.mjs` and does not create a planner-visible action by itself

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
It only introduces a shared contract and two minimal sample implementations.

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

### `document_summarize`

Code:

- `/Users/seanhan/Documents/Playground/src/skills/document-summarize-skill.mjs`

Contract:

```json
{
  "name": "document_summarize",
  "input_schema": {
    "type": "object",
    "required": ["account_id", "doc_id"],
    "properties": {
      "account_id": { "type": "string" },
      "doc_id": { "type": "string" },
      "pathname": { "type": ["string", "null"] },
      "reader_overrides": { "type": ["object", "null"] }
    }
  },
  "output_schema": {
    "type": "object",
    "required": ["doc_id", "title", "summary", "hits", "found", "sources", "limitations"]
  },
  "allowed_side_effects": {
    "read": ["get_company_brain_doc_detail"],
    "write": []
  },
  "skill_class": "read_only",
  "runtime_access": ["read_runtime"],
  "failure_mode": "fail_closed"
}
```

Behavior:

1. validates `account_id` and `doc_id`
2. validates input is JSON-serializable plain data
3. calls `read-runtime` with canonical `get_company_brain_doc_detail`
4. records actual side effect as `read-runtime / mirror / get_company_brain_doc_detail`
5. builds a deterministic summary from the document structured summary
6. adapts cleanly into a planner envelope through `planner/skill-bridge.mjs`

Boundary:

- does not read the repository directly
- does not call mutation runtime
- input/output are cloned by runtime, so the skill does not share caller object references
- does not add heuristic fallback or multi-skill planning
- does not change answer-service or generic detail contracts

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

This shape is planner-usable but does not register a new planner action by itself.

For planner runtime integration, the same bridge now also exposes checked-in planner-facing action results:

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

```json
{
  "ok": true,
  "action": "document_summarize",
  "data": {
    "skill": "document_summarize",
    "doc_id": "string",
    "title": "string",
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
    "runtime_access": ["read_runtime"]
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
- planner-visible promotion must pass through `internal_only -> readiness_check -> planner_visible`
- direct jump from `internal_only` to `planner_visible` is rejected fail-closed
- selector conflicts fail closed instead of choosing heuristically
- current checked-in planner skill action is read-only only
- planner-visible candidates must also keep:
  - `selector_mode = deterministic_only`
  - `runtime_access = ["read_runtime"]`
  - `allowed_side_effects.write = []`
  - existing answer/source normalization boundary
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
