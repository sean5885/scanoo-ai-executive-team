# System Health Check (Lobster)

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

本文件用來做目前 Lobster 系統的收口檢查。所有結論都以程式碼、設定、測試與已提交文檔為依據，不使用舊聊天上下文或推測補齊。

Last verified in this repo on 2026-04-28.

本次額外驗證：

- `node --test tests/release-check.test.mjs tests/system-self-check.test.mjs tests/planner-contract-closure.test.mjs tests/planner-contract-consistency.test.mjs`
- `npm run check:self -- --json`
- `npm run check:release -- --json`
- `npm run routing:closed-loop -- rerun`
- `node scripts/memory-influence-gate.mjs --json`
- `npm run release-check:ci`

## 0. WS-4 Observability And Readiness Gate

整體狀態：已收口（repo-code release gate 維持 pass）

- `check:self`：`ok=true`，`decision_os_observability` 已落地並輸出：
  - `readiness_score.score=100`
  - `readiness_score.level=ready`
  - `gate_summary=10/10 passed`
  - `verification_fail_taxonomy.status=pass`
  - `closed_loop_metrics.routing_closed_loop.status=pass`
  - `closed_loop_metrics.memory_influence.status=pass`（`scripts/self-check.mjs` / `src/release-check.mjs` 會注入 memory gate runner；runner 不可用時維持 fail-soft `unknown` fallback shape）
- `check:release` / `release-check:ci`：`overall_status=pass`，`decision_os_readiness` 已落地並輸出：
  - `final_score=100`
  - `readiness_level=ready`
  - `gate_pass_rate=1`
  - `blocked_reasons=[]`
  - `rollback_candidates=[]`
- `routing:closed-loop -- rerun`：`Eval gate: pass`、`Diagnostics summary: observe_only (info)`。
- `memory-influence-gate --json`：`gate=pass`、`memory_hit_rate=1`、`action_changed_by_memory_rate=1`。
- write rollout 現況仍維持既有高風險保守策略：
  - `meeting_confirm_write` 仍在 `warn`，原因為 `insufficient_real_request_backed_samples:0/20`。

## 1. Contract Closure

整體狀態：部分收口

- `routing_reason` 是否都在 contract：已收口。
  最關鍵 evidence：
  - `src/planner-contract-consistency.mjs:632-647,826-858` 會收集 planner selector、`router.js` literal、doc-query flow、task lifecycle 的 `routing_reason`，缺漏時直接歸類為 `undefined_routing_reasons`。
  - `tests/planner-contract-consistency.test.mjs` 明確驗證缺少註冊 `routing_reason` 時 gate 會 fail。
  - `tests/planner-contract-closure.test.mjs:72-84` 直接掃 `src/router.js` literal `routingReason`，要求全部都能在 `docs/system/planner_contract.json` 找到。
  - 本次 targeted test pass，代表目前觀察到的 route-selection reason 已有 contract closure。

- `action` naming 是否完全一致：部分收口。
  最關鍵 evidence：
  - `tests/planner-contract-closure.test.mjs:86-123,125-185` 已把 canonical planner action naming 鎖在 planner envelope 與 answer/registered-agent boundary；runtime info 這條鏈路目前也要求 `execution_result.kind` 收斂到同一個 canonical 名稱 `get_runtime_info`，不再接受舊的 `runtime_info` alias。
  - `src/executive-planner.mjs:2001-2019` 的 planner tool flow public shape 使用 `selected_action / execution_result / routing_reason`。
  - 但同檔案與多個 flow helper 仍大量使用內部 camelCase 參數 `selectedAction / executionResult / routingReason`，例如 `src/executive-planner.mjs:2001-2008`、`src/planner-flow-runtime.mjs:186-224`、`src/planner-doc-query-flow.mjs:468-760`。
  - `buildPlannedUserInputEnvelope(...)` 又把 planner-facing envelope 改寫成 `action / params / execution_result`，見 `src/executive-planner.mjs:6746-6842`。

判斷：

- contract closure 本身已經有 blocking gate。
- 但 action field naming 仍不是 repo-wide 單一版本，只能算 public contract 已收斂、內部 naming 尚未完全收口。

## 2. Mutation Boundary

整體狀態：部分收口

