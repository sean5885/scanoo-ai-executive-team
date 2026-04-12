# Modules

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Scope

This file is the current code-truth mirror for the checked-in runtime.

It intentionally separates:

- `implemented`: code path exists and is exercised by the current runtime or checked-in tests
- `secondary`: code exists, but it is not the main public surface for the same capability
- `policy-only`: governance language or design intent exists, but there is no full end-to-end runtime path
- `historical`: frozen baseline or migration aid; keep only as reference, not as the primary explanation

The consolidated truth table lives in [truth_matrix.md](/Users/seanhan/Documents/Playground/docs/system/truth_matrix.md).

Current-truth docs for onboarding are:

- [modules.md](/Users/seanhan/Documents/Playground/docs/system/modules.md)
- [api_map.md](/Users/seanhan/Documents/Playground/docs/system/api_map.md)
- [data_flow.md](/Users/seanhan/Documents/Playground/docs/system/data_flow.md)
- [repo_map.md](/Users/seanhan/Documents/Playground/docs/system/repo_map.md)
- [write_policy_unification.md](/Users/seanhan/Documents/Playground/docs/system/write_policy_unification.md)
- [truth_matrix.md](/Users/seanhan/Documents/Playground/docs/system/truth_matrix.md)
- [open_questions.md](/Users/seanhan/Documents/Playground/docs/system/open_questions.md)

## Canonical Terms

- `canonical source object`
  - the normalized evidence item used before public answer rendering
  - current shape is `{ id, snippet, metadata }`
  - code: `/Users/seanhan/Documents/Playground/src/read-source-schema.mjs`, `/Users/seanhan/Documents/Playground/src/answer-source-mapper.mjs`
- `mapping`
  - a checked-in route, authority, or action mapping that drives runtime behavior
  - examples:
    - read authority mapping in `/Users/seanhan/Documents/Playground/src/read-runtime.mjs`
    - external write action mapping in `/Users/seanhan/Documents/Playground/src/external-mutation-registry.mjs`
    - planner flow mapping in `/Users/seanhan/Documents/Playground/src/planner-flow-runtime.mjs`
- `mutation journal`
  - the runtime metadata recorded under `mutation_execution.meta.journal`
  - currently includes `action`, `status`, `started_at`, optional `error`, optional `rollback`, and optional `audit`
  - code: `/Users/seanhan/Documents/Playground/src/mutation-runtime.mjs`

## Runtime Module Groups

### 1. HTTP and Event Entrypoints

- Implemented:
  - `/Users/seanhan/Documents/Playground/src/http-server.mjs`
  - `/Users/seanhan/Documents/Playground/src/index.mjs`
  - `/Users/seanhan/Documents/Playground/src/lark-plugin-dispatch-adapter.mjs`
  - `/Users/seanhan/Documents/Playground/src/runtime-conflict-guard.mjs`
  - `/Users/seanhan/Documents/Playground/src/runtime-message-deduper.mjs`
  - `/Users/seanhan/Documents/Playground/src/runtime-message-reply.mjs`
  - `/Users/seanhan/Documents/Playground/src/single-machine-runtime-coordination.mjs`
  - `/Users/seanhan/Documents/Playground/src/runtime-observability.mjs`
- What they do now:
  - start the HTTP service and the Lark long-connection listener
  - accept the checked-in official plugin ingress on `POST /agent/lark-plugin/dispatch`
  - create per-request and per-event trace records
  - enforce duplicate-message suppression
  - guard against competing local responders
  - serialize same-account same-session workflow/executive entrypoints inside one process so one session keeps one active coordination owner at a time
  - normalize plugin `thread -> chat -> session` dispatch keys, record route-target observability, and keep direct ingress marked separately from the formal plugin entry when `LARK_DIRECT_INGRESS_PRIMARY_ENABLED=false`
  - preserve bounded plugin handoff context on hybrid dispatch: explicit user auth now stays mirrored on `event / event.context / __lobster_plugin_dispatch.plugin_context` for downstream lanes, and structured doc refs / compare objects still survive the synthetic lane event instead of collapsing to plain text only
  - send long-connection bot replies only through the mutation runtime, and only treat the send as successful when the Lark message response returns a concrete `message_id`; the runtime reply helper now emits `reply_send_attempted`, `reply_send_succeeded`, and `reply_send_failed` instead of a generic post-await success log
- Evidence:
  - `/Users/seanhan/Documents/Playground/tests/http-server.route-success.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/http-server.trace.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/http-monitoring.test.mjs`

### 2. Read Path

- Implemented:
  - `/Users/seanhan/Documents/Playground/src/read-runtime.mjs`
  - `/Users/seanhan/Documents/Playground/src/index-read-authority.mjs`
  - `/Users/seanhan/Documents/Playground/src/company-brain-query.mjs`
  - `/Users/seanhan/Documents/Playground/src/derived-read-authority.mjs`
- Current truth:
  - read authority is explicit, not implicit fallback
  - `index` handles retrieval search and system-knowledge reads
  - `mirror` handles `company_brain_docs`
  - `derived` handles approved knowledge and approval/learning-state views
  - `live` handles direct Lark doc/comment reads
  - live read helpers accept either a raw access-token string or the checked-in resolved auth envelope shape and normalize that into the canonical live-read request before reader execution
- Evidence:
  - `/Users/seanhan/Documents/Playground/tests/read-runtime.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/company-brain-query.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/http-server.route-success.test.mjs`

### 3. Answer Path

