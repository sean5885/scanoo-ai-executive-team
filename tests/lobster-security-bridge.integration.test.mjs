import test from "node:test";
import assert from "node:assert/strict";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();

const [
  { startHttpServer },
] = await Promise.all([
  import("../src/http-server.mjs"),
]);

test.after(() => {
  testDb.close();
});

function createSilentLogger() {
  return {
    log() {},
    info() {},
    warn() {},
    error() {},
  };
}

async function startSecurityTestServer(t, serviceOverrides = {}) {
  const server = startHttpServer({
    listen: false,
    logger: createSilentLogger(),
    serviceOverrides,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections?.();
    return new Promise((resolve) => server.close(resolve));
  });
  return server;
}

test("lobster security agent routes keep approval_required explicit through resolve and replay", async (t) => {
  const pending = [];
  const calls = [];

  const server = await startSecurityTestServer(t, {
    getSecurityStatus: async () => ({
      ok: true,
      enabled: true,
      approval_mode: "strict",
      pending_approvals: pending.length,
    }),
    startSecureTask: async (name) => {
      calls.push(["start", name]);
      return {
        task_id: "task-1",
        name,
      };
    },
    executeSecureAction: async (taskId, action) => {
      calls.push(["execute", taskId, action]);
      pending.splice(0, pending.length, {
        request_id: "req-1",
        task_id: taskId,
        action,
        approval_request: {
          request_id: "req-1",
          reason: "high_risk_command",
        },
      });
      return {
        ok: false,
        status: "approval_required",
        approval_request: {
          request_id: "req-1",
          reason: "high_risk_command",
        },
      };
    },
    listPendingApprovals: async () => pending.slice(),
    resolvePendingApproval: async (requestId, approved, actor) => {
      calls.push(["resolve", requestId, approved, actor]);
      pending.splice(0, pending.length);
      return {
        ok: true,
        status: approved ? "approved" : "rejected",
        request_id: requestId,
        execution: approved
          ? {
              replayed: true,
              result: {
                task_id: "task-1",
                status: "completed",
              },
            }
          : null,
      };
    },
    finishSecureTask: async (taskId, success) => {
      calls.push(["finish", taskId, success]);
      return {
        task_id: taskId,
        success,
        changed_files: [],
      };
    },
    rollbackSecureTask: async (taskId, dryRun) => {
      calls.push(["rollback", taskId, dryRun]);
      return {
        task_id: taskId,
        dry_run: dryRun,
        restored_files: [],
      };
    },
  });

  const { port } = server.address();

  const statusResponse = await fetch(`http://127.0.0.1:${port}/agent/security/status`);
  const statusPayload = await statusResponse.json();
  assert.equal(statusResponse.status, 200);
  assert.equal(statusPayload.ok, true);
  assert.equal(statusPayload.pending_approvals, 0);

  const taskResponse = await fetch(`http://127.0.0.1:${port}/agent/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "dangerous-task" }),
  });
  const taskPayload = await taskResponse.json();
  assert.equal(taskResponse.status, 200);
  assert.equal(taskPayload.task.task_id, "task-1");

  const actionResponse = await fetch(`http://127.0.0.1:${port}/agent/tasks/task-1/actions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: {
        type: "command",
        command: ["rm", "-rf", "/tmp/not-real"],
      },
    }),
  });
  const actionPayload = await actionResponse.json();
  assert.equal(actionResponse.status, 409);
  assert.equal(actionPayload.status, "approval_required");
  assert.equal(actionPayload.approval_request.request_id, "req-1");

  const approvalsResponse = await fetch(`http://127.0.0.1:${port}/agent/approvals`);
  const approvalsPayload = await approvalsResponse.json();
  assert.equal(approvalsResponse.status, 200);
  assert.equal(approvalsPayload.total, 1);
  assert.equal(approvalsPayload.items[0].request_id, "req-1");

  const resolveResponse = await fetch(`http://127.0.0.1:${port}/agent/approvals/req-1/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actor: "reviewer@test" }),
  });
  const resolvePayload = await resolveResponse.json();
  assert.equal(resolveResponse.status, 200);
  assert.equal(resolvePayload.status, "approved");
  assert.equal(resolvePayload.execution.replayed, true);

  const finishResponse = await fetch(`http://127.0.0.1:${port}/agent/tasks/task-1/finish`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ success: true }),
  });
  const finishPayload = await finishResponse.json();
  assert.equal(finishResponse.status, 200);
  assert.equal(finishPayload.ok, true);
  assert.equal(finishPayload.diff.success, true);

  assert.deepEqual(calls, [
    ["start", "dangerous-task"],
    ["execute", "task-1", { type: "command", command: ["rm", "-rf", "/tmp/not-real"] }],
    ["resolve", "req-1", true, "reviewer@test"],
    ["finish", "task-1", true],
  ]);
});
