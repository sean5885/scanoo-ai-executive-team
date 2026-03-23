# Planner Agent Alignment

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Purpose

This document aligns the `planner_agent` spec in [agent_spec.md](/Users/seanhan/Documents/Playground/docs/system/agent_spec.md) with the current checked-in runtime in `/Users/seanhan/Documents/Playground/src/executive-planner.mjs`.

This document now reflects the current fail-closed baseline for planner routing and execution.

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
- `/Users/seanhan/Documents/Playground/src/planner/agent-executor.mjs`
- `/Users/seanhan/Documents/Playground/src/planner/agent-runtime.mjs`

Current minimum runtime responsibilities already implemented there:

- planner-side intent selection
- planner action dispatch
- planner multi-step execution
- planner preset execution
- reusable planner flow interface / registry layer
- reusable planner-side company-brain doc-query pipeline
- bounded planner-side company-brain learning ingest/update dispatch
- action-level input/output contract validation
- preset-level final output validation
- normalized fail-soft error handling
- minimal retry policy
- minimal input self-healing
- planner stop boundary
- bounded planner-side `agent_execution` derivation on planner output

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
- bounded lane-to-agent selection helper via `executeAgent(...)`

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

## Bounded Lane-to-Agent Helper

`/Users/seanhan/Documents/Playground/src/planner/agent-executor.mjs` now provides a very small planner-side helper:

- input:
  - `{ "lane": "meeting|doc|runtime|mixed|..." }`
- output:
  - `{ "agent": "string", "action": "string", "status": "ok|fallback" }`

Current checked-in behavior:

- `meeting -> meeting_agent / meeting_summary`
- `doc -> doc_agent / doc_answer`
- `runtime -> runtime_agent / runtime_check`
- `mixed -> mixed_agent / mixed_lane`
- unknown lane -> `fallback_agent / unknown / fallback`

Boundary:

- this helper is deterministic mapping only
- it does not perform tool calls
- it does not transfer workflow ownership
- it does not claim a generic multi-agent runtime or full handoff engine

## Placeholder Agent Runtime

`/Users/seanhan/Documents/Playground/src/planner/agent-runtime.mjs` now provides a matching placeholder execution wrapper for the same checked-in agent/action pairs:

- input:
  - `{ "agent": "string", "action": "string" }`
  - or `{ "lane": "meeting|doc|runtime|mixed|..." }`, which is normalized through `agent-executor.mjs`
- output:
  - `{ "agent": "string", "action": "string", "result": "object" }`

Current checked-in behavior:

- `meeting_agent / meeting_summary -> { "kind": "meeting", "status": "ok", "summary": "meeting workflow placeholder result", "actionable_items": [], "confidence": 0.85, "data": { ... } }`
- `doc_agent / doc_answer -> { "kind": "doc", "status": "ok", "summary": "doc workflow placeholder result", "actionable_items": [], "confidence": 0.8, "data": { ... } }`
- `runtime_agent / runtime_check -> { "kind": "runtime", "status": "ok", "summary": "runtime status: healthy", "actionable_items": [], "confidence": 0.9, "data": { ... } }`
- `mixed_agent / mixed_lane -> { "kind": "mixed", "status": "ok", "summary": "mixed workflow placeholder result", "actionable_items": [], "confidence": 0.75, "data": { ... } }`
- unknown input -> `{ "status": "fallback" }`

Boundary:

- this wrapper is still deterministic and local-only
- it does not invoke live tools, agents, or workflow ownership transfer
- it exists as a thin checked-in placeholder runtime, not a generic specialist-agent executor

`/Users/seanhan/Documents/Playground/src/planner/result-schema.mjs` and `/Users/seanhan/Documents/Playground/src/planner/result-formatters.mjs` now also exist as small planner-side normalization helpers for those same placeholder result families:

- `buildResultEnvelope(kind, payload)` returns a stable local envelope:
  - `{ "kind": "string", "status": "ok|...", "summary": "string", "actionable_items": [], "confidence": "number", "data": {} }`
- `formatMeetingResult(...)`, `formatDocResult(...)`, `formatRuntimeResult(...)`, and `formatMixedResult(...)` each map the corresponding placeholder runtime payload into that shared envelope shape
- `runAgentExecution(...)` now uses those formatters for the checked-in placeholder lane/agent pairs before returning `result`

Boundary:

- these helpers are local-only normalization utilities
- they do not change `planner_contract.json` or the public planner response contract

`/Users/seanhan/Documents/Playground/src/executive-planner.mjs` now consumes that helper in a bounded way:

- `runPlannerToolFlow(...)` returns:
  - `{ "selected_action": "string|null", "execution_result": "object|null", "agent_execution": "object", "trace_id": "string|null" }`
