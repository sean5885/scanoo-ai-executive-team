# Closed-Loop Agent System

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Purpose

Lobster now includes a closed-loop executive layer so a reply by itself does not count as task completion.

Workflow governance baseline is consolidated in [workflow-kernel-spec.md](/Users/seanhan/Documents/Playground/docs/system/workflow-kernel-spec.md).

## Loops

### Execution Loop

`observe -> understand -> plan -> act`

Implemented through:

- `src/lane-executor.mjs`
- `src/executive-planner.mjs`
- `src/agent-dispatcher.mjs`
- `src/executive-orchestrator.mjs`
- `src/executive-planner.mjs` now also contains a minimal planner tool registry and `dispatchPlannerTool(...)` helper for thin calls into document/runtime routes (`create_doc`, `list_company_brain_docs`, `search_company_brain_docs`, `get_company_brain_doc_detail`, `get_runtime_info`), logging under `stage=planner_tool_dispatch`
- the same planner/runtime line now also treats `create_doc` as an entry-governed write: checked-in governance requires `source / owner / intent / type`, the agent bridge blocks missing fields with `entry_governance_required`, and planner dispatch auto-fills stable values for the controlled planner path so governed runtime behavior does not regress
- `src/executive-planner.mjs` now also keeps the planner-generation prompt more deterministic for MiniMax-style low-variance text models by requiring a single JSON object, tightening `clarify` / `handoff` usage, constraining `pending_questions` / `work_items`, and explicitly separating company-brain `list` / `search` / `detail` intent classes so the model is told to prefer tool use before fail-soft stop when the user is asking to find or read documents
- `src/executive-planner.mjs` now also applies deterministic agent-selection hardening after planner JSON normalization: simple single-intent requests collapse back to `/generalist`, multi-agent is reserved for compound requests that actually imply distinct specialist roles, explicit slash-agent requests do not auto-expand extra specialists, and the planner-visible role set is capped at three total roles (`1 primary + up to 2 supporting`) without changing the public decision shape
- downstream supporting-agent work items still run sequentially inside `src/executive-orchestrator.mjs`; this is a bounded in-process collaboration path, not a parallel worker mesh
- `src/executive-planner.mjs` now also validates planner-tool input and successful output against [planner_contract.json](/Users/seanhan/Documents/Playground/docs/system/planner_contract.json) before and after dispatch; the current runtime check is intentionally minimal (`required` + simple `string/object/number` type checks) and fails soft by returning `ok=false` with `error=contract_violation` instead of throwing
- `src/executive-planner.mjs` now also validates final preset output against [planner_contract.json](/Users/seanhan/Documents/Playground/docs/system/planner_contract.json) only when the preset itself reports success; this check is also fail-soft (`ok=false`, `error=contract_violation`, `phase=preset_output`) and does not yet validate individual step outputs
- `src/executive-planner.mjs` now also normalizes planner action/preset failures into a minimal taxonomy (`contract_violation`, `tool_error`, `runtime_exception`, `business_error`, `not_found`, `permission_denied`) without overwriting an existing `error` value; planner runtime still fails soft and does not throw for these controlled error paths
- `src/executive-planner.mjs` now also applies a minimal retry policy inside `dispatchPlannerTool(...)`: only `tool_error` and `runtime_exception` are retried, the default retry budget is one extra attempt, `contract_violation` / `business_error` are not retried, and final responses carry `data.retry_count` while staying fail-soft
- `src/executive-planner.mjs` now also applies readonly local fallback for non-abort upstream exceptions on planner read actions: when `get_runtime_info` upstream fetch throws, dispatch returns a local runtime snapshot (`meta.source=local_readonly_fallback`) instead of surfacing generic runtime_exception
- on the same readonly fallback path, company-brain read actions (`list/search/detail`) now fail closed as `missing_user_access_token` when no account context can be resolved, so user-facing copy stays auth-boundary explicit instead of generic fallback wording
- `src/executive-planner.mjs` now also applies a minimal self-healing pass for input-side `contract_violation` before dispatch: missing required fields are filled with `null`/`""`, simple type mismatches are coerced with basic `String()` / `Number()` conversion, the healed payload is re-dispatched at most once, success responses are tagged with `data.healed=true`, and unrecoverable cases still return `contract_violation` fail-soft
- `src/executive-planner.mjs` now also hardens a minimal execution policy and fail boundary around planner actions/presets: `contract_violation` gets at most one self-heal attempt, `tool_error` and `runtime_exception` get at most one retry, `business_error` stops immediately, and final controlled failures are normalized into a shared stopped shape (`data.stopped=true`, `data.stop_reason=...`) without throwing
- `src/executive-planner.mjs` also now exposes a minimal `selectPlannerTool(...)` policy helper that maps `user intent / task type` to `selected_action + reason`; it now prefers compound presets before single-step actions, including `create_and_list_doc` for intents like “建立文件後列出知識庫” and `create_search_detail_list_doc` for intents like “建立文件並查詢” / `create then search`, and still returns `selected_action: null` with a fixed internal fallback reason when no rule matches. On the public `runPlannerToolFlow(...)` surface, that unmatched case is normalized into `execution_result.error = "business_error"` with `data.reason = "未命中受控工具規則，保持空選擇。"` while retaining internal `routing_reason = "ROUTING_NO_MATCH"` for diagnostics; user-facing callers must convert that controlled failure into natural language instead of exposing raw planner JSON or trace fields.
- `src/router.js` now adds a minimal hard pre-route helper for company-brain-style document intents before the normal planner selector runs. Explicit search wording keeps priority over generic detail cues like `內容`, so queries such as `搜尋有提到 OKR 的內容` still route to `search_company_brain_docs`; `整理|解釋` still route to `search_and_detail_doc`; pronoun/detail follow-ups reuse `activeDoc`, ordinal follow-ups reuse `active_candidates`, and direct action hits can now surface as plain action strings while preset/error results still use the object envelope.
- `src/executive-planner.mjs` now also keeps a minimal planner read context per `sessionKey`: successful `search_and_detail_doc` or `get_company_brain_doc_detail` results can seed `active_doc = { doc_id, title }`, successful ambiguous company-brain search results can seed `active_candidates = [{ doc_id, title }]`, themed knowledge flows can seed `active_theme = okr|bd|delivery`, later pronoun-style follow-ups like `這份文件 / 那份文件 / 這個文件` prefer direct detail lookup from the same-session `active_doc`, ordinal follow-ups like `第一份 / 第二份 / 打開第一個` resolve only against the same-session `active_candidates`, and switching to another session starts from an isolated context instead of reusing the previous chat's candidates
- `src/executive-planner.mjs` now also exposes a minimal `runPlannerToolFlow(...)` helper that performs `select -> preset|dispatch / fallback`, returning `{ selected_action, execution_result, synthetic_agent_hint, trace_id }` and logging under `stage=planner_end_to_end`
- the same planner output now adds only a bounded `synthetic_agent_hint` field derived from explicit `lane` / `taskType` hints first, then a small checked-in action-to-lane mapping; this is deterministic metadata, not a generic agent handoff engine, and it is not treated as execution evidence
- the same end-to-end helper now also adds a minimal response formatter after successful company-brain read-side execution: search returns a compact file list (`title`, `doc_id`), detail returns `title + content_summary`, `search_and_detail_doc` returns either `title + match_reason + content_summary`, an explicit not-found result, or a bounded candidate list when search ambiguity prevents safe auto-detail; planner-facing formatted output is exposed in sibling `formatted_output` fields while `execution_result` remains the raw runtime result
- those planner-side company-brain read behaviors are now internally gathered under `src/planner-doc-query-flow.mjs`, so `executive-planner.mjs` remains the stable public planner surface while the reusable doc-query pipeline owns session-scoped hard routing context reuse, ambiguity handling, payload shaping, formatted read output, and minimal internal debug trace events for route/result diagnostics
- `src/planner-flow-runtime.mjs` now defines the minimum reusable planner flow interface used by the planner runtime: a flow can own `route`, `shapePayload`, `readContext`, `writeContext`, `formatResult`, and internal tracing, while `executive-planner.mjs` stays responsible only for orchestration / dispatch / preset execution and can attach more than one flow later without changing the external planner contract
- planner flow selection now uses an explicit ownership contract rather than list order or hidden ranking: `runtime_info` is the single owner for runtime-health queries; `okr`, `bd`, and `delivery` each own only one themed company-brain document lane plus same-theme follow-ups; `doc_query` is the generic company-brain document owner; and when more than one themed flow claims the same query, the runtime falls back to `doc_query` instead of choosing via implicit priority, keyword-hit scoring, or declaration order
- `src/planner-conversation-memory.mjs` now adds a minimal planner conversation summary layer backed by a small JSON store keyed by `sessionKey`: after enough turns or accumulated prompt text, planner runtime compacts previous exchanges into per-session `latest_summary`, keeps only bounded same-session `recent_messages`, auto-loads persisted memory on startup, writes back after compact/record updates, and lets later planner prompts use `system prompt + same-session latest_summary + recent dialogue + current user query` instead of replaying the full conversation history; the compacted summary now includes `active_theme` alongside `active_doc` / `active_candidates`, and a manual compact entry also exists for controlled summarize/checkpoint use
- the same session store now also carries a minimal working-memory v2 block (`task_id`, `task_type`, `task_phase`, `task_status`, `current_owner_agent`, `previous_owner_agent`, `handoff_reason`, `retry_count`, `retry_policy`, `slot_state`, `execution_plan`, plus v1-compatible fields): `execution_plan` is session-level only and currently includes `plan_id`, `plan_status`, `current_step_id`, ordered `steps[]` (`step_id`, `step_type`, `owner_agent`, `intended_action`, `status`, `depends_on`, `retryable`, `artifact_refs`, `slot_requirements`), and artifact/dependency graph v1 (`artifacts[]`, `dependency_edges[]`); pre-routing now prioritizes active-plan step continuation, waiting-user slot-fill resume, and bounded retry same-step resume before selector fallback, and additionally validates current-step incoming artifact dependencies (invalid/missing hard dependency blocks continuation and routes recovery `rollback_to_step` first, else fail-closed `ask_user`; soft dependency emits diagnostics only); topic-switch phrasing invalidates old plan context and starts a new task/plan id while keeping old plan artifact graph as historical session evidence without reusing it for new-plan routing; `slot_state.ttl` is enforced so stale slots do not affect later turns; write-back remains centralized at the answer boundary as patch updates only (no mid-planner full overwrite, no standalone workflow engine)
- `src/executive-planner.mjs` now also applies an explicit planner context window before decision prompting: prompt assembly prefers `focused_task`, `recent_steps`, and `high_weight_doc_summaries`, then fits bounded `planner_task_context`, `latest_summary`, `active_task`, and `recent_dialogue` into a local char budget; overflowed lower-priority context is summarized into `older_context` or dropped instead of replaying long raw JSON blobs
- `src/planner-runtime-info-flow.mjs` now provides the second concrete planner flow on top of that interface: it owns hard-route detection for `get_runtime_info`, including direct runtime-health wording such as `runtime`, `runtime status`, `db path`, `pid`, `cwd`, `運行資訊`, `系統狀態`, `穩不穩`, and `風險`, keeps a no-op flow context, and formats successful runtime-info reads into a stable `formatted_output.kind=get_runtime_info` block so runtime action naming stays canonical on that path without changing the planner's public response shape
- `src/planner-okr-flow.mjs` now provides the third concrete planner flow: it detects OKR / KR / 目標 / 關鍵結果 / 週進度 / 本週 todo style knowledge queries, routes them into the existing company-brain document query chain, reuses doc-query context/ambiguity/formatter behavior, and keeps that topic-specific logic out of `executive-planner.mjs`
- `src/planner-bd-flow.mjs` now provides the fourth concrete planner flow: it detects BD / 商機 / 客戶 / 跟進 / demo / 提案 style knowledge queries, routes `整理|進度|跟進|分析` requests into `search_and_detail_doc`, otherwise uses `search_company_brain_docs`, reuses doc-query context/ambiguity/formatter behavior, and keeps that topic-specific logic out of `executive-planner.mjs`
- `src/planner-delivery-flow.mjs` now provides a delivery/onboarding knowledge flow: it detects 交付 / SOP / 驗收 / 導入 / onboarding style queries, routes `流程|解釋|整理|驗收` requests into `search_and_detail_doc`, otherwise uses `search_company_brain_docs`, and reuses the same doc-query pipeline/context instead of duplicating delivery-specific read logic in `executive-planner.mjs`
- `src/planner-action-layer.mjs` now provides a reusable themed action formatter for OKR / BD / delivery flows: it runs after the existing doc-query formatter and enriches successful themed results with a stable `formatted_output.action_layer` block (`summary`, `next_actions`, `owner`, `deadline`, `risks`, optional `status`) while keeping raw tool results and planner public response shape unchanged; v2 adds a minimal deterministic extraction pass for `detail` / `search_and_detail` results so labeled `owner / deadline / risks / status` can be surfaced when the underlying content summary already contains them
- `src/executive-planner.mjs` now also exposes a minimal `runPlannerMultiStep(...)` helper that accepts ordered `steps`, dispatches them sequentially through the same planner tool bridge, returns `{ steps, results, trace_id }`, and logs under `stage=planner_multi_step`
- `src/executive-planner.mjs` now also exposes a minimal `runPlannerPreset(...)` helper; the current presets are `create_and_list_doc`, `runtime_and_list_docs`, `search_and_detail_doc`, and `create_search_detail_list_doc`, all returning `{ ok, preset, steps, results, trace_id, stopped, stopped_at_step }`, deriving top-level `ok` from whether every step result succeeded, and defaulting to `stop_on_error=true` so later steps are skipped once an earlier step fails; for `search_and_detail_doc` and `create_search_detail_list_doc`, the detail step only auto-runs when search resolves to exactly one candidate, otherwise the preset returns after the search step so the caller can present either not-found or candidate-selection UI

