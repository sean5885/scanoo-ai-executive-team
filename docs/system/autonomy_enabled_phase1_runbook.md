# AUTONOMY_ENABLED Phase 1 Scaffold Runbook

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Scope

這份 runbook 只覆蓋已落地的 Phase 1 autonomy scaffold：

- `/Users/seanhan/Documents/Playground/src/task-runtime/autonomy-job-types.mjs`
- `/Users/seanhan/Documents/Playground/src/task-runtime/autonomy-job-store.mjs`
- `/Users/seanhan/Documents/Playground/src/worker/enqueue-autonomy-job.mjs`
- `/Users/seanhan/Documents/Playground/src/worker/autonomy-worker-loop.mjs`
- `/Users/seanhan/Documents/Playground/src/worker/autonomy-runtime-manager.mjs`
- `/Users/seanhan/Documents/Playground/src/index.mjs`（主服務接線）
- `/Users/seanhan/Documents/Playground/scripts/run-autonomy-canary.mjs`（HTTP-only + runtime manager canary runner）

主流程不改；另外補充一個 Phase 3 cut 4 的最小 operator CLI ingress（僅 list-open / disposition）。
第一刀接線後，`npm run start:full` 的主服務會在同一 process 內受管啟動 autonomy runtime manager（單一 owner）。

## 0. Operator CLI Ingress（最小）

最小 operator CLI ingress 已落地：

- `/Users/seanhan/Documents/Playground/scripts/autonomy-operator-cli.mjs`

可用命令：

```bash
node scripts/autonomy-operator-cli.mjs list-open --limit 50
```

```bash
node scripts/autonomy-operator-cli.mjs disposition \
  --job-id <job_id> \
  --action <ack_waiting_user|ack_escalated|resume_same_job> \
  --reason <reason> \
  --operator-id <operator_id> \
  --request-id <request_id> \
  --expected-updated-at <incident.updated_at>
```

限制與保證：

- 不新增 HTTP/operator API。
- `disposition` 缺少 `job_id/action/reason/operator_id/request_id/expected_updated_at` 任一欄位時，不會寫入。
- `precondition_failed`、`open_incident_not_found`、`operator_action_lifecycle_sink_mismatch` 等 fail-soft 語義沿用 store 原樣輸出。

## 0A. Canary Script Base URL（實際執行）

`scripts/run-canary.sh` 與 `scripts/check-canary.sh` 的預設 `BASE_URL` 解析順序為：

1. `BASE_URL`
2. `LARK_OAUTH_BASE_URL`
3. `http://127.0.0.1:${LARK_OAUTH_PORT:-3333}`

因此若主服務使用預設 `LARK_OAUTH_PORT=3333`，可直接執行 canary 腳本，不必額外指定 `BASE_URL`。

worker canary execute 補充（已落地）：

- `planner_user_input_v1` 僅在 `AUTONOMY_CANARY_MODE=true` 且命中 canary 標記（`planner_input.text` 含 `autonomy canary` 或 `planner_input.session_key` 前綴為 `autonomy-canary-`）時，worker 才會先注入 deterministic `plannedDecision={ action: "get_runtime_info", params: {} }` 再執行 `executePlannedUserInput(...)`。
- 這是 queue-authoritative canary 的 throughput 保護；不改變 `completed` gate（仍需 execute success + verifier pass）。

## 0B. One-shot Autonomy Canary Runner（HTTP-only + runtime manager）

新增 one-shot runner：

- `/Users/seanhan/Documents/Playground/scripts/run-autonomy-canary.mjs`

用途：

- 自動啟 `src/http-only.mjs`（HTTP-only server，預設獨立 port，不依賴既有 3333）
- 自動啟受管 autonomy runtime manager（含 idle heartbeat）
- 自動注入 autonomy ingress 必要 env（`AUTONOMY_ENABLED=true`、`PLANNER_AUTONOMY_INGRESS_ENABLED=true`、`PLANNER_AUTONOMY_QUEUE_AUTHORITATIVE_ENABLED=true`、`PLANNER_AUTONOMY_QUEUE_AUTHORITATIVE_SAMPLING_PERCENT=100`、`AUTONOMY_CANARY_MODE=true`，並確保 allowlist 含 `session:<SESSION_ID>`）
- 先等 `/health` 與 worker heartbeat readiness，再跑 canary
- 依序執行 `scripts/run-canary.sh` + `scripts/check-canary.sh`
- fail-fast 保證：
  - `queue_hits=0` 直接失敗並輸出明確原因（不進 check phase）
  - `http-server` 或 `runtime-manager` 任一提前退出時立即失敗（不等待 timeout）
