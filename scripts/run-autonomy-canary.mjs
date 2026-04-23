#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readAutonomyWorkerReadiness } from "../src/task-runtime/autonomy-job-store.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const sessionId = process.env.SESSION_ID || `autonomy-canary-${Date.now()}`;
const outDir = process.env.OUT_DIR || ".tmp/canary";
const requestsJsonl = process.env.REQUESTS_JSONL || `${outDir}/${sessionId}.requests.jsonl`;
const checkJsonl = process.env.CHECK_JSONL || `${outDir}/${sessionId}.check.jsonl`;
const baseUrlFromEnv = process.env.BASE_URL
  || process.env.LARK_OAUTH_BASE_URL
  || `http://127.0.0.1:${process.env.LARK_OAUTH_PORT || "3333"}`;
const baseUrl = baseUrlFromEnv.replace(/\/+$/, "");

const ENV = {
  ...process.env,
  AUTONOMY_ENABLED: "true",
  AUTONOMY_MAX_QUEUED_AGE_MS: process.env.AUTONOMY_MAX_QUEUED_AGE_MS || "1800000",
  AUTONOMY_EXECUTE_TIMEOUT_MS: process.env.AUTONOMY_EXECUTE_TIMEOUT_MS || "180000",
  AUTONOMY_CANARY_MODE: process.env.AUTONOMY_CANARY_MODE || "1",
  SESSION_ID: sessionId,
  OUT_DIR: outDir,
  REQUESTS_JSONL: requestsJsonl,
  CHECK_JSONL: checkJsonl,
  BASE_URL: baseUrl,
};

const managerEntrypoint = `
import { startAutonomyRuntimeManager, stopAutonomyRuntimeManager } from "./src/worker/autonomy-runtime-manager.mjs";
const status = startAutonomyRuntimeManager({ logger: console });
console.log("[manager] start_status", JSON.stringify(status));
if (status?.status !== "running") {
  process.exit(2);
}
const shutdown = () => {
  try {
    stopAutonomyRuntimeManager({ logger: console });
  } catch {}
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
setInterval(() => {}, 60000);
`;

function resolvePath(filePath) {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }
  return path.join(repoRoot, filePath);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnProcess(command, args, name) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: ENV,
    stdio: "inherit",
  });
  child.on("exit", (code, signal) => {
    if (code !== 0 && signal == null) {
      console.error(`[${name}] exited with code ${code}`);
    }
  });
  return child;
}

function ensureRunning(child, name) {
  if (!child) {
    throw new Error(`${name}_process_missing`);
  }
  if (child.exitCode != null) {
    throw new Error(`${name}_exited_early code=${child.exitCode}`);
  }
}

function runCommand(command, args, name) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, name);
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`[${name}] failed (code=${code ?? "null"} signal=${signal ?? "none"})`));
    });
  });
}

async function terminateProcess(child, name, timeoutMs = 8_000) {
  if (!child || child.exitCode != null || child.killed) {
    return;
  }

  child.kill("SIGTERM");

  const exited = await new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve(true);
    });
  });

  if (!exited && child.exitCode == null) {
    console.warn(`[${name}] did not exit after SIGTERM, forcing SIGKILL`);
    child.kill("SIGKILL");
  }
}

async function waitForHttpReadiness({ timeoutMs = 60_000, intervalMs = 1_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "unknown";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        return;
      }
      lastError = `http_status_${response.status}`;
    } catch (error) {
      lastError = error?.message || "fetch_failed";
    }
    await sleep(intervalMs);
  }

  throw new Error(`http_readiness_timeout: ${lastError}`);
}

async function waitForRuntimeManagerReadiness({ timeoutMs = 30_000, intervalMs = 1_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastReadiness = null;

  while (Date.now() < deadline) {
    lastReadiness = readAutonomyWorkerReadiness();
    if (lastReadiness?.ready === true) {
      return lastReadiness;
    }
    await sleep(intervalMs);
  }

  throw new Error(`runtime_manager_readiness_timeout: ${JSON.stringify(lastReadiness)}`);
}

function countWhere(rows, predicate) {
  let count = 0;
  for (const row of rows) {
    if (predicate(row)) {
      count += 1;
    }
  }
  return count;
}

async function readJsonl(filePath) {
  const raw = await readFile(resolvePath(filePath), "utf8");
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`jsonl_parse_failed file=${filePath} line=${index + 1} reason=${error?.message || "invalid_json"}`);
    }
  });
}

async function printSummary() {
  const requestRows = await readJsonl(requestsJsonl);
  const checkRows = await readJsonl(checkJsonl);

  const total = requestRows.length;
  const queueHits = countWhere(requestRows, (row) => row?.queue_authoritative_hit === true);
  const fallback = countWhere(requestRows, (row) => row?.fallback_suspected === true);
  const completed = countWhere(checkRows, (row) => row?.final_status === "completed");
  const failed = checkRows.length - completed;

  console.log("");
  console.log("=== Autonomy Canary Summary (runner) ===");
  console.log(`total=${total} queue_hits=${queueHits} completed=${completed} failed=${failed} fallback=${fallback}`);
  console.log(JSON.stringify({
    total,
    queue_hits: queueHits,
    completed,
    failed,
    fallback,
    session_id: sessionId,
    requests_jsonl: requestsJsonl,
    check_jsonl: checkJsonl,
  }));
}

async function main() {
  let server = null;
  let manager = null;

  const shutdown = async () => {
    await terminateProcess(manager, "runtime-manager");
    await terminateProcess(server, "http-server");
  };

  process.on("SIGINT", () => {
    shutdown().finally(() => process.exit(130));
  });
  process.on("SIGTERM", () => {
    shutdown().finally(() => process.exit(143));
  });

  try {
    console.log("=== Starting HTTP-only server ===");
    server = spawnProcess(process.execPath, ["src/http-only.mjs"], "http-server");

    console.log("=== Waiting for HTTP readiness ===");
    await waitForHttpReadiness();
    ensureRunning(server, "http_server");

    console.log("=== Starting runtime manager (with heartbeat) ===");
    manager = spawnProcess(process.execPath, ["--input-type=module", "-e", managerEntrypoint], "runtime-manager");

    console.log("=== Waiting for runtime manager readiness ===");
    await waitForRuntimeManagerReadiness();
    ensureRunning(manager, "runtime_manager");

    console.log("=== Running canary request phase ===");
    ensureRunning(server, "http_server");
    ensureRunning(manager, "runtime_manager");
    await runCommand("bash", ["scripts/run-canary.sh"], "canary-run");

    console.log("=== Running canary verification phase ===");
    await runCommand("bash", ["scripts/check-canary.sh"], "canary-check");

    await printSummary();
  } finally {
    console.log("=== Cleaning up ===");
    await terminateProcess(manager, "runtime-manager");
    await terminateProcess(server, "http-server");
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});
