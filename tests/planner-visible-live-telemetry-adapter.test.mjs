import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  createInMemoryTelemetryAdapter,
  createStructuredLogTelemetryAdapter,
} from "../src/planner-visible-live-telemetry-adapter.mjs";

test("in-memory telemetry adapter keeps a bounded event buffer and can reset", () => {
  const adapter = createInMemoryTelemetryAdapter({
    maxBufferSize: 2,
  });

  adapter.emit({ event: "planner_visible_skill_selected", request_id: "req_a" });
  adapter.emit({ event: "planner_visible_answer_generated", request_id: "req_a" });
  adapter.emit({ event: "planner_visible_fallback", request_id: "req_b" });

  assert.deepEqual(adapter.getBuffer().map((event) => event.event), [
    "planner_visible_answer_generated",
    "planner_visible_fallback",
  ]);
  assert.deepEqual(adapter.getBuffer({ request_id: "req_b" }).map((event) => event.event), [
    "planner_visible_fallback",
  ]);

  adapter.reset({
    maxBufferSize: 4,
  });
  assert.deepEqual(adapter.getBuffer(), []);
  adapter.emit({ event: "planner_visible_fail_closed", request_id: "req_reset" });
  assert.equal(adapter.flush(), 1);
});

test("structured log telemetry adapter writes JSON lines to the file stub", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "planner-visible-telemetry-"));
  const filePath = path.join(tempDir, "telemetry.log");
  const adapter = createStructuredLogTelemetryAdapter({
    destination: "file",
    filePath,
  });

  adapter.emit({
    event: "planner_visible_skill_selected",
    request_id: "req_file_stub",
    selected_skill: "search_and_summarize",
  });

  const persistedLines = readFileSync(filePath, "utf8").trim().split("\n");
  assert.equal(persistedLines.length, 1);
  assert.deepEqual(JSON.parse(persistedLines[0]), {
    event: "planner_visible_skill_selected",
    request_id: "req_file_stub",
    selected_skill: "search_and_summarize",
  });
  assert.deepEqual(adapter.getBuffer(), [
    {
      event: "planner_visible_skill_selected",
      request_id: "req_file_stub",
      selected_skill: "search_and_summarize",
    },
  ]);
  assert.equal(adapter.flush(), 1);
});
