import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  lobsterSecurityApprovalMode,
  lobsterSecurityApprovalStorePath,
  lobsterSecurityConfigDir,
  lobsterSecurityPendingStorePath,
  lobsterSecurityProjectRoot,
  lobsterSecurityPythonBin,
} from "./config.mjs";
import { getLobsterSecurityRuntimeContract } from "./runtime-contract.mjs";

const execFileAsync = promisify(execFile);
const CLI_BUFFER_BYTES = 8 * 1024 * 1024;

async function ensureParentDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function readJsonFile(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function writeJsonFile(filePath, payload) {
  await ensureParentDir(filePath);
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function toError(message, details) {
  const error = new Error(message);
  error.details = details;
  return error;
}

async function runSecurityCli(args) {
  const env = {
    ...process.env,
    LOBSTER_APPROVAL_MODE: lobsterSecurityApprovalMode,
    LOBSTER_APPROVAL_STORE: lobsterSecurityApprovalStorePath,
  };

  try {
    const { stdout } = await execFileAsync(
      lobsterSecurityPythonBin,
      ["-m", "lobster_security.cli", "--config-dir", lobsterSecurityConfigDir, ...args],
      {
        cwd: lobsterSecurityProjectRoot,
        env,
        maxBuffer: CLI_BUFFER_BYTES,
      },
    );
    const parsed = stdout.trim() ? JSON.parse(stdout) : {};
    if (!parsed.ok) {
      throw toError(parsed.message || parsed.error || "lobster_security failed", parsed);
    }
    return parsed.result;
  } catch (error) {
    if (typeof error?.stdout === "string" && error.stdout.trim()) {
      try {
        const parsed = JSON.parse(error.stdout);
        if (parsed?.error === "approval_required") {
          return { __approval_required__: true, ...parsed };
        }
        throw toError(parsed.message || parsed.error || "lobster_security failed", parsed);
      } catch (parseError) {
        if (parseError instanceof SyntaxError) {
          throw error;
        }
        throw parseError;
      }
    }
    throw error;
  }
}

function approvalStoreTemplate() {
  return {};
}

function pendingStoreTemplate() {
  return {};
}

async function loadPendingApprovals() {
  return readJsonFile(lobsterSecurityPendingStorePath, pendingStoreTemplate());
}

async function savePendingApprovals(payload) {
  await writeJsonFile(lobsterSecurityPendingStorePath, payload);
}

async function loadApprovalStore() {
  return readJsonFile(lobsterSecurityApprovalStorePath, approvalStoreTemplate());
}

async function saveApprovalStore(payload) {
  await writeJsonFile(lobsterSecurityApprovalStorePath, payload);
}

async function setApprovalDecision(requestId, status, actor = "unknown") {
  const decisions = await loadApprovalStore();
  decisions[requestId] = {
    status,
    actor,
    resolved_at: new Date().toISOString(),
  };
  await saveApprovalStore(decisions);
}

async function clearApprovalDecision(requestId) {
  const decisions = await loadApprovalStore();
  if (decisions[requestId]) {
    delete decisions[requestId];
    await saveApprovalStore(decisions);
  }
}

export async function getSecurityStatus() {
  const pending = await loadPendingApprovals();
  const runtimeContract = await getLobsterSecurityRuntimeContract();
  return {
    ok: true,
    enabled: true,
    config_dir: lobsterSecurityConfigDir,
    project_root: lobsterSecurityProjectRoot,
    python_bin: lobsterSecurityPythonBin,
    approval_mode: lobsterSecurityApprovalMode,
    pending_approvals: Object.keys(pending).length,
    runtime_contract: runtimeContract,
  };
}

export async function startSecureTask(name) {
  return runSecurityCli(["start-task", "--name", name]);
}

export async function executeSecureAction(taskId, action) {
  const result = await runSecurityCli([
    "run-action",
    "--task-id",
    taskId,
    "--action-json",
    JSON.stringify(action),
  ]);

  if (result?.__approval_required__) {
    const pending = await loadPendingApprovals();
    const approval = result.approval_request;
    pending[approval.request_id] = {
      request_id: approval.request_id,
      created_at: new Date().toISOString(),
      task_id: taskId,
      action,
      approval_request: approval,
    };
    await savePendingApprovals(pending);
    return {
      ok: false,
      status: "approval_required",
      approval_request: approval,
    };
  }

  return {
    ok: true,
    status: "completed",
    result,
  };
}

export async function finishSecureTask(taskId, success) {
  const args = ["finish-task", "--task-id", taskId];
  if (success) {
    args.push("--success");
  }
  return runSecurityCli(args);
}

export async function rollbackSecureTask(taskId, dryRun) {
  const args = ["rollback", "--task-id", taskId];
  if (dryRun) {
    args.push("--dry-run");
  }
  return runSecurityCli(args);
}

export async function listPendingApprovals() {
  const pending = await loadPendingApprovals();
  return Object.values(pending);
}

export async function resolvePendingApproval(requestId, approved, actor = "unknown") {
  const pending = await loadPendingApprovals();
  const record = pending[requestId];
  if (!record) {
    throw toError(`approval request not found: ${requestId}`, {
      error: "approval_not_found",
      request_id: requestId,
    });
  }

  if (!approved) {
    delete pending[requestId];
    await savePendingApprovals(pending);
    await clearApprovalDecision(requestId);
    return {
      ok: true,
      status: "rejected",
      request_id: requestId,
      approval_request: record.approval_request,
    };
  }

  await setApprovalDecision(requestId, "approved", actor);
  try {
    const execution = await runSecurityCli([
      "run-action",
      "--task-id",
      record.task_id,
      "--action-json",
      JSON.stringify(record.action),
    ]);
    delete pending[requestId];
    await savePendingApprovals(pending);
    return {
      ok: true,
      status: "approved",
      request_id: requestId,
      execution,
    };
  } finally {
    await clearApprovalDecision(requestId);
  }
}