- `agent_execution` prefers explicit `payload.lane` or `taskType`
- otherwise it only infers a small checked-in mapping from known planner actions/presets
- the derived execution is then wrapped through `runAgentExecution(...)`, so current planner output can also carry deterministic placeholder `result` payloads for the checked-in lane/agent pairs
- when no bounded mapping exists, output falls back to `fallback_agent` with `result.status = "fallback"`

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
- unmatched routing still fails closed internally as `ROUTING_NO_MATCH` instead of silently falling through selector/default-reply paths; the public `runPlannerToolFlow(...)` fallback surface normalizes that no-match case to `business_error` while preserving the internal routing reason in structured detail
- no heuristic or free-text fallback is used on this strict user-input planning path

## Contract Consistency Check

Checkpoint status:

- `consistency-check checkpoint`
- `contract-alignment checkpoint`
- `Thread 45 planner contract regression-gate checkpoint`
- `Thread 46 planner diagnostics daily-entry checkpoint`
- `Thread 47 planner diagnostics history-snapshot checkpoint`
- `Thread 48 planner diagnostics minimal-compare checkpoint`

Current checked-in consistency checker:

- `/Users/seanhan/Documents/Playground/src/planner-contract-consistency.mjs`
- `/Users/seanhan/Documents/Playground/src/planner-diagnostics-history.mjs`
- `/Users/seanhan/Documents/Playground/scripts/planner-contract-check.mjs`
- `/Users/seanhan/Documents/Playground/scripts/planner-diagnostics.mjs`

Current purpose:

- compare checked-in planner contract targets against the runtime tool registry
- compare checked-in planner contract targets against the runtime preset registry and preset step actions
- compare selector / hard-route / flow-route outputs against the same contract target catalog
- emit a fixed human-readable diagnostics summary plus a machine-readable JSON report
- detect drift without changing routing or applying auto-fixes

Current drift judgment rules:

- `undefined_action`
  - a tool-registry action, preset step action, or action-slot route target does not exist in `planner_contract.json.actions`
- `undefined_preset`
  - a runtime preset entry does not exist in `planner_contract.json.presets`
- `deprecated_reachable_target`
  - a reachable contract target is still emitted after that target is explicitly marked deprecated in the checked-in contract metadata
- `selector_contract_mismatch`
  - a selector / route target is in the contract, but the contract kind does not match the slot semantics used by runtime
  - current example: a route field named `action` emitting a contract `preset`

Current checked-in code truth from this checker:

- no undefined planner actions were found in the current tool registry, preset steps, or sampled route outputs
- no undefined planner presets were found in the current preset registry
- no deprecated reachable targets were found because the current planner contract does not yet mark any target as deprecated
- no selector/contract mismatches were found in the current checked-in router and flow-route outputs
- `search_and_detail_doc` is now emitted from the doc-query router and themed flow routes through the preset slot rather than an action slot

Thread 45 planner contract regression-gate checkpoint:

- fixes planner contract drift checking as a blocking regression gate without changing routing decisions
- makes `planner-contract-check` and `self-check` share the same blocking criteria
- keeps the path read-only: no fallback, no auto-fix, no routing mutation
- adds `planner:diagnostics` as the daily-entry CLI that reads current runtime/contract state directly and does not rerun planner execution

Thread 46 planner diagnostics daily-entry checkpoint:

- fixes the planner contract view into a single daily-entry CLI summary
- keeps the path read-only: no new logic, no routing change, no fallback, no auto-fix
- makes operators check planner/contract drift from one human-readable summary before `planner:contract-check` or `self-check`

Thread 47 planner diagnostics history-snapshot checkpoint:

- keeps the same read-only daily-entry and regression-gate behavior
- adds snapshot-only planner diagnostics archival for `planner:diagnostics` and `planner:contract-check`
- stores the full JSON diagnostics report per run plus a minimal manifest index

Thread 48 planner diagnostics minimal-compare checkpoint:

- keeps the same read-only daily-entry and regression-gate behavior
- adds minimal compare mode only to `planner:diagnostics`
- supports:
  - `npm run planner:diagnostics -- --compare-previous`
  - `npm run planner:diagnostics -- --compare-snapshot <run-id|path>`
- compare stays read-only: no auto-fix, no routing change, no fallback, no gate-rule change
- compare output only covers:
  - `gate`
  - `undefined_actions`
  - `undefined_presets`
  - `selector_contract_mismatches`
  - `deprecated_reachable_targets`
- human-readable compare uses fixed direction markers:
  - `↑` = worse
  - `↓` = better
  - `=` = unchanged
- JSON compare adds `compare_summary`, and that object only contains changed fields

Thread 49 unified-self-check checkpoint:

- keeps the same planner gate and compare semantics
- folds current planner gate + latest archived compare into `self-check`
- exposes planner-side unified fields through `planner_summary`
- does not change planner routing, add fallback, or auto-fix drift