- 是否存在 bypass mutation runtime 的 write：部分收口。
  最關鍵 evidence：
  - `src/execute-lark-write.mjs:68-77` 用 `assertLarkWriteExecutionAllowed(...)` 阻止 direct Lark write bypass。
  - `src/lark-content.mjs` 的外部 write primitive 幾乎都先做 `assertLarkWriteExecutionAllowed(...)`，例如 `createDocument / updateDocument / replyMessage / sendMessage / resolveDocumentComment`。
  - `src/control-diagnostics.mjs:1862-1905` 也把「single write authority runtime only」與「bypass callers removed」做成診斷點。
  - 但 repo 內仍有刻意保留的 internal rollback / cleanup 例外，直接用 `withLarkWriteExecutionContext(...)` 包住 rollback 寫入，例如 `src/http-server.mjs:1847-1868` 的 `document_create_rollback`、`src/meeting-agent.mjs:1479-1524` 的 `meeting_confirm_write_rollback`、`src/doc-comment-rewrite.mjs:588-631` 的 rewrite rollback。

- `meeting` / doc rewrite 是否完全進 admission：已收口。
  最關鍵 evidence：
  - `src/mutation-admission.mjs:571-591` 明確建立 `meeting_confirm_write` canonical request。
  - `src/mutation-admission.mjs:594-626` 明確建立 `rewrite_apply` canonical request。
  - `src/meeting-agent.mjs:1754-1813` 的 meeting confirm path 先建 canonical request，再走 `runCanonicalLarkMutation(...)`。
  - `src/http-server.mjs:5552-5671` 的 doc rewrite apply path 先建 `buildDocumentCommentRewriteApplyCanonicalRequest(...)`，再走 `runCanonicalLarkMutation(...)`。
  - `tests/meeting-agent.test.mjs:377-443` 驗證 meeting preview 不會先寫文檔，confirm 後才進正式 write。
  - `tests/mutation-runtime.test.mjs`、`tests/doc-comment-rewrite.test.mjs` 與本次 targeted test pass，代表 admission / verification / rollback 目前有實際測試覆蓋。

判斷：

- 高風險正式 apply path 已經基本收進 mutation runtime。
- 但 repo 仍保留受控 rollback bypass，不能寫成「任何 write 都完全不繞 runtime」。

## 3. Runtime Shape

整體狀態：未收口

- `/answer` / planner / agent 是否同一 shape：未收口。
  最關鍵 evidence：
  - `src/answer-service.mjs:244-249,287-293` 的 answer service 回傳 shape 是 `{ account, answer, sources, provider, context_governance }`。
  - `src/executive-planner.mjs:6501-6744` 的 planner runtime 回傳 shape 是 `{ ok, action|steps, params, error, execution_result, trace_id, why, alternative }`。
  - `src/executive-planner.mjs:6746-6842` 的 planner envelope 又是一個獨立 shape。
  - `src/user-response-normalizer.mjs:567-647` 再把 planner/result/payload 正規化成 `{ ok, answer, sources, limitations }`。
  - `src/agent-dispatcher.mjs:405-538` 的 registered-agent 回傳 shape 則是 `{ text, agentId, metadata, ...optional error/details/context }`。
  - `src/lane-executor.mjs:250-295` 雖然強制 user-facing 文字用 `答案 -> 來源 -> 待確認/限制`，但那是渲染邊界，不代表內部 runtime object shape 已統一。

- 是否存在多版本 naming：未收口。
  最關鍵 evidence：
  - planner tool flow public contract 用 `selected_action / execution_result / routing_reason`，見 `docs/system/planner_contract.json:1216-1225` 與 `src/executive-planner.mjs:2001-2019`。
  - planner envelope 改成 `action / params / execution_result / trace`，見 `src/executive-planner.mjs:6816-6842`。
  - flow helper 與內部上下文仍以 camelCase `selectedAction / executionResult / routingReason` 傳遞，見 `src/planner-flow-runtime.mjs:186-224`、`src/planner-doc-query-flow.mjs:468-760`、`src/planner-runtime-info-flow.mjs:97-166`。
  - task lifecycle follow-up 又回到 `selected_action / routing_reason / execution_result`，見 `src/planner-task-lifecycle-v1.mjs:1909-2025`。

判斷：

- user-facing answer order 已收斂。
- 但 runtime object shape 與欄位命名仍是多層、多版本並存，這一項目前不能視為收口。

## 4. Routing Ownership