- 最後輸出固定 summary 欄位：`total / queue_hits / completed / failed / fallback`

執行方式：

```bash
node scripts/run-autonomy-canary.mjs
```

常用覆蓋：

```bash
SESSION_ID="autonomy-canary-1" OUT_DIR=".tmp/canary" node scripts/run-autonomy-canary.mjs
```

```bash
AUTONOMY_CANARY_PORT="3340" SESSION_ID="autonomy-canary-1" node scripts/run-autonomy-canary.mjs
```

## 1. 啟用前檢查

1. 進到 repo 根目錄。

```bash
cd /Users/seanhan/Documents/Playground
```

2. 確認必要環境變數存在（`src/config.mjs` 會要求 `LARK_APP_ID`、`LARK_APP_SECRET`）。

```bash
node --input-type=module -e 'import "dotenv/config"; const req=["LARK_APP_ID","LARK_APP_SECRET"]; const miss=req.filter((k)=>!process.env[k]); if(miss.length){console.error("missing_env", miss); process.exit(1);} console.log("env_ok", req);'
```

3. 確認/建立 autonomy tables（不改主流程，只做 schema ready）。

```bash
node --input-type=module -e 'import { ensureAutonomyJobTables } from "./src/task-runtime/autonomy-job-store.mjs"; ensureAutonomyJobTables(); console.log("autonomy_tables_ready");'
```

4. 先記錄目前 autonomy queue 狀態（作為回滾前後對照）。

```bash
node --input-type=module -e 'import db from "./src/db.mjs"; const rows=db.prepare("SELECT status, COUNT(*) AS count FROM autonomy_jobs GROUP BY status ORDER BY status").all(); console.log(JSON.stringify(rows, null, 2));'
```

## 2. 啟用步驟

1. 在要執行 enqueue / worker 的同一個 process 設定 `AUTONOMY_ENABLED=true`。

```bash
export AUTONOMY_ENABLED=true
```

2. 啟動主服務（受管 runtime manager 會自動啟 worker loop 並定時送 idle heartbeat）。

```bash
AUTONOMY_ENABLED=true npm run start:full
```

補充：worker execute timeout 可用 `AUTONOMY_EXECUTE_TIMEOUT_MS` 調整（預設 `60000` ms）。
補充：queued backlog stale guard 可用 `AUTONOMY_MAX_QUEUED_AGE_MS` 調整（預設 `60000` ms）。
補充：queued fresh-priority window 可用 `AUTONOMY_QUEUED_FRESH_PRIORITY_WINDOW_MS` 調整（預設 `60000` ms）。
補充：worker loop 在 claim 到 job 後會立即進下一輪（0ms）；只有 queue 為空時才套用 `pollIntervalMs`。

3. （可選）若要做 runbook 自訂 `job_type` 演練，可另外手動啟動 Phase 1 worker（前景執行，`Ctrl+C` 可停用）。

```bash
AUTONOMY_ENABLED=true node --input-type=module -e '
import { startAutonomyWorkerLoop } from "./src/worker/autonomy-worker-loop.mjs";
const loop = startAutonomyWorkerLoop({
  workerId: "phase1-runbook-worker",
  pollIntervalMs: 2000,
  heartbeatIntervalMs: 10000,
  leaseMs: 30000,
  logger: console,
  async executeJob({ job }) {
    if (job.job_type !== "runbook_smoke_job") {
      return { ok: false, error: "unsupported_job_type", data: { job_type: job.job_type } };
    }
    return {
      ok: true,
      handled_by: "phase1-runbook-worker",
      handled_at: new Date().toISOString(),
    };
  },
});
if (!loop.started) {
  console.error("worker_not_started", loop);
  process.exit(2);
}
console.log("worker_started", loop.worker_id);
const stop = () => { loop.stop(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => {}, 60000);
'
```

