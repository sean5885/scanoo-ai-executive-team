# Control Diagnostics

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Purpose

這份文件描述 Phase 3 control diagnostics 的 read-only 檢測與回溯入口。

它的目標是把目前已接線的三條風險線收斂成一個 daily-entry CLI：

- control
- routing
- write

這條路徑只做檢測、摘要、snapshot、compare。

它不會：

- 改 runtime 行為
- 改 routing
- 改 write gate
- 自動修正 drift
- 補 fallback

## Files

- `/Users/seanhan/Documents/Playground/src/control-diagnostics.mjs`
- `/Users/seanhan/Documents/Playground/src/control-diagnostics-history.mjs`
- `/Users/seanhan/Documents/Playground/scripts/control-diagnostics.mjs`
- `/Users/seanhan/Documents/Playground/tests/control-diagnostics-cli.test.mjs`

## Current Inputs

### control evidence

control diagnostics 目前直接重用 checked-in code truth：

- `/Users/seanhan/Documents/Playground/src/control-kernel.mjs`
- `/Users/seanhan/Documents/Playground/src/lane-executor.mjs`

它會用固定 deterministic scenario 驗證：

- explicit executive intent 是否優先奪回 control
  - 目前以 checked-in core slash 指令（例如 `/planner`）驗證，不再依賴舊 persona slash 指令
- doc rewrite follow-up 是否維持 `doc-editor`
- cloud-doc follow-up 是否要求 same scope
- scope mismatch 是否回到 lane default
- active executive task 是否保留 same-session ownership

它也會檢查 lane-executor 的 integration surface 是否仍存在：

- `decideIntent(...)`
- `control_kernel_decision` log
- owner assertion path

### routing evidence

routing summary 不會重跑 routing runtime，也不新增新的 routing diagnostics subsystem。

它只重用既有 archived routing evidence：

- `.tmp/routing-diagnostics-history/manifest.json`
- `.tmp/routing-diagnostics-history/snapshots/<run-id>.json`

目前 routing line 固定回答：

- latest snapshot 是否存在
- accuracy ratio
- compare 是否有 obvious regression
- 是否命中 checked-in doc/company-brain boundary regression family

若沒有 archived routing snapshot，這條線會 fail-soft 回報 `routing latest snapshot unavailable`，並提示先跑：

- `node scripts/routing-eval.mjs --json`
- 或 `npm run routing:closed-loop`

### write evidence

write summary 目前重用：

- `/Users/seanhan/Documents/Playground/src/external-mutation-registry.mjs`
- `/Users/seanhan/Documents/Playground/src/lark-mutation-runtime.mjs`
- `/Users/seanhan/Documents/Playground/src/write-policy-contract.mjs`
- `/Users/seanhan/Documents/Playground/src/write-guard.mjs`
- `/Users/seanhan/Documents/Playground/src/lark-write-guard.mjs`
- `/Users/seanhan/Documents/Playground/src/http-server.mjs`
- `/Users/seanhan/Documents/Playground/src/index.mjs`
- `/Users/seanhan/Documents/Playground/src/lane-executor.mjs`
- `/Users/seanhan/Documents/Playground/src/meeting-agent.mjs`
- `/Users/seanhan/Documents/Playground/src/comment-suggestion-workflow.mjs`
- `/Users/seanhan/Documents/Playground/src/lark-content.mjs`

它會做兩種檢查：

1. fixed deterministic guard scenarios
2. checked-in runtime integration surface scan
3. Phase 1 write-policy metadata presence check

目前固定檢查的 write guard family 包含：

- internal write allow
- preview external write deny
- confirmation-required deny
- verifier-incomplete deny
- verified external write allow
- live Lark create default deny
- confirm-required create deny
- demo-like create sandbox reroute

目前固定檢查的 guarded runtime surface 包含：

