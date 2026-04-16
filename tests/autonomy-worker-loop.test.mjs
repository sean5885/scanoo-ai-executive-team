import test from "node:test";
import assert from "node:assert/strict";

import { createTestDbHarness } from "./utils/test-db-factory.mjs";
import { EVIDENCE_TYPES } from "../src/executive-verifier.mjs";

const testDb = await createTestDbHarness();
const { db } = testDb;
const {
  ensureAutonomyJobTables,
  enqueueAutonomyJobRecord,
  getAutonomyJobById,
} = await import("../src/task-runtime/autonomy-job-store.mjs");
const { runAutonomyWorkerOnce } = await import("../src/worker/autonomy-worker-loop.mjs");

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

test("runAutonomyWorkerOnce completes claimed job on success path", async () => {
  const queued = enqueueAutonomyJobRecord({
    jobType: "worker_success_job",
    payload: {
      input: "ok",
    },
    traceId: "trace_worker_success",
    maxAttempts: 2,
  });

  const result = await runAutonomyWorkerOnce({
    workerId: "worker-success",
    enabled: true,
    heartbeatIntervalMs: 60_000,
    async executeJob({ job, attempt, traceContext }) {
      assert.equal(job.id, queued.id);
      assert.equal(attempt.job_id, queued.id);
      assert.equal(traceContext.job_id, queued.id);
      assert.equal(traceContext.attempt_id, attempt.id);
      return {
        ok: true,
        output: "done",
      };
    },
  });

  assert.equal(result?.ok, true);
  assert.equal(result?.claimed, true);
  assert.equal(result?.completed, true);
  assert.equal(result?.job_id, queued.id);
  assert.equal(typeof result?.trace_id, "string");

  const stored = getAutonomyJobById(queued.id);
  assert.equal(stored?.status, "completed");
  assert.equal(stored?.result?.output, "done");
  assert.equal(stored?.result?.verifier_gate_result?.pass, true);
  assert.equal(stored?.result?.verifier_gate_result?.task_type, "search");
});

test("runAutonomyWorkerOnce marks job failed when executeJob throws", async () => {
  const queued = enqueueAutonomyJobRecord({
    jobType: "worker_fail_job",
    traceId: "trace_worker_fail",
    maxAttempts: 1,
  });

  const result = await runAutonomyWorkerOnce({
    workerId: "worker-fail",
    enabled: true,
    heartbeatIntervalMs: 60_000,
    async executeJob() {
      throw new Error("worker_boom");
    },
  });

  assert.equal(result?.ok, false);
  assert.equal(result?.claimed, true);
  assert.equal(result?.failed, true);
  assert.equal(result?.job_id, queued.id);
  assert.equal(result?.retry_scheduled, false);
  assert.equal(result?.error?.message, "worker_boom");

  const stored = getAutonomyJobById(queued.id);
  assert.equal(stored?.status, "failed");
  assert.equal(stored?.error?.message, "worker_boom");
});

test("runAutonomyWorkerOnce fail-soft blocks completion when verifier gate fails", async () => {
  const queued = enqueueAutonomyJobRecord({
    jobType: "worker_verifier_blocked_job",
    traceId: "trace_worker_verifier_blocked",
    maxAttempts: 1,
  });

  const result = await runAutonomyWorkerOnce({
    workerId: "worker-verifier-blocked",
    enabled: true,
    heartbeatIntervalMs: 60_000,
    async executeJob() {
      return {
        ok: true,
        verifier_gate: {
          task_type: "cloud_doc",
          structured_result: {},
          evidence: [{
            type: EVIDENCE_TYPES.tool_output,
            summary: "cloud_doc_attempt_without_scope",
          }],
        },
      };
    },
  });

  assert.equal(result?.ok, false);
  assert.equal(result?.claimed, true);
  assert.equal(result?.failed, true);
  assert.equal(result?.job_id, queued.id);
  assert.equal(result?.error, "verifier_failed");
  assert.equal(typeof result?.reason, "string");

  const stored = getAutonomyJobById(queued.id);
  assert.equal(stored?.status, "failed");
  assert.equal(stored?.error?.error, "verifier_failed");
  assert.equal(typeof stored?.error?.reason, "string");
});
