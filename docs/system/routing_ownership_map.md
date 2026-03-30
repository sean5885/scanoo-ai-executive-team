# Routing Ownership Map

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Purpose

This document makes the current checked-in routing ownership explicit across:

- top-level workflow ownership
- planner-side action routing
- registered-agent dispatch
- execution boundaries

It is a code-truth mirror for the current runtime.

It does not change runtime behavior.
It does not introduce a new generic router.
It does not claim a background worker mesh or autonomous agent runtime.

## Scope Clarification

`router` in this repo is not one global routing owner.

Current checked-in routing happens in two different layers:

1. top-level workflow owner routing
   - owned by [src/control-kernel.mjs](/Users/seanhan/Documents/Playground/src/control-kernel.mjs)
   - consumed by [src/lane-executor.mjs](/Users/seanhan/Documents/Playground/src/lane-executor.mjs)
2. planner-local doc-query action routing
   - owned by [src/router.js](/Users/seanhan/Documents/Playground/src/router.js)
   - consumed through [src/planner-doc-query-flow.mjs](/Users/seanhan/Documents/Playground/src/planner-doc-query-flow.mjs) and [src/planner-flow-runtime.mjs](/Users/seanhan/Documents/Playground/src/planner-flow-runtime.mjs)

This distinction is the main boundary that prevents overlapping responsibility.

## Canonical Request Paths

### 1. Top-Level Workflow Owner Path

This is the current owner-selection path for chat/event handling:

`input event -> lane-executor.executeCapabilityLane(...) -> control-kernel.decideIntent(...) -> executive-orchestrator | doc-editor | lane owner`

Current code anchors:

- [src/lane-executor.mjs](/Users/seanhan/Documents/Playground/src/lane-executor.mjs)
- [src/control-kernel.mjs](/Users/seanhan/Documents/Playground/src/control-kernel.mjs)
- [src/executive-orchestrator.mjs](/Users/seanhan/Documents/Playground/src/executive-orchestrator.mjs)

### 2. Planner Tool Path

This is the current planner-side action path for `/answer`, knowledge-assistant, and other planner-driven execution:

`input text -> executive-planner.executePlannedUserInput(...) -> executive-planner.runPlannerToolFlow(...) -> planner-flow-runtime.resolvePlannerFlowRoute(...) -> planner-doc-query-flow.route(...) -> router.route(...) -> executive-planner.dispatchPlannerTool(...) -> tool / skill / preset executor`

Current code anchors:

- [src/executive-planner.mjs](/Users/seanhan/Documents/Playground/src/executive-planner.mjs)
- [src/planner-flow-runtime.mjs](/Users/seanhan/Documents/Playground/src/planner-flow-runtime.mjs)
- [src/planner-doc-query-flow.mjs](/Users/seanhan/Documents/Playground/src/planner-doc-query-flow.mjs)
- [src/router.js](/Users/seanhan/Documents/Playground/src/router.js)

Important boundary:

- `router.js` only chooses a planner-local action or preset for doc-query flow
- it does not own top-level session/workflow routing
- it does not dispatch tools

### 3. Executive Registered-Agent Path

This is the current executive path when the kernel routes the request to the executive workflow:

`input text -> control-kernel.decideIntent(...) -> executive-orchestrator.executeExecutiveTurn(...) -> executive-planner.planExecutiveTurn(...) -> executive-orchestrator.executeWorkItemsSequentially(...) -> agent-dispatcher.executeRegisteredAgent(...) -> retrieval + generation executor`

Current code anchors:

- [src/control-kernel.mjs](/Users/seanhan/Documents/Playground/src/control-kernel.mjs)
- [src/executive-orchestrator.mjs](/Users/seanhan/Documents/Playground/src/executive-orchestrator.mjs)
- [src/executive-planner.mjs](/Users/seanhan/Documents/Playground/src/executive-planner.mjs)
- [src/agent-dispatcher.mjs](/Users/seanhan/Documents/Playground/src/agent-dispatcher.mjs)

## Ownership Map

