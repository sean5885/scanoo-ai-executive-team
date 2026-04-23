#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createServer } from "node:http";
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
const requestedPort = process.env.AUTONOMY_CANARY_PORT || process.env.CANARY_PORT || "";

const AUTONOMY_CANARY_MODE_ENV = "AUTONOMY_CANARY_MODE";
const AUTONOMY_INGRESS_ENABLE_ENV = "PLANNER_AUTONOMY_INGRESS_ENABLED";
const AUTONOMY_INGRESS_ALLOWLIST_ENV = "PLANNER_AUTONOMY_INGRESS_ALLOWLIST";
const AUTONOMY_QUEUE_AUTHORITATIVE_ENABLE_ENV = "PLANNER_AUTONOMY_QUEUE_AUTHORITATIVE_ENABLED";
const AUTONOMY_QUEUE_AUTHORITATIVE_SAMPLING_PERCENT_ENV = "PLANNER_AUTONOMY_QUEUE_AUTHORITATIVE_SAMPLING_PERCENT";
const AUTONOMY_INGRESS_ALLOWLIST_SESSION_PREFIX = "session:";

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

function parsePort(rawPort = "") {
  const normalized = String(rawPort || "").trim();
  if (!normalized) {
    return null;
  }
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`invalid_port: ${normalized}`);
  }
  return parsed;
}

async function findFreePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address
        ? Number(address.port)
        : null;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          reject(new Error("failed_to_allocate_canary_port"));
          return;
        }
        resolve(port);
      });
    });
    server.on("error", reject);
  });
}

async function resolveCanaryPort() {
  const parsed = parsePort(requestedPort);
  if (parsed != null) {
    return parsed;
  }
  return await findFreePort();
}

function normalizeBooleanEnv(rawValue, fallbackValue = true) {
  const normalized = String(rawValue || "").trim().toLowerCase();
  if (!normalized) {
    return fallbackValue ? "true" : "false";
  }
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return "true";
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return "false";
  }
  return fallbackValue ? "true" : "false";
}

function buildAutonomyIngressAllowlist({
  rawAllowlist = "",
  session = "",
} = {}) {
  const normalizedSession = String(session || "").trim();
  const sessionAllowlistEntry = `${AUTONOMY_INGRESS_ALLOWLIST_SESSION_PREFIX}${normalizedSession}`;
  const entries = String(rawAllowlist || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!normalizedSession) {
    return entries.join(",");
  }
  const hasSessionMatch = entries.some((entry) => {
    const separator = entry.indexOf(":");
    if (separator < 0) {
      return entry === normalizedSession;
    }
    const subject = entry.slice(0, separator).trim().toLowerCase();
    const value = entry.slice(separator + 1).trim();
    return subject === "session" && value === normalizedSession;
  });
  if (!hasSessionMatch) {
    entries.unshift(sessionAllowlistEntry);
  }
  return entries.join(",");
}

