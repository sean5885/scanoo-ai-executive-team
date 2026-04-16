import test from "node:test";
import assert from "node:assert/strict";

import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();
const { db } = testDb;
const { ensureAutonomyJobTables } = await import("../src/task-runtime/autonomy-job-store.mjs");
const { enqueueAutonomyJob } = await import("../src/worker/enqueue-autonomy-job.mjs");

const previousAutonomyEnabled = process.env.AUTONOMY_ENABLED;

test.after(() => {
  if (previousAutonomyEnabled == null) {
    delete process.env.AUTONOMY_ENABLED;
  } else {
    process.env.AUTONOMY_ENABLED = previousAutonomyEnabled;
  }
  testDb.close();
});

test.beforeEach(() => {
  ensureAutonomyJobTables();
  db.exec(`
    DELETE FROM autonomy_job_attempts;
    DELETE FROM autonomy_jobs;
  `);
});

test("enqueueAutonomyJob keeps skip contract when AUTONOMY_ENABLED=false", async () => {
  process.env.AUTONOMY_ENABLED = "false";

  const result = await enqueueAutonomyJob({
    jobType: "disabled_job",
    payload: {
      from: "test",
    },
    traceId: "trace_enqueue_disabled",
  });

  assert.equal(result?.ok, false);
  assert.equal(result?.skipped, true);
  assert.equal(result?.reason, "autonomy_disabled");
  assert.equal(typeof result?.trace_id, "string");
  assert.equal(result?.trace_id, "trace_enqueue_disabled");

  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM autonomy_jobs
  `).get();
  assert.equal(row?.count, 0);
});
