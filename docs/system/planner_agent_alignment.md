# Planner Agent Alignment

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Purpose

This document aligns the `planner_agent` spec in [agent_spec.md](/Users/seanhan/Documents/Playground/docs/system/agent_spec.md) with the current checked-in runtime in `/Users/seanhan/Documents/Playground/src/executive-planner.mjs`.

It is an alignment document:

- it states what is already implemented
- it marks what is still spec-only
- it identifies the next refactor targets without claiming they already exist

## Current Runtime Mapping

Current runtime anchor:

- `/Users/seanhan/Documents/Playground/src/executive-planner.mjs`
- `/Users/seanhan/Documents/Playground/src/planner-flow-runtime.mjs`
- `/Users/seanhan/Documents/Playground/src/planner-runtime-info-flow.mjs`
- `/Users/seanhan/Documents/Playground/src/planner-okr-flow.mjs`
- `/Users/seanhan/Documents/Playground/src/planner-bd-flow.mjs`
- `/Users/seanhan/Documents/Playground/src/planner-delivery-flow.mjs`
- `/Users/seanhan/Documents/Playground/src/planner-doc-query-flow.mjs`
- `/Users/seanhan/Documents/Playground/src/planner-action-layer.mjs`

Current minimum runtime responsibilities already implemented there:

- planner-side intent selection
- planner action dispatch
- planner multi-step execution
- planner preset execution
- reusable planner flow interface / registry layer
- reusable planner-side company-brain doc-query pipeline
- action-level input/output contract validation
- preset-level final output validation
- normalized fail-soft error handling
- minimal retry policy
- minimal input self-healing
- planner stop boundary

This means `planner_agent` currently maps to a runtime module, not just a pure spec.

## Responsibilities

`planner_agent` currently acts as the bounded execution core for:

- selecting a tool action or preset from user intent / task type
- dispatching planner tools into agent bridge routes or company-brain routes
- running ordered multi-step plans and presets
- applying minimal runtime checks before and after dispatch
- returning a normalized result shape instead of throwing

## In Scope

Already in scope today:

- `selectPlannerTool(...)`
- `dispatchPlannerTool(...)`
- `runPlannerToolFlow(...)`
- `runPlannerMultiStep(...)`
- `runPlannerPreset(...)`
- `validateInput(...)`
- `validateOutput(...)`
- `validatePresetOutput(...)`
- minimal error taxonomy normalize
- minimal retry/self-heal/stop boundary

## Out of Scope

Still out of scope for current runtime:

- workflow completion decisions
- verifier ownership
- approval/writeback gating beyond the downstream route/workflow boundary
- independent planner worker mesh
- generic agent-to-agent router
- full handoff engine
- preset step-level validation
- externalized policy/config system

## Input Shape

Current planner-facing input shape in runtime is effectively:

```json
{
  "userIntent": "string|null",
  "taskType": "string|null",
  "payload": "object"
}
```

For direct tool dispatch the shape is:

```json
{
  "action": "string",
  "payload": "object"
}
```

For preset execution the shape is:

```json
{
  "preset": "string",
  "input": "object"
}
```

For strict user-input planning the decision shape is now:

```json
{
  "action": "string",
  "params": "object"
}
```

This path is bounded by the checked-in planner contract:

- `action` must exist in `planner_contract.json` (`actions` or `presets`)
- wrapped / non-JSON model output is rejected as `{ "error": "planner_failed" }`
- no heuristic or free-text fallback is used on this strict user-input planning path

## Output Shape

Current `runPlannerToolFlow(...)` output:

```json
{
  "selected_action": "string|null",
  "execution_result": "object|null",
  "trace_id": "string|null"
}
```

Current strict user-input planner output before execution supports both the legacy single-step shape and the new bounded multi-step shape:

```json
{
  "action": "string",
  "params": "object"
}
```

```json
{
  "steps": [
    {
      "action": "string",
      "params": "object"
    }
  ]
}
```

For the multi-step shape:

- each `steps[i].action` must resolve to an action in `planner_contract.json`
- presets are still allowed only through the legacy single-step `action` path
- each step is later dispatched through the existing planner tool execution boundary rather than a separate shortcut runtime

Current strict user-input planner error boundary:

```json
{
  "error": "planner_failed|invalid_action|contract_violation"
}
```

When the invalid item is inside `steps`, the error payload may also carry:

- `steps`
- `step_index`
- failing step `action` / `params`

`execution_result` may now also carry an additional `formatted_output` field for successful company-brain read flows; this is a presentation-layer enrichment on top of the raw tool result, not a replacement for the bounded route output.

The planner runtime also now keeps a small in-memory read context:

- `active_doc`
- `active_candidates`
- `active_theme`

This allows pronoun-style follow-ups (`這份文件`) and ordinal follow-ups (`第一份 / 第二份`) to resolve against the latest successful company-brain search/detail interaction without changing the external planner output shape.

The planner now also gives task-lifecycle follow-ups a higher-priority local read path than doc follow-up dispatch when a recent planner action-layer snapshot exists. Minimal follow-up queries such as `進度`, `誰負責`, `何時到期`, `這個卡住了`, and `這個完成了` can read or update the latest planner-side `task lifecycle v1` snapshot directly without changing the external planner response envelope or calling downstream company-brain/doc routes.

That same local task-lifecycle path now also includes a bounded `execution v1` layer in the same JSON file store: once a task is marked `in_progress`, later follow-ups can persist lightweight execution updates such as `完成一半`, `已處理`, `卡點：...`, and completion-side `結果 / 備註`, while still keeping the public planner envelope unchanged and avoiding DB / scheduler introduction.

Single-task targeting in that local follow-up path is currently limited and deterministic:

- ordinal targeting: `第一個 / 第二個 / 第N個`
- deictic targeting: `這個`
- owner targeting: query text containing one unique task `owner`

When one rule resolves exactly one task, only that task is updated and the same bounded single-task path is also used for read queries such as `第一個誰負責`, `Bob 的 task 何時到期`, `第一個的結果是什麼`, and `第一個的備註呢`, while keeping the external planner response envelope unchanged. When targeting is ambiguous, the planner returns candidate task rows in the same public planner envelope and does not mutate task state.

The planner runtime now also keeps a separate minimal in-memory conversation summary layer:

- `latest_summary`
- bounded `recent_messages`

This summary layer is used only for planner prompt assembly. When conversation turns accumulate, runtime compacts older planner exchanges into a deterministic summary that carries current planner architecture status, completed features, flow priorities, `active_doc` / `active_candidates` / `active_theme`, unfinished items, and next-step suggestions, so later planner prompting can rely on `latest_summary + recent dialogue + current user query` instead of replaying full history.

The same planner memory layer is now persisted through a minimal JSON file store, so `latest_summary`, bounded `recent_messages`, and `last_compacted_at` survive process restart and are auto-loaded before later planner prompt assembly. When runtime doc-query context is empty, the planner now lazily restores `active_doc` / `active_candidates` / `active_theme` from that persisted summary before later flow routing and prompt assembly.

The executive planner decision prompt now also reads a bounded task-state summary from that same local `task lifecycle v1` store: before agent selection, `/Users/seanhan/Documents/Playground/src/executive-planner.mjs` asks `/Users/seanhan/Documents/Playground/src/planner-task-lifecycle-v1.mjs` for the latest relevant snapshot summary and injects `unfinished_hint`, `blocked_hint`, and `in_progress_hint` into prompt assembly, so decisions can preferentially reference unfinished tasks, surface blocked-task risk, and reuse in-progress execution summaries without changing the public planner JSON shape.

That same decision-side task context now also includes a bounded `focus task` layer on top of `task driving v1`. It remains deterministic and local-only:

- scope resolution prefers `active_doc`, then matching `source_title` mentioned in the current user text, then matching task titles, then `active_theme`, then latest scope
- each scope now keeps `last_active_task_id`, allowing generic follow-ups like `這個現在怎麼辦` to stay attached to the current task instead of falling back to the whole task snapshot
- once a scope is chosen, task driving prefers that focused task for next-step / pending-question hints before considering aggregate task counts

When the model returns empty `work_items` or `pending_questions`, `/Users/seanhan/Documents/Playground/src/executive-planner.mjs` can fill those fields from that focused local task-driving hint without changing the public planner response envelope or introducing DB / scheduler behavior.

