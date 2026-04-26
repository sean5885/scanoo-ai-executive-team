#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { cleanText } from "../src/message-intent-utils.mjs";

const GATE_VERSION = "memory_influence_gate_v1";
const DEFAULT_CASE_COUNT = 4;
const DEFAULT_MEMORY_HIT_RATE_MIN = 0.8;
const DEFAULT_ACTION_CHANGED_RATE_MIN = 0.5;
const SILENT_LOGGER = Object.freeze({
  info() {},
  warn() {},
  error() {},
  debug() {},
  log() {},
  child() {
    return this;
  },
});

function toNumber(value, fallback) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function ratio(numerator = 0, denominator = 0) {
  const safeNumerator = Number.isFinite(Number(numerator)) ? Number(numerator) : 0;
  const safeDenominator = Number.isFinite(Number(denominator)) ? Number(denominator) : 0;
  if (safeDenominator <= 0) {
    return null;
  }
  return safeNumerator / safeDenominator;
}

function getArgValue(flag = "") {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return null;
  }
  return process.argv[index + 1] || null;
}

function parseArgs() {
  return {
    wantsJson: process.argv.includes("--json"),
    strict: process.argv.includes("--strict"),
    caseCount: Math.max(1, Math.floor(toNumber(getArgValue("--cases"), DEFAULT_CASE_COUNT))),
    memoryHitRateMin: toNumber(getArgValue("--memory-hit-rate-min"), DEFAULT_MEMORY_HIT_RATE_MIN),
    actionChangedRateMin: toNumber(getArgValue("--action-changed-rate-min"), DEFAULT_ACTION_CHANGED_RATE_MIN),
  };
}

function ensureRequiredRuntimeEnv() {
  process.env.LARK_APP_ID = cleanText(process.env.LARK_APP_ID) || "memory-influence-gate-app-id";
  process.env.LARK_APP_SECRET = cleanText(process.env.LARK_APP_SECRET) || "memory-influence-gate-app-secret";
  process.env.LARK_DOMAIN = cleanText(process.env.LARK_DOMAIN) || "lark";
}

function attachIsolatedStorePaths(tempDir = "") {
  process.env.EXECUTIVE_SESSION_MEMORY_STORE = path.join(tempDir, "executive-session-memory.json");
  process.env.EXECUTIVE_APPROVED_MEMORY_STORE = path.join(tempDir, "executive-approved-memory.json");
  process.env.EXECUTIVE_PENDING_PROPOSAL_STORE = path.join(tempDir, "executive-pending-proposals.json");
  process.env.PLANNER_CONVERSATION_MEMORY_PATH = path.join(tempDir, "planner-conversation-memory.json");
}

function buildCaseText(index = 0) {
  const texts = [
    "延續上一題，這個 checklist 還缺什麼？",
    "這個方案接著怎麼做？",
    "上次那份規劃，這輪要補什麼？",
    "繼續同一題，接下來先做哪一步？",
  ];
  return texts[index % texts.length];
}

function hasRetrievedMemory(args = null) {
  const sessionMemory = Array.isArray(args?.decisionMemory?.decision_context?.session_memory)
    ? args.decisionMemory.decision_context.session_memory
    : [];
  const approvedMemory = Array.isArray(args?.decisionMemory?.decision_context?.approved_memory)
    ? args.decisionMemory.decision_context.approved_memory
    : [];
  return sessionMemory.length + approvedMemory.length > 0;
}

async function runOneEdgeCase({
  runPlannerUserInputEdge,
  readPlannerUserInputEdgeMetadata,
  text = "",
  accountId = "",
  sessionKey = "",
} = {}) {
  const result = await runPlannerUserInputEdge({
    text,
    sessionKey,
    logger: SILENT_LOGGER,
    authContext: {
      account_id: accountId,
    },
    async plannerExecutor(args) {
      if (hasRetrievedMemory(args)) {
        return {
          ok: true,
          action: "search_company_brain_docs",
          execution_result: {
            ok: true,
            data: {
              answer: "命中 memory，採用 memory-guided 路由。",
              sources: ["memory-hit"],
              limitations: [],
            },
          },
        };
      }
      return {
        ok: true,
        action: "get_runtime_info",
        execution_result: {
          ok: true,
          data: {
            answer: "沒有 memory，退回 runtime 路由。",
            sources: ["memory-miss"],
            limitations: [],
          },
        },
      };
    },
    workingMemoryWriter: null,
  });
  return {
    action: cleanText(result?.plannerResult?.action || "") || null,
    answer: cleanText(result?.userResponse?.answer || "") || null,
    metadata: readPlannerUserInputEdgeMetadata(result) || null,
  };
}