### Verification Loop

`collect evidence -> validate -> pass/fail`

Implemented through:

- `src/executive-verifier.mjs`
- evidence stored in `src/executive-task-state.mjs`
- `src/executive-task-state.mjs` now serializes store mutations through one in-process queue, and append-style helpers (`evidence` / `verifications` / `reflections` / `improvement_proposals` / turns/handoffs/agent outputs) now apply task-local patching from the latest committed task snapshot instead of separate `read -> patch -> write` calls, reducing same-process lost-update races under overlapping finalize/update paths
- the same task-state store loader now includes a bounded retry on transient `null` JSON reads (for example, file read during partial write) before falling back to an empty store shape, reducing false `not_found`-style observations under short write/read overlap windows
- the verifier now reads only the task `execution_journal`; Phase-1 minimum journal fields are `classified_intent`, `selected_action`, `dispatched_actions`, `raw_evidence`, `fallback_used`, and `verifier_verdict`
- `supportingOutputs` no longer count as `tool_output`, `reply.text` no longer counts as `structured_output`, and synthetic planner lane hints do not count as execution evidence
- when `tool_required=true` and `dispatched_actions` is empty, verification cannot pass; no-dispatch paths fail or block instead of completing
- when `tool_required=true` and execution fell back to a generalist/text-only path, verification cannot complete and must remain `blocked` or `failed`

