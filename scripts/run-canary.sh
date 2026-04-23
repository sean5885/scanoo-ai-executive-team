#!/usr/bin/env bash
set -euo pipefail

DEFAULT_BASE_URL="${LARK_OAUTH_BASE_URL:-http://127.0.0.1:${LARK_OAUTH_PORT:-3333}}"
BASE_URL="${BASE_URL:-${DEFAULT_BASE_URL}}"
BASE_URL="${BASE_URL%/}"
SESSION_ID="${SESSION_ID:-autonomy-canary-1}"
REQUEST_COUNT="${REQUEST_COUNT:-20}"
OUT_DIR="${OUT_DIR:-.tmp/canary}"
REQUESTS_JSONL="${REQUESTS_JSONL:-${OUT_DIR}/${SESSION_ID}.requests.jsonl}"
RAW_DIR="${RAW_DIR:-${OUT_DIR}/raw}"
MIN_DELAY_MS="${MIN_DELAY_MS:-500}"
MAX_DELAY_MS="${MAX_DELAY_MS:-1000}"

if ! [[ "${REQUEST_COUNT}" =~ ^[0-9]+$ ]] || (( REQUEST_COUNT <= 0 )); then
  echo "REQUEST_COUNT must be a positive integer" >&2
  exit 1
fi

if ! [[ "${MIN_DELAY_MS}" =~ ^[0-9]+$ && "${MAX_DELAY_MS}" =~ ^[0-9]+$ ]] || (( MIN_DELAY_MS > MAX_DELAY_MS )); then
  echo "MIN_DELAY_MS/MAX_DELAY_MS invalid" >&2
  exit 1
fi

export AUTONOMY_ENABLED=true
export PLANNER_AUTONOMY_INGRESS_ENABLED=true
export PLANNER_AUTONOMY_QUEUE_AUTHORITATIVE_ENABLED=true
export PLANNER_AUTONOMY_INGRESS_ALLOWLIST="session:${SESSION_ID}"
export PLANNER_AUTONOMY_QUEUE_AUTHORITATIVE_SAMPLING_PERCENT=100

mkdir -p "${OUT_DIR}" "${RAW_DIR}"
: > "${REQUESTS_JSONL}"

echo "[canary] base_url=${BASE_URL} session=${SESSION_ID} count=${REQUEST_COUNT}"
echo "[canary] output_jsonl=${REQUESTS_JSONL}"

extract_header() {
  local header_file="$1"
  local header_name="$2"
  awk -F': *' -v target="${header_name}" '
    tolower($1) == tolower(target) {
      gsub(/\r/, "", $2);
      print $2;
    }
  ' "${header_file}" | tail -n 1
}

bool_from_body() {
  local body_file="$1"
  if grep -q 'queue_authoritative_pending' "${body_file}" \
    || grep -q '背景 worker 接手處理' "${body_file}" \
    || grep -q '非最終完成狀態' "${body_file}"; then
    echo "true"
  else
    echo "false"
  fi
}

for ((i = 1; i <= REQUEST_COUNT; i += 1)); do
  ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  prompt="autonomy canary ${SESSION_ID} sample #${i} at ${ts}"
  header_file="${RAW_DIR}/request-${i}.headers.txt"
  body_file="${RAW_DIR}/request-${i}.body.json"

  http_status="$(curl -sS -G \
    -D "${header_file}" \
    -o "${body_file}" \
    -w "%{http_code}" \
    -H "X-Session-Id: ${SESSION_ID}" \
    -H "X-Lobster-Traffic-Source: real" \
    --data-urlencode "q=${prompt}" \
    --data-urlencode "session_key=${SESSION_ID}" \
    "${BASE_URL}/answer")"

  request_id="$(extract_header "${header_file}" "X-Request-Id")"
  trace_id="$(extract_header "${header_file}" "X-Trace-Id")"

  if [[ -z "${request_id}" || -z "${trace_id}" ]]; then
    echo "[canary] missing request_id/trace_id on request ${i}" >&2
    echo "[canary] headers file: ${header_file}" >&2
    exit 2
  fi

  queue_hit="$(bool_from_body "${body_file}")"
  fallback_suspected="false"
  if [[ "${queue_hit}" != "true" ]]; then
    fallback_suspected="true"
  fi

  printf '{"index":%d,"timestamp":"%s","request_id":"%s","trace_id":"%s","http_status":%s,"queue_authoritative_hit":%s,"fallback_suspected":%s}\n' \
    "${i}" "${ts}" "${request_id}" "${trace_id}" "${http_status}" "${queue_hit}" "${fallback_suspected}" \
    >> "${REQUESTS_JSONL}"

  echo "[${i}/${REQUEST_COUNT}] request_id=${request_id} trace_id=${trace_id} status=${http_status} queue_hit=${queue_hit}"

  if (( i < REQUEST_COUNT )); then
    range=$((MAX_DELAY_MS - MIN_DELAY_MS + 1))
    delay_ms=$((MIN_DELAY_MS + RANDOM % range))
    sleep "$(awk -v ms="${delay_ms}" 'BEGIN { printf "%.3f", ms / 1000 }')"
  fi
done

queue_hits="$(grep -c '"queue_authoritative_hit":true' "${REQUESTS_JSONL}" || true)"
fallback_hits="$(grep -c '"fallback_suspected":true' "${REQUESTS_JSONL}" || true)"

echo "[canary] done total=${REQUEST_COUNT} queue_hits=${queue_hits} fallback_suspected=${fallback_hits}"
echo "[canary] jsonl=${REQUESTS_JSONL}"
