# Company Brain Agent Alignment

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Purpose

This document aligns the `company_brain_agent` spec in [agent_spec.md](/Users/seanhan/Documents/Playground/docs/system/agent_spec.md) with the currently checked-in company-brain read-side runtime and its bounded learning sidecar actions.

It is an alignment document:

- it describes what is already grounded in code
- it marks what is still spec-only
- it avoids claiming a larger autonomous knowledge agent than what the repo actually has

## Current Runtime Mapping

Current runtime anchor points:

- `/Users/seanhan/Documents/Playground/src/http-server.mjs`
- `/Users/seanhan/Documents/Playground/src/company-brain-learning.mjs`
- `/Users/seanhan/Documents/Playground/src/company-brain-query.mjs`
- `/Users/seanhan/Documents/Playground/src/rag-repository.mjs`
- `/Users/seanhan/Documents/Playground/src/db.mjs`

Current read-side company-brain runtime already exists through these routes:

- `GET /api/company-brain/docs`
- `GET /api/company-brain/docs/:doc_id`
- `GET /api/company-brain/search?q=...`
- `GET /agent/company-brain/docs`
- `GET /agent/company-brain/search`
- `GET /agent/company-brain/docs/:doc_id`
- `POST /agent/company-brain/learning/ingest`
- `POST /agent/company-brain/learning/state`

Current data source:

- `company_brain_docs`
- mirrored `lark_documents.raw_text` for summary/search enrichment
- optional `company_brain_learning_state` for planner-side learned summaries/concepts/tags

This means `company_brain_agent` currently maps to a narrow read-oriented route/repository capability layer, not to an independent long-running agent process.

## Responsibilities

`company_brain_agent` currently aligns to the following responsibilities:

- list verified document mirrors from `company_brain_docs`
- search company-brain records by `title` / `doc_id` with a basic semantic-lite ranking pass
- fetch detail for one mirrored document by `doc_id`
- derive planner-safe structured summaries from mirrored document text
- ingest a mirrored document into a simplified learning sidecar
- update simplified per-document learning state
- provide bounded read results back to planner/runtime callers

## In Scope

Already in scope today:

- company-brain docs list
- company-brain doc detail
- company-brain search
- planner-facing structured summary shaping
- planner-facing unified query envelope `{ success, data, error }`
- read-only access to verified mirror records
- bounded per-doc learning-state writes that stay outside approval/governance admission
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
- approval-governed long-term memory promotion

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

Public `/api/company-brain/*` outputs remain route-shaped, with the minimal item schema:

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

Planner-facing `/agent/company-brain/*` outputs now normalize their query payload under:

```json
{
  "success": "boolean",
  "data": "object",
  "error": "string|null"
}
```

Planner/runtime still receives the existing bounded wrapper:

```json
{
  "ok": "boolean",
  "action": "string",
  "data": {
    "success": "boolean",
    "data": "object",
    "error": "string|null"
  },
  "trace_id": "string|null"
}
```

Planner-facing `data` is summary-oriented:

- list:
  - `total`
  - `items[]`
  - each item includes `summary` and `learning_state`
- search:
  - `q`
  - `total`
  - `items[]`
  - each item includes `summary`, `learning_state`, and `match`
- detail:
  - `doc`
  - `summary`
- learning write actions return:
  - `doc`
  - `learning_state`

The planner-facing summary never returns raw full text.

## Handoff Behavior

Current practical handoff behavior:

- planner/runtime may hand off a bounded read request to company-brain routes
- this is currently implemented as direct route dispatch plus a small internal query module, not as a separate handoff runtime module

Minimum handoff-compatible request types today:

- list company-brain docs
- search company-brain docs
- get company-brain doc detail
- ingest learning doc
- update learning state

Requests that should stay with planner instead of company-brain handoff:

- create document
- document lifecycle query/retry
- runtime info
- any write path outside the bounded learning sidecar actions above

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
- richer knowledge reasoning beyond deterministic structured-summary extraction

## Next Refactor Targets

Most reasonable next refactor targets:

1. improve semantic ranking beyond the current lightweight local-token/cosine pass
2. add explicit trace/log event alignment for company-brain read-side operations
3. decide whether public `/api/company-brain/*` should eventually expose the same structured summary shape

These are future refactor goals only; they are not fully implemented today.
