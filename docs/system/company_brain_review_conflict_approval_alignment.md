# Company Brain Review / Conflict / Approval Alignment

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Purpose

This document aligns [company_brain_review_conflict_approval_spec.md](/Users/seanhan/Documents/Playground/docs/system/company_brain_review_conflict_approval_spec.md) with the runtime paths that are now checked in.

It is still an alignment document:

- it identifies what is grounded in code today
- it keeps the boundary between a minimum runnable slice and a full governance system explicit
- it avoids claiming a human-review UI, semantic conflict engine, or verifier-owned approval runtime that does not exist

## Current Runtime Mapping

Current grounded runtime anchor points:

- `/Users/seanhan/Documents/Playground/src/http-server.mjs`
- `/Users/seanhan/Documents/Playground/src/company-brain-review.mjs`
- `/Users/seanhan/Documents/Playground/src/company-brain-write-intake.mjs`
- `/Users/seanhan/Documents/Playground/src/company-brain-query.mjs`
- `/Users/seanhan/Documents/Playground/src/rag-repository.mjs`
- `/Users/seanhan/Documents/Playground/src/db.mjs`

Current company-brain review/conflict/approval/apply slice now exists through:

- `POST /agent/company-brain/review`
- `POST /agent/company-brain/conflicts`
- `POST /agent/company-brain/approval-transition`
- `POST /agent/company-brain/docs/:doc_id/apply`
- `GET /agent/company-brain/approved/docs`
- `GET /agent/company-brain/approved/search`
- `GET /agent/company-brain/approved/docs/:doc_id`

Neighboring grounded runtime behavior remains:

- bounded document create path:
  - `POST /api/doc/create`
- bounded document update path:
  - `POST /api/doc/update`
- document lifecycle and lifecycle retry:
  - `created -> indexed -> verified`
  - plus failure states
- verified mirror ingest into `company_brain_docs`
- persisted company-brain review state in `company_brain_review_state`
- persisted approved-only admission boundary in `company_brain_approved_knowledge`
- company-brain read-side:
  - `GET /api/company-brain/docs`
  - `GET /api/company-brain/docs/:doc_id`
  - `GET /api/company-brain/search?q=...`

This means the current runtime is now:

- document/runtime write path first
- verified mirror ingest second
- explicit agent-facing review/conflict/approval/apply slice third
- separated approved-only query boundary after apply

It is a **minimum runnable vertical slice**, not a full company-brain governance runtime.

## `review_doc` Alignment

### current alignment

Grounded as a direct agent-facing runtime plus helper-backed persistence.

### what is grounded

- `resolveCompanyBrainWriteIntake(...)` marks update, overlap, and formal-promotion paths as `review_required`
- `/Users/seanhan/Documents/Playground/src/company-brain-review.mjs` stages:
  - `pending_review`
  - `conflict_detected`
  - `approved`
  - `rejected`
- `POST /agent/company-brain/review`
  - runs the bounded review staging path against one mirrored doc
  - returns both `intake_boundary` and persisted `review_state`

### what is still not grounded

- no human review UI
- no multi-actor review workflow
- no company-brain-owned review state machine beyond per-doc bounded status persistence

## `conflict_check` Alignment

### current alignment

Grounded as a direct bounded runtime over read-side overlap evidence.

### what is grounded

- `resolveCompanyBrainWriteIntake(...)` uses read-side title overlap as the minimum `conflict_check_required` signal
- overlap candidates can persist `review_status=conflict_detected` into `company_brain_review_state`
- `POST /agent/company-brain/conflicts`
  - performs the explicit conflict-check step
  - returns `conflict_state=none|possible|confirmed`
  - returns `conflict_items`
  - keeps the bounded evidence source separate from apply

### what is still not grounded

- no semantic/topic-level conflict engine
- no conflict-resolution workflow beyond explicit bounded evidence and status persistence

## `approval_transition` Alignment

### current alignment

Grounded as a direct agent-facing decision transition plus a separate apply step.

### what is grounded

- helper output explicitly marks `approval_required_for_formal_source` when target stage is approved knowledge
- `POST /agent/company-brain/approval-transition`
  - persists `review_status=approved|rejected`
  - keeps that decision separate from final apply
- `POST /agent/company-brain/docs/:doc_id/apply`
  - only succeeds when `review_status=approved`
  - promotes the doc into `company_brain_approved_knowledge`
- approved-only reads now exist through:
  - `GET /agent/company-brain/approved/docs`
  - `GET /agent/company-brain/approved/search`
  - `GET /agent/company-brain/approved/docs/:doc_id`

### what this means

- verified mirror ingest is still not formal approval
- approval decision and apply are now explicit, separate runtime steps
- approved knowledge can now be queried without reading mirror-only rows

### what it is not

- not a company-brain-owned verifier
- not a complete long-term memory governance system
- not a human approval UI
- not a semantic approval/conflict resolution workflow

## In Scope

Currently in scope for grounded alignment:

- controlled document create/update paths
- lifecycle verification before mirror ingest
- verified mirror ingest into `company_brain_docs`
- explicit agent-facing review/conflict/approval/apply routes
- approved-only list/search/detail reads after apply
- planner/runtime separation between document path, mirror read path, and approved read path

## Out of Scope

Still out of scope for current runtime:

- direct public approval-governed write routes
- company-brain-owned verifier
- human review UI
- semantic/topic-level conflict resolution
- autonomous company-brain worker/runtime
- canonical long-term memory governance

## Current Gaps

Main gaps between spec and current runtime:

1. `review_doc`
   - direct route now exists
   - review still uses bounded per-doc persistence, not a richer workflow engine
2. `conflict_check`
   - direct route now exists
   - conflict evidence is still limited to bounded overlap signals, mainly title/doc overlap
3. `approval_transition`
   - direct decision route plus apply route now exist
   - approval is still not verifier-owned and still lacks human-review UI

## Current Boundary Summary

- `review_doc` is now runtimeized as a bounded agent route, but still not a human workflow system
- `conflict_check` is now runtimeized as a bounded overlap-evidence route, but still not semantic conflict resolution
- `approval_transition` plus `apply` are now explicit runtime steps, and mirror ingest must still not be described as formal approval
- current grounded company-brain runtime is:
  - controlled document/runtime path
  - verified mirror ingest
  - explicit review/conflict/approval/apply slice
  - separate approved-only read boundary
