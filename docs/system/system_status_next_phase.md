# System Status and Next Phase

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Purpose

This document is a minimum status snapshot of the current system surface and a pragmatic next-phase ordering guide.

It is intentionally limited to capabilities that are already grounded in checked-in code and validated docs.

Current note:

- this file is a planning/status snapshot, not the primary current-truth mirror
- for current company-brain boundary truth after the landed review/conflict/approval/apply slice, prefer:
  - `/Users/seanhan/Documents/Playground/docs/system/company_brain.md`
  - `/Users/seanhan/Documents/Playground/docs/system/modules.md`
  - `/Users/seanhan/Documents/Playground/docs/system/data_flow.md`
  - `/Users/seanhan/Documents/Playground/docs/system/api_map.md`

## 1. planner_agent

### Current Status

- current status:
  - active
  - grounded in `/Users/seanhan/Documents/Playground/src/executive-planner.mjs`
  - internally refactored through Phase 3 without changing public behavior

### Completed Work

- selection for single-step tools and compound preset intents
- action dispatch to bounded agent/document/company-brain/runtime routes
- action-level contract validation
- preset-level final output validation
- fail-soft error normalization
- minimal retry / self-heal / stop policy
- minimal planner trace runtime
- no-op internal hook points reserved for future wrapper / handoff / escalation

### Remaining Gaps

- no dedicated planner-agent wrapper runtime
- no step-level preset validation
- no true handoff runtime
- no true escalation runtime
- trace runtime is still local to planner module

### Risk If Continue Now

- continuing directly into bigger planner behavior changes risks breaking validated action/preset flows
- planner currently mixes stable runtime behavior with future-facing hook points in one file

### Recommended Next Step

- hold planner runtime behavior stable
- next planner-side work should focus on wrapper/interface extraction only when another runtime surface actually needs it

## 2. company_brain_agent read-side

### Current Status

- current status:
  - active
  - grounded in company-brain read routes and repository helpers
  - Phase 2 internal refactor completed

### Completed Work

- list route
- detail route
- search route
- bounded failures such as `invalid_query` and `not_found`
- shared list/detail/search helpers
- shared read-side failure boundary helpers

### Remaining Gaps

- no independent company-brain agent runtime
- no dedicated handoff runtime
- no verification-owned company-brain operations
- no write-side ownership

### Risk If Continue Now

- pushing read-side into a larger agent abstraction too early would add wrapper complexity without new runtime value
- changing read-side semantics now could break planner presets and live routes already validated

### Recommended Next Step

- keep read-side stable
- only add alignment-level or wrapper-prep work when write-side/runtime ownership becomes real

## 3. company_brain_write_intake

### Current Status

- current status:
  - partially grounded
  - backed by controlled document/runtime path plus verified mirror ingest
  - Phase 2 internal refactor completed

### Completed Work

- controlled document create path
- controlled document update path
- lifecycle advancement
- verified-to-company-brain mirror ingest
- internal helper/boundary cleanup for create/update/ingest

### Remaining Gaps

- no dedicated company-brain write runtime
- no `review_doc` runtime
- no `conflict_check` runtime
- no approval-aware intake flow
- no write-side ownership transfer from document/runtime path

### Risk If Continue Now

- continuing directly into write-side expansion is the highest-risk path because it touches document writes, lifecycle, and ingest semantics together
- any premature review/conflict/approval implementation could destabilize currently validated document routes

### Recommended Next Step

- if we continue this line, Phase 3 should stay interface-only:
  - reserve internal hooks for `review_doc`
  - reserve internal hooks for `conflict_check`
  - reserve internal hooks for approval-aware intake
- do not change public write behavior yet

## 4. runtime control

### Current Status

- current status:
  - active
  - grounded in HTTP routes, lifecycle, trace injection, auth gating, and request logging

### Completed Work

- per-request `trace_id`
- controlled document create/update routes
- lifecycle query / retry / summary
- runtime-info route
- agent bridges
- company-brain ingest/list/detail/search routes
- high-risk route child logs and route success coverage

### Remaining Gaps

- no single cross-module runtime control layer
- no unified runtime policy module across planner + document + company-brain
- no broader event model implementation beyond current partial route/planner trace coverage

### Risk If Continue Now

- broad runtime-control refactor now would span too many validated surfaces at once
- risk is high because HTTP routes are already serving as the stable integration surface

### Recommended Next Step

- keep route/runtime control stable for now
- only do narrowly scoped runtime-control changes when they support an already-prioritized write-side or agent-wrapper need

## 5. interface / agent / skill / routing specs

### Current Status

- current status:
  - documented
  - mostly spec-only
  - grounded only where code alignment documents explicitly say so

### Completed Work

- planner contract
- system interface spec
- agent spec
- routing / handoff spec
- skill spec
- planner/company-brain alignment specs
- trace log spec
- refactor plans

### Remaining Gaps

- most interface/handoff/escalation layers are not runtimeized
- no shared runtime enforcement of the broader interface specs
- skill layer is still a documented contract, not an independent runtime mesh

### Risk If Continue Now

- continuing to add spec breadth without runtime landing will increase documentation surface faster than executable value
- there is also a risk of overstating system maturity if spec work outruns code grounding

### Recommended Next Step

- pause broad spec expansion unless it directly supports the next code refactor phase
- prefer alignment/refactor-plan updates over entirely new abstract layers

## Next Phase Candidates

### Candidate A

- candidate:
  - company_brain_write_intake Phase 3
- why now:
  - it is the most direct path from current grounded write/runtime behavior toward clearer future review/conflict boundaries
- why not now:
  - it touches the highest-risk surface and should stay interface-only unless there is a concrete execution need

### Candidate B

- candidate:
  - company_brain_agent Phase 3
- why now:
  - read-side is already stable and can safely reserve handoff/write-side/verification interfaces
- why not now:
  - there is still no independent company-brain runtime, so wrapper prep may outpace real runtime demand

### Candidate C

- candidate:
  - planner wrapper-prep follow-up
- why now:
  - planner refactor phases are complete and internal hooks already exist
- why not now:
  - planner is already the most mature runtime surface, so more planner work yields less immediate payoff than clarifying company-brain ownership

### Candidate D

- candidate:
  - stop and stabilize
- why now:
  - current validated coverage across planner, company-brain read-side, and controlled document/runtime path is already broad
- why not now:
  - leaves write/intake future interfaces still deferred

## Priority Order

1. company_brain_write_intake Phase 3
2. company_brain_agent Phase 3
3. stabilize and observe
4. planner wrapper-prep follow-up

## Why Now / Why Not Now

- why `company_brain_write_intake Phase 3` is first:
  - it addresses the clearest remaining structural gap between validated document runtime writes and future company-brain write ownership
- why not jump directly into runtime review/conflict/approval:
  - those are still ungrounded and would create too much semantic change too early
- why `company_brain_agent Phase 3` is second:
  - it can prepare future handoff boundaries after write/intake boundaries are clearer
- why planner is later:
  - planner runtime is already comparatively mature and validated; it is not the current bottleneck
- why stabilization remains a valid option:
  - the system now spans multiple aligned specs plus validated runtime surfaces, so another pause can reduce refactor risk before new capability growth
