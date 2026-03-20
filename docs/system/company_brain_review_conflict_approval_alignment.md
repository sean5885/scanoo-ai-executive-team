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

### what is not yet grounded

- no dedicated `conflict_check` route
- no semantic/topic-level write-side conflict helper
- no explicit conflict state persistence tied to company-brain promotion

### alignment note

Current runtime only proves:

- search/read-side can support bounded overlap evidence gathering

It does **not** prove:

- company-brain conflict resolution is already runtimeized

## `approval_transition` Alignment

### current alignment

Mostly spec-only.

### what is partially grounded

The closest grounded behavior is:

- lifecycle reaching `verified`
- non-blocking mirror ingest into `company_brain_docs`
- helper-level output explicitly marking `approval_required_for_formal_source` when target stage is approved knowledge

### what this means

- verified mirror ingest is a bounded controlled path
- it can be used as an intake/mirror boundary
- formal admission remains a separately identified future step

### what it is not

- not a formal approval runtime
- not approved long-term memory governance
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
   - closest current actual write behavior is still verified mirror ingest
   - that is not a formal approval runtime

## Next Refactor Targets

Most reasonable next refactor targets:

1. keep the helper-level review/conflict/approval matrix stable for current callers
2. lift bounded overlap evidence into an explicit conflict-check interface only when a real runtime is added
3. separate "verified mirror ingest" terminology from "approval transition" terminology more explicitly
4. keep approval work interface-only until review/conflict boundaries are clearer

## Current Boundary Summary

- `review_doc` currently has helper-level gating plus adjacent review/confirm flows, but no standalone runtime
- `conflict_check` currently has helper-level read-side overlap evidence, but no standalone runtime
- `approval_transition` is still effectively spec-only; verified mirror ingest must not be described as formal approval runtime
- current grounded company-brain runtime remains:
  - controlled document/runtime path
  - verified mirror ingest
  - company-brain read-side
