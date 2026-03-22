# Modules

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Module Inventory

This inventory reflects the current fail-closed baseline for routing, planner, lane executor, and runtime surfaces.

Planner machine-readable contract: [planner_contract.json](/Users/seanhan/Documents/Playground/docs/system/planner_contract.json)

System interface layer: [interface_spec.md](/Users/seanhan/Documents/Playground/docs/system/interface_spec.md)

Agent layer: [agent_spec.md](/Users/seanhan/Documents/Playground/docs/system/agent_spec.md)

Meeting-agent spec: [meeting_agent_spec.md](/Users/seanhan/Documents/Playground/docs/system/meeting_agent_spec.md)

Meeting-agent trial-run report spec: [meeting_agent_trial_run_report_spec.md](/Users/seanhan/Documents/Playground/docs/system/meeting_agent_trial_run_report_spec.md)

Meeting recording / transcription alignment: [meeting_recording_transcription_alignment.md](/Users/seanhan/Documents/Playground/docs/system/meeting_recording_transcription_alignment.md)

Meeting recording / transcription runtime refactor plan: [meeting_recording_transcription_refactor_plan.md](/Users/seanhan/Documents/Playground/docs/system/meeting_recording_transcription_refactor_plan.md)

Planner-agent alignment: [planner_agent_alignment.md](/Users/seanhan/Documents/Playground/docs/system/planner_agent_alignment.md)

Company-brain-agent alignment: [company_brain_agent_alignment.md](/Users/seanhan/Documents/Playground/docs/system/company_brain_agent_alignment.md)

Company-brain runtime refactor plan: [company_brain_agent_refactor_plan.md](/Users/seanhan/Documents/Playground/docs/system/company_brain_agent_refactor_plan.md)

Company-brain write / intake layer: [company_brain_write_intake_spec.md](/Users/seanhan/Documents/Playground/docs/system/company_brain_write_intake_spec.md)

Company-brain write / intake alignment: [company_brain_write_intake_alignment.md](/Users/seanhan/Documents/Playground/docs/system/company_brain_write_intake_alignment.md)

Company-brain write / intake runtime refactor plan: [company_brain_write_intake_refactor_plan.md](/Users/seanhan/Documents/Playground/docs/system/company_brain_write_intake_refactor_plan.md)

Company-brain review / conflict / approval layer: [company_brain_review_conflict_approval_spec.md](/Users/seanhan/Documents/Playground/docs/system/company_brain_review_conflict_approval_spec.md)

Company-brain review / conflict / approval alignment: [company_brain_review_conflict_approval_alignment.md](/Users/seanhan/Documents/Playground/docs/system/company_brain_review_conflict_approval_alignment.md)

Company-brain review / conflict / approval runtime refactor plan: [company_brain_review_conflict_approval_refactor_plan.md](/Users/seanhan/Documents/Playground/docs/system/company_brain_review_conflict_approval_refactor_plan.md)

Planner runtime refactor plan: [planner_agent_refactor_plan.md](/Users/seanhan/Documents/Playground/docs/system/planner_agent_refactor_plan.md)

Routing / handoff layer: [routing_handoff_spec.md](/Users/seanhan/Documents/Playground/docs/system/routing_handoff_spec.md)

Routing eval baseline: [routing_eval_system.md](/Users/seanhan/Documents/Playground/docs/system/routing_eval_system.md)

Routing eval closed-loop runbook: [routing_eval_closed_loop_runbook.md](/Users/seanhan/Documents/Playground/docs/system/routing_eval_closed_loop_runbook.md)

Skill layer: [skill_spec.md](/Users/seanhan/Documents/Playground/docs/system/skill_spec.md)

Trace / log layer: [trace_log_spec.md](/Users/seanhan/Documents/Playground/docs/system/trace_log_spec.md)

System status / next phase: [system_status_next_phase.md](/Users/seanhan/Documents/Playground/docs/system/system_status_next_phase.md)

### 1. Runtime Entrypoints

- Location:
  - `/Users/seanhan/Documents/Playground/src/index.mjs`
  - `/Users/seanhan/Documents/Playground/src/http-only.mjs`
  - `/Users/seanhan/Documents/Playground/src/runtime-conflict-guard.mjs`
  - `/Users/seanhan/Documents/Playground/src/runtime-message-deduper.mjs`
  - `/Users/seanhan/Documents/Playground/src/runtime-observability.mjs`
  - `/Users/seanhan/Documents/Playground/scripts/monitoring-cli.mjs`
  - `/Users/seanhan/Documents/Playground/scripts/debug-trace.mjs`
- Responsibility:
  - start long-connection listener and/or HTTP server
  - disable known competing local LaunchAgents before starting the Playground long-connection listener
  - suppress duplicate Lark event re-deliveries by `message_id` before lane execution
  - emit structured runtime logs for long-connection event intake, lane routing, tool/doc/group steps, reply send, and failure paths
  - shared runtime/tool/alert logs now emit one JSON object per line with canonical `trace_id`, `action`, `status`, `event_type`, and `timestamp` fields for downstream analysis
  - emit immediate console alerts for `oauth_reauth_required`, `planner_failed`, and request-timeout failures through a shared in-memory rate-limited helper
  - attach a per-event and per-request `trace_id` so chain breaks can be located from logs
  - persist trace-scoped runtime events into SQLite so one `trace_id` can reconstruct request input, planner decision `why`, lane/action, and final result/error
  - preserve incoming `X-Request-Id` or mint a local `request_id` for HTTP request-log correlation, and echo it back in the response header
  - echo `X-Trace-Id` for every HTTP response, including HTML and redirects
  - provide a local CLI for reading persisted request-monitor data
  - provide a local CLI dashboard for request health overview
  - provide a local CLI for reconstructing one persisted trace timeline by `trace_id`
- Main entry:
  - `startHttpServer()`
  - `enforceSingleLarkResponderRuntime()`
  - `createMessageEventDeduper()`
- Depends on:
  - `config.mjs`
  - `http-server.mjs`
- Core path:
  - yes

### 1A. Binding / Session Runtime

- Location:
  - `/Users/seanhan/Documents/Playground/src/binding-runtime.mjs`
  - `/Users/seanhan/Documents/Playground/src/session-scope-store.mjs`
- Responsibility:
  - resolve Lark peer identity into binding/session/workspace/sandbox keys
  - persist latest peer-scoped session touches
  - provide capability-lane routing keys for downstream execution
- Main entry:
  - `resolveLarkBindingRuntime()`
  - `touchResolvedSession()`
- Depends on:
  - `config.mjs`
  - `token-store.mjs`
- Core path:
  - yes for future Lark assistant expansion

### 2. HTTP API Layer

- Location:
  - `/Users/seanhan/Documents/Playground/src/http-server.mjs`
  - `/Users/seanhan/Documents/Playground/src/http-route-contracts.mjs`
  - `/Users/seanhan/Documents/Playground/src/http-idempotency-store.mjs`
  - `/Users/seanhan/Documents/Playground/src/monitoring-store.mjs`
