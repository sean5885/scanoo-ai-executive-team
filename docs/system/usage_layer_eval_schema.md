# Usage Layer Eval Schema

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## 目的

這份文件定義 usage-layer baseline v1 的資料 schema。

它不是新的 public API，也不是新的 runtime contract；它是給 usage-layer baseline authoring 與 runner 使用的 eval contract。

這份 schema 直接站在現有 deterministic routing eval 之上：

- 保留 `lane / planner_action / agent_or_tool`
- 新增 `expected_reply_mode / expected_success_type / expected_eval_outcome / should_fail_if_generic`
- 用來回答「對使用者是不是有幫助」

## Repo Reality 對齊

- 現有 routing eval case shape 來自 `/Users/seanhan/Documents/Playground/evals/routing-eval-set.mjs`。
- 現有 answer boundary 來自 planner-first `/answer` 與 `user-response-normalizer.mjs`。
- partial success / fail-soft 的 seed case 來自：
  - `/Users/seanhan/Documents/Playground/tests/full-flow-validation.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/user-response-normalizer.test.mjs`

因此這份 schema 是「在既有事實上加 usage 標籤」，不是另起一套 imaginary framework。

## Required Fields

以下欄位為每條 baseline 必填：

### `user_text`

- 型別：`string`
- 定義：使用者原始輸入
- 規則：
  - 保留實際語氣
  - 優先沿用 repo 已有 eval wording 或相同語意變體

### `expected_lane`

- 型別：`string`
- 定義：預期命中的 capability lane / workflow lane
- 建議值：
  - `knowledge_assistant`
  - `doc_editor`
  - `cloud_doc_workflow`
  - `meeting_workflow`
  - `registered_agent`
  - `executive`
  - `personal_assistant`
  - `group_shared_assistant`

### `expected_planner_action`

- 型別：`string`
- 定義：預期命中的下一步 action
- 規則：
  - 優先沿用現有 routing eval action string
  - 允許 `ROUTING_NO_MATCH`
  - 不要發明 runtime 裡不存在的 action 名

### `expected_agent_or_tool`

- 型別：`string`
- 定義：預期命中的受控 target
- 規則：
  - 用現有 naming family
  - 合法前綴：
    - `tool:*`
    - `workflow:*`
    - `preset:*`
    - `agent:*`
    - `error:*`

### `tool_required`

- 型別：`boolean`
- 定義：這條 case 是否必須真的進到受控 executor 才能算 pass
- 規則：
  - `true`:
    - 需要 `tool:*`
    - 需要 `workflow:*`
    - 需要 `preset:*`
  - `false`:
    - 允許 text-only boundary 成立的 case
    - partial success / fail-soft 類 case
    - 純 agent brief 類 case

注意：這裡刻意沿用 closed-loop `tool_required` 的精神，但只把 literal tool/workflow/preset 視為 required。

### `expected_reply_mode`

- 型別：`string`
- 定義：預期的 usage-layer semantic reply mode
- 合法值：
  - `answer_first`
  - `workflow_update`
  - `executive_brief`
  - `card_preview`
  - `partial_success`
  - `fail_soft`

注意：這不是 runtime transport `reply_mode=text|card`。  
只有 `card_preview` 可以刻意映射到 transport card。

### `expected_success_type`

- 型別：`string`
- 定義：預期的使用者感知 outcome
- 合法值：
  - `direct_answer`
  - `workflow_progress`
  - `partial_success`
  - `fail_soft`

### `should_fail_if_generic`

- 型別：`boolean`
- 定義：若回覆只有空泛 boilerplate、缺 request-specific 資訊，是否直接判 fail
- 規則：
  - `true`:
    - doc/runtime 查詢
    - workflow review/reconfirm
    - registered/executive brief
    - partial success 但必須明講已完成部分
  - `false`:
    - 明確的 fail-soft 保底 case
    - intentionally broad fallback case

### `expected_eval_outcome`

- 型別：`string`
- 定義：這條 case 在 usage-layer gate 上預期落入的最終 outcome label
- 合法值：
  - `good_answer`
  - `partial_success`
  - `fail_closed`
  - `generic_reply`