- Main implemented public path:
  - `/Users/seanhan/Documents/Playground/src/lark-plugin-dispatch-adapter.mjs`
  - `/Users/seanhan/Documents/Playground/src/http-server.mjs`
  - `/Users/seanhan/Documents/Playground/src/planner-user-input-edge.mjs`
  - `/Users/seanhan/Documents/Playground/src/executive-planner.mjs`
  - `/Users/seanhan/Documents/Playground/src/execution-readiness-gate.mjs`
  - `/Users/seanhan/Documents/Playground/src/truly-missing-slot.mjs`
  - `/Users/seanhan/Documents/Playground/src/execution-outcome-scorer.mjs`
  - `/Users/seanhan/Documents/Playground/src/step-decision-advisor.mjs`
  - `/Users/seanhan/Documents/Playground/src/advisor-alignment-evaluator.mjs`
  - `/Users/seanhan/Documents/Playground/src/decision-engine-promotion.mjs`
  - `/Users/seanhan/Documents/Playground/src/promotion-control-surface.mjs`
  - `/Users/seanhan/Documents/Playground/src/decision-metrics-scoreboard.mjs`
  - `/Users/seanhan/Documents/Playground/src/planner-working-memory-trace.mjs`
  - `/Users/seanhan/Documents/Playground/src/usage-layer-intelligence-pass.mjs`
  - `/Users/seanhan/Documents/Playground/src/planner-ingress-contract.mjs`
  - `/Users/seanhan/Documents/Playground/src/user-response-normalizer.mjs`
  - `/Users/seanhan/Documents/Playground/src/answer-source-mapper.mjs`
