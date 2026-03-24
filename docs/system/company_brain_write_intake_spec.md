# Company Brain Write / Intake Spec

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Purpose

This document defines the minimum write-side / intake-side contract for company-brain related operations.

It is a spec only:

- it does not claim a full write-side runtime already exists
- it does not replace the current read-side routes
- it does not turn company-brain into an autonomous write owner

The purpose is to make future write-side and intake-side work easier to align with the current planner/runtime boundaries.

## Current Grounded Runtime Context

Currently grounded in code:

- document creation can happen through the existing document routes/runtime
- verified documents can be mirrored into `company_brain_docs`
- company-brain read-side is already available through:
  - `GET /api/company-brain/docs`
  - `GET /api/company-brain/docs/:doc_id`
  - `GET /api/company-brain/search?q=...`

Not yet grounded as a dedicated runtime:

- standalone company-brain write agent
- standalone intake review workflow
- standalone conflict-check runtime
- write-side verifier ownership inside company-brain layer

This spec therefore describes the minimum intended interface, not a claim of full implementation.

## Capability Inventory

Minimum write/intake capability set:

- `create_doc`
- `update_doc`
- `ingest_doc`
- `review_doc`
- `conflict_check`

## Write / Intake Boundary Summary

- `create_doc`
  - may directly create a bounded new document when the caller is already in a controlled document-write path
- `update_doc`
  - should not be treated as free write; it is higher risk than create and should remain review-gated
- `ingest_doc`
  - means proposing or mirroring a document into company-brain intake flow
  - it does **not** automatically mean approved long-term memory
- `review_doc`
  - is the gate between intake/proposal and approved write-side continuation
- `conflict_check`
  - should run before an intake result is treated as stable knowledge when overlap or replacement risk exists

## `create_doc`

### purpose

- create a new bounded document record or document target inside an already controlled write path

### caller

- `planner_agent`
- future controlled write-side workflow

### callee

- document route / write adapter layer

### input shape

```json
{
  "title": "string",
  "folder_token": "string|null",
  "source": "string|null"
}
```

### output shape

```json
{
  "ok": "boolean",
  "doc_id": "string|null",
  "title": "string|null",
  "trace_id": "string|null"
}
```

### validation

- title must exist
- write target must stay inside a controlled route / adapter path
- live Lark create must fail closed unless `ALLOW_LARK_WRITES=true`
- direct route-driven create also requires explicit confirmation at the request boundary (`confirm=true`)
- `test` / `demo` / `verify` / `smoke` / `e2e` create requests must stay in a configured sandbox folder and must not rely on root fallback
- returned `doc_id` or equivalent write evidence must exist before success can be claimed

### failure handling

- fail-soft
- bounded error result
- no write success without evidence

### boundary

- `create_doc` may be directly used only in already controlled write paths
- it does not itself approve company-brain knowledge admission
- it does not replace lifecycle verification

## `update_doc`

### purpose

- update an existing document in a controlled write path

### caller

- `planner_agent`
- future controlled write-side workflow

### callee

- document route / update adapter layer

### input shape

```json
{
  "doc_id": "string",
  "content": "object|string",
  "mode": "string|null"
}
```

### output shape

```json
{
  "ok": "boolean",
  "doc_id": "string|null",
  "write_result": "object|null",
  "trace_id": "string|null"
}
```

### validation

- target `doc_id` must exist
- write mode must stay bounded by the route/adapter contract
- update evidence must exist before success can be claimed

### failure handling

- fail-soft
- bounded error result
- no overwrite-like success claim without write evidence

### boundary

- `update_doc` should be treated as review-gated by default
- it should not be used as a free-form company-brain mutation path
- it is out of scope for current read-side company-brain runtime

## `ingest_doc`

### purpose

- move a document or verified mirror candidate into company-brain intake handling

### caller

- `planner_agent`
- document lifecycle / ingestion runtime
- future company-brain write-side flow

### callee

- company-brain intake boundary
- mirror / proposal storage layer

### input shape

```json
{
  "doc_id": "string",
  "title": "string|null",
  "source": "string|null",
  "created_at": "string|null",
  "creator": "object|null"
}
```

### output shape

```json
{
  "ok": "boolean",
  "doc_id": "string|null",
  "ingest_state": "string|null",
  "trace_id": "string|null"
}
```

### validation

- source document identity must exist
- minimum metadata must be present for later review/conflict handling
- ingest record must be distinguishable from approved memory

### failure handling

- fail-soft
- bounded ingest failure
- no claim that company-brain is updated unless ingest evidence exists

### boundary

- ingest is not equal to formal knowledge admission
- ingest may populate proposal/mirror state
- ingest should not be described as approved long-term memory by default

## `review_doc`

### purpose

- provide the explicit gate before a write/intake result is treated as approved company-brain knowledge

### caller

- `planner_agent`
- future company-brain write-side workflow

### callee

- human review boundary
- future review/verifier gate

### input shape

```json
{
  "doc_id": "string",
  "review_context": "object|null",
  "proposed_action": "string|null"
}
```

### output shape

```json
{
  "ok": "boolean",
  "doc_id": "string|null",
  "review_result": "approved|rejected|needs_changes|null",
  "trace_id": "string|null"
}
```

### validation

- review target must be identifiable
- review result must be explicit before downstream approval can be claimed

### failure handling

- fail-soft
- controlled `needs_changes` / `rejected` style result
- no implicit approval

### boundary

- `review_doc` is the default gate for higher-risk update/intake paths
- write-side approval should not be inferred from create/search/list success

## `conflict_check`

### purpose

- detect whether the new or updated document conflicts with existing stable company-brain records

### caller

- `planner_agent`
- future company-brain write/intake flow

### callee

- company-brain read/query layer
- future conflict policy helper

### input shape

```json
{
  "doc_id": "string",
  "title": "string|null",
  "candidate_metadata": "object|null"
}
```

### output shape

```json
{
  "ok": "boolean",
  "doc_id": "string|null",
  "has_conflict": "boolean|null",
  "matched_docs": "array|null",
  "trace_id": "string|null"
}
```

### validation

- target identity must be known
- conflict result must be explicit before overwrite/replacement-like approval is claimed

### failure handling

- fail-soft
- controlled error or `has_conflict` unknown result
- no silent pass-through on conflict-sensitive paths

### boundary

- `conflict_check` should be triggered when:
  - a new intake may overlap an existing stable doc
  - an update may replace or contradict current approved knowledge
  - a planner flow is about to promote ingest/proposal into stable company-brain state
- it does not itself resolve the conflict

## Direct Write vs Review-Gated Matrix

### may directly write in a controlled path

- `create_doc`
  - only when already inside bounded route / adapter governance

### should require review first

- `update_doc`
- `ingest_doc` when the result is about to become approved knowledge
- any path that may overwrite, replace, or redefine stable company-brain state

## Relationship to Existing Layers

### with read-side

- read-side remains the current grounded company-brain runtime
- write/intake is layered on top of, not a replacement for, read-side routes

### with `planner_agent`

- `planner_agent` remains the decision center
- planner decides whether a request stays read-only, enters intake, or requires review/conflict handling

### with `company_brain_agent`

- current `company_brain_agent` is aligned to read-only capabilities
- future write/intake support should extend that boundary carefully, not assume it already owns write approval

## Current Boundary Summary

- this spec defines the minimum future write/intake contract only
- it does not claim that all listed capabilities already exist as runtime endpoints
- the safest current interpretation is:
  - read-side is grounded
  - write-side exists only in bounded document/runtime paths
  - intake/review/conflict handling still need future runtimeization
