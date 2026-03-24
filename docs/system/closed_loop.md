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
- `src/executive-planner.mjs` now also keeps the planner-generation prompt more deterministic for MiniMax-style low-variance text models by requiring a single JSON object, tightening `clarify` / `handoff` usage, constraining `pending_questions` / `work_items`, and explicitly separating company-brain `list` / `search` / `detail` intent classes so the model is told to prefer tool use before fail-soft stop when the user is asking to find or read documents
- `src/executive-planner.mjs` now also validates planner-tool input and successful output against [planner_contract.json](/Users/seanhan/Documents/Playground/docs/system/planner_contract.json) before and after dispatch; the current runtime check is intentionally minimal (`required` + simple `string/object/number` type checks) and fails soft by returning `ok=false` with `error=contract_violation` instead of throwing
- `src/executive-planner.mjs` now also validates final preset output against [planner_contract.json](/Users/seanhan/Documents/Playground/docs/system/planner_contract.json) only when the preset itself reports success; this check is also fail-soft (`ok=false`, `error=contract_violation`, `phase=preset_output`) and does not yet validate individual step outputs
- `src/executive-planner.mjs` now also normalizes planner action/preset failures into a minimal taxonomy (`contract_violation`, `tool_error`, `runtime_exception`, `business_error`, `not_found`, `permission_denied`) without overwriting an existing `error` value; planner runtime still fails soft and does not throw for these controlled error paths
- `src/executive-planner.mjs` now also applies a minimal retry policy inside `dispatchPlannerTool(...)`: only `tool_error` and `runtime_exception` are retried, the default retry budget is one extra attempt, `contract_violation` / `business_error` are not retried, and final responses carry `data.retry_count` while staying fail-soft
- `src/executive-planner.mjs` now also applies a minimal self-healing pass for input-side `contract_violation` before dispatch: missing required fields are filled with `null`/`""`, simple type mismatches are coerced with basic `String()` / `Number()` conversion, the healed payload is re-dispatched at most once, success responses are tagged with `data.healed=true`, and unrecoverable cases still return `contract_violation` fail-soft
- `src/executive-planner.mjs` now also hardens a minimal execution policy and fail boundary around planner actions/presets: `contract_violation` gets at most one self-heal attempt, `tool_error` and `runtime_exception` get at most one retry, `business_error` stops immediately, and final controlled failures are normalized into a shared stopped shape (`data.stopped=true`, `data.stop_reason=...`) without throwing
- `src/executive-planner.mjs` also now exposes a minimal `selectPlannerTool(...)` policy helper that maps `user intent / task type` to `selected_action + reason`; it now prefers compound presets before single-step actions, including `create_and_list_doc` for intents like “建立文件後列出知識庫” and `create_search_detail_list_doc` for intents like “建立文件並查詢” / `create then search`, and still returns `selected_action: null` with a fixed internal fallback reason when no rule matches. On the public `runPlannerToolFlow(...)` surface, that unmatched case is normalized into `execution_result.error = "business_error"` with `data.reason = "未命中受控工具規則，保持空選擇。"` while retaining internal `routing_reason = "ROUTING_NO_MATCH"` for diagnostics; user-facing callers must convert that controlled failure into natural language instead of exposing raw planner JSON or trace fields.
- `src/router.js` now adds a minimal hard pre-route helper for company-brain-style document intents before the normal planner selector runs. Explicit search wording keeps priority over generic detail cues like `內容`, so queries such as `搜尋有提到 OKR 的內容` still route to `search_company_brain_docs`; `整理|解釋` still route to `search_and_detail_doc`; pronoun/detail follow-ups reuse `activeDoc`, ordinal follow-ups reuse `active_candidates`, and direct action hits can now surface as plain action strings while preset/error results still use the object envelope.
- `src/executive-planner.mjs` now also keeps a minimal planner read context per `sessionKey`: successful `search_and_detail_doc` or `get_company_brain_doc_detail` results can seed `active_doc = { doc_id, title }`, successful ambiguous company-brain search results can seed `active_candidates = [{ doc_id, title }]`, themed knowledge flows can seed `active_theme = okr|bd|delivery`, later pronoun-style follow-ups like `這份文件 / 那份文件 / 這個文件` prefer direct detail lookup from the same-session `active_doc`, ordinal follow-ups like `第一份 / 第二份 / 打開第一個` resolve only against the same-session `active_candidates`, and switching to another session starts from an isolated context instead of reusing the previous chat's candidates
- `src/executive-planner.mjs` now also exposes a minimal `runPlannerToolFlow(...)` helper that performs `select -> preset|dispatch / fallback`, returning `{ selected_action, execution_result, synthetic_agent_hint, trace_id }` and logging under `stage=planner_end_to_end`
- the same planner output now adds only a bounded `synthetic_agent_hint` field derived from explicit `lane` / `taskType` hints first, then a small checked-in action-to-lane mapping; this is deterministic metadata, not a generic agent handoff engine, and it is not treated as execution evidence
- the same end-to-end helper now also adds a minimal response formatter after successful company-brain read-side execution: search returns a compact file list (`title`, `doc_id`), detail returns `title + content_summary`, `search_and_detail_doc` returns either `title + match_reason + content_summary`, an explicit not-found result, or a bounded candidate list when search ambiguity prevents safe auto-detail, while preserving the raw tool result in the same `execution_result`
- those planner-side company-brain read behaviors are now internally gathered under `src/planner-doc-query-flow.mjs`, so `executive-planner.mjs` remains the stable public planner surface while the reusable doc-query pipeline owns session-scoped hard routing context reuse, ambiguity handling, payload shaping, formatted read output, and minimal internal debug trace events for route/result diagnostics
- `src/planner-flow-runtime.mjs` now defines the minimum reusable planner flow interface used by the planner runtime: a flow can own `route`, `shapePayload`, `readContext`, `writeContext`, `formatResult`, and internal tracing, while `executive-planner.mjs` stays responsible only for orchestration / dispatch / preset execution and can attach more than one flow later without changing the external planner contract
- planner flow selection is now dynamic rather than list-order-only: when multiple flows return a route candidate, the runtime compares `priority` first (`runtime=100`, `okr=80`, `delivery=80`, `doc=10`) and then compares keyword-hit count from flow metadata before falling back to declaration order
- `src/planner-conversation-memory.mjs` now adds a minimal planner conversation summary layer backed by a small JSON store keyed by `sessionKey`: after enough turns or accumulated prompt text, planner runtime compacts previous exchanges into per-session `latest_summary`, keeps only bounded same-session `recent_messages`, auto-loads persisted memory on startup, writes back after compact/record updates, and lets later planner prompts use `system prompt + same-session latest_summary + recent dialogue + current user query` instead of replaying the full conversation history; the compacted summary now includes `active_theme` alongside `active_doc` / `active_candidates`, and a manual compact entry also exists for controlled summarize/checkpoint use
- `src/executive-planner.mjs` now also applies an explicit planner context window before decision prompting: prompt assembly prefers `focused_task`, `recent_steps`, and `high_weight_doc_summaries`, then fits bounded `planner_task_context`, `latest_summary`, `active_task`, and `recent_dialogue` into a local char budget; overflowed lower-priority context is summarized into `older_context` or dropped instead of replaying long raw JSON blobs
- `src/planner-runtime-info-flow.mjs` now provides the second concrete planner flow on top of that interface: it owns hard-route detection for `get_runtime_info`, including direct runtime-health wording such as `runtime`, `runtime status`, `db path`, `pid`, `cwd`, `運行資訊`, `系統狀態`, `穩不穩`, and `風險`, keeps a no-op flow context, and formats successful runtime-info reads into a stable `formatted_output.kind=runtime_info` block without changing the planner's public response shape
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
- the verifier now reads only the task `execution_journal`; Phase-1 minimum journal fields are `classified_intent`, `selected_action`, `dispatched_actions`, `raw_evidence`, `fallback_used`, and `verifier_verdict`
- `supportingOutputs` no longer count as `tool_output`, `reply.text` no longer counts as `structured_output`, and synthetic planner lane hints do not count as execution evidence
- when `tool_required=true` and `dispatched_actions` is empty, verification cannot pass; no-dispatch paths fail or block instead of completing
- when `tool_required=true` and execution fell back to a generalist/text-only path, verification cannot complete and must remain `blocked` or `failed`

