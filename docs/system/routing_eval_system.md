# Routing Eval System

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Purpose

這份文件描述 repo 內的 deterministic routing eval regression gate baseline（v2 / `routing-eval-baseline-v2`）。

目前這份 mirror 同時保留多個已提交 checkpoint：

- Thread 34 observability checkpoint
- Thread 35 closed-loop checkpoint
- Thread 36 operations checkpoint
- Thread 37 routing dataset coverage checkpoint
- Thread 38 routing trend report checkpoint
- Thread 39 routing decision advice checkpoint
- Thread 40 routing diagnostics single-view checkpoint
- Thread 41 routing diagnostics history checkpoint
- Thread 42 routing diagnostics daily-entry checkpoint
- Thread 51 release-check preflight checkpoint

Thread 35 closed-loop checkpoint 針對 `top_miss_cases` / `error_breakdown` -> candidate fixture -> dataset review -> rerun eval -> baseline gate 的閉環流程補上最小工具與文件，且不改 routing 決策、fallback 行為或 baseline fixture。

Thread 36 operations checkpoint 把這條閉環路徑固定成 operator runbook 與單一入口 `npm run routing:closed-loop`，補上 session artifact、review checklist 與 rerun 入口；不新增 routing 邏輯、不改 routing 決策，也不調整 eval gate（仍為 `0.9`）。

Thread 37 routing dataset coverage checkpoint 只擴充 checked-in dataset coverage，新增 26 筆 fixture，補強模糊查詢、搜尋+打開、`doc` / `runtime` 邊界與中文自然語句；不新增 routing 邏輯、不改 routing 決策，也不調整 eval gate（仍為 `0.9`）。

Thread 38 routing trend report checkpoint 在既有 deterministic eval / compare / closed-loop 路徑上補上最小 `comparable_summary`、`trend_report`、`--compare` / `--compare-last`、closed-loop trend artifacts、測試與文件；不新增邏輯、不改 routing 決策，也不新增 fallback。

Thread 39 routing decision advice checkpoint 在既有 deterministic eval / compare / closed-loop 路徑上補上最小 `trend`、`decision_advice`、closed-loop decision artifacts、CLI 摘要、測試與文件；不新增 routing 邏輯、不改 routing 決策，也不新增 fallback。

Thread 40 routing diagnostics single-view checkpoint 把既有 summary、trend、decision advice 收斂成單一 `diagnostics_summary` 決策視圖，對齊 `routing-eval`、fixture-candidates、closed-loop prepare / rerun 的 artifact 與文件；不新增 routing 邏輯、不改 routing 決策，也不新增 fallback。

Thread 41 routing diagnostics history checkpoint 在既有 deterministic eval / compare / closed-loop 路徑上補上可歸檔 snapshot、最小 manifest/index、`--compare-snapshot`、`--compare-tag`、歷史趨勢判讀口徑與測試；不新增邏輯、不改 routing 決策，也不新增 fallback。

Thread 42 routing diagnostics daily-entry checkpoint 在既有 diagnostics history 基礎上補上固定 read-only `routing:diagnostics` 檢視入口、上一筆 history lookup、日常查看口徑與測試；不新增邏輯、不改 routing 決策，也不新增 fallback。

Thread 49 unified-self-check checkpoint 把既有 routing diagnostics latest snapshot / previous compare 整合進 `self-check` 的 unified summary，提供 `routing_summary.status`、明顯 regression 判讀與短 human-readable verdict；不新增 routing 邏輯、不改 fallback，也不改原本 eval gate。

Thread 51 release-check preflight checkpoint 把既有 unified `self-check` 的 routing line再壓成 merge/release 單一 preflight 入口的一部分；它只讀最新 routing snapshot 與 compare 判讀，不重跑 eval、不改 routing，也不新增 fallback。

目前這條路徑已再收斂成 `diagnostics_summary` 單一決策視圖，讓 operator 只看一個 summary 就能決定要補 fixture、檢查 routing rule，或保持不動；不新增 routing 邏輯、不新增 fallback，也不改 baseline/tag。

固定操作 runbook 見：

- [routing_eval_closed_loop_runbook.md](/Users/seanhan/Documents/Playground/docs/system/routing_eval_closed_loop_runbook.md)

目標是量化目前 checked-in routing 行為的三個層次：

- `lane`
- `planner_action`
- `agent_or_tool`

並讓這組資料可以直接做 regression gate baseline。

## Files