### Reflection Loop

`review what happened -> identify failure pattern`

Implemented through:

- `src/executive-reflection.mjs`
- `src/executive-closed-loop.mjs` now also derives a lightweight execution-reflection snapshot immediately after execution and before verification/improvement persistence: the pipeline first normalizes planner-step metadata into `execution_journal.planner_steps[]` with `{ intent, success_criteria }`, prefers explicit step metadata when present, falls back to task/work-plan/task-level success criteria when fields are missing, then returns a deterministic structured object with `overall_status` plus per-step `{ intent, success, success_match, deviation, reason }`; `success_match` records matched vs unmet success criteria, `deviation` is a bounded execution delta code, and `reason` is classified into controlled values such as `tool_failure`, `planning_error`, or `missing_info` instead of natural-language prose
- the checked-in top-level reflection record in `src/executive-reflection.mjs` now also classifies document access failures (`missing_access_token`, `permission_denied`, `document_not_found`) as `reason = "missing_info"` and marks `deviation = true` so downstream improvement logic can treat missing access/evidence as a knowledge/input gap instead of a generic tool failure
- `src/executive-evolution-metrics.mjs`
- `src/executive-evolution-replay.mjs`
- checked-in bounded replay fixtures now live under `/Users/seanhan/Documents/Playground/evals/executive-replay/fixtures`; each spec is local-only, deterministic, and safe to replay through `scripts/executive-evolution-replay.mjs` without re-driving external side effects
- `/Users/seanhan/Documents/Playground/scripts/executive-evolution-replay-pack.mjs` now runs the full checked-in replay pack, emits one bounded per-case line per fixture, and summarizes `improved_count / unchanged_count / regressed_count`; `--json` returns the same results as a single JSON object
- the same closed-loop finalize path now also archives a minimal local evolution snapshot per reflection and emits one structured `executive_evolution_metrics` log event with rolling local rates for:
  - `reflection_deviation_rate`
  - `improvement_trigger_rate`
  - `retry_success_rate`
