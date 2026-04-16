import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAutonomyTraceFields,
  createAutonomyJobAttemptTraceContext,
  createAutonomyTraceContext,
  createAutonomyTraceId,
} from "../src/trace/autonomy-trace-context.mjs";

test("createAutonomyTraceId keeps deterministic prefix contract", () => {
  const traceId = createAutonomyTraceId("phase1");
  assert.match(traceId, /^phase1_[a-z0-9]+_[a-f0-9]{8}$/);
});

test("trace context exposes job/attempt correlation fields", () => {
  const context = createAutonomyTraceContext({
    traceId: "trace_manual_1",
    jobId: "job_1",
    attemptId: "attempt_1",
    workerId: "worker_1",
    source: "unit_test",
  });
  const fields = buildAutonomyTraceFields({
    traceContext: context,
    fields: {
      event: "job_claimed",
    },
  });

  assert.deepEqual(fields, {
    event: "job_claimed",
    trace_id: "trace_manual_1",
    job_id: "job_1",
    attempt_id: "attempt_1",
    worker_id: "worker_1",
    trace_source: "unit_test",
  });
});

test("job attempt trace context derives correlation from job and attempt", () => {
  const context = createAutonomyJobAttemptTraceContext({
    job: {
      id: "job_2",
      trace_id: "trace_from_job",
    },
    attempt: {
      id: "attempt_2",
      job_id: "job_2",
      trace_id: "trace_from_attempt",
    },
    workerId: "worker_2",
    source: "autonomy_worker_loop",
  });

  assert.equal(context.trace_id, "trace_from_job");
  assert.equal(context.job_id, "job_2");
  assert.equal(context.attempt_id, "attempt_2");
  assert.equal(context.worker_id, "worker_2");
  assert.equal(context.source, "autonomy_worker_loop");
});