注意：

- checked-in pack 現在要求 `generic_reply` 預期值為 `0`，也就是沒有任何 case 應以 generic reply 作為成功標準
- `good_answer` 是 usage-layer gate label，不代表一定是 pure direct answer；也可包含 workflow progress / card preview
- `fail_closed` 表示這條 case 在目前 repo truth 下，明確邊界回覆本身就是預期結果

## Recommended Optional Fields

以下欄位建議保留，但不是本輪必填：

- `id`
- `problem_type`
- `source_anchor`
- `notes`
- `context`
- `scope`

建議物件 shape：

```json
{
  "id": "EU-01",
  "problem_type": "entry_understanding",
  "source_anchor": "routing-eval:doc-001",
  "user_text": "幫我整理 OKR 文件重點",
  "expected_lane": "knowledge_assistant",
  "expected_planner_action": "search_and_detail_doc",
  "expected_agent_or_tool": "tool:search_and_detail_doc",
  "tool_required": true,
  "expected_reply_mode": "answer_first",
  "expected_success_type": "direct_answer",
  "should_fail_if_generic": true
}
```

## Judge Interpretation Rules

下一輪實作 evaluator 時，建議固定以下判讀口徑：

1. `lane_hit`
   - `actual.lane === expected_lane`

2. `planner_hit`
   - `actual.planner_action === expected_planner_action`

3. `target_hit`
   - `actual.agent_or_tool === expected_agent_or_tool`

4. `tool_required_hit`
   - 只有 `tool_required=true` 的 case 才檢查
   - 若最後沒抵達 `tool:*` / `workflow:*` / `preset:*`，直接 fail

5. `reply_mode_hit`
   - 檢查實際回覆是否符合預期 semantic mode

6. `generic_fail`
   - 只有 `should_fail_if_generic=true` 的 case 才檢查
   - 若回覆缺少 request-specific noun、workflow state、已完成部分或限制，判 fail

## 40-Case Seed Pack

以下 40 條可直接作為 baseline v1 的 seed pack。

### `EU` 入口理解（14）

| ID | Source Anchor | `user_text` | `expected_lane` | `expected_planner_action` | `expected_agent_or_tool` | `tool_required` | `expected_reply_mode` | `expected_success_type` | `should_fail_if_generic` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `EU-01` | `routing-eval:doc-001` | `幫我整理 OKR 文件重點` | `knowledge_assistant` | `search_and_detail_doc` | `tool:search_and_detail_doc` | `true` | `answer_first` | `direct_answer` | `true` |
| `EU-02` | `routing-eval:doc-002` | `幫我查詢 OKR 文件` | `knowledge_assistant` | `search_company_brain_docs` | `tool:search_company_brain_docs` | `true` | `answer_first` | `direct_answer` | `true` |
| `EU-03` | `routing-eval:runtime-002` | `查一下 runtime db path` | `knowledge_assistant` | `get_runtime_info` | `tool:get_runtime_info` | `true` | `answer_first` | `direct_answer` | `true` |
| `EU-04` | `routing-eval:doc-007` | `幫我看這份文件的評論並改稿` | `doc_editor` | `comment_rewrite_preview` | `tool:lark_doc_rewrite_from_comments` | `true` | `card_preview` | `workflow_progress` | `true` |
| `EU-05` | `routing-eval:doc-019` | `把我的雲文檔做分類 指派給對應的角色` | `cloud_doc_workflow` | `preview` | `workflow:cloud_doc_organization` | `true` | `workflow_update` | `workflow_progress` | `true` |
| `EU-06` | `routing-eval:doc-023a` | `把非 scanoo 的文檔摘出去` | `cloud_doc_workflow` | `rereview` | `workflow:cloud_doc_organization` | `true` | `workflow_update` | `workflow_progress` | `true` |
| `EU-07` | `routing-eval:meeting-001` | `我要開會了` | `meeting_workflow` | `start_capture` | `workflow:meeting_agent` | `true` | `workflow_update` | `workflow_progress` | `true` |
| `EU-08` | `routing-eval:meeting-010` | `請問在持續記錄中嗎` | `meeting_workflow` | `capture_status` | `workflow:meeting_agent` | `true` | `workflow_update` | `workflow_progress` | `true` |
| `EU-09` | `routing-eval:mixed-001` | `/cmo 幫我整理定位` | `registered_agent` | `dispatch_registered_agent` | `agent:cmo` | `false` | `answer_first` | `direct_answer` | `true` |
| `EU-10` | `routing-eval:mixed-003` | `/knowledge audit 盤點 OKR 文件缺口` | `registered_agent` | `dispatch_registered_agent` | `agent:knowledge-audit` | `false` | `answer_first` | `direct_answer` | `true` |
| `EU-11` | `routing-eval:mixed-006` | `先請各個 agent 一起看這批文檔，最後再統一收斂建議` | `executive` | `start` | `agent:generalist` | `false` | `executive_brief` | `direct_answer` | `true` |
| `EU-12` | `routing-eval:mixed-008` | `這個需要高層決策，請一起協作` | `executive` | `start` | `agent:ceo` | `false` | `executive_brief` | `direct_answer` | `true` |
| `EU-13` | `routing-eval:runtime-008` | `幫我總結最近對話` | `group_shared_assistant` | `summarize_recent_dialogue` | `tool:lark_messages_list` | `true` | `answer_first` | `direct_answer` | `true` |
| `EU-14` | `routing-eval:runtime-010` | `晚點提醒我一下` | `personal_assistant` | `ROUTING_NO_MATCH` | `error:ROUTING_NO_MATCH` | `false` | `fail_soft` | `fail_soft` | `false` |

