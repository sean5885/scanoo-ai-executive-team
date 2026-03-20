# Company Brain Agent Runtime Refactor Plan

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Purpose

This document is a minimum refactor plan for evolving the current company-brain read-side routes/capabilities into a clearer `company_brain_agent` runtime shape over time.

It is a planning document only:

- it does not change runtime behavior
- it assumes current route behavior and validated read-side flows must stay stable
- it prefers staged internal cleanup over one-shot redesign

## Current Structure

Current company-brain read-side behavior is spread across:

- `/Users/seanhan/Documents/Playground/src/http-server.mjs`
- `/Users/seanhan/Documents/Playground/src/rag-repository.mjs`
- `/Users/seanhan/Documents/Playground/src/db.mjs`

Current responsibilities already implemented:

- list company-brain docs
- search company-brain docs
- get one company-brain doc detail
- return bounded route-level failures such as `invalid_query` and `not_found`

This means the current shape is route/repository driven, not a standalone agent runtime.

## Target Structure

Target direction is a clearer `company_brain_agent` runtime split, while preserving current external behavior:

- company-brain read route layer
- company-brain query/helper layer
- company-brain failure boundary layer
- company-brain handoff-facing interface layer

This does **not** mean introducing a full autonomous company-brain service immediately.

## Keep As-Is

These parts should stay as-is for now because they are already validated and externally visible:

- route paths:
  - `/api/company-brain/docs`
  - `/api/company-brain/docs/:doc_id`
  - `/api/company-brain/search`
- current response shapes
- current `trace_id` behavior
- current route-level controlled failures
- current `company_brain_docs` read model

## Extract Later

These are good candidates for later extraction into smaller internal helpers:

- list/search/detail repository helpers
- shared company-brain item normalization
- shared company-brain route response helpers
- read-side failure boundary helpers
- company-brain trace/log event helpers

The key rule is:

- extraction later should preserve route contracts and current planner-facing behavior

## Defer For Now

These should be explicitly deferred until the read-side is cleaner:

- write-side company-brain runtime
- verification ownership
- lifecycle ownership
- dedicated handoff runtime module
- dedicated escalation runtime module
- independent long-running company-brain agent wrapper
- richer knowledge reasoning/summarization inside company-brain layer

## Refactor Phases

### Phase 1: Clarify Read-Side Internal Responsibility Boundaries

- goal:
  - reorganize the current read-side logic conceptually without changing external behavior
- scope:
  - make list/search/detail responsibilities easier to see
  - align naming and internal flow descriptions
  - keep route contracts unchanged
- constraints:
  - no route rename
  - no response shape changes
  - no auth or trace behavior changes

Status:

- completed
- current Phase 1 landing keeps the existing read-side surface unchanged while clarifying internal responsibilities through:
  - shared company-brain read-side request parsing helpers
  - shared company-brain read-side success/failure response helpers
  - shared company-brain read-side log helper usage
  - centralized repository read-field selection for list/detail/search

### Phase 2: Extract Minimum Search/Detail/List Helper and Failure Boundary Structures

- goal:
  - move stable read-side concerns into clearer helper structures
- scope:
  - extract list/search/detail helpers
  - extract shared failure boundary helpers for `invalid_query` / `not_found`
  - extract shared item-shape normalization helpers
- constraints:
  - keep the current HTTP routes as the stable surface
  - no change to planner integration behavior
  - no change to company-brain ingest/write paths

Status:

- completed
- current Phase 2 landing keeps the same read-side route surface while extracting:
  - shared list/detail/search read helpers in the HTTP read-side path
  - shared read-side auth/result wrapper helpers
  - shared read-side failure boundary helpers for `missing_doc_id`, `invalid_query`, and `not_found`
  - a smaller repository-side read query shape around the stable list/detail/search SQL semantics

### Phase 3: Reserve Interfaces for Future Handoff / Write-Side / Verification

- goal:
  - make the current read-side easier to wrap into a clearer `company_brain_agent` boundary later
- scope:
  - define stable internal interfaces for:
    - read-side handoff
    - future write-side ingestion hooks
    - future verification-aware company-brain operations
- constraints:
  - no standalone runtime yet
  - no write-side expansion in this phase
  - no verifier ownership transfer

## What Should Not Be Touched Now

To avoid breaking already validated behavior, these should not be changed in the near-term refactor:

- route paths
- route response shapes
- current item schema:
  - `doc_id`
  - `title`
  - `source`
  - `created_at`
  - `creator`
- current search semantics on `title` / `doc_id`
- current auth requirement behavior
- current `invalid_query` / `not_found` handling

## What Can Be Safely Refactored First

These are good first moves because they are mostly semantic/internal:

- clarify read-side helper grouping
- unify list/search/detail normalization helpers
- isolate read-side failure boundary helpers
- improve comments and responsibility grouping around company-brain read routes

These should be done without changing:

- route names
- output shapes
- planner-facing behavior
- test expectations

## Validation Strategy

Every refactor phase should preserve the existing validated company-brain read surface.

Minimum validation after each phase:

- list route still returns expected item schema
- detail route still returns expected item schema
- search route still matches `title` / `doc_id`
- `invalid_query` remains controlled
- `not_found` remains controlled

When available, preserve existing live checks:

- company-brain list
- company-brain detail
- company-brain search
- planner preset flows that depend on company-brain read-side routes

## Rollback Boundary

Rollback should stay simple:

- keep existing company-brain routes as the stable surface during all phases
- avoid simultaneous refactors across company-brain read routes and planner runtime behavior
- if a refactor breaks read-side behavior, revert only the company-brain-internal extraction/change set

Practical rollback boundary:

- one phase per PR/change set
- no concurrent write-side/lifecycle behavior changes

## Current Boundary Summary

- current company-brain behavior is already a working minimum read-side capability layer
- the safest near-term goal is clearer internal structure, not larger capability expansion
- future `company_brain_agent` wrapperization should be prepared by interface/helper extraction, not by replacing current routes in one step