Thread 50 self-check history checkpoint:

- keeps the same planner gate and compare semantics
- adds snapshot-only unified self-check archival to `.tmp/system-self-check-history/`
- adds `self-check -- --compare-previous` and `self-check -- --compare-snapshot <run-id|path>`
- keeps compare read-only and minimal; no routing change, no fallback, no planner gate mutation, no auto-fix

Thread 51 release-check preflight checkpoint:

- keeps the same planner gate and compare semantics
- adds `release-check` as the single merge/release preflight entry over the existing self-check, routing, and planner evidence
- keeps human output bounded to merge/release verdict, first repair line, plus one minimal `下一步`
- classifies planner-side blocking output under the minimal `planner_contract_failure` triage line
- keeps planner next-step guidance module-first: inspect planner registry / flow-route files before considering `docs/system/planner_contract.json`
- adds read-only fail drilldown from existing evidence only:
  - `failing_area`
  - `representative_fail_case`
  - `drilldown_source`
- keeps JSON output minimal and read-only, with one extra `action_hint` derived from existing `suggested_next_step` + drilldown evidence only; no routing change, no fallback, no planner gate mutation, no auto-fix
- when the blocking routing line belongs to the checked-in doc/company-brain family, the same read-only report may also mark `doc_boundary_regression = true` and point the operator at the existing doc-boundary pack plus intent guards; this does not change gate order

Thread 54 release drilldown checkpoint:

- keeps the same release-check gate ordering and next-step guidance
- persists the minimal fail drilldown as the checked-in checkpoint:
  - `failing_area`
  - `representative_fail_case`
  - `drilldown_source`
- keeps human-readable output bounded to one extra line `下一步`
- keeps the drilldown source bounded to existing release triage plus routing/planner diagnostics evidence only
- does not add fallback, auto-fix, or a new diagnostics subsystem

Thread 56 daily status entry checkpoint:

- keeps the same routing/planner/release gate semantics and reuses the current `runReleaseCheck(...)` path
- adds `daily-status` as the single daily operator entry for `開發 / 合併 / 發布` answers
- keeps human-readable output bounded to four lines only:
  - `今天能不能安心開發`
  - `今天能不能安心合併`
  - `今天能不能安心發布`
  - `若不能，先看哪一條線`

Thread 57 daily compare checkpoint:

- adds read-only daily compare mode:
  - `npm run daily-status -- --compare-previous`
  - `npm run daily-status -- --compare-snapshot <run-id|path>`
  - human-readable compare keeps the same four daily lines and only adds one extra line:
    - `下一步`
  - compare JSON reuses the same four daily fields and only adds:
    - `changed_line`
    - `change_reason_hint`
    - `action_hint`
  - `changed_line` only uses:
    - `routing`
    - `planner`
    - `release`
    - `none`
  - `change_reason_hint` stays minimal and only reuses existing sources:
    - routing -> `doc` / `meeting` / `runtime` / `mixed` from routing diagnostics/history compare + drilldown
    - planner -> `contract` / `selector` from planner diagnostics/current gate findings
    - release -> current first `blocking_checks` type from release compare
  - `action_hint` stays fixed-format and only reuses the existing compare hint:
    - routing -> `run routing-eval and inspect <area> fixtures`
    - planner -> `run planner-contract-check and fix <type> mismatch`
    - release -> `inspect blocking_checks and representative_fail_case`
- keeps `--json` output bounded to:
  - `routing_status`
  - `planner_status`
  - `release_status`
  - `overall_recommendation`
- keeps recommendation line-first and read-only:
  - `routing` = check the archived routing regression line first
  - `planner` = check the current planner contract/runtime line first
  - `release` = check the existing release line first, including base/self-check failures already compressed there
- does not add a new gate, compare mode, fallback path, or auto-fix behavior

Thread 58 daily trend checkpoint:

- adds read-only daily trend mode:
  - `npm run daily-status -- --trend`
  - `npm run daily-status -- --trend --trend-count <n>`
  - human-readable trend output only answers:
    - `最近趨勢`
    - `最常變動`
  - trend JSON only returns `trend_summary` with:
    - `sample_count`
    - `trend`
    - `most_changed_line`
    - `recent_runs`
  - each `recent_runs` item only uses:
    - `run_id`
    - `timestamp`
    - `routing_status`
    - `planner_status`
    - `release_status`
    - `overall_recommendation`
- keeps trend source bounded to existing archives only:
  - release line from `release-check-history`
  - routing/planner lines from `system-self-check-history`
  - no new daily-status history archive
- does not add a new gate, fallback path, or auto-fix behavior

Thread 59 action hint checkpoint:

- keeps the same release-check and daily-status gate semantics
- adds fixed-format `action_hint` to `release-check` and daily-status compare JSON only
- keeps `action_hint` source bounded to existing evidence only:
  - release-check -> existing `suggested_next_step` + drilldown
  - daily-status compare -> existing `change_reason_hint`