### `ES` 執行策略（14）

| ID | Source Anchor | `user_text` | `expected_lane` | `expected_planner_action` | `expected_agent_or_tool` | `tool_required` | `expected_reply_mode` | `expected_success_type` | `should_fail_if_generic` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `ES-01` | `routing-eval:doc-017` | `根據文件打開這份文件內容` | `knowledge_assistant` | `get_company_brain_doc_detail` | `tool:get_company_brain_doc_detail` | `true` | `answer_first` | `direct_answer` | `true` |
| `ES-02` | `routing-eval:doc-018` | `根據文件打開第2份` | `knowledge_assistant` | `get_company_brain_doc_detail` | `tool:get_company_brain_doc_detail` | `true` | `answer_first` | `direct_answer` | `true` |
| `ES-03` | `routing-eval:doc-011` | `search company brain 列出文件` | `knowledge_assistant` | `list_company_brain_docs` | `tool:list_company_brain_docs` | `true` | `answer_first` | `direct_answer` | `true` |
| `ES-04` | `routing-eval:doc-012` | `search company brain 建立文件` | `knowledge_assistant` | `create_doc` | `tool:create_doc` | `true` | `answer_first` | `direct_answer` | `true` |
| `ES-05` | `routing-eval:doc-015` | `知識 create doc then list docs` | `knowledge_assistant` | `create_and_list_doc` | `preset:create_and_list_doc` | `true` | `answer_first` | `direct_answer` | `true` |
| `ES-06` | `routing-eval:doc-016` | `company brain create then search doc` | `knowledge_assistant` | `create_search_detail_list_doc` | `preset:create_search_detail_list_doc` | `true` | `answer_first` | `direct_answer` | `true` |
| `ES-07` | `routing-eval:runtime-019` | `幫我搜尋 runtime db path 文件` | `knowledge_assistant` | `get_runtime_info` | `tool:get_runtime_info` | `true` | `answer_first` | `direct_answer` | `true` |
| `ES-08` | `routing-eval:runtime-016` | `查一下 onboarding runtime 流程` | `knowledge_assistant` | `get_runtime_info` | `tool:get_runtime_info` | `true` | `answer_first` | `direct_answer` | `true` |
| `ES-09` | `routing-eval:runtime-005` | `幫我看今天日程` | `personal_assistant` | `calendar_summary` | `tool:lark_calendar_primary` | `true` | `answer_first` | `direct_answer` | `true` |
| `ES-10` | `routing-eval:runtime-006` | `幫我看目前任務` | `personal_assistant` | `tasks_summary` | `tool:lark_tasks_list` | `true` | `answer_first` | `direct_answer` | `true` |
| `ES-11` | `routing-eval:runtime-007` | `幫我總結最近對話` | `personal_assistant` | `summarize_recent_dialogue` | `tool:lark_messages_list` | `true` | `answer_first` | `direct_answer` | `true` |
| `ES-12` | `routing-eval:mixed-005` | `/tech 幫我看架構風險` | `registered_agent` | `dispatch_registered_agent` | `agent:tech` | `false` | `answer_first` | `direct_answer` | `true` |
| `ES-13` | `routing-eval:meeting-008` | `/meeting confirm confirm-123` | `meeting_workflow` | `confirm` | `workflow:meeting_agent` | `true` | `workflow_update` | `workflow_progress` | `true` |
| `ES-14` | `routing-eval:meeting-009` | `/meeting 客戶會議 參與人員：Sean、Amy TODO：Sean 整理 PRD` | `meeting_workflow` | `process` | `workflow:meeting_agent` | `true` | `workflow_update` | `workflow_progress` | `true` |