- Current truth:
  - `GET /answer` no longer uses `answer-service.mjs` as its primary route
  - the checked-in official plugin entry now lands on `/Users/seanhan/Documents/Playground/src/lark-plugin-dispatch-adapter.mjs` first, not on scattered route decisions inside the plugin
  - public answer generation goes through planner execution first
  - plugin-native document/message/calendar/task-style tools are explicitly classified as `plugin_native` and do not enter the internal planner/lane business path
  - planner-backed `/answer` and plugin hybrid dispatch now arm one earlier bounded-fallback abort signal before the outer HTTP hard timeout, so planner/lane fail-soft recovery can answer first and the generic timeout stays the last resort
  - `/answer` and the `knowledge-assistant` lane now share one checked-in answer-edge helper instead of rebuilding `execute -> envelope -> normalize` separately
  - that shared answer-edge helper also lifts current legacy planner result shapes into canonical `answer / sources / limitations` before public rendering
  - `planner-ingress-contract.mjs` is the checked-in ingress rule for doc/knowledge/runtime planner admission and the personal-lane planner edge guard
  - planner ingress now only escalates high-confidence doc/runtime phrasings; generic wording such as standalone "整理" or "風險" no longer forces document/runtime routing by itself
  - planner flow ownership between `runtime_info`, `doc_query`, `okr`, `bd`, and `delivery` is now explicit in code rather than inferred from flow priority or registration order
  - active-plan continuation now runs one deterministic session-level pre-execution readiness gate before dispatching the current step action
  - planner working-memory continuation now also has one deterministic usage-layer tightening pass:
    - short/high-related follow-ups prefer same-task continuation over accidental new-task reset
    - candidate-selection short follow-ups (for example `第一份` / `第2個` / `這個`) can continue the same task even when selected/current/next action hints are temporarily missing, as long as active task context still exists
    - `waiting_user` with already-filled slots resumes the current plan step instead of re-asking user by default
    - slot missingness now uses one shared helper (`/Users/seanhan/Documents/Playground/src/truly-missing-slot.mjs`) across readiness gate / usage layer / decision-promotion ask-user gate
    - in `waiting_user`, if required slots are all actually filled (not invalid and not ttl-expired), unresolved slots are treated as empty and runtime prefers resuming current-step/next-best action over reopening the same ask
    - same `waiting_user + required slots already filled` path now writes a bounded continuation signal into planner payload (`__force_resume_after_slot_fill`, `__slot_fill_resumed`) and usage-layer pass can expose `slot_fill_resumed=true` from runtime observability (`resumed_from_waiting_user`) for eval/diagnostic alignment
    - when planner/advisor surface suggests `ask_user` but slot-state already has valid reusable `filled` slots, runtime now suppresses redundant ask promotion and resumes current-step/next-best continuation instead (`slot_suppressed_ask`)
    - non-promotion owner continuity now has a guard: selector output keeps `current_owner_agent` unless reroute/owner-mismatch/capability-gap/explicit step-owner switch is present
    - retry continuation is now forced by state (`task_phase=retrying` or `recovery_action=retry_same_step`) and no longer treated as a fresh task by default
    - safe-tool execution now hard-checks read-only skill boundary (`search_and_summarize` / `document_summarize` / `search_company_brain_docs` / `official_read_document`) so those skills cannot continue through write-class actions (`send_message` / `update_doc` / `create_task` / `write_memory` / `update_record`); violations are recorded as `__boundary_violation` and fail-soft to fallback
    - safe-tool continuation now also writes one unified internal state marker `__continuation_state={state,resume}` (`idle|continue|retry|ask_user|fallback`) so retry/ask/fallback telemetry uses one deterministic source
  - that gate is fail-closed and state-derived (slot/artifact/dependency/owner/recovery/plan integrity checks), and does not introduce a second planner/workflow truth source
  - when readiness is blocked, planner routing is lockable for the turn and reuses existing controlled paths (`ask_user` / `retry` / `reroute` / `rollback` / `skip` / fail-closed stop) instead of executing the intended action directly
  - the same step/recovery/readiness signals now feed a deterministic outcome scorer v1 (`success|partial|blocked|failed`) plus `outcome_confidence`, `outcome_evidence`, `artifact_quality`, `retry_worthiness`, and `user_visible_completeness`, and malformed outcome payloads are rejected fail-closed
  - the same execution-state signals now also feed a deterministic `step-decision-advisor` v1 that emits `recommended_next_action` with reason codes/confidence/based-on summaries at router and answer-boundary trace points; advisor output remains diagnostics-first by default and still does not mutate step status/outcome/recovery source fields
  - advisor recommendation vs actual execution/routing is now evaluated by a deterministic diagnostics-first `advisor-alignment-evaluator` v1:
    - output shape: `advisor_action`, `actual_action`, `is_aligned`, `alignment_type`, `divergence_reason_codes`, `promotion_candidate`, `evaluator_version`
    - alignment types: `exact_match|acceptable_divergence|hard_divergence|unknown`
    - malformed/missing inputs are fail-closed to `alignment_type=unknown`
    - this evaluator remains diagnostics-first; it does not directly mutate routing/recovery authority
  - `decision-engine-promotion` v1 now adds one gated override layer over advisor diagnostics:
    - promotion allow/deny/threshold truth is centralized in `/Users/seanhan/Documents/Playground/src/promotion-control-surface.mjs` (single authority)
    - v1 control surface policy:
      - `allowed_actions = ask_user|retry|reroute|fail`
      - `denied_actions = proceed|rollback|skip`
      - `ineffective_threshold = 3`
      - if an action appears in `rollback_disabled_actions`, promotion is blocked even if it is in `allowed_actions`
    - promotion prerequisites are all required: action policy says `promotion_allowed=true`, `advisor_alignment.promotion_candidate=true`, `alignment_type=exact_match`, evidence complete, no malformed/unknown/conflicting signals, and no readiness/outcome/recovery/artifact conflict against the promoted action
    - promoted `ask_user` is recalibrated fail-closed and is allowed only when all deterministic conditions hold:
      - advisor recommends `ask_user` and alignment is exact-match/evidence-complete
      - at least one truly missing required slot exists (missing entry OR `status!=filled` OR invalid OR ttl expired)
      - no resumable `current_step`/`next_best_action` path exists
      - no `slot_suppressed_ask` signal
      - not in `waiting_user` with all required slots already filled
      - readiness/outcome/recovery do not already indicate direct continuation
      - `ask_user` is not rollback-disabled by promotion policy
      - malformed slot gate input fails closed
    - when the ask-user recalibration gate blocks promotion, `ask_user` stays advisory-only and runtime continues on existing resume/next-best fail-soft paths
    - promoted `retry` is additionally gated by deterministic retry-only checks: `outcome.retry_worthiness=true`, `outcome_status!=failed`, `readiness.is_ready=true`, no `invalid_artifact`/`blocked_dependency`, retry budget not exhausted, and no rollback flag for `retry`
    - promoted `reroute` is additionally gated as bounded fail-closed:
      - explicit `owner_mismatch` or `capability_gap` signal
      - no `missing_slot` ask-user-priority signal
      - no `invalid_artifact`/`blocked_dependency`/hard-fail/recovery-conflict
      - reroute health baseline must exist and be non-low for `ask_user|retry|fail`; otherwise fail-closed
      - planner apply stage must verify exactly one legal reroute target; ambiguous/unverified target is fail-closed
      - promoted reroute observability now carries `previous_owner_agent`, `current_owner_agent`, `reroute_target`, `reroute_reason`, `reroute_source`
    - when the gate passes, planner/router can apply deterministic override on the same low-risk fail-soft/fail-closed boundary; when blocked, behavior stays on existing routing/recovery authority and only emits diagnostics (`decision_promotion`, `decision_promotion_summary`)
    - the same diagnostics payload now also carries `promotion_policy` / `promotion_policy_summary` so trace can answer current allow-list, rollback-disabled actions, and threshold in one place
    - the same boundary now also emits `promotion_audit` / `promotion_audit_summary` per step:
      - required audit fields include `promotion_audit_id`, `promoted_action`, `promotion_applied`, `promotion_context`, `promotion_outcome`, `promotion_effectiveness`, `rollback_flag`, `audit_version`
      - deterministic effectiveness rules cover promoted `ask_user`, `retry`, `reroute`, and `fail` outcomes; malformed/conflicting audits are fail-closed and excluded from ineffective streak counting
      - promoted `retry` audit marks `effective` when pre-retry failed/partial outcome is improved to `success`, otherwise `ineffective`
      - promoted `reroute` audit marks `effective` when reroute improves outcome / avoids blocked-or-failed / reaches completed follow-up; wrong-target/no-improvement paths are `ineffective`
      - rollback safety threshold source is the same centralized control surface (`ineffective_threshold=3` in v1) and disables future promotion for that action without retroactively changing already-executed actions
    - the same promotion-audit state now also keeps deterministic per-action metrics counters (`promotion_applied_count`, alignment split, effectiveness split, rollback flag count) so scoreboard aggregation does not create a second truth source
    - `/Users/seanhan/Documents/Playground/src/decision-metrics-scoreboard.mjs` builds one per-session/per-memory snapshot from existing observability + promotion control surface:
      - action entry fields: `action_name`, `promotion_enabled`, `promotion_applied_count`, `exact_match_count`, `acceptable_divergence_count`, `hard_divergence_count`, `effective_count`, `ineffective_count`, `rollback_flag_count`, `current_rollback_disabled`, `maturity_signal`, `scoreboard_version`
      - conservative deterministic maturity rule: `high|medium|low` (fixed threshold, no statistical model)
      - malformed input fails closed into empty scoreboard payload with explicit reason code
    - planner observability / trace now also exposes:
      - `decision_scoreboard.actions`
      - `decision_scoreboard_summary`
      - `highest_maturity_actions`
      - `rollback_disabled_actions`
      - `ask_user_gate.truly_missing_slots`
      - `ask_user_gate.blocked_reason_codes`
      - `ask_user_gate.promotion_allowed`
      - `ask_user_gate.resume_instead_of_ask`
      - `ask_user_blocked_reason`
      - `ask_user_recalibrated`
      - `ask_user_recalibration_summary`
  - final HTTP/chat response is normalized into `answer -> sources -> limitations`
  - for explicit plugin capability handoff (`requested_capability=scanoo_compare|scanoo_diagnose`), `/Users/seanhan/Documents/Playground/src/lane-executor.mjs` now executes one lane-primary fast-path before planner; success returns immediately and does not enter planner timeout recovery for that turn
  - `scanoo-compare` still reuses that same answer-edge helper, but now has one extra fail-soft branch in `/Users/seanhan/Documents/Playground/src/lane-executor.mjs`: when compare evidence is insufficient and did not already resolve to a doc-read action, it hard-shapes the fallback search query by extracting up to two `*店` compare targets plus matched metric terms from `流量 / 轉化 / 留存 / 排名`, strips the minimal stopwords `比較 / 一下 / 幫我 / 看看`, prefers the form `A店 vs B店 + 指標`, and then calls `/Users/seanhan/Documents/Playground/src/read-runtime.mjs -> searchCompanyBrainDocsFromRuntime(...)`; compare candidates pass a lane-local relevance gate (`demo/verify/success/test/final validation/minimal/artifact/stub/sample` hard filter + required `entity identifier + comparable metric + time/data` signals), and the fallback contract stays explicit: `>=2` valid entity+metric evidence -> normal compare, `>=1` -> partial compare with clear missing-dimension report, `0` -> non-generic gap report with concrete data requests
  - `scanoo-diagnose` still reuses that same answer-edge helper, but `/Users/seanhan/Documents/Playground/src/lane-executor.mjs` now prepends a fixed diagnose brief before planner execution so the reply stays inside the checked-in section order `【問題現象】 -> 【可能原因】 -> 【目前證據】 -> 【不確定性】 -> 【建議下一步】`
  - `/Users/seanhan/Documents/Playground/src/lane-executor.mjs` now treats diagnose doc refs more aggressively than compare: when `plugin_context.document_refs` already exposes a direct token it uses that `document_id`, and when the handoff only preserves `title` / `name` / `query` / bounded description text it now fail-soft mirror-searches those document-ref hints to recover one bounded `document_id`, then writes that resolved id back into the in-memory handoff refs for the rest of the diagnose turn
  - once `scanoo-diagnose` has a resolved doc id and explicit user auth, the same wrapper now forces `/Users/seanhan/Documents/Playground/src/read-runtime.mjs -> readDocumentFromRuntime(...)` unless planner already executed a doc-read action; on that fallback path, explicit user auth is resolved from the plugin handoff envelope first and session-persisted explicit auth second, instead of relying on tenant/generic auth only
  - when `scanoo-diagnose` still cannot read because the explicit user token is missing, the lane no longer falls through to the generic planner failure text: with hydrated doc refs / bounded evidence / readable auth context it now returns a weak-but-usable diagnose reply, and without that context it still returns an explicit-limitation diagnose reply that includes prompt-backed observations, candidate causes, and concrete next checks
  - if docs search still cannot resolve a document id, the lane now returns one bounded diagnose-contract missing-document reply instead of dropping to a generic fallback
  - when explicit Scanoo lane-primary fast-path does not return a bounded reply and runtime falls back to planner, the same turn no longer re-enters timeout-triggered lane fallback (`request_timeout -> lane fallback`) again
  - `user-response-normalizer.mjs` now only reads canonical `execution_result.data.answer / sources / limitations`
  - answer boundary now also runs a deterministic usage-layer intelligence pass:
    - emits `usage_layer.interpreted_as_continuation`, `usage_layer.interpreted_as_new_task`, `usage_layer.redundant_question_detected`, `usage_layer.owner_selection_feels_consistent`, `usage_layer.slot_suppressed_ask`, `usage_layer.retry_context_applied`, `usage_layer.response_continuity_score`, `usage_layer.usage_issue_codes`, and `usage_layer_summary` into planner working-memory observability
    - applies bounded continuity copy polish on continuation/retry/reroute replies so user-facing sources preserve continuation context while avoiding unnecessary “換流程” tone when owner is unchanged
  - delivery/onboarding single-hit company-brain search replies now answer first with the matched document title plus bounded location/checklist/step hints from indexed snippets, instead of only repeating the generic "已索引文件" search copy
  - canonical user replies now degrade gracefully when only partial `sources / limitations` are present, instead of collapsing straight to a full-failure generic reply
  - when the planner result would otherwise degrade to a generic failure, `user-response-normalizer.mjs` now performs a minimal mixed-request decomposition for copy/image/send-style asks and upgrades the reply to partial success if a text-draft subtask is still doable
  - `renderUserResponseText(...)` renders an already-canonical `{ answer, sources, limitations }` object directly without re-normalizing legacy payload shapes
  - planner/read evidence is converted into public `sources[]` lines through canonical source mapping
