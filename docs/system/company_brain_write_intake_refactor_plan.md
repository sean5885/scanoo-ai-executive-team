# Company Brain Write / Intake Runtime Refactor Plan

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Purpose

This document is a minimum refactor plan for evolving the current controlled document/runtime write path plus verified mirror ingest into a clearer company-brain write/intake runtime shape over time.

It is a planning document only:

- it does not change runtime behavior
- it assumes existing write paths and validated lifecycle behavior must stay stable
- it prefers staged internal cleanup over one-shot redesign

## Current Structure

Current write/intake-adjacent behavior is spread across:

- `/Users/seanhan/Documents/Playground/src/http-server.mjs`
- `/Users/seanhan/Documents/Playground/src/lark-content.mjs`
- `/Users/seanhan/Documents/Playground/src/rag-repository.mjs`
- `/Users/seanhan/Documents/Playground/src/db.mjs`

Current grounded responsibilities already implemented:

- controlled document create path
- controlled document update path
- document lifecycle status advancement
- verified-to-company-brain mirror ingest
- read-side access to ingested mirror records

This means the current shape is:

- document/runtime write path first
- lifecycle/index/verify path second
- non-blocking company-brain mirror ingest after verification

It is not yet a dedicated company-brain write/intake runtime.

## Target Structure

Target direction is a clearer company-brain write/intake split, while preserving current external behavior:

- document write entry layer
- write/intake helper layer
- write/intake failure boundary layer
- ingest boundary layer
- future review/conflict/approval interface layer

This does **not** mean introducing a full company-brain write service immediately.

## Keep As-Is

These parts should stay as-is for now because they are already validated and externally visible:

- current document create/update route behavior
- current lifecycle result shapes
- current company-brain mirror schema
- current non-blocking ingest behavior after `verified`
- current company-brain read-side routes
- current `trace_id` behavior

## Extract Later

These are good candidates for later extraction into smaller internal helpers:

- create/update shared write-side helpers
- lifecycle-to-ingest transition helpers
- shared company-brain mirror payload normalization
- write/intake failure boundary helpers
- write/intake trace/log helpers

The key rule is:

- extraction later should preserve route contracts and existing lifecycle semantics

## Defer For Now

These should be explicitly deferred until the current write/intake boundary is cleaner:

- dedicated `review_doc` runtime
- dedicated `conflict_check` runtime
- full approval flow inside company-brain layer
- company-brain-owned verification runtime
- standalone company-brain write agent wrapper
- autonomous long-running write/intake worker

## Refactor Phases

### Phase 1: Clarify Create / Update / Ingest Internal Responsibility Boundaries

- status:
  - completed

- goal:
  - reorganize current write/intake-adjacent logic conceptually without changing external behavior
- scope:
  - make create/update/ingest responsibilities easier to see
  - align naming and internal flow descriptions
  - keep route contracts unchanged
- constraints:
  - no route rename
  - no response shape changes
  - no lifecycle semantics changes
  - no ingest behavior changes

Current Phase 1 landing:

- keeps the external create/update/lifecycle/company-brain-ingest behavior unchanged
- clarifies internal responsibility boundaries through:
  - shared create/update input parsing helpers
  - shared lifecycle transition logging helpers
  - shared create-failure / created-seed / index-failure lifecycle helpers
  - shared permission-grant helper boundary
  - clearer separation between document write, lifecycle transition, and company-brain ingest concerns

### Phase 2: Extract Minimum Write / Intake Helpers and Failure Boundary Structures

- status:
  - completed

- goal:
  - move stable write/intake concerns into clearer helper structures
- scope:
  - extract create/update shared helpers where safe
  - extract lifecycle-to-ingest helper boundary
  - extract write/intake failure boundary helpers
  - extract shared mirror payload normalization helpers
- constraints:
  - keep existing HTTP routes as the stable surface
  - keep planner integration behavior unchanged
  - keep read-side routes unchanged

Current Phase 2 landing:

- keeps the external create/update/document-runtime behavior unchanged
- extracts a clearer minimum write/intake helper structure for:
  - write-side auth payload/result building
  - create success response shaping
  - update apply/replace-preview response shaping
  - create-side index/ingest success-failure boundary handling
- keeps the same response shape, route contracts, trace behavior, and ingest trigger point

### Phase 3: Reserve Interfaces for Future Review / Conflict / Approval

- goal:
  - make the current write/intake runtime easier to wrap in a clearer company-brain boundary later
- scope:
  - define stable internal interfaces for:
    - future `review_doc`
    - future `conflict_check`
    - future approval-aware intake
- constraints:
  - no full review runtime yet
  - no full conflict runtime yet
  - no approval ownership transfer in this phase

## What Should Not Be Touched Now

To avoid breaking already validated behavior, these should not be changed in the near-term refactor:

- `/api/doc/create` external behavior
- `/api/doc/update` external behavior
- current lifecycle status progression
- current company-brain ingest trigger point (`verified`)
- current company-brain mirror schema
- current read-side route shapes
- current auth and trace behavior

## What Can Be Safely Refactored First

These are good first moves because they are mostly semantic/internal:

- clarify create/update/ingest helper grouping
- isolate company-brain mirror payload building
- isolate write/intake failure boundary helpers
- improve comments and responsibility grouping around write/intake transitions

These should be done without changing:

- route names
- output shapes
- planner-facing behavior
- lifecycle semantics
- read-side expectations

## Validation Strategy

Every refactor phase should preserve the existing validated write/intake surface.

Minimum validation after each phase:

- document create still succeeds/fails with the same route contract
- document update still follows the same route contract
- lifecycle still advances through the same states
- verified documents still mirror into `company_brain_docs`
- read-side list/detail/search still reflect mirrored docs

When available, preserve existing live checks:

- document create
- lifecycle query/retry
- company-brain ingest
- company-brain list/detail/search
- planner flows that depend on create + read-side company-brain capabilities

## Rollback Boundary

Rollback should stay simple:

- keep the current document routes and company-brain read routes as the stable external surface
- avoid simultaneous refactors across write paths, planner runtime, and read-side contracts
- if a refactor breaks behavior, revert only the write/intake-internal extraction/change set

Practical rollback boundary:

- one phase per PR/change set
- no concurrent write-side, review-side, and planner-surface rewrites

## Current Boundary Summary

- current company-brain write/intake behavior is still anchored in controlled document/runtime paths
- the safest near-term goal is internal clarity, not broader write capability expansion
- future company-brain write/intake wrapperization should be prepared by helper/interface extraction, not by replacing current routes in one step
