# Workflow Kernel Spec v1

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Purpose

本文件封板目前已落地的 workflow 治理骨架，作為後續 `meeting`、`doc_rewrite`、`cloud_doc` 與新 workflow onboarding 的共同基線。

本規格只描述已存在於程式碼中的控制模式，不宣稱尚未落地的能力。

## Active Task Contract

最小 `active_task` contract 由 `src/executive-task-state.mjs` 承載，至少包含：

- `workflow`
- `workflow_state`
- `routing_hint`
- `trace_id`
- `status`
- `lifecycle_state`

常見擴充欄位：

- `objective`
- `task_type`
- `meta`
- `chat_id`
- `session_key`

`meta` 為 workflow-specific 擴充區，現有用法包括：

- `meeting`
  - `confirmation_id`
- `doc_rewrite`
  - `document_id`
  - `confirmation_id`
- `cloud_doc`
  - `scope_key`
  - `scope_type`
  - `preview_plan`

## State Transition Ownership

workflow state 的推進權限必須收斂，避免多個模組同時寫狀態。

### Primary Owners

- `src/executive-orchestrator.mjs`
  - workflow-specific state transition owner
  - 負責初始化 workflow task、推進 `workflow_state`、同步 `status`
- `src/executive-closed-loop.mjs`
  - verifier gate owner
  - 負責 `verifying -> completed|blocked|retry` 的收口決策
- `src/single-machine-runtime-coordination.mjs`
  - same-session single-process coordination owner
  - 負責把 orchestrator public entrypoints 串成單一路徑，避免同一 session 的 start / apply / finalize 互相重疊

### Allowed Non-terminal Writers

以下模組可在自己的階段內觸發 workflow 前進，但不擁有 terminal 決策權：

- `src/control-kernel.mjs`
  - follow-up routing decision owner
  - 把 `same session -> same workflow -> same scope if required -> lane fallback` 收斂成單一 source of truth
- `lane-executor`
  - 只能消費 `decideIntent(...)` 的結果後 dispatch 對應 owner
  - 不可直接寫 terminal state
- `http route`
  - 可建立 preview/apply 入口所需上下文
  - 不可直接寫 terminal state
- workflow executor / specialist module
  - 可產出 preview / apply 所需結果
  - 不可自行宣告完成

### Forbidden State Jumps

- `executor` / `lane` / `http route` 不可直接寫：
  - `completed`
  - `blocked`
- 非 owner 模組不可跨階段跳 state，例如：
  - `created -> applying`
  - `previewing -> completed`
  - `awaiting_review -> completed`

## status / lifecycle_state / workflow_state 關係

三者用途不同，不應混用。

### `workflow_state`

- 用途：
  - workflow 內部控制狀態
  - 描述該 workflow 目前卡在哪個階段
- 例子：
  - `capturing`
  - `awaiting_review`
  - `applying`
- 對 workflow 控制來說，這是最直接的 source of truth

### `lifecycle_state`

- 用途：
  - closed-loop 任務治理狀態
  - 描述 task 在 executive lifecycle 內的位置
- 例子：
  - `created`
  - `executing`
  - `awaiting_result`
  - `verifying`
  - `completed`

### `status`

- 用途：
  - 簡化後的運行狀態
  - 給 routing、UI、簡單查詢用
- 例子：
  - `active`
  - `completed`
  - `blocked`

### Source of Truth Rule

- workflow 階段控制：
  - 以 `workflow_state` 為主
- closed-loop completion / blocked / retry 決策：
  - 以 `lifecycle_state` + verifier outcome 為主
- `status` 只做摘要，不應單獨作為 gate 依據

### Conflict Avoidance

- 不應只看 `status === active` 就允許 follow-up 直接套用
- 不應只看 `workflow_state` 就跳過 lifecycle/verifier gate
- terminal 判定應以 verifier 後的 lifecycle/status 同步結果為準
- 同一 `account_id + session_key` 的 workflow/executive entrypoint 不可平行寫 `active_task`；checked-in 路徑現在必須先經 `single-machine-runtime-coordination.mjs`
- 清理 `active_task` 時不可只看 `session_key`；terminal cleanup 必須同時確認 finishing task 仍是該 session 的當前 owner

## State Semantics

以下是跨 workflow 的共通語義層，不要求字面 state 完全一致，但要求語義對齊。

### INIT

- 任務已建立，但尚未進入主要執行階段
- 典型 state：
  - `created`
  - `loading_source`
  - `scoping`

### EXECUTING

- workflow 正在收集輸入、生成草稿、或建立預覽
- 典型 state：
  - `capturing`
  - `drafting`
  - `previewing`

### REVIEW

- 已有可審核輸出，但尚未允許套用或寫回
- 典型 state：
  - `awaiting_confirmation`
  - `awaiting_review`

### APPLYING

- 已經通過 review / confirm gate，開始執行實際寫入或套用
- 典型 state：
  - `writing_back`
  - `applying`

### VERIFYING

- workflow 已收集 apply / write evidence，等待 verifier 決定是否可完成
- 典型 state：
  - `verifying`

