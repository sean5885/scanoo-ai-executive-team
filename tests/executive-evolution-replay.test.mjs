import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  formatExecutiveReplayReport,
  replayExecutiveTaskEvolution,
} from "../src/executive-evolution-replay.mjs";

const execFileAsync = promisify(execFile);

function buildReplaySpec() {
  return {
    task: {
      task_type: "search",
      objective: "整理知識答案",
      success_criteria: ["有可讀結論", "有來源證據"],
      work_plan: [
        {
          agent_id: "research",
          task: "查資料",
          selected_action: "search_company_brain_docs",
          status: "completed",
          tool_required: true,
        },
        {
          agent_id: "generalist",
          task: "回答使用者",
          selected_action: "answer_user",
          status: "completed",
        },
      ],
    },
    request_text: "幫我整理知識答案",
    first_run: {
      reply: {
        text: "這是答案，但沒有來源。",
      },
      routing: {
        action: "answer_user",
        dispatched_actions: [
          { action: "search_company_brain_docs", status: "completed" },
          { action: "answer_user", status: "completed" },
        ],
      },
    },
    second_run: {
      reply: {
        text: "這是答案，來源整理如下。",
      },
      routing: {
        action: "answer_user",
        dispatched_actions: [
          { action: "search_company_brain_docs", status: "completed" },
          { action: "answer_user", status: "completed" },
        ],
      },
      extraEvidence: [
        { type: "tool_output", summary: "retrieved_sources:2" },
      ],
    },
  };
}

test("replayExecutiveTaskEvolution compares baseline and improved run", () => {
  const logs = [];
  const report = replayExecutiveTaskEvolution({
    ...buildReplaySpec(),
    logger: {
      info(event, payload) {
        logs.push({ event, payload });
      },
    },
  });

  assert.equal(report.first_run.success, false);
  assert.equal(report.second_run.success, true);
  assert.deepEqual(report.improvement_delta, {
    status: "improved",
    success: {
      previous: false,
      current: true,
      status: "improved",
    },
    steps: {
      total_steps: {
        previous: 2,
        current: 2,
        delta: 0,
        status: "same",
      },
      successful_steps: {
        previous: 0,
        current: 2,
        delta: 2,
        status: "improved",
      },
      failed_steps: {
        previous: 2,
        current: 0,
        delta: -2,
        status: "improved",
      },
      deviated_steps: {
        previous: 2,
        current: 0,
        delta: -2,
        status: "improved",
      },
      intents: {
        previous: ["search_company_brain_docs", "answer_user"],
        current: ["search_company_brain_docs", "answer_user"],
        added: [],
        removed: [],
        status: "same",
      },
    },
    deviation: {
      rate: {
        previous: 1,
        current: 0,
        delta: -1,
        status: "improved",
      },
      overall_status: {
        previous: "failed",
        current: "success",
        status: "improved",
      },
    },
  });

  const rendered = formatExecutiveReplayReport(report);
  assert.match(rendered, /Improvement delta: improved/);
  assert.match(rendered, /success: false -> true \| improved/);
  assert.match(rendered, /deviation_rate: 1 -> 0 \| delta -1\.0000 \| improved/);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, "executive_evolution_replay");
  assert.deepEqual(logs[0].payload.improvement_delta, report.improvement_delta);
});

test("executive evolution replay CLI prints improvement delta", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "executive-replay-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const specPath = path.join(tempDir, "spec.json");
  await fs.writeFile(specPath, `${JSON.stringify(buildReplaySpec(), null, 2)}\n`, "utf8");

  const { stdout } = await execFileAsync(process.execPath, [
    "scripts/executive-evolution-replay.mjs",
    specPath,
  ], {
    cwd: process.cwd(),
  });

  assert.match(stdout, /Executive Evolution Replay/);
  assert.match(stdout, /First run: success=false/);
  assert.match(stdout, /Second run: success=true/);
  assert.match(stdout, /Improvement delta: improved/);
});
