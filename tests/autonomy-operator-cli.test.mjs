import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const SCRIPT_PATH = path.resolve(process.cwd(), "scripts/autonomy-operator-cli.mjs");
const testDb = await createTestDbHarness();
const { db, dbPath } = testDb;
const {
  claimNextAutonomyJob,
  enqueueAutonomyJobRecord,
  ensureAutonomyJobTables,
  failAutonomyAttempt,
  getAutonomyJobById,
  getAutonomyOpenIncidentByJobId,
} = await import("../src/task-runtime/autonomy-job-store.mjs");

test.after(() => {
  testDb.close();
});

test.beforeEach(() => {
  ensureAutonomyJobTables();
  db.exec(`
    DELETE FROM autonomy_job_attempts;
    DELETE FROM autonomy_jobs;
  `);
});

function runOperatorCli(args = [], { expectNonZero = false } = {}) {
  testDb.closeRuntimeDb();
  const result = spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      RAG_SQLITE_PATH: dbPath,
    },
  });
  if (result.error) {
    throw result.error;
  }
  const stdout = String(result.stdout || "").trim();
  const parsed = stdout ? JSON.parse(stdout) : null;
  if (!expectNonZero) {
    assert.equal(
      result.status,
      0,
      `operator cli should exit 0, stderr=${String(result.stderr || "").trim()}`,
    );
  }
  return {
    result,
    parsed,
  };
}

function createFailedSinkIncident({
  jobType = "unit_test_operator_cli_job",
  traceId = "trace_operator_cli",
  sinkState = "waiting_user",
  failureClass = "business_error",
  routingHint = "answer_waiting_user",
} = {}) {
  const queued = enqueueAutonomyJobRecord({
    jobType,
    traceId,
    maxAttempts: 1,
  });
  const claim = claimNextAutonomyJob({
    workerId: `worker-${traceId}`,
    leaseMs: 30_000,
  });
  const failed = failAutonomyAttempt({
    jobId: claim?.job?.id,
    attemptId: claim?.attempt?.id,
    workerId: `worker-${traceId}`,
    retryable: false,
    error: {
      reason: "forced_failure",
      lifecycle_sink: {
        state: sinkState,
        failure_class: failureClass,
        routing_hint: routingHint,
        at: "2026-04-20T00:00:00.000Z",
      },
    },
  });
  return {
    queued,
    claim,
    failed,
  };
}

test("operator CLI list-open shows bounded open incidents", () => {
  const waitingIncident = createFailedSinkIncident({
    jobType: "unit_test_operator_cli_waiting",
    traceId: "trace_operator_cli_waiting",
    sinkState: "waiting_user",
  });
  const escalatedIncident = createFailedSinkIncident({
    jobType: "unit_test_operator_cli_escalated",
    traceId: "trace_operator_cli_escalated",
    sinkState: "escalated",
    failureClass: "permission_denied",
    routingHint: "need_human_approval",
  });
  createFailedSinkIncident({
    jobType: "unit_test_operator_cli_non_sink",
    traceId: "trace_operator_cli_non_sink",
    sinkState: "blocked",
    failureClass: "runtime_exception",
    routingHint: "no_open_incident",
  });

  const { parsed } = runOperatorCli(["list-open", "--limit", "10"]);
  assert.equal(parsed?.ok, true);
  assert.equal(parsed?.command, "list-open");
  assert.equal(parsed?.total, 2);
  assert.equal(Array.isArray(parsed?.incidents), true);
  assert.equal(parsed.incidents.some((item) => item.job_id === waitingIncident.queued.id), true);
  assert.equal(parsed.incidents.some((item) => item.job_id === escalatedIncident.queued.id), true);
});

