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
- `/Users/seanhan/Documents/Playground/src/read-runtime.mjs`
- `/Users/seanhan/Documents/Playground/src/company-brain-learning.mjs`
- `/Users/seanhan/Documents/Playground/src/mutation-runtime.mjs`
- `/Users/seanhan/Documents/Playground/src/company-brain-query.mjs`
- `/Users/seanhan/Documents/Playground/src/rag-repository.mjs`
- `/Users/seanhan/Documents/Playground/src/db.mjs`

Current read-side company-brain runtime now enters through `/Users/seanhan/Documents/Playground/src/read-runtime.mjs`, which accepts a canonical read request, fixes `primary_authority = "mirror"` for the first batch, and delegates every company-brain read to `/Users/seanhan/Documents/Playground/src/company-brain-query.mjs` as the only mirror reader.

The current route surfaces are:

- `GET /api/company-brain/docs`
- `GET /api/company-brain/docs/:doc_id`
- `GET /api/company-brain/search?q=...`
- `GET /agent/company-brain/docs`
- `GET /agent/company-brain/search`
- `GET /agent/company-brain/docs/:doc_id`
- `GET /agent/company-brain/approved/docs`
- `GET /agent/company-brain/approved/search`
- `GET /agent/company-brain/approved/docs/:doc_id`
- `POST /agent/company-brain/learning/ingest`
- `POST /agent/company-brain/learning/state`

Current data source:

- `company_brain_docs`
- mirrored `lark_documents.raw_text` for summary/search enrichment
- optional `company_brain_learning_state` for planner-side learned summaries/concepts/tags
- internal-only review/approval persistence:
  - `company_brain_review_state`
  - `company_brain_approved_knowledge`

This means `company_brain_agent` currently maps to a narrow read-oriented route/repository capability layer, not to an independent long-running agent process.

## Responsibilities

`company_brain_agent` currently aligns to the following responsibilities:

- list verified document mirrors from `company_brain_docs`
- search company-brain records by `title` / `doc_id` with a composite ranking pass over keyword match, semantic-lite similarity, learning tags/key concepts, and recency
- fetch detail for one mirrored document by `doc_id`
- read approved company-brain rows through the same mirror-backed runtime envelope
- derive planner-safe structured summaries from mirrored document text
- ingest a mirrored document into a simplified learning sidecar
- update simplified per-document learning state
- route learning writes through the shared mutation runtime instead of direct route-local persistence
- provide bounded read results back to planner/runtime callers without live fallback or multi-authority mixing

## In Scope

Already in scope today:

- company-brain docs list
- company-brain doc detail
- company-brain search
- approved company-brain list/search/detail
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
- standalone write approval runtime
- direct Feishu write orchestration
- independent knowledge synthesis engine
- autonomous company-brain worker/runtime
- planner-facing approval-governed long-term memory routes

## Input Shape

Public route inputs still stay list/detail/search shaped, but the checked-in internal read-runtime now normalizes them into:

```json
{
  "action": "string",
  "account_id": "string",
  "payload": "object",
  "context": "object"
}
```

The current route-facing payload variants remain:

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
  "limit": "number|null",
  "top_k": "number|null"
}
```

## Output Shape

The internal read-runtime result now stays on one canonical envelope:

```json
{
  "ok": "boolean",
  "action": "string",
  "primary_authority": "mirror",
  "authorities_attempted": ["mirror"],
  "fallback_used": false,
  "result": {
    "success": "boolean",
    "data": "object",
    "error": "string|null"
  },
  "error": "string|null"
}
```

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
  - `top_k`
  - `total`
  - `items[]`
  - each item includes `summary`, `learning_state`, and `match`
  - `match` now carries composite `score`, per-signal component scores, and simplified `ranking_basis`
  - ranking is now deterministic for the same query/data snapshot: composite score stays fixed for that snapshot, ties are broken by per-signal scores and stable doc metadata (`doc_id` / `title`), and no runtime randomness is used in the read-side ranking pass
  - `summary.snippet` is now one deterministic top-1 sentence/line per document, chosen by exact-query/token hit score and then by source order
- detail:
  - `doc`
  - `summary`
  - `summary` keeps a fixed object shape: `overview`, `headings`, `highlights`, `snippet`, `content_length`
- learning write actions return:
  - `doc`
  - `learning_state`

The planner-facing summary never returns raw full text.

## Handoff Behavior

Current practical handoff behavior:

- planner/runtime may hand off a bounded read request to company-brain routes
- this is currently implemented as direct route dispatch plus a small internal query module, not as a separate handoff runtime module
- detail-like planner presets still derive the follow-up `doc_id` from the ranked search result order, so higher-weight documents are preferred before detail fetch when the search side can safely narrow to one candidate
- ordinal follow-up reads are expected to stay bound to the previously returned candidate index; they should not silently fall back to an unrelated active document when no candidate index is available

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
- helper-driven review/approval promotion, which currently exists only as an internal persistence boundary

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