- this metrics path is local-only: it reads the checked-in reflection archive, does not call any external service, and is intended for runtime/log inspection rather than a separate telemetry backend
- the bounded replay helper now re-runs the same task definition against two local run specs (`first_run`, `second_run`), reuses the checked-in execution-reflection and verifier rules for both passes, and returns `improvement_delta` across:
  - `success`
  - `steps`
  - `deviation`
- this replay path is reconstruction-only and local-only: it compares provided run artifacts, does not re-drive live external side effects, and does not claim exact raw-wire request replay

### Improvement Loop

`convert reflection into upgrade proposal`

Implemented through:

- `src/executive-improvement.mjs`
- memory stores in `src/executive-memory.mjs`
- workflow persistence and approval routes in `src/executive-improvement-workflow.mjs`
- `src/executive-improvement-workflow.mjs` now serializes reflection/proposal store writes per backing file through an in-process mutation queue, and exposes a bounded archived-reflection listing helper for task-scoped readback (`listArchivedExecutiveReflections(...)`) so verification/eval callers do not rely on global latest-row ordering under concurrent write traffic
- the same improvement-workflow store loader now includes a bounded retry on transient `null` JSON reads before defaulting to an empty store shape, reducing proposal/archive read flakiness under short write/read overlap windows
- `src/agent-learning-loop.mjs` now also derives review-first improvement proposals from persisted monitoring / trace history, including routing-failure summaries and suggested tool-weight adjustments

