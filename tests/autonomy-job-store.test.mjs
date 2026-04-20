import test from "node:test";
import assert from "node:assert/strict";

import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();
const { db } = testDb;
const {
  applyAutonomyIncidentDisposition,
  buildAutonomyIncidentReplaySpec,
  claimNextAutonomyJob,
  completeAutonomyAttempt,
  enqueueAutonomyJobRecord,
  ensureAutonomyJobTables,
  failAutonomyAttempt,
  heartbeatAutonomyAttempt,
  listAutonomyOpenIncidents,
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

function createFailedSinkIncident({
  jobType = "unit_test_incident_job",
  traceId = "trace_store_incident",
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

test("autonomy job store lists open incidents from failed lifecycle sinks", () => {
  const waitingIncident = createFailedSinkIncident({
    jobType: "unit_test_waiting_incident_job",
    traceId: "trace_store_open_waiting",
    sinkState: "waiting_user",
    failureClass: "business_error",
    routingHint: "answer_waiting_user",
  });
  const escalatedIncident = createFailedSinkIncident({
    jobType: "unit_test_escalated_incident_job",
    traceId: "trace_store_open_escalated",
    sinkState: "escalated",
    failureClass: "permission_denied",
    routingHint: "need_human_approval",
  });

  const nonSinkQueued = enqueueAutonomyJobRecord({
    jobType: "unit_test_failed_without_sink",
    traceId: "trace_store_no_sink",
    maxAttempts: 1,
  });
  const nonSinkClaim = claimNextAutonomyJob({
    workerId: "worker-trace_store_no_sink",
    leaseMs: 30_000,
  });
  failAutonomyAttempt({
    jobId: nonSinkClaim?.job?.id,
    attemptId: nonSinkClaim?.attempt?.id,
    workerId: "worker-trace_store_no_sink",
    retryable: false,
    error: {
      reason: "forced_failure_without_sink",
    },
  });

  const incidents = listAutonomyOpenIncidents({
    limit: 10,
  });
  assert.equal(Array.isArray(incidents), true);
  assert.equal(incidents.length, 2);

  const waiting = incidents.find((incident) => incident.job_id === waitingIncident.queued.id);
  assert.equal(waiting?.attempt_id, waitingIncident.claim?.attempt?.id);
  assert.equal(waiting?.lifecycle_sink, "waiting_user");
  assert.equal(waiting?.failure_class, "business_error");
  assert.equal(waiting?.routing_hint, "answer_waiting_user");
  assert.equal(waiting?.trace_id, "trace_store_open_waiting");
  assert.equal(Boolean(waiting?.updated_at), true);

  const escalated = incidents.find((incident) => incident.job_id === escalatedIncident.queued.id);
  assert.equal(escalated?.attempt_id, escalatedIncident.claim?.attempt?.id);
  assert.equal(escalated?.lifecycle_sink, "escalated");
  assert.equal(escalated?.failure_class, "permission_denied");
  assert.equal(escalated?.routing_hint, "need_human_approval");
  assert.equal(escalated?.trace_id, "trace_store_open_escalated");
  assert.equal(Boolean(escalated?.updated_at), true);

  assert.equal(incidents.some((incident) => incident.job_id === nonSinkQueued.id), false);
});

test("autonomy job store ack disposition writes metadata only without status changes", () => {
  const waitingIncident = createFailedSinkIncident({
    jobType: "unit_test_ack_waiting_incident",
    traceId: "trace_store_ack_waiting",
    sinkState: "waiting_user",
  });
  const escalatedIncident = createFailedSinkIncident({
    jobType: "unit_test_ack_escalated_incident",
    traceId: "trace_store_ack_escalated",
    sinkState: "escalated",
    failureClass: "permission_denied",
    routingHint: "need_human_approval",
  });

  const acked = applyAutonomyIncidentDisposition({
    jobId: waitingIncident.queued.id,
    action: "ack_waiting_user",
    reason: "operator_confirmed_waiting_user",
  });
  assert.equal(acked?.ok, true);
  assert.equal(acked?.rescheduled, false);
  assert.equal(acked?.job?.status, "failed");
  assert.equal(acked?.disposition?.action, "ack_waiting_user");
  assert.equal(acked?.disposition?.reason, "operator_confirmed_waiting_user");
  assert.equal(acked?.job?.error?.operator_disposition?.latest?.action, "ack_waiting_user");
  assert.equal(acked?.job?.error?.operator_disposition?.latest?.reason, "operator_confirmed_waiting_user");
  assert.equal(Array.isArray(acked?.job?.error?.operator_disposition?.history), true);
  assert.equal(acked?.job?.error?.operator_disposition?.history.length, 1);
  assert.equal(acked?.replay_spec?.version, "autonomy_incident_replay_spec_v1");

  const ackedEscalated = applyAutonomyIncidentDisposition({
    jobId: escalatedIncident.queued.id,
    action: "ack_escalated",
    reason: "operator_confirmed_escalation",
  });
  assert.equal(ackedEscalated?.ok, true);
  assert.equal(ackedEscalated?.rescheduled, false);
  assert.equal(ackedEscalated?.job?.status, "failed");
  assert.equal(ackedEscalated?.job?.error?.operator_disposition?.latest?.action, "ack_escalated");

  const incidentsAfterAck = listAutonomyOpenIncidents({
    limit: 10,
  });
  assert.equal(incidentsAfterAck.some((incident) => incident.job_id === waitingIncident.queued.id), false);
  assert.equal(incidentsAfterAck.some((incident) => incident.job_id === escalatedIncident.queued.id), false);
});

test("autonomy incident disposition supports precondition and writes operator audit fields", () => {
  const waitingIncident = createFailedSinkIncident({
    jobType: "unit_test_precondition_success_incident",
    traceId: "trace_store_precondition_success",
    sinkState: "waiting_user",
  });
  const openIncident = listAutonomyOpenIncidents({
    limit: 10,
  }).find((incident) => incident.job_id === waitingIncident.queued.id);
  assert.equal(Boolean(openIncident?.updated_at), true);

  const acked = applyAutonomyIncidentDisposition({
    jobId: waitingIncident.queued.id,
    action: "ack_waiting_user",
    reason: "operator_ack_with_precondition",
    precondition: {
      expected_updated_at: openIncident.updated_at,
    },
    operatorId: "operator-001",
    requestId: "req-incident-001",
  });
  assert.equal(acked?.ok, true);
  assert.equal(acked?.error, undefined);
  assert.equal(acked?.disposition?.expected_updated_at, openIncident.updated_at);
  assert.equal(acked?.disposition?.operator_id, "operator-001");
  assert.equal(acked?.disposition?.request_id, "req-incident-001");
  assert.equal(acked?.job?.status, "failed");
  assert.equal(acked?.job?.error?.operator_disposition?.latest?.action, "ack_waiting_user");
  assert.equal(acked?.job?.error?.operator_disposition?.latest?.operator_id, "operator-001");
  assert.equal(acked?.job?.error?.operator_disposition?.latest?.request_id, "req-incident-001");
  assert.equal(acked?.job?.error?.operator_disposition?.latest?.expected_updated_at, openIncident.updated_at);
  assert.equal(acked?.job?.error?.operator_disposition?.history?.length, 1);
  assert.equal(acked?.job?.error?.operator_disposition?.history?.[0]?.operator_id, "operator-001");
  assert.equal(acked?.job?.error?.operator_disposition?.history?.[0]?.request_id, "req-incident-001");
  assert.equal(acked?.job?.error?.operator_disposition?.history?.[0]?.expected_updated_at, openIncident.updated_at);
});

test("autonomy incident disposition rejects stale precondition and does not write disposition", () => {
  const waitingIncident = createFailedSinkIncident({
    jobType: "unit_test_precondition_stale_incident",
    traceId: "trace_store_precondition_stale",
    sinkState: "waiting_user",
  });
  const openIncident = listAutonomyOpenIncidents({
    limit: 10,
  }).find((incident) => incident.job_id === waitingIncident.queued.id);
  assert.equal(Boolean(openIncident?.updated_at), true);

  const forcedUpdatedAt = "2026-04-20T01:00:00.000Z";
  db.prepare(`
    UPDATE autonomy_jobs
    SET updated_at = @updated_at
    WHERE id = @job_id
  `).run({
    updated_at: forcedUpdatedAt,
    job_id: waitingIncident.queued.id,
  });

  const staleWrite = applyAutonomyIncidentDisposition({
    jobId: waitingIncident.queued.id,
    action: "ack_waiting_user",
    reason: "operator_ack_should_fail_stale",
    precondition: {
      expected_updated_at: openIncident.updated_at,
    },
    operatorId: "operator-should-not-write",
    requestId: "req-should-not-write",
  });
  assert.equal(staleWrite?.ok, false);
  assert.equal(staleWrite?.error, "precondition_failed");
  assert.equal(staleWrite?.stale, true);
  assert.equal(staleWrite?.expected_updated_at, openIncident.updated_at);
  assert.equal(staleWrite?.current_updated_at, forcedUpdatedAt);

  const jobRow = db.prepare(`
    SELECT error_json
    FROM autonomy_jobs
    WHERE id = @job_id
    LIMIT 1
  `).get({
    job_id: waitingIncident.queued.id,
  });
  const error = jobRow?.error_json ? JSON.parse(jobRow.error_json) : null;
  assert.equal(error?.operator_disposition, undefined);

  const incidentsAfterStale = listAutonomyOpenIncidents({
    limit: 10,
  });
  assert.equal(incidentsAfterStale.some((incident) => incident.job_id === waitingIncident.queued.id), true);
});

test("autonomy incident disposition remains backward-compatible without new audit fields", () => {
  const waitingIncident = createFailedSinkIncident({
    jobType: "unit_test_backward_compatible_incident",
    traceId: "trace_store_backward_compatible",
    sinkState: "waiting_user",
  });

  const acked = applyAutonomyIncidentDisposition({
    jobId: waitingIncident.queued.id,
    action: "ack_waiting_user",
    reason: "legacy_operator_ack",
  });
  assert.equal(acked?.ok, true);
  assert.equal(acked?.job?.status, "failed");
  assert.equal(acked?.job?.error?.operator_disposition?.latest?.action, "ack_waiting_user");
  assert.equal(Object.hasOwn(acked?.job?.error?.operator_disposition?.latest || {}, "operator_id"), false);
  assert.equal(Object.hasOwn(acked?.job?.error?.operator_disposition?.latest || {}, "request_id"), false);
  assert.equal(Object.hasOwn(acked?.job?.error?.operator_disposition?.latest || {}, "expected_updated_at"), false);
});

test("autonomy job store resume disposition makes failed incident schedulable again", () => {
  const escalatedIncident = createFailedSinkIncident({
    jobType: "unit_test_resume_incident",
    traceId: "trace_store_resume",
    sinkState: "escalated",
    failureClass: "permission_denied",
    routingHint: "need_operator_resume",
  });

  const resumed = applyAutonomyIncidentDisposition({
    jobId: escalatedIncident.queued.id,
    action: "resume_same_job",
    reason: "operator_resume_after_fix",
  });
  assert.equal(resumed?.ok, true);
  assert.equal(resumed?.rescheduled, true);
  assert.equal(resumed?.job?.status, "queued");
  assert.equal(Boolean(resumed?.job?.next_run_at), true);
  assert.equal(resumed?.job?.failed_at, null);
  assert.equal(resumed?.job?.error?.operator_disposition?.latest?.action, "resume_same_job");
  assert.equal(resumed?.job?.error?.operator_disposition?.latest?.reason, "operator_resume_after_fix");

  const reclaimed = claimNextAutonomyJob({
    workerId: "worker-resume-reclaim",
    leaseMs: 30_000,
  });
  assert.equal(reclaimed?.job?.id, escalatedIncident.queued.id);
  assert.equal(reclaimed?.job?.status, "running");
});

test("autonomy job store rejects sink-mismatched ack action and keeps incident unchanged", () => {
  const waitingIncident = createFailedSinkIncident({
    jobType: "unit_test_mismatch_incident",
    traceId: "trace_store_mismatch",
    sinkState: "waiting_user",
  });

  const mismatch = applyAutonomyIncidentDisposition({
    jobId: waitingIncident.queued.id,
    action: "ack_escalated",
    reason: "wrong_ack",
  });
  assert.equal(mismatch?.ok, false);
  assert.equal(mismatch?.error, "operator_action_lifecycle_sink_mismatch");

  const incidents = listAutonomyOpenIncidents({
    limit: 10,
  });
  const waiting = incidents.find((incident) => incident.job_id === waitingIncident.queued.id);
  assert.equal(waiting?.lifecycle_sink, "waiting_user");
});

test("autonomy job store preserves operator disposition history on later runtime failure and reopens incident", () => {
  const incident = createFailedSinkIncident({
    jobType: "unit_test_resume_then_fail_incident",
    traceId: "trace_store_resume_then_fail",
    sinkState: "escalated",
    failureClass: "permission_denied",
    routingHint: "need_operator_resume",
  });

  const resumed = applyAutonomyIncidentDisposition({
    jobId: incident.queued.id,
    action: "resume_same_job",
    reason: "operator_resume_after_fix",
  });
  assert.equal(resumed?.ok, true);
  assert.equal(resumed?.rescheduled, true);
  assert.equal(resumed?.job?.status, "queued");
  assert.equal(resumed?.job?.error?.operator_disposition?.latest?.action, "resume_same_job");

  const reclaimed = claimNextAutonomyJob({
    workerId: "worker-resume-then-fail",
    leaseMs: 30_000,
  });
  assert.equal(reclaimed?.job?.id, incident.queued.id);
  assert.equal(reclaimed?.job?.status, "running");

  const failedAgain = failAutonomyAttempt({
    jobId: reclaimed?.job?.id,
    attemptId: reclaimed?.attempt?.id,
    workerId: "worker-resume-then-fail",
    retryable: false,
    error: {
      reason: "forced_second_failure",
      lifecycle_sink: {
        state: "waiting_user",
        failure_class: "runtime_exception",
        routing_hint: "answer_waiting_user",
        at: "2026-04-20T00:10:00.000Z",
      },
    },
  });
  assert.equal(failedAgain?.ok, true);
  assert.equal(failedAgain?.retry_scheduled, false);
  assert.equal(failedAgain?.job?.status, "failed");
  assert.equal(failedAgain?.job?.error?.reason, "forced_second_failure");
  assert.equal(Array.isArray(failedAgain?.job?.error?.operator_disposition?.history), true);
  assert.equal(failedAgain?.job?.error?.operator_disposition?.history.length, 2);
  assert.equal(failedAgain?.job?.error?.operator_disposition?.history[0]?.action, "resume_same_job");
  assert.equal(failedAgain?.job?.error?.operator_disposition?.latest?.action, "runtime_failure");

  const incidents = listAutonomyOpenIncidents({
    limit: 10,
  });
  const reopened = incidents.find((item) => item.job_id === incident.queued.id);
  assert.equal(reopened?.lifecycle_sink, "waiting_user");
  assert.equal(reopened?.failure_class, "runtime_exception");
});

test("autonomy incident replay spec builder returns bounded metadata", () => {
  const replaySpec = buildAutonomyIncidentReplaySpec({
    incident: {
      job_id: "job-1",
      attempt_id: "attempt-1",
      lifecycle_sink: "escalated",
      failure_class: "permission_denied",
      routing_hint: "need_human_approval",
      trace_id: "trace-1",
      updated_at: "2026-04-20T00:00:00.000Z",
    },
    action: "ack_escalated",
    reason: "operator_ack",
    generatedAt: "2026-04-20T12:00:00.000Z",
  });
  assert.equal(replaySpec?.version, "autonomy_incident_replay_spec_v1");
  assert.equal(replaySpec?.action, "ack_escalated");
  assert.equal(replaySpec?.reason, "operator_ack");
  assert.equal(replaySpec?.incident?.job_id, "job-1");
  assert.equal(replaySpec?.incident?.lifecycle_sink, "escalated");
});