Planner prompt assembly is now explicitly context-window-governed before XML packing. `/Users/seanhan/Documents/Playground/src/executive-planner.mjs` no longer relies on raw `latest_summary + recent_messages + active_task JSON` alone. Instead it builds a bounded planner context window and prefers, in order:

- `focused_task`
- `recent_steps`
- `high_weight_doc_summaries`
- bounded `planner_task_context`
- compact `latest_summary`
- compact `active_task`
- compact `recent_dialogue`

If those inputs still exceed the local planner context budget, lower-priority material is summarized or dropped and the prompt carries only a short `older_context` note. The focused task summary can now also surface `source_title`, `source_doc_id`, and `source_summary` from planner task lifecycle items so high-weight document context survives prompt compaction instead of being lost behind long dialogue or active-task payloads.

The company-brain doc-query context and its ambiguity-aware formatter are now gathered in `/Users/seanhan/Documents/Playground/src/planner-doc-query-flow.mjs`; `/Users/seanhan/Documents/Playground/src/planner-runtime-info-flow.mjs` is the second concrete flow and handles `get_runtime_info`; `/Users/seanhan/Documents/Playground/src/planner-okr-flow.mjs` is the third concrete flow and routes OKR/topic-style knowledge questions into the existing doc-query chain; `/Users/seanhan/Documents/Playground/src/planner-bd-flow.mjs` is the fourth concrete flow and routes BD/topic-style knowledge questions into that same doc-query chain; `/Users/seanhan/Documents/Playground/src/planner-delivery-flow.mjs` is the fifth concrete flow and routes delivery/onboarding/SOP knowledge questions into that same doc-query chain; `/Users/seanhan/Documents/Playground/src/planner-action-layer.mjs` is a shared themed formatter that runs after the doc-query formatter for OKR / BD / delivery flows and adds a stable action-oriented enrichment block without changing raw tool results; its current v2 behavior remains bounded and deterministic, but detail-like results now make the first `next_actions` item state-aware when labeled `status` already says `blocked` / `in_progress` / `done`, while still keeping the same public action-layer field names and preserving extracted `owner / deadline / risks`; `/Users/seanhan/Documents/Playground/src/planner-task-lifecycle-v1.mjs` now mirrors those same `action_layer.next_actions` into a minimal planner-side task lifecycle v1 JSON store, keeps a separate operational task state (`planned -> in_progress -> blocked -> done`), extends that store with bounded `execution v1` progress/result tracking for local follow-ups, persists `last_active_task_id` per scope, and serves higher-priority local follow-up reads/updates for task-oriented queries including single-task targeting by ordinal / `這個` / unique owner while keeping the external planner result shape unchanged; `/Users/seanhan/Documents/Playground/src/planner-flow-runtime.mjs` defines the minimum internal flow contract (`route`, `shapePayload`, `readContext`, `writeContext`, `formatResult`, tracing hooks); `/Users/seanhan/Documents/Playground/src/executive-planner.mjs` remains the public planner entrypoint and wires those flows into normal select/dispatch/preset execution.

When more than one internal flow can route the same user query, the planner runtime now chooses the best candidate dynamically rather than relying on array order alone: it compares flow `priority` first, then compares flow keyword-hit count, and only uses declaration order as the final tiebreaker.

The same extracted flow now also emits minimal internal debug trace events for:

- doc-query route resolution
- doc-query result formatting

This tracing is for observability/debug only and does not change planner public result shapes.

Current `dispatchPlannerTool(...)` output:

```json
{
  "ok": "boolean",
  "action": "string|null",
  "error": "string|null",
  "data": "object",
  "trace_id": "string|null"
}
```

For company-brain planner actions, `data` now keeps the planner-facing query envelope from `src/company-brain-query.mjs`:

```json
{
  "success": "boolean",
  "data": "object",
  "error": "string|null"
}
```

That query envelope is where structured summaries, search match metadata, and doc detail summaries now live; the public planner wrapper remains unchanged.

Current `runPlannerMultiStep(...)` output:

```json
{
  "ok": "boolean",
  "steps": "array",
  "results": "array",
  "trace_id": "string|null",
  "error": "string|null",
  "stopped": "boolean",
  "stopped_at_step": "number|null"
}
```

