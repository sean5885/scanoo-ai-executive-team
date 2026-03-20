import test from "node:test";
import assert from "node:assert/strict";

import { startHttpServer } from "../src/http-server.mjs";

test("http server attaches trace_id and emits request logs", async (t) => {
  const calls = [];
  const logger = {
    log() {},
    info(...args) {
      calls.push(args);
    },
    warn(...args) {
      calls.push(args);
    },
    error(...args) {
      calls.push(args);
    },
  };

  const server = startHttpServer({ listen: false, logger });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/health`);
  const payload = await response.json();

  assert.equal(payload.ok, true);
  assert.match(payload.trace_id, /^http_/);
  assert.equal(calls.some((entry) => entry[1]?.event === "request_started"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "request_finished"), true);
});

test("http server preserves incoming x-request-id in request logs and response header", async (t) => {
  const calls = [];
  const logger = {
    log() {},
    info(...args) {
      calls.push(args);
    },
    warn(...args) {
      calls.push(args);
    },
    error(...args) {
      calls.push(args);
    },
  };

  const server = startHttpServer({ listen: false, logger });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/health`, {
    headers: {
      "X-Request-Id": "req_http_123",
    },
  });

  assert.equal(response.headers.get("x-request-id"), "req_http_123");
  assert.equal(calls.some((entry) => entry[1]?.event === "request_started" && entry[1]?.request_id === "req_http_123"), true);
});

test("http server emits child route logs for auth route", async (t) => {
  const calls = [];
  const logger = {
    log() {},
    info(...args) {
      calls.push(args);
    },
    warn(...args) {
      calls.push(args);
    },
    error(...args) {
      calls.push(args);
    },
  };

  const server = startHttpServer({ listen: false, logger });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/auth/status`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.match(payload.trace_id, /^http_/);
  assert.equal(calls.some((entry) => entry[1]?.event === "route_started" && entry[1]?.route === "auth_status"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "auth_status_missing_stored_token"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "route_succeeded" && entry[1]?.route === "auth_status"), true);
});

test("http server emits child route logs for drive list route", async (t) => {
  const calls = [];
  const logger = {
    log() {},
    info(...args) {
      calls.push(args);
    },
    warn(...args) {
      calls.push(args);
    },
    error(...args) {
      calls.push(args);
    },
  };

  const server = startHttpServer({ listen: false, logger });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/drive/list`);
  const payload = await response.json();

  assert.equal(response.status, 401);
  assert.match(payload.trace_id, /^http_/);
  assert.equal(calls.some((entry) => entry[1]?.event === "route_started" && entry[1]?.route === "drive_list"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "route_succeeded" && entry[1]?.route === "drive_list"), true);
});

