# Planner-Visible Multi-Skill Observability

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Purpose

This document is the checked-in technical mirror for the long-run coexistence watch on the two current `planner_visible` skills:

- `search_and_summarize`
- `document_summarize`

The goal is not to widen admission. The goal is to prove that both skills can stay enabled together while the planner still:

- remains query-bound
- fails closed on ambiguity and follow-up references
- preserves the existing non-skill routing family
- keeps the answer pipeline in front of every user-visible reply

For the production-ready but not-yet-wired live telemetry design that builds on top of this checked-in watch, see:

- [planner_visible_live_telemetry_design.md](/Users/seanhan/Documents/Playground/docs/system/planner_visible_live_telemetry_design.md)

## Code Anchors

- `/Users/seanhan/Documents/Playground/src/planner-visible-skill-observability.mjs`
- `/Users/seanhan/Documents/Playground/src/planner/skill-bridge.mjs`
- `/Users/seanhan/Documents/Playground/src/executive-planner.mjs`
- `/Users/seanhan/Documents/Playground/src/user-response-normalizer.mjs`
- `/Users/seanhan/Documents/Playground/scripts/planner-visible-skill-check.mjs`
- `/Users/seanhan/Documents/Playground/tests/planner-visible-skill-observability.test.mjs`
- `/Users/seanhan/Documents/Playground/tests/search-and-summarize-readiness.test.mjs`
- `/Users/seanhan/Documents/Playground/tests/executive-planner.test.mjs`

## Checked-In Watch Pack

The current observability check is still a checked-in fixture pack, not a best-effort heuristic.

### Deterministic Selector Pack

Current selector probes are:

- `taskType=skill_read` -> `search_and_summarize`
- `taskType=knowledge_read_skill` -> `search_and_summarize`
- `taskType=document_summary_skill` -> `document_summarize`

Current checked-in expectation:

- selector key hit rate stays `3/3`
- per-skill selector hit rate stays:
  - `search_and_summarize = 2/2`
  - `document_summarize = 1/1`
- selector fail-closed count stays `0`
- selector overlap stays `0`

### Query-Type Pack

The checked-in query-type watch is:

- `search_and_summarize`
  - query: `幫我搜尋 launch checklist 並整理重點`
  - planner-visible admission: `search_and_summarize`
  - generic fallback path stays `search_company_brain_docs`
- `detail_summary`
  - query: `幫我整理 launch checklist 文件重點`
  - planner-visible admission: `document_summarize`
  - generic fallback path stays `search_and_detail_doc`
- `mixed_query`
  - query: `幫我搜尋這份 launch checklist 文件並整理重點`
  - planner-visible admission: fail-closed
  - ambiguity trigger: true
  - generic fallback path stays `search_company_brain_docs`
- `follow_up_reference`
  - query: `這份文件幫我整理重點`
  - planner-visible admission: fail-closed
  - explicit same-task follow-up reference must not re-enter `document_summarize`
  - generic fallback path stays `search_and_detail_doc`

Current checked-in metrics from that pack:

- fail-closed count: `2`
- fail-closed ratio: `0.5`
- ambiguity trigger count: `1`
- routing fallback distribution:
  - `search_company_brain_docs: 2`
  - `search_and_detail_doc: 2`

Telemetry normalization used by the live design maps these fixture labels to:

- `search_and_summarize` -> `search`
- `detail_summary` -> `detail`
- `mixed_query` -> `mixed`
- `follow_up_reference` -> `follow-up`

Interpretation:

- the two expected fail-closed cases are not regressions; they are the bounded protection line
- any increase above that checked-in baseline is treated as abnormal

## Answer-Boundary Watch

The coexistence watch now verifies both success paths plus one fail-closed negative probe:

- `search_and_summarize` success probe
- `document_summarize` success probe
- `document_summarize` fail-closed probe

To keep the probe result deterministic while the repository test suite runs in parallel, each probe now uses its own fixed `sessionKey` scope in planner runtime memory. This isolation is additive and does not change planner routing/output contracts.

Each probe must keep:

- `planner_skill_boundary = "answer_pipeline"`
- `planner_skill_answer_pipeline_enforced = true`
- `planner_skill_raw_payload_blocked = true`
- no raw bridge payload leakage into rendered reply text

Current checked-in answer consistency baseline:

