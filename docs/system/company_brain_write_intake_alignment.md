# Company Brain Write / Intake Alignment

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Purpose

This document aligns [company_brain_write_intake_spec.md](/Users/seanhan/Documents/Playground/docs/system/company_brain_write_intake_spec.md) with the runtime paths that already exist in this repo.

It is an alignment document:

- it identifies what is already grounded in code
- it marks what is only partially represented through controlled document/runtime paths
- it avoids overstating current company-brain write-side maturity

## Current Runtime Mapping

Current grounded runtime anchor points:

- `/Users/seanhan/Documents/Playground/src/http-server.mjs`
- `/Users/seanhan/Documents/Playground/src/company-brain-write-intake.mjs`
- `/Users/seanhan/Documents/Playground/src/lark-content.mjs`
- `/Users/seanhan/Documents/Playground/src/rag-repository.mjs`
- `/Users/seanhan/Documents/Playground/src/db.mjs`

Current write/intake-adjacent paths already in code:

- `POST /api/doc/create`
  - bounded document creation
- `POST /api/doc/update`
  - bounded document update / write path
- document lifecycle inside `/api/doc/create` and `/api/doc/lifecycle/retry`
  - `created -> indexed -> verified`
  - plus failure states
- non-blocking mirror write into `company_brain_docs` when lifecycle reaches `verified`
- an internal write-intake policy helper now classifies:
  - whether verified ingest may stay `direct_intake`
  - whether the path should be treated as `review_required`
  - whether overlap evidence should trigger `conflict_check_required`
  - whether promotion into formal knowledge would still remain `approval_required_for_formal_source`

Current company-brain-specific read-side remains:

- `GET /api/company-brain/docs`
- `GET /api/company-brain/docs/:doc_id`
- `GET /api/company-brain/search?q=...`

This means the current runtime is:

- document/runtime write path first
- company-brain mirror ingest second
- company-brain read-side after ingest

It is **not** yet a standalone company-brain write runtime.

## `create_doc` Alignment

### current alignment

Partially grounded in code through:

- `/api/doc/create`
- planner tool `create_doc`
- agent bridge `/agent/docs/create`

### what is already grounded

- controlled document creation exists
- creation returns bounded success/failure shape
- write path remains inside auth + route + adapter governance
- successful create can later feed lifecycle and mirror ingest

### what it is not

- not a native company-brain write endpoint
- not direct approved company-brain admission
- not a substitute for lifecycle verification

## `update_doc` Alignment

### current alignment

Partially grounded in code through:

- `/api/doc/update`
- preview/apply style controlled document update paths
- review-aware workflow/kernel constraints documented elsewhere

### what is already grounded

- bounded update path exists
- write path is not free-form and already sits behind controlled document/runtime rules
- runtime now classifies `update_doc` as review-gated before any stable company-brain promotion

### what it is not

- not a dedicated company-brain mutation API
- not an autonomous write-side owned by `company_brain_agent`
- not currently aligned to a company-brain-specific verifier

## `ingest_doc` Alignment

### current alignment

Partially grounded in code through:

- `ingestVerifiedDocumentToCompanyBrain(...)`
- `resolveCompanyBrainWriteIntake(...)`
- verified lifecycle transition writing into `company_brain_docs`
- `stage=company_brain_ingest` logging
- `stage=company_brain_intake_boundary` logging

### what is already grounded

- verified documents can be mirrored into `company_brain_docs`
- ingest is non-blocking relative to lifecycle success
- verified ingest now resolves a minimum intake boundary before mirror upsert:
  - no overlap signal -> `direct_intake_allowed=true`
  - overlap signal -> `review_required=true` and `conflict_check_required=true`
  - formal knowledge promotion stays separated as `approval_required_for_formal_source=true`
- mirror row schema is bounded:
  - `doc_id`
  - `title`
  - `source`
  - `created_at`
  - `creator`

### what it is not

- not a full intake workflow
- not explicit proposal-vs-approved memory governance inside company-brain layer
- not a separate company-brain approval runtime

### alignment note

Current runtime maps best to:

- "verified document mirror ingest"

not to:

- "formal company-brain knowledge approval"

## `review_doc` Alignment

### current alignment

Partially grounded as a helper-level boundary, not as a standalone runtime.

There is still no dedicated company-brain `review_doc` route or review state machine today.

### partial adjacent grounding

Review/confirm gates already exist in other document/workflow paths:

- `doc_rewrite`
- `cloud_doc`
- preview/review/apply flows
- `resolveCompanyBrainWriteIntake(...)` now marks update/promotion/overlap paths as `review_required`

### what this means

- review as a system concept is grounded
- company-brain-specific write/intake review is only a minimum policy decision today
- it is **not** yet runtimeized as its own independent capability

## `conflict_check` Alignment

### current alignment

Partially grounded as a bounded evidence helper.

### partial adjacent grounding

Conflict concepts already exist in surrounding system areas:

- workflow verifier expectations mention `conflict_items`
- knowledge/conflict-oriented command/docs exist elsewhere in the repo
- search/read-side capability now feeds the intake policy helper as bounded overlap evidence
- current overlap evidence is limited to read-side `title` matches excluding the same `doc_id`

### what is not yet grounded

- no dedicated company-brain write/intake conflict-check runtime
- no explicit `conflict_check` route
- no semantic/topic-level conflict resolver tied to write-side promotion

## In Scope

Currently in scope for grounded alignment:

- bounded document creation path
- bounded document update path
- verified mirror ingest into `company_brain_docs`
- read-side list/detail/search over mirrored docs
- planner-aware use of create/read-side capabilities

## Out of Scope

Still out of scope for current runtime:

- direct company-brain write ownership
- standalone write-side company-brain agent
- company-brain-specific review gate
- company-brain-specific verification ownership
- company-brain-specific conflict resolution runtime
- automatic approval of long-term company-brain knowledge on ingest

## Current Gaps

Main gaps between spec and current runtime:

1. `create_doc`
   - grounded as document creation, not as company-brain-native write
2. `update_doc`
   - grounded as controlled document update, not as company-brain mutation contract
3. `ingest_doc`
   - grounded as verified mirror write plus a minimum intake policy helper, but not as a full intake state machine
4. `review_doc`
   - only helper-level gating exists; no dedicated company-brain review runtime yet
5. `conflict_check`
   - only title/doc overlap evidence exists; no dedicated company-brain write-side conflict runtime yet

## Next Refactor Targets

Most reasonable next refactor targets:

1. keep the helper-level intake matrix stable and reuse it from future planner/runtime callers
2. separate company-brain mirror ingest terminology from generic document lifecycle terminology
3. lift helper-level review/conflict decisions into an explicit bounded interface only when a real runtime is added
4. keep read-side and document write-side separate until a true company-brain write boundary exists

## Current Boundary Summary

- some write/intake-adjacent behavior is already grounded in code
- that grounding currently lives in controlled document/runtime paths, not in a standalone company-brain write runtime
- `create_doc`, `update_doc`, and `ingest_doc` have partial runtime alignment
- `review_doc` and `conflict_check` now have a minimum helper-level boundary, but not a standalone runtime