## 3. 停用步驟

1. 在主服務 terminal 按 `Ctrl+C`（`SIGINT/SIGTERM` 會觸發 manager stop + heartbeat timer stop）。
2. 關閉開關：

```bash
export AUTONOMY_ENABLED=false
```

3. 驗證停用合約（enqueue 必須回 `skipped=true` + `reason=autonomy_disabled`）。

```bash
AUTONOMY_ENABLED=false node --input-type=module -e 'import { enqueueAutonomyJob } from "./src/worker/enqueue-autonomy-job.mjs"; const result = await enqueueAutonomyJob({ jobType:"runbook_disable_probe", traceId:"runbook_disable_probe" }); console.log(JSON.stringify({ok:result?.ok, skipped:result?.skipped, reason:result?.reason, trace_id:result?.trace_id}, null, 2));'
```

## 4. 驗證步驟

1. 建立 smoke trace id 並 enqueue 一筆 smoke job。

```bash
TRACE_ID="runbook_smoke_$(date +%s)"
TRACE_ID="$TRACE_ID" AUTONOMY_ENABLED=true node --input-type=module -e 'import { enqueueAutonomyJob } from "./src/worker/enqueue-autonomy-job.mjs"; const traceId=process.env.TRACE_ID; const result = await enqueueAutonomyJob({ jobType:"runbook_smoke_job", payload:{source:"runbook"}, traceId, maxAttempts:1 }); console.log(JSON.stringify({traceId, ok:result?.ok, job_id:result?.job_id, status:result?.status, trace_id:result?.trace_id}, null, 2));'
```

2. 以 one-shot worker 執行一次 claim/execute/complete。

```bash
AUTONOMY_ENABLED=true node --input-type=module -e 'import { runAutonomyWorkerOnce } from "./src/worker/autonomy-worker-loop.mjs"; const result = await runAutonomyWorkerOnce({ workerId:"runbook-verify-worker", enabled:true, heartbeatIntervalMs:60000, async executeJob({ job }) { if (job.job_type !== "runbook_smoke_job") return { ok:false, error:"unsupported_job_type", data:{job_type:job.job_type} }; return { ok:true, handled_job_id:job.id, source:"runbook_verify" }; } }); console.log(JSON.stringify(result, null, 2));'
```

3. 查詢 DB，確認該 trace 的 job 轉成 `completed`，且有 attempt。

```bash
TRACE_ID="$TRACE_ID" node --input-type=module -e 'import db from "./src/db.mjs"; const traceId=process.env.TRACE_ID; const jobs=db.prepare("SELECT id, job_type, status, attempt_count, trace_id FROM autonomy_jobs WHERE trace_id = ?").all(traceId); const attempts=db.prepare("SELECT id, job_id, worker_id, status, trace_id FROM autonomy_job_attempts WHERE trace_id = ? ORDER BY created_at DESC").all(traceId); console.log(JSON.stringify({jobs, attempts}, null, 2));'
```

4. 驗證標準：

- enqueue 回傳 `ok=true`
- worker 回傳 `claimed=true` 且 `completed=true`
- `autonomy_jobs.status=completed`
- `autonomy_job_attempts.status=completed`

## Smoke Test（最小驗證）

1. 啟用 `AUTONOMY_ENABLED`。

```bash
cd /Users/seanhan/Documents/Playground
export AUTONOMY_ENABLED=true
export TRACE_ID="smoke_autonomy_$(date +%s)"
echo "$AUTONOMY_ENABLED $TRACE_ID"
```

預期結果：輸出 `true` 與 `smoke_autonomy_*` trace id。

2. enqueue 一個 demo job。

```bash
TRACE_ID="$TRACE_ID" AUTONOMY_ENABLED=true node --input-type=module -e 'import { enqueueAutonomyJob } from "./src/worker/enqueue-autonomy-job.mjs"; const traceId=process.env.TRACE_ID; const result=await enqueueAutonomyJob({ jobType:"smoke_demo_job", payload:{source:"smoke"}, traceId, maxAttempts:1 }); console.log(JSON.stringify({ok:result?.ok, job_id:result?.job_id, status:result?.status, trace_id:result?.trace_id}, null, 2));'
```

