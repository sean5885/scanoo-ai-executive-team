#!/bin/bash
echo "=== LOBSTER AUDIT v1.2 ==="
date

TIMEOUT_CMD=""
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_CMD="timeout"
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_CMD="gtimeout"
fi

# 1. tests（防卡死 + 不吃輸出）
echo -e "\n[1] tests"
if [ -n "$TIMEOUT_CMD" ]; then
  "$TIMEOUT_CMD" 20s node --test 2>&1 | tee /tmp/lobster-test.log
  TEST_EXIT=${PIPESTATUS[0]}
else
  echo "⚠️ timeout command not found; using python timeout fallback"
  python3 - <<'PY'
import os
import signal
import subprocess
import sys
import threading

log_path = "/tmp/lobster-test.log"
timed_out = False

with open(log_path, "w", encoding="utf-8", errors="replace") as log:
    proc = subprocess.Popen(
        ["node", "--test"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        start_new_session=True,
    )

    def pump_stdout():
        if not proc.stdout:
            return
        for line in proc.stdout:
            sys.stdout.write(line)
            sys.stdout.flush()
            log.write(line)
            log.flush()

    pump_thread = threading.Thread(target=pump_stdout, daemon=True)
    pump_thread.start()
    try:
        proc.wait(timeout=20)
    except subprocess.TimeoutExpired:
        timed_out = True
        os.killpg(proc.pid, signal.SIGKILL)
        proc.wait()
    finally:
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGKILL)
        proc.wait()
        pump_thread.join(timeout=2)

sys.exit(124 if timed_out else proc.returncode)
PY
  TEST_EXIT=$?
fi

if [ $TEST_EXIT -eq 124 ]; then
  echo "⚠️ tests timeout (20s)"
fi

# 2. skill contract（精準一點）
echo -e "\n[2] skill contract"
for f in ./src/skills/*.mjs; do
  name=$(basename "$f")
  has_intent=$(grep -E "intent\s*:" "$f" | wc -l)
  has_criteria=$(grep -E "criteria_failed" "$f" | wc -l)
  if [ "$has_intent" -eq 0 ] || [ "$has_criteria" -eq 0 ]; then
    echo "⚠️ $name missing contract"
  fi
done

# 3. reflection
echo -e "\n[3] reflection"
[ -f "./src/reflection/skill-reflection.mjs" ] \
  && echo "OK reflection file" || echo "❌ no reflection file"

grep "emitSkillReflection" ./src/planner/skill-bridge.mjs >/dev/null \
  && echo "OK hook" || echo "❌ hook missing"

# 4. read-runtime
echo -e "\n[4] read-runtime"
grep -E "access_token|accessToken" ./src/read-runtime.mjs >/dev/null \
  && echo "OK token normalize" || echo "❌ token normalize missing"

echo -e "\n=== DONE ==="