- keeps human-readable output line count unchanged and only rewrites the last hint line into `下一步`
- does not add fallback, auto-fix, new routing logic, or a new diagnostics subsystem

Current daily-entry CLI:

- `npm run daily-status`
- `npm run check:daily`
- `npm run daily-status -- --trend`
- `npm run daily-status -- --trend --trend-count <n>`
- `npm run daily-status -- --compare-previous`
- `npm run daily-status -- --compare-snapshot <run-id|path>`
- `npm run check:self`
- `npm run check:release`
- `npm run check:routing`
- `npm run planner:diagnostics`
- `npm run check:planner`
- `npm run planner:diagnostics -- --compare-previous`
- `npm run planner:diagnostics -- --compare-snapshot <run-id|path>`
- `check:*` scripts are wrapper-only aliases over the same existing CLIs:
  - `check:daily` -> `daily-status`
  - `check:self` -> `self-check`
  - `check:release` -> `release-check`
  - `check:routing` -> `routing:diagnostics`
  - `check:planner` -> `planner:diagnostics`
  - they do not change output shape, gate semantics, fallback behavior, or auto-fix behavior
- `daily-status` is the first daily glance:
  - it reuses current `release-check` + unified `self-check` evidence
  - it answers whether today is safe to develop / merge / release
  - it only tells you which existing line to inspect first
- `planner:diagnostics` remains the planner-specific daily-entry:
  - it reads the current checked-in runtime selector / registry / flow-route state directly
  - it is still the right entry once daily-status tells you to look at planner
- it reads the current checked-in runtime selector / registry / flow-route state directly
- it does not rerun planner execution, mutate routing, or auto-fix drift
- every `planner:diagnostics` and `planner:contract-check` run now writes a snapshot-only archive to:
  - `.tmp/planner-diagnostics-history/manifest.json`
  - `.tmp/planner-diagnostics-history/snapshots/<run-id>.json`
- `manifest.json` keeps the minimal per-run fields:
  - `run_id`
  - `timestamp`
  - `gate`
  - `undefined_actions`
  - `undefined_presets`
  - `selector_contract_mismatches`
  - `deprecated_reachable_targets`
- each snapshot stores the full JSON diagnostics report emitted by the same CLI path
- it renders one fixed summary line with:
  - `gate`
  - `undefined_actions`
  - `undefined_presets`
  - `selector_contract_mismatches`
  - `deprecated_reachable_targets`
- compare mode renders one fixed minimal compare view with the same five fields only
- compare mode defaults to:
  - current = this run's freshly generated diagnostics report
  - compare target = previous archived snapshot or specified snapshot path/run-id
- `--json` keeps the full current report and adds `compare_summary` only when compare mode is used
- `compare_summary` only includes fields whose value changed versus the compare target
- `npm run self-check` 也會整合這條線，但 planner 部分仍以 current runtime/contract state 為準：
  - self-check 直接重跑 current planner contract consistency check
  - 若 `.tmp/planner-diagnostics-history/` 有最新 snapshot，會把 current report 對那一筆做 compare
  - self-check 不會改 planner gate 規則，也不會 auto-fix drift
- every `self-check` run now also writes a snapshot-only unified archive to:
  - `.tmp/system-self-check-history/manifest.json`
  - `.tmp/system-self-check-history/snapshots/<run-id>.json`
- unified self-check `manifest.json` keeps the minimal per-run fields:
  - `run_id`
  - `timestamp`
  - `system_status`
  - `routing_status`
  - `planner_status`
- unified self-check compare mode supports:
  - `npm run self-check -- --compare-previous`
  - `npm run self-check -- --compare-snapshot <run-id|path>`
- unified self-check result may now also carry top-level `doc_boundary_regression`, and `routing_summary.doc_boundary_regression` mirrors the same routing-only signal
- unified self-check compare human output only covers:
  - `system` better / worse / unchanged
  - whether `routing` regressed
  - whether `planner` regressed
- if `gate = fail`, the decision guidance is:
  - default: fix planner implementation first
  - alternative: update the contract only for an intentional stable target, and state the reason explicitly
  - deprecated reachable targets remain warning-only and do not block the gate
- when compare is used:
  - `↑ gate` means `pass -> fail`
  - `↓ gate` means `fail -> pass`
  - for the count fields, larger count = worse, smaller count = better

When to add/update contract:

- the runtime target is intentional, reachable, and stable
- the target kind is clear (`action` vs `preset`)
- the target has a bounded input/output contract that can be validated without changing routing semantics
- the same target is already used by runtime and the checker is only failing because the contract mirror is missing or stale
- the change is expanding or narrowing an already-intended stable planner surface, not preserving accidental selector/flow output

When contract update is allowed:

- after the runtime target name/kind has already been intentionally introduced in checked-in code
- after the target contract can be reviewed as a stable public planner boundary
- when the checker failure is caused by mirror drift between runtime registry/route outputs and `planner_contract.json`
- in the same change that updates the relevant `docs/system` mirror

When contract check must run:

- first command after planner / contract changes: `npm run planner:diagnostics`
- when a change should be judged as regression/non-regression against the immediately previous snapshot, run `npm run planner:diagnostics -- --compare-previous`
- when a change should be judged against a known checkpoint file or archived run, run `npm run planner:diagnostics -- --compare-snapshot <run-id|path>`
- any change to `/Users/seanhan/Documents/Playground/docs/system/planner_contract.json`
- any change to `/Users/seanhan/Documents/Playground/src/executive-planner.mjs` that adds/removes/renames planner actions or presets
- any change to planner-side selector / hard-route / flow-route emitters, including:
  - `/Users/seanhan/Documents/Playground/src/router.js`
  - `/Users/seanhan/Documents/Playground/src/planner-doc-query-flow.mjs`
  - `/Users/seanhan/Documents/Playground/src/planner-runtime-info-flow.mjs`
  - `/Users/seanhan/Documents/Playground/src/planner-okr-flow.mjs`
  - `/Users/seanhan/Documents/Playground/src/planner-bd-flow.mjs`
  - `/Users/seanhan/Documents/Playground/src/planner-delivery-flow.mjs`
- before merging/releasing planner contract, selector, or preset changes through the fixed `release-check` entry or the fuller `self-check` gate

When to change planner implementation instead:

- a route/selector emits a target name that is not part of the checked-in contract
- a route/selector emits a target through the wrong slot kind, for example `action` carrying a contract `preset`
- the target is legacy/deprecated and should no longer be reachable
- the change would otherwise require the contract to encode accidental runtime behavior rather than an intended stable interface
- the only way to make the checker pass is to bless an accidental selector/route emission that has not been accepted as stable planner surface

Fail handling order:

1. run `npm run planner:diagnostics`
2. if you just changed planner / selector / preset code and need a quick regression read, run `npm run planner:diagnostics -- --compare-previous`
3. if `gate = fail`, inspect fields in this order:
   - `undefined_actions`
   - `undefined_presets`
   - `selector_contract_mismatches`
   - `deprecated_reachable_targets`
4. fix planner implementation first by default
5. only if the reachable target is intentional and stable, update `planner_contract.json` and record the reason in the same change
6. if only `deprecated_reachable_targets > 0`, treat it as warning-only and clean it up without blocking the gate
7. before merge/release, rerun `npm run planner:contract-check`, `npm run self-check`, or the single-entry `npm run release-check`

Unified self-check reading order:

1. if `self-check` says look at `routing`, inspect routing first; planner may still be clean while the archived routing behavior already regressed
2. if the same report also marks `doc_boundary_regression = true`, treat it as a doc/company-brain boundary issue and inspect `message-intent-utils.mjs` / `lane-executor.mjs` before revalidating the doc-boundary pack
3. once `self-check` points to `planner`, stay inside the planner order above
4. planner line means contract/runtime drift; routing line means archived behavior regression

Daily-status reading order:

1. run `npm run daily-status` or `npm run check:daily` first when you need the bounded daily answer
2. if it says `routing`, move to `npm run routing:diagnostics` or `npm run check:routing`
3. if it says `planner`, move to `npm run planner:diagnostics` or `npm run check:planner`
4. if it says `release`, move to `npm run release-check` / `npm run check:release` or `npm run self-check` / `npm run check:self` depending on whether you need the minimal preflight or the fuller base/routing/planner breakdown
5. `daily-status` does not replace the existing planner gate; it only points you at the first existing line to read

Release-check fail -> drilldown order:

1. run `npm run release-check`
2. if output says `先看哪類 case：doc|meeting|runtime|mixed`, use that only as the first slice, not as a new gate
3. read `report.representative_fail_case` from `npm run release-check -- --json`
4. if `drilldown_source` contains `routing-eval diagnostics/history`:
   - start from the listed routing eval case ids
   - if the representative case is a coverage gap and `diagnostics_summary.decision_advice.minimal_decision.action = review_fixture_coverage`, add/update fixture first
   - if the representative case points to `INVALID_ACTION`, wrong lane/action bucket, or rule precedence drift, inspect routing rule before touching fixture
5. if `drilldown_source` contains `planner diagnostics/history`:
   - start from the listed finding `category:target via source_id`
   - inspect planner rule / route first when the finding is `selector_contract_mismatches` or the emitting source is `router.js` / `src/planner-*-flow.mjs`
   - inspect planner contract only when the runtime target is intentional, reachable, and stable
6. `release-check` drilldown is read-only; it must not auto-fix, add fallback, or mutate gate behavior

