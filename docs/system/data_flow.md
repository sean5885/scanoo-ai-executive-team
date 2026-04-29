# Data Flow

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Scope

This file mirrors the current data paths that are actually implemented.

The three main paths are:

1. `read`
2. `write`
3. `answer`

Sync, meeting, comment-rewrite, and the minimal skill layer are adjacent workflows built on top of those paths.

For the checked-in executive/workflow surfaces, same-account same-session entrypoints are now serialized in-process by `/Users/seanhan/Documents/Playground/src/single-machine-runtime-coordination.mjs` before task start/continue/apply/finalize logic runs.

The Lark long-connection reply path is a bounded adjacent flow: inbound `im.message.receive_v1` events enter `/Users/seanhan/Documents/Playground/src/index.mjs`, lane selection happens before reply materialization, and `/Users/seanhan/Documents/Playground/src/runtime-message-reply.mjs` now treats the downstream Lark send as complete only when the message mutation response includes a concrete `message_id`.
That same ingress surface now also tracks websocket lifecycle activity through `/Users/seanhan/Documents/Playground/src/long-connection-lifecycle-monitor.mjs`; `/Users/seanhan/Documents/Playground/src/index.mjs` mounts the monitor on startup, message callbacks mark ingress activity before lane execution, the monitor classifies decoded websocket control/data frames before `eventDispatcher.invoke(...)`, records the parsed callback/event type plus handler presence, and if the socket stays `ready` but has no inbound message or heartbeat activity past the watchdog window, the process exits so the local LaunchAgent can rebuild the persistent connection.

The OpenClaw plugin ingress is now a second bounded adjacent flow: tool calls first post to `POST /agent/lark-plugin/dispatch`, `/Users/seanhan/Documents/Playground/src/lark-plugin-dispatch-adapter.mjs` normalizes `request_text / session_id / thread_id / chat_id / user_id / source / requested_capability / capability_source`, preserves a bounded `plugin_context` handoff payload for explicit auth plus doc/compare references, derives the checked-in session key (`thread -> chat -> session`), uses `requested_capability` first when present, records dispatch observability, and then either:

1. executes the existing planner answer edge
2. executes the existing lane path through a synthetic lane event/scope
3. returns a `plugin_native` forward decision so the plugin can continue on the existing direct document/message/calendar/task-style route without entering the internal planner/lane business flow

## 0B. Attachment -> Extract -> Index -> Citation (PDF)

Current additive path:

1. inbound message structured content enters `/Users/seanhan/Documents/Playground/src/message-intent-utils.mjs`
2. `extractAttachmentObjects(...)` extracts bounded attachment metadata:
   - `file_key`
   - `file_token`
   - `name`
   - `mime`
   - `ext`
3. `/Users/seanhan/Documents/Playground/src/modality-router.mjs` classifies modality with PDF awareness:
   - `pdf`
   - `pdf_multimodal`
4. current checked-in path has no direct PDF OCR/read API execution step; PDF is recognized for routing/modality boundary only.
5. image-only execution paths now keep PDF out of image analysis dispatch:
   - `/Users/seanhan/Documents/Playground/src/lane-executor.mjs`
   - `/Users/seanhan/Documents/Playground/src/agent-dispatcher.mjs`
6. when downstream answer rendering needs source citation, source lines are generated from canonical evidence objects via `/Users/seanhan/Documents/Playground/src/answer-source-mapper.mjs`, not free-form source strings

Current truth:

- this is recognition/classification + citation-boundary hardening only
- no checked-in PDF text-extraction/index-write path is added in this change
- PDF permission/read-runtime boundary remains subject to existing controlled routes

## 0A. Autonomy Worker Failure Sink + Operator Incident Closure (Phase 2-3 additive)

Current additive path:

1. `/Users/seanhan/Documents/Playground/src/worker/autonomy-worker-loop.mjs` derives `recovery_decision`
2. for sink-class decisions, worker writes additive `error.lifecycle_sink={state,reason,failure_class,routing_hint,at}` to failure payload
3. `/Users/seanhan/Documents/Playground/src/task-runtime/autonomy-job-store.mjs` persists the failure payload under `error_json`, while preserving prior `operator_disposition.history` and refreshing `operator_disposition.latest` to runtime-failure context when applicable
4. job/attempt read records project `lifecycle_sink` from `error_json.lifecycle_sink` for query/observability
5. operator read model (`listAutonomyOpenIncidents`) lists only open incidents from failed jobs where `lifecycle_sink.state in {waiting_user, escalated}` and `operator_disposition.latest.action` is not `ack_waiting_user` / `ack_escalated`
6. single-incident helper (`getAutonomyOpenIncidentByJobId`) reuses the same open-incident filter semantics as list-read and returns one bounded record (including `operator_disposition`) for CLI-safe precondition reads
6A. additive caller receipt lookup read model in the same store:
   - `lookupAutonomyJobReceiptByTraceId(trace_id)`
   - `lookupAutonomyJobReceiptByRequestId(request_id)` (request key matched from persisted job payload envelope)
   - bounded response only: `job_id / job_type / status / lifecycle_sink / updated_at / reason(failure_class,routing_hint)`
   - lookup status projection is bounded to `accepted|queued|running|completed|failed|not_found`
   - unknown/miss path is fail-soft `not_found`
   - multi-hit lookup returns latest visible row by `updated_at DESC, created_at DESC, id DESC`
6B. additive read-only HTTP ingress for caller lookup:
   - `GET /api/monitoring/autonomy/receipt`
   - token sources: `trace_id` / `request_id` query params, plus existing `X-Trace-Id` / `X-Request-Id` headers
   - execution: ingress resolves token -> store lookup read model (`lookupAutonomyJobReceiptByTraceId` / `lookupAutonomyJobReceiptByRequestId`)
   - response remains bounded to `job_id / job_type / status / lifecycle_sink / updated_at / reason`; unknown/miss is fail-soft `status=not_found`
6C. additive final-result pickup read model in the same store:
   - `lookupAutonomyJobFinalPickupByTraceId(trace_id)`
   - `lookupAutonomyJobFinalPickupByRequestId(request_id)` (same payload-envelope request-id matching and same latest-visible ordering as receipt lookup)
   - bounded response only: `answer / sources / limitations / status / updated_at / reason`
   - never exposes raw `result_json / error_json / planner_result`
   - terminal gate is fail-soft: only truly completed rows can project `status=completed`
   - `queued / running / failed / not_found` remain non-completed states
   - completed projection prefers canonical `result_json.structured_result.answer/sources/limitations`; `answer` may fallback to `reply_text` only when needed
