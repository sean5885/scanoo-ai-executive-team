# Company Brain Review / Conflict / Approval Alignment

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Purpose

This document aligns [company_brain_review_conflict_approval_spec.md](/Users/seanhan/Documents/Playground/docs/system/company_brain_review_conflict_approval_spec.md) with the runtime paths that already exist in this repo.

It is an alignment document:

- it identifies what is already grounded in code
- it marks what is only partially represented through current document/runtime paths
- it avoids overstating current company-brain approval maturity

## Current Runtime Mapping

Current grounded runtime anchor points:

- `/Users/seanhan/Documents/Playground/src/http-server.mjs`
- `/Users/seanhan/Documents/Playground/src/company-brain-review.mjs`
- `/Users/seanhan/Documents/Playground/src/company-brain-write-intake.mjs`
- `/Users/seanhan/Documents/Playground/src/lark-content.mjs`
- `/Users/seanhan/Documents/Playground/src/rag-repository.mjs`
- `/Users/seanhan/Documents/Playground/src/db.mjs`

Current adjacent runtime behavior already in code:

- bounded document create path:
  - `POST /api/doc/create`
- bounded document update path:
  - `POST /api/doc/update`
- document lifecycle and lifecycle retry:
  - `created -> indexed -> verified`
  - plus failure states
- verified mirror ingest into `company_brain_docs`
- helper-level write-intake classification for review/conflict/approval requirements
- persisted company-brain review state in `company_brain_review_state`
- persisted approved-only admission boundary in `company_brain_approved_knowledge`
- company-brain read-side:
  - `GET /api/company-brain/docs`
  - `GET /api/company-brain/docs/:doc_id`
  - `GET /api/company-brain/search?q=...`

This means the current runtime is:

- document/runtime write path first
- verified mirror ingest second
- company-brain read-side after ingest

It is **not** yet a dedicated review/conflict/approval runtime.

## `review_doc` Alignment

### current alignment

Partially grounded as a helper-level gate, not a direct runtime.

### what is partially grounded

Review-style concepts already exist in neighboring system paths:

- document replace preview / confirm
- `doc_rewrite` preview/review/apply flows
- `cloud_doc` preview/review/apply flows
- lifecycle verification before stable completion
- `resolveCompanyBrainWriteIntake(...)` now marks update, overlap, and formal-promotion paths as `review_required`
- `/Users/seanhan/Documents/Playground/src/company-brain-review.mjs` can now persist:
  - `pending_review`
  - `conflict_detected`
  - `approved`
  - `rejected`

### what is not yet grounded

- no dedicated `review_doc` route
- no company-brain-specific review state machine

### alignment note

Current runtime only proves:

- review is a real system concept
- company-brain write/intake now has a minimum internal review decision boundary

It does **not** prove:

- company-brain review already exists as an independent runtime capability

## `conflict_check` Alignment

### current alignment

Partially grounded as bounded overlap evidence, with no standalone runtime.

### what is partially grounded

Adjacent conflict signals already exist:

- workflow outputs may carry `conflicts` / `conflict_items`
- company-brain read-side search/detail can act as bounded lookup evidence
- verification logic elsewhere already treats conflicting or incomplete state as a blocking concern
- `resolveCompanyBrainWriteIntake(...)` now uses read-side title overlap as a minimum `conflict_check_required` signal
- overlap candidates now persist `review_status=conflict_detected` with matched documents in `company_brain_review_state`

### what is not yet grounded

- no dedicated `conflict_check` route
- no semantic/topic-level write-side conflict helper
- no semantic/topic-level conflict resolver beyond bounded title/doc overlap evidence

### alignment note

Current runtime only proves:

- search/read-side can support bounded overlap evidence gathering

It does **not** prove:

- company-brain conflict resolution is already runtimeized

## `approval_transition` Alignment

### current alignment

Partially grounded as helper-driven persistence, but still not a standalone runtime.

### what is partially grounded

The closest grounded behavior is:

- lifecycle reaching `verified`
- non-blocking mirror ingest into `company_brain_docs`
- helper-level output explicitly marking `approval_required_for_formal_source` when target stage is approved knowledge
- explicit review decisions can now persist `review_status=approved|rejected`
- only `review_status=approved` may be promoted into `company_brain_approved_knowledge`

### what this means

- verified mirror ingest is a bounded controlled path
- it can be used as an intake/mirror boundary
- formal admission now has a minimal persisted storage boundary distinct from mirror and learning

### what it is not

- not a formal approval runtime
- not a complete approved long-term memory governance system
- not an explicit `approval_transition`
- not a separate approval-aware company-brain state machine

### alignment note

Current runtime maps best to:

- "verified mirror ingest"

not to:

- "approved company-brain admission"

## In Scope

Currently in scope for grounded alignment:

- controlled document create/update paths
- lifecycle verification before mirror ingest
- verified mirror ingest into `company_brain_docs`
- company-brain read-side lookup as bounded evidence input
- planner/runtime separation between document path and read-side path

## Out of Scope

Still out of scope for current runtime:

- direct company-brain approval ownership
- standalone review runtime
- standalone conflict-check runtime
- standalone approval-transition runtime
- long-term memory approval workflow inside company-brain layer
- company-brain-owned verifier

## Current Gaps

Main gaps between spec and current runtime:

1. `review_doc`
   - helper-level review gating exists
   - no direct company-brain review runtime
2. `conflict_check`
   - only title/doc overlap evidence exists
   - no direct company-brain conflict-check runtime
3. `approval_transition`
   - helper-level approval requirement exists
   - minimum approval persistence now exists
   - there is still no standalone approval route/runtime or verifier-owned approval flow

## Next Refactor Targets

Most reasonable next refactor targets:

1. keep the helper-level review/conflict/approval matrix stable for current callers
2. lift bounded overlap evidence into an explicit conflict-check interface only when a real runtime is added
3. keep the new approved-only query boundary separate from mirror read-side routes
4. keep approval work helper-driven until review/conflict boundaries are clearer

## Current Boundary Summary

- `review_doc` currently has helper-level gating plus adjacent review/confirm flows, but no standalone runtime
- `conflict_check` currently has helper-level read-side overlap evidence plus persisted `conflict_detected` review state, but no standalone runtime
- `approval_transition` now has minimal persisted `approved/rejected` state plus `company_brain_approved_knowledge`, but verified mirror ingest must still not be described as formal approval runtime
- current grounded company-brain runtime remains:
  - controlled document/runtime path
  - verified mirror ingest
  - company-brain read-side
  - helper-driven review/approval persistence
