# Skill Spec

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Purpose

This document mirrors the checked-in minimal `agent skill` runtime baseline.

Current code anchors:

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
- it does not change deterministic routing

## Skill Concept

### What a skill is

A skill is a bounded reusable capability with:

- explicit `input_schema`
- explicit `output_schema`
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

- planner may consume a skill result
- planner does not implicitly bypass its own action registry because a skill exists

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

## Minimal Checked-In Contract

Current contract shape:

```json
{
  "name": "string",
  "input_schema": "object",
  "output_schema": "object",
  "allowed_side_effects": {
    "read": ["string"],
    "write": ["string"]
  },
  "failure_mode": "fail_closed"
}
```

Current runtime rules:

- input validation failure:
  - returns `contract_violation`
- undeclared side effect:
  - returns `contract_violation`
- invalid output shape:
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
  "failure_mode": "fail_closed"
}
```

Behavior:

1. validates `account_id` and `query`
2. calls `read-runtime` with canonical `search_knowledge_base`
3. records actual side effect as `read-runtime / index / search_knowledge_base`
4. builds a deterministic summary from retrieved snippets
5. adapts cleanly into a planner envelope through `planner/skill-bridge.mjs`

Boundary:

- does not read the repository directly
- does not call mutation runtime
- does not modify planner routing
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