### `RP` 回覆包裝（12）

| ID | Source Anchor | `user_text` | `expected_lane` | `expected_planner_action` | `expected_agent_or_tool` | `tool_required` | `expected_reply_mode` | `expected_success_type` | `should_fail_if_generic` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `RP-01` | `routing-eval:doc-024` | `根據文件這份文件寫了什麼` | `knowledge_assistant` | `get_company_brain_doc_detail` | `tool:get_company_brain_doc_detail` | `true` | `answer_first` | `direct_answer` | `true` |
| `RP-02` | `routing-eval:doc-025` | `根據文件讀這份文件` | `knowledge_assistant` | `get_company_brain_doc_detail` | `tool:get_company_brain_doc_detail` | `true` | `answer_first` | `direct_answer` | `true` |
| `RP-03` | `routing-eval:mixed-011` | `幫我搜尋 onboarding 文件並直接打開內容` | `knowledge_assistant` | `search_company_brain_docs` | `tool:search_company_brain_docs` | `true` | `answer_first` | `direct_answer` | `true` |
| `RP-04` | `routing-eval:mixed-012` | `幫我列出知識庫文件` | `knowledge_assistant` | `list_company_brain_docs` | `tool:list_company_brain_docs` | `true` | `answer_first` | `direct_answer` | `true` |
| `RP-05` | `routing-eval:doc-020` | `好的，現在請告訴我還有什麼內容是需要我二次做確認的` | `cloud_doc_workflow` | `review` | `workflow:cloud_doc_organization` | `true` | `workflow_update` | `workflow_progress` | `true` |
| `RP-06` | `routing-eval:doc-021` | `這些待人工確認的文件，到底為什麼不能直接分配？` | `cloud_doc_workflow` | `why` | `workflow:cloud_doc_organization` | `true` | `workflow_update` | `workflow_progress` | `true` |
| `RP-07` | `routing-eval:doc-023` | `退出分類模式` | `cloud_doc_workflow` | `exit` | `workflow:cloud_doc_organization` | `true` | `workflow_update` | `workflow_progress` | `true` |
| `RP-08` | `routing-eval:meeting-006` | `會議結束了` | `meeting_workflow` | `stop_capture` | `workflow:meeting_agent` | `true` | `workflow_update` | `workflow_progress` | `true` |
| `RP-09` | `routing-eval:doc-009` | `幫我修改這份文檔` | `doc_editor` | `comment_rewrite_preview` | `tool:lark_doc_rewrite_from_comments` | `true` | `card_preview` | `workflow_progress` | `true` |
| `RP-10` | `full-flow:mixed-copy-image-send` | `幫我寫新品上線的 FB 貼文、做一張圖片並發送出去` | `personal_assistant` | `ROUTING_NO_MATCH` | `error:ROUTING_NO_MATCH` | `false` | `partial_success` | `partial_success` | `true` |
| `RP-11` | `normalizer:mixed-email-banner-send` | `幫我寫招募 email、做一張 banner 再寄給客戶` | `personal_assistant` | `ROUTING_NO_MATCH` | `error:ROUTING_NO_MATCH` | `false` | `partial_success` | `partial_success` | `true` |
| `RP-12` | `full-flow:image-send-unavailable` | `幫我做一張圖片並直接發送給客戶` | `personal_assistant` | `ROUTING_NO_MATCH` | `error:ROUTING_NO_MATCH` | `false` | `fail_soft` | `fail_soft` | `false` |