- Secondary implemented path:
  - `/Users/seanhan/Documents/Playground/src/answer-service.mjs`
  - still exists for internal retrieval-answer generation and tests
  - not the main `/answer` route entry
- Evidence:
  - `/Users/seanhan/Documents/Playground/tests/executive-planner.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/user-response-normalizer.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/answer-service.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/step-decision-advisor-v1.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/advisor-alignment-evaluator-v1.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/decision-metrics-scoreboard.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/decision-engine-promotion-v1.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/truly-missing-slot.test.mjs`

### 4. Skill Runtime

- Implemented:
  - `/Users/seanhan/Documents/Playground/src/skill-governance.mjs`
  - `/Users/seanhan/Documents/Playground/src/skill-contract.mjs`
  - `/Users/seanhan/Documents/Playground/src/skill-runtime.mjs`
  - `/Users/seanhan/Documents/Playground/src/skill-registry.mjs`
  - `/Users/seanhan/Documents/Playground/src/actions/send-message-action.mjs`
  - `/Users/seanhan/Documents/Playground/src/actions/update-doc-action.mjs`
  - `/Users/seanhan/Documents/Playground/src/skills/document-fetch.mjs`
  - `/Users/seanhan/Documents/Playground/src/skills/image-generate-skill.mjs`
  - `/Users/seanhan/Documents/Playground/src/skills/search-and-summarize-skill.mjs`
  - `/Users/seanhan/Documents/Playground/src/planner/action-loop.mjs`
  - `/Users/seanhan/Documents/Playground/src/planner/tool-loop.mjs`
  - `/Users/seanhan/Documents/Playground/src/planner/tool-loop-with-feedback.mjs`
  - `/Users/seanhan/Documents/Playground/src/planner/plan-normalizer.mjs`
  - `/Users/seanhan/Documents/Playground/src/planner/execution-pipeline.mjs`
  - `/Users/seanhan/Documents/Playground/src/planner/render-execution-result.mjs`
  - `/Users/seanhan/Documents/Playground/src/planner-autonomous-workflow.mjs`
  - `/Users/seanhan/Documents/Playground/src/prompts/action-system-prompt.txt`
  - `/Users/seanhan/Documents/Playground/src/planner/skill-bridge.mjs`
  - `/Users/seanhan/Documents/Playground/src/planner-visible-skill-observability.mjs`
  - `/Users/seanhan/Documents/Playground/src/planner-visible-live-telemetry-spec.mjs`
  - `/Users/seanhan/Documents/Playground/src/planner-visible-live-telemetry-adapter.mjs`
  - `/Users/seanhan/Documents/Playground/src/planner-visible-live-telemetry-runtime.mjs`