### Reflection Loop

`review what happened -> identify failure pattern`

Implemented through:

- `src/executive-reflection.mjs`

### Improvement Loop

`convert reflection into upgrade proposal`

Implemented through:

- `src/executive-improvement.mjs`
- memory stores in `src/executive-memory.mjs`
- workflow persistence and approval routes in `src/executive-improvement-workflow.mjs`
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
- 第二階段才會把 meeting / 文件整理 / doc rewrite 完整接到 workflow-state machine。

## Phase-2 Meeting Workflow Control

- `meeting` 現在是第一個受控 workflow，沿用同一份 `active_task` store，不另開第二套狀態機。
- 最小 workflow state 已落地：
  - `created -> capturing -> awaiting_confirmation -> writing_back -> verifying -> completed|blocked`
- `lane-executor.mjs` 在 meeting start / preview / confirm 時會更新同 session `active_task`：
  - start capture -> `workflow="meeting"` + `workflow_state="capturing"`
  - summary preview -> `workflow_state="awaiting_confirmation"`
  - confirm write -> `workflow_state="writing_back"`
- meeting completion 不再因文檔寫入成功就直接完成；`executive-closed-loop.mjs` 會先進 verifier gate，再決定 `completed` 或 `blocked`。
- 未經 confirm 的 meeting preview 不得 writeback，也不得進 `completed`。