async function buildMemoryInfluenceReport({
  caseCount = DEFAULT_CASE_COUNT,
  memoryHitRateMin = DEFAULT_MEMORY_HIT_RATE_MIN,
  actionChangedRateMin = DEFAULT_ACTION_CHANGED_RATE_MIN,
} = {}) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "memory-influence-gate-"));
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true);
  try {
    ensureRequiredRuntimeEnv();
    attachIsolatedStorePaths(tempDir);

    const [
      { runPlannerUserInputEdge, readPlannerUserInputEdgeMetadata },
      { appendSessionMemory, appendApprovedMemory },
    ] = await Promise.all([
      import("../src/planner-user-input-edge.mjs"),
      import("../src/executive-memory.mjs"),
    ]);

    const actionLevelEvidence = [];
    const errors = [];

    let memoryEligibleCount = 0;
    let memoryHitCount = 0;
    let actionChangedCount = 0;

    for (let index = 0; index < caseCount; index += 1) {
      const text = buildCaseText(index);
      const accountId = `acct-memory-gate-hit-${Date.now()}-${index}`;
      const accountIdMiss = `acct-memory-gate-miss-${Date.now()}-${index}`;
      const sessionWithMemory = `session-memory-gate-hit-${Date.now()}-${index}`;
      const sessionWithoutMemory = `session-memory-gate-miss-${Date.now()}-${index}`;

      try {
        await appendSessionMemory({
          account_id: accountId,
          session_key: sessionWithMemory,
          task_id: `task-memory-gate-${index}`,
          type: "working_memory",
          title: "onboarding checklist",
          content: "先補 owner，再補 deadline。",
          tags: ["onboarding", "checklist"],
        });
        await appendApprovedMemory({
          account_id: accountId,
          session_key: sessionWithMemory,
          task_id: `task-memory-gate-${index}`,
          type: "approved_memory",
          title: "approved onboarding rule",
          content: "缺 owner 不可宣稱完成。",
          tags: ["approved", "owner"],
        });

        const [hitRun, missRun] = await Promise.all([
          runOneEdgeCase({
            runPlannerUserInputEdge,
            readPlannerUserInputEdgeMetadata,
            text,
            accountId,
            sessionKey: sessionWithMemory,
          }),
          runOneEdgeCase({
            runPlannerUserInputEdge,
            readPlannerUserInputEdgeMetadata,
            text,
            accountId: accountIdMiss,
            sessionKey: sessionWithoutMemory,
          }),
        ]);

        const needsContext = hitRun?.metadata?.memory_retrieval_needs_context === true;
        const memoryHit = hitRun?.metadata?.memory_retrieval_hit === true;
        const actionChanged = memoryHit && hitRun?.action && missRun?.action && hitRun.action !== missRun.action;

        if (needsContext) {
          memoryEligibleCount += 1;
          if (memoryHit) {
            memoryHitCount += 1;
          }
        }
        if (actionChanged) {
          actionChangedCount += 1;
        }

        actionLevelEvidence.push({
          case_id: `memory_influence_case_${index + 1}`,
          request_text: text,
          memory_retrieval_needs_context: needsContext,
          memory_retrieval_hit: memoryHit,
          action_with_memory: hitRun?.action || null,
          action_without_memory: missRun?.action || null,
          action_changed_by_memory: actionChanged,
          answer_with_memory: hitRun?.answer || null,
          answer_without_memory: missRun?.answer || null,
        });
      } catch (error) {
        errors.push({
          case_id: `memory_influence_case_${index + 1}`,
          error: cleanText(error?.message || "") || "memory_influence_case_failed",
        });
      }
    }

    const memoryHitRate = ratio(memoryHitCount, memoryEligibleCount);
    const actionChangedByMemoryRate = ratio(actionChangedCount, memoryHitCount);

    const memoryHitRateOk = memoryHitRate !== null && memoryHitRate >= memoryHitRateMin;
    const actionChangedRateOk = actionChangedByMemoryRate !== null
      && actionChangedByMemoryRate >= actionChangedRateMin;
    const pass = memoryHitRateOk && actionChangedRateOk && errors.length === 0;

    return {
      gate_version: GATE_VERSION,
      generated_at: new Date().toISOString(),
      ok: pass,
      gate: pass ? "pass" : "fail",
      thresholds: {
        memory_hit_rate_min: memoryHitRateMin,
        action_changed_by_memory_rate_min: actionChangedRateMin,
      },
      metrics: {
        memory_hit_rate: memoryHitRate,
        action_changed_by_memory_rate: actionChangedByMemoryRate,
      },
      counts: {
        total_cases: caseCount,
        memory_eligible_cases: memoryEligibleCount,
        memory_hit_cases: memoryHitCount,
        action_changed_cases: actionChangedCount,
        failed_cases: errors.length,
      },
      checks: {
        memory_hit_rate: {
          ok: memoryHitRateOk,
          actual: memoryHitRate,
          threshold: memoryHitRateMin,
          denominator: memoryEligibleCount,
        },
        action_changed_by_memory_rate: {
          ok: actionChangedRateOk,
          actual: actionChangedByMemoryRate,
          threshold: actionChangedRateMin,
          denominator: memoryHitCount,
        },
      },
      action_level_evidence: actionLevelEvidence,
      errors,
    };
  } finally {
    process.stdout.write = originalStdoutWrite;
    await rm(tempDir, { recursive: true, force: true });
  }
}

function renderTextReport(report = {}) {
  const lines = [
    `memory influence gate: ${report?.gate || "fail"}`,
    `memory_hit_rate=${report?.metrics?.memory_hit_rate ?? "null"} (min=${report?.thresholds?.memory_hit_rate_min ?? DEFAULT_MEMORY_HIT_RATE_MIN})`,
    `action_changed_by_memory_rate=${report?.metrics?.action_changed_by_memory_rate ?? "null"} (min=${report?.thresholds?.action_changed_by_memory_rate_min ?? DEFAULT_ACTION_CHANGED_RATE_MIN})`,
    `evidence_cases=${report?.action_level_evidence?.length || 0}`,
  ];
  return lines.join("\n");
}

async function main() {
  const args = parseArgs();
  const report = await buildMemoryInfluenceReport({
    caseCount: args.caseCount,
    memoryHitRateMin: args.memoryHitRateMin,
    actionChangedRateMin: args.actionChangedRateMin,
  });
  if (args.wantsJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderTextReport(report));
  }
  if (args.strict && report.ok !== true) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const result = {
    gate_version: GATE_VERSION,
    ok: false,
    gate: "fail",
    error: cleanText(error?.message || "") || "memory_influence_gate_runtime_error",
  };
  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
});