- Current truth:
  - a checked-in minimal skill contract now exists
  - the checked-in skill/helper modules under `src/skills/` now also export a lightweight descriptive `SKILL_CONTRACT` object with `intent`, `success_criteria`, and `failure_criteria`
  - skill definitions must now declare `skill_class` and `runtime_access`
  - the runtime validates input, output, and side effects
  - the runtime rejects non-serializable input/output and nested skill execution
  - the checked-in skill set is currently `search_and_summarize`, `document_summarize`, and `image_generate`
  - `search_and_summarize` and `document_summarize` are read-only and go through `read-runtime`
  - `image_generate` is a checked-in internal-only read-only skill that returns a deterministic placeholder image URL without external side effects
  - `send-message-action.mjs` is a bounded Lark IM write helper for text messages (`/open-apis/im/v1/messages?receive_id_type=chat_id`) and now fails fast on missing fields or non-ASCII `token/chat_id` placeholders before network send
  - `update-doc-action.mjs` is a bounded Lark Docx write helper that enters `/Users/seanhan/Documents/Playground/src/execute-lark-write.mjs` `executeLarkWrite(...)` and then reuses `/Users/seanhan/Documents/Playground/src/lark-content.mjs` `updateDocument(...)`; it supports optional `token_type/mode` and infers tenant token mode from `t-` token prefix when `token_type` is absent
  - `planner/action-loop.mjs` currently provides a minimal standalone action executor (`send_message`, `update_doc`, `create_task`) and returns a bounded `no_action | action_executed | unsupported_action` shape; it now also hard-blocks read-only skill contexts from executing write actions and returns `error = read_only_skill_cannot_execute_write_action` with `blocked = true`
  - `planner/tool-loop.mjs` wraps `runActionLoop(...)`; it keeps the loop envelope (`type = "tool_loop"`, ordered `steps`) and follows bounded `next_action` chaining up to `max_steps`; it now also enforces the same read-only-skill/write-action hard block both before the first step and while stepping chained actions
  - `planner/tool-loop-with-feedback.mjs` is a local feedback-loop helper that reruns `llm(...)` each step with the previous step history (`previous_steps` + `last_result`), returns early on normalized `answer`, and otherwise executes through the same bounded action loop
  - `planner/plan-normalizer.mjs` is a local helper that normalizes model output into a plan-like object but is not currently wired as a required planner contract step
  - `planner/execution-pipeline.mjs` is a local orchestration helper that runs `llm(input) -> normalizePlan(raw)` and then:
    - returns `{ ok: true, type: "answer", answer }` directly when normalized output carries `answer`
    - otherwise enters `runToolLoopWithFeedback({ llm, input, context, max_steps: 3 })` through a replay wrapper that reuses that first `raw` output as feedback-loop step 1 (so the initial action decision is not dropped)
    - when feedback loop returns `type = "final_answer"`, it maps to `{ ok: true, type: "answer", answer, steps }`
    - otherwise it uses `planner/render-execution-result.mjs` to convert feedback-loop steps into a readable fallback `answer` and still returns `{ ok: true, type: "answer", answer, steps }`
  - `planner-autonomous-workflow.mjs` is a local deterministic workflow helper that maps bounded user-input patterns (currently Scanoo intro-style asks) into a fixed tool sequence (`search_company_brain_docs -> official_read_document -> answer_user_directly`) through `tool-execution-runtime.mjs`
  - that helper currently returns one bounded execution envelope `{ ok, plan, state, final }` and fail-soft exits early on first failed action (`{ ok:false, failed_action, state }`)
  - this autonomous helper is currently local/demo-only and not wired as the primary `/answer` or plugin dispatch control path
  - `requestPlannerJson(...)` in `/Users/seanhan/Documents/Playground/src/executive-planner.mjs` now prepends an optional file-backed system message from `/Users/seanhan/Documents/Playground/src/prompts/action-system-prompt.txt` when the file exists
  - `src/skills/document-fetch.mjs` is a secondary read-only helper under the same module group; it resolves `document_id` from direct input or raw Lark-style card payload and returns bounded `missing_access_token | not_found | permission_denied` failures without registering a new planner-visible skill
  - planner can consume a skill result through a bridge envelope
  - planner-visible skill selection is deterministic-only and conflict-fail-closed
  - planner-visible skill rollout now has a checked-in observability/rollback watch over selector, tool execution, and answer-boundary evidence
  - planner-visible live telemetry now emits minimal spec-constrained runtime events through an injected telemetry adapter at planner decision/selection, fail-closed admission, fallback, and answer boundary
  - the default adapter is a bounded in-memory buffer and the checked-in mock structured-log adapter can write JSON lines to console or a local file stub
  - no external telemetry pipeline is wired from this module set yet
  - skill existence does not add a new public route or planner routing target by itself
