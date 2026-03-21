# Company Brain Review / Conflict / Approval Runtime Refactor Plan

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Purpose

This document defines a minimum refactor plan for the future company-brain review/conflict/approval runtime.

It starts from the runtime that already exists today:

- controlled document/runtime create and update paths
- lifecycle verification before mirror ingest
- verified mirror ingest into `company_brain_docs`
- company-brain read-side routes

It does **not** claim that a standalone review/conflict/approval runtime already exists.

## Current Structure

Current grounded structure is split across adjacent layers:

- document/runtime write path in `/Users/seanhan/Documents/Playground/src/http-server.mjs`
- minimum review/approval helper in `/Users/seanhan/Documents/Playground/src/company-brain-review.mjs`
- document SDK/write adapters in `/Users/seanhan/Documents/Playground/src/lark-content.mjs`
- lifecycle and mirror persistence in `/Users/seanhan/Documents/Playground/src/rag-repository.mjs`
- company-brain read-side list/detail/search over `company_brain_docs`

Current review/conflict/approval behavior is only partial:

- `review_doc`
  - adjacent review concepts exist through preview/confirm/review style flows
  - minimum persisted statuses now exist in `company_brain_review_state`
- `conflict_check`
  - adjacent conflict signals and read-side evidence sources exist
  - overlap candidates can now persist `conflict_detected`
- `approval_transition`
  - verified -> mirror ingest still exists
  - explicit `approved|rejected` persistence plus `company_brain_approved_knowledge` now exists as a minimal boundary

## Target Structure

Target structure should stay small and explicit:

- review/conflict/approval remains downstream of the controlled document/runtime path
- review/conflict/approval gets its own bounded helper layer
- approval transition stays distinct from mirror ingest
- company-brain read-side continues to provide evidence inputs, not admission decisions
- future approval flow can be attached without rewriting the current write path

## Keep As-Is

These parts should remain unchanged during this refactor sequence:

- public document/runtime routes
- current response shapes
- current lifecycle semantics
- current verified mirror ingest behavior
- company-brain read-side route semantics

## Extract Later

These are reasonable candidates for later extraction:

- review-related boundary helpers around preview/confirm/review-like paths
- conflict evidence gathering helpers that read from company-brain search/detail
- approval-transition input/output shaping helpers
- a small shared failure-boundary helper for review/conflict/approval work

## Defer For Now

These should remain deferred until later phases:

- formal approval runtime
- standalone `review_doc` route
- standalone `conflict_check` route
- standalone `approval_transition` route
- approval-aware long-term memory governance
- company-brain-owned verifier
- human approval UI or workflow mesh

## Refactor Phases

### Phase 1

Organize the partial review/conflict related paths without changing behavior.

Focus:

- clarify internal responsibility boundaries around neighboring review/confirm paths
- make partial conflict-related evidence sources easier to identify
- improve comments/naming/structure only

Guardrail:

- no public behavior change

Status:

- completed

Landed scope:

- clarified internal section boundaries around:
  - company-brain conflict-evidence read helpers
  - company-brain approval-adjacent mirror ingest
  - review-adjacent preview/review helpers for drive/wiki/doc-rewrite paths
- extracted only tiny helper builders and local response/logging helpers
- kept route names, response shapes, lifecycle semantics, and mirror-ingest meaning unchanged

### Phase 2

Extract minimum review/conflict helpers and failure-boundary structure.

Focus:

- add bounded helper shapes for review-style path handling
- add bounded helper shapes for conflict-evidence collection from read-side lookup
- centralize fail-soft boundary handling for future review/conflict work

Guardrail:

- still no standalone approval runtime
- still no public surface change

Status:

- completed

Landed scope:

- added bounded review/conflict-adjacent helper shapes inside `/Users/seanhan/Documents/Playground/src/http-server.mjs`
- centralized small success/failure response helpers for:
  - drive/wiki organize preview-required boundaries
  - doc rewrite confirmation failure boundaries
  - organize success result shaping
- kept public routes, response shapes, search semantics, lifecycle semantics, and verified mirror-ingest meaning unchanged

### Phase 3

Reserve interfaces for approval transition / approval flow.

Focus:

- define minimum internal approval-transition hook points
- separate mirror-ingest terminology from approval terminology in runtime structure
- prepare future interfaces for approval, rejection, and unresolved-conflict outcomes

Guardrail:

- no full approval mesh
- no independent runtime wrapper yet

Status:

- completed

Landed scope:

- added minimum helper-level review state persistence in `company_brain_review_state`
- added minimum helper-level approved storage in `company_brain_approved_knowledge`
- kept public mirror read-side routes unchanged
- added approved-only internal query boundary so formal knowledge reads do not include mirror/learning-only rows

## What Must Not Move Yet

These are too risky to change now:

- verified mirror ingest semantics
- current document lifecycle state meanings
- company-brain read-side route contracts
- planner-facing assumptions around current document/runtime behavior

## What Can Be Refactored Safely First

These are safe Phase 1 / Phase 2 candidates:

- internal helper extraction
- naming cleanup
- comments and responsibility boundaries
- internal failure-boundary normalization
- read-side evidence gathering helpers used by future conflict checks

## What Belongs to Later Work

These belong to later work, not this plan's early phases:

- formal `review_doc` runtime
- formal `conflict_check` runtime
- formal `approval_transition` runtime
- approval-specific verifier behavior
- approval UI / workflow / human approval routing

## Validation Strategy

Each phase should validate:

- no route contract changes
- no response-shape changes
- no search/read-side semantic drift
- no write-path regression
- no verified-ingest regression

Recommended validation approach:

- existing document/runtime tests
- existing workflow smoke/integration tests
- targeted company-brain read-side smoke checks
- route-level regression checks for create/update/list/detail/search

## Rollback Boundary

Rollback should stay simple:

- if a refactor changes behavior instead of only structure, revert to the previous helper/route layout
- keep public route contracts untouched until approval runtime truly exists
- do not merge approval terminology into mirror-ingest code paths until approval transition is explicitly implemented

## Current Planning Boundary

This plan is intentionally conservative:

- current runtime is still:
  - document/runtime path
  - verified mirror ingest
  - company-brain read-side
- helper-driven review/conflict/approval persistence is now grounded
- review/conflict/approval is not yet an independent runtime
- formal approval remains future work