## Lifecycle States

- `created`
- `clarified`
- `planned`
- `executing`
- `awaiting_result`
- `verifying`
- `completed`
- `failed`
- `blocked`
- `escalated`
- `reflected`
- `improvement_proposed`
- `improved`

`completed` now requires evidence plus verifier pass.

`verifying` fail 只允許回到 `executing`、`blocked` 或 `escalated`，不允許直接以失敗驗證結果宣稱完成。

## Phase-1 Control Unification

- `active_task` 仍沿用 `executive-task-state.mjs`，但第一階段已補最小欄位：
  - `workflow`
  - `workflow_state`
  - `routing_hint`
  - `trace_id`
- `src/control-kernel.mjs` 現在收斂 `lane-executor.mjs` 的 follow-up owner 決策，輸出固定 `decision / matched_task_id / precedence_source / routing_reason / guard / final_owner`。
- `executive-orchestrator.mjs` 不再用 direct status patch 把 task 標成 `completed`；完成只能經 `executive-closed-loop.mjs` 的 verifier gate。
- `lane-executor.mjs` 現在先呼叫 `decideIntent(...)`，依 `final_owner` 決定 follow-up 應回 `executive`、`doc-editor` 或既有 lane；同 scope 的 cloud-doc 才能延續原 workflow，否則回既有 lane 決策。
- meeting / doc rewrite / cloud-doc 已接到最小 workflow-state machine；其他 workflow 仍待後續整合。