- Evidence:
  - `/Users/seanhan/Documents/Playground/tests/skill-runtime.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/document-fetch.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/execution-pipeline.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/execution-pipeline-feedback.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/tool-loop-feedback.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/planner-autonomous-workflow.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/planner-visible-skill-observability.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/planner-visible-live-telemetry-adapter.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/planner-visible-live-telemetry-spec.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/planner-visible-live-telemetry-runtime.test.mjs`

### 4A. Task Layer Helper

- Implemented:
  - `/Users/seanhan/Documents/Playground/src/task-layer/task-classifier.mjs`
  - `/Users/seanhan/Documents/Playground/src/task-layer/task-dependency.mjs`
  - `/Users/seanhan/Documents/Playground/src/task-layer/task-skill-map.mjs`
  - `/Users/seanhan/Documents/Playground/src/task-layer/task-to-answer.mjs`
  - `/Users/seanhan/Documents/Playground/src/task-layer/orchestrator.mjs`
- Current truth:
  - a checked-in task-layer helper now exists under `src/task-layer/`
  - it performs deterministic keyword classification into `copywriting`, `image`, and `publish`
  - `task-dependency.mjs` defines the current checked-in execution order as `copywriting -> image -> publish`
  - it maps those task tags to routed capability identifiers `document_summarize`, `image_generate`, and `message_send`
  - `/Users/seanhan/Documents/Playground/src/task-layer/task-aggregator.mjs` folds per-task records into a unified `{ ok, tasks, results, summary, data, errors }` envelope
  - `/Users/seanhan/Documents/Playground/src/task-layer/task-to-answer.mjs` converts that bounded task-layer envelope into canonical `answer / sources / limitations` fields for planner-facing multi-task replies, and now prefers surfacing bounded per-task natural-language content (for example copy text or generated-image location) before falling back to generic execution summary text
  - `runTaskLayer(...)` sorts detected tasks through that dependency helper, executes the provided `runSkill` callback sequentially, and returns that aggregated envelope with both raw per-task records and summarized status
  - if a task is classified but no routed capability identifier is mapped, the helper records `no_skill_mapped` fail-soft and still keeps the same bounded result shape
  - a task failure is recorded fail-soft and does not stop later tasks from running in the same bounded pass
  - `executePlannedUserInput(...)` can now consult this helper as a planner pre-pass, but only when the caller explicitly provides a `runSkill` callback
  - if that optional pre-pass detects more than one task, planner execution short-circuits into a bounded `multi_task` result that still stays inside the canonical `answer / sources / limitations` boundary
  - if no `runSkill` callback is provided, the pre-pass errors, or at most one task is detected, the original planner flow continues unchanged
  - the checked-in public `/answer` edge does not currently provide `runSkill`, so this does not change the default public route behavior
  - `document_summarize` is a checked-in skill-backed action, `message_send` is a checked-in write action, and `image_generate` is now a checked-in internal-only skill-backed action that still returns a placeholder URL rather than calling a real image backend
- Evidence:
  - `/Users/seanhan/Documents/Playground/tests/task-dependency.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/task-layer.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/task-layer-integration.test.mjs`

### 5. External Write Path

- Implemented:
  - `/Users/seanhan/Documents/Playground/src/external-mutation-registry.mjs`
  - `/Users/seanhan/Documents/Playground/src/write-policy-contract.mjs`
  - `/Users/seanhan/Documents/Playground/src/lark-mutation-runtime.mjs`
  - `/Users/seanhan/Documents/Playground/src/mutation-runtime.mjs`
  - `/Users/seanhan/Documents/Playground/src/execute-lark-write.mjs`