## Authoring Notes

建立正式 baseline 檔時，建議遵守以下規則：

1. 先以 40 條 seed pack 為骨架，再在同一 schema 下擴到 40~60 條 quality-gate pack。
2. 每條若需要 context，直接沿用現有 `routing-eval-set` 的 `context` / `scope` 形狀。
3. `EU` / `ES` / `RP` 三群不得失衡；若新增某群 case，需補足其他群。
4. 不要在 baseline 檔裡發明 repo 不存在的 lane、action、agent、tool、preset 名稱。
5. 若後續發現某條 baseline 與 code truth 不符，先修正 baseline 或註記 repo reality，不要在文件中偷渡新能力名稱。

## Current Checked-In Runner

目前 repo 已先落地一個最小 runner：

- dataset: `/Users/seanhan/Documents/Playground/evals/usage-layer/usage-layer-evals.mjs`
- runner: `/Users/seanhan/Documents/Playground/evals/usage-layer/usage-layer-runner.mjs`
- CLI: `npm run eval:usage-layer`
- runner 目前會沿用 routing eval 的 owner truth：
  - `cloud_doc_workflow` 走既有 workflow reply surface
  - `meeting_workflow` 走既有 workflow-style reply surface，不再為 eval 重跑 planner
  - `doc_editor` 走既有 lane intro / preview surface
  - `registered_agent -> dispatch_registered_agent` 走 checked-in slash-agent dispatcher boundary，而不是再退回 planner edge generic fallback
  - deterministic `executive` / `ROUTING_NO_MATCH` seed case 走 runner-side bounded reply surface，避免 eval 因 planner waiting 失去 summary；這不改 route truth 或 public contract

目前 checked-in dataset 已擴到 50 條，覆蓋：

- follow-up
- 多意圖 / partial success
- command-style
- doc / workflow（含 delivery / onboarding）
- fail-closed
- runtime / executive / meeting workflow

另外有一組最小 focused pack：

- dataset: `/Users/seanhan/Documents/Playground/evals/usage-layer/registered-agent-family-evals.mjs`
- CLI: `npm run eval:usage-layer:registered-agent-family`
- case 數量固定維持 `15~20` 條
- 覆蓋 slash command、persona-style owner phrasing、registered-agent success、`permission_denied`、`routing_no_match`、`fail_closed`
- 這組 pack 另外帶 optional `expected_owner_surface`，runner 會額外輸出 `actual_owner_surface`、`wrong_owner_surface`、`generic_owner_surface`，專門用來抓 explicit persona request 被 generic executive surface 吃掉的 regression

這一輪另外補了一組 timeout-governance focused pack：

- dataset: `/Users/seanhan/Documents/Playground/evals/usage-layer/workflow-timeout-governance-evals.mjs`
- CLI: `npm run eval:usage-layer:workflow-timeout-governance`
- case 數量固定 `5` 條
- 覆蓋 `successful_but_slow`、`timeout_acceptable`、`timeout_fail_closed`、`workflow_too_slow`、`needs_fixture_mock`
- 這組 pack 是 deterministic governance case pack，不宣稱每條都在 live runtime 真實重現；它的用途是固定 usage-layer judge、reply surface 與 fail-closed 邊界

判讀方式維持保守：