Current operating rule:

- this checker is read-only
- it must not modify routing precedence
- it must not add fallback behavior
- it must not auto-fix contract or runtime drift
- it now acts as a fixed regression gate through both `node scripts/planner-contract-check.mjs` and `node scripts/self-check.mjs`
- non-zero exit is limited to:
  - `undefined_actions > 0`
  - `undefined_presets > 0`
  - `selector_contract_mismatches > 0`
- `deprecated_reachable_targets` remains visible as drift evidence, but is not currently a blocking gate condition

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
  "params": "object",
  "why": "string|null",
  "alternative": {
    "action": "string|null",
    "summary": "string|null"
  }
}
```

```json
{
  "steps": [
    {
      "action": "string",
      "params": "object"
    }
  ],
  "why": "string|null",
  "alternative": {
    "action": "string|null",
    "summary": "string|null"
  }
}
```

For strict user-input planning, `why` and simplified `alternative` are runtime-generated explanation fields added after the core `{ action, params }` / `{ steps }` contract has already been validated. The model is still constrained to produce the existing bounded planner JSON core, and the runtime appends explanation metadata deterministically so the decision remains stable and machine-checkable.

For the multi-step shape:

- each `steps[i].action` must resolve to an action in `planner_contract.json`
- presets are still allowed only through the legacy single-step `action` path
- each step is later dispatched through the existing planner tool execution boundary rather than a separate shortcut runtime

Current strict user-input planner error boundary:

```json
{
  "error": "planner_failed|INVALID_ACTION|contract_violation|semantic_mismatch|stale_decision_reused|ROUTING_NO_MATCH"
}
```

When the invalid item is inside `steps`, the error payload may also carry:

- `steps`
- `step_index`
- failing step `action` / `params`

For stricter fail-soft behavior on direct user-input planning, the checked-in runtime now also rejects:

- semantically mismatched decisions, for example trying to map `總結最近對話` onto a document-search action
- byte-identical planner decisions copied from the previous turn when the current user input is not an explicit same-task follow-up

These structured planner failures may also carry:

- `reason`
- `previous_user_text`
- `semantics`

The planner envelope built for lane execution now also exposes a minimal trace summary:

```json
{
  "trace": {
    "chosen_action": "string|null",
    "fallback_reason": "string|null",
    "reasoning": {
      "why": "string|null",
      "alternative": {
        "action": "string|null",
        "summary": "string|null"
      }
    }
  }
}
```

`execution_result` may now also carry an additional `formatted_output` field for successful company-brain read flows; this is a presentation-layer enrichment on top of the raw tool result, not a replacement for the bounded route output.

When `runPlannerToolFlow(...)` cannot resolve either a hard route or a selector target, it now stops with `error = "ROUTING_NO_MATCH"` and does not emit a business-error fallback reply.

Successful company-brain detail-like flows may now also expose `learning_status`, `learning_concepts`, and `learning_tags` inside that formatted layer when the underlying doc has learning state.

The planner runtime also now keeps a small in-memory read context:

- `active_doc`
- `active_candidates`
- `active_theme`

This allows pronoun-style follow-ups (`這份文件`) and ordinal follow-ups (`第一份 / 第二份`) to resolve against the latest successful company-brain search/detail interaction without changing the external planner output shape. Ordinal detail follow-ups are now intentionally narrower than pronoun follow-ups: they resolve only through the stored `active_candidates` index from the previous candidate list, and do not silently fall back to `active_doc` when that candidate context is missing.

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

The normalized executive decision shape in that same module now also carries deterministic explainability metadata:

```json
{
  "action": "start|continue|handoff|clarify",
  "objective": "string",
  "primary_agent_id": "string",
  "next_agent_id": "string",
  "supporting_agent_ids": ["string"],
  "reason": "string",
  "why": "string|null",
  "alternative": {
    "action": "start|continue|handoff|clarify|null",
    "agent_id": "string|null",
    "summary": "string|null"
  },
  "pending_questions": ["string"],
  "work_items": [
    {
      "agent_id": "string",
      "task": "string",
      "role": "primary|supporting"
    }
  ]
}
```

`why` and simplified `alternative` are normalized by runtime rather than trusted as free-form model output, so executive routing stays explainable without loosening the existing JSON decision boundary.

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

The company-brain doc-query context and its ambiguity-aware formatter are now gathered in `/Users/seanhan/Documents/Playground/src/planner-doc-query-flow.mjs`; its checked-in hard-route precedence is `follow_up -> doc -> search -> fallback`, and each branch must collapse to one unique action/preset before planner continues. In that same route family, `搜尋/查詢 + 內容/打開/流程` phrasing now stays on generic `search_company_brain_docs` unless an active doc/candidate follow-up already resolves a single detail action. Detail formatting in that flow now keeps one fixed planner-facing shape for doc results (`kind`, `title`, `doc_id`, `items`, `match_reason`, `content_summary`, `learning_status`, `learning_concepts`, `learning_tags`, `found`) and prefers deterministic summary text from the company-brain detail payload before falling back to fetched document content. `/Users/seanhan/Documents/Playground/src/planner-runtime-info-flow.mjs` is the second concrete flow and handles `get_runtime_info`; `/Users/seanhan/Documents/Playground/src/planner-okr-flow.mjs` is the third concrete flow and routes OKR/topic-style knowledge questions into the existing doc-query chain while keeping that same search-vs-detail precedence; `/Users/seanhan/Documents/Playground/src/planner-bd-flow.mjs` is the fourth concrete flow and routes BD/topic-style knowledge questions into that same doc-query chain with the same search guard; `/Users/seanhan/Documents/Playground/src/planner-delivery-flow.mjs` is the fifth concrete flow and routes delivery/onboarding/SOP knowledge questions into that same doc-query chain; `/Users/seanhan/Documents/Playground/src/planner-action-layer.mjs` is a shared themed formatter that runs after the doc-query formatter for OKR / BD / delivery flows and adds a stable action-oriented enrichment block without changing raw tool results; its current v2 behavior remains bounded and deterministic, but detail-like results now make the first `next_actions` item state-aware when labeled `status` already says `blocked` / `in_progress` / `done`, while still keeping the same public action-layer field names and preserving extracted `owner / deadline / risks`; `/Users/seanhan/Documents/Playground/src/planner-task-lifecycle-v1.mjs` now mirrors those same `action_layer.next_actions` into a minimal planner-side task lifecycle v1 JSON store, keeps a separate operational task state (`planned -> in_progress -> blocked -> done`), extends that store with bounded `execution v1` progress/result tracking for local follow-ups, persists `last_active_task_id` per scope, and serves higher-priority local follow-up reads/updates for task-oriented queries including single-task targeting by ordinal / `這個` / unique owner while keeping the external planner result shape unchanged; `/Users/seanhan/Documents/Playground/src/planner-flow-runtime.mjs` defines the minimum internal flow contract (`route`, `shapePayload`, `readContext`, `writeContext`, `formatResult`, tracing hooks); `/Users/seanhan/Documents/Playground/src/executive-planner.mjs` remains the public planner entrypoint and wires those flows into normal select/dispatch/preset execution.

Separately, `/Users/seanhan/Documents/Playground/src/planner/knowledge-bridge.mjs` now exists as a tiny planner-side local adapter over `/Users/seanhan/Documents/Playground/src/knowledge/knowledge-service.mjs`: `plannerAnswer({ keyword, question })` prefers an explicit `keyword`, otherwise fail-soft tries `/Users/seanhan/Documents/Playground/src/planner/intent-parser.mjs` to extract a document-search keyword from `question`, then expands that final keyword through `/Users/seanhan/Documents/Playground/src/planner/query-rewrite.mjs` before querying the same cached `docs/system` in-memory preview rows once per expanded key through synchronous `queryKnowledgeWithContext(...)`. The merged local rows are deduplicated by `id` before summarization. Inside that local helper, case-insensitive doc hits are reordered through `/Users/seanhan/Documents/Playground/src/knowledge/rank-results.mjs`, which boosts direct keyword matches, earlier keyword hits near the start of the document, repeated exact matches, and a small boundary-like bonus when the keyword appears adjacent to spaces. Snippet extraction then strips leading absolute `/Users/...` path lines, leading heading/metadata labels such as bare slash labels or `runtime / monitoring - Purpose:` prefixes, and leading navigation artifacts such as `Back to README.md`, `Loop Runbook`, or `Delivery Guide`; the context helper first prioritizes a small checked-in alias set for common ASCII topic terms (`okr`, `bd`, `sop`, `delivery`, `onboarding`), then fail-soft expands matching Chinese normalization terms (`交付`, `流程`, `設計`, `商機`, `管理`, `系統`, `穩不穩`, `運行情況`), and only after that falls back to remaining ASCII tokens and the raw full query so mixed-language lookup terms and runtime-health phrasing can reuse alternate forms without letting broad brand-like tokens dominate the bounded preview too early. Each variant still keeps only snippets that contain the active query term and excludes `oauth` snippets unless that active term itself is `oauth`; the helper then drops very short fragments, table-row-like snippets, bare path/path-like labels, and empty metadata labels, deduplicates rows by `id`, and round-robins across the bounded per-query result buckets before returning the final top-3 preview rows. That parser no longer carries its own inline allowlist; it now reuses the shared `/Users/seanhan/Documents/Playground/src/config/tech-terms.mjs` registry through `/Users/seanhan/Documents/Playground/src/utils/pick-tech-term.mjs`, with longest-term-first matching so `entry os` or `scanoo entry os` are not shadowed by the broader `entry` substring. `/Users/seanhan/Documents/Playground/src/planner/query-rewrite.mjs` now also exists as a tiny deterministic local helper that expands a small checked-in alias map for `routing`, `planner`, `sop`, and `okr`, or derives one mapped expansion set from `pickTechTerm(question)` before falling back to `[keyword]` or `[]`. The planner-side local summary path still summarizes rows through `/Users/seanhan/Documents/Playground/src/planner/llm-summary.mjs`, which now uses the shared `/Users/seanhan/Documents/Playground/src/llm/generate-text.mjs` helper for the repo-wide text-model path, prompts for a concise answer with bracketed source indices such as `[1][2]`, sends that request with `temperature: 0`, and falls back to `/Users/seanhan/Documents/Playground/src/planner/answer-builder.mjs` when generation fails. The bridge now also returns `sources`, mirroring the deduplicated preview rows in summary order as `{ id, index, snippet }`, but normalizes each exposed `snippet` through `/Users/seanhan/Documents/Playground/src/knowledge/snippet-cleaner.mjs` with the final keyword before returning it, and keeps the empty-keyword fail-soft shape at `{ answer: "請提供查詢關鍵字", count: 0, sources: [] }`. `/Users/seanhan/Documents/Playground/src/planner/answer-builder.mjs` exposes `buildAnswer(keyword, results) -> string`, returning either a fixed Chinese no-result line or a numbered summary over the same `{ id, snippet }` preview rows with a count-based intro and snippet cleanup that strips inline code spans, local absolute-path fragments, excess whitespace, leading punctuation noise, trailing separator noise, stray spaces before punctuation, repeated commas, and dangling trailing conjunction/placeholder tails. These helpers are not part of the current public planner runtime surface, are not wired into `executive-planner.mjs`, and do not change `planner_contract.json`, planner flow routing, or company-brain governance boundaries.

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

That query envelope is where structured summaries, search match metadata, doc detail summaries, and per-document `learning_state` now live; the public planner wrapper remains unchanged.

Current `runPlannerMultiStep(...)` output:

```json
{
  "ok": "boolean",
  "steps": "array",
  "results": "array",
  "trace_id": "string|null",
  "error": "string|null",
  "stopped": "boolean",
  "stopped_at_step": "number|null",
  "current_step_index": "number|null",
  "last_error": "object|null",
  "retry_count": "number"
}
```

Current multi-step runtime behavior:

- steps are executed in order
- each step goes through `dispatchPlannerTool(...)`
- planner dispatch, planner JSON request, preset execution, and multi-step execution now all accept a shared abort signal from the HTTP request boundary
- default behavior is stop-on-first-error
- stopped runs return the failing step index and normalized error instead of continuing silently
- multi-step runtime now records bounded execution state for resume/retry:
  - `current_step_index` points to the current stop point on failure and to `steps.length` after full completion
  - `last_error` captures the latest failed step attempt as `{ error, trace_id, data }`
  - `retry_count` counts multi-step step-level retries performed by `runPlannerMultiStep(...)`
- multi-step runtime now accepts:
  - `resume_from_step`
  - `previous_results`
  - `max_retries`
  - `retryable_error_types`
- when `previous_results` carries a contiguous successful prefix, runtime resumes from the first unresolved step and does not rerun already successful steps
- planner resume is execution-only; the runtime can continue an existing bounded plan without recomputing the whole planner decision

Current `runPlannerPreset(...)` output:

```json
{
  "ok": "boolean",
  "preset": "string",
  "steps": "array",
  "results": "array",
  "trace_id": "string|null",
  "stopped": "boolean",
  "stopped_at_step": "number|null",
  "current_step_index": "number|null",
  "last_error": "object|null",
  "retry_count": "number",
  "error": "string|null"
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
- `request_timeout`
  - stop immediately; no retry after the timeout boundary
- `request_cancelled`
  - stop immediately; no retry after the cancel boundary
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
- multi-step step-level retry / resume state:
  - configurable `max_retries`
  - configurable `retryable_error_types`
  - bounded `resume_from_step` continuation
  - reuse of `previous_results` successful prefix so completed steps are not rerun
- minimal ambiguity handling for company-brain search/detail flows:
  - zero-hit `search_and_detail_doc` returns a controlled not-found-style formatted result
  - multi-hit `search_and_detail_doc` returns bounded candidates instead of auto-opening a document
  - ordinal follow-ups can resolve against `active_candidates`

Boundary:

- self-heal is minimal and shallow
- action-dispatch retry still exists independently inside `dispatchPlannerTool(...)`
- multi-step retry is step-level and bounded to the current ordered plan
- preset resume/retry is still implemented inside `runPlannerPreset(...)`, not as a separate workflow engine

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
