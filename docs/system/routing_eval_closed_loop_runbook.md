# Routing Eval Closed-Loop Runbook

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

Operations checkpoint: Thread 36

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

這一步的目的是先確認目前 checked-in routing 行為與 eval dataset 的落差，不先改資料。

### 2. Candidates

同一次 `prepare` 會直接產出：

- `03-routing-eval-candidates.json`

這份資料來自既有 `top_miss_cases` 與 `error_breakdown` 展開，不會自動寫回 dataset。

### 3. Review

人工審核 `03-routing-eval-candidates.json` 與 `04-review-checklist.md`。

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

只有 rerun 後 gate 與審查結果一致，這輪 closed-loop 才算收口。

## Decision Rules

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

如果沒有任何 intended behavior change，只是 coverage 不足，這就是 dataset-only 更新。

### 何時需要改 routing rule

需要進 routing rule 變更，而不能只補 dataset，典型訊號是：

- 同一類 intent 反覆 miss，且 miss 不是單一語句標註問題
- `observed_actual_route` 明顯違反產品預期或受控 route 邊界
- 你必須把錯誤行為寫進 dataset 才能讓 eval 變綠
- miss 反映的是 rule precedence、hard-route selector、workflow follow-up 判定本身錯了

遇到這種情況，應先開 routing rule 修改，再用同一個 runbook 驗證修改後的行為；不能用 dataset 掩蓋。

## Non-Goals

這份 runbook 不負責：

- 自動批准 fixture candidate
- 自動寫回 dataset
- 自動修改 routing rule
- 引入新的 fallback path