- high-risk doc / meeting apply family 經 `runCanonicalLarkMutation(...)`
- public HTTP external writes 經 `executeCanonicalLarkMutation(...)`
- runtime-only message writers stay on the guarded mutation bridge:
  - `/Users/seanhan/Documents/Playground/src/index.mjs` delegates to `/Users/seanhan/Documents/Playground/src/runtime-message-reply.mjs`
  - `/Users/seanhan/Documents/Playground/src/runtime-message-reply.mjs` owns `executeCanonicalLarkMessageReply(...)` / `executeCanonicalLarkMessageSend(...)`
  - `/Users/seanhan/Documents/Playground/src/comment-suggestion-workflow.mjs` and `/Users/seanhan/Documents/Playground/src/meeting-agent.mjs` still enter the same canonical message/runtime surface
- lane-executor 外部寫入經 `runCanonicalLarkMutation(...)`
- `http-server.mjs` / `index.mjs` / `comment-suggestion-workflow.mjs` / `meeting-agent.mjs` / `lane-executor.mjs` 不再直接呼叫 `executeLarkWrite(...)`
- `runDocumentCreateMutation(...)`
- `assertDocumentCreateAllowed(...)`
- comment rewrite apply 的 confirmation `peek` / `validate` 進 runtime
- drive/wiki apply 的 preview gate 不再在 route 層先 short-circuit，而是交給 runtime verifier block

目前固定檢查的 Phase 1 write-policy family 已擴成 registry-backed external action coverage：

- Doc / Drive / Wiki / Message / Calendar / Task / Bitable / Sheet 的 30 個 external actions
- 對應 33 條 checked-in route fixtures

這一層驗證 checked-in metadata 是否存在於：

- registry-backed route contract
- registry-backed write-policy enforcement fixture
- centralized runtime-only write bridge
- shared write-policy contract module

## CLI

```bash
npm run control:diagnostics
npm run control:diagnostics -- --json
npm run control:diagnostics -- --compare-previous
npm run control:diagnostics -- --compare-snapshot <run-id|path>
```

預設 human-readable 輸出固定回答：

- overall summary
- `control_summary`
- `routing_summary`
- `write_summary`
- one bounded decision line
- one bounded next-step line

`--json` 會輸出完整 report，固定包含：

- `diagnostics_summary`
- `control_summary`
- `routing_summary`
- `write_summary`
- `decision`

目前 `write_summary` 會額外暴露：

- `policy_actions`
- `policy_route_checks`
- `enforcement_route_checks`
- `enforcement_modes`
- `policy_coverage`
- `violation_type_stats`
- `runtime_stats`
- `rollout_advice`

其中：

- `enforcement_route_checks`
  - 每條 grounded write route 的 `mode` 與 check coverage
- `enforcement_modes`
  - 每條 route 的 mode 清單
  - 以及 `observe` / `warn` / `enforce` 計數
- `policy_coverage`
  - `metadata_route_count`
  - `enforced_route_count`
  - `metadata_action_count`
  - `enforced_action_count`
  - route / action coverage ratio
- `violation_type_stats`
  - deterministic policy self-check 統計
  - 目前固定看：
    - `missing_scope_key`
    - `missing_idempotency_key`
    - `confirm_required`
    - `review_required`
- `runtime_stats`
  - read-only trace aggregation from `http_request_trace_events.write_guard_decision`
  - every sample now carries:
    - `traffic_source`
      - `real`
      - `test`
      - `replay`
    - `request_backed`
      - `true|false`
  - exposes overall, source-layered, and request-backed-only sample count, violation rate, and scope/idempotency coverage rates
  - this is advisory evidence only; it must not mutate runtime behavior
- `rollout_advice`
  - per-route rollout view with:
    - `mode`
    - `target_mode`
    - `violation_rate`
    - `real_traffic_violation_rate`
    - `test_traffic_violation_rate`
    - `scope_key_coverage_rate`
    - `idempotency_key_coverage_rate`
    - `rollout_basis`
      - current trusted source = `real_request_backed`
      - `eligible`
      - `real_traffic_sample_count`
      - `real_traffic_violation_rate`
    - bounded `recommendation`
  - summary lists:
    - `upgrade_ready_routes`
    - `high_risk_routes`
    - `basis_summary`

目前 checked-in enforcement mode 分佈是：

- `enforce`
  - 27 routes
- `warn`
  - 4 routes
- `observe`
  - 2 routes
  - `warn`
- `drive_organize_apply`
  - `observe`
- `wiki_organize_apply`
  - `observe`
- `document_comment_rewrite_apply`
  - `warn`

