#!/usr/bin/env bash
set -euo pipefail

DEFAULT_BASE_URL="${LARK_OAUTH_BASE_URL:-http://127.0.0.1:${LARK_OAUTH_PORT:-3333}}"
BASE_URL="${BASE_URL:-${DEFAULT_BASE_URL}}"
BASE_URL="${BASE_URL%/}"
SESSION_ID="${SESSION_ID:-autonomy-canary-1}"
OUT_DIR="${OUT_DIR:-.tmp/canary}"
REQUESTS_JSONL="${REQUESTS_JSONL:-${OUT_DIR}/${SESSION_ID}.requests.jsonl}"
CHECK_JSONL="${CHECK_JSONL:-${OUT_DIR}/${SESSION_ID}.check.jsonl}"
POLL_INTERVAL_SEC="${POLL_INTERVAL_SEC:-1}"
FINAL_TIMEOUT_SEC="${FINAL_TIMEOUT_SEC:-180}"

if [[ ! -s "${REQUESTS_JSONL}" ]]; then
  echo "missing requests jsonl: ${REQUESTS_JSONL}" >&2
  exit 1
fi

mkdir -p "${OUT_DIR}"
: > "${CHECK_JSONL}"

extract_json_string_field() {
  local line="$1"
  local key="$2"
  local compact
  compact="$(printf '%s' "${line}" | tr -d '\r\n')"
  printf '%s' "${compact}" | sed -nE "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\"([^\"]*)\".*/\1/p"
}

extract_json_bool_field() {
  local line="$1"
  local key="$2"
  local compact
  compact="$(printf '%s' "${line}" | tr -d '\r\n')"
  printf '%s' "${compact}" | sed -nE "s/.*\"${key}\"[[:space:]]*:[[:space:]]*(true|false).*/\1/p"
}

normalize_iso_without_ms() {
  local iso="$1"
  if [[ "${iso}" =~ ^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(\.[0-9]+)?Z$ ]]; then
    printf '%sZ' "${BASH_REMATCH[1]}"
    return
  fi
  printf '%s' "${iso}"
}

iso_to_epoch() {
  local iso="$1"
  local normalized
  normalized="$(normalize_iso_without_ms "${iso}")"
  if [[ -z "${normalized}" ]]; then
    return 1
  fi

  if date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "${normalized}" "+%s" >/dev/null 2>&1; then
    date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "${normalized}" "+%s"
    return 0
  fi

  if date -u -d "${normalized}" "+%s" >/dev/null 2>&1; then
    date -u -d "${normalized}" "+%s"
    return 0
  fi

  return 1
}

fetch_receipt() {
  local request_id="$1"
  local trace_id="$2"
  curl -sS -G \
    -H "X-Session-Id: ${SESSION_ID}" \
    -H "X-Request-Id: ${request_id}" \
    -H "X-Trace-Id: ${trace_id}" \
    --data-urlencode "request_id=${request_id}" \
    --data-urlencode "trace_id=${trace_id}" \
    "${BASE_URL}/api/monitoring/autonomy/receipt"
}

fetch_final() {
  local request_id="$1"
  local trace_id="$2"
  curl -sS -G \
    -H "X-Session-Id: ${SESSION_ID}" \
    -H "X-Request-Id: ${request_id}" \
    -H "X-Trace-Id: ${trace_id}" \
    --data-urlencode "request_id=${request_id}" \
    --data-urlencode "trace_id=${trace_id}" \
    "${BASE_URL}/api/monitoring/autonomy/final"
}

total=0
queue_hits=0
enqueue_success=0
completed_count=0
fail_count=0
fallback_count=0

while IFS= read -r line || [[ -n "${line}" ]]; do
  [[ -z "${line}" ]] && continue
  total=$((total + 1))

  request_id="$(extract_json_string_field "${line}" "request_id")"
  trace_id="$(extract_json_string_field "${line}" "trace_id")"
  request_ts="$(extract_json_string_field "${line}" "timestamp")"
  queue_hit="$(extract_json_bool_field "${line}" "queue_authoritative_hit")"
  fallback_suspected="$(extract_json_bool_field "${line}" "fallback_suspected")"

  if [[ "${queue_hit}" == "true" ]]; then
    queue_hits=$((queue_hits + 1))
  fi
  if [[ "${fallback_suspected}" == "true" ]]; then
    fallback_count=$((fallback_count + 1))
  fi

  receipt_json="$(fetch_receipt "${request_id}" "${trace_id}")"
  receipt_status="$(extract_json_string_field "${receipt_json}" "status")"
  if [[ -n "${receipt_status}" && "${receipt_status}" != "not_found" ]]; then
    enqueue_success=$((enqueue_success + 1))
  fi

  poll_started_epoch="$(date +%s)"
  final_json='{}'
  final_status="not_found"
  timed_out="false"

  while true; do
    final_json="$(fetch_final "${request_id}" "${trace_id}")"
    final_status="$(extract_json_string_field "${final_json}" "status")"

    if [[ "${final_status}" == "completed" || "${final_status}" == "failed" ]]; then
      break
    fi

    now_epoch="$(date +%s)"
    if (( now_epoch - poll_started_epoch >= FINAL_TIMEOUT_SEC )); then
      timed_out="true"
      break
    fi

    sleep "${POLL_INTERVAL_SEC}"
  done

  completed="false"
  latency="na"
  final_updated_at="$(extract_json_string_field "${final_json}" "updated_at")"

  if [[ "${final_status}" == "completed" ]]; then
    completed="true"
    completed_count=$((completed_count + 1))
  else
    fail_count=$((fail_count + 1))
  fi

  if [[ -n "${request_ts}" && -n "${final_updated_at}" ]]; then
    if request_epoch="$(iso_to_epoch "${request_ts}")" && final_epoch="$(iso_to_epoch "${final_updated_at}")"; then
      latency_sec=$((final_epoch - request_epoch))
      if (( latency_sec < 0 )); then
        latency_sec=0
      fi
      latency="${latency_sec}s"
    fi
  fi

  printf '[%02d] request_id=%s receipt_status=%s final_status=%s completed=%s latency=%s\n' \
    "${total}" "${request_id}" "${receipt_status:-unknown}" "${final_status:-unknown}" "${completed}" "${latency}"

  printf '{"index":%d,"request_id":"%s","trace_id":"%s","receipt_status":"%s","final_status":"%s","completed":%s,"latency":"%s","timed_out":%s}\n' \
    "${total}" "${request_id}" "${trace_id}" "${receipt_status:-unknown}" "${final_status:-unknown}" "${completed}" "${latency}" "${timed_out}" \
    >> "${CHECK_JSONL}"
done < "${REQUESTS_JSONL}"

echo
echo "=== Canary Summary ==="
echo "total requests: ${total}"
echo "queue_authoritative 命中數: ${queue_hits}"
echo "enqueue 成功數: ${enqueue_success}"
echo "completed 數: ${completed_count}"
echo "fail 數: ${fail_count}"
echo "fallback 數(heuristic): ${fallback_count}"
echo "check_jsonl: ${CHECK_JSONL}"