- inconsistency count: `0`
- `search_and_summarize`: consistent
- `document_summarize`: consistent

## Selector Overlap Rule

Both `planner_visible` skills still remain deterministic-only and must stay non-overlapping.

Current hard thresholds:

- selector key conflicts: `0`
- selector task-type overlap pairs: `0`

Current checked-in selector registry status:

- planner-visible skill count: `2`
- selector key conflicts: none
- selector task-type overlap pairs: none

## Rollback Conditions

Rollback is required if any one of the following becomes true:

- `selector_overlap_threshold_exceeded`
  - any selector key conflict appears
  - any deterministic selector task-type overlap pair appears
- `fail_closed_rate_anomalous`
  - observed fail-closed count rises above `2`
  - or observed fail-closed ratio rises above `0.5`
- `routing_mismatch`
  - any checked-in non-skill routing guard changes action or routing reason
- `answer_inconsistency`
  - answer-boundary inconsistency count rises above `0`
  - or success/fail-closed probes stop proving answer normalization and raw-payload blocking

Current checked-in decision boundary:

- all four rollback conditions are currently `false`
- current decision is `allow_two_planner_visible_skills`

## Debug SOP

When the coexistence watch fails:

1. run `node scripts/planner-visible-skill-check.mjs --json`
2. inspect `summary.selector_hit_rate_per_skill`
3. inspect `summary.fail_closed_count`, `summary.fail_closed_ratio`, and `summary.ambiguity_trigger_count`
4. inspect `query_types`
5. inspect `observability.selector_overlap`
6. inspect `cases.query_type_watch`
7. inspect `cases.success_probe` and `cases.fail_closed_probe`

Current read order by failure class:

- selector overlap or selector hit-rate drift
  - inspect `/Users/seanhan/Documents/Playground/src/planner/skill-bridge.mjs`
- admission/fail-closed drift
  - inspect `/Users/seanhan/Documents/Playground/src/planner/skill-bridge.mjs`
  - inspect `/Users/seanhan/Documents/Playground/src/executive-planner.mjs`
- routing fallback drift
  - inspect `/Users/seanhan/Documents/Playground/src/executive-planner.mjs`
- answer inconsistency or raw payload leak
  - inspect `/Users/seanhan/Documents/Playground/src/user-response-normalizer.mjs`
  - inspect `/Users/seanhan/Documents/Playground/src/planner-visible-skill-observability.mjs`

## Live Design Boundary

This document remains the checked-in coexistence watch and fixture baseline.

It is not itself a live telemetry pipeline.

Current intended layering is:

- this file:
  - checked-in selector/query/probe watch
- [planner_visible_live_telemetry_design.md](/Users/seanhan/Documents/Playground/docs/system/planner_visible_live_telemetry_design.md):
  - production-ready event/metric/alert/rollback design
- `/Users/seanhan/Documents/Playground/src/planner-visible-live-telemetry-spec.mjs`:
  - checked-in minimal stub for future wiring

## Rollback SOP

The fastest safe rollback is to remove only the affected skill from planner-visible catalog exposure while keeping the checked-in internal skill runtime intact.

Current rollback steps:

1. identify which rollback condition fired
2. choose the affected action in `/Users/seanhan/Documents/Playground/src/planner/skill-bridge.mjs`
3. change that action metadata from:
   - `surface_layer = "planner_visible"`
   - `promotion_stage = "planner_visible"`
4. back to:
   - `surface_layer = "internal_only"`
   - `promotion_stage = "internal_only"`
   - keep `previous_promotion_stage = "planner_visible"` as rollback evidence
5. do not add a fallback or widen another skill to compensate
6. rerun:
   - `node scripts/planner-visible-skill-check.mjs`
   - `node --test tests/planner-visible-skill-observability.test.mjs tests/search-and-summarize-readiness.test.mjs tests/executive-planner.test.mjs`

This rollback path keeps:

- no new public API
- no third planner-visible skill
- admission still fail-closed
- deterministic internal-only skill execution still available to explicit task-type callers

## Current Assessment

With the current checked-in watch:

- two planner-visible skills are stable enough to keep running together
- but only under the current narrow admission boundary
- follow-up/deictic references must stay outside planner-visible admission
- mixed search/detail language must keep failing closed
- rollback should happen immediately if overlap, fail-closed inflation, routing drift, or answer inconsistency appears