## Phase-2 Doc Rewrite Workflow Control

- `doc rewrite` 已沿用同一套 `active_task` 控制骨架，不另開新的 workflow store。
- 最小 state 已落地：
  - `created -> loading_source -> drafting -> awaiting_review -> applying -> verifying -> completed|blocked`
- rewrite preview 只會停在 `awaiting_review`，未 review / confirm 前不得 apply，也不得進 `completed`。
- apply 成功後仍需進 verifier gate；只有同時具備 rewrite diff、apply evidence、且未破壞結構，才可 `completed`。

## Phase-2 Cloud-Doc Workflow Control

- `cloud doc` 也已沿用同一套 `active_task` 控制骨架，使用 `scope_key` 綁定 chat scope 或 drive/wiki 操作目標。
- 最小 state 已落地：
  - `created -> scoping -> previewing -> awaiting_review -> applying -> verifying -> completed|blocked`
- preview route 只能進 `awaiting_review`；未 review 前不得 apply，也不得 `completed`。
- drive/wiki apply route 現在需要先有同 scope 的 preview/review task，不能直接繞過 review gate。
- apply 成功後仍需進 verifier gate；只有 scope 正確且有 apply evidence 才可 `completed`。
- `executor`、`lane`、`orchestrator`、HTTP route 都不得 direct `completed`；cloud-doc completion 只允許由 verifier gate 放行。
- preview 結果不視為完成；沒有 `preview_plan`、`apply_evidence`、`skipped_items/conflict_items` 的 cloud-doc apply 不得通過 verifier。

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

## Improvement Approval Workflow

- `auto_apply` proposals are persisted and marked applied immediately
- `proposal_only` and `human_approval` proposals are persisted as pending items
- approval and apply are now explicit HTTP workflow steps instead of only task-local fields
- a monitoring-driven learning summary can now draft the same pending improvement items without auto-applying them:
  - `GET /api/monitoring/learning`
  - `POST /agent/improvements/learning/generate`
- routing and tool-weight suggestions produced from monitoring stay human-review-first; they are archived as `pending_approval` until explicitly approved and applied
