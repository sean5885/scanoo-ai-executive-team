import test from "node:test";
import assert from "node:assert/strict";

import { runTaskLayer } from "../src/task-layer/orchestrator.mjs";
import { classifyTask } from "../src/task-layer/task-classifier.mjs";
import { TASK_SKILL_MAP } from "../src/task-layer/task-skill-map.mjs";

test("classifyTask returns stable task tags from keyword heuristics", () => {
  assert.deepEqual(classifyTask("請幫我寫文案、做配圖，最後發布"), [
    "copywriting",
    "image",
    "publish",
  ]);
  assert.deepEqual(classifyTask("只是查詢資料"), []);
});

test("runTaskLayer maps tasks to skills and records per-task failures", async () => {
  const calls = [];
  const result = await runTaskLayer("請幫我寫文案、做配圖，最後發布", async (skill, payload) => {
    calls.push({ skill, payload });
    if (skill === "message_send") {
      throw new Error("publish blocked");
    }
    return { handledBy: skill, task: payload.task };
  });

  assert.deepEqual(result.tasks, ["copywriting", "image", "publish"]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.summary, {
    copywriting: "done",
    image: "done",
    publish: "failed",
  });
  assert.deepEqual(result.data, {
    copywriting: {
      handledBy: "document_summarize",
      task: "copywriting",
    },
    image: {
      handledBy: "image_generate",
      task: "image",
    },
  });
  assert.deepEqual(result.errors, [
    {
      task: "publish",
      error: "publish blocked",
    },
  ]);
  assert.deepEqual(calls, [
    {
      skill: "document_summarize",
      payload: {
        input: "請幫我寫文案、做配圖，最後發布",
        task: "copywriting",
      },
    },
    {
      skill: "image_generate",
      payload: {
        input: "請幫我寫文案、做配圖，最後發布",
        task: "image",
      },
    },
    {
      skill: "message_send",
      payload: {
        input: "請幫我寫文案、做配圖，最後發布",
        task: "publish",
      },
    },
  ]);
  assert.deepEqual(result.results, [
    {
      task: "copywriting",
      ok: true,
      result: {
        handledBy: "document_summarize",
        task: "copywriting",
      },
    },
    {
      task: "image",
      ok: true,
      result: {
        handledBy: "image_generate",
        task: "image",
      },
    },
    {
      task: "publish",
      ok: false,
      status: "failed",
      blocked: false,
      failure_class: null,
      error: "publish blocked",
    },
  ]);
});

test("runTaskLayer records a fail-soft error when a task has no mapped skill", async () => {
  const originalImageSkill = TASK_SKILL_MAP.image;
  delete TASK_SKILL_MAP.image;

  try {
    const calls = [];
    const result = await runTaskLayer("請幫我做配圖", async (skill, payload) => {
      calls.push({ skill, payload });
      return { handledBy: skill, task: payload.task };
    });

    assert.deepEqual(calls, []);
    assert.equal(result.ok, false);
    assert.deepEqual(result.tasks, ["image"]);
    assert.deepEqual(result.summary, {
      image: "failed",
    });
    assert.deepEqual(result.errors, [
      {
        task: "image",
        error: "no_skill_mapped",
      },
    ]);
    assert.deepEqual(result.results, [
      {
        task: "image",
        ok: false,
        error: "no_skill_mapped",
      },
    ]);
  } finally {
    TASK_SKILL_MAP.image = originalImageSkill;
  }
});

test("runTaskLayer marks image task blocked when skill fail-closes on missing backend", async () => {
  const result = await runTaskLayer("請幫我做配圖", async (skill, payload) => {
    assert.equal(skill, "image_generate");
    assert.equal(payload.task, "image");
    return {
      ok: false,
      error: "business_error",
      details: {
        failure_class: "capability_gap",
        reason: "image_backend_unavailable",
      },
    };
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.summary, {
    image: "blocked",
  });
  assert.deepEqual(result.errors, [
    {
      task: "image",
      error: "business_error",
      status: "blocked",
      blocked: true,
      failure_class: "capability_gap",
    },
  ]);
  assert.deepEqual(result.results, [
    {
      task: "image",
      ok: false,
      status: "blocked",
      blocked: true,
      failure_class: "capability_gap",
      error: "business_error",
    },
  ]);
});

test("runTaskLayer blocks image placeholder output so it cannot be treated as success", async () => {
  const result = await runTaskLayer("請幫我做配圖", async () => ({
    ok: true,
    output: {
      prompt: "cat",
      url: "https://dummyimage.com/512x512/000/fff.png&text=cat",
    },
  }));

  assert.equal(result.ok, false);
  assert.deepEqual(result.summary, {
    image: "blocked",
  });
  assert.deepEqual(result.errors, [
    {
      task: "image",
      error: "placeholder_output_blocked",
      status: "blocked",
      blocked: true,
      failure_class: "capability_gap",
    },
  ]);
});