| Layer | Current modules | Owns | Must NOT decide | Input contract | Output contract |
| --- | --- | --- | --- | --- | --- |
| Kernel | [src/control-kernel.mjs](/Users/seanhan/Documents/Playground/src/control-kernel.mjs), consumed by [src/lane-executor.mjs](/Users/seanhan/Documents/Playground/src/lane-executor.mjs) | Same-session follow-up ownership, workflow continuity, session/workflow/scope precedence, final owner lane or executive handoff | Planner tool action, planner preset, registered-agent content, workflow completion, verifier pass/fail | `{ text, lane, activeTask, wantsCloudOrganizationFollowUp, cloudDocScopeKey }` | `{ decision, matched_task_id, precedence_source, routing_reason, guard, final_owner }` |
| Executive orchestrator | [src/executive-orchestrator.mjs](/Users/seanhan/Documents/Playground/src/executive-orchestrator.mjs) | Executive task start/continue/handoff, task lifecycle transitions, work-plan sequencing, bounded merge-agent fallback, workflow-state updates | Top-level session routing precedence, arbitrary agent registration, planner tool contract selection, verifier bypass, fake completion | `{ accountId, event, scope, activeTask?, planExecutiveTurnFn? }` | User-facing executive reply plus task/evidence side effects; internal task state updates |
| Router | [src/router.js](/Users/seanhan/Documents/Playground/src/router.js) | Deterministic doc-query target selection from text plus `activeDoc` / `activeCandidates` | Workflow owner, tool execution, skill execution, task lifecycle, retry policy, agent choice | `route(q, { activeDoc, activeCandidates })` | `{ selected_target, target_kind, routing_reason, action? , preset? , error? }` |
| Planner flows | [src/planner-flow-runtime.mjs](/Users/seanhan/Documents/Playground/src/planner-flow-runtime.mjs), [src/planner-doc-query-flow.mjs](/Users/seanhan/Documents/Playground/src/planner-doc-query-flow.mjs), [src/executive-planner.mjs](/Users/seanhan/Documents/Playground/src/executive-planner.mjs) | Flow match, flow priority resolution, payload shaping, planner action selection validation, preset orchestration, fail-soft stop boundary, planner-visible formatting/context sync | Top-level workflow owner, registered-agent assignment, task completion, approval/writeback gate, direct verifier ownership | `executePlannedUserInput({ text, ... })` and `runPlannerToolFlow({ userIntent, taskType, payload, ... })` | Planner envelope with `selected_action` or `action`, `execution_result`, `trace_id`, optional `synthetic_agent_hint`, fail-soft error fields |
| Agent dispatcher | [src/agent-dispatcher.mjs](/Users/seanhan/Documents/Playground/src/agent-dispatcher.mjs) | Registered-agent execution packaging: retrieval, checkpoint load/update, prompt assembly, generation call, boundary normalization | Which workflow owns the turn, whether executive mode should start, which agent should be chosen next, task completion, verification result | `{ accountId, agent, requestText, scope, event, supportingContext? }` | `{ text, agentId, metadata, error?, details?, context_governance? }` |
| Executors | Planner tool handlers and skill bridge inside [src/executive-planner.mjs](/Users/seanhan/Documents/Playground/src/executive-planner.mjs), planner skill bridge in [src/planner/skill-bridge.mjs](/Users/seanhan/Documents/Playground/src/planner/skill-bridge.mjs), registered-agent runtime inside [src/agent-dispatcher.mjs](/Users/seanhan/Documents/Playground/src/agent-dispatcher.mjs) | Actual read/write/retrieval/generation execution for the already-selected action or agent | Re-route upstream ownership, redefine contracts, mark workflow `completed` on their own, skip verification/stop rules | Action-specific payload or `{ agent, requestText, ... }` | Action result or agent reply only; upstream layers decide routing meaning |

## Layer-by-Layer Boundary Notes

### Kernel

Owned decision:

- whether the request stays on the current active workflow
- whether explicit executive intent overrides lane default
- whether scope-sensitive follow-up can continue on the same task
- which final owner receives the turn now

Must not decide:

- planner `selected_action`
- planner preset steps
- registered-agent answer content
- verification pass/fail

Determinism rule:

- precedence is fixed as explicit executive intent -> same session / same workflow / same scope when required -> lane guard -> lane default

### Executive Orchestrator

Owned decision:

- whether to start, continue, or hand off within the existing executive task
- which already-registered agent executes each work item
- how specialist outputs are merged and how task state advances

Must not decide:

- global session routing precedence already owned by the kernel
- tool contract schema for planner actions
- verifier completion outcome without going through the closed-loop path

Determinism rule:

- it consumes either explicit slash-command agent choice or planner-produced executive decision
- it does not invent an extra router layer after dispatch begins

### Router

Owned decision:

- doc-query action or preset only
- follow-up detail selection based on `activeDoc` or ordinal candidate references
- no-match when deterministic doc-query rules do not hit

Must not decide:

