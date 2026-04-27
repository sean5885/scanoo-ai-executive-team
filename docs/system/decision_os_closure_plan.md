# Decision OS Readiness Plan（v1, 2026-04-27）

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## 目標

把目前的「閉環核心已落地」推進到「可持續運轉的閉環 Decision OS（Beta production readiness）」。

本計劃只基於已提交程式碼與當前技術鏡像，不把尚未實作的能力當成既成事實。

## 基線（2026-04-27）

本輪基線來自當日實測（閉環核心 + company-brain 治理 + release/self-check）：

1. 並行跑指定測試組：`123 pass / 1 fail`
2. 失敗點：`tests/executive-improvement-workflow.test.mjs` 單測在同批並行時出現一次 `TypeError`（讀取空物件）
3. 同測試單獨執行：`2 pass / 0 fail`
4. 同一批改為 `--test-concurrency=1`：`124 pass / 0 fail`

結論：核心邏輯可用，但存在並行隔離/持久層穩定性風險，這是目前最優先修補面。

## 目前評分與目標評分

- 目前客觀分數：`76/100`（Beta+ / 準生產）
- 4 週目標：`85/100`

評分維度（固定）：

1. 閉環流程完整度（30 分）
2. verifier 與 evidence 嚴謹度（25 分）
3. company-brain 治理完整度（20 分）
4. 可靠性與並行韌性（15 分）
5. 可觀測性與營運可追蹤（10 分）

## 非目標（避免誤擴張）

1. 不把系統描述成背景 worker mesh 或自治 company-brain server
2. 不改 public API response shape（planner 單一 JSON、answer 順序契約維持）
3. 不繞過 review/conflict/approval/verification 邊界

## 4 週執行排程（有 owner、有截止日、有 exit criteria）

owner 以角色標示，啟動會議再映射到實際人名。

### Week 1（2026-04-27 ~ 2026-05-03）

主題：`WS-1 Runtime Durability & Concurrency Hardening`  
Owner：`Runtime/Core`

交付：

1. 盤點 `.data` / temp store 寫入路徑，補齊原子寫入與損毀防護（temp + rename + parse guard）
2. 測試用資料目錄全面唯一化（避免跨 suite 共用狀態）
3. 對 `executive-improvement-workflow` 與 `executive-closed-loop` 補壓力迴圈測試（最少 50 回合）
4. 新增「並行穩定性 smoke 命令」到 CI/本地 runbook

Exit criteria：

1. 目標測試組連跑 20 次零隨機失敗
2. `node --test --test-concurrency=8 <target-pack>` 與 `--test-concurrency=1` 結果一致
3. 沒有 `Unexpected end of JSON` / `Cannot read properties of null` 類 store race

### Week 2（2026-05-04 ~ 2026-05-10）

主題：`WS-2 Company-Brain Governance Closure`  
Owner：`Knowledge Governance`

交付：

1. review -> conflict -> approval-transition -> apply 的狀態圖補齊機器可驗證 invariants
2. apply 前置證據缺失時一律 fail-soft blocked（禁止假完成）
3. review/conflict/apply 路徑補齊 idempotency 案例（重放請求不重複副作用）
4. 對外僅維持既有受控 route，不增加未驗證 write path

Exit criteria：

1. `tests/company-brain-lifecycle-contract.test.mjs`、`tests/company-brain-review-approval.test.mjs` 全綠
2. lifecycle contract 自檢輸出 `company-brain lifecycle contract and apply gate are aligned`
3. 無 evidence 時不會出現 completed/applied 宣稱

### Week 3（2026-05-11 ~ 2026-05-17）

主題：`WS-3 Verifier Coverage & No-Bypass Guarantee`  
Owner：`Planner/Workflow`

交付：

1. 列出所有 high-risk write route（doc rewrite / company-brain apply / learning ingest / meeting writeback）
2. 為每條路由建立「必經 verifier gate」證據
3. 補齊 fake/partial/overclaim 測試樣本（含 structured output 缺欄位）
4. finalize 失敗路徑僅能回 `executing/blocked/escalated/retrying`，不得直接 completed

Exit criteria：

1. 高風險路由 100% 有 verifier pass/fail 可追蹤
2. `tests/executive-verifier.test.mjs`、`tests/executive-orchestrator.test.mjs`、`tests/mutation-verifier.test.mjs` 全綠
3. 人工注入 overclaim case 會被 verifier 擋下

### Week 4（2026-05-18 ~ 2026-05-24）

主題：`WS-4 Observability, Release Gates, Final Scoring`  
Owner：`Ops/Diagnostics`

交付：

1. `self-check` / `release-check` 加入 Decision OS 指標段（gate pass rate、blocked reasons、verification fail taxonomy）
2. 固定輸出週報（JSON + human 簡版），含分數、退化項、建議回滾點
3. 把 memory influence 與 routing closed-loop 指標接到同一份 readiness scoreboard
4. 進行最終回歸與打分，產出 v1 驗收報告

Exit criteria：

1. `npm run check:self -- --json`、`npm run check:release -- --json` 可輸出穩定欄位
2. `npm run release-check:ci` 在綠燈時能過 full-test gate
3. readiness scoreboard 可重跑、可比較、可追責

## 每週固定驗證命令（最低）

```bash
npm run test:ci
npm run check:self -- --json
npm run check:release -- --json
npm run routing:closed-loop -- rerun
node scripts/memory-influence-gate.mjs --json
```

閉環核心目標包（建議納入每週至少一次）：

```bash
node --test --test-concurrency=1 \
  tests/executive-lifecycle.test.mjs \
  tests/executive-verifier.test.mjs \
  tests/executive-closed-loop.test.mjs \
  tests/executive-orchestrator.test.mjs \
  tests/executive-improvement-workflow.test.mjs \
  tests/company-brain-write-intake.test.mjs \
  tests/company-brain-review-approval.test.mjs \
  tests/company-brain-lifecycle-contract.test.mjs \
  tests/mutation-verifier.test.mjs \
  tests/release-check.test.mjs \
  tests/system-self-check.test.mjs
```

## Definition Of Done（2026-05-25 結算）

必須同時滿足：

1. 並行穩定性：目標包連續 20 次無隨機失敗
2. no-evidence-no-complete：無 evidence 不可 `completed`，且有測試證據
3. no-verification-no-complete：所有 high-risk 路由不可繞過 verifier gate
4. company-brain apply gate：review/conflict/approval 缺任一條件即 blocked
5. release gate 完整：`release-check:ci` 維持 full-test gate
6. 文檔同步：`closed_loop.md`、`data_flow.md`、`modules.md`、`open_questions.md` 與程式碼一致
7. 最終評分 `>= 85/100`

## 風險與升級條件

以下情況必須進入 `blocked` 或 `escalated`，不可包裝成完成：

1. 缺少必要 evidence
2. verifier fail 且無安全重試路徑
3. approval/conflict 邊界未滿足
4. 同路徑重試後仍發生同型錯誤

## 追蹤文件（本計劃的事實鏡像）

如有不一致，以程式碼為準，並更新 open question：

- [closed_loop.md](/Users/seanhan/Documents/Playground/docs/system/closed_loop.md)
- [data_flow.md](/Users/seanhan/Documents/Playground/docs/system/data_flow.md)
- [modules.md](/Users/seanhan/Documents/Playground/docs/system/modules.md)
- [open_questions.md](/Users/seanhan/Documents/Playground/docs/system/open_questions.md)
