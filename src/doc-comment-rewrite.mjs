import {
  agentPromptEmergencyRatio,
  agentPromptLightRatio,
  agentPromptRollingRatio,
  docRewriteCommentMaxChars,
  docRewriteDocumentMaxChars,
  docRewritePromptMaxTokens,
  llmApiKey,
  llmBaseUrl,
  llmModel,
  llmTemperature,
  llmTopP,
} from "./config.mjs";
import {
  buildCheckpointSummary,
  buildCompactSystemPrompt,
  compactListItems,
  governPromptSections,
  trimTextForBudget,
} from "./agent-token-governance.mjs";
import { getWorkflowCheckpoint, updateWorkflowCheckpoint } from "./agent-workflow-state.mjs";
import { getDocument, listDocumentComments, resolveDocumentComment, updateDocument } from "./lark-content.mjs";

function normalizeText(value) {
  return String(value || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

async function collectDocumentComments(accessToken, documentId, { includeSolved = false } = {}) {
  const items = [];
  let pageToken = undefined;

  while (true) {
    const page = await listDocumentComments(accessToken, documentId, {
      fileType: "docx",
      isSolved: includeSolved ? undefined : false,
      pageToken,
    });
    items.push(...page.items);
    if (!page.has_more || !page.page_token) {
      break;
    }
    pageToken = page.page_token;
  }

  return items;
}

function summarizeComments(comments) {
  return comments.map((comment, index) => {
    const replies = comment.replies
      .map((reply) =>
        [
          `  - 回覆：${reply.text || "(空回覆)"}`,
          Array.isArray(reply.images) && reply.images.length ? `    附圖：${reply.images.length} 張` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      )
      .join("\n");
    return [
      `${index + 1}. comment_id=${comment.comment_id || "unknown"}`,
      `   引用內容：${comment.quote || "(沒有引用文字)"}`,
      `   評論內容：${comment.latest_reply_text || "(沒有評論文字)"}`,
      Array.isArray(comment.replies) && comment.replies.some((reply) => Array.isArray(reply.images) && reply.images.length)
        ? `   評論附圖：${comment.replies.reduce((sum, reply) => sum + (Array.isArray(reply.images) ? reply.images.length : 0), 0)} 張`
        : "",
      replies,
    ]
      .filter(Boolean)
      .join("\n");
  });
}

function extractDocumentStructure(content) {
  const lines = normalizeText(content).split("\n");
  const headings = lines.filter((line) => /^#{1,6}\s/.test(line)).slice(0, 12);
  return headings.length ? headings : lines.slice(0, 12);
}

function compareDocumentStructure(originalContent, rewrittenContent) {
  const original = extractDocumentStructure(originalContent);
  const rewritten = extractDocumentStructure(rewrittenContent);
  if (!original.length) {
    return true;
  }
  if (rewritten.length < original.length) {
    return false;
  }
  return original.every((line, index) => normalizeText(rewritten[index]) === normalizeText(line));
}

function collectFocusedExcerpts(content, comments = []) {
  const paragraphs = splitParagraphs(content);
  if (!paragraphs.length) {
    return [];
  }

  const hints = comments
    .flatMap((comment) => [comment.quote, comment.latest_reply_text, ...(comment.replies || []).map((reply) => reply.text)])
    .map((item) => normalizeText(item))
    .filter(Boolean);

  const selected = [];
  for (const hint of hints) {
    const matchIndex = paragraphs.findIndex((paragraph) => paragraph.includes(hint) || hint.includes(paragraph.slice(0, 24)));
    if (matchIndex === -1) {
      continue;
    }
    const window = paragraphs.slice(Math.max(0, matchIndex - 1), Math.min(paragraphs.length, matchIndex + 2));
    selected.push(...window);
  }

  if (!selected.length) {
    selected.push(...paragraphs.slice(0, 6));
  }

  return compactListItems(selected, { maxItems: 8, maxItemChars: 280 });
}

export function buildRewritePromptInput(document, comments, checkpoint = null) {
  const structureSummary = extractDocumentStructure(document.content || "");
  const focusedExcerpts = collectFocusedExcerpts(document.content || "", comments);
  const commentSummary = compactListItems(summarizeComments(comments), {
    maxItems: 8,
    maxItemChars: 260,
  });
  const systemPrompt = buildCompactSystemPrompt("你是文件編修助手。", [
    "根據評論修正文檔，保留原本語言與結構。",
    "不要輸出 JSON、表格或程式碼框。",
  ]);
  const governed = governPromptSections({
    systemPrompt,
    format: "xml",
    maxTokens: docRewritePromptMaxTokens,
    thresholds: {
      light: agentPromptLightRatio,
      rolling: agentPromptRollingRatio,
      emergency: agentPromptEmergencyRatio,
    },
    sections: [
      {
        name: "task_goal",
        label: "task_goal",
        text:
          "輸出兩段：<<SUMMARY>> 列 1 到 6 條修改重點；<<CONTENT>> 輸出完整修訂後 Markdown。已進入 checkpoint 的舊資訊不要重複展開。若評論要求的事實無法從文檔或評論證明，保留原文並在摘要中標示待確認。",
        required: true,
        maxTokens: 110,
      },
      {
        name: "task_checkpoint",
        label: "task_checkpoint",
        text: checkpoint ? buildCheckpointSummary(checkpoint, { maxChars: 720 }) : "",
        summaryText: checkpoint ? buildCheckpointSummary(checkpoint, { maxChars: 420 }) : "",
        maxTokens: 180,
      },
      {
        name: "document_structure",
        label: "document_structure",
        text: structureSummary.join("\n"),
        summaryText: structureSummary.slice(0, 6).join("\n"),
        required: true,
        maxTokens: 180,
      },
      {
        name: "focused_document_excerpts",
        label: "focused_document_excerpts",
        text: focusedExcerpts.join("\n\n"),
        summaryText: focusedExcerpts.slice(0, 4).join("\n\n"),
        required: true,
        maxTokens: Math.ceil(docRewriteDocumentMaxChars / 4),
      },
      {
        name: "comment_summary",
        label: "comment_summary",
        text: commentSummary.join("\n\n"),
        summaryText: commentSummary.slice(0, 4).join("\n\n"),
        required: true,
        maxTokens: Math.ceil(docRewriteCommentMaxChars / 4),
      },
      {
        name: "full_document_fallback",
        label: "full_document_fallback",
        text: trimTextForBudget(document.content, docRewriteDocumentMaxChars),
        summaryText: trimTextForBudget(document.content, Math.floor(docRewriteDocumentMaxChars * 0.45)),
        maxTokens: Math.ceil(docRewriteDocumentMaxChars / 4),
      },
    ],
  });

  return {
    systemPrompt,
    prompt: governed.prompt,
    governance: governed,
  };
}

function parseRewriteResponse(text) {
  const normalized = String(text || "").trim();
  const summaryMarker = "<<SUMMARY>>";
  const contentMarker = "<<CONTENT>>";
  const summaryStart = normalized.indexOf(summaryMarker);
  const contentStart = normalized.indexOf(contentMarker);

  if (summaryStart === -1 || contentStart === -1 || contentStart <= summaryStart) {
    throw new Error("invalid_rewrite_response_format");
  }

  const summaryText = normalized
    .slice(summaryStart + summaryMarker.length, contentStart)
    .trim();
  const content = normalized.slice(contentStart + contentMarker.length).trim();
  const summary = summaryText
    .split("\n")
    .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
    .filter(Boolean);

  if (!content) {
    throw new Error("missing_rewritten_document_content");
  }

  return {
    summary,
    content,
  };
}

function splitParagraphs(content) {
  return normalizeText(content)
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildParagraphPatchPlan(originalContent, rewrittenContent) {
  const original = splitParagraphs(originalContent);
  const rewritten = splitParagraphs(rewrittenContent);
  let prefix = 0;
  while (prefix < original.length && prefix < rewritten.length && original[prefix] === rewritten[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < (original.length - prefix) &&
    suffix < (rewritten.length - prefix) &&
    original[original.length - 1 - suffix] === rewritten[rewritten.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const originalChanged = original.slice(prefix, original.length - suffix);
  const rewrittenChanged = rewritten.slice(prefix, rewritten.length - suffix);
  if (!originalChanged.length && !rewrittenChanged.length) {
    return [];
  }

  const patchType = !originalChanged.length
    ? "insert"
    : !rewrittenChanged.length
      ? "delete"
      : "replace";

  return [
    {
      patch_type: patchType,
      start_index: prefix,
      end_index: original.length - suffix,
      before: originalChanged,
      after: rewrittenChanged,
    },
  ];
}

function applyParagraphPatchPlan(originalContent, patchPlan = []) {
  const paragraphs = splitParagraphs(originalContent);
  if (!Array.isArray(patchPlan) || !patchPlan.length) {
    return normalizeText(originalContent);
  }

  const [patch] = patchPlan;
  const before = paragraphs.slice(0, patch.start_index);
  const after = paragraphs.slice(patch.end_index);
  return [...before, ...(patch.after || []), ...after].join("\n\n").trim();
}

export function buildDocRewriteStructuredResult({
  originalContent = "",
  rewrittenContent = "",
  patchPlan = [],
  changeSummary = [],
  applied = false,
  documentId = "",
  title = "",
  updateResult = null,
} = {}) {
  return {
    document_id: documentId || "",
    title: title || "",
    change_summary: Array.isArray(changeSummary) ? changeSummary : [],
    patch_plan: Array.isArray(patchPlan) ? patchPlan : [],
    before_excerpt: splitParagraphs(originalContent).slice(0, 3),
    after_excerpt: splitParagraphs(rewrittenContent).slice(0, 3),
    structure_preserved: compareDocumentStructure(originalContent, rewrittenContent),
    applied: applied === true,
    update_result: updateResult || null,
  };
}

async function rewriteWithModel(document, comments, checkpoint = null) {
  if (!llmApiKey) {
    throw new Error("missing_llm_api_key_for_comment_rewrite");
  }

  const promptInput = buildRewritePromptInput(document, comments, checkpoint);

  const response = await fetch(`${llmBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${llmApiKey}`,
    },
    body: JSON.stringify({
      model: llmModel,
      temperature: llmTemperature,
      top_p: llmTopP,
      messages: [
        {
          role: "system",
          content: promptInput.systemPrompt,
        },
        {
          role: "user",
          content: `document_title:\n${document.title || document.document_id}\n\n${promptInput.prompt}`,
        },
      ],
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || `comment_rewrite_llm_failed:${response.status}`);
  }

  return {
    ...parseRewriteResponse(data.choices?.[0]?.message?.content || ""),
    context_governance: promptInput.governance,
  };
}

export async function rewriteDocumentFromComments(
  accessToken,
  documentId,
  {
    includeSolved = false,
    commentIds = [],
    apply = false,
    resolveComments = false,
  } = {},
) {
  const document = await getDocument(accessToken, documentId);
  const workflowStateKey = `doc-rewrite:${documentId}`;
  const checkpoint = await getWorkflowCheckpoint(workflowStateKey);
  const allComments = await collectDocumentComments(accessToken, documentId, { includeSolved });
  const selectedComments = Array.isArray(commentIds) && commentIds.length
    ? allComments.filter((item) => commentIds.includes(item.comment_id))
    : allComments;

  if (!selectedComments.length) {
    return {
      ok: true,
      document_id: document.document_id,
      title: document.title,
      comment_count: 0,
      applied: false,
      message: "目前沒有可處理的文檔評論。",
    };
  }

  const rewritten = await rewriteWithModel(document, selectedComments, checkpoint);
  const patchPlan = buildParagraphPatchPlan(document.content, rewritten.content);
  const patchedContent = applyParagraphPatchPlan(document.content, patchPlan);
  let updateResult = null;
  let resolvedComments = [];

  if (apply) {
    throw new Error("internal_direct_apply_disabled_use_http_apply_route");
  }

  await updateWorkflowCheckpoint(workflowStateKey, {
    goal: `依據文檔評論持續修訂「${document.title || document.document_id}」`,
    completed: [
      `已處理 ${selectedComments.length} 則評論並生成修訂預覽`,
      ...(apply ? ["已將修訂寫回 Lark 文件"] : []),
    ],
    pending: apply ? [] : ["尚未將預覽正式寫回文件"],
    constraints: [
      "保留原本語言與結構",
      "不可加入文件與評論中不存在的事實",
      "已進入 checkpoint 的舊內容不要再全文重放",
    ],
    facts: [
      `文件標題：${document.title || document.document_id}`,
      `最近一次處理評論數：${selectedComments.length}`,
      ...extractDocumentStructure(document.content || "").slice(0, 4),
    ],
    risks: apply ? [] : ["Lark doc API 最終仍是 replace-based materialization"],
    meta: {
      document_title: document.title || document.document_id,
      last_comment_count: selectedComments.length,
      last_governance_stage: rewritten.context_governance?.stage || "normal",
    },
  });

  const structuredResult = buildDocRewriteStructuredResult({
    originalContent: document.content,
    rewrittenContent: patchedContent,
    patchPlan,
    changeSummary: rewritten.summary,
    applied: Boolean(apply),
    documentId: document.document_id,
    title: document.title,
    updateResult,
  });

  return {
    ok: true,
    document_id: document.document_id,
    title: document.title,
    document_url: document.url,
    comment_count: selectedComments.length,
    comment_ids: selectedComments.map((item) => item.comment_id).filter(Boolean),
    comments: selectedComments,
    applied: Boolean(apply),
    resolve_comments: Boolean(resolveComments && apply),
    change_summary: rewritten.summary,
    patch_plan: patchPlan,
    revised_content: patchedContent,
    structured_result: structuredResult,
    workflow_state: apply ? "applying" : "awaiting_review",
    context_governance: rewritten.context_governance || null,
    update_result: updateResult,
    resolved_comment_ids: resolvedComments.map((item) => item.comment_id),
  };
}

export async function applyRewrittenDocument(
  accessToken,
  documentId,
  rewrittenContent,
  { resolveCommentIds = [], patchPlan = [] } = {},
) {
  const currentDocument = await getDocument(accessToken, documentId);
  const nextContent = patchPlan.length
    ? applyParagraphPatchPlan(currentDocument.content, patchPlan)
    : rewrittenContent;
  const updateResult = await updateDocument(accessToken, documentId, nextContent, "replace");
  const resolvedComments = await Promise.all(
    (Array.isArray(resolveCommentIds) ? resolveCommentIds : [])
      .filter(Boolean)
      .map((commentId) => resolveDocumentComment(accessToken, documentId, commentId, true, "docx")),
  );

  const structuredResult = buildDocRewriteStructuredResult({
    originalContent: currentDocument.content,
    rewrittenContent: nextContent,
    patchPlan,
    changeSummary: [],
    applied: true,
    documentId,
    title: currentDocument.title,
    updateResult,
  });

  return {
    update_result: updateResult,
    applied_patch_count: Array.isArray(patchPlan) ? patchPlan.length : 0,
    resolved_comment_ids: resolvedComments.map((item) => item.comment_id),
    structured_result: structuredResult,
    workflow_state: "applying",
  };
}