## Single-Machine Runtime Coordination Closure

- `src/single-machine-runtime-coordination.mjs` 現在是單機同 session orchestration 的唯一串行化 owner。
- `executive-orchestrator.mjs` 的 checked-in public entrypoints 現在都先經過同一條 `account_id + session_key` coordination queue，再進入 start / continue / apply / finalize。
- 這條線只處理單機單 process 內的協調責任，不宣稱跨機器分散式鎖或 background worker mesh。
- `clearActiveExecutiveTask(...)` 現在支援 `expectedTaskId` guard；舊 task 晚到的 completion 不可清掉同 session 較新的 active task owner。
- 因此目前已落地的 contract 是：
  - duplicate message suppression 仍由 `runtime-message-deduper.mjs` 處理 ingress 層
  - same-session execution ordering 由 `single-machine-runtime-coordination.mjs` 處理 orchestration 層
  - completion / blocked / retry / escalated 仍只由 verifier-gated lifecycle 收口

## Phase-2 Meeting Workflow Control

- `meeting` 現在是第一個受控 workflow，沿用同一份 `active_task` store，不另開第二套狀態機。
- 最小 workflow state 已落地：
  - `created -> capturing -> awaiting_confirmation -> writing_back -> verifying -> completed|retrying|waiting_user|blocked|failed|escalated`
- `lane-executor.mjs` 在 meeting start / preview / confirm 時會更新同 session `active_task`：
  - start capture -> `workflow="meeting"` + `workflow_state="capturing"`
  - summary preview -> `workflow_state="awaiting_confirmation"`
  - confirm write -> `workflow_state="writing_back"`
- meeting completion 不再因文檔寫入成功就直接完成；`executive-closed-loop.mjs` 會先進 verifier gate，再由 `recovery_decision_v1` 決定 `completed` 或 fail-soft recovery 狀態。
- 未經 confirm 的 meeting preview 不得 writeback，也不得進 `completed`。

## Phase-2 Doc Rewrite Workflow Control

- `doc rewrite` 已沿用同一套 `active_task` 控制骨架，不另開新的 workflow store。
- comment suggestion card / poller 只作為 ingress，現在也會落到同一個 preview helper、同一個 `awaiting_review` task、同一個 confirmation artifact。
- 最小 state 已落地：
  - `created -> loading_source -> drafting -> awaiting_review -> applying -> verifying -> completed|retrying|waiting_user|blocked|failed|escalated`
- rewrite preview 只會停在 `awaiting_review`，未 review / confirm 前不得 apply，也不得進 `completed`。
- `/api/doc/rewrite-from-comments` 是唯一 apply 入口；沒有同 document + 同 confirmation 的 `awaiting_review` task，就必須 fail-closed。
- apply 成功後仍需進 verifier gate；只有同時具備 rewrite diff、apply evidence、且未破壞結構，才可 `completed`。
- comment suggestion notification 成功前不得先 `mark_seen`；任何通知失敗都不得留下 partial success。

## Phase-2 Cloud-Doc Workflow Control

- `cloud doc` 也已沿用同一套 `active_task` 控制骨架，使用 `scope_key` 綁定 chat scope 或 drive/wiki 操作目標。
- 最小 state 已落地：
  - `created -> scoping -> previewing -> awaiting_review -> applying -> verifying -> completed|retrying|waiting_user|blocked|failed|escalated`
