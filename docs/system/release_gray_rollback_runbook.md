# Release Gray/Rollback Runbook

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

Last verified in this repo on 2026-05-07.

## Purpose

本 runbook 定義 production rollout 的灰度與回滾執行步驟，並強制使用雙門檻 gate：

- Capability gate
- Experience gate

若任一門檻不滿足，該階段必須立刻 freeze，不可升級。

## Prerequisite Commands

每一輪灰度窗口開始前，固定執行：

```bash
node scripts/live-eval-runner.mjs
node scripts/memory-influence-gate.mjs --json
node scripts/real-traffic-evidence.mjs --json
npm run release-check:ci
node scripts/quality-dashboard.mjs
node scripts/deadletter-replay-runner.mjs --json
```

必要條件：

- `release-check` 的 `capability_gate.status = pass`
- `release-check` 的 `experience_gate.status = pass`
- `release-check` 不可含 `blocking_checks=sample_insufficient`
- `release-check` 的 `collab_gate.status = pass`（樣本達門檻後）
- `overall_status = pass`
- `real-traffic-evidence` 的 `overall_status = pass`（24h/72h/336h 視窗都達門檻）
- `release-check` 不可含 `blocking_checks=memory_influence_gate_failure`

若因 `blocking_checks=sample_insufficient` 被卡住，先補樣本再進灰度：

```bash
npm run eval:collab-bootstrap -- --parallel-graphs 80 --deadletter-graphs 20 --json
node scripts/quality-dashboard.mjs --json
npm run check:release -- --json
```

## Gate Thresholds

### Capability gate (hard)

- `pdf_task_success_rate >= 0.90`
- `evidence_coverage_rate >= 1.00`
- `tool_permission_violation_count = 0`
- `blocked_misreported_completed_count = 0`

### Experience gate (hard)

- `task_success_rate >= 0.85`
- `fake_completion_rate < 0.02`
- usage-layer 既有 gate = `pass`
- routing/planner regression = `false`

## Gray Rollout Stages

### Stage 1: 5% (24h)

- 開啟 5% authoritative sampling。
- 24 小時內每個觀測窗口都必須雙門檻 pass。
- 若 fail：freeze，停止升級。

### Stage 2: 20% (24h)

- 只有 Stage 1 全窗口 pass 才可升到 20%。
- 24 小時內每個觀測窗口都必須雙門檻 pass。
- 若 fail：freeze，停止升級。

### Stage 3: 50% (24h)

- 只有 Stage 2 全窗口 pass 才可升到 50%。
- 24 小時內每個觀測窗口都必須雙門檻 pass。
- 若 fail：freeze，停止升級。

### Stage 4: 100% (48h)

- 只有 Stage 3 全窗口 pass 才可升到 100%。
- 48 小時內每個觀測窗口都必須雙門檻 pass。
- 若 fail：freeze，停止升級並進入 rollback。

## Rollback Triggers

任一條件成立即回滾：

- `fake_completion_rate >= 0.03` 連續 2 個窗口
- `pdf_task_success_rate < 0.85`
- `blocked_misreported_completed_count > 0`
- `release-check overall_status = fail`

## Rollback Actions

1. 將 authoritative sampling 降為 0。
2. 切回前一穩定策略版本。
3. 產生 incident 記錄。
4. 產生 deadletter 重放清單。

## Incident Minimum Record

incident 至少包含：

- `incident_id`
- `started_at`
- `trigger_condition`
- `failed_window`
- `release_check_run_id`
- `live_eval_run_id`
- `rollback_version`
- `deadletter_replay_plan`

## Freeze/Resume Rule

- freeze 後不得直接升下一階段。
- 必須先完成 rollback、補證據、重新跑 `live-eval-runner` + `release-check:ci` + `quality-dashboard`。
- 重新啟動時從 5% 重新開始。
