# Routing Eval Closed-Loop Runbook

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

Operations checkpoint: Thread 36
Decision checkpoint: Thread 39

## Purpose

這份 runbook 把 routing closed-loop 固定成單一路徑：

`eval -> candidates -> review -> dataset -> eval`

它只負責 regression 操作流程與 dataset 維護節奏，不改 routing 邏輯，也不新增 fallback。

## Single Entrypoint

```bash
npm run routing:closed-loop
```

預設會執行 `prepare`：

1. 跑 routing eval
2. 產出 machine-readable fixture candidates
3. 建立 review checklist
4. 把 artifacts 寫到 `.tmp/routing-eval-closed-loop/<session-id>/`

常用 rerun 指令：

```bash
npm run routing:closed-loop -- rerun
```

若要指定 dataset 或工作目錄：

```bash
npm run routing:closed-loop -- prepare --dataset evals/routing-eval-set.mjs --out-dir .tmp/routing-eval-closed-loop
npm run routing:closed-loop -- rerun --session .tmp/routing-eval-closed-loop/<session-id>
```

## Fixed Flow

### 1. Eval

執行：

```bash
npm run routing:closed-loop
```

主要 artifact：

- `01-routing-eval.json`
- `02-routing-eval-report.txt`
- `07-initial-trend-report.json`
- `08-initial-trend-report.txt`
- `11-initial-decision-advice.json`
- `12-initial-decision-advice.txt`

這一步的目的是先確認目前 checked-in routing 行為與 eval dataset 的落差，不先改資料。

### 2. Candidates

同一次 `prepare` 會直接產出：

- `03-routing-eval-candidates.json`

這份資料來自既有 `top_miss_cases` 與 `error_breakdown` 展開，並可選擇帶入上一輪 run 產出 `trend` / `decision_advice`；它不會自動寫回 dataset。

### 3. Review

人工審核 `03-routing-eval-candidates.json`、`04-review-checklist.md`、`11-initial-decision-advice.json` 與 `12-initial-decision-advice.txt`。

審核時只接受兩種候選：

- 現有 checked-in 行為本來就是正確的，但 dataset 還沒覆蓋
- 現有 fixture 的 `expected` 已經過時或標錯

審核時必須拒絕：

- 只是把目前錯誤 routing 結果直接寫成新的 expected
- 企圖用 dataset 掩蓋應該由 routing rule 修正的 regression

### 4. Dataset

人工修改：

- [/Users/seanhan/Documents/Playground/evals/routing-eval-set.mjs](/Users/seanhan/Documents/Playground/evals/routing-eval-set.mjs)

處理原則：

- `update_existing_fixture`
  - 更新既有 case 的 `expected`
- `add_fixture`
  - 把 `fixture_source` 轉成新的 `createCase(...)` entry

這一步仍然是 dataset 維護，不是 baseline 自動更新。

### 5. Eval

dataset 修改後，重跑：

```bash
npm run routing:closed-loop -- rerun
```

rerun artifact：

- `05-rerun-routing-eval.json`
- `06-rerun-routing-eval-report.txt`
- `09-rerun-trend-report.json`
- `10-rerun-trend-report.txt`
- `13-rerun-decision-advice.json`
- `14-rerun-decision-advice.txt`

只有 rerun 後 gate 與審查結果一致，這輪 closed-loop 才算收口。

## Decision Rules

### 最小 decision advice 規則

closed-loop 會固定輸出一個 `minimal_decision`，只做摘要建議，不會自動執行任何變更。

- `ROUTING_NO_MATCH`
  - 若 `misses > 0` 或 `actual > matched`，建議補 fixture coverage
- `INVALID_ACTION`
  - 若 `misses > 0` 或 `actual > matched`，建議檢查 routing rule / action contract
- `FALLBACK_DISABLED`
  - 若 `actual > 0` 或 `misses > 0`，標記高風險，需人工審查
- accuracy trend
  - 相對前一次下降：輸出 warning
  - 相對前一次穩定：建議不動

CLI 與 JSON 只會挑一個最高優先級摘要，順序固定為：

1. `manual_review_high_risk`
2. `warn_accuracy_decline`
3. `check_routing_rule`
4. `review_fixture_coverage`
5. `no_change`

### 何時更新 baseline

更新 baseline 的前提是：

- routing 預期行為已經有明確決策
- 對應 code change 已經 checked in
- rerun eval 反映的是新的、刻意接受的 deterministic 行為

在這個 repo，baseline 實際上就是 checked-in eval dataset 加上 `0.9` gate。  
因此「更新 baseline」不是額外寫一份 golden 檔，而是在人為確認新的 routing 行為應被接受後，更新 dataset 並重新跑 eval。

### 何時只補 dataset

只補 dataset，而不動 routing rule，適用於：

- 新 query 形態屬於既有規則已經涵蓋的意圖，只是 dataset 沒收進來
- 現行實際 route 與產品預期一致，但 fixture 標註落後
- 需要補 context case，例如 `active_doc`、`active_candidates`、`active_theme`、workflow follow-up 狀態
- trend report 顯示新增或變動只落在單一 wording / context bucket，且對應實際 route 已符合既有 intended behavior

如果沒有任何 intended behavior change，只是 coverage 不足，這就是 dataset-only 更新。

### 何時補 fixture

補 fixture 是 dataset-only 的更具體子集，適用於：

- 新 wording、同義句、語序變體，實際 route 已命中既有正確 lane / action / tool
- 只缺 checked-in coverage，沒有 evidence 顯示 rule precedence 或 route boundary 出錯
- trend report 的新增差異能被解釋成「多了一個 bucket 觀測點」而不是「既有 bucket 準確率下降」

這時只需要把新 case 納入 dataset；不要順手改 routing rule。

### 何時需要改 routing rule

需要進 routing rule 變更，而不能只補 dataset，典型訊號是：

- 同一類 intent 反覆 miss，且 miss 不是單一語句標註問題
- `observed_actual_route` 明顯違反產品預期或受控 route 邊界
- 你必須把錯誤行為寫進 dataset 才能讓 eval 變綠
- miss 反映的是 rule precedence、hard-route selector、workflow follow-up 判定本身錯了
- trend report 顯示既有 lane / action bucket accuracy 下滑，而不是單純多一筆新 fixture
- 同一個 `error_breakdown` code 的 `misses` 持續增加，表示 hard-route 邊界或 precedence 出現 regression

遇到這種情況，應先開 routing rule 修改，再用同一個 runbook 驗證修改後的行為；不能用 dataset 掩蓋。

### 何時不動

以下情況應保持 code 與 dataset 都不動：

- current vs previous 的 `comparable_summary` 完全一致
- 差異只來自 latency 或 artifact 時間戳，routing accuracy / error buckets 沒變
- 差異已由同一輪刻意接受的 checked-in dataset 更新完整解釋，且 rerun 沒有留下新的 accuracy regression
- 無法從 code 與 checked-in fixture 證明 intended behavior；這時應先記錄 open question，而不是先改 dataset 或 rule

## Non-Goals

這份 runbook 不負責：

- 自動批准 fixture candidate
- 自動寫回 dataset
- 自動修改 routing rule
- 引入新的 fallback path