整體狀態：部分收口

- router / planner / dispatcher 是否有重疊決策：部分收口。
  最關鍵 evidence：
  - `src/router.js:14-195` 直接做 doc-query heuristic route decision，輸出 `selected_target / target_kind / routing_reason`。
  - `src/planner-flow-runtime.mjs:106-163` 會再對多個 planner flow route 結果做 candidate 比較與選擇。
  - `src/planner-doc-query-flow.mjs:5` 直接 import `route as routeDocQuery`，表示 doc-query router 是 planner flow 的內部決策來源之一，而不是完全獨立的上游。
  - `src/executive-planner.mjs:6501-6744` 還有 LLM planner / strict user input planner 的 action 決策層。
  - `src/executive-planner.mjs:3344-3535` 的 `dispatchPlannerTool(...)` 則負責 contract validate、skill/tool bridge 與真正 dispatch，不只是被動 transport。
  - `src/control-kernel.mjs:93-120` 還有 workflow ownership 層的 routing precedence，決定是否把控制權交給 executive workflow。

判斷：

- 目前不是「同一層多人搶同一個決策」那種混亂重疊。
- 但也還不是單一 owner：doc router、planner flow、strict planner、dispatcher、control kernel 各自掌握不同層級的 route / ownership / execution decision。
- 這代表分層邊界已經浮現，但 ownership 尚未完全單一化。

## 5. Docs vs Reality

整體狀態：部分收口

- `summary` / spec 是否與 code 一致：部分收口。
  最關鍵 evidence：
  - `docs/system/summary.md:59-60,120,143` 對「不是完整自治 multi-agent server、沒有 background worker / parallel subagent」的描述，和目前 code reality 相符。
  - `docs/system/routing_handoff_spec.md:47,57-72,198-199` 對 `company_brain_agent` 只負責 bounded read path 的描述，和目前 code/runtime alignment 相符。
  - 但 `docs/system/interface_spec.md:31-38` 把 `planner_agent_interface` output 寫成只有 `selected_action / execution_result / trace_id`。
  - 實際 checked-in public contract `docs/system/planner_contract.json:1216-1225` 與 runtime `src/executive-planner.mjs:2001-2019` 都把 `routing_reason` 視為固定欄位。
  - `docs/system/summary.md:123-130` 的 `Not Implemented: company_brain` 文字過於粗粒度；因為 repo 其實已有 read-side mirror、learning sidecar 與 partial review/conflict/approval path，見 `docs/system/company_brain.md:7-16,180`。這句如果解讀成「完整 company brain 尚未落地」是成立的，但如果解讀成「repo 內完全沒有 company-brain runtime path」就會失真。

判斷：

- summary 與 alignment/spec 大方向多數是對的。
- 目前最明確的 docs drift 是 `interface_spec` 對 planner output under-spec。
- `summary` 的 `company_brain` 用語則偏粗，不算完全錯，但容易讓人低估 repo 內已落地的 partial path。

## 結論（一定要填）

- 已收口：
  - `routing_reason` contract closure 已有 blocking gate 與 regression test。
  - `meeting_confirm_write` 與 `document_comment_rewrite_apply` 已正式進 canonical admission + mutation runtime。
  - direct Lark write bypass 已有 runtime assert 與 diagnostics 守住主要入口。

- 未收口：
  - `/answer` / planner / registered-agent` 不是同一 runtime shape。
  - planner 相關 naming 仍有 `selectedAction / selected_action / action` 並存。
  - routing ownership 仍是分層多 owner，不是單一決策中心。
  - docs/spec 仍有局部 under-spec，特別是 planner interface output。

- 風險最高點：
  - runtime shape 與 naming drift。
  - 原因不是單一 bug，而是 planner tool flow、planned envelope、answer normalization、registered-agent boundary 各自已經有穩定 shape；如果未先定 canonical envelope 就局部改名或局部統一，很容易造成下游 boundary regression，而且這種 regression 不一定會立刻在單一模組內暴露。

- 建議下一個唯一優先 thread：
  - `thread-runtime-shape-closure`
  - 目標只做一件事：先定並收斂 planner -> answer -> agent 的 canonical envelope 與 field naming，明確區分 public contract、internal helper naming、user-facing render boundary；在這一步完成前，不建議再擴張 routing spec 或新增新的 agent/result shape。