6D. additive read-only HTTP ingress for final pickup:
   - `GET /api/monitoring/autonomy/final`
   - token sources: `trace_id` / `request_id` query params, plus existing `X-Trace-Id` / `X-Request-Id` headers
   - execution: ingress resolves token -> store lookup read model (`lookupAutonomyJobFinalPickupByTraceId` / `lookupAutonomyJobFinalPickupByRequestId`)
   - response remains bounded to `answer / sources / limitations / status / updated_at / reason`; unknown/miss is fail-soft `status=not_found`
7. operator disposition writes (`applyAutonomyIncidentDisposition`) append `error_json.operator_disposition` with traceable `at/action/reason` and optional audit fields (`operator_id/request_id/expected_updated_at`)
8. additive precondition support (`precondition.expected_updated_at`) is guarded in the same transaction/update as the disposition write; stale mismatch fails-soft as `precondition_failed` (`stale=true`)
9. only `resume_same_job` re-queues the same job (`status=queued`, `next_run_at=now`); `ack_waiting_user` / `ack_escalated` are metadata-only and keep job status unchanged
10. optional replay bridge (`buildAutonomyIncidentReplaySpec`) emits bounded incident replay spec metadata only; no replay execution path is added
11. minimal operator CLI ingress (`/Users/seanhan/Documents/Playground/scripts/autonomy-operator-cli.mjs`) reuses the same store read/write path and enforces required disposition fields (`job_id`, `action`, `reason`, `operator_id`, `request_id`, `expected_updated_at`) before allowing any write

Current truth:

- this is an additive autonomy-store closure path: `ack_*` stays metadata-only while `resume_same_job` re-queues the same failed job (`status=queued`, `next_run_at=now`)
- sink state is currently bounded to:
  - `waiting_user` when recovery decision is `blocked` with `routing_hint` ending `_waiting_user`
  - `escalated` when recovery decision `next_state=escalated`
- operator closure here is additive and local to autonomy store:
  - no new escalation subsystem
  - no new queue/worker mesh
  - no planner/router/public response shape change

## 1. Read Path

### 1A. Retrieval Index Read

Current path:

1. request enters `/search`, planner-side retrieval, or a system-knowledge helper
2. runtime builds a canonical read request
3. `/Users/seanhan/Documents/Playground/src/read-runtime.mjs` resolves `primary_authority=index`
4. `index-read-authority.mjs` reads the local index or system-knowledge helper
5. result is normalized into the canonical read result shape

Current truth:

- this path is implemented
- it does not silently fall back to mirror/live on the same request
- public retrieval snippets are normalized through the read-source schema before leaving the runtime

### 1B. Company-Brain Mirror Read

Current path:

1. request enters `/api/company-brain/*` or `/agent/company-brain/*`
2. runtime builds a canonical read request
3. `read-runtime.mjs` resolves `primary_authority=mirror`
4. `company-brain-query.mjs` reads `company_brain_docs`
5. result is returned as mirror data plus derived summary/learning metadata where available

Current truth:

- this is a read-side mirror path
- it is not the same thing as approved knowledge
- it is not a generic approval runtime

### 1C. Approved Knowledge Read

Current path:

1. request enters `/agent/company-brain/approved/*`
2. runtime builds a canonical read request
3. `read-runtime.mjs` resolves `primary_authority=derived`
4. `derived-read-authority.mjs` reads the approved/applied view
5. result is returned in the same bounded read envelope

Current truth:

- approved knowledge is a separate derived surface
- it only becomes visible after the checked-in review/approval/apply path has completed

### 1D. Live Lark Read

Current path:

1. request enters `/api/doc/read` or comment-read helpers
2. runtime builds a canonical read request
3. `read-runtime.mjs` resolves `primary_authority=live`
4. `lark-content.mjs` fetches the live document or comment list

Current truth:

- this path is explicit and live-only
- it is not automatically supplemented by mirror data in the same route
- the checked-in live-read wrappers normalize either a raw access token or a resolved auth envelope before handing the request to the live reader

## 2. Write Path

### 2A. External Lark Write Path

Current path:

1. route or lane code determines the write action
2. code builds:
   - a canonical mutation request
   - a write policy record
3. external action metadata comes from `/Users/seanhan/Documents/Playground/src/external-mutation-registry.mjs`
4. `lark-mutation-runtime.mjs` invokes `runMutation(...)`
5. `mutation-runtime.mjs` performs:
   - admission
   - pre-verification
   - execute
   - post-verification
   - mutation journal generation
6. `execute-lark-write.mjs` performs the actual Lark mutation under runtime guard context
7. result returns to the route or lane

Current truth:

- this path is implemented
- direct `executeLarkWrite(...)` from route or lane modules is no longer the checked-in primary pattern
- runtime-local idempotency exists in `mutation-runtime.mjs`
- persisted HTTP idempotency also exists at the HTTP layer
- long-connection chat replies now reuse this same guarded write path and keep request/event/target/message evidence in the reply-send logs; awaiting the send call without a `message_id` is not treated as success
- long-connection chat replies now also reuse the incoming Lark `message_id` as the write idempotency key, so repeated canned reply text on different inbound messages does not trip `duplicate_write_same_session`
- message send/reply budget dedupe now distinguishes target plus reply content/card payload, so different replies in the same chat are not collapsed into one `duplicate_write_same_session` block

### 2B. Internal Company-Brain Governance Write Path

Current path:

1. mirror ingest or explicit company-brain governance route builds a canonical request
2. `runMutation(...)` is used for admission and verification
3. internal action writes review state, conflict state, approval state, learning state, or applied knowledge state

Current truth:

- this is implemented
- this is an internal governance write path, not an external Lark write path
- verified mirror ingest and approved/apply are distinct states

## 3. Answer Path

Current public `/answer` path:

1. request enters `GET /answer`
2. `http-server.mjs` calls `planner-user-input-edge.mjs` `runPlannerUserInputEdge(...)`
3. `runPlannerUserInputEdge(...)` first resolves one bounded completion-authority execution mode:
   - mode candidates: `sync_authoritative` (default), `queue_shadow` (current), `queue_authoritative` (skeleton, default-off)
   - guard inputs: `PLANNER_AUTONOMY_INGRESS_ENABLED`, strict allowlist hit from `PLANNER_AUTONOMY_INGRESS_ALLOWLIST`, and `PLANNER_AUTONOMY_QUEUE_AUTHORITATIVE_ENABLED` (only for queue authority skeleton)
   - when queue-authoritative is enabled, deterministic sampling gate `PLANNER_AUTONOMY_QUEUE_AUTHORITATIVE_SAMPLING_PERCENT` (0~100) runs before worker-ready:
     - sampling key uses `request_id` first, then `trace_id`
     - sampling miss keeps the existing non-authoritative path (`queue_shadow`)
     - `0` force-closes queue-authoritative immediately; `100` keeps full-open behavior (still subject to worker-ready gate)
   - if candidate mode is `queue_authoritative`, one worker-ready admission gate runs first using bounded latest heartbeat/lease signal (`readAutonomyWorkerReadiness`) from running-attempt + worker-heartbeat records; gate is fail-closed
   - when worker-ready gate is not ready, mode is force-downgraded to `sync_authoritative` before enqueue is attempted
   - ingress observability now emits additive runtime trace events for rollout checks:
     - mode decision: `planner_autonomy_ingress_mode_decision`
     - deterministic sampling miss: `planner_autonomy_queue_authoritative_sampling_miss`
     - worker-ready gate fallback: `planner_autonomy_queue_authoritative_gate_fallback_sync`
     - enqueue fail fallback: `planner_autonomy_ingress_fallback_sync`