- `/Users/seanhan/Documents/Playground/src/routing-eval.mjs`
- `/Users/seanhan/Documents/Playground/src/routing-eval-diagnostics.mjs`
- `/Users/seanhan/Documents/Playground/src/routing-eval-fixture-candidates.mjs`
- `/Users/seanhan/Documents/Playground/evals/routing-eval-set.mjs`
- `/Users/seanhan/Documents/Playground/scripts/routing-eval.mjs`
- `/Users/seanhan/Documents/Playground/scripts/routing-eval-fixture-candidates.mjs`
- `/Users/seanhan/Documents/Playground/scripts/routing-eval-closed-loop.mjs`
- `/Users/seanhan/Documents/Playground/scripts/routing-diagnostics.mjs`
- `/Users/seanhan/Documents/Playground/src/routing-diagnostics-history.mjs`
- `/Users/seanhan/Documents/Playground/tests/routing-eval.test.mjs`
- `/Users/seanhan/Documents/Playground/tests/routing-eval-fixture-candidates.test.mjs`
- `/Users/seanhan/Documents/Playground/tests/routing-eval-decision-advice.test.mjs`
- `/Users/seanhan/Documents/Playground/tests/routing-eval-closed-loop.test.mjs`
- `/Users/seanhan/Documents/Playground/tests/routing-diagnostics-cli.test.mjs`

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
npm run routing:diagnostics
npm run routing:diagnostics -- --compare-previous
npm run routing:diagnostics -- --compare-snapshot <run-id>
npm run routing:diagnostics -- --compare-tag routing-eval-baseline-v2
node scripts/routing-eval.mjs
node scripts/routing-eval.mjs --json
node scripts/routing-eval.mjs --compare .tmp/routing-eval-closed-loop/<session-id>/01-routing-eval.json
node scripts/routing-eval.mjs --compare-last
node scripts/routing-eval.mjs --compare-snapshot latest
node scripts/routing-eval.mjs --compare-snapshot <run-id>
node scripts/routing-eval.mjs --compare-tag routing-eval-baseline-v2
npm run routing:closed-loop -- prepare --compare-tag routing-eval-baseline-v2
npm run routing:closed-loop -- rerun --compare-snapshot <run-id>
node scripts/routing-eval.mjs --json | node scripts/routing-eval-fixture-candidates.mjs
node scripts/routing-eval-fixture-candidates.mjs --input /tmp/routing-eval.json --previous /tmp/previous-routing-eval.json
```

其中 `npm run routing:closed-loop` 是固定操作入口：

- `prepare`（預設）會一次完成 `eval -> candidates`，並把 review checklist 與 artifacts 寫到 `.tmp/routing-eval-closed-loop/<session-id>/`
- `rerun` 會在 dataset 審核更新後重跑 eval，沿用同一個 session
- 這層只做 orchestration，不改 routing 邏輯，也不新增 fallback

其中 `npm run routing:diagnostics` 是固定檢視入口：

- 預設直接讀 diagnostics history 的最新 snapshot，輸出簡潔人類可讀摘要
- `--compare-previous` 會拿最新 snapshot 對 manifest 內上一筆 snapshot 做 compare
- `--compare-snapshot <run-id|path>` 會拿最新 snapshot 對指定歷史 snapshot 做 compare
- `--compare-tag <git-tag>` 會拿最新 snapshot 對既有 baseline / checkpoint tag 做 compare
- 這層只讀 history / tag，不重跑最新 eval，也不改 baseline/tag

輸出包含：

- overall accuracy
- comparable `accuracy_ratio`
- lane accuracy
- planner accuracy
- agent/tool accuracy
- `by_lane_accuracy`
- `by_action_accuracy`
- `error_breakdown`
- `comparable_summary`
- latency avg / p95 / max
- top miss cases
- `diagnostics_summary`

每次 `node scripts/routing-eval.mjs` 與 `npm run routing:closed-loop` / `rerun` 執行後，現在都會額外把同一份 decision view 歸檔到：

- `.tmp/routing-diagnostics-history/manifest.json`
- `.tmp/routing-diagnostics-history/snapshots/<run-id>.json`

`--json` 也會回傳 `diagnostics_archive`，指出本次 snapshot 與 manifest 路徑。

日常查看這份 archive 時，固定先看：

1. `npm run routing:diagnostics`
2. 若剛改過 routing 相關程式或 fixture，再看 `npm run routing:diagnostics -- --compare-previous`
3. 若要回答是否偏離已接受 checkpoint，再看 `npm run routing:diagnostics -- --compare-tag routing-eval-baseline-v2`

`npm run self-check` 現在會直接整合這條線的 read-only 結論，但仍不重跑 eval：

- routing 部分只讀 `.tmp/routing-diagnostics-history/` 的最新 snapshot
- 若 manifest 內有上一筆 snapshot，會再做 latest vs previous compare
- self-check 每次執行也會把 unified result 歸檔到 `.tmp/system-self-check-history/`
- unified `routing_summary.status` 只分成：
  - `pass`
  - `degrade`
  - `fail`
- `pass` 代表 latest snapshot 本身穩定，且 compare 沒有明顯 regression
- `degrade` 代表 latest snapshot 仍通過，但 compare 已出現明顯 drift / regression，應先看 routing
- `fail` 代表 latest snapshot 缺失、accuracy 低於原本 eval gate，或 diagnostics 已出現高風險訊號

這裡的 self-check 整合只做彙總，不改 routing 邏輯、不改 fallback，也不改原本 `routing-eval` 的 gate。

若要最小回答 unified 狀態是否比上一筆更差，也可以直接用：

- `npm run self-check -- --compare-previous`
- `npm run self-check -- --compare-snapshot <run-id|path>`

這兩條 compare path 只回答 unified `system` 變化、`routing` 是否 regression、以及 `planner` 是否 regression；不改 routing 邏輯、不改 fallback，也不做 auto-fix。

CLI 會以 overall accuracy ratio 當作強制 regression gate；目前這份 checked-in baseline 為 regression gate baseline v2（`routing-eval-baseline-v2`），門檻是 `0.9`。

- overall accuracy ratio `< 0.9` 時，CLI 會以 non-zero exit code 結束
- overall accuracy ratio `>= 0.9` 時，CLI 保持 zero exit code，即使仍有少量 miss case
- `--json` 會輸出完整結果、gate threshold、`top_miss_cases`（最多前 10 筆錯誤）與完整 `diagnostics_summary`
- 預設文字輸出改為單一 `diagnostics_summary` 視圖，不再把 eval / trend / decision advice 分散列印
- `scripts/routing-eval-fixture-candidates.mjs` 會在 JSON 內輸出：
  - `diagnostics_summary`
  - `trend`
  - `decision_advice.warnings`
  - `decision_advice.recommendations`
  - `decision_advice.minimal_decision`
- `diagnostics_summary` 固定包含：
  - `accuracy_ratio`
  - `by_lane_accuracy`
  - `by_action_accuracy`
  - `error_breakdown`
  - `trend_report`
  - `decision_advice`
- `summary.comparable_summary` 是 compare-ready snapshot，固定只保留：
  - `accuracy_ratio`
  - `by_lane_accuracy`
  - `by_action_accuracy`
  - `error_breakdown`
- `node scripts/routing-eval.mjs --compare <run-json>` 會把 trend 比較結果收進同一份 `diagnostics_summary.trend_report`
- `node scripts/routing-eval.mjs --compare-last` 會把本次結果與 `.tmp/routing-eval-closed-loop/latest-session.json` 指向的最新 artifact 比較
- `node scripts/routing-eval.mjs --compare-snapshot <run-id|path>` 會把本次結果與 diagnostics history 內指定 snapshot 比較；`latest` 會解析 manifest 的最新一筆
- `node scripts/routing-eval.mjs --compare-tag <git-tag>` 會把本次結果與既有 git baseline / checkpoint tag 的 routing-eval 產出比較，不改任何既有 tag

## Diagnostics Archive

routing diagnostics history 是獨立於 closed-loop session 的最小歸檔層，只負責保存可比較的 diagnostics snapshot，不改 routing 邏輯、不改 gate，也不改 baseline/tag。

固定檔案：

- `.tmp/routing-diagnostics-history/manifest.json`
  - 最新 manifest / index
- `.tmp/routing-diagnostics-history/snapshots/<run-id>.json`
  - 單次可歸檔 snapshot

manifest 每筆最小欄位固定包含：

- `run_id`
- `timestamp`
- `accuracy_ratio`
- `error_breakdown`
- `trend_report_summary`

其中 `trend_report_summary` 只保留最小摘要：

- `available`
- `status`
- `previous_label`
- `accuracy_ratio_delta`
- `miss_count_delta`
- `total_cases_delta`

單筆 snapshot 會在這個最小索引之外，再保留：

- `diagnostics_summary`
- `run`
- `compare_target`
- `scope`
- `stage`
- `session_id`

`diagnostics_summary` 是 operator 的 single source of truth。  
`summary.comparable_summary` 仍保留給 compare / conversion 使用，但不是操作決策入口。

`trend_report` 是最小比較輸出，不改 gate，也不改 routing 決策。它固定比較：

- `accuracy_ratio`
- total case count
- miss count
- changed `by_lane_accuracy` buckets
- changed `by_action_accuracy` buckets
- changed `error_breakdown`

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

## Diagnostics Summary

`diagnostics_summary` 是唯一決策輸出物。  
它把 current comparable snapshot、trend 與 decision advice 整合進同一個 object：

- `accuracy_ratio`
- `by_lane_accuracy`
- `by_action_accuracy`
- `error_breakdown`
- `trend_report`
- `decision_advice`

判讀順序固定為：

1. 先看 `decision_advice.minimal_decision`
2. 再用 `accuracy_ratio`、`by_lane_accuracy`、`by_action_accuracy`、`error_breakdown`、`trend_report` 驗證
3. 最終只做三種決策：
   - 補 fixture
   - 檢查 routing rule
   - 不動

## Minimal Decision Advice

fixture-candidate JSON 與 closed-loop diagnostics artifact 會根據 `trend` 與 `error_breakdown` 產出最小 decision 建議，但只做建議，不會自動修改 routing rule、fallback 或 dataset。

固定規則如下：

- `ROUTING_NO_MATCH`
  - 若出現 drift（例如 `misses > 0` 或 `actual > matched`），建議補 fixture coverage
- `INVALID_ACTION`
  - 若出現 drift，建議檢查 routing rule / action contract
- `FALLBACK_DISABLED`
  - 若觀測到實際命中或 miss，標記為高風險，要求人工審查
- accuracy trend
  - 相對前一次 run 下降：輸出 warning
  - 相對前一次 run 穩定：建議不動

`minimal_decision` 只會選一個最高優先級摘要給 CLI / JSON，優先順序為：

1. `manual_review_high_risk`
2. `warn_accuracy_decline`
3. `check_routing_rule`
4. `review_fixture_coverage`
5. `no_change`

若沒有前一次 run，`trend.status = "unknown"`，系統只會根據目前 `error_breakdown` 產出建議。

### 三種情境

#### a. 補 fixture

- 看 `diagnostics_summary.decision_advice.minimal_decision.action = review_fixture_coverage`
- 主看 `error_breakdown.ROUTING_NO_MATCH`
- 若 drift 可被解釋為 coverage 缺口，補 dataset fixture；不要順手改 routing rule

#### b. 檢查 routing rule

- 看 `diagnostics_summary.decision_advice.minimal_decision.action = check_routing_rule`
- 主看 `error_breakdown.INVALID_ACTION`
- 若 `trend_report` 也顯示既有 lane / action bucket 下滑，優先檢查 routing rule / precedence / action contract

#### c. 不動（穩定）

- 看 `diagnostics_summary.decision_advice.minimal_decision.action = no_change`
- `trend_report` stable，且 `accuracy_ratio` / `error_breakdown` 沒新增 drift
- code 與 dataset 都不動

## Miss / Error To Dataset Loop

這個 loop 只補「收集 -> 整理 -> 候選 fixture -> dataset review -> rerun eval -> baseline gate」；不直接改 routing 決策，也不新增 fallback。

### Fixed Runbook

固定流程是：

`eval -> candidates -> review -> dataset -> eval`

建議直接使用單一入口：

```bash
npm run routing:closed-loop
```

closed-loop session 現在固定輸出單一 diagnostics artifact：

- `07-initial-diagnostics-summary.json`
- `08-initial-diagnostics-summary.txt`
- `09-rerun-diagnostics-summary.json`
- `10-rerun-diagnostics-summary.txt`
- `.tmp/routing-diagnostics-history/manifest.json`
- `.tmp/routing-diagnostics-history/snapshots/<run-id>.json`

其中：

- initial diagnostics 比較「本次 prepare」vs「上一個 session 的最新 eval artifact」
- rerun diagnostics 比較「本次 rerun」vs「同一 session 的 initial eval」
- 若明確指定 `--compare` / `--compare-snapshot` / `--compare-tag` / `--compare-last`，則以明確 compare target 覆蓋預設比較對象

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
- `diagnostics_summary`
- 如需 trend / minimal decision，一併準備前一次 eval JSON
- `results`

### 2. 轉成可審查的候選 fixture

```bash
node scripts/routing-eval-fixture-candidates.mjs --input /tmp/routing-eval.json > /tmp/routing-eval-candidates.json
```

若要連同 current vs previous 的 diagnostics 一起輸出：

```bash
node scripts/routing-eval-fixture-candidates.mjs \
  --input /tmp/routing-eval.json \
  --previous /tmp/previous-routing-eval.json \
  > /tmp/routing-eval-candidates.json
```

轉換器會輸出四層資料：

- `diagnostics_summary`
  - 單一決策視圖，直接用來判斷補 fixture / 檢查 routing rule / 不動
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
node scripts/routing-eval.mjs --compare-last
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
    "total_cases": 88,
    "miss_count": 0,
    "overall_accuracy_ratio": 1,
    "overall_accuracy": 100,
    "gate_ok": true,
    "min_accuracy_ratio": 0.9
  },
  "diagnostics_summary": {
    "accuracy_ratio": 1,
    "by_lane_accuracy": {},
    "by_action_accuracy": {},
    "error_breakdown": {
      "ROUTING_NO_MATCH": {
        "expected": 1,
        "actual": 1,
        "matched": 1,
        "misses": 0
      }
    },
    "trend_report": {
      "available": false
    },
    "decision_advice": {
      "minimal_decision": {
        "action": "observe_only"
      }
    }
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
