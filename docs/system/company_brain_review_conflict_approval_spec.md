# Company Brain Review / Conflict / Approval Spec

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Purpose

This document defines the minimum company-brain review/conflict/approval contract.

It is a spec only:

- it does not claim that a full runtime already exists
- it does not replace the current controlled document/runtime write path
- it does not change the current read-side routes

The goal is to create a bounded contract for the next layer after `create_doc`, `update_doc`, and `ingest_doc`.

## Capability Inventory

Minimum review/conflict/approval capability set:

- `review_doc`
- `conflict_check`
- `approval_transition`

## Relationship to Existing Capabilities

Current neighboring capability groups are:

- write-side / intake-side:
  - `create_doc`
  - `update_doc`
  - `ingest_doc`
- read-side:
  - company-brain `list`
  - company-brain `detail`
  - company-brain `search`

This means:

- `create_doc`
  - can create a controlled document target
- `update_doc`
  - can modify a controlled document target
- `ingest_doc`
  - can move a verified or bounded document result into intake/mirror state
- `review_doc`
  - is the explicit gate before a write/intake result is treated as approved company-brain knowledge
- `conflict_check`
  - is the explicit gate for overlap/replacement/conflict detection
- `approval_transition`
  - is the only capability that may move intake/review output into formally approved company-brain state

## Review / Conflict / Approval Boundary Summary

- direct document creation does not equal approved company-brain knowledge
- direct document update does not equal approved company-brain knowledge
- ingest does not equal formal admission
- review is required when a write/intake result is going to be treated as stable knowledge
- conflict check is required when the new material may overlap, replace, or contradict existing knowledge
- approval transition is the final controlled step before formal company-brain admission

## When Review Is Required

Review is required at minimum when one of these is true:

- `update_doc` changes content that may become stable knowledge
- `ingest_doc` is intended to become more than mirror/proposal state
- a document is being promoted from proposal/mirror state into approved company-brain state
- the write/intake result affects an existing topic with potential ownership ambiguity

Review is not automatically required for:

- raw read-side retrieval
- listing/searching/detail lookup
- bounded create-only steps that have not yet been proposed for formal admission

## When Conflict Check Is Triggered

`conflict_check` should run when one of these is true:

- the incoming document overlaps an existing `doc_id`, title, or topic area
- an update may replace previously approved knowledge
- a verified ingest candidate may contradict current read-side material
- approval is requested for a topic that already has stable company-brain coverage

Conflict check is not required for:

- purely new isolated material with no overlap signal
- read-only list/detail/search requests

## When Approval Transition Is Allowed

`approval_transition` is allowed only when:

- the document/intake target is already identified
- review has returned an approvable result
- required conflict checks have either passed or produced an explicit accepted resolution
- the result is no longer only proposal/mirror state
- success evidence exists for the transition

Approval transition is not allowed when:

- the document is still only in mirror/proposal state
- review is missing, rejected, or unresolved
- conflict state is unresolved
- evidence is incomplete

## `review_doc`

### purpose

- provide the explicit review gate between write/intake activity and approved company-brain knowledge handling

### caller

- `planner_agent`
- future `company_brain_agent` write/intake flow

### callee

- human review boundary
- future bounded review runtime

### input shape

```json
{
  "doc_id": "string",
  "source_stage": "string|null",
  "proposed_action": "string|null",
  "review_context": "object|null"
}
```

### output shape

```json
{
  "ok": "boolean",
  "doc_id": "string|null",
  "review_result": "approved|rejected|needs_changes|null",
  "review_notes": "string|null",
  "trace_id": "string|null"
}
```

### validation

- `doc_id` must exist
- the reviewed unit must be identifiable as a write/intake candidate
- review result must stay bounded to a controlled enum-like outcome

### failure handling

- fail-soft
- bounded review failure
- no implied approval on missing review result

### boundary

- `review_doc` is a gate, not the final admission step
- it does not directly mutate read-side state
- it does not replace verification already required by the surrounding document/runtime path

## `conflict_check`

### purpose

- detect overlap, contradiction, or replacement risk before formal approval of company-brain knowledge

### caller

- `planner_agent`
- future `company_brain_agent` write/intake flow
- future approval-aware intake runtime

### callee

- future conflict-check helper/runtime
- existing read-side lookup/search as a bounded evidence source

### input shape

```json
{
  "doc_id": "string",
  "title": "string|null",
  "candidate_summary": "string|null",
  "existing_scope_hint": "string|null"
}
```

### output shape

```json
{
  "ok": "boolean",
  "doc_id": "string|null",
  "conflict_state": "none|possible|confirmed|null",
  "conflict_items": "object[]|null",
  "trace_id": "string|null"
}
```

### validation

- target document identity must exist
- the conflict result must distinguish at least:
  - no conflict
  - possible conflict
  - confirmed conflict
- conflict evidence should be linked to identifiable overlap items when available

### failure handling

- fail-soft
- bounded conflict-check failure
- unresolved conflict state should block approval transition

### boundary

- `conflict_check` does not approve or reject by itself
- it is an input to later approval decision-making
- it may use read-side search/detail as evidence input, but does not replace them

## `approval_transition`

### purpose

- move a reviewed and conflict-checked intake candidate into approved company-brain state

### caller

- `planner_agent`
- future approval-aware company-brain write/intake runtime

### callee

- future approval transition boundary
- future approved-memory persistence layer

### input shape

```json
{
  "doc_id": "string",
  "review_result": "string|null",
  "conflict_state": "string|null",
  "approval_context": "object|null"
}
```

### output shape

```json
{
  "ok": "boolean",
  "doc_id": "string|null",
  "approval_state": "approved|blocked|rejected|null",
  "trace_id": "string|null"
}
```

### validation

- `doc_id` must exist
- review outcome must be present
- conflict state must be present when conflict check is required
- transition result must clearly distinguish approved vs blocked/rejected

### failure handling

- fail-soft
- bounded approval failure
- no formal admission without explicit successful approval evidence

### boundary

- `approval_transition` is the only spec-level capability in this layer that may authorize formal admission
- it does not replace document create/update mechanics
- it should not be used for raw mirror/proposal ingest

## Current Relationship to Create / Update / Ingest / Read-Side

### `create_doc`

- can produce a bounded new document target
- does not equal review
- does not equal conflict resolution
- does not equal approval

### `update_doc`

- can change a controlled document target
- is higher risk than create
- should normally feed review before stable knowledge admission

### `ingest_doc`

- can place a verified or bounded document result into intake/mirror state
- does not equal approved company-brain memory
- should feed review/conflict/approval when promotion is intended

### read-side (`list/detail/search`)

- provides bounded retrieval and evidence lookup
- does not mutate company-brain state
- can support conflict-check input
- is downstream of approved or mirrored material, not the approval gate itself

## Current Boundary Summary

- `review_doc`, `conflict_check`, and `approval_transition` are the minimum missing layer between current controlled document/runtime paths and a future clearer company-brain write/intake runtime
- current repo behavior already supports the neighboring create/update/ingest/read-side pieces
- this layer is still spec-only and should remain bounded until a dedicated runtime refactor phase begins