test("operator CLI disposition rejects missing required fields before write", () => {
  const waitingIncident = createFailedSinkIncident({
    jobType: "unit_test_operator_cli_missing_required",
    traceId: "trace_operator_cli_missing_required",
    sinkState: "waiting_user",
  });
  const openIncident = getAutonomyOpenIncidentByJobId(waitingIncident.queued.id);
  assert.equal(Boolean(openIncident?.updated_at), true);

  const { result, parsed } = runOperatorCli([
    "disposition",
    "--job-id",
    waitingIncident.queued.id,
    "--action",
    "ack_waiting_user",
    "--reason",
    "operator_ack",
    "--request-id",
    "req-missing-operator-id",
    "--expected-updated-at",
    openIncident.updated_at,
  ], { expectNonZero: true });

  assert.equal(result.status, 1);
  assert.equal(parsed?.ok, false);
  assert.equal(parsed?.error, "invalid_operator_disposition_input");
  assert.equal(Array.isArray(parsed?.missing_fields), true);
  assert.equal(parsed.missing_fields.includes("operator_id"), true);

  const afterIncident = getAutonomyOpenIncidentByJobId(waitingIncident.queued.id);
  assert.equal(afterIncident?.job_id, waitingIncident.queued.id);
  const afterJob = getAutonomyJobById(waitingIncident.queued.id);
  assert.equal(afterJob?.status, "failed");
  assert.equal(afterJob?.error?.operator_disposition, undefined);
});

test("operator CLI disposition preserves fail-soft precondition_failed semantics", () => {
  const waitingIncident = createFailedSinkIncident({
    jobType: "unit_test_operator_cli_precondition_failed",
    traceId: "trace_operator_cli_precondition_failed",
    sinkState: "waiting_user",
  });
  const openIncident = getAutonomyOpenIncidentByJobId(waitingIncident.queued.id);
  assert.equal(Boolean(openIncident?.updated_at), true);

  const forcedUpdatedAt = "2026-04-20T03:00:00.000Z";
  db.prepare(`
    UPDATE autonomy_jobs
    SET updated_at = @updated_at
    WHERE id = @job_id
  `).run({
    updated_at: forcedUpdatedAt,
    job_id: waitingIncident.queued.id,
  });

  const { result, parsed } = runOperatorCli([
    "disposition",
    "--job-id",
    waitingIncident.queued.id,
    "--action",
    "ack_waiting_user",
    "--reason",
    "operator_ack_stale",
    "--operator-id",
    "operator-stale-001",
    "--request-id",
    "req-stale-001",
    "--expected-updated-at",
    openIncident.updated_at,
  ], { expectNonZero: true });

  assert.equal(result.status, 1);
  assert.equal(parsed?.ok, false);
  assert.equal(parsed?.error, "precondition_failed");
  assert.equal(parsed?.stale, true);
  assert.equal(parsed?.expected_updated_at, openIncident.updated_at);
  assert.equal(parsed?.current_updated_at, forcedUpdatedAt);
});

test("operator CLI disposition supports resume_same_job with required audit fields", () => {
  const escalatedIncident = createFailedSinkIncident({
    jobType: "unit_test_operator_cli_resume",
    traceId: "trace_operator_cli_resume",
    sinkState: "escalated",
    failureClass: "permission_denied",
    routingHint: "need_operator_resume",
  });
  const openIncident = getAutonomyOpenIncidentByJobId(escalatedIncident.queued.id);
  assert.equal(Boolean(openIncident?.updated_at), true);

  const { parsed } = runOperatorCli([
    "disposition",
    "--job-id",
    escalatedIncident.queued.id,
    "--action",
    "resume_same_job",
    "--reason",
    "operator_resume_after_fix",
    "--operator-id",
    "operator-resume-001",
    "--request-id",
    "req-resume-001",
    "--expected-updated-at",
    openIncident.updated_at,
  ]);

  assert.equal(parsed?.ok, true);
  assert.equal(parsed?.rescheduled, true);
  assert.equal(parsed?.job?.status, "queued");
  assert.equal(parsed?.disposition?.action, "resume_same_job");
  assert.equal(parsed?.disposition?.operator_id, "operator-resume-001");
  assert.equal(parsed?.disposition?.request_id, "req-resume-001");
  assert.equal(parsed?.disposition?.expected_updated_at, openIncident.updated_at);
  assert.equal(getAutonomyOpenIncidentByJobId(escalatedIncident.queued.id), null);
});