- cross-workflow owner
- which lane or executive task owns the request
- whether to execute a tool

Determinism rule:

- regex and checked context only
- no model call
- no side effects

### Planner Flows

Owned decision:

- which checked-in planner flow matches the request
- whether flow hard-route or selector result wins inside the bounded planner rules
- payload shaping and result formatting for the selected action
- stop/fail-soft behavior when contract or tool execution fails

Must not decide:

- same-session workflow ownership
- registered-agent execution ownership
- final workflow completion

Determinism rule:

- `resolvePlannerFlowRoute(...)` compares candidates by priority, keyword-hit count, then stable flow order
- `router.js` can only influence the doc-query flow
- `shouldPreferSelectorAction(...)` only overrides a narrow generic-search case

### Agent Dispatcher

Owned decision:

- how to execute an already-selected registered agent safely
- how much retrieval context, checkpoint context, image context, and supporting context enter the prompt
- how the agent reply is normalized back into a bounded text result

Must not decide:

- whether executive mode should exist
- whether another agent should take over
- whether the task is done

Determinism rule:

- dispatcher never re-plans the workflow
- it executes the supplied `agent`
- no implicit handoff happens here

### Executors

Owned decision:

- only the concrete execution of the already-approved action or agent request

Must not decide:

- upstream routing
- ownership transfer
- lifecycle terminal state

Determinism rule:

- executors return evidence/results
- upstream control layers interpret those results

## Non-Overlap Rules

The current checked-in system preserves non-overlap by keeping each decision in one place only:

1. top-level owner selection belongs to the kernel
2. executive task coordination belongs to the executive orchestrator
3. planner-local doc-query target selection belongs to `router.js`
4. planner execution, preset orchestration, and fail-soft stop belong to `executive-planner.mjs`
5. registered-agent execution packaging belongs to `agent-dispatcher.mjs`
6. underlying tool or generation execution belongs to the executor surface only

If a lower layer tries to take a higher-layer decision, ownership becomes ambiguous. Current code avoids that by design:

- `router.js` returns a route decision but never executes
- `dispatchPlannerTool(...)` executes but does not choose workflow owner
- `executeRegisteredAgent(...)` executes an already-chosen agent but does not re-route
- `control-kernel.decideIntent(...)` chooses owner but does not choose planner tool action

## Deterministic Routing Preservation

Deterministic routing is currently preserved by these checked-in rules:

1. kernel routing uses explicit precedence and guard fields instead of free-form fallback
2. planner doc-query routing in [src/router.js](/Users/seanhan/Documents/Playground/src/router.js) is pure deterministic text/context matching
3. planner flow resolution in [src/planner-flow-runtime.mjs](/Users/seanhan/Documents/Playground/src/planner-flow-runtime.mjs) uses stable comparison rules
4. executive planning may use an LLM for `planExecutiveTurn(...)`, but the handoff boundary after that stays explicit: orchestrator owns task state, dispatcher owns execution, executors do not re-route
5. fail-soft stop conditions stay in planner/orchestrator layers instead of being delegated to executors

## Practical Reading Guide

When a contributor needs to answer “who owns this routing decision?”, use this order:

1. If the question is “which workflow or lane owns this turn?”, read [src/control-kernel.mjs](/Users/seanhan/Documents/Playground/src/control-kernel.mjs).
2. If the question is “within executive mode, which registered agent acts next?”, read [src/executive-orchestrator.mjs](/Users/seanhan/Documents/Playground/src/executive-orchestrator.mjs) and [src/executive-planner.mjs](/Users/seanhan/Documents/Playground/src/executive-planner.mjs).
3. If the question is “for a doc-query planner request, which action/preset is selected?”, read [src/router.js](/Users/seanhan/Documents/Playground/src/router.js) through [src/planner-doc-query-flow.mjs](/Users/seanhan/Documents/Playground/src/planner-doc-query-flow.mjs).
4. If the question is “who actually executes the chosen action or agent?”, read [src/executive-planner.mjs](/Users/seanhan/Documents/Playground/src/executive-planner.mjs) for planner actions and [src/agent-dispatcher.mjs](/Users/seanhan/Documents/Playground/src/agent-dispatcher.mjs) for registered agents.

## Summary

Current routing ownership is explicit when read as two stacked control planes:

- kernel/orchestrator decide who owns the turn
- router/planner/dispatcher decide how the already-owned turn is executed

That split is what keeps responsibility non-overlapping and preserves deterministic routing in the current checked-in runtime.