4. when mode is `queue_shadow` or `queue_authoritative`, the same bounded autonomy ingress adapter may enqueue additive job `planner_user_input_v1`
   - contract: enqueue accepted is not final completion and not a final user answer
   - fail-soft: enqueue failure / queue unavailable falls back to same-request synchronous planner path
5. when mode is `queue_authoritative` and enqueue is accepted:
   - edge does not call `executePlannedUserInput(...)` in the same request
   - edge returns the existing response shape (`plannerResult / plannerEnvelope / userResponse`) with non-enumerable metadata marking `non-final` pending state
   - completed authority remains worker + verifier only (no result delivery in this stage)
5A. additive autonomy worker execute path for the same job type:
   - claim stage first applies stale fail-soft guard (`AUTONOMY_MAX_QUEUED_AGE_MS`, default 60s):
     - queued rows older than threshold are moved to `failed` with `queued_job_stale_timeout`
     - expired running rows that are also older than threshold are moved to `failed` with `running_job_stale_timeout`
   - queued claim order is FIFO fairness-first with recent-window priority:
     - rows in `AUTONOMY_QUEUED_FRESH_PRIORITY_WINDOW_MS` (default 60s) are claimed before older backlog rows
     - inside the same priority bucket, claim uses oldest schedulable `next_run_at/created_at` first
   - worker claims `job_type=planner_user_input_v1`
   - worker dispatches payload to `executePlannedUserInput(...)`
   - when `AUTONOMY_CANARY_MODE=true` and payload is canary-marked (`planner_input.text` contains `autonomy canary` or `planner_input.session_key` starts with `autonomy-canary-`), worker seeds deterministic planner decision `{ action: "get_runtime_info", params: {} }` before execute to keep queue-authoritative canary throughput bounded
   - after any successful claim, worker schedules the next tick immediately (`0ms`) so queue drain speed follows execute time rather than fixed poll interval
   - worker execute stage is bounded by `AUTONOMY_EXECUTE_TIMEOUT_MS` (default 60s); timeout aborts in-flight execute signal, then fail-softs as runtime exception and does not mark completion
   - worker completion still requires verifier gate pass; execute failure / verifier fail continue to `recovery_decision_v1` fail-soft handling
6. otherwise `runPlannerUserInputEdge(...)` runs executive memory retrieval first (`session memory + approved memory` from `/Users/seanhan/Documents/Playground/src/executive-memory.mjs`), then calls `executePlannedUserInput(...)` with bounded internal `decisionMemory` context
7. `executive-planner.mjs` resolves planner action or controlled failure
   - planner now mounts an additive execution-plane selector facade (`/Users/seanhan/Documents/Playground/src/execution/index.mjs`) backed by contract/evidence skeleton registries (`/Users/seanhan/Documents/Playground/src/contracts/index.mjs`, `/Users/seanhan/Documents/Playground/src/evidence/index.mjs`); current selector behavior remains pass-through
   - before active current-step continuation, planner runs one deterministic execution-readiness gate from the same session working-memory execution plan state
   - readiness is fail-closed and checks slot/artifact/dependency/owner/recovery/plan validity on current step, returning `is_ready`, blocking diagnostics, and `recommended_action`
   - when `is_ready=false`, planner does not dispatch intended step action directly; it follows existing controlled paths (`ask_user` / `retry` / `reroute` / `rollback` / `skip` / fail-closed stop)
   - for tool-layer contract actions, planner now consumes continuation tokens as dispatch control flow (not metadata-only):
     - `retry`: bounded re-dispatch under retry policy
     - `ask_user`: stop at ask-user boundary without implicit fallthrough
     - `fallback`: stop at fallback boundary without implicit fallthrough
     - `complete_task`: accept current dispatch result as terminal
     - unknown token: fail-closed (`invalid_continuation_token`)
   - planner/router observability now also emits a deterministic `step decision advisor` result for that same step (`recommended_next_action`, reason codes, confidence, based-on summary), derived only from existing readiness/outcome/recovery/artifact/task-plan state
   - the same state also feeds a deterministic `advisor alignment evaluator` v1 (`advisor_action`, `actual_action`, `is_aligned`, `alignment_type`, `divergence_reason_codes`, `promotion_candidate`, `evaluator_version`) plus `advisor_alignment_summary`; malformed/missing inputs fail closed as `alignment_type=unknown`
   - the same advisor/alignment evidence then feeds `decision-engine-promotion` v1 gate:
     - promotion policy truth is read from centralized control surface (`/Users/seanhan/Documents/Playground/src/promotion-control-surface.mjs`)
     - v1 control surface policy: `allowed_actions=ask_user|retry|reroute|fail`, `denied_actions=proceed|rollback|skip`, `ineffective_threshold=3`
     - if the action is currently flagged in `rollback_disabled_actions`, promotion stays blocked even when it appears in the allow-list
     - promoted `retry` also requires deterministic retry-only gate pass (`retry_worthiness=true`, `outcome_status!=failed`, `readiness.is_ready=true`, no invalid artifact / blocked dependency, retry budget available, and retry context not degraded by `retry-context-pack`)
     - promoted `reroute` is bounded and fail-closed:
       - `advisor.recommended_next_action=reroute`
       - `advisor_alignment.promotion_candidate=true` and `alignment_type=exact_match`
       - evidence complete
       - explicit `owner_mismatch` or `capability_gap` signal
       - no `missing_slot` ask-user-priority signal
       - no `invalid_artifact` / `blocked_dependency` conflict
       - no recovery conflict (`rollback_to_step` / `failed` / hard-fail / exhausted retry budget)
       - reroute health baseline must exist and be non-low for `ask_user|retry|fail`; otherwise fail-closed
     - planner apply stage must verify one deterministic reroute target; unverifiable/ambiguous target fails closed
     - override is applied only when all promotion prerequisites pass; otherwise the planner keeps existing routing/recovery authority and emits blocked diagnostics
   - deterministic usage-layer tightening is now applied on top of the same working-memory continuation boundary:
     - short/high-related follow-ups can stay on continuation path without opening a new task
     - candidate-selection short follow-ups (for example `第一份` / `第2個` / `這個`) can still be treated as continuation even when selected/current/next action hints are temporarily missing, as long as active task context remains
     - `waiting_user` turns with already-filled slots resume the current plan step (`working_memory_waiting_user_resume_plan_step`) instead of redundant ask