### TERMINAL

- workflow 已離開 active routing
- 典型 state：
  - `completed`
  - `blocked`

## Routing Rules

## Slow-path / Timeout Governance

目前 checked-in workflow slow/timeout 治理只落在最小 family 分類，不宣稱已完成全域 timeout runtime。

### Controlled Families

- `successful_but_slow`
  - workflow 有完成，但耗時超過本地 slow-warning 門檻
  - 允許留在成功路徑，但必須留下 slow telemetry，且使用層要明講這是可接受慢路徑
- `timeout_acceptable`
  - 子流程 timeout 後仍有受控 fallback，可交付保底結果
  - 不可假裝原本的深層流程已完成
- `timeout_fail_closed`
  - timeout 後沒有安全 fallback
  - 必須維持 fail-closed 邊界，不可回傳不完整結果
- `workflow_too_slow`
  - 尚未 timeout，但已慢到不能再包裝成正常完成
  - 應停在 workflow boundary / progress boundary，而不是 overclaim
- `needs_fixture_mock`
  - 目前 repo 沒有足夠 fixture/mock/本地上下文，不能把該 case 當真實 runtime 行為宣稱完成

### Current Code Truth

- cloud-doc 第二輪 rereview 現在會對 semantic rereview path 做 slow warning 與 timeout family telemetry
- rereview 成功但超過 slow-warning 門檻時，reply 會在 `摘要` 明講這是可接受慢路徑
- rereview 若遇到 `request_timeout`，會回退到本地 pending summary，並標成 `timeout_acceptable`
- rereview 若只是 `request_cancelled`，reply 只會表達流程被中斷，不會誤寫成 timeout
- HTTP `/answer` 的 request-level timeout 仍維持 fail-closed；這類屬於 `timeout_fail_closed`

## Routing Priority

follow-up 吸附優先順序應固定如下：

1. same session
2. same workflow
3. same scope if required
4. 否則回 planner / 既有決策流程

這個順序的目的，是避免 ambiguous follow-up 被錯誤吸附到舊 task。

### Session-first Routing

- 若同一 `session_key` 存在 non-terminal `active_task`，follow-up 優先考慮回原 workflow。
- 只有 `completed` 或 `blocked` 後，該 workflow 才應釋放 routing 主導權。

### Workflow Match

- follow-up 必須先命中同一 `workflow`。
- 未命中 workflow 時，回既有 planner / lane 決策流程。

### Scope Match

- 對需要 scope 的 workflow，不可只靠 session 命中。
- `cloud_doc` 目前要求：
  - 同 session
  - 同 workflow
  - 同 `meta.scope_key`
- scope 為 required 時，少任何一層都不應命中原 task。
- scope 未命中時，不得強行回舊 task。

### Routing Hint

- `routing_hint` 用於標記 workflow 預期的下一類 follow-up，例如：
  - `meeting_confirmation_pending`
  - `doc_rewrite_review_pending`
  - `cloud_doc_review_pending`
- `routing_hint` 是輔助訊號，不可取代 session/workflow/scope gate。

## Hard Constraints

以下限制適用於目前已受控的 workflow。

### 1. 不允許 Direct Completed

- `executor`
- `lane`
- `orchestrator`
- `http route`

以上模組都不得直接把 workflow 標成 `completed`。

### 2. 不允許繞過 Verifier

- apply / write 成功不等於完成
- completion 必須經 `src/executive-closed-loop.mjs` 的 verifier gate

### 3. REVIEW 前不得 APPLYING

- 未經 `awaiting_confirmation` 或 `awaiting_review`
- 不得進入 `writing_back` 或 `applying`

### 4. 不接受 Self-declared Success

- 不能只因 agent 回傳「已完成」
- 不能只因 route handler 執行成功
- 不能只因已有 preview 結果

就直接視為 workflow 完成

## WS-3 High-risk Write Verifier Coverage

WS-3 針對 high-risk write 補齊「no-verification-no-complete / no-bypass」最小保證，覆蓋目前已落地路徑：

- `meeting_confirm_write`
  - canonical admission 仍走 external write guard
  - `confirmed` 與 `verifier_completed` 任一缺失都會 deny（`confirmation_required` / `verifier_incomplete`）
- `document_comment_rewrite_apply`（`rewrite_apply`）
  - canonical admission 仍走 external write guard
  - `verifier_completed=false` 不可進入 apply 寫入
- `company_brain_apply`
  - internal write path 也必須帶 `verifier_completed=true`
  - mutation verifier profile 必須是 `knowledge_write_v1`，缺失或錯配會在 pre phase fail-closed
- `ingest_learning_doc` / `update_learning_state`
  - internal write path 也必須帶 `verifier_completed=true`
  - mutation verifier profile 必須是 `knowledge_write_v1`，缺失或錯配會在 pre phase fail-closed

對應實作來源：

- `src/mutation-admission.mjs`
  - internal high-risk write 的 verifier-completion deny gate
  - ready-route metadata 補上 `high_risk` 與 `verifier_gate_required`
