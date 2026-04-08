# Scanoo Lane Closeout Note (v1)

日期：2026-04-08
範圍：`aaec6a8`（capability lane mapping）到 `37850ac`（compare gap -> partial），已在 `main` (`bd36cc7`)。

## 1) 這輪修了什麼

- plugin dispatch 對 `requested_capability` 建立明確 mapping：
  - `scanoo_compare -> scanoo-compare`
  - `scanoo_diagnose -> scanoo-diagnose`
  - `scanoo_optimize -> knowledge-assistant`（fallback）
  - 位置：`src/lark-plugin-dispatch-adapter.mjs`
- 新增兩條 Scanoo 專用 lane（compare/diagnose），並保留 distinct lane identity。
  - 位置：`src/lane-executor.mjs`
- compare 與 diagnose 都加上固定輸出契約（固定段落順序）。
  - 位置：`src/lane-executor.mjs`、`tests/scanoo-compare-contract.test.mjs`、`tests/scanoo-diagnose-contract.test.mjs`
- compare 補上 fail-soft 證據路徑：query shaping、relevance gate、0/1/2+ evidence 分流（gap-only / partial / normal compare）。
  - 位置：`src/lane-executor.mjs`
- diagnose 補上 fail-soft 官方讀取路徑：docref resolve（含 title-only 搜索補 `document_id`）、explicit auth handoff、missing token 時回 bounded diagnose（非 generic）。
  - 位置：`src/lane-executor.mjs`
- Scanoo lane 補上 pre-timeout 機制：planner 超時前先留 fallback window，並避免 timeout 後重入 lane fallback。
  - 位置：`src/lane-executor.mjs`

## 2) 修完後現在的行為

- 顯式 `requested_capability=scanoo_compare|scanoo_diagnose` 時，先走 lane fast-path，再決定是否落回 planner。
- `scanoo-compare`：
  - 先嘗試 evidence search fallback。
  - 證據足夠時回正式 compare。
  - 僅單側或缺維度時回 partial comparison（含缺口）。
  - 無有效證據時回具體 gap report，不回泛化模板。
- `scanoo-diagnose`：
  - 有可解析 `document_id` + explicit user token 時，會強制 official read fallback。
  - 缺 token 時不假裝完成，回 bounded diagnose（context-backed 或 prompt-only）。
  - docref 只有 title 時，會先做受限 search 嘗試補 `document_id`。
- pre-timeout 發生時，Scanoo lane 先嘗試 lane-local fallback；若 fast-path 已接手，該輪不再重複 re-enter fallback。

## 3) 已消失的問題

- `requested_capability` 被文字 heuristics 蓋掉，導致 lane 不穩定命中。
- compare 在 evidence 不足時只能回 gap-only，無 partial compare 中間態。
- diagnose 在 missing token / docref resolve 失敗時退回 generic 失敗文案。
- planner timeout 後 Scanoo fallback 可能重入同一路徑。

對應回歸測試已通過（73/73）：
- `tests/lark-plugin-dispatch-adapter.test.mjs`
- `tests/lane-executor.test.mjs`
- `tests/scanoo-compare-contract.test.mjs`
- `tests/scanoo-diagnose-contract.test.mjs`

## 4) 仍存在但非 P0 的風險

- `scanoo_optimize` 仍無 dedicated lane，現在是 fallback 到 `knowledge-assistant`。
- compare query shaping 的指標詞目前是固定集合（`流量/轉化/留存/排名`），長尾指標可能抓不到。
- compare relevance gate 含硬編碼過濾詞（demo/test/stub/sample 等），可能誤排真實文件。
- diagnose official read 仍依賴 explicit user token；token 缺失時只能提供 bounded 判讀，不是正式驗證結論。

## 5) 下次若再做，優先順序

1. 補 `scanoo_optimize` dedicated lane 與對應 contract/test，移除目前 fallback-only 狀態。
2. 將 compare 指標詞與 relevance gate 規則配置化（避免硬編碼詞表造成漏抓/誤排）。
3. 強化 diagnose explicit-auth 與 docref resolve 的可觀測性（失敗原因分桶、可追蹤統計）。
4. 在 compare/diagnose fallback 後補更多 detail-read 對齊測試，降低「有結構但證據仍粗粒度」風險。