8. planner reads and tool results remain internal runtime state
9. `user-response-normalizer.mjs` converts the planner envelope into the public response shape:
   - `answer`
   - `sources`
   - `limitations`
10. `answer-source-mapper.mjs` converts canonical source objects into bounded public `sources[]` lines
11. `planner-user-input-edge.mjs` performs session-scoped working-memory v2 patch write-back only after a stable final boundary response is available
12. `executive-orchestrator.mjs` enforces truthful completion gate on final user-facing copy:
   - when `verification.pass !== true`, user-facing text is forced into blocked/escalated tone
   - fail path can only render `目前狀態 + 可驗證證據 + 待確認/限制`
   - completed-tone wording is blocked in verifier-fail/fake-completion/partial-completion paths
13. `renderPlannerUserFacingReplyText(...)` keeps fixed public order:
   - `答案 -> 來源 -> 待確認/限制`

Current truth:

- this path is implemented
- `/answer` is planner-first, not answer-service-first
- direct `/answer` remains available, but when `LARK_DIRECT_INGRESS_PRIMARY_ENABLED=false` the runtime marks it as a non-primary ingress rather than the formal plugin entry
- direct `/answer` is now locked to one planner runtime entry and does not route through `runAgentE2E(...)` from HTTP ingress
- inside `executePlannedUserInput(...)`, when caller is on the default strict planner requester path, deterministic runtime-info routing now has one fast path to `get_runtime_info` before LLM planning
- direct `/answer` now includes one synthetic probe short-circuit: when request traffic is classified as `test|replay` and query is a bounded probe token (`test|ping|health|healthcheck|smoke|probe`), runtime returns a fast ingress-ready `ok=true` answer without entering planner execution
- `runAgentE2E(...)` remains in the codebase as an internal helper, not a parallel `/answer` runtime authority
- `runAgentE2E(...)` continuation semantics are aligned with planner runtime boundaries:
  - `retry` / `continue_planner` continue the loop
  - `complete_task` terminates success
  - `ask_user` / `fallback` terminate fail-soft (no implicit continue)
  - unknown token terminates fail-closed
- `/answer` and the `knowledge-assistant` lane now share the same planner answer-edge helper instead of re-assembling `execute -> envelope -> normalize` separately
- sync ingress path now has one bounded executive-memory retrieval pre-step:
  - reads session + approved memory through `/Users/seanhan/Documents/Playground/src/executive-memory.mjs -> retrieveExecutiveDecisionMemory(...)`
  - injects memory context into planner execution via internal `decisionMemory` only; public response shape remains `answer / sources / limitations`
  - queue-authoritative accepted short-circuit path remains metadata-only and does not run sync memory retrieval in-request
- strict planner prompt assembly now consumes that retrieval payload before action selection via `executive_memory_context` and deterministic prompt markers (`executive_memory_context_hit`, `executive_memory_context_needs_context`)
- the same shared edge helper now includes a completion-authority mode skeleton at ingress:
  - `sync_authoritative`: synchronous planner is the authority path (default)
  - `queue_shadow`: enqueue additive job then keep synchronous planner as authority
  - `queue_authoritative` (skeleton, default-off): enqueue accepted short-circuits sync planner in-request and returns non-final pending response metadata
- `queue_authoritative` admission is now fail-closed on worker readiness:
  - readiness signal uses bounded latest heartbeat/lease projection (`readAutonomyWorkerReadiness`) from running-attempt + worker-heartbeat records
  - additive store helper `heartbeatAutonomyWorker` is the idle-worker heartbeat write surface; main service now wires this through `src/worker/autonomy-runtime-manager.mjs` for one process-local managed worker owner
  - worker not ready forces mode to `sync_authoritative` before enqueue
- `queue_authoritative` enqueue failure fail-soft falls back to `sync_authoritative`
- enqueue accepted is explicitly guarded as not completed; completed authority remains worker + verifier
- main service long-connection bootstrap now includes one additive managed runtime path:
  - `src/index.mjs` starts `startAutonomyRuntimeManager(...)` after service startup
  - manager owns `startAutonomyWorkerLoop(...)` plus a fixed conservative idle heartbeat timer (3s)
  - `SIGINT/SIGTERM` now stop the manager via `stopAutonomyRuntimeManager(...)`
  - manager start failure is fail-soft and does not block HTTP/Lark runtime startup
- monitoring diagnostics now expose one additive rollout guardrail snapshot (`getAutonomyRolloutGuardrailSnapshot`) that combines:
  - ingress fallback/sampling counts + rates from persisted runtime trace events
  - queue backlog counts (`queued/running/failed`) + `oldest_queued_age_ms`
  - worker readiness projection (`readiness_state`, `heartbeat_lag_ms`, `lease_remaining_ms`)
  - bounded alerts for high fallback rates, queue-age pressure, and worker-not-ready state