compare mode 仍保持 read-only：

- current = 本次新產生的 diagnostics report
- compare target = previous archived control snapshot，或指定 snapshot/run-id
- `--json` 只額外加 `compare_summary`
- `compare_summary` 只保留有變化的欄位

目前 compare 只看：

- `overall_status`
- `control_status`
- `routing_status`
- `write_status`
- `control_issue_count`
- `routing_issue_count`
- `write_issue_count`

human-readable compare 使用固定方向標記：

- `↑` = worse
- `↓` = better
- `=` = unchanged

## Snapshot History

每次 `npm run control:diagnostics` 都會把完整 report 歸檔到：

- `.tmp/control-diagnostics-history/manifest.json`
- `.tmp/control-diagnostics-history/snapshots/<run-id>.json`

`manifest.json` 只保留最小 index：

- `run_id`
- `timestamp`
- `overall_status`
- `control_status`
- `routing_status`
- `write_status`
- `control_issue_count`
- `routing_issue_count`
- `write_issue_count`

單筆 snapshot 會保留完整 JSON report，供 operator 回溯：

- 哪條線先出問題
- 問題是 control / routing / write 哪一類
- 是 deterministic scenario drift、integration drift，還是 archived routing regression

## Decision Rules

目前 decision line 固定採用：

1. `control` fail -> 先看 control
2. `write` fail -> 再看 write
3. `routing` degrade/fail -> 再看 routing
4. 三條都穩定 -> `observe_only`

這條 decision 只提供 operator triage，不改任何 runtime gate。

## Exit Behavior

- `overall_status = fail` 時 CLI 以 non-zero exit code 結束
- `overall_status = degrade` 仍可成功輸出，因為這代表 drift/觀察，不等同 blocking write/runtime failure

## Boundary

這個 checkpoint 的定位是 observability / traceback，不是新的控制層。

它不能被描述成：

- autonomous repair runtime
- write approval runtime
- routing auto-fix loop
- company-brain formal approval flow

它只是把 control / write / routing 三條既有證據線做最小彙總與可回溯化。

## Gate Reuse

Phase 4 起，這條 read-only diagnostics 線也會被既有 gate 直接重用，但仍不改 runtime：

- `self-check` 直接重用目前 code truth 產生的 `control_summary`
- `self-check` 也會帶出同一份 write governance summary，而且只有在 `write_summary.status !== "pass"` 時才會 block `safe_to_change`
- `release-check` 的 JSON/CI report 也會帶出同一份 write governance snapshot，而且只有在 `write_summary.status !== "pass"` 時才會歸類成 `write_policy_failure`
- `self-check` / `release-check` 的 human-readable summary 也會帶出：
  - `real_only_violation_rate`
  - `是否可作為 rollout 依據`
  - `upgrade_ready_routes`
  - `high_risk_routes`
- `warn` / `observe` mode、`rollout_basis` 未成熟、或 `high_risk_routes` 存在，本身仍是 advisory evidence，不會單獨把 baseline/read-only gate 判成 fail
- `system_summary.safe_to_change` 必須同時滿足：
  - `base`
  - `control`
  - `write`
  - `routing`
  - `planner`
- `release-check` 新增最小 blocking 類別 `control_regression`
- `release-check` fail drilldown 若控制線先 block，會優先重用既有 control diagnostics snapshot/history，並把 `drilldown_source` 標成 `control diagnostics/history`

這條接線仍維持 read-only：

- 不會改 control runtime
- 不會新增 fallback
- 不會自動修正 control drift
- 不會把 detached trace sample 說成正式 production traffic evidence

## Phase 4 Rollout Basis

Phase 4 的 write rollout 判斷現在固定只看可信 evidence：

- source = `real`
- `request_backed = true`

warn -> enforce 目前最小規則是：

- `confirm_required` / `review_required` coverage 必須完整
- `real request-backed` sample size 必須達到最小門檻
- `real request-backed violation rate` 必須低於門檻

目前 checked-in 預設門檻為：

- `real traffic violation < 1%`
- `real request-backed sample size >= 20`

test / replay / detached sample 可以保留在 diagnostics 裡，但不能直接當 rollout 依據。
