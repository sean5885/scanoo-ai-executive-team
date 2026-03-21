# Workflow Regression Baseline

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Purpose

本文件整理目前已驗證可穩定執行的 workflow smoke / regression 基線命令。

目標是讓變更 `meeting`、`doc_rewrite`、`cloud_doc`、HTTP route、task-state harness 或 verifier gate 後，有一套固定的最低回歸檢查可跑。

若變更內容涉及 lane / planner / registered agent / meeting / cloud-doc 的 routing 決策，也應同步跑 deterministic routing eval baseline。

## Baseline Tiers

### 1. Smoke Baseline

用途：

- 快速確認 workflow 核心 gate 沒壞
- 適合在修改 orchestrator / verifier / task-state / route gate 後第一時間跑

命令：

```bash
node --test \
  tests/executive-task-state.test.mjs \
  tests/control-unification-phase2-meeting.test.mjs \
  tests/control-unification-phase2-doc-rewrite.test.mjs \
  tests/control-unification-phase2-cloud-doc.test.mjs
```

覆蓋：

- active_task store
- meeting gate
- doc_rewrite gate
- cloud_doc gate

### 2. Integration Baseline

用途：

- 確認 workflow 與 HTTP / lane / integration chain 沒有脫節
- 適合在修改 `http-server`、`lane-executor`、`meeting-agent`、cloud-doc scope routing 後跑
- 需要可綁定本地 loopback port 的環境，因為 `tests/http-server.route-success.test.mjs` 會啟動本地 HTTP server

命令：

```bash
node --test \
  tests/http-server.route-success.test.mjs \
  tests/cloud-doc-organization-regression.test.mjs \
  tests/lane-executor.test.mjs \
  tests/chain-integration.test.mjs
```

覆蓋：

- workflow HTTP preview/apply 路徑
- cloud-doc follow-up branch
- lane follow-up routing
- meeting / knowledge integration chain

### 3. Workflow-specific Baseline

用途：

- 只驗證單一 workflow 相關變更
- 適合小範圍修補後快速確認

#### Meeting

```bash
node --test \
  tests/control-unification-phase2-meeting.test.mjs \
  tests/meeting-agent.test.mjs \
  tests/chain-integration.test.mjs
```

#### Doc Rewrite

```bash
node --test \
  tests/control-unification-phase2-doc-rewrite.test.mjs \
  tests/http-server.route-success.test.mjs
```

#### Cloud Doc

```bash
node --test \
  tests/control-unification-phase2-cloud-doc.test.mjs \
  tests/cloud-doc-organization-regression.test.mjs \
  tests/http-server.route-success.test.mjs \
  tests/lane-executor.test.mjs
```

### 4. Monitoring Learning Baseline

用途：

- 驗證 monitoring-backed learning summary 沒有被歷史資料污染
- 驗證 top-N output 會保留最新的 routing/tool regression 樣本
- 驗證 CLI 與 HTTP route 對同一批樣本能穩定產生 deterministic learning summary

命令：

```bash
node --test \
  tests/agent-learning-loop.test.mjs \
  tests/http-monitoring.test.mjs
```

CLI 檢查：

```bash
node scripts/monitoring-cli.mjs learning 1 1
```

說明：

- `tests/agent-learning-loop.test.mjs` 會驗證 learning summary 連續執行結果一致，draft proposal 也保持穩定
- `tests/http-monitoring.test.mjs` 會驗證 `/api/monitoring/learning` 與 CLI `learning` 都覆蓋 monitoring-backed regression path，且 top-N 不會讓舊 high-score buckets 擠掉新樣本

## When To Run

### Run Smoke Baseline When

- 修改 `src/executive-task-state.mjs`
- 修改 `src/executive-orchestrator.mjs`
- 修改 `src/executive-closed-loop.mjs`
- 修改 `src/executive-verifier.mjs`
- 修改 workflow state / gate 邏輯

### Run Integration Baseline When

- 修改 `src/http-server.mjs`
- 修改 `src/lane-executor.mjs`
- 修改 `src/meeting-agent.mjs`
- 修改 `src/doc-comment-rewrite.mjs`
- 修改 `src/cloud-doc-organization-workflow.mjs`
- 修改 `src/monitoring-store.mjs`
- 修改 `src/agent-learning-loop.mjs`

### Run Workflow-specific Baseline When

- 只改單一 workflow 的 state / schema / route / verifier

## Slow Cases

以下測試目前仍屬較慢案例：

- `tests/meeting-agent.test.mjs`
- `tests/chain-integration.test.mjs`

其中：

- `meeting-agent.test.mjs` 內有幾個會走較長的 meeting preview / confirm 路徑
- `chain-integration.test.mjs` 的 meeting chain 也會拉長總時間

這些測試已可正常退出，但不適合當作每次小改動都必跑的最小 smoke。

## Test Harness Note

目前 workflow baseline 依賴以下 test harness / cleanup hooks：

- `tests/helpers/executive-task-state-harness.mjs`
- `src/executive-task-state.mjs`
  - `useInMemoryExecutiveTaskStateStoreForTests()`
  - `resetExecutiveTaskStateStoreForTests()`
  - `restoreExecutiveTaskStateStoreForTests()`
- `src/db.mjs`
  - `closeDbForTests()`
- `src/lark-content.mjs`
  - `disposeLarkContentClientForTests()`

## Script Entry

可使用最小 runner：

```bash
node scripts/run-workflow-baseline.mjs smoke
node scripts/run-workflow-baseline.mjs integration
node scripts/run-workflow-baseline.mjs meeting
node scripts/run-workflow-baseline.mjs doc-rewrite
node scripts/run-workflow-baseline.mjs cloud-doc
node scripts/run-workflow-baseline.mjs all
```

Routing eval regression gate baseline（v1）：

```bash
node scripts/routing-eval.mjs
node scripts/routing-eval.mjs --json
```

用途：

- 驗證 checked-in deterministic routing baseline 是否仍與 eval set 一致
- 這份 checked-in 結果即為 routing eval regression gate baseline v1
- 提供 `lane / planner_action / agent_or_tool / latency` 的固定 regression 量測
- 以 overall accuracy ratio `0.9` 作為強制門檻；`< 0.9` 時 CLI 會以 non-zero exit code 結束
- `--json` 模式會輸出完整結果與 `top_miss_cases`（前 10 筆錯誤）

目前 monitoring learning baseline 尚未納入 `scripts/run-workflow-baseline.mjs` 的 workflow-only runner；需要驗證這條路徑時，直接使用上面的 `node --test ...` 與 CLI 命令。