預期結果：`ok=true`，`status=queued`，且有 `job_id`。

3. 啟動 worker loop。

```bash
mkdir -p .tmp
AUTONOMY_ENABLED=true node --input-type=module -e 'import { startAutonomyWorkerLoop } from "./src/worker/autonomy-worker-loop.mjs"; const loop=startAutonomyWorkerLoop({ workerId:"smoke-worker", pollIntervalMs:1000, heartbeatIntervalMs:10000, leaseMs:30000, enabled:true, logger:console, async executeJob({ job }) { if (job.job_type !== "smoke_demo_job") return { ok:false, error:"unsupported_job_type", data:{ job_type: job.job_type } }; return { ok:true, handled_job_id: job.id, handled_by:"smoke-worker" }; } }); if (!loop.started) { console.error("worker_not_started"); process.exit(2); } console.log("worker_started", loop.worker_id); const stop=()=>{ loop.stop(); process.exit(0); }; process.on("SIGINT", stop); process.on("SIGTERM", stop); setInterval(() => {}, 60000);' > .tmp/autonomy-smoke-worker.log 2>&1 & echo $! > .tmp/autonomy-smoke-worker.pid
cat .tmp/autonomy-smoke-worker.pid
```

預期結果：輸出一個 PID，且 `.tmp/autonomy-smoke-worker.log` 出現 `autonomy_worker_loop_started`。

4. 查詢 SQLite（`autonomy_jobs` / `autonomy_job_attempts`）。

```bash
sleep 2
TRACE_ID="$TRACE_ID" node --input-type=module -e 'import db from "./src/db.mjs"; const traceId=process.env.TRACE_ID; const jobs=db.prepare("SELECT id, job_type, status, attempt_count, trace_id FROM autonomy_jobs WHERE trace_id = ?").all(traceId); const attempts=db.prepare("SELECT id, job_id, worker_id, status, trace_id FROM autonomy_job_attempts WHERE trace_id = ? ORDER BY created_at DESC").all(traceId); console.log(JSON.stringify({jobs, attempts}, null, 2));'
```

預期結果：`jobs` 與 `attempts` 各至少 1 筆。

5. 驗證 job 完成。

```bash
TRACE_ID="$TRACE_ID" node --input-type=module -e 'import db from "./src/db.mjs"; const traceId=process.env.TRACE_ID; const job=db.prepare("SELECT status FROM autonomy_jobs WHERE trace_id = ? ORDER BY created_at DESC LIMIT 1").get(traceId); const attempt=db.prepare("SELECT status FROM autonomy_job_attempts WHERE trace_id = ? ORDER BY created_at DESC LIMIT 1").get(traceId); if (job?.status !== "completed" || attempt?.status !== "completed") { console.error(JSON.stringify({ job, attempt }, null, 2)); process.exit(1); } console.log(JSON.stringify({ job_status: job.status, attempt_status: attempt.status }, null, 2));'
```

預期結果：輸出 `job_status=completed`、`attempt_status=completed`，並以 exit code `0` 結束。

6. 停止 worker。

```bash
kill "$(cat .tmp/autonomy-smoke-worker.pid)"
sleep 1
ps -p "$(cat .tmp/autonomy-smoke-worker.pid)" >/dev/null && echo "still_running" || echo "worker_stopped"
```

預期結果：輸出 `worker_stopped`。

## 5. 回滾步驟

1. 停 worker（`Ctrl+C`），並設回 `AUTONOMY_ENABLED=false`。

```bash
export AUTONOMY_ENABLED=false
```

2. 清除 runbook 產生的 smoke/probe 資料（只清 `runbook_*` trace）。

```bash
node --input-type=module -e 'import db from "./src/db.mjs"; const deletedAttempts = db.prepare("DELETE FROM autonomy_job_attempts WHERE trace_id LIKE ? OR trace_id = ?").run("runbook_smoke_%", "runbook_disable_probe"); const deletedJobs = db.prepare("DELETE FROM autonomy_jobs WHERE trace_id LIKE ? OR trace_id = ?").run("runbook_smoke_%", "runbook_disable_probe"); console.log(JSON.stringify({deletedAttempts:deletedAttempts.changes, deletedJobs:deletedJobs.changes}, null, 2));'
```