test("http server emits child route logs for tasks list route", async (t) => {
  const calls = [];
  const logger = {
    log() {},
    info(...args) {
      calls.push(args);
    },
    warn(...args) {
      calls.push(args);
    },
    error(...args) {
      calls.push(args);
    },
  };

  const server = startHttpServer({ listen: false, logger });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/tasks`);
  const payload = await response.json();

  assert.equal(response.status, 401);
  assert.match(payload.trace_id, /^http_/);
  assert.equal(calls.some((entry) => entry[1]?.event === "route_started" && entry[1]?.route === "tasks_list"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "route_succeeded" && entry[1]?.route === "tasks_list"), true);
});

test("http server threads child logger into drive organize handler", async (t) => {
  const calls = [];
  const logger = {
    log() {},
    info(...args) {
      calls.push(args);
    },
    warn(...args) {
      calls.push(args);
    },
    error(...args) {
      calls.push(args);
    },
  };

  const server = startHttpServer({ listen: false, logger });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/drive/organize/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const payload = await response.json();

  assert.equal(response.status, 401);
  assert.match(payload.trace_id, /^http_/);
  assert.equal(calls.some((entry) => entry[1]?.event === "route_started" && entry[1]?.route === "drive_organize_preview"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "auth_context_resolve_started"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "auth_context_missing_user_token"), true);
});

test("http server threads child logger into calendar freebusy handler", async (t) => {
  const calls = [];
  const logger = {
    log() {},
    info(...args) {
      calls.push(args);
    },
    warn(...args) {
      calls.push(args);
    },
    error(...args) {
      calls.push(args);
    },
  };

  const server = startHttpServer({ listen: false, logger });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/calendar/freebusy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const payload = await response.json();

  assert.equal(response.status, 401);
  assert.match(payload.trace_id, /^http_/);
  assert.equal(calls.some((entry) => entry[1]?.event === "route_started" && entry[1]?.route === "calendar_freebusy"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "auth_context_resolve_started"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "auth_context_missing_user_token"), true);
});

test("http server threads child logger into wiki organize handler", async (t) => {
  const calls = [];
  const logger = {
    log() {},
    info(...args) {
      calls.push(args);
    },
    warn(...args) {
      calls.push(args);
    },
    error(...args) {
      calls.push(args);
    },
  };

  const server = startHttpServer({ listen: false, logger });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/wiki/organize/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const payload = await response.json();

  assert.equal(response.status, 401);
  assert.match(payload.trace_id, /^http_/);
  assert.equal(calls.some((entry) => entry[1]?.event === "route_started" && entry[1]?.route === "wiki_organize_preview"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "auth_context_resolve_started"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "auth_context_missing_user_token"), true);
});

test("http server emits child route logs for bitable records list route", async (t) => {
  const calls = [];
  const logger = {
    log() {},
    info(...args) {
      calls.push(args);
    },
    warn(...args) {
      calls.push(args);
    },
    error(...args) {
      calls.push(args);
    },
  };

  const server = startHttpServer({ listen: false, logger });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/bitable/apps/app-1/tables/tbl-1/records`);
  const payload = await response.json();

  assert.equal(response.status, 401);
  assert.match(payload.trace_id, /^http_/);
  assert.equal(calls.some((entry) => entry[1]?.event === "route_started" && entry[1]?.route === "bitable_records_list"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "auth_context_resolve_started"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "auth_context_missing_user_token"), true);
});

test("http server emits child route logs for bitable records search route", async (t) => {
  const calls = [];
  const logger = {
    log() {},
    info(...args) {
      calls.push(args);
    },
    warn(...args) {
      calls.push(args);
    },
    error(...args) {
      calls.push(args);
    },
  };

  const server = startHttpServer({ listen: false, logger });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/bitable/apps/app-1/tables/tbl-1/records/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const payload = await response.json();

  assert.equal(response.status, 401);
  assert.match(payload.trace_id, /^http_/);
  assert.equal(calls.some((entry) => entry[1]?.event === "route_started" && entry[1]?.route === "bitable_records_search"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "auth_context_resolve_started"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "auth_context_missing_user_token"), true);
});

test("http server emits child route logs for task comments list route", async (t) => {
  const calls = [];
  const logger = {
    log() {},
    info(...args) {
      calls.push(args);
    },
    warn(...args) {
      calls.push(args);
    },
    error(...args) {
      calls.push(args);
    },
  };

  const server = startHttpServer({ listen: false, logger });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/tasks/task-1/comments`);
  const payload = await response.json();

  assert.equal(response.status, 401);
  assert.match(payload.trace_id, /^http_/);
  assert.equal(calls.some((entry) => entry[1]?.event === "route_started" && entry[1]?.route === "task_comments_list"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "auth_context_resolve_started"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "auth_context_missing_user_token"), true);
});

test("http server emits child route logs for task comment create route", async (t) => {
  const calls = [];
  const logger = {
    log() {},
    info(...args) {
      calls.push(args);
    },
    warn(...args) {
      calls.push(args);
    },
    error(...args) {
      calls.push(args);
    },
  };

  const server = startHttpServer({ listen: false, logger });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/tasks/task-1/comments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const payload = await response.json();

  assert.equal(response.status, 401);
  assert.match(payload.trace_id, /^http_/);
  assert.equal(calls.some((entry) => entry[1]?.event === "route_started" && entry[1]?.route === "task_comment_create"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "auth_context_resolve_started"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "auth_context_missing_user_token"), true);
});