- autonomy worker now has one built-in execute path for `planner_user_input_v1` (`queue payload -> executePlannedUserInput -> verifier/recovery`) while preserving existing `executeJob` override behavior for custom job handlers
- that shared edge helper also absorbs current legacy planner result shapes into canonical `answer / sources / limitations` before the public boundary
- for delivery/onboarding knowledge lookups, a single-hit company-brain search now turns into an answer-first reply that names the matched SOP/checklist document and surfaces bounded location/checklist/start-step hints from the indexed snippet, while preserving the same public `answer / sources / limitations` shape
- before the public boundary returns a generic failure, the checked-in normalizer now does a minimal mixed-request decomposition for copy/image/send-style asks and returns partial success when at least one text-draft subtask is still doable
- fail-soft (`ok=false`) responses are now normalized into one usable structure before public rendering: `answer` is treated as summary, `sources` carries what-we-got lines (never empty), and the last `limitations` line is an executable CTA (`retry` / `refine query` / `provide missing params`) instead of internal diagnostics
- timeout fail-soft replies now include one explicit `limitations[]` marker `timeout_layer=planner|tool|external_dependency` so timeout evidence can be attributed to the planner stage, tool dispatch stage, or upstream dependency stage
- answer-boundary runtime objects now keep non-enumerable fail-soft metadata (`summary`, `what_we_got`, `next_step`) plus non-enumerable `failure_class_v2` (`timeout` / `upstream_error` / `partial_data` / `user_input_missing`) while preserving existing `failure_class` compatibility
- answer evidence is surfaced through canonical source mapping before public rendering
- the checked-in normalizer now reads only canonical `execution_result.data.answer / sources / limitations`
- session working-memory v2 write-back is centralized at this answer boundary (not mid-planner): only stable final outputs write patch updates; patch writes now include task/phase/status/owner/retry/slot updates, plus execution-plan persistence v1 updates (`plan_status`, `current_step_id`, `step.status`, `artifact_refs`, `slot_requirements`), plan-aware recovery policy v1 step fields (`failure_class`, `recovery_policy`, `recovery_state.last_failure_class`, `recovery_state.recovery_attempt_count`, `recovery_state.last_recovery_action`, `recovery_state.rollback_target_step_id`), and artifact/dependency graph v1 updates (`artifacts[]`, `dependency_edges[]`, `validity_status`, `supersedes_artifact_id`, `consumed_by_step_ids[]`) via patch-merge semantics together with v1-compatible fields; malformed/missing memory reads or malformed artifact graph snapshots fail closed and are treated as miss during pre-routing reuse
- the same answer-boundary patch path now also writes deterministic per-step `outcome` structures (`outcome_status`, `outcome_confidence`, `outcome_evidence`, `artifact_quality`, `retry_worthiness`, `user_visible_completeness`) via patch-merge semantics without overwriting the existing `step.status`
- answer-boundary working-memory observability write-back now also carries readiness diagnostics when present (`readiness`, `blocking_reason_codes`, `missing_slots`, `invalid_artifacts`, `blocked_dependencies`, `owner_ready`, `recovery_ready`, `recommended_action`) so read/write observability stays aligned with pre-execution gating decisions
- answer-boundary/ingress observability now also carries executive memory retrieval diagnostics (`memory_retrieval_attempted`, `memory_retrieval_needs_context`, `memory_retrieval_hit`, `memory_retrieval_session_hit_count`, `memory_retrieval_approved_hit_count`, `memory_retrieval_used`, `memory_retrieval_used_rate`, `memory_retrieval_eligible_count`, `memory_retrieval_used_count`, `memory_retrieval_rate_target_met`) so context-use adoption is measurable without widening public API fields
- answer-boundary and routing observability now also carry deterministic outcome diagnostics (`outcome_status`, `outcome_confidence`, `outcome_evidence`, `artifact_quality`, `retry_worthiness`, `user_visible_completeness`) so recovery/trace paths can answer "success level" and "worth retrying" from one rule-based source
- answer-boundary observability now also carries the same `step decision advisor` fields (`advisor.recommended_next_action`, `advisor.decision_reason_codes`, `advisor.decision_confidence`, `advisor_based_on_summary`) and deterministic advisor-alignment diagnostics (`advisor_alignment`, `advisor_alignment_summary`; compatibility mirror `advisor_vs_actual`) together with promotion-gate diagnostics (`decision_promotion`, `decision_promotion_summary`) without overwriting `step.status/outcome/recovery`
- answer-boundary/routing observability now also carries promotion control-surface diagnostics (`promotion_policy.allowed_actions`, `promotion_policy.rollback_disabled_actions`, `promotion_policy.ineffective_threshold`, `promotion_policy_summary`) so trace can explain policy-level gate blocks deterministically
- answer-boundary observability now also carries usage-layer diagnostics and summary:
  - `usage_layer.interpreted_as_continuation`
  - `usage_layer.interpreted_as_new_task`
  - `usage_layer.redundant_question_detected`
  - `usage_layer.owner_selection_feels_consistent`
  - `usage_layer.response_continuity_score`
  - `usage_layer.usage_issue_codes`
  - `usage_layer_summary`
- when the same usage-layer pass detects continuation/retry/reroute continuity gaps, `/Users/seanhan/Documents/Playground/src/planner-user-input-edge.mjs` now prepends one bounded contextual source line (for example slot-fill resume, retry resume, reroute handoff) instead of resetting reply tone as a fresh task
- planner JSON requests now attempt to prepend one optional file-backed action system prompt (`/Users/seanhan/Documents/Playground/src/prompts/action-system-prompt.txt`) before the existing planner system prompt; when the file is missing/unreadable this step fail-soft skips and keeps the prior prompt path

### Secondary Retrieval-Answer Helper

Current secondary path:

1. `answer-service.mjs` performs `searchKnowledgeBase(...)`
2. it calls `read-runtime` through the index authority
3. it either calls the text model or falls back to extractive answer construction

Current truth:

- this helper is implemented and tested
- it is not the main public `/answer` route
- text-model selection for this helper follows `/Users/seanhan/Documents/Playground/src/config.mjs`: `MINIMAX_TEXT_MODEL` is primary, legacy `LLM_MODEL` is fallback, default remains `MiniMax-M2.7`
- answer-service prompt contract explicitly constrains generated text to the stable order `答案 -> 來源 -> 待確認/限制`; when generation fails, helper falls back to extractive `answer + sources` and leaves final public shaping to the shared normalizer path
- even when planner uses a skill-backed action, the final user-facing reply still goes through the existing answer normalization path rather than exposing raw skill payload fields

### 3A. Plugin Hybrid Dispatch Path

Current path:

1. OpenClaw tool call enters `/Users/seanhan/Documents/Playground/openclaw-plugin/lark-kb/index.ts`
2. the plugin posts one normalized dispatch request to `POST /agent/lark-plugin/dispatch`, carrying one checked-in `requested_capability`
   - `knowledge_answer`
   - `scanoo_diagnose`
   - `scanoo_compare`
   - `scanoo_optimize`
   - plugin-native tool name passthrough for non-specialized tools
3. `/Users/seanhan/Documents/Playground/src/lark-plugin-dispatch-adapter.mjs` decides:
   - `knowledge_answer` directly from `requested_capability`
   - `lane_backend` from `scanoo_*` capability only after the adapter resolves an explicit capability-to-lane mapping
   - `plugin_native` for plugin-native passthrough or unknown capability
   - only when `requested_capability` is absent does it fall back to the older tool/text heuristics
4. `knowledge_answer` reuses `/Users/seanhan/Documents/Playground/src/planner-user-input-edge.mjs`
5. `lane_backend` reuses `/Users/seanhan/Documents/Playground/src/lane-executor.mjs`
6. `plugin_native` returns a forward decision and the plugin continues on the existing direct HTTP route

Current truth:

- the checked-in official plugin ingress is the hybrid dispatch route, not direct scattered route selection inside the plugin
- plugin-native document/message/calendar/task-style tools stay outside the internal planner/lane business flow
- the checked-in minimal capability map does not add planner or model-side NLP; `lark_kb_answer` uses simple tool+params rules to emit `knowledge_answer` or one of the three `scanoo_*` capabilities
- the current checked-in `scanoo_*` capability-to-lane mapping is:
  - `scanoo_compare -> scanoo-compare` with `lane_mapping_source=explicit`
  - `scanoo_diagnose -> scanoo-diagnose` with `lane_mapping_source=explicit`
  - `scanoo_optimize -> knowledge-assistant` with `lane_mapping_source=fallback`
- the dedicated `scanoo-compare` and `scanoo-diagnose` lanes are intentionally thin: adapter identity, lane trace, and execution owner are distinct, but execution still reuses the existing planner answer-edge helper
- before `scanoo-compare` enters the shared planner answer-edge helper, `lane-executor.mjs` now prepends one fixed compare brief that requires the planner input/output to stay in the checked-in heading order:
  - `【比較對象】`
  - `【比較維度】`
  - `【核心差異】`
  - `【原因假設】`
  - `【證據 / 不確定性】`
  - `【建議行動】`
- before `scanoo-diagnose` enters that same shared planner answer-edge helper, `lane-executor.mjs` now prepends one fixed diagnose brief that requires the planner input/output to stay in the checked-in heading order:
  - `【問題現象】`
  - `【可能原因】`
  - `【目前證據】`
  - `【不確定性】`
  - `【建議下一步】`
- both wrapper briefs stay lane-local and do not change planner ingress or the public response shape
- for explicit plugin capability handoff (`requested_capability=scanoo_compare|scanoo_diagnose`), `/Users/seanhan/Documents/Playground/src/lane-executor.mjs` now runs one lane-primary fast-path before planner:
  - `scanoo_compare`: force one mirror evidence search pass first
  - `scanoo_diagnose`: force one document resolve + official read attempt first
- if that explicit-capability lane-primary fast-path returns a bounded reply, runtime returns immediately and does not enter planner soft-timeout recovery
- `scanoo-diagnose` now gives official doc hydration higher priority than the old insufficient-evidence-only fallback: it first tries to resolve a doc id from the current message, bounded `plugin_context.document_refs`, or referenced upstream message; when a handoff ref carries only `title` / `name` / `query` / bounded description text, the same diagnose path now fail-soft searches mirror docs by those hints to recover a bounded `document_id`, and writes the resolved id back into the in-memory handoff refs for the rest of the turn
- when that diagnose path has a resolved doc id and explicit user auth, it forces the checked-in live official read helper `readDocumentFromRuntime(...)` unless planner already executed a document-read action
- when the same diagnose fallback still lacks an explicit user access token, it now returns a bounded diagnose reply instead of the old generic failure copy: hydrated doc refs / bounded evidence / readable auth context produce a weak-but-usable context-backed diagnose, while prompt-only cases still return an explicit-limitation diagnose with known observations, candidate causes, and verifiable next steps
- if docs search still cannot recover an id, it now returns a bounded diagnose-contract missing-document reply instead of dropping to a generic fallback
- when compare evidence still lands in an insufficient-evidence state and did not already resolve to a doc-read action, `lane-executor.mjs` fail-soft calls the checked-in mirror read helper `searchCompanyBrainDocsFromRuntime(...)` with `action=search_company_brain_docs`; compare candidates are then filtered by one lane-local relevance gate (`demo/verify/success/test/final validation/minimal/artifact/stub/sample` hard filter + required `entity identifier + comparable metric + time/data` signals), and the compare fallback contract is enforced as `>=2` valid evidence + two-sided query-metric coverage -> normal compare, `>=1` valid side with explicit opposite-side gaps -> partial compare (must include confirmed-side observation, missing dimensions, inferred difference direction, and minimal data-backfill action), `0` -> non-generic gap report that names concrete data gaps instead of weak fallback copy
- when explicit Scanoo lane-primary fast-path fails and runtime falls back to planner, the fallback path does not re-enter timeout-driven lane recovery for the same turn
- before the shared planner soft timeout can surface inside a dedicated Scanoo lane that is still on planner-backed execution, `lane-executor.mjs` arms one lane-local pre-timeout hook:
  - `scanoo_compare` stops planner early and forces at least one mirror evidence search before allowing `request_timeout`
  - `scanoo_diagnose` stops planner early and forces at least one document-resolution + live-read recovery attempt before allowing `request_timeout`
- only if `scanoo-compare` is unavailable does the adapter fall back to `knowledge-assistant`, recording `fallback_reason=missing_exact_scanoo_compare_lane_fallback_to_knowledge_assistant`
- only if `scanoo-diagnose` is unavailable does the adapter fall back to `knowledge-assistant`, recording `fallback_reason=missing_exact_scanoo_diagnose_lane_fallback_to_knowledge_assistant`
- `scanoo_optimize` still has no dedicated checked-in lane, so it remains a bounded fallback and still records a concrete `fallback_reason` instead of silently collapsing into one generic lane label
- the dispatch layer records `request_text / source / session_id / thread_id / requested_capability / capability_source / route_target / mapped_lane / lane_mapping_source / chosen_lane / chosen_skill / fallback_reason / final_status`
- when `plugin_context` is present, the lane handoff event now keeps bounded `explicit_auth`, `document_refs`, `compare_objects`, and structured `route_request.body` context so downstream lane/planner recovery can still see the same compare/doc evidence instead of flattening everything to raw text only
- `GET /answer` and plugin hybrid dispatch now also arm one early fallback abort signal ahead of the outer HTTP hard timeout; planner/lane code gets that earlier `request_timeout` first so bounded fail-soft replies can return before the final generic timeout guard fires

## 4. Adjacent Workflows

### 4A. Skill Runtime

Current path:

1. planner-adjacent caller or internal module selects a checked-in skill
2. `skill-runtime.mjs` validates input schema
3. skill executes only through declared bounded runtimes/tools
4. `skill-runtime.mjs` validates side effects and output schema
5. optional planner adaptation happens through `planner/skill-bridge.mjs`

Current truth:

- implemented as a minimal baseline
- current checked-in skill implementations are `search_and_summarize`, `document_summarize`, and `image_generate`
- `search_and_summarize` and `document_summarize` are read-only and use `read-runtime`
- `image_generate` is read-only and now fail-closes as `business_error` with `failure_class=capability_gap` when an image backend is unavailable; it no longer returns placeholder URL success output
- `search_and_summarize` uses `search_knowledge_base`
- `document_summarize` uses `get_company_brain_doc_detail`
- this does not register a new public route or planner routing target
- the checked-in skill-backed actions stay behind `planner/skill-bridge.mjs` and the answer pipeline
- `planner/action-loop.mjs`, `planner/tool-loop.mjs`, `planner/tool-loop-with-feedback.mjs`, `planner/render-execution-result.mjs`, `actions/send-message-action.mjs`, and `actions/update-doc-action.mjs` are currently adjacent helpers:
  - `runActionLoop(...)` supports minimal `send_message`, `update_doc`, and `create_task` execution with a standalone envelope
  - `runActionLoop(...)` now requires explicit write access (`allow_write_actions=true` / `allowWriteActions=true`) before executing write actions (`send_message`, `update_doc`, `create_task`, `write_memory`, `update_record`); missing explicit access fail-closes as `error = write_action_not_allowed`
  - `runActionLoop(...)` and `runToolLoop(...)` still hard-block read-only skill contexts from those same write actions and return `error = read_only_skill_cannot_execute_write_action` with `blocked = true`
  - `runToolLoop(...)` wraps `runActionLoop(...)` into an ordered `tool_loop` envelope with bounded step records (`{ step, action, result }`), follows `next_action` chaining up to `max_steps`, and carries selected-skill context into chained steps so later actions cannot bypass read-only boundaries
  - `runToolLoopWithFeedback(...)` reruns `llm(...)` with step history context (`previous_steps` + `last_result`) up to `max_steps`, returns early on normalized `answer`, and otherwise keeps bounded step records
  - `runExecutionPipeline(...)` (`/Users/seanhan/Documents/Playground/src/planner/execution-pipeline.mjs`) runs `llm(input) -> normalizePlan(raw)` and:
    - returns a direct `type="answer"` reply when normalized output already has `answer`
    - otherwise enters `runToolLoopWithFeedback({ llm, input, context, max_steps: 3 })` through a replay wrapper that reuses the already-generated `raw` output as feedback-loop step 1
    - maps feedback-loop `type="final_answer"` to `{ ok: true, type: "answer", answer, steps }`
    - otherwise uses `renderExecutionResult(...)` to produce a readable fallback `answer` and returns `{ ok: true, type: "answer", answer, steps }`
  - `sendMessageAction(...)` issues `POST /open-apis/im/v1/messages?receive_id_type=chat_id` and fails fast on missing or non-ASCII `token/chat_id` placeholders
  - `updateDocAction(...)` now enters the controlled write path through `/Users/seanhan/Documents/Playground/src/execute-lark-write.mjs` `executeLarkWrite(...)` and then reuses `/Users/seanhan/Documents/Playground/src/lark-content.mjs` `updateDocument(...)` (docx block descendant write path), accepts optional `token_type/mode`, and infers tenant token mode from `t-` token prefix when `token_type` is absent
  - `planner/skill-bridge.mjs` no longer allows direct legacy bridge actions (`planner_bridge` / `tool_loop_bridge`) to enter `runToolLoop(...)`; those actions now fail closed as `invalid_action` with `message = legacy_tool_loop_bridge_disabled`
  - planner-visible skill actions inside `planner/skill-bridge.mjs` now also run a local pre-dispatch `account_id` guarantee; resolution order is `payload -> payload.authContext -> authContext -> context -> context.authContext -> ctx -> ctx.authContext`, and missing account id fail-closes as `missing_required_account_id` before skill runtime
- failed skill-bridge executions may now emit one process-local `skill_bridge_failure` reflection payload through `/Users/seanhan/Documents/Playground/src/reflection/skill-reflection.mjs` when the host installs `globalThis.appendReflectionLog`
- that hook is additive observability only; it does not create a closed-loop executive task, does not enter the executive reflection archive, and does not change the public `answer / sources / limitations` boundary
- `document_summarize` is planner-visible on its single-document summary boundary
- `search_and_summarize` is planner-visible only on its query-bound search-plus-summarize admission boundary and otherwise fails closed back to the original routing family
- this does not bypass mutation-runtime for writes

### 4A-1. Task Layer Helper

Current path:

1. an internal caller passes raw user text to `/Users/seanhan/Documents/Playground/src/task-layer/task-classifier.mjs`
2. `classifyTask(...)` emits zero or more deterministic task tags from keyword heuristics
3. `/Users/seanhan/Documents/Playground/src/task-layer/task-dependency.mjs` normalizes those tags into the checked-in execution order
4. `/Users/seanhan/Documents/Playground/src/task-layer/task-skill-map.mjs` resolves each tag to a string skill identifier
5. `/Users/seanhan/Documents/Playground/src/task-layer/orchestrator.mjs` invokes the caller-provided `runSkill(skill, { input, task })`
6. `/Users/seanhan/Documents/Playground/src/task-layer/task-to-answer.mjs` now normalizes that task-layer result and derives the canonical user-facing `{ answer, sources, limitations }` fields for multi-task planner replies
7. the helper returns a unified object `{ ok, partial, tasks, results, summary, data, errors }`; each result row keeps `status` (`done|failed|blocked`) with `result/error`, while aggregate output stays summary-first instead of dumping raw error lists into the answer body

Current truth:

- implemented as an adjacent helper with an optional planner pre-pass
- current checked-in tags are `copywriting`, `image`, and `publish`
- current checked-in execution order is `copywriting -> image -> publish`
- current checked-in mapped identifiers are `document_summarize` and `image_generate`; `publish` is intentionally unmapped and fail-closed in the current baseline
- execution is sequential and callback-driven; task failures are recorded fail-soft and later tasks still run; there is no checked-in queue on this path
- routed task skills must exist in checked-in `skill-registry.mjs`; unregistered mappings fail-closed as `skill_not_registered`
- if a task tag exists but no mapped identifier is present, the helper records `no_skill_mapped` and still returns the same fail-soft task-layer envelope
- `executePlannedUserInput(...)` may call this helper before normal planning only when the caller explicitly supplies `runSkill`
- when that optional pre-pass detects more than one task, planner execution returns a bounded `multi_task` result through the same canonical `answer / sources / limitations` boundary, and those user-facing fields are now derived by `task-to-answer.mjs` instead of being inlined inside `executive-planner.mjs`
- on the current checked-in path, `task-to-answer.mjs` prefers exposing bounded per-task natural-language payloads for successful `copywriting` and `image` tasks inside `answer`; `publish` is rendered only when success evidence carries a registered routed skill, otherwise it fail-closes into limitations
- image-task guarding now blocks placeholder-like image URLs (`dummyimage`, `placeholder`) so they cannot be rendered as successful image generation in either task summary or answer text
- if the helper detects zero or one task, or if the optional pre-pass fails, execution falls back to the original planner path
- the checked-in public `/answer` edge does not currently supply `runSkill`, so the default public route behavior is unchanged
- `document_summarize` is backed by the checked-in skill runtime, and `image_generate` is backed by a checked-in internal-only skill runtime that fail-closes until a real image backend is wired; task-layer `publish` stays fail-closed until a checked-in registered publish skill exists

