# Routing Eval System

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Purpose

這份文件描述 repo 內的 deterministic routing eval regression gate baseline（v2 / `routing-eval-baseline-v2`）。

目前這份 mirror 同時保留兩個已提交 checkpoint：

- Thread 34 observability checkpoint
- Thread 35 closed-loop checkpoint
- Thread 36 operations checkpoint
- Thread 37 routing dataset coverage checkpoint

Thread 35 closed-loop checkpoint 針對 `top_miss_cases` / `error_breakdown` -> candidate fixture -> dataset review -> rerun eval -> baseline gate 的閉環流程補上最小工具與文件，且不改 routing 決策、fallback 行為或 baseline fixture。

Thread 36 operations checkpoint 把這條閉環路徑固定成 operator runbook 與單一入口 `npm run routing:closed-loop`，補上 session artifact、review checklist 與 rerun 入口；不新增 routing 邏輯、不改 routing 決策，也不調整 eval gate（仍為 `0.9`）。

Thread 37 routing dataset coverage checkpoint 只擴充 checked-in dataset coverage，新增 26 筆 fixture，補強模糊查詢、搜尋+打開、`doc` / `runtime` 邊界與中文自然語句；不新增 routing 邏輯、不改 routing 決策，也不調整 eval gate（仍為 `0.9`）。

固定操作 runbook 見：

- [routing_eval_closed_loop_runbook.md](/Users/seanhan/Documents/Playground/docs/system/routing_eval_closed_loop_runbook.md)

目標是量化目前 checked-in routing 行為的三個層次：

- `lane`
- `planner_action`
- `agent_or_tool`

並讓這組資料可以直接做 regression gate baseline。

## Files

- `/Users/seanhan/Documents/Playground/src/routing-eval.mjs`
- `/Users/seanhan/Documents/Playground/src/routing-eval-fixture-candidates.mjs`
- `/Users/seanhan/Documents/Playground/evals/routing-eval-set.mjs`
- `/Users/seanhan/Documents/Playground/scripts/routing-eval.mjs`
- `/Users/seanhan/Documents/Playground/scripts/routing-eval-fixture-candidates.mjs`
- `/Users/seanhan/Documents/Playground/scripts/routing-eval-closed-loop.mjs`
- `/Users/seanhan/Documents/Playground/tests/routing-eval.test.mjs`
- `/Users/seanhan/Documents/Playground/tests/routing-eval-fixture-candidates.test.mjs`

## Scope

目前 eval 只量 checked-in deterministic routing surface，不直接呼叫外部 LLM、OpenClaw、Lark API 或任何網路依賴。

這代表它量到的是：

- meeting command / meeting capture status heuristics
- cloud-doc organization workflow heuristics
- registered slash-agent dispatch
- executive fallback heuristic
- capability-lane routing
- planner hard-route / explicit `ROUTING_NO_MATCH`
- generic `search_company_brain_docs` hard-route 被更具體 selector action 覆蓋的 deterministic 規則

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
- `ROUTING_NO_MATCH`

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

目前 eval set 共有 88 筆，覆蓋：

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

`mixed` 類別目前額外覆蓋：

- 搜尋後直接打開內容（`search_and_detail_doc`）
- 列出知識庫文件（`list_company_brain_docs`）

新增的 checked-in coverage 重點：

- 中文自然語句的模糊文件跟進，包含會落到 `ROUTING_NO_MATCH` 的 fail-closed 邊界
- 搜尋後直接打開內容的多種中文表述
- `doc` / `runtime` 邊界語句，包含同時帶有 `文件` / `摘要` / `db path` / `runtime` 等信號時，實際仍被 runtime flow 優先接走的 case
- doc editor 類的自然中文改稿請求

## Execution

CLI:

```bash
npm run routing:closed-loop
npm run routing:closed-loop -- rerun
node scripts/routing-eval.mjs
node scripts/routing-eval.mjs --json
node scripts/routing-eval.mjs --json | node scripts/routing-eval-fixture-candidates.mjs
```

其中 `npm run routing:closed-loop` 是固定操作入口：

- `prepare`（預設）會一次完成 `eval -> candidates`，並把 review checklist 與 artifacts 寫到 `.tmp/routing-eval-closed-loop/<session-id>/`
- `rerun` 會在 dataset 審核更新後重跑 eval，沿用同一個 session
- 這層只做 orchestration，不改 routing 邏輯，也不新增 fallback

輸出包含：

- overall accuracy
- lane accuracy
- planner accuracy
- agent/tool accuracy
- `by_lane_accuracy`
- `by_action_accuracy`
- `error_breakdown`
- latency avg / p95 / max
- top miss cases

CLI 會以 overall accuracy ratio 當作強制 regression gate；目前這份 checked-in baseline 為 regression gate baseline v2（`routing-eval-baseline-v2`），門檻是 `0.9`。

- overall accuracy ratio `< 0.9` 時，CLI 會以 non-zero exit code 結束
- overall accuracy ratio `>= 0.9` 時，CLI 保持 zero exit code，即使仍有少量 miss case
- `--json` 會輸出完整結果、gate threshold 與 `top_miss_cases`（最多前 10 筆錯誤）
- `--json` 與文字 report 都會固定輸出 hard-routing 錯誤分佈 `error_breakdown`

`by_lane_accuracy` 與 `by_action_accuracy` 都是以 expected bucket 做分桶，統計該 bucket 內整筆 case 的 overall accuracy，而不是只看單一欄位命中率。