Current multi-step runtime behavior:

- steps are executed in order
- each step goes through `dispatchPlannerTool(...)`
- default behavior is stop-on-first-error
- stopped runs return the failing step index and normalized error instead of continuing silently

Current `runPlannerPreset(...)` output:

```json
{
  "ok": "boolean",
  "preset": "string",
  "steps": "array",
  "results": "array",
  "trace_id": "string|null",
  "stopped": "boolean",
  "stopped_at_step": "number|null"
}
```

## Stop / Escalation Behavior

Current stop behavior already implemented in runtime:

- `contract_violation`
  - self-heal once on input only, then stop
- `tool_error`
  - retry once, then stop
- `runtime_exception`
  - retry once, then stop
- `business_error`
  - stop immediately

Current stopped result boundary is normalized to:

```json
{
  "ok": false,
  "action": "string|null",
  "error": "string",
  "data": {
    "stopped": true,
    "stop_reason": "string"
  },
  "trace_id": "string|null"
}
```

Preset failures preserve:

- `stopped`
- `stopped_at_step`

What is not yet runtimeized:

- a dedicated escalation subsystem
- a separate escalation queue/handler

At the moment escalation is mainly represented as a controlled stop/fallback back to planner caller.

## Handoff Behavior

Already grounded in runtime:

- planner can dispatch directly to:
  - agent bridges
  - company-brain read routes
- planner selection can choose presets over single actions

Still spec-only / not fully runtimeized:

- a standalone `handoff engine`
- explicit agent-to-agent transfer objects as a separate module

Today the closest runtime equivalent is:

- planner selection chooses bounded downstream action
- planner dispatch invokes the corresponding route/tool

## Skill Usage

Current runtime-aligned reading:

- `planning_skill` in [skill_spec.md](/Users/seanhan/Documents/Playground/docs/system/skill_spec.md) maps most closely to the current planner runtime
- `executive-planner.mjs` already behaves like planner-private capability logic
- current planner can indirectly use:
  - create doc
  - company-brain list/search/detail
  - runtime info

What is still spec-only:

- a dedicated skill runtime layer that wraps planner actions separately from `executive-planner.mjs`

## Failure Handling

Already implemented in runtime:

- fail-soft only
- no throw for controlled planner action/preset failures
- normalized error taxonomy:
  - `contract_violation`
  - `tool_error`
  - `runtime_exception`
  - `business_error`
  - `not_found`
  - `permission_denied`
- action-level contract validation
- preset-level final output validation

Still not implemented:

- preset step-level validation
- richer upstream error mapping policies

## Trace / Retry / Self-Heal Responsibility

Already implemented in `executive-planner.mjs`:

- preserve `trace_id` across action dispatch
- sticky `trace_id` across retry
- `data.retry_count`
- one-time retry for `tool_error` / `runtime_exception`
- one-time self-heal for input-side `contract_violation`
- `data.healed=true` on healed success
- minimal ambiguity handling for company-brain search/detail flows:
  - zero-hit `search_and_detail_doc` returns a controlled not-found-style formatted result
  - multi-hit `search_and_detail_doc` returns bounded candidates instead of auto-opening a document
  - ordinal follow-ups can resolve against `active_candidates`

Boundary:

- self-heal is minimal and shallow
- retry is action-dispatch only
- preset-level retry policy does not exist as an independent runtime layer

## What Is Already Landed vs Spec-Only

### Already Landed in `executive-planner.mjs`

- selection
- dispatch
- multi-step
- presets
- fail-soft runtime error normalize
- action contract validation
- preset final output validation
- retry policy
- self-heal policy
- stop boundary

### Still Spec-Only

- standalone planner agent runtime wrapper separate from `executive-planner.mjs`
- explicit handoff runtime module
- explicit escalation runtime module
- step-level preset validation
- planner policy externalization

## Next Refactor Targets

Most reasonable next refactor targets:

1. extract planner action dispatch policy into a dedicated planner-runtime submodule
2. extract preset execution policy into a dedicated preset runner module
3. add explicit step-level preset validation
4. make handoff/escalation objects first-class runtime structures instead of implied planner behavior

These are next-step refactor goals only; they are not fully implemented today.
