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
  assert.equal(typeof result?.recovery_decision?.reason, "string");

  const stored = getAutonomyJobById(queued.id);
  assert.equal(stored?.status, "failed");
  assert.equal(stored?.error?.error, "worker_boom");
  assert.equal(stored?.error?.runtime_error?.message, "worker_boom");
  assert.equal(typeof stored?.error?.recovery_decision?.reason, "string");
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
  assert.equal(typeof result?.recovery_decision?.reason, "string");

  const stored = getAutonomyJobById(queued.id);
  assert.equal(stored?.status, "failed");
  assert.equal(stored?.error?.error, "verifier_failed");
  assert.equal(typeof stored?.error?.reason, "string");
  assert.equal(typeof stored?.error?.recovery_decision?.reason, "string");
});

test("runAutonomyWorkerOnce requeues job when recovery decision says executing", async () => {
  const queued = enqueueAutonomyJobRecord({
    jobType: "worker_retry_via_recovery_decision_job",
    traceId: "trace_worker_retry_via_recovery_decision",
    maxAttempts: 2,
  });

  const result = await runAutonomyWorkerOnce({
    workerId: "worker-retry-via-decision",
    enabled: true,
    heartbeatIntervalMs: 60_000,
    async executeJob() {
      return {
        ok: false,
        error: "temporary_network_failure",
      };
    },
  });

  assert.equal(result?.ok, false);
  assert.equal(result?.claimed, true);
  assert.equal(result?.failed, true);
  assert.equal(result?.retry_scheduled, true);
  assert.equal(result?.recovery_decision?.next_state, "executing");
  assert.equal(result?.recovery_decision?.reason, "recovery_decision_v1_retrying");

  const stored = getAutonomyJobById(queued.id);
  assert.equal(stored?.status, "queued");
  assert.equal(stored?.error?.error, "temporary_network_failure");
  assert.equal(stored?.error?.recovery_decision?.next_state, "executing");
  assert.equal(stored?.error?.recovery_decision?.reason, "recovery_decision_v1_retrying");
});

test("runAutonomyWorkerOnce stops retry when recovery decision enters waiting_user", async () => {
  const queued = enqueueAutonomyJobRecord({
    jobType: "worker_waiting_user_via_recovery_decision_job",
    traceId: "trace_worker_waiting_user_via_recovery_decision",
    maxAttempts: 3,
  });

  const result = await runAutonomyWorkerOnce({
    workerId: "worker-waiting-user-via-decision",
    enabled: true,
    heartbeatIntervalMs: 60_000,
    async executeJob() {
      return {
        ok: false,
        error: "missing_slot_document_id",
      };
    },
  });

  assert.equal(result?.ok, false);
  assert.equal(result?.claimed, true);
  assert.equal(result?.failed, true);
  assert.equal(result?.retry_scheduled, false);
  assert.equal(result?.recovery_decision?.next_state, "blocked");
  assert.equal(result?.recovery_decision?.waiting_user, true);
  assert.equal(result?.recovery_decision?.routing_hint, "worker_waiting_user_via_recovery_decision_job_waiting_user");

  const stored = getAutonomyJobById(queued.id);
  assert.equal(stored?.status, "failed");
  assert.equal(stored?.error?.error, "missing_slot_document_id");
  assert.equal(stored?.error?.failure_class, "missing_slot");
  assert.equal(stored?.error?.recovery_decision?.next_state, "blocked");
  assert.equal(stored?.error?.recovery_decision?.waiting_user, true);
  assert.equal(stored?.error?.lifecycle_sink?.state, "waiting_user");
  assert.equal(stored?.lifecycle_sink?.state, "waiting_user");
});

test("runAutonomyWorkerOnce records escalated lifecycle sink on permission_denied", async () => {
  const queued = enqueueAutonomyJobRecord({
    jobType: "worker_permission_denied_via_recovery_decision_job",
    traceId: "trace_worker_permission_denied_via_recovery_decision",
    maxAttempts: 3,
  });

  const result = await runAutonomyWorkerOnce({
    workerId: "worker-permission-denied-via-decision",
    enabled: true,
    heartbeatIntervalMs: 60_000,
    async executeJob() {
      return {
        ok: false,
        error: "permission_denied_lark_scope",
      };
    },
  });

  assert.equal(result?.ok, false);
  assert.equal(result?.claimed, true);
  assert.equal(result?.failed, true);
  assert.equal(result?.retry_scheduled, false);
  assert.equal(result?.recovery_decision?.next_state, "escalated");

  const stored = getAutonomyJobById(queued.id);
  assert.equal(stored?.status, "failed");
  assert.equal(stored?.error?.error, "permission_denied_lark_scope");
  assert.equal(stored?.error?.failure_class, "permission_denied");
  assert.equal(stored?.error?.lifecycle_sink?.state, "escalated");
  assert.equal(stored?.lifecycle_sink?.state, "escalated");
});