`error_breakdown` 是受控錯誤觀測欄位，只統計目前 checked-in hard-routing error code：

- `ROUTING_NO_MATCH`
- `INVALID_ACTION`
- `FALLBACK_DISABLED`

每個錯誤碼都固定輸出：

- `expected`: fixture 期望該錯誤碼的 case 數
- `actual`: eval 實際命中該錯誤碼的 case 數
- `matched`: expected / actual 同時命中同一錯誤碼的 case 數
- `misses`: 涉及該錯誤碼但 expected / actual 不一致的 case 數

這一層只補 observability，不改 routing 決策、fallback 行為或 baseline fixture。

## Miss / Error To Dataset Loop

這個 loop 只補「收集 -> 整理 -> 候選 fixture -> dataset review -> rerun eval -> baseline gate」；不直接改 routing 決策，也不新增 fallback。

### Fixed Runbook

固定流程是：

`eval -> candidates -> review -> dataset -> eval`

建議直接使用單一入口：

```bash
npm run routing:closed-loop
```

細部操作與 decision rules 見：

- [routing_eval_closed_loop_runbook.md](/Users/seanhan/Documents/Playground/docs/system/routing_eval_closed_loop_runbook.md)

### 1. 收集 miss / error

先跑 routing eval，保留完整 JSON：

```bash
node scripts/routing-eval.mjs --json > /tmp/routing-eval.json
```

來源重點：

- `summary.top_miss_cases`
- `summary.error_breakdown`
- `results`

### 2. 轉成可審查的候選 fixture

```bash
node scripts/routing-eval-fixture-candidates.mjs --input /tmp/routing-eval.json > /tmp/routing-eval-candidates.json
```

轉換器會輸出三層資料：

- `conversion_input.top_miss_cases_input`
  - 把 `top_miss_cases` 整理成可直接審查的逐案輸入
- `conversion_input.error_breakdown_input`
  - 把 aggregate `error_breakdown` 展開成 per-error-code、per-case 的可轉換輸入
- `fixture_candidates`
  - 預設以 `observed_actual_route` 產生候選 fixture，至少帶：
    - `lane`
    - `planner_action`
    - `agent_or_tool`
  - 若原 case 已存在於 dataset，`suggested_dataset_action` 會是 `update_existing_fixture`
  - 若找不到原 case，`suggested_dataset_action` 會是 `add_fixture`

若要改用目前 dataset 的 expected route 當草稿，可改：

```bash
node scripts/routing-eval-fixture-candidates.mjs --input /tmp/routing-eval.json --prefer expected
```

### 3. 加入 dataset

審查 `fixture_candidates` 後：

- `update_existing_fixture`
  - 到 `/Users/seanhan/Documents/Playground/evals/routing-eval-set.mjs` 對應 case 更新 `expected`
- `add_fixture`
  - 將 `fixture_source` 轉成新的 `createCase(...)` entry 加進 dataset

這一步是人工審查後納入，不是自動寫回。

### 4. 重跑 eval

```bash
node scripts/routing-eval.mjs
node scripts/routing-eval.mjs --json
```

### 5. Baseline Gate

只有在 overall accuracy ratio `>= 0.9` 時，才可把更新後的 dataset 視為新的 checked-in regression baseline。

- `< 0.9`：不得當作 baseline 完成，必須繼續修 case / 調整 dataset 標註
- `>= 0.9`：可納入 baseline review

## Example Output

以下是目前 checked-in baseline 轉出的一組示例。因為 baseline 目前沒有 miss，示例來自已存在的 hard-routing error case：

```json
{
  "source_summary": {
    "total_cases": 62,
    "miss_count": 0,
    "overall_accuracy_ratio": 1,
    "overall_accuracy": 100,
    "gate_ok": true,
    "min_accuracy_ratio": 0.9
  },
  "conversion_input": {
    "top_miss_cases_input": [],
    "error_breakdown_input": [
      {
        "error_code": "ROUTING_NO_MATCH",
        "summary": {
          "expected": 1,
          "actual": 1,
          "matched": 1,
          "misses": 0
        },
        "cases": [
          {
            "source_case_id": "runtime-010",
            "source_kind": "routing_error_case",
            "category": "runtime",
            "text": "晚點提醒我一下",
            "current_expected": {
              "lane": "personal_assistant",
              "planner_action": "ROUTING_NO_MATCH",
              "agent_or_tool": "error:ROUTING_NO_MATCH"
            },
            "observed_actual": {
              "lane": "personal_assistant",
              "planner_action": "ROUTING_NO_MATCH",
              "agent_or_tool": "error:ROUTING_NO_MATCH",
              "route_source": "lane_execution_plan"
            }
          }
        ]
      }
    ]
  },
  "fixture_candidates": [
    {
      "source_case_id": "runtime-010",
      "suggested_dataset_action": "update_existing_fixture",
      "lane": "personal_assistant",
      "planner_action": "ROUTING_NO_MATCH",
      "agent_or_tool": "error:ROUTING_NO_MATCH"
    }
  ]
}
```

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
- 當 hard-route 只命中 generic `search_company_brain_docs`，但 selector 能判定出更具體的 create / list / learning / search-and-detail action 時，會優先採用 selector 結果

因此它適合作為 regression gate baseline v2，但不應被描述成完整的 live end-to-end routing benchmark。
