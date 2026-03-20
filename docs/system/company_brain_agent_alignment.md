# Company Brain Agent Alignment

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Purpose

This document aligns the `company_brain_agent` spec in [agent_spec.md](/Users/seanhan/Documents/Playground/docs/system/agent_spec.md) with the currently checked-in company-brain read-side runtime.

It is an alignment document:

- it describes what is already grounded in code
- it marks what is still spec-only
- it avoids claiming a larger autonomous knowledge agent than what the repo actually has

## Current Runtime Mapping

Current runtime anchor points:

- `/Users/seanhan/Documents/Playground/src/http-server.mjs`
- `/Users/seanhan/Documents/Playground/src/rag-repository.mjs`
- `/Users/seanhan/Documents/Playground/src/db.mjs`

Current read-side company-brain runtime already exists through these routes:

- `GET /api/company-brain/docs`
- `GET /api/company-brain/docs/:doc_id`
- `GET /api/company-brain/search?q=...`

Current data source:

- `company_brain_docs`

This means `company_brain_agent` currently maps to a narrow read-oriented route/repository capability layer, not to an independent long-running agent process.

## Responsibilities

`company_brain_agent` currently aligns to the following responsibilities:

- list verified document mirrors from `company_brain_docs`
- search company-brain records by `title` / `doc_id`
- fetch detail for one mirrored document by `doc_id`
- provide bounded read results back to planner/runtime callers

## In Scope

Already in scope today:

- company-brain docs list
- company-brain doc detail
- company-brain search
- read-only access to verified mirror records
- bounded route-level error handling for:
  - `invalid_query`
  - `not_found`
  - auth-required access

## Out of Scope

Still out of scope for current runtime:

- direct document creation
- document lifecycle control
- verifier ownership
- write approval logic
- direct Feishu write orchestration
- independent knowledge synthesis engine
- autonomous company-brain worker/runtime

## Input Shape

Current effective input shapes are:

### list

```json
{
  "limit": "number|null"
}
```

### detail

```json
{
  "doc_id": "string"
}
```

### search

```json
{
  "q": "string",
  "limit": "number|null"
}
```

## Output Shape

Current list/detail/search outputs are all route-shaped, with the minimal item schema:

```json
{
  "doc_id": "string",
  "title": "string",
  "source": "string",
  "created_at": "string",
  "creator": {
    "account_id": "string",
    "open_id": "string"
  }
}
```

### list/search wrapper shape

```json
{
  "ok": "boolean",
  "action": "string",
  "total": "number",
  "items": "array",
  "trace_id": "string|null"
}
```

### detail wrapper shape

```json
{
  "ok": "boolean",
  "action": "string",
  "item": "object|null",
  "trace_id": "string|null"
}
```

## Handoff Behavior

Current practical handoff behavior:

- planner/runtime may hand off a bounded read request to company-brain routes
- this is currently implemented as direct route dispatch, not as a separate handoff runtime module

Minimum handoff-compatible request types today:

- list company-brain docs
- search company-brain docs
- get company-brain doc detail

Requests that should stay with planner instead of company-brain handoff:

- create document
- document lifecycle query/retry
- runtime info
- any write path

## Stop / Escalation Behavior

Current controlled stop/escalation-like behaviors already present through routes:

- empty search query:
  - returns `ok=false`
  - `error=invalid_query`
- missing `doc_id` route target:
  - route-level invalid path/use remains outside company-brain detail success path
- nonexistent `doc_id`:
  - returns `ok=false`
  - `error=not_found`
- missing auth context:
  - returns controlled auth failure instead of silent success

What is not yet runtimeized:

- a dedicated company-brain escalation subsystem
- explicit upward escalation events to planner as a first-class runtime object

At the moment, escalation is effectively represented as a controlled route failure that planner/runtime can interpret.

## Skill Usage

Current skill alignment is:

- `company_brain_search_skill`
- `company_brain_detail_skill`

These are aligned to current read-side capabilities.

What is already grounded:

- the route/capability surface these skills describe

What is still spec-only:

- a dedicated runtime skill wrapper around those routes

## Failure Handling

Already grounded in current runtime:

- fail-soft route responses
- `invalid_query` for empty search
- `not_found` for missing mirrored doc
- `trace_id` in responses
- bounded read-side schema shape

Not yet grounded as a separate runtime layer:

- company-brain-specific error normalization module
- dedicated company-brain retry/escalation policy

## Memory Boundary

Current memory boundary is strict:

- `company_brain_agent` reads from `company_brain_docs`
- it does not directly write memory
- mirror writes happen elsewhere:
  - when verified document lifecycle reaches ingest

This means:

- read-side company-brain access is runtime-grounded
- write-side company-brain ownership is **not** part of the current company-brain agent alignment

## What Is Already Landed vs Spec-Only

### Already Landed

- read-only list/detail/search routes
- repository/database-backed company-brain mirror reads
- bounded route-level controlled failures
- planner-accessible search/detail/list capabilities

### Still Spec-Only

- standalone `company_brain_agent` runtime wrapper
- dedicated handoff/escalation runtime objects
- richer knowledge reasoning or summarization behavior inside company-brain agent

## Next Refactor Targets

Most reasonable next refactor targets:

1. extract company-brain read route/repository logic into a clearer internal company-brain runtime boundary
2. align planner dispatch and company-brain route results to one more explicit handoff shape
3. add explicit trace/log event alignment for company-brain read-side operations

These are future refactor goals only; they are not fully implemented today.
