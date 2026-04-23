# Canary usage (minimal)

```bash
# 一鍵：自動啟 HTTP-only server + runtime manager、等 readiness、跑 canary 與 check，最後輸出 summary
node scripts/run-autonomy-canary.mjs
```

```bash
# 1) 跑 20 筆實流量（同一 session）
bash scripts/run-canary.sh

# 2) 驗證 receipt/final 閉環 + summary
bash scripts/check-canary.sh
```

可調整：

```bash
BASE_URL="http://127.0.0.1:3333" SESSION_ID="autonomy-canary-1" bash scripts/run-canary.sh
BASE_URL="http://127.0.0.1:3333" SESSION_ID="autonomy-canary-1" bash scripts/check-canary.sh
```

可覆蓋 summary 用的 session / output：

```bash
SESSION_ID="autonomy-canary-1" OUT_DIR=".tmp/canary" node scripts/run-autonomy-canary.mjs
```

預設 `BASE_URL` 解析順序：

1. `BASE_URL`
2. `LARK_OAUTH_BASE_URL`
3. `http://127.0.0.1:${LARK_OAUTH_PORT:-3333}`