- Current truth:
  - external writes are described by registry-backed action specs
  - public route or lane code builds a canonical request and write policy
  - `mutation-runtime.mjs` owns admission, verification, and mutation journal generation
  - `execute-lark-write.mjs` is the only checked-in `executeLarkWrite(...)` callsite authority
- Evidence:
  - `/Users/seanhan/Documents/Playground/tests/mutation-admission.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/write-policy-contract.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/mutation-runtime.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/lark-mutation-runtime.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/execute-lark-write.test.mjs`

### 6. Company-Brain Mirror and Governance

- Implemented mirror/read side:
  - `/Users/seanhan/Documents/Playground/src/company-brain-write-intake.mjs`
  - `/Users/seanhan/Documents/Playground/src/company-brain-query.mjs`
  - `/Users/seanhan/Documents/Playground/src/company-brain-learning.mjs`
  - `/Users/seanhan/Documents/Playground/src/company-brain-review.mjs`
  - `/Users/seanhan/Documents/Playground/src/company-brain-lifecycle-contract.mjs`
- Current truth:
  - verified mirror ingest exists
  - read-side list/detail/search exists
  - review, conflict check, approval transition, apply, and learning-state routes exist
  - approved knowledge is a separate derived/applied surface
  - the audited company-brain review/learning/verifier helpers now re-enter `read-runtime.mjs` for mirror/derived reads
- Important boundary:
  - this is not a full generic company-brain runtime
  - mirror ingest is not equivalent to formal approval
  - apply is gated by the checked-in lifecycle contract, not by a broader autonomous workflow engine
- Evidence:
  - `/Users/seanhan/Documents/Playground/tests/company-brain-write-intake.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/company-brain-review-approval.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/company-brain-lifecycle-contract.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/http-server.route-success.test.mjs`

### 7. Workflow-Specific Mutation Surfaces

- Implemented:
  - comment rewrite: `/Users/seanhan/Documents/Playground/src/doc-comment-rewrite.mjs`
  - comment/doc workflow closure helper: `/Users/seanhan/Documents/Playground/src/comment-doc-workflow.mjs`
  - comment suggestion ingress: `/Users/seanhan/Documents/Playground/src/comment-suggestion-workflow.mjs`
  - meeting workflow: `/Users/seanhan/Documents/Playground/src/meeting-agent.mjs`
  - capture/update/delete during meeting capture: `/Users/seanhan/Documents/Playground/src/lane-executor.mjs`
- Current truth:
  - comment/doc preview now has one checked-in owner path: preview is prepared by `comment-doc-workflow.mjs`, review is represented by one `awaiting_review` task plus one confirmation artifact, and apply is only allowed from `/api/doc/rewrite-from-comments`
  - comment suggestion card and poller are ingress-only surfaces into that same preview/review path; they do not own a separate apply or completion path
  - comment rewrite final materialization still uses doc replace-based apply inside the shared runtime gate
  - meeting confirmation writes are runtime-governed external writes
  - meeting capture document create/update/delete actions are already registry-backed external writes
  - the checked-in workflow/executive entrypoints now also pass through one single-machine coordination helper keyed by `account_id + session_key`, so overlapping local turns do not each create or finish their own competing same-session owner path
  - active-task cleanup is now owner-aware: terminal workflow completion clears the session pointer only when the finishing task still owns that session slot
- Evidence:
  - `/Users/seanhan/Documents/Playground/tests/doc-comment-rewrite.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/control-unification-phase2-doc-rewrite.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/comment-suggestion-workflow.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/http-server.route-success.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/meeting-agent.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/control-unification-phase2-meeting.test.mjs`

### 7A. Executive Closed-Loop Learning and Metrics

- Implemented:
  - `/Users/seanhan/Documents/Playground/src/executive-closed-loop.mjs`
  - `/Users/seanhan/Documents/Playground/src/executive-reflection.mjs`
  - `/Users/seanhan/Documents/Playground/src/executive-improvement.mjs`
  - `/Users/seanhan/Documents/Playground/src/executive-improvement-workflow.mjs`
  - `/Users/seanhan/Documents/Playground/src/executive-evolution-metrics.mjs`
  - `/Users/seanhan/Documents/Playground/src/executive-evolution-replay.mjs`
  - `/Users/seanhan/Documents/Playground/scripts/executive-evolution-replay.mjs`
  - `/Users/seanhan/Documents/Playground/scripts/executive-evolution-replay-pack.mjs`
- Current truth:
  - execution reflection remains the checked-in source for per-step `success / deviation / reason`
  - top-level reflection records now also classify `missing_access_token`, `permission_denied`, and `document_not_found` as `reason = missing_info` with `deviation = true`
  - finalized executive turns now archive a local evolution snapshot alongside the reflection record
  - the runtime logger now emits one structured `executive_evolution_metrics` event with rolling local rates for `reflection_deviation_rate`, `improvement_trigger_rate`, and `retry_success_rate`
  - bounded executive replay can now compare the same task across `first_run` and `second_run` run specs and output `improvement_delta` for success, steps, and deviation
  - the checked-in replay pack runner executes every JSON spec under `evals/executive-replay/fixtures`, reports one bounded result line per case, and can also emit a single JSON summary document
  - this replay surface is offline/local reconstruction only; it does not promise raw live request replay or automatic improvement application
