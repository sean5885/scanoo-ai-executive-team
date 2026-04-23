# Canary usage

## 必要前提

- 已在 repo root：`/Users/seanhan/Documents/Playground`
- 已安裝依賴（`npm install`）
- 已提供 Lark 基本 env（至少 `LARK_APP_ID`、`LARK_APP_SECRET`）
- autonomy tables 已存在（可執行一次 `node --input-type=module -e 'import { ensureAutonomyJobTables } from "./src/task-runtime/autonomy-job-store.mjs"; ensureAutonomyJobTables(); console.log("autonomy_tables_ready");'`）

## 推薦：one-shot runner（與手動可行流程一致）

```bash
node scripts/run-autonomy-canary.mjs
```

runner 會自動做這些事：

- 用獨立 port 啟 `src/http-only.mjs`（可用 `AUTONOMY_CANARY_PORT` 覆蓋）
- 啟 `autonomy runtime manager`（含 idle heartbeat + worker loop）
- 注入 autonomy ingress 必要 env（`AUTONOMY_ENABLED=true`、`PLANNER_AUTONOMY_INGRESS_ENABLED=true`、`PLANNER_AUTONOMY_QUEUE_AUTHORITATIVE_ENABLED=true`、`PLANNER_AUTONOMY_QUEUE_AUTHORITATIVE_SAMPLING_PERCENT=100`、`AUTONOMY_CANARY_MODE=true`、allowlist 含 `session:<SESSION_ID>`）
- readiness 成功後才跑 `scripts/run-canary.sh` 與 `scripts/check-canary.sh`
- 若 `queue_hits=0` 或 `http-server/runtime-manager` 任一提前退出，立即 fail-fast 並帶明確原因（exit code 非 0）

常用覆蓋：

```bash
SESSION_ID="autonomy-canary-1" OUT_DIR=".tmp/canary" node scripts/run-autonomy-canary.mjs
AUTONOMY_CANARY_PORT="3340" SESSION_ID="autonomy-canary-1" node scripts/run-autonomy-canary.mjs
```

## 手動模式（兩進程）

1. 啟 HTTP-only server（同一個 `SESSION_ID`，帶 ingress env）：

```bash
AUTONOMY_ENABLED=true \
AUTONOMY_CANARY_MODE=true \
PLANNER_AUTONOMY_INGRESS_ENABLED=true \
PLANNER_AUTONOMY_QUEUE_AUTHORITATIVE_ENABLED=true \
PLANNER_AUTONOMY_QUEUE_AUTHORITATIVE_SAMPLING_PERCENT=100 \
PLANNER_AUTONOMY_INGRESS_ALLOWLIST="session:autonomy-canary-1" \
LARK_OAUTH_PORT=3340 \
node src/http-only.mjs
```

2. 另一個 terminal 啟 runtime manager：

```bash
AUTONOMY_ENABLED=true AUTONOMY_CANARY_MODE=true node --input-type=module -e '
import { startAutonomyRuntimeManager, stopAutonomyRuntimeManager } from "./src/worker/autonomy-runtime-manager.mjs";
const status = startAutonomyRuntimeManager({ logger: console });
console.log("[manager] start_status", JSON.stringify(status));
if (status?.status !== "running") process.exit(2);
const shutdown = () => { try { stopAutonomyRuntimeManager({ logger: console }); } catch {} process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
setInterval(() => {}, 60000);
'
```

3. readiness 後執行 canary + check：

```bash
BASE_URL="http://127.0.0.1:3340" SESSION_ID="autonomy-canary-1" bash scripts/run-canary.sh
BASE_URL="http://127.0.0.1:3340" SESSION_ID="autonomy-canary-1" bash scripts/check-canary.sh
```