### 4B. Comment Rewrite

Current path:

1. preview ingress enters the shared preview helper from either `/api/doc/rewrite-from-comments` or comment-suggestion card/poller
2. helper reads the doc, generates the rewrite proposal, creates one confirmation artifact, and moves the same workflow task to `awaiting_review`
3. only `/api/doc/rewrite-from-comments` may apply, and it requires the matching confirmation plus the matching `awaiting_review` task
4. final apply enters the shared mutation runtime and verifier gate before completion

Current truth:

- implemented
- comment suggestion ingress no longer owns a parallel preview/apply path
- still ends in replace-based doc materialization

### 4C. Meeting Workflow

Current path:

1. meeting starts from slash command, wake phrase, or capture flow
2. capture state may create/update/delete a meeting doc through the external mutation runtime
3. summary generation produces structured meeting output
4. confirm route writes the final meeting entry back through the shared mutation runtime

Current truth:

- implemented
- structured meeting output exists
- `/meeting` is still a specialized workflow, not proof of a generic delegated subagent framework

### 4C-1. Workflow Finalize Recovery (Phase-2 Slice-3)

Current path (verifier-fail branch only):

1. `executive-closed-loop.mjs` verifier gate returns `verification.pass=false` in workflow finalize.
2. `executive-orchestrator.mjs` finalize fail branch builds recovery inputs from existing task/meta/structured result/verification signals.
3. `recovery_decision_v1` (`/Users/seanhan/Documents/Playground/src/recovery-decision.mjs`) resolves the next bounded recovery route.
4. orchestrator applies lifecycle/status/routing updates from that decision without changing public response shape.

Input signals (existing only):

- `error`
- `failure_class`
- `retryable`
- `retry_count`
- `max_retries`
- `workflow`
- `verification`
- `recovery_candidates` (optional candidate list for route/tool/prompt variants)
- `candidate_selection` (optional selected candidate id for deterministic scoring result)

Decision outputs (existing only):

- `next_state`
- `next_status`
- `routing_hint`
- `reason`
- `recovery_mode`
- `decision_basis` (`why_search`, `why_retry`, `candidate_count`, selected candidate metadata)
- `candidate_selection` (only when search candidate is selected)

Wiring points (orchestrator finalize fail branches):

- `finalizeMeetingWorkflowTaskUnlocked(...)`
- `finalizeDocRewriteWorkflowTaskUnlocked(...)`
- `finalizeDocumentReviewWorkflowTaskUnlocked(...)`
- `finalizeCloudDocWorkflowTaskUnlocked(...)`

Minimal split:

- `search candidate`: when `recovery_candidates` exists and scoring selects one candidate -> `next_state=executing` with `routing_hint=<workflow>_search_candidate`
- `retry/resume`: only when no candidate is available and retry budget is still available -> `next_state=executing` (`workflow_state=retrying`, resume same task)
- `escalated`: `failure_class in {effect_committed, commit_unknown, permission_denied}` or `retryable=false`
- `waiting_user`: `missing_slot` -> blocked lifecycle + waiting-user workflow routing
- fail-soft `blocked/failed`: remaining non-safe continuation paths when retry budget or verification state does not allow safe resume

Boundary:

- no public contract / response-shape change
- not a full escalation subsystem
- no automatic retry for `effect_committed` / `commit_unknown`
- no planner/router contract change

### 4D. Personal DM Skill Tasks

Current path:

1. inbound `im.message.receive_v1` event enters `/Users/seanhan/Documents/Playground/src/index.mjs`
2. `/Users/seanhan/Documents/Playground/src/binding-runtime.mjs` resolves the chat as direct-message scope
3. `/Users/seanhan/Documents/Playground/src/lane-executor.mjs` keeps the request in `personal-assistant`
4. only when the personal lane would otherwise fall to `general_assistant_action`, the checked-in helper now runs `/Users/seanhan/Documents/Playground/src/planner/personal-dm-skill-intent.mjs`
5. the MiniMax text path classifies the DM into exactly one of:
   - `skill_find_request`
   - `skill_install_request`
   - `skill_verify_request`
   - `not_skill_task`
6. only the three explicit skill intents may continue into `/Users/seanhan/Documents/Playground/src/local-skill-actions.mjs`
7. the bounded skill action checks controlled local catalogs first, and for find/install may also call the checked-in `skill-installer` helper scripts under `$CODEX_HOME/skills/.system/skill-installer`
8. the bounded action returns canonical `answer / sources / limitations`
9. `/Users/seanhan/Documents/Playground/src/user-response-normalizer.mjs` renders the final text reply
10. `/Users/seanhan/Documents/Playground/src/runtime-message-reply.mjs` sends the reply through the existing guarded Lark mutation path

Current truth:

- implemented only for personal DM / direct-message scope
- this does not widen the existing planner-visible read-only skill bridge in `/Users/seanhan/Documents/Playground/src/planner/skill-bridge.mjs`
- current bounded actions are:
  - `find_local_skill`
  - `install_local_skill`
  - `verify_local_skill`
- skill actions are fail-closed and source-bounded:
  - local discovery reads only from `~/.codex/skills` and `~/.agents/skills`
  - remote find/install is limited to the checked-in curated catalog helper scripts under `$CODEX_HOME/skills/.system/skill-installer`
  - remote install is limited to `openai/skills` `skills/.curated`
  - install writes only to `~/.codex/skills`
  - no arbitrary command surface, no arbitrary path writes, no package-manager install path
- `not_skill_task` keeps the old personal-lane behavior unchanged; it does not bypass the existing fallback / tenant-token / meeting / cloud-doc precedence
- `find-skills` remains an agent skill/spec in the Codex environment; this runtime path does not directly execute that skill as a generic task owner
- this minimal version covers controlled skill find / install / verify and should not be described as a generic write-capable planner execution surface

### 4E. Sync

Current path:

1. `/sync/full` or `/sync/incremental`
2. connectors scan Drive and Wiki
3. doc text is extracted and chunked
4. repository writes documents, chunks, FTS rows, and sync summaries

Current truth:

- implemented
- sync feeds the retrieval index and mirror-adjacent data, but it is not the same thing as approved company-brain knowledge

## 5. Policy-Only or Incomplete Areas

- no single universal planner ingress for every lane/workflow in the repo; the checked-in shared ingress contract only covers current planner doc/knowledge/runtime reads plus the shared `/answer` and `knowledge-assistant` edge surfaces
- no full generic repo-wide read abstraction; the audited company-brain/review/verification/system-knowledge helpers now re-enter `read-runtime.mjs`, but other repository-local reads still exist outside one universal surface
- no full targeted doc block mutation runtime
- no background worker mesh or autonomous company-brain server