- `lane / planner_action / agent_or_tool` 仍沿用既有 routing resolver
- answer edge 仍維持 public `answer / sources / limitations` contract，但 `/Users/seanhan/Documents/Playground/src/user-response-normalizer.mjs` 現在會在 runtime object 上附加非 public、non-enumerable 的 `failure_class`
- 目前 checked-in `failure_class` 最少可區分：`routing_no_match`、`tool_omission`、`planner_failed`、`permission_denied`、`partial_success`、`generic_fallback`
- runner 會優先讀這層 classification，再退回 `generic` / `clarify` / `partial_success` heuristic
- summary 會輸出 `failure_breakdown` 與 top failure categories，避免所有 fail-soft case 都被誤壓成同一種 generic clarify
- 若 case 有提供 `expected_owner_surface`，runner 也會把 owner surface 納入 fail reason，避免 `/cmo` 這類 explicit owner family 只剩 route 命中、但回答邊界退成 generic executive brief
- `knowledge_assistant` case 會重用 checked-in route truth，直接驅動 deterministic executor path 再回到同一條 answer boundary；這是 eval runner 的 bounded executor fallback，用來隔離 planner JSON latency，不改 routing truth、public contract 或 write policy
- personal-lane `partial_success / fail_closed` case 會直接走 checked-in answer boundary normalizer，而不是讓 eval 被 planner waiting 拖成 timeout
- follow-up / multi-intent continuity pack 現在另外允許在 eval context 內預載 `planner.active_doc / active_candidates`，並可用 bounded `mock_planner_envelope` 驗證第二輪 answer boundary；這只用於 deterministic usage-layer judging，不改 public runtime contract
- 同一組 pack 也會把「主問題已成功回答，但句子裡還有送出 / 發布 / 圖片這類目前不可代做的子任務」判成 `partial_success`，要求回覆保留已完成部分並明講剩餘限制
- runner 現在對每條 case 都加上固定 timeout guard；若單條 case 超時，會取消該 case、在 summary 額外列出 `timed_out_cases`，並繼續跑完剩餘 case
- runner 現在也會輸出 `governance_family`、`governance_breakdown`、`governance_cases`，把 timeout/slow family 與一般 `failure_class` 分開看
- 若 runner 看到 timeout 但無法分進明確 family，summary 會把它記到 `unclassified_timeout`
- CLI 會印出 case start/done/timeout 與 stuck warning，方便直接定位是哪一條 case 長時間沒有結束
- usage eval runner v2（`/Users/seanhan/Documents/Playground/src/usage-eval-runner.mjs`）在同一條 evaluation-only path 內新增 issue visibility 分層，不改 planner/decision/runtime：
  - 每個 turn 會同時輸出：
    - `issue_detected_codes[]`（raw detected）
    - `issue_exposed_codes[]`（user-visible）
    - `suppression_flags.slot` / `suppression_flags.retry`
  - `redundant_slot_ask` 若符合 suppression 條件（`slot_suppressed_ask=true` + slot reusable valid + 未實際 promotion ask_user），會在 detected 層改標 `redundant_slot_ask_suppressed`，且不計入 exposed 層
  - `retry_without_contextual_response` 若符合 retry continuity suppression 條件（`retry_context_applied=true` + 無 long reset + 有 continuity tone），保留 detected，但不計入 exposed
  - aggregation 現在固定分開輸出：
    - `issue_detected_count_by_code` / `raw_issue_distribution`
    - `issue_exposed_count_by_code` / `user_visible_issue_distribution`
  - summary v2 現在固定輸出：
    - `top_detected_issues`
    - `top_user_visible_issues`
    - `suppression_effectiveness`（`suppressed_count` / `detected_count` / `suppressed_ratio`）
    - `retry_context_success_rate`
    - `slot_ask_suppression_success_rate`
  - `overall_intelligence_signal` 仍維持 deterministic 規則，但在 user-visible issue 相對 detected issue 明顯下降時可提升一級
- `RDR` 目前先保留 TODO，只做 case log，不宣稱已收斂成穩定自動 judge
- 由於目前 repo 本地沒有 stored explicit user auth / account context，checked-in pack 會把 auth-required company-brain read 與 account-required cloud-doc workflow case 標成 `fail_closed`；這是當前 code truth，不是宣稱能力不存在

## 結論

這份 schema 已經足夠直接拿去做 usage-layer 50 條 quality-gate pack：

- 欄位已定義
- enum 已收斂
- judge 口徑已定義
- 40 條 seed pack 已排好，並已擴成 50 條 checked-in gate pack
- runner 已可直接穩定實跑整組

下一步是收斂 `RDR` judge 與後續增量維護，不需要回頭重談 schema。
