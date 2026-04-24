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
  tests/write-guard.test.mjs \
  tests/executive-task-state.test.mjs \
  tests/control-unification-phase2-meeting.test.mjs \
  tests/control-unification-phase2-doc-rewrite.test.mjs \
  tests/control-unification-phase2-cloud-doc.test.mjs
```

覆蓋：

- active_task store
- shared write guard
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

#### Document Review / Triage

```bash
node --test \
  tests/document-review-triage-workflow.test.mjs
```

覆蓋：

- reusable internal document review / triage workflow execution
- structured result contract：`conclusion` / `referenced_documents` / `reasons` / `next_actions`
- evidence-first reply rendering：`結論 / 標記文件 / 下一步`
- verifier-gated completion for the read-only workflow path

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
- 修改 `src/write-guard.mjs`
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

## Deterministic Fixture Evals

### Document Workflow Fixture Smoke

用途：

- 用最小 deterministic fixture 快速檢查本地 `docs/system` read-side query 對常見文件流程問法沒有明顯退化
- 適合在補 retrieval fixture、整理 knowledge-service query 行為或做最小 smoke 驗證時使用
- 這不是正式 workflow completion verifier，也不替代 integration / route / planner 驗證

命令：

```bash
node scripts/doc-workflow-eval.mjs
```

覆蓋：

- checked-in document workflow fixture dataset：`evals/doc-workflow-set.mjs`
- synchronous `queryKnowledgeWithContext(...)` read-side smoke output：PASS / FAIL 與命中筆數

### Meeting Workflow Fixture Smoke

用途：

- 用最小 deterministic fixture 快速檢查 meeting summary / decisions / action items / blockers 的抽取腳本沒有明顯退化
- 適合在補 fixture、整理 meeting eval 腳本或做最小 smoke 驗證時使用
- 這不是正式 workflow completion verifier，也不替代 `tests/meeting-agent.test.mjs` 或 preview / confirm 路徑測試

命令：

```bash
node scripts/meeting-workflow-eval.mjs
```

覆蓋：

- checked-in meeting fixture dataset：`evals/meeting-workflow-set.mjs`
- deterministic smoke extractor output：`summary`、`decisions`、`action_items`、`blockers`

### Runtime Workflow Fixture Smoke

用途：

- 用最小 deterministic fixture 快速檢查 runtime health / status 類問法的 smoke runner 沒有明顯退化
- 適合在補 runtime fixture、整理 runtime read-side smoke 腳本或做最小驗證時使用
- 這不是正式 workflow completion verifier，也不替代 routing / planner / tool dispatch 的整合測試

命令：

```bash
node scripts/runtime-workflow-eval.mjs
```

覆蓋：

- checked-in runtime workflow fixture dataset：`evals/runtime-workflow-set.mjs`
- deterministic smoke runner output：PASS / FAIL 與固定 runtime mock answer 命中結果

### Executive Evolution Replay

用途：

- 用 bounded reconstruction 比較同一個 executive task 在 improvement 前後的兩次 run spec
- 適合在修改 `src/executive-closed-loop.mjs`、`src/executive-reflection.mjs`、`src/executive-improvement.mjs` 或 evolution metrics / replay judge 後快速確認 delta 判讀沒有退化
- 這不是 live request replay；它不重放外部 side effects，只重用 checked-in verifier / reflection 規則

命令：

```bash
npm run executive:replay -- path/to/replay-spec.json
npm run executive:replay -- path/to/replay-spec.json --json
npm run executive:replay-pack
npm run executive:replay-pack -- --json
```

輸入最小 shape：

```json
{
  "task": {
    "task_type": "search",
    "objective": "整理知識答案",
    "success_criteria": ["有可讀結論", "有來源證據"],
    "work_plan": []
  },
  "request_text": "幫我整理知識答案",
  "first_run": {},
  "second_run": {}
}
```

覆蓋：

- `success`
- `steps`
- `deviation`
- `improvement_delta`

### Workflow Timeout Governance Focused Pack

用途：

- 用最小 deterministic case pack 固定 cloud-doc / workflow slow-path 與 timeout family 的 judge
- 適合在修改 cloud-doc rereview fallback、usage-layer timeout summary、reply surface 或 timeout telemetry 後快速確認
- 這不是 live timeout 壓測；它是受控 governance pack

命令：

```bash
npm run eval:usage-layer:workflow-timeout-governance
```

覆蓋：

- `successful_but_slow`
- `timeout_acceptable`
- `timeout_fail_closed`
- `workflow_too_slow`
- `needs_fixture_mock`

### Real-user Prompt Loop Smoke

用途：

- 用少量 checked-in 真實使用者問法做最小人工檢視 loop，確認腳本可穩定列出任務並保留後續人工判讀入口
- 適合在整理 eval fixture、補真實問法樣本或建立手動 review 節奏時使用
- 這不是正式 verifier，也不會宣稱 task 已完成；目前只輸出 `TASK` 與 `RESULT: (manual check required)` 供人工續查
- 若需要把人工判讀結果落成 checked-in review artifact，可再執行 `node scripts/real-user-review-log.mjs "<task>" "<lane>" "<action>" "<result_quality>" "<issue>"` 追加一筆 JSON review record

命令：

```bash
node scripts/real-user-loop.mjs
node scripts/real-user-review-log.mjs "幫我整理今天會議重點並列出待辦" "meeting" "meeting_summary" "good" ""
```

覆蓋：

- checked-in real-user prompt dataset：`evals/real-user-tasks.mjs`
- deterministic console loop output：逐筆列出 task 與固定 manual-check marker
- manual review log append output：把單筆人工判讀結果寫到 `evals/real-user-review.json`

### Real-user Usability Regression

用途：

- 用最小 checked-in 真實問法 regression pack，自動鎖住目前 assistant-like chat 行為
- 適合在修改 `src/lane-executor.mjs`、`src/capability-lane.mjs`、`src/control-kernel.mjs`、`src/planner-user-input-edge.mjs` 或 user-facing reply normalization 後跑
- 這條線只保護 real-user usability surface，不擴功能、不改 routing 規則本身

命令：

```bash
npm run test:real-user-usability
```

覆蓋：

- checked-in real-user dataset：`evals/real-user-tasks.mjs`（目前 10 條最小使用者問法）
- automated assertions：
  - 不可掉到錯誤 capability lane
  - 不可落到 `no-match`
  - 回覆必須維持 assistant-style，而不是 system-style
  - 不可外漏 `internal` / `routing` / `lane` / `trace`
  - partial path 仍需有可交付內容
- deterministic reply snapshots：`tests/real-user-usability-regression.test.mjs`

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

Routing eval regression gate baseline（v2 / `routing-eval-baseline-v2`）：

Thread 36 operations checkpoint 固定了 runbook 與單一入口，但不改 routing 決策、不改 eval gate，也不新增 fallback。
Thread 40 diagnostics checkpoint 把 operator 決策入口收斂為單一 `diagnostics_summary`，但不新增 routing 邏輯、不改 routing 決策，也不新增 fallback。
Thread 41 history checkpoint 補上 diagnostics snapshot 歸檔、manifest、snapshot/tag compare，但不新增 routing 邏輯、不改 routing 決策，也不新增 fallback。
Thread 42 daily-entry checkpoint 補上固定 `routing:diagnostics` 日常入口、latest/previous/tag compare 檢視口徑與文件，但不新增邏輯、不改 routing 決策，也不新增 fallback。

```bash
node scripts/regression-check.mjs
node scripts/retrieval-realworld-eval.mjs
npm run routing:closed-loop
npm run routing:closed-loop -- rerun
npm run routing:diagnostics
npm run routing:diagnostics -- --compare-previous
npm run routing:diagnostics -- --compare-tag routing-eval-baseline-v2
node scripts/routing-eval.mjs
node scripts/routing-eval.mjs --json
node scripts/routing-eval.mjs --json > /tmp/routing-eval.json
node scripts/routing-eval-fixture-candidates.mjs --input /tmp/routing-eval.json
node scripts/routing-eval-fixture-candidates.mjs --input /tmp/routing-eval.json --previous /tmp/previous-routing-eval.json
node --test tests/routing-eval-decision-advice.test.mjs tests/routing-eval-closed-loop.test.mjs
```

Canary gate baseline（stability + routing + boundary）：

```bash
node scripts/run-canary.mjs --cases=100
node scripts/check-canary.mjs --strict
```

用途：

- 固定把 canary gate 壓成可重跑 JSON contract，不靠人工讀 log
- runner 固定輸出 `canary_run_report_v1`，包含：
  - `thresholds`
  - `metrics.routing_accuracy_ratio`
  - `metrics.boundary_accuracy_ratio`
  - `metrics.stability_ratio`
  - `gate.status`
  - `gate.degradation_reasons[]`
- checker 固定輸出 `canary_check_report_v1`
- `--strict` exit contract：
  - exit `0` = pass
  - exit `1` = fail

用途：

- `node scripts/regression-check.mjs` 提供最小的 read-side regression quick check，固定串接 `scripts/retrieval-eval.mjs`、`tests/routing-eval-lite.mjs`、`scripts/retrieval-realworld-eval.mjs`、`scripts/doc-workflow-eval.mjs` 與 `scripts/runtime-workflow-eval.mjs`
- `node scripts/retrieval-realworld-eval.mjs` 提供額外的 read-side retrieval smoke check，使用 checked-in 的真實問法風格 query set 量測 HIT / MISS 與命中率
- 驗證 checked-in deterministic routing baseline 是否仍與 eval set 一致
- 這份 checked-in 結果即為 routing eval regression gate baseline v2（`routing-eval-baseline-v2`）
- 提供 `lane / planner_action / agent_or_tool / latency` 的固定 regression 量測
- 提供 `diagnostics_summary` 單一決策視圖，以及 `top_miss_cases` / `error_breakdown` 到候選 fixture 的閉環轉換入口
- `npm run routing:closed-loop` 提供固定 `eval -> candidates -> review -> dataset -> eval` 操作入口，並把 artifact 寫到 `.tmp/routing-eval-closed-loop/<session-id>/`
- `npm run routing:diagnostics` 提供固定 read-only 檢視入口，預設直接看最新 snapshot，也可快速 compare 上一筆 snapshot 或既有 tag
- 以 overall accuracy ratio `0.9` 作為強制門檻；`< 0.9` 時 CLI 會以 non-zero exit code 結束
- `--json` 模式會輸出完整結果、`top_miss_cases`（前 10 筆錯誤）與完整 `diagnostics_summary`
- `scripts/routing-eval-fixture-candidates.mjs` 會把 `top_miss_cases` 與 `error_breakdown` 展開成 machine-readable candidate fixture input，供人工審查後加入 dataset
- `scripts/routing-eval-fixture-candidates.mjs --previous <run-json>` 會額外把 trend 與 decision advice 收進同一份 `diagnostics_summary`
- `prepare` / `rerun` 的 closed-loop artifact 統一為 `*-diagnostics-summary.{json,txt}`
- `tests/routing-eval-decision-advice.test.mjs`、`tests/routing-eval-closed-loop.test.mjs`、`tests/routing-diagnostics-cli.test.mjs` 會覆蓋 diagnostics summary 的 JSON / CLI 輸出

目前 monitoring learning baseline 尚未納入 `scripts/run-workflow-baseline.mjs` 的 workflow-only runner；需要驗證這條路徑時，直接使用上面的 `node --test ...` 與 CLI 命令。

## Planner Contract Gate

Thread 45 planner contract regression-gate checkpoint 將這條檢查固定成 repo-level regression gate，但不新增邏輯、不改 routing 決策，也不新增 fallback。

Thread 46 planner diagnostics daily-entry checkpoint 在既有 planner contract consistency gate 基礎上補上固定 `planner:diagnostics` 日常入口、單一 diagnostics summary、fail 處理順序與測試，但不新增邏輯、不改 routing，也不新增 fallback。

Thread 47 planner diagnostics history-snapshot checkpoint 在既有 daily-entry CLI 與 regression gate 之上補上 snapshot-only 歷史歸檔、manifest、相關測試與文件同步，但不新增 compare、不改 routing，也不新增 fallback 或 gate 變更。

Thread 49 unified-self-check checkpoint 在既有 routing diagnostics 與 planner diagnostics 基礎上，把兩條線收斂成單一 `self-check` verdict、統一 JSON summary、demo-release 對接、相關測試與文件同步；不新增邏輯、不改 routing、不新增 fallback，也不改 planner gate。

Thread 50 self-check history checkpoint 在既有 unified `self-check` 基礎上，補上 self-check 自身 snapshot 歷史、最小 manifest、`--compare-previous` / `--compare-snapshot <run-id|path>`、相關測試與文件同步；不改 routing、不新增 fallback、不改 planner gate，也不做 auto-fix。

Thread 51 release-check preflight checkpoint 在既有 `self-check`、routing diagnostics 與 planner gate 基礎上，補上單一 `release-check` merge/release preflight 入口、最小 human-readable / JSON 輸出、相關測試與文件同步；不改 routing、不新增 fallback、不改 planner gate，也不做 auto-fix。

Thread 52 release-check CI checkpoint 在既有 `release-check` preflight 基礎上，補上 `release-check:ci` 專用入口、固定最小 JSON 輸出與 strict exit code contract；不改 routing、不新增 fallback、不改 planner gate，也不做 auto-fix。

Thread 53 release decision layer checkpoint 在既有 `release-check` / `release-check:ci` 基礎上，把 fail triage 收斂為 `system_regression`、`control_regression`、`routing_regression`、`planner_contract_failure` 四條線，並把 `suggested_next_step` 升級成模組 / 檔案類型指引；不改 routing、不新增 fallback、不改 planner gate，也不做 auto-fix。

Thread 55 release history checkpoint 在既有 `release-check` / `release-check:ci` 基礎上，補上 release-check 自身 snapshot 歷史、最小 manifest、`--compare-previous` / `--compare-snapshot <run-id|path>`、相關測試與文件同步；不改 gate 規則、不新增 fallback、不做 auto-fix，也不重做新的 decision 系統。

Thread 59 action hint checkpoint 在既有 `release-check` / `daily-status` 提示層基礎上，補上固定格式 `action_hint`、對應 human-readable 下一步提示、相關測試與文件同步；不改 gate、不新增 fallback、不做 auto-fix，也不新增新的 decision / diagnostics 系統。

Thread planner-visible-skill observability checkpoint 在既有 skill promotion gate 上補進最小 runtime observability / regression watch / rollback guard：它只增加 selector/tool/boundary evidence、輕量 repo-wide check、相關測試與文件同步；不新增 skill、不改 public API、不改 skill surface policy，也不新增 fallback。

用途：

- 固定阻擋 planner contract drift，不更動 routing 決策
- 在 planner selector / preset / flow-route 相關變更後，第一時間確認 contract mirror 仍與 runtime 對齊
- 在 merge / release 前，用單一 preflight 入口壓縮 self-check、control、routing、planner 四條線的 operator 判斷
- 在 merge / release 前，提供完整 release decision layer：CI entry、strict exit code、最小 triage、模組級 next-step 指引
- 在 merge / release 前，保留最小 release-check 歷史歸檔與 compare checkpoint，方便只讀比對 release verdict 變化

命令：

```bash
npm run planner:diagnostics
node scripts/planner-contract-check.mjs
npm run planner:contract-check
npm run check:planner-visible-skill
npm run self-check
npm run self-check -- --compare-previous
npm run self-check -- --compare-snapshot <run-id|path>
npm run release-check
npm run release-check -- --compare-previous
npm run release-check -- --compare-snapshot <run-id|path>
npm run release-check:ci
npm run release-check:ci -- --compare-previous
npm run release-check:ci -- --compare-snapshot <run-id|path>
```

說明：

- `planner:diagnostics` 是固定日常入口，直接根據目前 checked-in runtime / contract 狀態輸出單一 diagnostics summary，不會重跑 planner
- `planner-contract-check` 本身是 read-only gate，不做 auto-fix
- `check:planner-visible-skill` 是 planner-visible skill 的最小 read-only regression watch；固定檢查 selector key 命中、planner-visible/internal-only split、answer-boundary evidence、fail-closed negative probe，以及既有 non-skill routing 是否保持不變
- `npm run self-check` 已固定包含同一個 planner contract gate，並會把 current planner 結果對最新 archived planner snapshot 做 compare（若存在）；同時也會固定帶入 lockfile dependency guardrails
- `npm run release-check` 是 release / merge 前的單一 preflight 入口；它重用同一份 self-check、control、dependency、routing、planner 證據，但把 operator-facing 輸出壓成 merge/release verdict
- `npm run release-check:ci` 是 CI / pipeline 專用入口；它重用同一份 report，只保留最小 JSON，並以 exit `0/1` 嚴格對應 pass/fail
- `npm run check:dependencies` 是新的 lockfile-only gate：
  - 掃描 repo 內所有 checked-in `package-lock.json`
  - 目前固定阻擋 `axios@1.14.1` 與 `axios@0.30.4`
  - 不改 runtime，不做 auto-fix，只提供 pass/fail 與最小 violation evidence
- `npm run daily-status` 也額外暴露 read-only compare：
  - `--compare-previous`
  - `--compare-snapshot <run-id|path>`
- daily-status compare 不新增自己的 archive；只重用同一份 `release-check` history 當 compare target
- `planner:diagnostics` 與 `planner:contract-check` 每次執行都會額外把當次 JSON report 歸檔到 `.tmp/planner-diagnostics-history/`
- `self-check` 每次執行也會額外把 unified JSON report 歸檔到 `.tmp/system-self-check-history/`
- `release-check` / `release-check:ci` 每次執行也都會額外把當次 report 歸檔到 `.tmp/release-check-history/`
- archive 是 snapshot-only：
  - manifest: `.tmp/planner-diagnostics-history/manifest.json`
  - snapshots: `.tmp/planner-diagnostics-history/snapshots/<run-id>.json`
- unified self-check archive 也是 snapshot-only：
  - manifest: `.tmp/system-self-check-history/manifest.json`
  - snapshots: `.tmp/system-self-check-history/snapshots/<run-id>.json`
- release-check archive 也是 snapshot-only：
  - manifest: `.tmp/release-check-history/manifest.json`
  - snapshots: `.tmp/release-check-history/snapshots/<run-id>.json`
- unified self-check manifest per-run entry 固定最小欄位為：
  - `run_id`
  - `timestamp`
  - `system_status`
  - `control_status`
  - `routing_status`
  - `planner_status`
- manifest per-run entry 固定最小欄位為：
  - `run_id`
  - `timestamp`
  - `gate`
  - `undefined_actions`
  - `undefined_presets`
  - `undefined_routing_reasons`
  - `selector_contract_mismatches`
  - `deprecated_reachable_targets`
- snapshot 檔內容為該次 CLI 對應的完整 JSON diagnostics report
- `self-check` 現在也額外暴露 unified compare CLI：
  - `--compare-previous`
  - `--compare-snapshot <run-id|path>`
- unified compare human output 固定只回答：
  - `system` 變好 / 變差 / 無變化
  - `control` 有無 regression
  - `routing` 有無 regression
  - `planner` 有無 regression
- `release-check` human output 固定只回答：
  - `能否放心合併/發布`
  - `若不能，先修哪一條線`
  - `下一步`
- `release-check -- --json` 固定只保留：
  - `overall_status`
  - `blocking_checks`
  - `suggested_next_step`
  - `action_hint`
  - `failing_area`
  - `representative_fail_case`
  - `drilldown_source`
- `blocking_checks` 固定只分類成：
  - `system_regression`
  - `control_regression`
  - `routing_regression`
  - `planner_contract_failure`
- `suggested_next_step` 固定維持單行，但要點到模組族或檔案類型：
  - system regression -> agent registry / route contract / service modules
  - control regression -> control-kernel / lane-executor modules
  - routing regression -> routing rule modules 或 eval fixture files
  - planner contract failure -> planner registry / flow-route modules，`planner_contract.json` 只在 intentional stable target 時才看
- `action_hint` 固定只重用既有 `suggested_next_step` / drilldown：
  - routing -> `run routing-eval and inspect <area> fixtures`
  - planner -> `run planner-contract-check and fix <type> mismatch`
  - release -> `inspect blocking_checks and representative_fail_case`
- `release-check:ci` exit contract 固定為：
  - exit `0` = `pass` = 可放行到下一個 merge/deploy stage
  - exit `1` = `fail` = 阻擋 merge/deploy，先修 `blocking_checks[0]`
- release-check archive manifest per-run entry 固定最小欄位為：
  - `run_id`
  - `timestamp`
  - `overall_status`
  - `blocking_checks`
  - `suggested_next_step`
- `release-check` / `release-check:ci` 現在也額外暴露最小 compare CLI：
  - `--compare-previous`
  - `--compare-snapshot <run-id|path>`
- release-check compare 固定只回答：
  - `release` 狀態變好 / 變差 / 無變化
  - `blocking_checks` 是否改變
  - `suggested_next_step` 是否改變
- daily-status compare 固定只在原本 daily answer 上補最小 regression signal：
  - `changed_line`
  - `change_reason_hint`
  - `action_hint`
  - human-readable 只多一行 `下一步`
- `change_reason_hint` 來源固定重用：
  - routing -> routing diagnostics/history compare 的 `doc` / `meeting` / `runtime` / `mixed`
  - planner -> planner diagnostics/current gate 的 `contract` / `selector`
  - release -> `blocking_checks[0]`
- `action_hint` 固定只重用既有 compare signal：
  - routing -> `run routing-eval and inspect <area> fixtures`
  - planner -> `run planner-contract-check and fix <type> mismatch`
  - release -> `inspect blocking_checks and representative_fail_case`
- fail 條件僅限：
  - `undefined actions > 0`
  - `undefined presets > 0`
  - `undefined routing reasons > 0`
  - `selector/contract mismatches > 0`
- planner-visible skill watch rollback trigger 僅限：
  - `selector_drift`
  - `answer_bypass`
  - `regression_break`
  - `routing_mismatch`
- 固定 diagnostics summary 欄位為：
  - `gate`
  - `undefined_actions`
  - `undefined_presets`
  - `undefined_routing_reasons`
  - `selector_contract_mismatches`
  - `deprecated_reachable_targets`
- 若 `gate = fail`，decision 提示固定為：
  - 預設先修 planner 實作
  - 只有在 target 確實是 intentional / stable planner surface 時，才補 contract，且必須明確說明原因
  - `deprecated_reachable_targets` 只提示，不阻擋 gate

### Run Planner Contract Check When

- 每次改 planner / contract 後先跑 `npm run planner:diagnostics`
- 每次改 planner-visible skill selector / dispatch / answer-boundary 相關程式時，同步跑 `npm run check:planner-visible-skill`
- 修改 `docs/system/planner_contract.json`
- 修改 `src/executive-planner.mjs` 中的 planner tool registry / preset registry / selector 輸出
- 修改 `src/planner/skill-bridge.mjs`
- 修改 `src/user-response-normalizer.mjs`
- 修改 `src/planner-visible-skill-observability.mjs`
- 修改 `src/router.js` 的 planner hard-route target
- 修改任何 planner flow route target：
  - `src/planner-doc-query-flow.mjs`
  - `src/planner-runtime-info-flow.mjs`
  - `src/planner-okr-flow.mjs`
  - `src/planner-bd-flow.mjs`
  - `src/planner-delivery-flow.mjs`
- 修改會改變 planner action/preset target name 或 target kind 的 contract-adjacent code
- 修改 planner/answer/registered-agent 共用的 canonical envelope 邊界：
  - `src/executive-planner.mjs`
  - `src/user-response-normalizer.mjs`
  - `src/agent-dispatcher.mjs`

### Update Contract Vs Fix Planner

- 允許更新 contract：
  - runtime 已經有意圖地引入穩定 target，只是 checked-in contract mirror 尚未同步
  - target kind 與 target name 已確定，而且要反映的是預期介面，不是 accidental behavior
- 應修 planner 實作而不是改 contract：
  - selector/flow route 發出了不該存在的 target
  - `action` / `preset` slot 用錯
  - 想靠擴充 contract 來容納 legacy / deprecated / accidental route output

### Fail Handling Order

1. 先跑 `npm run planner:diagnostics`
2. 若 `gate = fail`，先修 planner 實作，再重跑同一個 diagnostics summary
3. 只有確認 target 是 intentional / stable contract surface 時，才更新 `docs/system/planner_contract.json`，並在同一個變更說清楚原因
4. 若只剩 `deprecated_reachable_targets`，視為 warning；不阻擋 gate，但應列入後續清理
5. 準備 merge / release 前再跑 `npm run planner:contract-check` 或 `npm run self-check`

### Run Release Check When

- 本地手動確認 merge/release 風險時，跑 `npm run release-check`
- PR 涉及 planner contract、selector/route wiring、release gate script、或相依的 `docs/system` 治理文件時，PR pipeline 必跑 `npm run release-check:ci`
- merge 到受保護分支前，merge gate 必跑 `npm run release-check:ci`
- 正式 release / deploy 前，release pipeline 必須重新跑 `npm run release-check:ci`

Minimal platform-neutral CI shape:

```bash
npm ci
npm test
npm run release-check:ci
```