- `src/mutation-verifier.mjs`
  - action-to-required-profile coverage map
  - missing/mismatch profile fail-closed verifier result

此外，workflow finalize fail-soft 路徑在 orchestrator 收斂為受控集合：

- verifier fail 後只允許進入 `executing`（`workflow_state=retrying`）/ `blocked` / `escalated`
- 不允許在 finalize fail path 停在 `failed` 或回寫 `completed`
- 對應實作：`src/executive-orchestrator.mjs`

## Verifier Contract

所有受控 workflow 至少都要滿足：

- 有 `structured_result`
- 有 apply / write evidence
- 有最小 schema 檢查
- 有欄位型別檢查
- 有非空或最低 coverage 檢查
- verifier fail 不得 `completed`

### Minimum Generic Checks

不分 workflow，verifier 至少應檢查：

- required field 是否存在
- required field 型別是否正確
- 關鍵欄位不是空值、空陣列、或無內容結構
- 關鍵集合欄位是否達到最低 coverage

最低 coverage 的例子：

- `action_items.length > 0`
- `preview_plan.moves` 為 array
- `patch_plan.length > 0`
- `skipped_items` 或 `conflict_items` 至少有一個集合欄位存在

現有 workflow-specific 最小 contract：

### Meeting

- `summary`
- `decisions`
- `action_items`
- owner coverage
- deadline coverage 或 `open_questions`
- `knowledge_writeback`

### Doc Rewrite

- rewrite diff 或 `patch_plan`
- apply evidence
- `structure_preserved === true`

### Cloud Doc

- `preview_plan`
- `apply_evidence`
- `skipped_items` 或 `conflict_items`
- `scope_key`
- preview 不可被當作完成結果

### Document Review

- `conclusion`
- `referenced_documents`
- `reasons`
- `next_actions`
- `document_count`
- 這是 read-only workflow，不走 apply/writeback，但仍必須帶 read-side evidence 與 verifier pass 才能 `completed`

verifier fail 後只允許：

- `blocked`
- retry path
- 或更高層 escalation

不可直接轉成 `completed`。

## Workflow Onboarding Checklist

新 workflow 接入前，至少應完成以下項目：

### Contract

- 定義 `workflow`
- 定義最小 `workflow_state`
- 定義 `routing_hint`
- 定義是否需要 `scope_key` 或等價 scope contract
- 定義 `structured_result` 最小 schema

### Control

- 接入 `active_task`
- 接入 review gate；若 workflow 是 read-only，必須明確記錄為「直接 `triaging -> verifying`」而不是隱含 apply
- 接入 applying / writeback gate；若 workflow 沒有 write path，必須在文件與 verifier contract 中明示
- 接入 verifier gate
- 確認沒有 direct completed path

### Routing

- 定義同 session follow-up 規則
- 定義 scope 命中規則
- 定義 terminal 後如何釋放 routing

### Verification

- 定義最小 evidence contract
- 定義 verifier checklist
- 定義 fail 後去向：`blocked` 或 retry

### Tests

- preview / draft 只能到 REVIEW
- REVIEW 前不得 APPLYING
- APPLYING 後必經 VERIFYING
- verifier fail 不得 completed
- 同 scope follow-up 回原 task
- 不同 scope 不得誤命中舊 task

## Test Harness

workflow 測試目前使用共用 test harness：

- `tests/helpers/executive-task-state-harness.mjs`

其作用：

- `before` 啟用 in-memory `executive-task-state`
- `beforeEach` / `afterEach` reset task state
- `after` 還原為預設 store 行為

相關 test-only hooks：

- `src/executive-task-state.mjs`
  - `useInMemoryExecutiveTaskStateStoreForTests()`
  - `resetExecutiveTaskStateStoreForTests()`
  - `restoreExecutiveTaskStateStoreForTests()`

## Test-only Cleanup Hooks

為避免 integration tests 殘留 open handles，現有 test-only cleanup hooks 包括：

- `src/db.mjs`
  - `closeDbForTests()`
- `src/lark-content.mjs`
  - `disposeLarkContentClientForTests()`

這些 hooks 僅供測試使用：

- 不改 production 預設初始化方式
- 不應在正式 runtime 中自動觸發

## Current Workflow Patterns

### Meeting

- `created -> capturing -> awaiting_confirmation -> writing_back -> verifying -> completed|blocked`

### Doc Rewrite

- `created -> loading_source -> drafting -> awaiting_review -> applying -> verifying -> completed|blocked`

### Cloud Doc

- `created -> scoping -> previewing -> awaiting_review -> applying -> verifying -> completed|blocked`

## Source of Truth

本規格對應的主要實作來源：

- `src/control-kernel.mjs`
- `src/executive-task-state.mjs`
- `src/executive-orchestrator.mjs`
- `src/executive-closed-loop.mjs`
- `src/executive-verifier.mjs`
- `src/lane-executor.mjs`
- `src/meeting-agent.mjs`
- `src/doc-comment-rewrite.mjs`
- `src/cloud-doc-organization-workflow.mjs`
