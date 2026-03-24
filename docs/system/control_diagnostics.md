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

- `/Users/seanhan/Documents/Playground/src/write-guard.mjs`
- `/Users/seanhan/Documents/Playground/src/lark-write-guard.mjs`
- `/Users/seanhan/Documents/Playground/src/http-server.mjs`
- `/Users/seanhan/Documents/Playground/src/meeting-agent.mjs`
- `/Users/seanhan/Documents/Playground/src/lark-content.mjs`

它會做兩種檢查：

1. fixed deterministic guard scenarios
2. checked-in runtime integration surface scan

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

- `document_company_brain_ingest`
- `drive_organize_apply`
- `wiki_organize_apply`
- `meeting_confirm_write`
- `document_comment_rewrite_apply`
- `planDocumentCreateGuard(...)`
- `assertDocumentCreateAllowed(...)`

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