function resolveRunnerEnv({
  baseUrl = "",
  port = null,
} = {}) {
  if (!baseUrl) {
    throw new Error("missing_base_url");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid_runner_port: ${port}`);
  }

  const ingressAllowlist = buildAutonomyIngressAllowlist({
    rawAllowlist: process.env[AUTONOMY_INGRESS_ALLOWLIST_ENV],
    session: sessionId,
  });

  return {
    ...process.env,
    AUTONOMY_ENABLED: "true",
    AUTONOMY_MAX_QUEUED_AGE_MS: process.env.AUTONOMY_MAX_QUEUED_AGE_MS || "1800000",
    AUTONOMY_EXECUTE_TIMEOUT_MS: process.env.AUTONOMY_EXECUTE_TIMEOUT_MS || "180000",
    [AUTONOMY_CANARY_MODE_ENV]: normalizeBooleanEnv(process.env[AUTONOMY_CANARY_MODE_ENV], true),
    [AUTONOMY_INGRESS_ENABLE_ENV]: "true",
    [AUTONOMY_QUEUE_AUTHORITATIVE_ENABLE_ENV]: "true",
    [AUTONOMY_QUEUE_AUTHORITATIVE_SAMPLING_PERCENT_ENV]:
      process.env[AUTONOMY_QUEUE_AUTHORITATIVE_SAMPLING_PERCENT_ENV] || "100",
    [AUTONOMY_INGRESS_ALLOWLIST_ENV]: ingressAllowlist || `${AUTONOMY_INGRESS_ALLOWLIST_SESSION_PREFIX}${sessionId}`,
    SESSION_ID: sessionId,
    OUT_DIR: outDir,
    REQUESTS_JSONL: requestsJsonl,
    CHECK_JSONL: checkJsonl,
    LARK_OAUTH_PORT: String(port),
    LARK_OAUTH_BASE_URL: baseUrl,
    BASE_URL: baseUrl,
  };
}

function resolvePath(filePath) {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }
  return path.join(repoRoot, filePath);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatExit({ name = "", code = null, signal = null } = {}) {
  return `${name}_exited_early code=${code ?? "null"} signal=${signal ?? "none"}`;
}

function buildEarlyExitError({
  name = "",
  code = null,
  signal = null,
  phase = "",
} = {}) {
  const suffix = phase ? ` phase=${phase}` : "";
  return new Error(`${formatExit({ name, code, signal })}${suffix}`);
}

function spawnProcess(command, args, name, env) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });
  child.on("exit", (code, signal) => {
    if (code !== 0 && signal == null) {
      console.error(`[${name}] exited with code ${code}`);
    }
  });
  return child;
}

function ensureRunning(child, name, phase = "") {
  if (!child) {
    const suffix = phase ? ` phase=${phase}` : "";
    throw new Error(`${name}_process_missing${suffix}`);
  }
  if (child.exitCode != null || child.signalCode != null) {
    throw buildEarlyExitError({
      name,
      code: child.exitCode,
      signal: child.signalCode,
      phase,
    });
  }
}

function ensureProcessesRunning(processes = [], phase = "") {
  for (const entry of processes) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    ensureRunning(entry.child, entry.name || "child_process", phase);
  }
}

function runCommand(command, args, name, {
  env,
  guardProcesses = [],
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, name, env);
    let settled = false;
    const guardListeners = [];

    const finalize = (error = null) => {
      if (settled) {
        return;
      }
      settled = true;
      for (const listenerRef of guardListeners) {
        try {
          listenerRef.child.off("exit", listenerRef.listener);
        } catch {}
      }
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };

    try {
      ensureProcessesRunning(guardProcesses, `${name}_start`);
    } catch (error) {
      terminateProcess(child, name).finally(() => {
        finalize(error);
      });
      return;
    }

    for (const guard of guardProcesses) {
      const guardName = guard?.name || "child_process";
      const guardChild = guard?.child;
      if (!guardChild) {
        continue;
      }
      const listener = (code, signal) => {
        const reason = buildEarlyExitError({
          name: guardName,
          code,
          signal,
          phase: `${name}_running`,
        });
        terminateProcess(child, name).finally(() => {
          finalize(reason);
        });
      };
      guardChild.once("exit", listener);
      guardListeners.push({
        child: guardChild,
        listener,
      });
    }

    try {
      ensureProcessesRunning(guardProcesses, `${name}_post_guard_attach`);
    } catch (error) {
      terminateProcess(child, name).finally(() => {
        finalize(error);
      });
      return;
    }

    child.on("error", (error) => {
      finalize(new Error(`[${name}] spawn_error: ${error?.message || "unknown_error"}`));
    });
    child.on("exit", (code, signal) => {
      if (code === 0) {
        finalize(null);
        return;
      }
      finalize(new Error(`[${name}] failed (code=${code ?? "null"} signal=${signal ?? "none"})`));
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

async function waitForHttpReadiness({
  baseUrl = "",
  timeoutMs = 60_000,
  intervalMs = 1_000,
  monitoredProcesses = [],
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "unknown";

  while (Date.now() < deadline) {
    ensureProcessesRunning(monitoredProcesses, "http_readiness_wait");
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

async function waitForRuntimeManagerReadiness({
  timeoutMs = 30_000,
  intervalMs = 1_000,
  monitoredProcesses = [],
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastReadiness = null;

  while (Date.now() < deadline) {
    ensureProcessesRunning(monitoredProcesses, "runtime_manager_readiness_wait");
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

async function summarizeRequests() {
  const requestRows = await readJsonl(requestsJsonl);
  return {
    total: requestRows.length,
    queue_hits: countWhere(requestRows, (row) => row?.queue_authoritative_hit === true),
    fallback: countWhere(requestRows, (row) => row?.fallback_suspected === true),
  };
}

async function printSummary(requestSummary) {
  const checkRows = await readJsonl(checkJsonl);

  const completed = countWhere(checkRows, (row) => row?.final_status === "completed");
  const failed = checkRows.length - completed;

  console.log("");
  console.log("=== Autonomy Canary Summary (runner) ===");
  console.log(
    `total=${requestSummary.total} queue_hits=${requestSummary.queue_hits} completed=${completed} failed=${failed} fallback=${requestSummary.fallback}`,
  );
  console.log(JSON.stringify({
    total: requestSummary.total,
    queue_hits: requestSummary.queue_hits,
    completed,
    failed,
    fallback: requestSummary.fallback,
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
    const canaryPort = await resolveCanaryPort();
    const baseUrl = `http://127.0.0.1:${canaryPort}`;
    const env = resolveRunnerEnv({
      baseUrl,
      port: canaryPort,
    });
    const guardProcesses = [];

    console.log("=== Canary runner config ===");
    console.log(`session_id=${sessionId}`);
    console.log(`base_url=${baseUrl}`);
    console.log(`port=${canaryPort}`);
    console.log(`requests_jsonl=${requestsJsonl}`);
    console.log(`check_jsonl=${checkJsonl}`);

    console.log("=== Starting HTTP-only server ===");
    server = spawnProcess(process.execPath, ["src/http-only.mjs"], "http-server", env);
    guardProcesses.push({ name: "http_server", child: server });

    console.log("=== Waiting for HTTP readiness ===");
    await waitForHttpReadiness({
      baseUrl,
      monitoredProcesses: guardProcesses,
    });

    console.log("=== Starting runtime manager (with heartbeat) ===");
    manager = spawnProcess(
      process.execPath,
      ["--input-type=module", "-e", managerEntrypoint],
      "runtime-manager",
      env,
    );
    guardProcesses.push({ name: "runtime_manager", child: manager });

    console.log("=== Waiting for runtime manager readiness ===");
    await waitForRuntimeManagerReadiness({
      monitoredProcesses: guardProcesses,
    });

    console.log("=== Running canary request phase ===");
    ensureProcessesRunning(guardProcesses, "before_canary_run");
    await runCommand("bash", ["scripts/run-canary.sh"], "canary-run", {
      env,
      guardProcesses,
    });

    const requestSummary = await summarizeRequests();
    if (requestSummary.queue_hits <= 0) {
      throw new Error(
        `queue_hits_zero total=${requestSummary.total} queue_hits=${requestSummary.queue_hits} requests_jsonl=${requestsJsonl} reason=autonomy_ingress_or_runtime_manager_not_effective`,
      );
    }

    console.log("=== Running canary verification phase ===");
    ensureProcessesRunning(guardProcesses, "before_canary_check");
    await runCommand("bash", ["scripts/check-canary.sh"], "canary-check", {
      env,
      guardProcesses,
    });

    await printSummary(requestSummary);
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
