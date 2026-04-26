# Decision OS 閉環修正計劃（v1）

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## 目的

把現況從「有 closed-loop 元件」升級成「可驗證的真正閉環 Decision OS」。

必須同時滿足：

1. memory 有寫入且有 retrieval（決策前取回）
2. retrieval 會影響 strategy（非僅記錄）
3. retry 與 search 分流（有 candidate search，不是盲重試）
4. non-regression 可驗證且可回滾

## 現況摘要（2026-04-24）

- `node --test`：`1261 pass / 13 fail`
- `npm run eval:usage-layer`：`FTHR 60%`、`Generic Rate 40%`
- canary 腳本缺失：`scripts/run-canary.mjs`、`scripts/check-canary.mjs` 不存在
- memory 寫入已存在，但 retrieval-to-decision 鏈路未完整閉環
- learning 以 proposal 為主，缺少「生效 -> 驗證 -> 回滾」完整路徑

## 現況補記（2026-04-26）

- routing eval baseline 出現 `doc-038`、`doc-039` 漂移：deictic 文件跟進問句誤落 `personal_assistant + ROUTING_NO_MATCH`。
- 已在 `/Users/seanhan/Documents/Playground/src/planner-ingress-contract.mjs` 補上 deictic 文件 detail ingress，讓「這份文件在講什麼」「打開這份給我看」回到 `knowledge_assistant + search_and_detail_doc`。
- 對應回歸測試已補在 `/Users/seanhan/Documents/Playground/tests/message-intent-utils.test.mjs`。

## 修正範圍與原則

- 所有高風險區變更（planner/dispatch/routing/answer/knowledge write）必須 fail-soft，禁止 throw 掩蓋失敗。
- 不改 public response shape；若要強化約束，優先收斂 prompt/rules，而非破壞 contract。
- `completed` 必須同時滿足：success criteria + required evidence + verifier pass。
- docs 與 code 同步提交，不允許長期漂移。

## 分階段計劃

### Phase 0：恢復穩定基線（必做）

目標：先把回歸測試拉回綠燈，建立可信變更基準。

工作項：

1. 修復 `agent-latency-budget` 相關失敗（503/504 邊界一致性）
2. 修復 `agent-runtime-convergence` 相關失敗（single runtime authority + legacy fallback gate）
3. 修復 `/answer canary ingress` 失敗（rollout gate / force-canary / stall fail-fast）
4. 修復 planner fallback contract regression（錯誤型別穩定）
5. 修復 `test-db-guardrails` direct import 問題

驗收：`node --test` 全綠。

### Phase 1：補齊 Canary 體系

目標：把穩定性與 routing 退化變成可重跑 gate。

工作項：

1. 新增 `scripts/run-canary.mjs`
2. 新增 `scripts/check-canary.mjs`
3. 建立 `evals/canary/cases.json`（含 timeout/routing/answer-boundary/fail-soft case）
4. 定義固定輸出 schema（單一 JSON object）與 fail gate

驗收：

- `node scripts/run-canary.mjs --cases=100`
- `node scripts/check-canary.mjs --strict`

### Phase 2：Memory 寫入與取回閉環

目標：memory 成為決策輸入，而非僅落盤。

工作項：

1. 在 planner ingress 增加 retrieval step（session memory + approved memory）
2. 將 retrieval 信號以受控欄位注入 planner context（不外漏內部 trace）
3. 增加 retrieval observability（是否命中、命中數、是否影響選擇）
4. 保持 fail-soft：retrieval miss 不得導致 hard fail

驗收：

- 需要上下文的 case 有可追蹤 retrieval evidence
- retrieval miss 時仍有可用回答

### Phase 3：Learning 影響策略（可控）

目標：learning 不只產 proposal，要能在可控風險下生效且可回滾。

工作項：

1. 將低風險 proposal 類別引入 `auto_apply`，高風險保留 `human_approval`
2. 加入策略版本化（apply_id/version）
3. 加入 rollback trigger（退化閾值、錯誤型別閾值）
4. 將 learning effect 與 verifier/evolution metrics 串接

驗收：

- 有「proposal -> apply -> verification -> pass/fail -> rollback(optional)」可追蹤鏈
- 無 evidence 不得宣稱 improved

### Phase 4：Retry 與 Search 分流

目標：遇到失敗先候選搜索，再決定 retry。

工作項：

1. 新增 candidate generation（route/tool/prompt variant）
2. 新增候選評分與選擇規則（可解釋）
3. 明確紀錄 `why_retry` 與 `why_search`
4. retry 只在 `retry_worthy + budget + no_conflict` 成立時進行

驗收：

- `retry_without_candidate` 比例下降
- search 成功率可量測

### Phase 5：Non-Regression 防線

目標：高風險區變更可控、可回退。

工作項：

1. 新路徑導入 `feature_flag`
2. contract tests + snapshot gate 覆蓋 planner/answer/error taxonomy
3. release-check 增加四要素 gate（memory/retrieval/learning/non-regression）
4. 高風險區差異檢查納入 CI

驗收：

- 關閉 flag 時舊行為不變
- 開啟 flag 時指標可觀測、異常可回滾

### Phase 6：文檔與事實同步

目標：避免 doc/code 漂移。

同步文件：

- `/Users/seanhan/Documents/Playground/docs/system/closed_loop.md`
- `/Users/seanhan/Documents/Playground/docs/system/data_flow.md`
- `/Users/seanhan/Documents/Playground/docs/system/modules.md`
- `/Users/seanhan/Documents/Playground/docs/system/open_questions.md`

規則：若文檔與程式碼不一致，以程式碼為當前事實，並記錄衝突到 `open_questions.md`。

## 驗收標準（Definition of Done）

1. `node --test` 全綠
2. usage-layer 指標改善（FTHR 上升、Generic Rate 下降）
3. canary 可穩定執行且有 fail gate
4. memory retrieval 進入決策鏈且可觀測
5. learning 有受控生效與回滾能力
6. 高風險區 contract 穩定，無未授權 response-shape 漂移
7. docs/system 與 code 同步完成

## 執行節奏（建議）

1. 第 1 週：Phase 0 + Phase 1
2. 第 2 週：Phase 2 + Phase 4
3. 第 3 週：Phase 3 + Phase 5 + Phase 6

## 風險與升級邊界

需要 escalated 的情況：

1. 缺少必要 evidence
2. verification 無法通過
3. 權限/approval/conflict 邊界未滿足
4. 同一路徑重試後仍無法安全完成

在上述條件未滿足前，不得以 partial/review-pending 包裝成 completed。
