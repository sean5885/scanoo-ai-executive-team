# Routing Eval System

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Purpose

這份文件描述 repo 內的 deterministic routing eval regression gate baseline（v1）。

目標是量化目前 checked-in routing 行為的三個層次：

- `lane`
- `planner_action`
- `agent_or_tool`

並讓這組資料可以直接做 regression gate baseline。

## Files

- `/Users/seanhan/Documents/Playground/src/routing-eval.mjs`
- `/Users/seanhan/Documents/Playground/evals/routing-eval-set.mjs`
- `/Users/seanhan/Documents/Playground/scripts/routing-eval.mjs`
- `/Users/seanhan/Documents/Playground/tests/routing-eval.test.mjs`

## Scope

目前 eval 只量 checked-in deterministic routing surface，不直接呼叫外部 LLM、OpenClaw、Lark API 或任何網路依賴。

這代表它量到的是：

- meeting command / meeting capture status heuristics
- cloud-doc organization workflow heuristics
- registered slash-agent dispatch
- executive fallback heuristic
- capability-lane routing
- planner hard-route / selector fallback

它刻意不量：

- live LLM planner JSON quality
- 真實 tool execution 成敗
- 真實網路 latency

## Normalized Dimensions

### 1. `lane`

目前 baseline 使用的是「effective route lane」，不是單指 `capability_lane`。

可用值包含：

- `meeting_workflow`
- `cloud_doc_workflow`
- `registered_agent`
- `executive`
- `knowledge_assistant`
- `doc_editor`
- `group_shared_assistant`
- `personal_assistant`

### 2. `planner_action`

這一欄表示路由後下一個受控動作。

範例：

- `start_capture`
- `review`
- `dispatch_registered_agent`
- `search_and_detail_doc`
- `get_runtime_info`
- `calendar_summary`
- `default_reply`

對 specialized workflow 而言，這欄不一定是 planner contract action；它是 eval 層統一後的「下一步 route action」。

### 3. `agent_or_tool`

這一欄表示 eval 想驗證的最終命中 target。

範例：

- `workflow:meeting_agent`
- `workflow:cloud_doc_organization`
- `agent:cmo`
- `tool:get_runtime_info`
- `tool:lark_doc_rewrite_from_comments`
- `preset:create_and_list_doc`

## Eval Set

目前 eval set 共有 60 筆，覆蓋：

- `doc`
- `meeting`
- `runtime`
- `mixed`

每筆 fixture 至少定義：

- `id`
- `category`
- `text`
- `expected.lane`
- `expected.planner_action`
- `expected.agent_or_tool`

部分案例還會帶 deterministic context，例如：

- `scope.chat_type`
- `context.planner.active_doc`
- `context.planner.active_candidates`
- `context.planner.active_theme`
- `context.active_workflow_mode`
- `context.meeting_capture_active`

這些 context 只在 eval adapter 內部使用，不會對 production runtime 寫入持久狀態。

## Execution

CLI:

```bash
node scripts/routing-eval.mjs
node scripts/routing-eval.mjs --json
```

輸出包含：

- overall accuracy
- lane accuracy
- planner accuracy
- agent/tool accuracy
- latency avg / p95 / max
- top miss cases

CLI 會以 overall accuracy ratio 當作強制 regression gate；目前這份 checked-in baseline 為 regression gate baseline v1，門檻是 `0.9`。

- overall accuracy ratio `< 0.9` 時，CLI 會以 non-zero exit code 結束
- overall accuracy ratio `>= 0.9` 時，CLI 保持 zero exit code，即使仍有少量 miss case
- `--json` 會輸出完整結果、gate threshold 與 `top_miss_cases`（最多前 10 筆錯誤）

## Determinism

這組 eval 可重跑的原因：

- 不調用 live LLM
- 不調用真實外部工具
- fixture 與 context 都是 checked-in
- 每筆 case 在執行前都重置 planner doc-query context

## Relationship To Existing Runtime

這份 baseline 是 code-truth mirror，不是新的 product contract。

它目前鏡像的 checked-in事實是：

- top-level routing 仍有大量 heuristic
- meeting / cloud-doc / registered-agent 仍有 specialized bypass path
- planner 只在 knowledge-lane 等受控入口內被 deterministic adapter 模擬

因此它適合作為 regression gate baseline v1，但不應被描述成完整的 live end-to-end routing benchmark。
