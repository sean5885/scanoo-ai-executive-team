import test from "node:test";
import assert from "node:assert/strict";

import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();
const { db } = testDb;
const {
  claimNextAutonomyJob,
  completeAutonomyAttempt,
  enqueueAutonomyJobRecord,
  ensureAutonomyJobTables,
  failAutonomyAttempt,
  heartbeatAutonomyAttempt,
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

test("autonomy job store supports table setup and success lifecycle", () => {
  ensureAutonomyJobTables();

  const tables = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name IN ('autonomy_jobs', 'autonomy_job_attempts')
    ORDER BY name
  `).all().map((row) => row.name);
  assert.deepEqual(tables, ["autonomy_job_attempts", "autonomy_jobs"]);

  const queued = enqueueAutonomyJobRecord({
    jobType: "unit_test_job",
    payload: {
      source: "store_test",
    },
    traceId: "trace_store_success",
    maxAttempts: 2,
  });
  assert.equal(queued?.status, "queued");
  assert.equal(queued?.attempt_count, 0);

  const claimed = claimNextAutonomyJob({
    workerId: "worker-store-success",
    leaseMs: 30_000,
  });
  assert.equal(claimed?.skipped, false);
  assert.equal(claimed?.job?.id, queued.id);
  assert.equal(claimed?.job?.status, "running");
  assert.equal(claimed?.attempt?.status, "running");

  const heartbeat = heartbeatAutonomyAttempt({
    jobId: claimed.job.id,
    attemptId: claimed.attempt.id,
    workerId: "worker-store-success",
    leaseMs: 30_000,
  });
  assert.equal(heartbeat?.ok, true);
  assert.equal(heartbeat?.job?.id, queued.id);
  assert.equal(heartbeat?.attempt?.id, claimed.attempt.id);

  const completed = completeAutonomyAttempt({
    jobId: claimed.job.id,
    attemptId: claimed.attempt.id,
    workerId: "worker-store-success",
    result: {
      ok: true,
      output: "done",
    },
  });
  assert.equal(completed?.ok, true);
  assert.equal(completed?.job?.status, "completed");
  assert.equal(completed?.attempt?.status, "completed");
  assert.equal(completed?.job?.result?.output, "done");
});

test("autonomy job store supports fail path", () => {
  const queued = enqueueAutonomyJobRecord({
    jobType: "unit_test_fail_job",
    traceId: "trace_store_fail",
    maxAttempts: 1,
  });
  const claimed = claimNextAutonomyJob({
    workerId: "worker-store-fail",
    leaseMs: 30_000,
  });
  assert.equal(claimed?.job?.id, queued.id);

  const failed = failAutonomyAttempt({
    jobId: claimed.job.id,
    attemptId: claimed.attempt.id,
    workerId: "worker-store-fail",
    retryable: false,
    error: {
      reason: "forced_failure",
    },
  });
  assert.equal(failed?.ok, true);
  assert.equal(failed?.retry_scheduled, false);
  assert.equal(failed?.job?.status, "failed");
  assert.equal(failed?.attempt?.status, "failed");
  assert.equal(failed?.job?.error?.reason, "forced_failure");
});

test("autonomy job store reclaims expired lease for the same job", () => {
  const queued = enqueueAutonomyJobRecord({
    jobType: "unit_test_reclaim_job",
    traceId: "trace_store_reclaim",
    maxAttempts: 3,
  });

  const firstClaim = claimNextAutonomyJob({
    workerId: "worker-first",
    leaseMs: 60_000,
  });
  assert.equal(firstClaim?.job?.id, queued.id);
  assert.equal(firstClaim?.job?.status, "running");
  assert.equal(firstClaim?.job?.attempt_count, 1);

  db.prepare(`
    UPDATE autonomy_jobs
    SET lease_expires_at = ?
    WHERE id = ?
  `).run("1970-01-01T00:00:00.000Z", queued.id);

  const reclaimed = claimNextAutonomyJob({
    workerId: "worker-second",
    leaseMs: 60_000,
  });
  assert.equal(reclaimed?.job?.id, queued.id);
  assert.equal(reclaimed?.attempt?.worker_id, "worker-second");
  assert.equal(reclaimed?.job?.lease_owner, "worker-second");
  assert.equal(reclaimed?.job?.attempt_count, 2);
});