3. 最終確認沒有遺留 runbook 記錄。

```bash
node --input-type=module -e 'import db from "./src/db.mjs"; const row=db.prepare("SELECT COUNT(*) AS count FROM autonomy_jobs WHERE trace_id LIKE ? OR trace_id = ?").get("runbook_smoke_%", "runbook_disable_probe"); console.log(JSON.stringify(row, null, 2));'
```

## 6. 風險與 Guardrail

- 風險：`AUTONOMY_ENABLED=true` 現在會由主服務自動接線到受管 runtime manager，但仍不是 background worker mesh / distributed coordination。
  - Guardrail：只把它視為單機單 owner 的 Phase 1 managed runtime。
- 風險：`startAutonomyWorkerLoop` 預設 `executeJob` 會回 `ok:true`。
  - Guardrail：永遠傳入明確 `executeJob`，並限制可處理 `job_type`（本 runbook 僅允許 `runbook_smoke_job`）。
- 風險：單筆 execute 若外部依賴卡住，可能阻塞單一 loop 後續 claim。
  - Guardrail：worker execute 現在有 `AUTONOMY_EXECUTE_TIMEOUT_MS`（預設 60s）硬性 timeout；timeout 會 abort in-flight execute signal，並走既有 fail-soft failed path。
- 風險：舊的 queued backlog 可能長時間堵住新 queue-authoritative job。
  - Guardrail：claim 前會先套用 stale fail-soft（`AUTONOMY_MAX_QUEUED_AGE_MS`，預設 60s），超時 queued 轉 `failed(queued_job_stale_timeout)`、過期過久的 running 轉 `failed(running_job_stale_timeout)`；queued claim 採 recent-window 優先 + FIFO（`AUTONOMY_QUEUED_FRESH_PRIORITY_WINDOW_MS`，預設 60s）以避免舊 backlog 阻塞新批次，同時避免同批次飢餓。
- 風險：autonomy tables 與主 DB 同一個 SQLite（`RAG_SQLITE_PATH`）。
  - Guardrail：所有演練都加 `trace_id=runbook_*`，可精準清理。
- 風險：worker 雖已受管於主服務 process，但仍無跨進程 supervisor/租約仲裁。
  - Guardrail：同一環境只啟動一個主服務實例；如需手動演練 worker，避免與主服務重疊長時間並行。
- 風險：`maxAttempts` 預設 1，錯誤後不一定重試。
  - Guardrail：驗證時明確設定 `maxAttempts`，並用 DB 查 `attempt_count/max_attempts`。

## 7. 故障處理（最小版）

1. 症狀：enqueue 回 `autonomy_disabled`。

- 檢查：

```bash
AUTONOMY_ENABLED=${AUTONOMY_ENABLED:-""} node --input-type=module -e 'import { isAutonomyEnabled } from "./src/task-runtime/autonomy-job-types.mjs"; console.log(JSON.stringify({raw:process.env.AUTONOMY_ENABLED, enabled:isAutonomyEnabled()}, null, 2));'
```

- 處理：把同一個執行 process 的 `AUTONOMY_ENABLED` 設成 `true` 再重試。

2. 症狀：job 長時間 `running` 不前進。

- 檢查：

```bash
node --input-type=module -e 'import db from "./src/db.mjs"; const rows=db.prepare("SELECT id, status, lease_owner, lease_expires_at, attempt_count, max_attempts, trace_id FROM autonomy_jobs WHERE status IN (\"queued\",\"running\",\"failed\") ORDER BY updated_at DESC LIMIT 20").all(); console.log(JSON.stringify(rows, null, 2));'
```

- 處理：先停掉舊 worker，再用 `runAutonomyWorkerOnce` 啟動新 worker reclaim；僅對 `runbook_*` trace 做 cleanup。

3. 症狀：worker 啟動但一直 claim 不到 job。

- 檢查 `autonomy_jobs` 是否真的有 `queued` 且 `next_run_at <= now`。
- 若只有 `failed`，代表已耗盡重試，需要重新 enqueue 新 job（保留新 trace）。