- preview route 只能進 `awaiting_review`；未 review 前不得 apply，也不得 `completed`。
- drive/wiki apply route 現在需要先有同 scope 的 preview/review task，不能直接繞過 review gate。
- apply 成功後仍需進 verifier gate；只有 scope 正確且有 apply evidence 才可 `completed`。
- `executor`、`lane`、`orchestrator`、HTTP route 都不得 direct `completed`；cloud-doc completion 只允許由 verifier gate 放行。
- preview 結果不視為完成；沒有 `preview_plan`、`apply_evidence`、`skipped_items/conflict_items` 的 cloud-doc apply 不得通過 verifier。

## Phase-2 Slice-3 Recovery Decision (recovery_decision_v1)

- `recovery_decision_v1` 目前是 finalize-verification-fail 後續行為的最小共用決策層，不改主流程 contract。
- input signals（既有欄位）：
  - `error`
  - `failure_class`
  - `retryable`
  - `retry_count`
  - `max_retries`
  - `workflow`
  - `verification`
- output fields（既有欄位）：
  - `next_state`
  - `next_status`
  - `routing_hint`
  - `reason`
- 最小決策表：
  - `retryable=true` 且 budget 未耗盡 -> `executing`（orchestrator 映射為 `workflow_state=retrying`，resume same task）
  - `effect_committed / commit_unknown / permission_denied / retryable=false` -> `escalated`
  - `missing_slot` -> `waiting_user`（lifecycle `blocked`）
  - 其餘不可安全續跑 -> fail-soft `blocked` 或 `failed`
- 接線位置（orchestrator finalize fail branches）：
  - `finalizeMeetingWorkflowTaskUnlocked(...)`
  - `finalizeDocRewriteWorkflowTaskUnlocked(...)`
  - `finalizeDocumentReviewWorkflowTaskUnlocked(...)`
  - `finalizeCloudDocWorkflowTaskUnlocked(...)`
- 邊界：
  - 不改 public API / response shape
  - 不是完整 escalation subsystem
  - 不對 `effect_committed` / `commit_unknown` 做自動重試
  - 不改 planner/router contract
  - 不新增獨立 escalation runtime

## Evidence Model

Closed-loop layer 對齊的 evidence 類型為：

- `tool_output`
- `file_created`
- `file_updated`
- `structured_output`
- `summary_generated`
- `action_items_created`
- `knowledge_proposal_created`
- `API_call_success`
- `DB_write_confirmed`

## Phase-3 Control Diagnostics

- `npm run control:diagnostics` 是 Phase 3 的 read-only daily-entry，固定輸出 `control_summary`、`routing_summary`、`write_summary`。
- control line 直接驗證 `src/control-kernel.mjs` 的 deterministic decision surface 與 `src/lane-executor.mjs` 的 integration callsite。
- write line 直接驗證 `src/write-guard.mjs` / `src/lark-write-guard.mjs` 的 deterministic guard 行為，並掃描既有 guarded runtime surface。
- routing line 只重用 `.tmp/routing-diagnostics-history/` 的 latest/previous archived evidence；若 snapshot 缺失，必須 fail-soft 回報 unavailable，而不是假裝 routing 正常。
- 這條路徑支援 `--json`、snapshot history、`--compare-previous`、`--compare-snapshot <run-id|path>`，但不重跑 runtime、不 auto-fix，也不改 gate。

## Improvement Approval Workflow

- `auto_apply` proposals are persisted through the same workflow record path, then evaluated via effect evidence: measurable `improved` keeps `status=applied`, while `same/regressed` is fail-soft `status=rolled_back`
- `auto_apply` records still keep explicit versioned traceability (`strategy_version`, `active_strategy_version`, `strategy_history`) plus rollback metadata when rollback is triggered
- `proposal_only` and `human_approval` proposals are persisted as pending items
- approval and apply are now explicit HTTP workflow steps instead of only task-local fields
- `verification_status` is tracked on the same proposal record (`pending|passed|failed`) and is updated by apply/rollback outcomes rather than by conversational status text
- a monitoring-driven learning summary can now draft the same pending improvement items without auto-applying them:
  - `GET /api/monitoring/learning`
  - `POST /agent/improvements/learning/generate`
- routing and tool-weight suggestions produced from monitoring stay human-review-first; they are archived as `pending_approval` until explicitly approved and applied
