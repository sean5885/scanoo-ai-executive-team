import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const tempDir = mkdtempSync(path.join(tmpdir(), "playground-governance-test-"));
process.env.AGENT_WORKFLOW_CHECKPOINT_STORE = path.join(tempDir, "workflow-checkpoints.json");
const testDb = await createTestDbHarness();

const { getWorkflowCheckpoint, updateWorkflowCheckpoint } = await import("../src/agent-workflow-state.mjs");
const { buildKnowledgeAnswerPrompt } = await import("../src/answer-service.mjs");
const { buildRewritePromptInput } = await import("../src/doc-comment-rewrite.mjs");

test.after(() => {
  testDb.close();
});

function buildKnowledgeItems() {
  return [
    {
      title: "AI 系統速度優化藍圖",
      url: "https://example.com/doc-speed",
      content: "oMLX、上下文瘦身、summary checkpoint、retrieval only snippets。".repeat(120),
    },
    {
      title: "長任務處理守則",
      url: "https://example.com/doc-long-task",
      content: "每完成一段就外部化 checkpoint，保留未完成事項與關鍵約束。".repeat(100),
    },
    {
      title: "工具輸出治理",
      url: "https://example.com/doc-tools",
      content: "長 log、stack trace、JSON payload 都要先摘要化，只回必要欄位。".repeat(110),
    },
  ];
}

function buildRewriteDocument() {
  return {
    document_id: "doccn-long-governance",
    title: "Lobster 長任務規格",
    content: [
      "# 背景",
      "這是一份很長的規格文件，用來測試 comment rewrite 在多輪修訂時是否仍能控制上下文大小。".repeat(40),
      "",
      "# 現況問題",
      "目前風險包含長對話膨脹、工具輸出過大、歷史背景重複注入。".repeat(36),
      "",
      "# 目標",
      "保留任務連續性，但不要讓 prompt 失控。".repeat(34),
      "",
      "# 執行方案",
      "需要用 checkpoint、focused excerpts、comment summary 和 full document fallback。".repeat(42),
      "",
      "# 驗證",
      "需要多輪驗證與壓測，確認 prompt 不會線性成長。".repeat(38),
    ].join("\n"),
  };
}

function buildRewriteComments(round) {
  return [
    {
      comment_id: `c-${round}-1`,
      quote: "checkpoint、focused excerpts、comment summary 和 full document fallback",
      latest_reply_text: `第 ${round} 輪請把任務連續性與 token 成本的取捨寫清楚`,
      replies: [],
    },
    {
      comment_id: `c-${round}-2`,
      quote: "需要多輪驗證與壓測",
      latest_reply_text: `第 ${round} 輪請補上驗收條件與風險`,
      replies: [{ text: "請不要重複整份歷史內容" }],
    },
  ];
}

test.after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test("knowledge prompt stays bounded across many rounds with checkpoint externalization", async () => {
  const workflowKey = "knowledge-lane:test-long-task";
  const tokenSeries = [];
  const stages = [];

  for (let round = 1; round <= 10; round += 1) {
    await updateWorkflowCheckpoint(workflowKey, {
      goal: "持續回答同一個長任務中的知識問題。",
      completed: [`第 ${round} 輪已處理回答速度與上下文治理的一部分`],
      pending: [`第 ${round + 1} 輪要接著回答新的 follow-up`],
      constraints: ["只能依據檢索內容回答", "不要重複解釋專案背景"],
      facts: [`第 ${round} 輪已確認 checkpoint 可外部化`, `當前 round=${round}`],
      risks: ["避免 prompt 線性膨脹"],
      meta: { round },
    });
    const checkpoint = await getWorkflowCheckpoint(workflowKey);
    const prompt = buildKnowledgeAnswerPrompt({
      question: `第 ${round} 輪：oMLX 對回答速度是否有幫助？請只補新的重點。`,
      items: buildKnowledgeItems(),
      checkpoint,
    });
    tokenSeries.push(prompt.governance.finalTokens);
    stages.push(prompt.governance.stage);
  }

  const checkpoint = await getWorkflowCheckpoint(workflowKey);
  assert.ok(checkpoint);
  assert.ok(checkpoint.completed.length <= 8);
  assert.ok(tokenSeries.at(-1) <= tokenSeries[0] + 220);
  assert.ok(Math.max(...tokenSeries) <= 900);
  assert.equal(stages.includes("emergency"), false);
});

test("rewrite prompt stays bounded across many comment rounds", async () => {
  const workflowKey = "doc-rewrite:doccn-long-governance";
  const tokenSeries = [];
  const stages = [];
  const document = buildRewriteDocument();

  for (let round = 1; round <= 8; round += 1) {
    await updateWorkflowCheckpoint(workflowKey, {
      goal: "持續修訂同一份長文件，避免每輪都重放全文。",
      completed: [`第 ${round} 輪已整理部分評論要求`],
      pending: [`第 ${round + 1} 輪仍需補上未完成段落`],
      constraints: ["保留原本結構", "不要加入不存在的事實"],
      facts: [`文件標題：${document.title}`, `當前 round=${round}`],
      risks: ["replace 寫回仍受 Lark API 限制"],
      meta: { round },
    });
    const checkpoint = await getWorkflowCheckpoint(workflowKey);
    const prompt = buildRewritePromptInput(document, buildRewriteComments(round), checkpoint);
    tokenSeries.push(prompt.governance.finalTokens);
    stages.push(prompt.governance.stage);
  }

  const checkpoint = await getWorkflowCheckpoint(workflowKey);
  assert.ok(checkpoint);
  assert.ok(checkpoint.completed.length <= 8);
  assert.ok(tokenSeries.at(-1) <= tokenSeries[0] + 260);
  assert.ok(Math.max(...tokenSeries) <= 1700);
  assert.equal(stages.includes("emergency"), false);
});