- this path is process-local and file-backed through the existing reflection archive; it does not use any external telemetry service
- adjacent planner-visible skill failures may also emit a separate process-local `skill_bridge_failure` hook through `/Users/seanhan/Documents/Playground/src/reflection/skill-reflection.mjs` when `globalThis.appendReflectionLog` is present; this is additive observability and not the same persistence path as the executive reflection archive
- Evidence:
  - `/Users/seanhan/Documents/Playground/tests/executive-closed-loop.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/executive-evolution-metrics.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/executive-evolution-replay.test.mjs`

### 7B. Usage/Decision Evaluation Runner (Real-World Pass V1)

- Implemented:
  - `/Users/seanhan/Documents/Playground/src/usage-eval-runner.mjs`
  - `/Users/seanhan/Documents/Playground/tests/fixtures/usage-eval-cases.json`
  - `/Users/seanhan/Documents/Playground/tests/usage-eval-runner-v1.test.mjs`
- Current truth:
  - this is a pure evaluation/measurement layer; it does not change planner routing or decision behavior
  - the runner executes multi-turn test cases and collects turn-level observability surfaces:
    - `usage_layer`
    - `decision_promotion`
    - `advisor_alignment`
    - `outcome`
    - `readiness`
    - simplified trace snapshot (`case_id`, `turn_index`, `action.actual/promoted`, `usage_issue_codes`, `response_continuity_score`, `outcome_status`)
  - output is deterministic and bounded to:
    - per-case summary
    - global aggregated metrics (`continuation`, `redundant ask`, `slot resume`, `decision promotion`, `reroute quality`, `usage issue/continuity distribution`)
    - global summary (`top issues`, `divergence patterns`, `promotion performance`, `pause recommendations`, `overall intelligence signal`)
  - malformed fixtures fail closed with `contract_violation` shape; runner does not silently skip invalid case structures
  - checked-in fixture pack currently contains 114 multi-turn real-world cases, including hardening categories for ambiguous utterances, short utterances, typos, multi-intent requests, supplement-data turns, emotional statements, and half-sentence inputs
  - default CLI case-count target for this runner is `100~140` (`DEFAULT_USAGE_EVAL_CASE_COUNT_MIN/MAX`)
  - direct CLI run now enforces hard regression guardrails and exits non-zero with `[REGRESSION_GUARDRAIL_FAIL]` when any of these checks degrade:
    - `summary.overall_intelligence_signal` must stay `high`
    - `aggregated_metrics.continuation_quality.mistaken_new_task_rate` must stay `0`
    - `aggregated_metrics.redundant_ask.redundant_question_rate` must stay `0`
    - `aggregated_metrics.continuation_quality.continuation_rate` must stay `>= 0.99`
    - `aggregated_metrics.slot_resume_quality.slot_fill_resume_success_rate` must stay `>= 0.99`
    - `summary.retry_context_success_rate` must stay `>= 0.99`
- Boundary:
  - this path is offline eval simulation only
  - no external dependencies, no runtime side effects, and no public API shape change
- Evidence:
  - `/Users/seanhan/Documents/Playground/tests/usage-eval-runner-v1.test.mjs`

### 8. Classification and Plugin Adapters

- Implemented:
  - semantic classifier: `/Users/seanhan/Documents/Playground/src/lark-drive-semantic-classifier.mjs`
  - OpenClaw plugin: `/Users/seanhan/Documents/Playground/openclaw-plugin/lark-kb/index.ts`
- Current truth:
  - semantic organization no longer depends only on OpenClaw; local fallback exists
  - OpenClaw plugin is an adapter over checked-in HTTP surfaces
- Evidence:
  - `/Users/seanhan/Documents/Playground/tests/lark-drive-semantic-classifier.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/openclaw-plugin-regression.test.mjs`

## Secondary and Non-Canonical Modules

- `secondary but real`
  - `/Users/seanhan/Documents/Playground/src/answer-service.mjs`
  - `/Users/seanhan/Documents/Playground/src/knowledge/knowledge-service.mjs`
  - `/Users/seanhan/Documents/Playground/src/planner/knowledge-bridge.mjs`
- `experimental / process-local`
  - `/Users/seanhan/Documents/Playground/src/company-brain-memory-authority.mjs`
  - `/Users/seanhan/Documents/Playground/src/memory-write-guard.mjs`
  - `/Users/seanhan/Documents/Playground/src/memory-write-detector.mjs`
- Current truth:
  - these files exist and are tested
  - they are not the canonical public read/write surfaces for the current system

## Policy-Only or Not Fully Landed

- no checked-in background worker mesh
- no full autonomous company-brain server
- no full generic repo-wide read abstraction; the audited company-brain/review/verification/system-knowledge helper set now re-enters `read-runtime.mjs`, but other repository-local reads still exist outside one universal surface
- no targeted block-level doc mutation runtime; targeted preview exists, final apply is still replace-based in the doc write adapter
- no production telemetry sink or runtime rollback flag carrier for planner-visible live telemetry; the checked-in emitter/adapters stay local-only (`in-memory` or mock structured-log) and the broader rollout design remains in `/Users/seanhan/Documents/Playground/docs/system/planner_visible_live_telemetry_design.md`

## Historical or Frozen References

- [mutation_path_mapping_phase1.md](/Users/seanhan/Documents/Playground/docs/system/mutation_path_mapping_phase1.md)
  - keep as historical Phase 1 mapping baseline
  - do not read it as the exhaustive current mutation inventory
- `/Users/seanhan/Documents/Playground/docs/system/mutation_admission_contract_v1.md`
  - frozen baseline for admission-contract history
  - current route/action truth is in code and mirrored through [write_policy_unification.md](/Users/seanhan/Documents/Playground/docs/system/write_policy_unification.md)
