# Control Diagnostics Reporting Enhancement

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Purpose

這份文件記錄 thread117 對 control diagnostics 做的觀測層增強。

本次變更只增加 read-only reporting 資訊，目標是讓 operator 更快定位 control / routing / write 線上的 regressions，同時維持既有 gate 與 runtime 行為完全不變。

## Scope

這次只增強：

- `src/control-diagnostics.mjs` 的 additive reporting summary
- `scripts/control-diagnostics.mjs` 的 human-readable reporting line
- archived control diagnostics snapshot 中隨 report 一起保存的 reporting data

這次不修改：

- `src/system-self-check.mjs`
- `src/release-check.mjs`
- `src/http-server.mjs`
- `src/write-guard.mjs`
- `src/control-kernel.mjs`
- `docs/system/modules.md`

## Added Read-Only Fields

`runControlDiagnostics(...)` 仍維持既有：

- `diagnostics_summary`
- `control_summary`
- `routing_summary`
- `write_summary`
- `decision`

另外新增一個 additive 區塊：

- `reporting_summary`

`reporting_summary` 目前包含：

- `error_code_class_count`
- `failure_group_count`
- `top_regression_case_count`
- `error_code_classes`
- `failure_groups`
- `top_regression_cases`

### error code classification

這一層會把目前 diagnostics issue / routing top miss evidence 轉成穩定的 error-code family，例如：

- `control_scenario_failed`
- `control_integration_missing`
- `write_scenario_failed`
- `routing_compare_regression`
- `routing_top_miss:ROUTING_NO_MATCH`

這只是觀測分類，不會反向改寫 runtime error code，也不會影響 downstream gate 判定。

### failure grouping

這一層把 operator 常見 triage 視角壓成固定 group，例如：

- `control:deterministic_scenarios`
- `control:integration_surface`
- `write:integration_surface`
- `routing:compare_regression`
- `routing:top_miss_cases`

這些 group 只用來摘要與排序，不新增任何 blocking gate。

### top regression cases

這一層把目前最值得先看的案例做固定排序，來源包含：

- control/write/routing issue entries
- routing archived snapshot 內的 `top_miss_cases`

排序規則固定優先看：

1. `control`
2. `write`
3. `routing`

同一條線內再用固定 source/type 順序排序，確保同一份 snapshot 會得到穩定輸出。

## CLI Output

`npm run control:diagnostics` 仍保留原本摘要與 decision line，只額外增加：

- `reporting_summary`
- `top_regressions`

`--json`、snapshot archive、`--compare-previous`、`--compare-snapshot <run-id|path>` 都維持可用。

compare logic 仍只看原本既定 compare fields，不把 reporting summary 變成新的 gate 或 compare contract。

## Non-Goals

本次 enhancement 明確不做以下事情：

- 不改 control / write / routing runtime 行為
- 不改 `self-check` / `release-check` 決策
- 不改 planner / company-brain contract
- 不新增 fallback
- 不新增 blocking gate
- 不把 reporting summary 說成 approval / repair runtime

## Verification Notes

驗證重點如下：

- error code grouping 能穩定輸出
- failure grouping 能穩定輸出
- top regression cases 能穩定排序
- compare / snapshot 行為維持原樣
- `diagnostics_summary` 與既有 decision 結論不變