- Responsibility:
  - route parsing
  - route method contract
  - auth checks
  - HTTP endpoint handling
  - response shaping
  - optional request-body idempotency for JSON `POST` / `PUT` / `PATCH` routes via `idempotency_key`
  - replay the first persisted JSON result for repeated keyed requests instead of re-running the handler
  - persist first-response idempotency rows into SQLite `http_request_idempotency`
  - per-request trace creation and request lifecycle logging
  - per-request timeout/cancel context with one shared `AbortSignal`
  - shared request/route runtime logs now guarantee `trace_id`, `action`, and `status` in the emitted structured payload, while preserving the existing `event` field as a compatibility alias
  - `trace_id` injection into JSON responses for easier cross-log correlation
  - `X-Trace-Id` response-header echo for every request
  - response-finish persistence into SQLite `http_request_monitor`
  - read-only monitoring routes for recent requests, recent errors, latest error, and aggregate request metrics
  - serve a simple local `/monitoring` HTML dashboard with success/error rates plus recent error/request tables
  - key route child-log coverage for `auth_status`, `doc_create`, `doc_update`, `meeting_process`, `meeting_confirm`, `messages_list`, `message_reply`, `knowledge_search`, `knowledge_answer`, `drive_*`, `wiki_*`, `bitable_*`, `calendar_*`, and `tasks_*`
  - `/api/doc/update` now also accepts minimal heading-targeted insert input (`target_heading`, optional `target_position`), resolves the target section against the current markdown content during preview, and then reuses the existing replace preview/apply safety gate instead of changing the underlying Lark block-write adapter
  - the same route still accepts shared doc URLs for preview-time resolution, but the real write step now requires explicit `document_id` plus `section_heading`; missing either fails soft with structured `missing_explicit_write_target` instead of depending on resolver state
  - doc-targeted HTTP routes now accept either explicit `document_id` / `doc_token` fields or a shared doc URL (`document_url` / `document_link` / `doc_link`), and the rewrite route can also recover a nested `target_document.url` payload before failing with `missing_document_id`
  - `GET /api/system/runtime-info` exposes the live HTTP process runtime facts (`db_path`, `node_pid`, `cwd`, `service_start_time`) from the same DB/config initialization path the server uses, and logs under `stage=runtime_info`
  - high-risk handler step logs now cover drive/wiki organize, bitable records, calendar event create/freebusy, and task get/create/comments
  - `/api/doc/create` now splits create from post-create permission grant, skips the grant when the current user is already the owner, and still returns `ok: true` if docx creation succeeded even when a later permission upgrade is rejected by the platform
  - `/api/doc/create` also writes normalized API-created document metadata (`doc_id`, `source`, `created_at`, `creator.account_id`, `creator.open_id`, `title`, `folder_token`) into the existing retrieval index (`lark_sources` / `lark_documents`) as a non-blocking `document_index` step
  - `/api/doc/create` now also advances a minimal document lifecycle in `lark_documents` with `status`, `indexed_at`, `verified_at`, and `failure_reason`, logging each transition under `stage=document_lifecycle_update`
  - `/api/doc/lifecycle` can query lifecycle rows by `status`, and `/api/doc/lifecycle/retry` can re-run only the `index_failed` / `verify_failed` portion of the lifecycle without re-running document creation
  - `/api/doc/lifecycle/summary` returns lifecycle status counts and logs the aggregation under `stage=document_lifecycle_summary`
  - when `/api/doc/create` or `/api/doc/lifecycle/retry` drives a document into `verified`, the route now also attempts a non-blocking mirror write into `company_brain_docs`, logging `stage=company_brain_ingest` without affecting lifecycle success/failure
  - `GET /api/company-brain/docs` now exposes a minimal read-only list view over `company_brain_docs`, with `limit` support and `stage=company_brain_list` logging
  - `GET /api/company-brain/docs/:doc_id` now exposes a minimal read-only detail view over `company_brain_docs`, returning the same `{ doc_id, title, source, created_at, creator }` shape and logging `stage=company_brain_detail`
  - `GET /api/company-brain/search?q=...` now exposes a minimal read-only search view over `company_brain_docs`, matching against `title` and `doc_id`, reusing the same item schema, and logging `stage=company_brain_search`
  - `src/company-brain-query.mjs` now centralizes planner-facing company-brain list/search/detail actions, joins `company_brain_docs` with mirrored `lark_documents.raw_text` plus optional `company_brain_learning_state`, ranks search results with a composite score over keyword match, semantic-lite similarity, learned `key_concepts` / `tags`, and mirror recency, supports `top_k` with default `5` (`limit` remains a compatibility alias), and emits unified `{ success, data, error }` payloads that keep only structured summaries plus `learning_state`
  - `src/company-brain-learning.mjs` now provides a bounded learning sidecar for verified company-brain docs: `ingestLearningDocAction(...)` derives deterministic `structured_summary`, `key_concepts`, and `tags`; `updateLearningStateAction(...)` updates simplified per-doc learning state; both write into SQLite `company_brain_learning_state` and do not claim approval-governed memory admission
  - `GET /answer` no longer calls `answer-service.mjs` directly; it now first requires a strict planner decision shaped as either legacy single-step `{ action, params }` or bounded multi-step `{ steps: [{ action, params }] }`, rejects wrapped/non-JSON planner output with `{ error: "planner_failed" }`, rejects contract-external actions with structured `INVALID_ACTION`, and returns a structured planner envelope instead of free-text fallback
  - that same strict planner path now also attaches deterministic explanation metadata to each normalized decision and envelope: `why` plus a simplified `alternative`, while `trace.reasoning` exposes the same pair for downstream lane/debug consumption without relaxing the core planner JSON contract
  - the same HTTP request path now also enforces `HTTP_REQUEST_TIMEOUT_MS` as a per-request timeout budget; timeout emits `event=request_timeout`, returns `504 { ok: false, error: "request_timeout" }`, records that error into `http_request_monitor`, and raises a rate-limited alert keyed by route/path
  - `/agent/docs/create`, `/agent/company-brain/docs`, `/agent/company-brain/search`, `/agent/company-brain/docs/:doc_id`, `/agent/company-brain/learning/ingest`, `/agent/company-brain/learning/state`, and `/agent/system/runtime-info` now provide thin agent-facing bridges over the corresponding document/runtime/query routes, normalizing output into `{ ok, action, data, trace_id }`; the learning routes additionally log `stage=company_brain_learning`
  - `executive-planner.mjs` now enforces a minimal fail-soft contract check around planner action dispatch using [planner_contract.json](/Users/seanhan/Documents/Playground/docs/system/planner_contract.json); invalid required fields or simple `string/object/number` type mismatches return `ok=false` with `error=contract_violation` instead of throwing
  - `executive-planner.mjs` now also enforces a minimal fail-soft final-output contract check for successful planner presets using [planner_contract.json](/Users/seanhan/Documents/Playground/docs/system/planner_contract.json); preset-level violations return `ok=false` with `error=contract_violation`, but step-level preset validation is still intentionally out of scope
  - `executive-planner.mjs` now also normalizes planner runtime failures into a small shared error taxonomy while preserving any pre-existing `error` field from routes/tools; current planner-generated fallbacks mainly use `tool_error`, `runtime_exception`, `business_error`, plus abort-boundary `request_timeout` / `request_cancelled`
  - the same planner/runtime path now also accepts a shared abort signal from the HTTP request boundary; `planUserInputAction(...)`, `requestPlannerJson(...)`, `dispatchPlannerTool(...)`, `runPlannerMultiStep(...)`, `runPlannerPreset(...)`, and `executePlannedUserInput(...)` all stop fail-soft on `request_timeout` / `request_cancelled` instead of retrying past the abort boundary
  - `executive-planner.mjs` now also applies a minimal one-retry policy for dispatch-time `tool_error` / `runtime_exception` cases, preserving a sticky `trace_id` across retry attempts and returning `data.retry_count` in the final action result
  - `executive-planner.mjs` now also attempts one minimal self-healing pass for input-side planner `contract_violation` cases before dispatch, limited to filling missing required fields and basic `String()` / `Number()` coercion, and marks successful healed requests with `data.healed=true`
  - `executive-planner.mjs` now also enforces a small fixed execution policy/fail boundary: `contract_violation` can self-heal once then stops, `tool_error` / `runtime_exception` retry once then stop, `business_error` stops immediately, and final controlled failures are normalized into a shared stopped shape under `data.stopped` / `data.stop_reason` while keeping existing `stopped` / `stopped_at_step` fields intact
  - `executive-planner.mjs` now also emits a minimal planner trace runtime on top of the internal trace helpers, covering `action_dispatch`, `action_result`, `preset_start`, `preset_result`, `self_heal_attempt`, `retry_attempt`, and `stopped`; this currently lands through the planner module logger path and does not yet replace the broader system logging model
  - executive planning decisions in that same module now also normalize `why` and simplified `alternative` fields, log `executive_decision` / `executive_decision_fallback` trace events with `reasoning`, and let `executive-orchestrator.mjs` persist the latest explainability snapshot in task meta (`last_reason`, `last_why`, `last_alternative`)
  - the same planner path now also emits an immediate console alert for `planner_failed`; the shared runtime helper keeps that alert rate-limited in-memory so repeated invalid JSON failures do not flood logs
  - `src/planner-flow-runtime.mjs` now defines the minimum reusable planner flow interface and registry/runtime helpers, covering: `route`, `shapePayload`, `readContext`, `writeContext`, `formatResult`, and planner-flow-level context reset/lookup; this lets `executive-planner.mjs` attach multiple internal flows without changing its public planner contract
  - the same planner flow runtime now also resolves competing flow matches dynamically: flow metadata can carry `priority` and `matchKeywords`, and route selection compares `priority` first, then keyword-hit count, before falling back to declaration order
  - `src/planner-conversation-memory.mjs` now provides a minimal planner conversation summary layer backed by a small JSON file store: it keeps `latest_summary`, bounded `recent_messages`, and `last_compacted_at`, auto-loads persisted memory when planner runtime starts, writes back after compact/record updates, and exposes manual/auto compact helpers so planner prompt assembly can prefer `latest_summary + recent_messages + current query` instead of replaying long history; the compacted summary now also preserves `active_theme`
  - `planExecutiveTurn()` in `src/executive-planner.mjs` now also injects a bounded `planner_task_context` section into planner prompt assembly by reading the latest relevant snapshot from `src/planner-task-lifecycle-v1.mjs`; that summary carries deterministic `unfinished_hint`, `blocked_hint`, `in_progress_hint`, and `focus_hint` fields so agent-selection decisions can reference unfinished work, proactively surface blocked risk, reuse in-progress summaries, and prefer the most relevant current task instead of flattening the whole snapshot, without changing the public decision JSON contract or adding DB coupling
  - the same planner prompt path now applies a local context-window policy before XML packing: it explicitly prioritizes `focused_task`, `recent_steps`, and `high_weight_doc_summaries`, then fits compact `latest_summary`, `active_task`, and `recent_dialogue` into a bounded planner budget; lower-priority overflow is summarized into `older_context` or dropped, so long active-task payloads and old dialogue no longer crowd out focused task hints
  - `src/planner-doc-query-flow.mjs` now holds the reusable planner-side document query pipeline for company-brain reads: hard pre-route integration, `active_doc` / `active_candidates` / `active_theme` context, doc-query payload shaping, ambiguity-aware result formatting, doc-query context sync after successful search/detail flows, and minimal internal debug tracing for route/result observability; detail-like formatted outputs can now also carry `learning_status`, `learning_concepts`, and `learning_tags` when available; `executive-planner.mjs` stays the public planner entrypoint and only wires this flow in, and now lazily restores doc-query context from `latest_summary` when runtime context is empty
  - `src/planner-runtime-info-flow.mjs` now holds the reusable planner-side runtime-info flow: runtime intent hard-route detection for `get_runtime_info`, no-op flow-local context hooks, runtime-info result formatting, and minimal internal debug tracing so multiple planner flows can coexist without embedding special-case logic back into `executive-planner.mjs`
  - `src/planner-okr-flow.mjs` now holds the reusable planner-side OKR flow: it detects OKR/topic-style knowledge queries, shapes them into the existing company-brain document query actions, and reuses the doc-query pipeline's context, ambiguity handling, and formatter instead of duplicating that logic in `executive-planner.mjs`
  - `src/planner-bd-flow.mjs` now holds the reusable planner-side BD flow: it detects BD / 商機 / 客戶 / 跟進 / demo / 提案 style knowledge queries, routes `整理|進度|跟進|分析` requests into `search_and_detail_doc`, otherwise uses `search_company_brain_docs`, and reuses the same doc-query pipeline/context instead of duplicating BD-specific read logic in `executive-planner.mjs`
  - `src/planner-delivery-flow.mjs` now holds the reusable planner-side delivery flow: it detects delivery/onboarding/SOP knowledge queries, routes them into the existing company-brain document query actions, and reuses the doc-query pipeline's context, ambiguity handling, and formatter instead of duplicating that logic in `executive-planner.mjs`
  - `src/planner-action-layer.mjs` now adds a reusable themed action formatter for OKR / BD / delivery flows: after the existing doc-query formatter runs, it enriches `formatted_output` with a stable `action_layer` block (`summary`, `next_actions`, `owner`, `deadline`, `risks`, optional `status`) without changing raw tool results or planner public result shape; v2 now also performs a minimal deterministic field extraction from `detail` / `search_and_detail` content summaries, leaving missing values as `null`
  - `src/planner-task-lifecycle-v1.mjs` now mirrors `formatted_output.action_layer.next_actions` into a minimal planner-side lifecycle store backed by `.data/planner-task-lifecycle-v1.json`: each derived task keeps its derivation lifecycle (`created -> clarified -> planned`), a separate operational task state (`planned -> in_progress -> blocked -> done`), source metadata (`theme`, `selected_action`, `doc_id`, `trace_id`, extracted owner/deadline/risks/status`, `source_title`, `source_summary`), and a scope snapshot of the latest active task ids plus `last_active_task_id`; the same store now also carries a small `execution v1` layer for ongoing progress tracking (`progress_status`, `progress_summary`, `note`, `result`, `execution_started_at`, `last_progress_at`, `completed_at`, bounded `execution_history`) without adding DB or scheduler dependencies; follow-up task-oriented queries (`進度 / 誰負責 / 何時到期 / 這個卡住了 / 這個完成了 / 完成一半 / 已處理 / 結果 / 備註`) now read or update that local store before any doc follow-up dispatch, can single-target one task by `第一個 / 第二個 / 第N個`, `這個`, or unique `owner`, and when the target resolves to exactly one task they return single-task read summaries for `owner / deadline / status / result / note`; planner decision-side reads now resolve task context by `active_doc`, mentioned `source_title`, mentioned task title, `active_theme`, then latest scope, and task driving prefers that focused task for next-step suggestions; ambiguous target attempts return candidate task rows without mutating state, while the public planner output remains unchanged
  - success-path HTTP smoke fixtures now cover both preview/read and apply/write routes for drive/wiki/bitable/calendar/tasks
  - self-check now validates both read/preview and write/apply route presence for those same high-risk HTTP families
- Main entry:
  - `startHttpServer()`
- Depends on:
  - OAuth, content, sync, answer, security bridge, and monitoring modules
- Core path:
  - yes
- Coupling note:
  - still high, but route method contracts now live outside the server file
  - comment suggestion cards and preview-confirm doc writes are also coordinated here

### 2A. Request Monitoring

- Location:
  - `/Users/seanhan/Documents/Playground/src/monitoring-store.mjs`
  - `/Users/seanhan/Documents/Playground/src/agent-learning-loop.mjs`
  - `/Users/seanhan/Documents/Playground/scripts/monitoring-cli.mjs`
  - `/Users/seanhan/Documents/Playground/scripts/debug-trace.mjs`
- Responsibility:
  - persist one compact row per HTTP request into SQLite `http_request_monitor`
  - persist trace-correlated runtime events into SQLite `http_request_trace_events`
  - normalize request outcome fields (`status_code`, `ok`, `error_code`, `error_message`, `duration_ms`)
  - persist timeout/cancel outcomes as normal request-monitor rows so operators can query `request_timeout` / `request_cancelled` the same way as other failures
  - expose recent-request, recent-error, latest-error, success/error-rate, dashboard-snapshot, and per-trace reconstruction queries
  - derive monitoring-backed learning summaries over recent requests/traces, including routing failure-rate hotspots, per-tool success-rate/latency summaries, and human-reviewable improvement drafts
  - learning summaries now rank equal-score routing/tool buckets by latest sampled request recency so top-N output does not let older buckets squeeze out fresher regression samples
  - the same learning summary path now keeps `generated_at` and proposal ids deterministic for a fixed sampled request set, so CLI/test regression output is reproducible
  - persist generated learning-loop proposals into the existing executive improvement workflow as `pending_approval` items rather than auto-applying them
  - provide local CLIs so operators can inspect request health, view one compact dashboard, and reconstruct one request timeline without scraping logs
  - `scripts/monitoring-cli.mjs` now also exposes a `learning` command for the same review-first summary surface
- Core path:
  - yes for runtime observability

### 2B. Routing Eval Regression Gate Baseline (v2)

- Location:
  - `/Users/seanhan/Documents/Playground/src/routing-eval.mjs`
  - `/Users/seanhan/Documents/Playground/src/routing-diagnostics-history.mjs`
  - `/Users/seanhan/Documents/Playground/src/routing-eval-fixture-candidates.mjs`
  - `/Users/seanhan/Documents/Playground/evals/routing-eval-set.mjs`
  - `/Users/seanhan/Documents/Playground/scripts/routing-eval.mjs`
  - `/Users/seanhan/Documents/Playground/scripts/routing-eval-fixture-candidates.mjs`
  - `/Users/seanhan/Documents/Playground/scripts/routing-eval-closed-loop.mjs`
  - `/Users/seanhan/Documents/Playground/tests/routing-eval.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/routing-eval-fixture-candidates.test.mjs`
- Responsibility:
  - provide a deterministic routing baseline for checked-in heuristic routing behavior
  - define the checked-in regression gate baseline v2 for routing eval
  - normalize route outcomes into `lane`, `planner_action`, and `agent_or_tool`
  - replay 50~100 checked-in fixtures without calling live LLM / network dependencies
  - report overall accuracy, per-dimension accuracy, hard-routing `error_breakdown`, latency summary, and `top_miss_cases` (up to 10 errors)
  - support `--json` output for machine-readable regression consumption
  - archive every standalone / closed-loop diagnostics run into `.tmp/routing-diagnostics-history` with a minimal manifest (`run_id`, `timestamp`, `accuracy_ratio`, `error_breakdown`, `trend_report_summary`)
  - resolve compare targets from archived snapshot ids/paths and existing git baseline/checkpoint tags without changing routing logic or tags
  - convert `top_miss_cases` plus `error_breakdown` into candidate fixture input for dataset review without changing routing logic
  - provide one closed-loop operator entrypoint for `eval -> candidates -> review -> dataset -> eval`, with session artifacts and rerun support
  - return non-zero exit status when overall accuracy ratio drops below `0.9` so the baseline can act as a regression gate
- Depends on:
  - `capability-lane.mjs`
  - `lane-executor.mjs`
  - `meeting-agent.mjs`
  - `cloud-doc-organization-workflow.mjs`
  - `agent-registry.mjs`
  - `planner-flow-runtime.mjs`
  - planner flow modules
- Core path:
  - no for production request handling
  - yes for routing regression protection

### 3. OAuth and User Context

- Location:
  - `/Users/seanhan/Documents/Playground/src/lark-user-auth.mjs`
  - `/Users/seanhan/Documents/Playground/src/token-store.mjs`
- Responsibility:
  - build login URL
  - exchange code
  - persist `access_token` / `refresh_token` / `expires_at` into SQLite-backed account state
  - refresh expired user tokens through the stored `refresh_token`
  - expose token-state resolution (`valid` / `missing` / `reauth_required`) for HTTP and request-layer fail-soft handling
- Core path:
  - yes

### 3A. Comment Preview and Watch State

- Location:
  - `/Users/seanhan/Documents/Playground/src/doc-preview-cards.mjs`
  - `/Users/seanhan/Documents/Playground/src/doc-update-confirmations.mjs`
  - `/Users/seanhan/Documents/Playground/src/comment-watch-store.mjs`
- Responsibility:
  - build human-readable replace/rewrite preview cards
  - persist confirmation artifacts for two-step apply
  - persist `/meeting` preview-confirm artifacts before document write
  - track unseen document comments for suggestion-card workflows
  - run reusable suggestion-card generation flow
  - support watched-document polling
- Core path:
  - yes for safe doc editing

### 3B. Document Targeting

- Location:
  - `/Users/seanhan/Documents/Playground/src/doc-targeting.mjs`
- Responsibility:
  - parse markdown heading structure from the current Lark raw-content snapshot
  - resolve a unique target heading section
  - support minimal insert positions for targeted writes (`end_of_section`, `after_heading`)
  - fail soft on missing or ambiguous heading matches instead of silently writing to the wrong section
- Core path:
  - yes for minimal targeted doc editing

### 4. Lark Content Service

- Location:
  - `/Users/seanhan/Documents/Playground/src/lark-content.mjs`
- Responsibility:
  - direct Lark SDK calls for drive, wiki, doc, comments, messages, reactions, calendar, freebusy, tasks, bitable, and sheets
  - resolve a valid user token from account-scoped auth context before each Lark API call
  - auto-refresh expired user tokens in the adapter path instead of requiring handlers to inject fresh `access_token` strings manually
  - grant the initiating Lark user `full_access` on Lobster-created docx files
  - repair reused Lobster meeting docs so the initiator keeps management access instead of read-only access
  - docx create adapter now emits structured platform diagnostics (`stage/http_status/platform_code/platform_msg/log_id/token_type/title/folder_token/raw`) instead of collapsing all failures into a plain 400 message
  - docx create now probes root-vs-folder capability through the adapter path and falls back to root create when folder-scoped create is blocked by platform code `1063003`
  - expose a test-only client dispose hook so integration suites can tear down any SDK transport agents without changing production defaults
- Core path:
  - yes

### 5. Lark Tree Scanning Connectors

- Location:
  - `/Users/seanhan/Documents/Playground/src/lark-connectors.mjs`
- Responsibility:
  - recursive drive and wiki scan
  - doc text extraction
  - account-scoped token resolution and per-call refresh before sync-side Lark reads
- Core path:
  - yes for sync

### 6. Sync and Indexing

- Location:
  - `/Users/seanhan/Documents/Playground/src/lark-sync-service.mjs`
  - `/Users/seanhan/Documents/Playground/src/chunking.mjs`
- Responsibility:
  - scan authorized content
  - normalize content
  - write documents and chunks
- Core path:
  - yes

### 7. Storage and Repository

- Location:
  - `/Users/seanhan/Documents/Playground/src/db.mjs`
  - `/Users/seanhan/Documents/Playground/src/rag-repository.mjs`
- Responsibility:
  - schema
  - persistence
  - FTS indexing
  - sync job recording
  - request-monitor storage through `http_request_monitor`
  - `db.mjs` now keeps the SQLite singleton reopenable and exposes a test-only close hook so integration suites can exit cleanly without mutating production behavior
- Core path:
  - yes

### 8. Search and Answer

- Location:
  - `/Users/seanhan/Documents/Playground/src/answer-service.mjs`
- Responsibility:
  - FTS retrieval
  - retrieval-summary fallback only when text generation fails
  - optional LLM answer
  - text-model selection now resolves from `MINIMAX_TEXT_MODEL` first, then falls back to legacy `LLM_MODEL`, with current default `MiniMax-M2.7`
  - XML-governed prompt assembly with anti-hallucination and user-intent self-check rules
  - prompt-budget governance and workflow-checkpoint-aware knowledge answers
  - shared low-variance generation parameters (`temperature=0.1`, clamped `top_p=0.7~0.8`)
  - direct user-input routes no longer call this module as their first responder; `/answer` and the knowledge-assistant lane are now planner-gated through `executive-planner.mjs`
- Core path:
  - yes

### 8A. Agent Token Governance

- Location:
  - `/Users/seanhan/Documents/Playground/src/agent-token-governance.mjs`
  - `/Users/seanhan/Documents/Playground/src/agent-workflow-state.mjs`
- Responsibility:
  - prompt slimming
  - shared compact system-prompt builder for AI-heavy flows
  - context budget staging
  - XML prompt wrapping for AI-heavy flows
  - shared anti-hallucination rules
  - shared self-check scaffolding
  - structured rolling checkpoint summary
  - tool output compression
  - external workflow state persistence
- Core path:
  - yes for AI-heavy flows

### 8B. Image Understanding

- Location:
  - `/Users/seanhan/Documents/Playground/src/modality-router.mjs`
  - `/Users/seanhan/Documents/Playground/src/image-understanding-service.mjs`
- Responsibility:
  - classify incoming requests as `text`, `image`, or `multimodal`
  - route image-first work to the Nano Banana-oriented provider instead of the text model
  - call Nano Banana through Gemini `generateContent` semantics instead of OpenAI chat-completions semantics
  - accept both directly reachable image URLs and Lark `image_key` downloads
  - convert image outputs into compact structured fields before any optional downstream text synthesis
- Core path:
  - important for image-bearing chat tasks and meeting capture

### 8C. Registered Agent Dispatch

- Location:
  - `/Users/seanhan/Documents/Playground/src/agent-registry.mjs`
  - `/Users/seanhan/Documents/Playground/src/agent-dispatcher.mjs`
  - `/Users/seanhan/Documents/Playground/src/openclaw-text-service.mjs`
- Responsibility:
  - checked-in slash command registry for persona agents and knowledge subcommands
  - role / persona config
  - `executive-planner.mjs` now also contains a minimal planner tool selection policy that can route compound intents to presets such as `create_and_list_doc` and `create_search_detail_list_doc` before falling back to single-step tools
  - explicit agent capability contract metadata
  - compact retrieval-grounded agent prompt assembly
  - slash-command execution before generic lane fallback
  - optional compact image-context handoff into slash agents
  - when direct `LLM_API_KEY` is absent, registered agents now reuse the local OpenClaw MiniMax text path through the dedicated `lobster-backend` agent before falling back to extractive retrieval-only replies
- Main entry:
  - `parseRegisteredAgentCommand()`
  - `dispatchRegisteredAgentCommand()`
- Depends on:
  - `answer-service.mjs`
  - `agent-token-governance.mjs`
  - `agent-workflow-state.mjs`
  - `image-understanding-service.mjs`
- Core path:
  - yes for slash-agent conversations

### 8D. External Skill Governance Mirror

- Location:
  - `/Users/seanhan/Documents/Playground/docs/system/skill_routing_map.md`
  - `/Users/seanhan/Documents/Playground/docs/system/skill_audit_summary.md`
- Responsibility:
  - mirror the externally stored skill layer under `~/.agents` and `~/.codex`
  - record which skills Lobster should prefer for common task families
  - summarize the first audited and Traditional-Chinese-translated skill batch
  - document which external skills are still pending audit
- Core path:
  - advisory / governance only

### 8D. Closed-Loop Executive Reliability

- Location:
  - `/Users/seanhan/Documents/Playground/src/executive-rules.mjs`
  - `/Users/seanhan/Documents/Playground/src/executive-lifecycle.mjs`
  - `/Users/seanhan/Documents/Playground/src/executive-verifier.mjs`
  - `/Users/seanhan/Documents/Playground/src/executive-reflection.mjs`
  - `/Users/seanhan/Documents/Playground/src/executive-improvement.mjs`
  - `/Users/seanhan/Documents/Playground/src/executive-memory.mjs`
  - `/Users/seanhan/Documents/Playground/src/executive-closed-loop.mjs`
  - `/Users/seanhan/Documents/Playground/src/executive-improvement-workflow.mjs`
- Responsibility:
  - define execution / verification / knowledge / tool / meeting rules
  - enforce lifecycle state transitions
  - require evidence plus verifier pass before completion
  - route verification failure back to `executing`, `blocked`, or `escalated` instead of silently treating a reply as completed
  - generate reflection records and improvement proposals
  - maintain session / approved / proposal memory stores
  - persist reflection records and improvement proposals into dedicated stores
  - expose approve / reject / apply workflow for improvement proposals
  - resolve approve / reject / apply against the newest matching proposal record in the persisted workflow store so stale archived duplicates do not mutate the wrong task
- Core path:
  - yes for executive orchestration and knowledge governance

### 8E. Health Governance

- Location:
  - `/Users/seanhan/Documents/Playground/src/daily-status.mjs`
  - `/Users/seanhan/Documents/Playground/src/system-self-check.mjs`
  - `/Users/seanhan/Documents/Playground/src/release-check.mjs`
  - `/Users/seanhan/Documents/Playground/src/release-check-history.mjs`
  - `/Users/seanhan/Documents/Playground/src/system-self-check-history.mjs`
  - `/Users/seanhan/Documents/Playground/src/planner-contract-consistency.mjs`
  - `/Users/seanhan/Documents/Playground/src/planner-diagnostics-history.mjs`
  - `/Users/seanhan/Documents/Playground/scripts/daily-status.mjs`
  - `/Users/seanhan/Documents/Playground/scripts/self-check.mjs`
  - `/Users/seanhan/Documents/Playground/scripts/release-check.mjs`
  - `/Users/seanhan/Documents/Playground/scripts/release-check-ci.mjs`
  - `/Users/seanhan/Documents/Playground/scripts/planner-contract-check.mjs`
  - `/Users/seanhan/Documents/Playground/scripts/planner-diagnostics.mjs`
  - `/Users/seanhan/Documents/Playground/docs/system/agent_capability_matrix.md`
  - `/Users/seanhan/Documents/Playground/docs/system/chain_health_checklist.md`
- Responsibility:
  - validate registry completeness
  - validate minimum agent contracts
  - validate route-contract coverage for key HTTP endpoints
  - validate that core service modules still initialize
  - validate planner tool/preset registries and selector/flow targets against `docs/system/planner_contract.json`
  - classify planner contract drift into undefined action, undefined preset, deprecated reachable target, and selector-contract mismatch
  - read latest archived routing diagnostics snapshot and compare it with the previous routing snapshot when available
  - compare current planner diagnostics against the latest archived planner diagnostics snapshot when available
  - archive every self-check run into snapshot-only unified self-check history
  - expose a fixed planner contract gate through `planner-contract-check` and `self-check`
  - expose a unified self-check summary through `system_summary`, `routing_summary`, and `planner_summary`
  - mirror doc/company-brain routing severity into read-only `doc_boundary_regression` when the current routing regression belongs to the checked-in doc-boundary family
  - answer the operator-facing question `現在系統能不能放心改`
  - expose `daily-status` as the single daily operator entry over the same release/self-check evidence
  - keep `daily-status` human output bounded to four lines only:
    - `今天能不能安心開發`
    - `今天能不能安心合併`
    - `今天能不能安心發布`
    - `若不能，先看哪一條線`
  - expose read-only `daily-status` compare through `--compare-previous` and `--compare-snapshot <run-id|path>`
  - expose read-only `daily-status` trend through `--trend` and `--trend --trend-count <n>`
  - keep `daily-status` trend human output bounded to two lines only:
    - `最近趨勢`
    - `最常變動`
  - keep `daily-status -- --trend --json` bounded to:
    - `trend_summary.sample_count`
    - `trend_summary.trend`
    - `trend_summary.most_changed_line`
    - `trend_summary.recent_runs`
  - keep each `trend_summary.recent_runs` item bounded to:
    - `run_id`
    - `timestamp`
    - `routing_status`
    - `planner_status`
    - `release_status`
    - `overall_recommendation`
  - keep `daily-status` trend source read-only and bounded:
    - release status/history comes from `release-check-history`
    - routing/planner status/history comes from `system-self-check-history`
    - trend does not create a new daily-status archive
  - keep `daily-status` compare human output bounded to the same four daily lines plus one extra line only:
    - `為什麼變差`
  - keep `daily-status -- --json` bounded to:
    - `routing_status`
    - `planner_status`
    - `release_status`
    - `overall_recommendation`
  - keep `daily-status` compare JSON bounded to the same four fields plus:
    - `changed_line`
    - `change_reason_hint`
  - keep `daily-status` recommendation read-only and line-first:
    - `safe_to_develop_merge_release`
    - `check_routing_first`
    - `check_planner_first`
    - `check_release_first`
  - keep `daily-status` compare reason minimal and source-bound:
    - `changed_line` only uses `routing` / `planner` / `release` / `none`
    - `change_reason_hint` only uses:
      - routing -> `doc` / `meeting` / `runtime` / `mixed`
      - planner -> `contract` / `selector`
      - release -> first `blocking_checks` type
  - expose `release-check` as the single merge/release preflight entry over the same self-check, routing, and planner evidence
  - archive every `release-check` / `release-check:ci` execution into snapshot-only release-check history
  - keep `release-check` human output bounded to three lines only:
    - `能否放心合併/發布`
    - `若不能，先修哪一條線`
    - `下一步`
  - keep `release-check -- --json` bounded to:
    - `overall_status`
    - `blocking_checks`
    - `doc_boundary_regression`
    - `suggested_next_step`
    - `action_hint`
    - `failing_area`
    - `representative_fail_case`
    - `drilldown_source`
  - classify `blocking_checks` only as `system_regression`, `routing_regression`, or `planner_contract_failure`
  - keep `suggested_next_step` single-line but module-specific: base modules for system regression, routing rule/fixture files for routing regression, planner registry/flow modules before `planner_contract.json` for planner contract failure
  - when `doc_boundary_regression = true` and routing is the first blocking line, route the operator hint to the existing doc-boundary pack first, then `message-intent-utils.mjs`, then `lane-executor.mjs`; this is a hint-only overlay and does not change gate order
  - keep drilldown read-only and minimal:
    - `failing_area` only uses `doc` / `meeting` / `runtime` / `mixed`
    - `representative_fail_case` only carries 1~2 representative case strings
    - `drilldown_source` only reuses `release-check triage`, `routing-eval diagnostics/history`, and `planner diagnostics/history`
  - expose `release-check:ci` as the CI/pipeline entry with the same minimal JSON report and strict `0/1` exit contract
  - expose a minimal `release-check` compare view through `--compare-previous` and `--compare-snapshot <run-id|path>`
  - keep release-check compare output bounded to:
    - `release` 狀態變好 / 變差 / 無變化
    - `blocking_checks` 是否改變
    - `suggested_next_step` 是否改變
  - define `pass` as merge/deploy may proceed and `fail` as merge/deploy must stop on this preflight line
  - expose a fixed human-readable daily-entry view through `planner:diagnostics`
  - expose a minimal self-check compare view through `--compare-previous` and `--compare-snapshot <run-id|path>`
  - fail the planner contract gate only on undefined action, undefined preset, and selector-contract mismatch
  - emit a concise default human-readable verdict plus a JSON report via `self-check -- --json` without changing routing logic
  - keep self-check compare output bounded to `system`, `routing regression`, and `planner regression`
  - archive each `planner:diagnostics` / `planner:contract-check` execution into snapshot-only planner diagnostics history without adding compare mode or changing the gate
  - keep a human-readable capability matrix and chain checklist in sync with code
- Core path:
  - important for regression prevention and operator debugging

### 8F. Executive Orchestration

- Location:
  - `/Users/seanhan/Documents/Playground/src/executive-planner.mjs`
  - `/Users/seanhan/Documents/Playground/src/executive-task-state.mjs`
  - `/Users/seanhan/Documents/Playground/src/executive-orchestrator.mjs`
- Governance baseline:
  - `/Users/seanhan/Documents/Playground/docs/system/workflow-kernel-spec.md`
- Responsibility:
  - planner for start / continue / handoff decisions
  - shared task state per session
  - initialize task rules, lifecycle state, and success criteria
  - maintain a minimal `active_task` contract with `workflow`, `workflow_state`, `routing_hint`, and `trace_id`
  - expose test-only in-memory/reset hooks so workflow suites can avoid writing shared task state into the file-backed store
  - planner text generation can now use the same dedicated OpenClaw MiniMax path when direct text-model credentials are absent
  - keep a compact visible work plan for primary/supporting agents
  - normalize supporting-agent outputs into short summaries
  - answer first, then append orchestration context only when useful
  - explicit multi-turn continuation across registered agents
  - handoff logging between agents
  - persist a compact work plan and supporting-agent outputs per executive task
  - run supporting agents in parallel async calls, then synthesize through the primary agent
  - finalize each executive turn with evidence collection, verifier pass/fail, reflection, and improvement proposal generation
  - direct task completion is now blocked at orchestrator level; completion must pass the verifier gate in `executive-closed-loop.mjs`
  - meeting workflow now reuses the same task-state store through exported helpers, instead of inventing a separate control registry
  - doc rewrite workflow now reuses the same task-state store through exported preview/apply helpers and verifier gate integration
  - cloud-doc organization now reuses the same task-state store through scope-keyed preview/apply helpers and verifier gate integration
  - cloud-doc apply now hard-requires `awaiting_review -> applying -> verifying`; preview routes are explicitly non-terminal and cannot self-declare success
  - `executive-planner.mjs` now also contains a minimal planner tool registry and `dispatchPlannerTool(...)` helper for `create_doc`, `list_company_brain_docs`, `search_company_brain_docs`, `get_company_brain_doc_detail`, and `get_runtime_info`, using the existing document/runtime HTTP surfaces and logging `stage=planner_tool_dispatch`
  - the same module now also exposes a strict user-input planning surface: `planUserInputAction(...)` only accepts a single JSON object shaped as either legacy `{ action, params }` or bounded `{ steps: [{ action, params }] }`, returns `{ error: "planner_failed" }` when planner output is not strict JSON, rejects contract-external actions with structured `INVALID_ACTION`, validates each `steps[i].params` against the same checked-in action contract, and `executePlannedUserInput(...)` keeps legacy single-step action/preset execution while routing multi-step plans through the existing sequential planner tool runtime without reopening selector/free-text fallback paths
  - the same module now includes a minimal tool-selection policy helper that takes `user intent / task type` and returns `selected_action + reason`; it still prefers bounded presets for explicit create-then-list / create-then-search intents, logs `stage=planner_tool_select`, and now returns `reason = "ROUTING_NO_MATCH"` when unmatched instead of silently continuing into default fallback wording
  - contract-alignment checkpoint: `src/router.js` now provides a minimal hard pre-route for company-brain document intents before the planner selector, using priority `mixed -> search -> detail`: `整理|解釋 -> preset:search_and_detail_doc`, `找|搜尋|查 -> action:search_company_brain_docs`, `這份|內容 -> action:get_company_brain_doc_detail`; ordinal follow-ups like `第一份 / 第二份 / 打開第一個` can also route to detail when the planner has active candidates, and `runPlannerToolFlow(...)` still feeds the routed target into the existing preset/dispatch path without changing its external response shape
  - the same planner runtime now also keeps a minimal in-memory read context: after a successful `search_and_detail_doc` or `get_company_brain_doc_detail`, the planner can remember `active_doc = { doc_id, title }`; after an ambiguous successful search it can also remember a bounded `active_candidates` list; themed knowledge flows can also remember `active_theme = okr|bd|delivery`; follow-up pronoun/detail questions like `這份文件裡面寫了什麼` route directly to `get_company_brain_doc_detail`, ordinal follow-ups can resolve through those candidates, and compacted planner memory can restore that doc-query context after runtime reset/restart
  - the same module now includes a minimal end-to-end helper that runs `selectPlannerTool(...)` and, when matched, executes either the preset runner or `dispatchPlannerTool(...)`, returning `{ selected_action, execution_result, trace_id }` and logging `stage=planner_end_to_end`
  - after successful company-brain read-side execution, `runPlannerToolFlow(...)` now also adds a minimal response formatter inside `execution_result.formatted_output`: `search_company_brain_docs` returns a compact `title/doc_id` list, `get_company_brain_doc_detail` returns `title + content_summary`, and `search_and_detail_doc` returns either `title + match_reason + content_summary`, an explicit not-found payload, or a bounded candidate list for follow-up selection, while keeping the raw tool result intact
  - the same module now also includes a minimal multi-step helper that accepts ordered planner-tool `steps`, dispatches them sequentially through the existing planner tool bridge, accepts either `step.params` or internal `step.payload`, returns `{ ok, steps, results, trace_id, error, stopped, stopped_at_step }`, stops on the first normalized step failure by default, and logs `stage=planner_multi_step`
  - the same module now also includes minimal preset helpers; `create_and_list_doc` expands into `create_doc -> list_company_brain_docs`, `runtime_and_list_docs` expands into `get_runtime_info -> list_company_brain_docs`, `search_and_detail_doc` expands into `search_company_brain_docs -> get_company_brain_doc_detail`, and `create_search_detail_list_doc` expands into `create_doc -> search_company_brain_docs -> get_company_brain_doc_detail -> list_company_brain_docs`; all return `{ ok, preset, steps, results, trace_id, stopped, stopped_at_step }`, derive top-level `ok` from all step results, default to `stop_on_error=true`, and now only auto-run the detail step when search resolves to exactly one candidate
  - planner prompt shaping is now stricter for low-variance text models: `buildPlannerPrompt(...)` explicitly requires a single JSON object with no Markdown/code fences, caps `pending_questions` and `work_items`, narrows when `clarify` / `handoff` may be chosen, and now also tells the model to distinguish company-brain `list` vs `search` vs `detail/read` intents and to avoid declaring “not found” or stopping before the matching tool has been attempted, while keeping the external planner result shape unchanged
- Main entry:
  - `executeExecutiveTurn()`
  - `planExecutiveTurn()`
  - `getActiveExecutiveTask()`
- Depends on:
  - `agent-registry.mjs`
  - `agent-dispatcher.mjs`
  - `agent-token-governance.mjs`
  - local JSON task state
- Core path:
  - yes for executive-team style conversations

### 9. Drive and Wiki Organization

- Location:
  - `/Users/seanhan/Documents/Playground/src/lark-drive-organizer.mjs`
  - `/Users/seanhan/Documents/Playground/src/lark-wiki-organizer.mjs`
  - `/Users/seanhan/Documents/Playground/src/lark-drive-semantic-classifier.mjs`
- Responsibility:
  - semantic classification
  - malformed/incomplete MiniMax JSON retry before local fallback
  - batch classification across all pending items instead of truncating to the first classifier window
  - preview/apply organization plans
- Core path:
  - important, but not base runtime

### 10. Comment Rewrite

- Location:
  - `/Users/seanhan/Documents/Playground/src/doc-comment-rewrite.mjs`
- Responsibility:
  - collect comments
  - call LLM
  - generate rewrite preview
  - XML-governed rewrite prompt with anti-hallucination rules
  - keep rewrite-specific checkpoint state and use focused excerpts instead of full raw document when possible
  - optionally write back and resolve comments
  - emit controlled rewrite workflow state for `awaiting_review` and `applying`
  - build minimal structured rewrite result with patch plan, before/after excerpts, and structure-preservation flag for verifier use
- Core path:
  - important recent capability

### 10A. Lane Execution

- Location:
  - `/Users/seanhan/Documents/Playground/src/capability-lane.mjs`
  - `/Users/seanhan/Documents/Playground/src/cloud-doc-organization-workflow.mjs`
  - `/Users/seanhan/Documents/Playground/src/lane-executor.mjs`
  - `/Users/seanhan/Documents/Playground/src/message-intent-utils.mjs`
- Responsibility:
  - isolate the cloud-document classification / reassignment follow-up workflow into a testable submodule instead of keeping all branch logic inside `lane-executor.mjs`
  - knowledge-assistant lane turns no longer call `answer-service.mjs` directly; they now serialize the strict planner envelope returned by `executePlannedUserInput(...)`
  - strict planner envelopes now reject semantically mismatched actions and stale previous-turn decision reuse with structured errors instead of generic fallback text
  - keep cloud-doc organization follow-ups in the same workflow mode, including a plain-language re-explanation path, a dedicated "why can't this be directly assigned?" explainer path, and second-pass review continuation for generic confirmation follow-ups
  - generic second-confirmation follow-ups now prefer a session-scoped cached review summary, so "還有什麼需要我二次確認" returns quickly instead of rerunning a full semantic re-review on every turn
  - explicit reassignment / relearning requests such as "重新分配" or "各個角色去學習" still trigger the slower second-pass semantic re-review branch
  - scoped exclusion / rereview phrasing family such as "把非 scanoo 的文檔摘出去", "摘出無關文檔", "只保留某主題文檔，把非該主題文檔排出去", and "重新審核哪些文件不屬於某集合" is treated as cloud-doc re-review / reassignment intent instead of falling through to generic personal-assistant `ROUTING_NO_MATCH`
  - avoid hard-failing mixed image+text turns when the image provider is unavailable; image tasks can fall back to the text lane when the user message still has actionable text
  - if image download or image analysis throws for a mixed image+text turn, lane execution now degrades to the text lane instead of emitting a generic failure reply
  - resolve one lane from message intent and peer scope
  - normalize structured Lark message content into reusable intent signals
  - extract document IDs from raw message payloads, shared links, and reply-chain upstream messages
  - detect image-bearing requests and route them through the image-understanding adapter before plain text fallback
  - execute lane-specific reply and tool strategy for DM, group, doc, and knowledge requests
  - detect DM requests for cloud-document classification / role assignment and persist a chat-scoped workflow mode so follow-up phrases about learning, unrelated docs, reassignment, and explicit exit stay in the same organization flow instead of generic personal-assistant fallback
  - personal-lane execution now emits the existing `semantic_mismatch_document_request_in_personal_lane` guard for clear cloud-doc/company-brain document intents instead of treating them as generic no-match chat turns
  - the current checked-in high-confidence doc-boundary set is:
    - document summary / organization phrasing such as `整理文件`, `文件摘要`, `文件重點`
    - document classification phrasing such as `分類文件`, `歸類文檔`, `指派文件`
    - document boundary-selection phrasing such as `排除`, `摘出`, `保留` when the same turn also clearly refers to docs / wiki / company-brain scope
    - explicit company-brain scope such as `company brain`, `company_brain`, `公司知識庫`, `知識庫`
  - these intents must not run as generic `personal-assistant` turns because they require document-scoped or company-brain-scoped routing/verification; letting them fall through the personal lane would blur document/workspace boundaries and degrade into generic chat no-match behavior instead of a bounded doc/company-brain path
  - run a second-pass role-review branch inside that workflow, using local classification plus a small MiniMax semantic re-review set for ambiguous documents, so follow-up turns can return reassignment candidates instead of only category totals
  - intercept `/meeting` plus explicit preview-then-confirm meeting requests as a command-style workflow that runs before lane-specific fallback replies
  - suppress normal lane replies while a chat-scoped meeting capture session is actively recording plain-text notes
  - prefer the same-session active executive task before falling back to generic lane heuristics
  - prefer the same-session active meeting workflow for capture/confirm follow-up before generic lane fallback
  - prefer the same-session active doc-rewrite workflow for review follow-up before generic lane fallback
  - prefer the same-session active cloud-doc workflow only when the same `scope_key` matches, otherwise fall back to the existing planner/lane path
  - for doc lane, also inspect referenced upstream messages when current message only contains a share/reply wrapper
  - keep group-summary prompts in the group lane instead of over-matching the knowledge lane
  - distinguish document-summary requests from recent-dialogue summary requests so `整理文件` and `總結最近對話` do not collapse into the same lane/action path
  - emit lane execution trace fields `chosen_lane`, `chosen_action`, and `fallback_reason`
  - emit doc-resolution and auth-context runtime logs to support live payload debugging
  - honor direct-message cleanup instructions for failed Lobster meeting docs and persist a chat-only failure-report preference instead of falling back to generic personal-assistant boilerplate
- Core path:
  - yes for long-connection assistant behavior

### 10B. Meeting Workflow

- Location:
  - `/Users/seanhan/Documents/Playground/src/meeting-agent.mjs`
  - `/Users/seanhan/Documents/Playground/src/meeting-capture-store.mjs`
  - `/Users/seanhan/Documents/Playground/src/meeting-audio-capture.mjs`
- Responsibility:
  - open and close chat-scoped meeting capture sessions
  - classify meetings into `weekly` or `general`
  - accept explicit `/meeting`, menu wake text, start/stop natural-language intents, calendar-backed "this meeting" intents, and preview-then-confirm natural-language intents
  - treat short offline-meeting requests like `線下會議 請記錄`, `okr 周例會`, and `現在正要開始 請準備記錄吧` as capture starts instead of generic assistant traffic
  - auto-upgrade generic `我要開會了` starts into calendar-backed sessions when the current or nearest event already has a `meeting_url`
  - answer explicit in-meeting status questions instead of swallowing them into the transcript buffer
  - start and stop local microphone recording with `ffmpeg`
  - persist audio process metadata on the meeting session so status checks and stop can recover after long-connection restarts
  - transcribe local recordings through local `faster-whisper` by default, with optional OpenAI-compatible fallback when explicitly configured
  - compact long chat transcripts before they are sent into meeting summarization
  - convert image-bearing meeting messages into compact structured image notes before they are appended to the transcript
  - treat empty local transcription as a failed capture state and write an explicit operator-facing note instead of a misleading meeting summary
  - filter low-signal control chatter and raw JSON payload echoes out of meeting transcript rendering
  - tolerate broken user OAuth refresh during meeting capture by falling back to tenant-token document writes
  - create one dedicated Lark meeting doc per capture session and replace it with final usable minutes on stop
  - ensure the meeting starter's `open_id` is granted `full_access` on both new and reused meeting docs
  - format fixed weekly/general summaries
  - emit structured meeting outputs for decisions, action items, owners, deadlines, risks, open questions, conflicts, knowledge writeback, and task writeback
  - verify meeting completeness and create pending knowledge proposals when confirmed writes should feed long-term knowledge
  - send summary to a designated Lark group
  - build a Lark interactive confirmation card with an open-url button
  - persist pending confirmation state before any doc write
  - find/create/prepend meeting docs with newest entry on top
  - update weekly todo tracker after confirmation
  - mirror controlled meeting state into `active_task` with `workflow="meeting"` and `workflow_state` transitions for `capturing`, `awaiting_confirmation`, `writing_back`, and verifier-gated completion
- Core path:
  - yes for `/meeting`

### 10C. Cloud-Doc Organization Workflow

- Location:
  - `/Users/seanhan/Documents/Playground/src/cloud-doc-organization-workflow.mjs`
  - `/Users/seanhan/Documents/Playground/src/lark-drive-organizer.mjs`
  - `/Users/seanhan/Documents/Playground/src/lark-wiki-organizer.mjs`
- Responsibility:
  - keep a session-scoped preview/review/why conversation mode for cloud document classification
  - build deterministic `scope_key` values for chat scope, drive folder scope, and wiki scope
  - mirror cloud-doc workflow state into `active_task` with `workflow="cloud_doc"`
  - require preview/review before drive/wiki apply
  - run verifier-gated completion after apply instead of treating apply as immediate completion
- Core path:
  - important for drive/wiki organization safety

### 11. OpenClaw Plugin

- Location:
  - `/Users/seanhan/Documents/Playground/openclaw-plugin/lark-kb`
- Responsibility:
  - expose repo HTTP API as OpenClaw tools
  - compress oversized tool payloads before they are returned into agent context
  - wrap every plugin tool execution with a unified `lobster_tool_execution` log payload containing `request_id`, `action`, `params`, and normalized `result`
  - forward the same `request_id` to the local HTTP server through `X-Request-Id`
  - keep a local TypeScript compiler and `npm run typecheck` path for plugin contract checks
- Main entry:
  - `register(...)` in `index.ts`
- Core path:
  - yes for OpenClaw users

### 12. Secure Local Action Bridge

- Location:
  - `/Users/seanhan/Documents/Playground/src/lobster-security-bridge.mjs`
- Responsibility:
  - invoke Python security wrapper CLI
  - manage pending approval state
- Core path:
  - yes for secured agent actions

### 13. Python Security Subproject

- Location:
  - `/Users/seanhan/Documents/Playground/lobster_security`
- Responsibility:
  - workspace sandbox
  - command policy
  - network guard
  - approval
  - audit
  - rollback
- Core path:
  - separate but integrated subproject

## File-Level High-Value Entry Files

- `/Users/seanhan/Documents/Playground/src/http-server.mjs`
  - API router and operational center

- `/Users/seanhan/Documents/Playground/src/lark-content.mjs`
  - all direct user-token Lark operations

- `/Users/seanhan/Documents/Playground/src/lark-sync-service.mjs`
  - sync orchestrator

- `/Users/seanhan/Documents/Playground/src/rag-repository.mjs`
  - persistence and FTS query layer
  - local semantic embedding storage
  - indexed-document listing for DM cloud-organization previews

- `/Users/seanhan/Documents/Playground/src/answer-service.mjs`
  - hybrid retrieval-to-answer pipeline
  - now uses XML-governed prompt sections, checkpoint summaries, retrieved-snippet budgets, and shared low-variance generation settings instead of stuffing raw chunks
  - answer prompt instructions are now stricter for low-variance text models: answer order is fixed as `answer -> sources -> unresolved/limits`, invented tool-use is explicitly forbidden, and missing evidence must be surfaced as uncertainty instead of filled-in facts; external API/response shape remains unchanged

- `/Users/seanhan/Documents/Playground/src/doc-comment-rewrite.mjs`
  - comment-to-doc patch-plan workflow
  - now prefers focused excerpts, compact comment summaries, doc-specific checkpoints, and XML-governed anti-hallucination prompt rules over full-doc replay

- `/Users/seanhan/Documents/Playground/src/doc-update-confirmations.mjs`
  - preview / confirm state store for safe doc overwrite and patch-plan apply

- `/Users/seanhan/Documents/Playground/src/agent-token-governance.mjs`
  - shared context budget, rolling-summary, XML prompt wrapper, anti-hallucination rules, and tool-output compression logic

- `/Users/seanhan/Documents/Playground/src/agent-workflow-state.mjs`
  - external checkpoint persistence for multi-round AI workflows

- `/Users/seanhan/Documents/Playground/src/secret-crypto.mjs`
  - token-at-rest encryption helper

- `/Users/seanhan/Documents/Playground/src/semantic-embeddings.mjs`
  - local semantic embedding generation and similarity

- `/Users/seanhan/Documents/Playground/src/knowledge/doc-index.mjs`
  - local in-memory document index helper
  - provides exact-id lookup plus case-sensitive and case-insensitive content search helpers
  - not connected to sync ingestion, SQLite persistence, planner routes, or company-brain approval/governance paths

- `/Users/seanhan/Documents/Playground/src/knowledge/doc-loader.mjs`
  - local Markdown-to-in-memory-index loader helper
  - scans one directory for `.md` files and inserts them into `doc-index`
  - not connected to sync ingestion, SQLite persistence, planner routes, or company-brain approval/governance paths

- `/Users/seanhan/Documents/Playground/src/knowledge/knowledge-service.mjs`
  - local cached knowledge query helper
  - lazily loads `./docs/system` into memory once per process and exposes keyword lookup over the cached index
  - also exposes `queryKnowledgeWithSnippet(keyword)` for a bounded top-3 `{ id, snippet }` preview over the same cached results, expanding around the keyword and snapping to nearby line/sentence-style breaks when available
  - also exposes `queryKnowledgeWithContext(keyword)` as a compatibility alias over that same contextual preview helper
  - not connected to sync ingestion, SQLite persistence, planner routes, or company-brain approval/governance paths

- `/Users/seanhan/Documents/Playground/src/planner/knowledge-bridge.mjs`
  - local planner-side bridge over `queryKnowledgeWithContext(keyword)`
  - exposes `plannerAnswer({ keyword }) -> { answer, count }`
  - reads the same local `{ id, snippet }` preview rows and formats them through `buildAnswer(keyword, results)`
  - not wired into `executive-planner.mjs`, planner contract routing, SQLite persistence, or company-brain approval/governance paths

- `/Users/seanhan/Documents/Playground/src/planner/answer-builder.mjs`
  - local planner-side formatter for knowledge preview results
  - exposes `buildAnswer(keyword, results) -> string`
  - returns a fixed Chinese no-result message when `results` is empty and otherwise renders a count-based intro plus a cleaned numbered list over each `{ id, snippet }` row
  - snippet cleanup strips inline code spans, local absolute-path fragments, excess whitespace, leading punctuation noise, trailing separator noise, stray spaces before punctuation, repeated commas, and dangling trailing conjunction/placeholder tails before rendering
  - not wired into `executive-planner.mjs`, planner contract routing, SQLite persistence, or company-brain approval/governance paths

- `/Users/seanhan/Documents/Playground/src/runtime-contract.mjs`
  - Node/Python runtime compatibility check

- `/Users/seanhan/Documents/Playground/openclaw-plugin/lark-kb/index.ts`
  - external tool contract surface

## Dependency Shape

- entrypoints -> `http-server`
- `http-server` -> auth/content/sync/answer/security bridge
- sync -> connectors -> repository
- answer -> repository -> optional LLM
- comment rewrite -> content service -> optional LLM -> content service
- plugin -> HTTP API
- security bridge -> python `lobster_security` CLI

## Responsibility Risks

- `http-server.mjs` is too broad and mixes:
  - OAuth
  - browse
  - write
  - search
  - answer
  - security bridge

- `lark-content.mjs` is a strong central adapter, but it now spans multiple product domains:
  - doc
  - comments
  - messages
  - calendar
  - task
  - bitable
  - sheets
  - task
  - drive
  - wiki

- `lark-drive-semantic-classifier.mjs` depends on OpenClaw runtime conventions that live outside pure repo code.
