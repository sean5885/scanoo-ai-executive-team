import http from "node:http";
import process from "node:process";
import {
  httpRequestTimeoutMs,
  oauthBaseUrl,
  oauthCallbackPath,
  oauthPort,
  searchTopK,
} from "./config.mjs";
import { installMemoryWriteDetector } from "./memory-write-detector.mjs";
import {
  ingestLearningDocAction,
  updateLearningStateAction,
} from "./company-brain-learning.mjs";
import {
  listDocumentCommentsFromRuntime,
  readDocumentFromRuntime,
  runRead,
} from "./read-runtime.mjs";
import { resolveLarkBindingRuntime } from "./binding-runtime.mjs";
import {
  buildAuthorizeUrl,
  buildOAuthState,
  exchangeCodeForUserToken,
  getStoredAccountContext,
  getStoredUserToken,
  getValidUserTokenState,
  getUserProfile,
} from "./lark-user-auth.mjs";
import { isOAuthReauthRequiredError } from "./lark-request-auth.mjs";
import {
  getDocumentByDocumentId,
  getDocumentByExternalKey,
  listDocumentsByStatus,
  runRepositoryTransaction,
  summarizeDocumentLifecycle,
  upsertCompanyBrainDoc,
  upsertDocument,
  upsertSource,
} from "./rag-repository.mjs";
import {
  bulkUpsertBitableRecords,
  checkDriveTask,
  createBitableApp,
  createBitableRecord,
  createBitableTable,
  createCalendarEvent,
  createDocument,
  createDriveFolder,
  createMessageReaction,
  createSpreadsheet,
  createTask,
  createTaskComment,
  deleteBitableRecord,
  deleteDriveItem,
  deleteMessageReaction,
  deleteTaskComment,
  getMessage,
  getPrimaryCalendar,
  getBitableApp,
  getBitableRecord,
  getSpreadsheet,
  getSpreadsheetSheet,
  getTask,
  getTaskComment,
  listDriveFolder,
  listDriveRoot,
  listCalendarEvents,
  listBitableRecords,
  listBitableTables,
  listFreebusy,
  listMessages,
  listMessageReactions,
  listSpreadsheetSheets,
  listTasks,
  listTaskComments,
  moveDriveItem,
  replyMessage,
  replaceSpreadsheetCells,
  replaceSpreadsheetCellsBatch,
  resolveDocumentComment,
  resolveDriveRootFolderToken,
  searchCalendarEvents,
  searchBitableRecords,
  searchMessages,
  createWikiNode,
  listWikiSpaceNodes,
  listWikiSpaces,
  moveWikiNode,
  ensureDocumentManagerPermission,
  updateBitableApp,
  updateBitableRecord,
  updateDocument,
  updateSpreadsheet,
  updateTaskComment,
} from "./lark-content.mjs";
import { searchKnowledgeBase } from "./answer-service.mjs";
import {
  applyApprovedCompanyBrainKnowledgeAction,
  approvalTransitionCompanyBrainDocAction,
  checkCompanyBrainConflictAction,
  getCompanyBrainApprovalState,
  reviewCompanyBrainDocAction,
} from "./company-brain-review.mjs";
import {
  applyRewrittenDocument,
  rewriteDocumentFromComments,
  rollbackRewrittenDocument,
} from "./doc-comment-rewrite.mjs";
import {
  executePlannedUserInput,
} from "./executive-planner.mjs";
import {
  normalizeExplicitUserAuthContext,
  readExplicitUserAuthContextFromRequest,
  requestRequiresExplicitUserAuth,
} from "./explicit-user-auth.mjs";
import { applyHeadingTargetedInsert, DocumentTargetingError } from "./doc-targeting.mjs";
import { listUnseenDocumentComments, markDocumentCommentsSeen } from "./comment-watch-store.mjs";
import { generateDocumentCommentSuggestionCard } from "./comment-suggestion-workflow.mjs";
import { runCommentSuggestionPollOnce } from "./comment-suggestion-poller.mjs";
import {
  buildDocumentRewriteTaskMeta,
  buildDocumentRewriteWorkflowScope,
  loadDocumentCommentRewriteApplyState,
  prepareDocumentCommentRewritePreview,
} from "./comment-doc-workflow.mjs";
import { buildCloudDocStructuredResult, buildCloudDocWorkflowScopeKey } from "./cloud-doc-organization-workflow.mjs";
import {
  consumeCommentRewriteConfirmation,
  consumeDocumentReplaceConfirmation,
  consumeMeetingWriteConfirmation,
  createDocumentReplaceConfirmation,
  createMeetingWriteConfirmation,
  peekCommentRewriteConfirmation,
  peekDocumentReplaceConfirmation,
  peekMeetingWriteConfirmation,
} from "./doc-update-confirmations.mjs";
import {
  executeSecureAction,
  finishSecureTask,
  getSecurityStatus,
  listPendingApprovals,
  resolvePendingApproval,
  rollbackSecureTask,
  startSecureTask,
} from "./lobster-security-bridge.mjs";
import {
  applyImprovementWorkflowProposal,
  getImprovementWorkflowProposal,
  listImprovementWorkflowProposals,
  resolveImprovementWorkflowProposal,
} from "./executive-improvement-workflow.mjs";
import {
  assertLarkWriteAllowed,
  validateDocumentCreateEntryGovernance,
} from "./lark-write-guard.mjs";
import {
  buildCreateDocWritePolicy,
} from "./write-policy-contract.mjs";
import {
  buildAgentLearningSummary,
  generateLearningLoopImprovementProposals,
} from "./agent-learning-loop.mjs";
import {
  buildCompanyBrainApprovalTransitionCanonicalRequest,
  buildCompanyBrainApplyCanonicalRequest,
  buildCompanyBrainConflictCanonicalRequest,
  buildCompanyBrainReviewCanonicalRequest,
  buildDocumentCommentRewriteApplyCanonicalRequest,
  buildDriveOrganizeApplyCanonicalRequest,
  buildIngestCompanyBrainDocCanonicalRequest,
  buildIngestLearningDocCanonicalRequest,
  buildUpdateLearningStateCanonicalRequest,
  buildMeetingConfirmWriteCanonicalRequest,
  buildUpdateDocCanonicalRequest,
  buildWikiOrganizeApplyCanonicalRequest,
} from "./mutation-admission.mjs";
import {
  ensureCloudDocWorkflowTask,
  finalizeDocRewriteWorkflowTask,
  finalizeCloudDocWorkflowTask,
  markCloudDocApplying,
  markDocRewriteApplying,
} from "./executive-orchestrator.mjs";
import { runSync } from "./lark-sync-service.mjs";
import { applyDriveOrganization, previewDriveOrganization } from "./lark-drive-organizer.mjs";
import { applyWikiOrganization, previewWikiOrganization } from "./lark-wiki-organizer.mjs";
import { getAllowedMethodsForPath } from "./http-route-contracts.mjs";
import { listResolvedSessions } from "./session-scope-store.mjs";
import { createMeetingCoordinator } from "./meeting-agent.mjs";
import { cleanText, extractDocumentId } from "./message-intent-utils.mjs";
import {
  executeCanonicalLarkMutation,
  runDocumentCreateMutation,
  runCanonicalLarkMutation,
} from "./lark-mutation-runtime.mjs";
import { runMutation } from "./mutation-runtime.mjs";
import {
  buildHttpIdempotencyScopeKey,
  getHttpIdempotencyRecord,
  storeHttpIdempotencyRecord,
} from "./http-idempotency-store.mjs";
import { normalizeText, nowIso } from "./text-utils.mjs";
import { createRequestId, createRuntimeLogger, createTraceId, emitRateLimitedAlert } from "./runtime-observability.mjs";
import { getDbPath } from "./db.mjs";
import {
  getMonitoringDashboard,
  getLatestError,
  getRequestMetrics,
  listRecentErrors,
  listRecentRequests,
  recordHttpRequest,
  sanitizeTracePayload,
} from "./monitoring-store.mjs";
import { normalizeUserResponse } from "./user-response-normalizer.mjs";
import { runPlannerUserInputEdge } from "./planner-user-input-edge.mjs";
import db from "./db.mjs";
import { buildExecutionEnvelope } from "./execution-envelope.mjs";
import { withLarkWriteExecutionContext } from "./execute-lark-write.mjs";

installMemoryWriteDetector();

const pendingOauthStates = new Map();
const meetingCoordinator = createMeetingCoordinator({
  createConfirmation: createMeetingWriteConfirmation,
  peekConfirmation: peekMeetingWriteConfirmation,
  consumeConfirmation: consumeMeetingWriteConfirmation,
});
let activeHttpServiceOverrides = {};
const serviceStartTime = nowIso();
const inFlightIdempotentRequests = new Map();
const REQUEST_CANCELLED_STATUS_CODE = 499;
const SYNTHETIC_REQUEST_USER_AGENT_PATTERN = /\b(node(?:\.js)?|undici|jest|vitest|mocha|tap|ava|playwright|cypress|postman|insomnia|curl|wget)\b/i;

function emitOauthReauthAlert({ accountId = null, scope = "http", pathname = null, reason = null } = {}) {
  emitRateLimitedAlert({
    code: "oauth_reauth_required",
    scope,
    dedupeKey: `oauth_reauth_required:${accountId || "unknown_account"}`,
    message: "Stored OAuth token requires reauthorization before the request can continue.",
    details: {
      account_id: accountId || null,
      pathname: pathname || null,
      reason: reason || null,
    },
  });
}

function setActiveHttpServiceOverrides(overrides = {}) {
  activeHttpServiceOverrides = overrides && typeof overrides === "object" ? overrides : {};
}

function getHttpService(name, fallback) {
  const override = activeHttpServiceOverrides?.[name];
  return typeof override === "function" ? override : fallback;
}

function cleanupOauthStates() {
  const cutoff = Date.now() - 10 * 60 * 1000;

  for (const [state, createdAt] of pendingOauthStates.entries()) {
    if (createdAt < cutoff) {
      pendingOauthStates.delete(state);
    }
  }
}

function withTracePayload(res, payload) {
  if (!payload || Array.isArray(payload) || typeof payload !== "object") {
    return payload;
  }
  const normalizedPayload = payload.__hide_trace_id === true
    ? Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "__hide_trace_id"))
    : payload;
  if (res?.__trace_id && normalizedPayload.trace_id == null && payload.__hide_trace_id !== true) {
    return {
      ...normalizedPayload,
      trace_id: res.__trace_id,
    };
  }
  return normalizedPayload;
}

function captureResponsePayload(res, payload) {
  const tracedPayload = withTracePayload(res, payload);
  if (res) {
    res.__monitor_payload = tracedPayload;
  }
  return tracedPayload;
}

function canWriteResponse(res) {
  return Boolean(res) && res.writableEnded !== true && res.destroyed !== true;
}

function jsonResponse(res, statusCode, payload) {
  if (!canWriteResponse(res)) {
    captureResponsePayload(res, payload);
    if (res && Number.isFinite(Number(statusCode))) {
      res.statusCode = Number(statusCode);
    }
    return false;
  }
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(`${JSON.stringify(captureResponsePayload(res, payload), null, 2)}\n`);
  return true;
}

function htmlResponse(res, statusCode, html) {
  res.__monitor_payload = null;
  if (!canWriteResponse(res)) {
    if (res && Number.isFinite(Number(statusCode))) {
      res.statusCode = Number(statusCode);
    }
    return false;
  }
  res.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
  });
  res.end(html);
  return true;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function formatMonitoringRate(percent, count, total) {
  return `${Number(percent || 0).toFixed(2)}% (${Number(count || 0)}/${Number(total || 0)})`;
}

function formatMonitoringOutcome(item = {}) {
  return item.error_code || item.status_code || "unknown";
}

function renderMonitoringTableRows(items = []) {
  if (!items.length) {
    return `
      <tr>
        <td colspan="6" class="monitoring-empty">No entries yet.</td>
      </tr>
    `;
  }

  return items.map((item) => `
    <tr>
      <td>${escapeHtml(item.finished_at || item.started_at || "-")}</td>
      <td>${escapeHtml(item.method || "-")}</td>
      <td>${escapeHtml(item.pathname || "-")}</td>
      <td>${escapeHtml(item.route_name || "-")}</td>
      <td>${escapeHtml(formatMonitoringOutcome(item))}</td>
      <td>${escapeHtml(`${Number(item.duration_ms || 0)}ms`)}</td>
    </tr>
  `).join("");
}

function renderMonitoringDashboardPage({ dashboard, traceId = null } = {}) {
  const metrics = dashboard?.metrics || {};
  const latestError = dashboard?.latest_error || null;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Lobster Monitoring Dashboard</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f1e8;
      --panel: rgba(255, 252, 247, 0.88);
      --ink: #1f2a2a;
      --muted: #59676a;
      --line: rgba(31, 42, 42, 0.12);
      --accent: #0f766e;
      --danger: #b42318;
      --shadow: 0 18px 48px rgba(31, 42, 42, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(15, 118, 110, 0.18), transparent 32%),
        radial-gradient(circle at top right, rgba(180, 35, 24, 0.14), transparent 28%),
        linear-gradient(180deg, #f8f4ec 0%, var(--bg) 100%);
      min-height: 100vh;
    }
    main {
      max-width: 1200px;
      margin: 0 auto;
      padding: 40px 20px 56px;
    }
    .monitoring-header {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      align-items: flex-end;
      justify-content: space-between;
      margin-bottom: 24px;
    }
    .monitoring-title {
      margin: 0;
      font-size: clamp(2rem, 5vw, 3.75rem);
      line-height: 0.95;
      letter-spacing: -0.04em;
    }
    .monitoring-subtitle,
    .monitoring-meta,
    .monitoring-links {
      margin: 0;
      color: var(--muted);
    }
    .monitoring-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .monitoring-card,
    .monitoring-panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 20px;
      box-shadow: var(--shadow);
      backdrop-filter: blur(8px);
    }
    .monitoring-card {
      padding: 20px;
    }
    .monitoring-card h2,
    .monitoring-panel h2 {
      margin: 0 0 10px;
      font-size: 0.95rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--muted);
    }
    .monitoring-value {
      margin: 0;
      font-size: clamp(2rem, 6vw, 3rem);
      line-height: 1;
    }
    .monitoring-caption {
      margin: 8px 0 0;
      color: var(--muted);
      font-size: 0.95rem;
    }
    .monitoring-panels {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 16px;
    }
    .monitoring-panel {
      overflow: hidden;
    }
    .monitoring-panel-header {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: baseline;
      padding: 20px 20px 0;
    }
    .monitoring-panel-body {
      padding: 0 20px 20px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.95rem;
    }
    th, td {
      padding: 10px 0;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
    }
    th {
      color: var(--muted);
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    tbody tr:last-child td {
      border-bottom: none;
    }
    .monitoring-empty {
      color: var(--muted);
      padding: 18px 0;
    }
    .monitoring-alert {
      margin: 0 0 24px;
      padding: 16px 18px;
      border-radius: 18px;
      background: rgba(180, 35, 24, 0.08);
      border: 1px solid rgba(180, 35, 24, 0.18);
    }
    .monitoring-alert strong {
      color: var(--danger);
    }
    a {
      color: var(--accent);
      text-decoration: none;
    }
    a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <main>
    <section class="monitoring-header">
      <div>
        <p class="monitoring-subtitle">Playground Runtime</p>
        <h1 class="monitoring-title">Monitoring Dashboard</h1>
      </div>
      <div>
        <p class="monitoring-meta">Generated: ${escapeHtml(dashboard?.generated_at || "-")}</p>
        <p class="monitoring-meta">Trace ID: ${escapeHtml(traceId || "-")}</p>
        <p class="monitoring-links"><a href="/api/monitoring/metrics">Metrics JSON</a> · <a href="/api/monitoring/requests">Requests JSON</a> · <a href="/api/monitoring/errors">Errors JSON</a></p>
      </div>
    </section>
    ${latestError ? `
      <section class="monitoring-alert">
        <strong>Latest error:</strong>
        ${escapeHtml(latestError.pathname || "-")}
        (${escapeHtml(latestError.error_code || String(latestError.status_code || "unknown"))})
      </section>
    ` : ""}
    <section class="monitoring-grid">
      <article class="monitoring-card">
        <h2>Success Rate</h2>
        <p class="monitoring-value">${escapeHtml(`${Number(metrics.success_rate_percent || 0).toFixed(2)}%`)}</p>
        <p class="monitoring-caption">${escapeHtml(formatMonitoringRate(metrics.success_rate_percent, metrics.success_count, metrics.total_requests))}</p>
      </article>
      <article class="monitoring-card">
        <h2>Error Rate</h2>
        <p class="monitoring-value">${escapeHtml(`${Number(metrics.error_rate_percent || 0).toFixed(2)}%`)}</p>
        <p class="monitoring-caption">${escapeHtml(formatMonitoringRate(metrics.error_rate_percent, metrics.error_count, metrics.total_requests))}</p>
      </article>
      <article class="monitoring-card">
        <h2>Total Requests</h2>
        <p class="monitoring-value">${escapeHtml(String(metrics.total_requests || 0))}</p>
        <p class="monitoring-caption">Persisted HTTP requests in local monitoring storage.</p>
      </article>
    </section>
    <section class="monitoring-panels">
      <article class="monitoring-panel">
        <div class="monitoring-panel-header">
          <h2>Recent Errors</h2>
          <p class="monitoring-meta">Last ${escapeHtml(String(dashboard?.error_limit || 0))}</p>
        </div>
        <div class="monitoring-panel-body">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Method</th>
                <th>Path</th>
                <th>Route</th>
                <th>Error</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>${renderMonitoringTableRows(dashboard?.recent_errors || [])}</tbody>
          </table>
        </div>
      </article>
      <article class="monitoring-panel">
        <div class="monitoring-panel-header">
          <h2>Recent Requests</h2>
          <p class="monitoring-meta">Last ${escapeHtml(String(dashboard?.request_limit || 0))}</p>
        </div>
        <div class="monitoring-panel-body">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Method</th>
                <th>Path</th>
                <th>Route</th>
                <th>Status</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>${renderMonitoringTableRows(dashboard?.recent_requests || [])}</tbody>
          </table>
        </div>
      </article>
    </section>
  </main>
</body>
</html>`;
}

function methodNotAllowed(res, allowedMethods) {
  const payload = captureResponsePayload(res, {
    ok: false,
    error: "method_not_allowed",
    allowed_methods: allowedMethods,
  });
  if (!canWriteResponse(res)) {
    if (res) {
      res.statusCode = 405;
    }
    return false;
  }
  res.writeHead(405, {
    "Content-Type": "application/json; charset=utf-8",
    Allow: allowedMethods.join(", "),
  });
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
  return true;
}

const noopHttpLogger = {
  info() {},
  warn() {},
  error() {},
  compactError(error) {
    if (!error) {
      return null;
    }
    if (error instanceof Error) {
      return {
        name: error.name || "Error",
        message: error.message || "unknown_error",
      };
    }
    return {
      message: typeof error === "string" ? error : String(error),
    };
  },
  child() {
    return this;
  },
};

function extractHttpPlatformError(error) {
  const raw = error?.response?.data || null;
  return {
    http_status: Number.isFinite(Number(error?.response?.status)) ? Number(error.response.status) : null,
    platform_code: Number.isFinite(Number(raw?.code)) ? Number(raw.code) : null,
    platform_msg: raw?.msg || raw?.message || String(error?.message || "unknown_error"),
    log_id: raw?.log_id || raw?.error?.log_id || null,
    raw: raw || null,
  };
}

function buildApiDocumentMetadata({
  account,
  documentId = null,
  title = null,
  folderToken = null,
  createdAt = null,
} = {}) {
  return {
    doc_id: documentId || null,
    source: "api",
    created_at: createdAt || null,
    creator: {
      account_id: account?.id || null,
      open_id: account?.open_id || null,
    },
    title: title || null,
    folder_token: folderToken || null,
  };
}

function buildDocumentLifecycleView(row) {
  return {
    doc_id: row?.document_id || null,
    external_key: row?.external_key || null,
    status: row?.status || null,
    failure_reason: row?.failure_reason || null,
    indexed_at: row?.indexed_at || null,
    verified_at: row?.verified_at || null,
    created_at: row?.created_at || null,
    updated_at: row?.updated_at || null,
  };
}

function buildCompanyBrainPayload(row, metadata) {
  return {
    doc_id: row?.document_id || metadata?.doc_id || null,
    title: row?.title || metadata?.title || null,
    source: metadata?.source || "api",
    created_at: metadata?.created_at || row?.created_at || null,
    creator: metadata?.creator || {
      account_id: null,
      open_id: null,
    },
  };
}

function buildCompanyBrainDocView(row) {
  let creator = {
    account_id: null,
    open_id: null,
  };
  try {
    const parsed = row?.creator && typeof row.creator === "object"
      ? row.creator
      : row?.creator_json
        ? JSON.parse(row.creator_json)
        : null;
    if (parsed && typeof parsed === "object") {
      creator = {
        account_id: parsed.account_id || null,
        open_id: parsed.open_id || null,
      };
    }
  } catch {
    creator = {
      account_id: null,
      open_id: null,
    };
  }

  return {
    doc_id: row?.doc_id || null,
    title: row?.title || null,
    source: row?.source || null,
    created_at: row?.created_at || null,
    creator,
  };
}

function parseCompanyBrainLimit(requestUrl, body, fallback = 50) {
  const limitRaw = Number.parseInt(
    String(
      requestUrl.searchParams.get("top_k")
      || body.top_k
      || requestUrl.searchParams.get("limit")
      || body.limit
      || String(fallback)
    ).trim(),
    10,
  );
  return Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : fallback;
}

function parseCompanyBrainDocId(requestUrl, body) {
  return String(
    requestUrl.pathname.match(/^\/(?:api|agent)\/company-brain\/(?:approved\/)?docs\/([^/]+)(?:\/apply)?$/)?.[1]
    || body.doc_id
    || ""
  ).trim();
}

function parseCompanyBrainSearchQuery(requestUrl, body) {
  return String(requestUrl.searchParams.get("q") || body.q || "").trim();
}

// ---------------------------------------------------------------------------
// Company-brain conflict-evidence read helpers
// ---------------------------------------------------------------------------

function logCompanyBrainReadEvent(logger, stage, fields = {}) {
  logger.info(`document_${stage}`, {
    stage,
    ...fields,
  });
}

function logCompanyBrainCollectionRead(logger, stage, { accountId, limit = null, q = null, total = 0 }) {
  logCompanyBrainReadEvent(logger, stage, {
    account_id: accountId,
    ...(limit == null ? {} : { limit }),
    ...(q == null ? {} : { q }),
    total,
  });
}

function logCompanyBrainDetailRead(logger, { accountId, docId, found }) {
  logCompanyBrainReadEvent(logger, "company_brain_detail", {
    account_id: accountId,
    doc_id: docId,
    found,
  });
}

function resolveExplicitPlannerAuthContext(res, requestUrl, body) {
  const headerAuth = readExplicitUserAuthContextFromRequest(res?.__request_headers || null);
  return normalizeExplicitUserAuthContext({
    ...(headerAuth || {}),
    account_id: headerAuth?.account_id || getAccountId(requestUrl, body) || null,
  });
}

function companyBrainReadRequiresExplicitAuth(res, requestUrl) {
  return requestRequiresExplicitUserAuth(res?.__request_headers || null)
    || Boolean(String(requestUrl?.pathname || "").startsWith("/agent/company-brain/"));
}

function buildMissingExplicitUserAuthPayload() {
  return {
    ok: false,
    error: "missing_user_access_token",
    login_url: `${oauthBaseUrl}/oauth/lark/login`,
    message: "This document-search path now requires an explicit user_access_token on the current request.",
  };
}

function resolveCompanyBrainReadContext(res, requestUrl, body, logger = noopHttpLogger) {
  if (companyBrainReadRequiresExplicitAuth(res, requestUrl)) {
    const explicitAuth = resolveExplicitPlannerAuthContext(res, requestUrl, body);
    if (!explicitAuth?.account_id || !explicitAuth?.access_token) {
      logger.warn("company_brain_explicit_auth_missing", {
        account_id: getAccountId(requestUrl, body) || null,
        pathname: requestUrl?.pathname || null,
      });
      jsonResponse(res, 401, buildMissingExplicitUserAuthPayload());
      return null;
    }
    return {
      account: { id: explicitAuth.account_id },
      token: {
        access_token: explicitAuth.access_token,
        account_id: explicitAuth.account_id,
      },
      tokenKind: "user",
      explicit_auth: true,
    };
  }
  return requireUserContext(res, getAccountId(requestUrl, body), logger);
}

function buildCompanyBrainReadAuthPayload(context, action) {
  return {
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action,
  };
}

function respondCompanyBrainReadSuccess(res, statusCode, payload) {
  jsonResponse(res, statusCode, {
    ok: true,
    ...payload,
  });
}

function respondCompanyBrainReadFailure(res, statusCode, error) {
  jsonResponse(res, statusCode, {
    ok: false,
    error,
  });
}

function buildCompanyBrainCollectionResult(context, action, payload) {
  return {
    ...buildCompanyBrainReadAuthPayload(context, action),
    ...payload,
  };
}

function buildCompanyBrainDetailResult(context, item) {
  return {
    ...buildCompanyBrainReadAuthPayload(context, "company_brain_doc_detail"),
    item,
  };
}

function buildCompanyBrainAgentResult(res, action, result = {}) {
  return withTracePayload(res, {
    ok: result?.success === true,
    action,
    data: {
      success: result?.success === true,
      data: result?.data && typeof result.data === "object" && !Array.isArray(result.data)
        ? result.data
        : {},
      error: result?.error || null,
    },
    ...(result?.success === true ? {} : { error: result?.error || "business_error" }),
  });
}

function getCompanyBrainAgentStatusCode(result = {}) {
  if (result?.success === true) {
    return 200;
  }
  if (result?.error === "not_found") {
    return 404;
  }
  if (result?.error === "approval_required") {
    return 409;
  }
  return 400;
}

function buildCompanyBrainReadCanonicalRequest({
  action = "",
  context = null,
  payload = {},
  pathname = "",
} = {}) {
  return {
    action,
    account_id: cleanText(context?.account?.id) || "",
    payload: payload && typeof payload === "object" && !Array.isArray(payload)
      ? { ...payload }
      : {},
    context: {
      pathname: cleanText(pathname) || null,
    },
  };
}

function getCompanyBrainReadResult(readExecution = null) {
  if (readExecution?.data && typeof readExecution.data === "object" && !Array.isArray(readExecution.data)) {
    return readExecution.data;
  }
  return {
    success: false,
    data: {},
    error: cleanText(readExecution?.error) || "runtime_exception",
  };
}

async function runCompanyBrainRead({
  action = "",
  context = null,
  payload = {},
  pathname = "",
  logger = noopHttpLogger,
} = {}) {
  return runRead({
    canonicalRequest: buildCompanyBrainReadCanonicalRequest({
      action,
      context,
      payload,
      pathname,
    }),
    logger,
  });
}

function buildCompanyBrainRuntimeBlockedResult({
  docId = "",
  error = "mutation_verifier_blocked",
  approvalState = null,
  reviewState = null,
} = {}) {
  return {
    success: false,
    data: {
      doc_id: cleanText(docId) || null,
      review_state: reviewState || approvalState?.review_state || null,
      approval_state: approvalState || null,
    },
    error: cleanText(error) || "mutation_verifier_blocked",
  };
}

async function runCompanyBrainReviewSyncMutation({
  accountId = "",
  docId = "",
  title = "",
  action = "ingest_doc",
  targetStage = "mirror",
  overlapSignal = false,
  replacesExisting = false,
  pathname = "internal:company-brain/review-sync",
  method = "INTERNAL",
  traceId = null,
  logger = noopHttpLogger,
} = {}) {
  const canonicalRequest = buildCompanyBrainReviewCanonicalRequest({
    pathname,
    method,
    docId,
    actor: {
      accountId,
    },
    context: {
      confirmed: true,
      verifierCompleted: true,
      reviewRequiredActive: true,
    },
    originalRequest: {
      doc_id: docId,
      title: cleanText(title) || null,
      action,
      target_stage: targetStage,
      overlap_signal: overlapSignal === true,
      replaces_existing: replacesExisting === true,
    },
  });

  return runMutation({
    action: "review_company_brain_doc",
    payload: {
      doc_id: docId,
      title,
      action,
      target_stage: targetStage,
      overlap_signal: overlapSignal === true,
      replaces_existing: replacesExisting === true,
    },
    context: {
      pathname,
      account_id: accountId,
      trace_id: traceId,
      logger,
      canonical_request: canonicalRequest,
      verifier_profile: "knowledge_write_v1",
      verifier_input: {
        account_id: accountId,
        doc_id: docId,
        expected_write: "review_state_optional",
      },
    },
    execute: async () => reviewCompanyBrainDocAction({
      accountId,
      docId,
      title,
      action,
      targetStage,
      overlapSignal,
      replacesExisting,
    }),
  });
}

// ---------------------------------------------------------------------------
// Company-brain approval-adjacent mirror-ingest helper
// ---------------------------------------------------------------------------

async function ingestVerifiedDocumentToCompanyBrain({ account, row, logger = noopHttpLogger }) {
  if (!account?.id || !row?.document_id) {
    return {
      success: false,
      stage: "ingest",
      error: "missing_account_or_document",
    };
  }

  let metadata = null;
  try {
    metadata = row.meta_json ? JSON.parse(row.meta_json) : null;
  } catch {
    metadata = null;
  }

  const payload = buildCompanyBrainPayload(row, metadata);
  const canonicalRequest = buildIngestCompanyBrainDocCanonicalRequest({
    docId: payload.doc_id,
    actor: {
      accountId: account.id,
    },
    context: {
      confirmed: true,
      verifierCompleted: true,
      reviewRequiredActive: false,
    },
    originalRequest: {
      doc_id: payload.doc_id,
      source: payload.source,
    },
  });

  const mutationExecution = await runMutation({
    action: "ingest_doc",
    payload,
    context: {
      pathname: "internal:company-brain/verified-ingest",
      account_id: account.id,
      logger,
      canonical_request: canonicalRequest,
      verifier_profile: "knowledge_write_v1",
      verifier_input: {
        account_id: account.id,
        doc_id: payload.doc_id,
        expected_write: "mirror_doc",
      },
    },
    execute: async () => {
      try {
        const ingested = upsertCompanyBrainDoc({
          account_id: account.id,
          ...payload,
        });
        logger.info("document_company_brain_ingested", {
          stage: "company_brain_ingest",
          account_id: account.id,
          doc_id: payload.doc_id,
          source: payload.source,
        });
        return {
          success: true,
          data: {
            doc_id: payload.doc_id,
            ingested,
          },
          error: null,
        };
      } catch (error) {
        logger.warn("document_company_brain_ingest_failed", {
          stage: "company_brain_ingest",
          account_id: account.id,
          doc_id: payload.doc_id,
          error: logger.compactError(error),
        });
        return {
          success: false,
          data: {
            doc_id: payload.doc_id,
          },
          error: "mirror_ingest_failed",
        };
      }
    },
  });
  if (!mutationExecution?.ok) {
    logger.warn("document_company_brain_ingest_blocked_by_runtime", {
      stage: "company_brain_ingest",
      account_id: account.id,
      doc_id: payload.doc_id,
      error: mutationExecution?.error || "mutation_verifier_blocked",
      verifier: getRuntimeExecutionData(mutationExecution)?.verifier || null,
    });
    return {
      success: false,
      stage: "ingest",
      error: mutationExecution?.error || "mutation_verifier_blocked",
      runtime_execution: mutationExecution,
    };
  }
  const result = getRuntimeExecutionData(mutationExecution);
  if (result?.success !== true) {
    logger.warn("document_company_brain_ingest_failed", {
      stage: "company_brain_ingest",
      account_id: account.id,
      doc_id: payload.doc_id,
      error: result?.error || "business_error",
    });
    return {
      success: false,
      stage: "ingest",
      error: result?.error || "mirror_ingest_failed",
      business_result: result,
    };
  }
  const reviewSyncExecution = await runCompanyBrainReviewSyncMutation({
    accountId: account.id,
    docId: payload.doc_id,
    title: payload.title,
    action: "ingest_doc",
    targetStage: "mirror",
    pathname: "internal:company-brain/verified-ingest/review",
    logger,
  });
  if (!reviewSyncExecution?.ok) {
    logger.warn("document_company_brain_review_sync_blocked", {
      stage: "company_brain_review_state",
      account_id: account.id,
      doc_id: payload.doc_id,
      error: reviewSyncExecution?.error || "mutation_verifier_blocked",
      verifier: getRuntimeExecutionData(reviewSyncExecution)?.verifier || null,
    });
    return {
      success: false,
      stage: "review_sync",
      error: reviewSyncExecution?.error || "mutation_verifier_blocked",
      runtime_execution: reviewSyncExecution,
      ingested: result.data?.ingested || null,
    };
  }
  const reviewResult = getRuntimeExecutionData(reviewSyncExecution);
  if (reviewResult?.success !== true) {
    logger.warn("document_company_brain_review_sync_failed", {
      stage: "company_brain_review_state",
      account_id: account.id,
      doc_id: payload.doc_id,
      error: reviewResult?.error || "business_error",
      review_state: reviewResult?.data?.review_state || null,
      approval_state: reviewResult?.data?.approval_state || null,
    });
    return {
      success: false,
      stage: "review_sync",
      error: reviewResult?.error || "company_brain_review_sync_failed",
      business_result: reviewResult,
      ingested: result.data?.ingested || null,
    };
  }
  const intakeBoundary = reviewResult?.data?.intake_boundary || null;
  logger.info("document_company_brain_intake_classified", {
    stage: "company_brain_intake_boundary",
    account_id: account.id,
    doc_id: payload.doc_id,
    intake_state: intakeBoundary?.intake_state || null,
    review_status: intakeBoundary?.review_status || null,
    direct_intake_allowed: intakeBoundary?.direct_intake_allowed === true,
    review_required: intakeBoundary?.review_required === true,
    conflict_check_required: intakeBoundary?.conflict_check_required === true,
    approval_required_for_formal_source: intakeBoundary?.approval_required_for_formal_source === true,
    matched_docs: Array.isArray(intakeBoundary?.matched_docs)
      ? intakeBoundary.matched_docs.map((item) => ({
          doc_id: item.doc_id,
          title: item.title,
          match_type: item.match_type,
        }))
      : [],
  });
  if (reviewResult?.data?.review_state?.status) {
    logger.info("document_company_brain_review_staged", {
      stage: "company_brain_review_state",
      account_id: account.id,
      doc_id: payload.doc_id,
      review_status: reviewResult.data.review_state.status,
    });
  }
  return {
    success: true,
    stage: "review_sync",
    ingested: result.data?.ingested || null,
    business_result: reviewResult,
  };
}

// ---------------------------------------------------------------------------
// Company-brain write/intake helpers
// ---------------------------------------------------------------------------

function buildDocumentCreateInput(body = {}) {
  return {
    title: String(body.title || "").trim(),
    folderToken: String(body.folder_token || "").trim() || undefined,
    content: String(body.content || "").trim(),
    source: String(body.source || "").trim(),
    owner: String(body.owner || "").trim(),
    intent: String(body.intent || "").trim(),
    type: String(body.type || "").trim(),
    confirm: body.confirm === true,
    confirmationId: String(body.confirmation_id || "").trim(),
  };
}

function buildDocumentReferenceSeed(requestUrl, body = {}) {
  const searchParams = requestUrl?.searchParams;
  return {
    document_id: searchParams?.get("document_id") || body.document_id || "",
    doc_token: searchParams?.get("doc_token") || body.doc_token || "",
    document_url:
      searchParams?.get("document_url")
      || searchParams?.get("document_link")
      || searchParams?.get("doc_link")
      || searchParams?.get("doc_url")
      || body.document_url
      || body.document_link
      || body.doc_link
      || body.doc_url
      || "",
    url: searchParams?.get("url") || body.url || body.link || body.href || "",
    target_document_id: body.target_document_id || "",
    target_document_url: body.target_document_url || "",
    target_document: body.target_document || null,
    text: body.text || "",
  };
}

function resolveDocumentIdFromRequest(requestUrl, body = {}) {
  const seed = buildDocumentReferenceSeed(requestUrl, body);
  return String(seed.document_id || seed.doc_token || extractDocumentId(seed) || "").trim();
}

function buildDocumentUpdateInput(requestUrl, body = {}) {
  const target = body.target && typeof body.target === "object" ? body.target : {};
  return {
    documentId: resolveDocumentIdFromRequest(requestUrl, body),
    content: String(body.content || "").trim(),
    mode: String(body.mode || "append").trim() === "replace" ? "replace" : "append",
    confirm: body.confirm === true,
    confirmationId: String(body.confirmation_id || "").trim(),
    targetHeading: String(
      body.target_heading
      || body.section_heading
      || body.heading
      || target.heading
      || target.section
      || "",
    ).trim(),
    targetPosition: String(body.target_position || target.position || "").trim(),
  };
}

function buildExplicitDocumentWriteTarget(body = {}) {
  return {
    documentId: String(body.document_id || body.doc_token || "").trim(),
    sectionHeading: String(body.section_heading || "").trim(),
  };
}

function buildDocumentWriteAuthPayload(context, action) {
  return {
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action,
  };
}

function ensureMutationAudit(value = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  value.nested_mutations = Array.isArray(value.nested_mutations) ? value.nested_mutations : [];
  return value;
}

function recordNestedMutation(audit = null, {
  phase = "execute",
  action = "",
  targetId = "",
} = {}) {
  const resolvedAudit = ensureMutationAudit(audit);
  if (!resolvedAudit) {
    return;
  }
  resolvedAudit.nested_mutations.push({
    phase: String(phase || "").trim() || "execute",
    action: String(action || "").trim() || null,
    target_id: String(targetId || "").trim() || null,
  });
}

function respondDocumentWriteSuccess(res, statusCode, payload) {
  jsonResponse(res, statusCode, {
    ok: true,
    ...payload,
  });
}

function respondDocumentWriteFailure(res, statusCode, error, extra = {}) {
  jsonResponse(res, statusCode, {
    ok: false,
    error,
    ...extra,
  });
}

function respondWriteExecutionFailure(res, execution, fallbackStatusCode = 409) {
  const executionData = getRuntimeExecutionData(execution);
  jsonResponse(res, Number(executionData?.statusCode || fallbackStatusCode), {
    ok: false,
    error: execution?.error || "write_guard_denied",
    ...(executionData?.message ? { message: executionData.message } : {}),
    write_guard: executionData?.write_guard || null,
    ...(Array.isArray(executionData?.violation_types) ? { violation_types: executionData.violation_types } : {}),
  });
}

function respondCompanyBrainSyncFailure(res, syncResult, {
  message = "",
  extra = {},
} = {}) {
  if (!syncResult || syncResult.success === true) {
    return false;
  }

  if (syncResult.runtime_execution && syncResult.runtime_execution.ok !== true) {
    const execution = syncResult.runtime_execution;
    const executionData = getRuntimeExecutionData(execution);
    jsonResponse(res, Number(executionData?.statusCode || (execution.error === "execution_failed" ? 500 : 409)), {
      ok: false,
      error: execution.error || syncResult.error || "company_brain_sync_failed",
      ...(executionData?.message ? { message: executionData.message } : (message ? { message } : {})),
      write_guard: executionData?.write_guard || null,
      ...(Array.isArray(executionData?.violation_types) ? { violation_types: executionData.violation_types } : {}),
      company_brain_stage: syncResult.stage || null,
      ...extra,
    });
    return true;
  }

  const businessResult =
    syncResult.business_result && typeof syncResult.business_result === "object" && !Array.isArray(syncResult.business_result)
      ? syncResult.business_result
      : {
          success: false,
          data: {},
          error: syncResult.error || "company_brain_sync_failed",
        };

  jsonResponse(res, getCompanyBrainAgentStatusCode(businessResult), {
    ok: false,
    error: businessResult.error || syncResult.error || "company_brain_sync_failed",
    ...(message ? { message } : {}),
    review_state: businessResult?.data?.review_state || null,
    approval_state: businessResult?.data?.approval_state || null,
    company_brain_stage: syncResult.stage || null,
    ...extra,
  });
  return true;
}

function getRuntimeExecutionData(execution = null) {
  if (!execution || typeof execution !== "object" || Array.isArray(execution)) {
    return null;
  }
  if (execution.data && typeof execution.data === "object" && !Array.isArray(execution.data)) {
    return execution.data;
  }
  return execution;
}

function buildDocumentCreateResult({
  context,
  created,
  permissionGrantFailed,
  permissionGrantSkipped,
  permissionGrantError,
  writeResult,
  initialContentWriteFailed,
  initialContentWriteError,
}) {
  return {
    ...buildDocumentWriteAuthPayload(context, "document_create"),
    ...created,
    permission_grant_failed: permissionGrantFailed,
    permission_grant_skipped: permissionGrantSkipped,
    permission_grant_error: permissionGrantError,
    write_result: writeResult,
    initial_content_write_failed: initialContentWriteFailed,
    initial_content_write_error: initialContentWriteError,
  };
}

function buildDocumentCreatePreviewResult({
  context,
  preview,
  message = "Document creation preview is ready. Re-submit with confirm=true and confirmation_id to create the document.",
}) {
  return {
    ...buildDocumentWriteAuthPayload(context, "document_create_preview"),
    preview_required: true,
    message,
    confirmation_id: preview.confirmation_id,
    confirmation_type: preview.confirmation_type,
    confirmation_expires_at: preview.expires_at,
    create_preview: preview.preview,
  };
}

function buildDocumentUpdateResult({
  context,
  mode,
  result,
  targeting = null,
}) {
  const action = targeting
    ? "document_update_targeted_apply"
    : mode === "replace"
      ? "document_update_replace_apply"
      : "document_update";
  return {
    ...buildDocumentWriteAuthPayload(context, action),
    ...result,
    targeting,
  };
}

function buildDocumentReplacePreviewResult({
  context,
  preview,
  targeting = null,
  message = "Replace mode needs explicit confirmation. Re-submit with confirm=true and confirmation_id.",
}) {
  const action = targeting ? "document_update_targeted_preview" : "document_update_replace_preview";
  return {
    ...buildDocumentWriteAuthPayload(context, action),
    preview_required: true,
    message,
    ...preview,
    targeting,
  };
}

function buildDocumentTargetingFailure(error) {
  if (!(error instanceof DocumentTargetingError)) {
    return null;
  }

  return {
    statusCode: 400,
    error: error.code || "document_targeting_error",
    extra: {
      message: error.message || "Failed to resolve targeted document update.",
      ...(error.details && typeof error.details === "object" ? error.details : {}),
    },
  };
}

function buildExplicitDocumentWriteTargetFailure(body = {}) {
  const explicitTarget = buildExplicitDocumentWriteTarget(body);
  const missingFields = [];
  if (!explicitTarget.documentId) {
    missingFields.push("document_id");
  }
  if (!explicitTarget.sectionHeading) {
    missingFields.push("section_heading");
  }
  if (!missingFields.length) {
    return null;
  }
  return {
    statusCode: 400,
    error: "missing_explicit_write_target",
    extra: {
      message: "Final document write requires explicit document_id and section_heading.",
      missing_fields: missingFields,
      required_fields: ["document_id", "section_heading"],
    },
  };
}

function logDocumentLifecycleTransition(
  logger,
  {
    accountId = null,
    documentId = null,
    from = null,
    to = null,
    error = null,
  } = {},
) {
  const level = error ? "warn" : "info";
  logger[level]("document_lifecycle_updated", {
    stage: "document_lifecycle_update",
    account_id: accountId,
    document_id: documentId,
    from,
    to,
    ...(error ? { error: logger.compactError(error) } : {}),
  });
}

function buildCreateFailureExternalKey(res, fallbackTimestamp) {
  return `api-create:${res.__trace_id || fallbackTimestamp}`;
}

function buildCreatedDocumentSeed(created = {}) {
  return {
    document_id: created.document_id || null,
    revision_id: created.revision_id || null,
    title: created.title || null,
    url: created.url || null,
  };
}

function logDocumentCreatePermissionGrantSkipped(logger, context, created) {
  logger.info("document_create_permission_grant_skipped", {
    stage: "permission_grant_skipped",
    reason: "self_owner",
    account_id: context.account.id,
    document_id: created.document_id || null,
  });
}

function logDocumentCreatePermissionGrantFailed(logger, context, created, permissionGrantError) {
  logger.warn("document_create_permission_grant_failed", {
    stage: "permission_grant",
    account_id: context.account.id,
    document_id: created.document_id || null,
    code: permissionGrantError.platform_code,
    msg: permissionGrantError.platform_msg,
    log_id: permissionGrantError.log_id,
  });
}

function logDocumentCreateInitialContentWriteFailed(
  logger,
  context,
  created,
  initialContentWriteError,
) {
  logger.warn("document_create_initial_content_write_failed", {
    stage: "initial_content_write",
    account_id: context.account.id,
    document_id: created.document_id || null,
    code: initialContentWriteError.platform_code,
    msg: initialContentWriteError.platform_msg,
    log_id: initialContentWriteError.log_id,
    http_status: initialContentWriteError.http_status,
  });
}

async function persistCreateFailedLifecycleRecord({
  account,
  res,
  title,
  folderToken,
  logger = noopHttpLogger,
  error,
}) {
  const failureCreatedAt = nowIso();
  const failureExternalKey = buildCreateFailureExternalKey(res, failureCreatedAt);
  try {
    upsertApiLifecycleDocument({
      account,
      externalKey: failureExternalKey,
      created: buildCreatedDocumentSeed({ title }),
      folderToken,
      content: null,
      status: "create_failed",
      failureReason: extractHttpPlatformError(error).platform_msg,
      createdAt: failureCreatedAt,
    });
    logDocumentLifecycleTransition(logger, {
      accountId: account.id,
      documentId: null,
      from: null,
      to: "create_failed",
    });
  } catch (lifecycleError) {
    logDocumentLifecycleTransition(logger, {
      accountId: account.id,
      documentId: null,
      from: null,
      to: "create_failed",
      error: lifecycleError,
    });
  }
}

async function persistCreatedLifecycleSeed({
  account,
  created,
  folderToken,
  createdAt,
  logger = noopHttpLogger,
}) {
  try {
    upsertApiLifecycleDocument({
      account,
      externalKey: `drive:${created.document_id}`,
      created: buildCreatedDocumentSeed(created),
      folderToken,
      content: null,
      status: "created",
      createdAt,
    });
    logDocumentLifecycleTransition(logger, {
      accountId: account.id,
      documentId: created.document_id || null,
      from: null,
      to: "created",
    });
  } catch (error) {
    logDocumentLifecycleTransition(logger, {
      accountId: account.id,
      documentId: created.document_id || null,
      from: null,
      to: "created",
      error,
    });
  }
}

async function applyDocumentManagerPermissionGrant({
  context,
  created,
  logger = noopHttpLogger,
}) {
  const managerOpenId = String(context.account.open_id || "").trim();
  const createdByOpenId = String(
    created?.created_by_open_id
    || created?.creator_open_id
    || created?.owner_open_id
    || managerOpenId,
  ).trim();
  let permissionGrantFailed = false;
  let permissionGrantSkipped = false;
  let permissionGrantError = null;

  if (!managerOpenId || managerOpenId === createdByOpenId) {
    permissionGrantSkipped = true;
    logDocumentCreatePermissionGrantSkipped(logger, context, created);
    return {
      permissionGrantFailed,
      permissionGrantSkipped,
      permissionGrantError,
    };
  }

  try {
    await getHttpService("ensureDocumentManagerPermission", ensureDocumentManagerPermission)(
      context.token,
      created.document_id,
      {
        tokenType: "user",
        managerOpenId,
      },
    );
  } catch (error) {
    permissionGrantFailed = true;
    permissionGrantError = extractHttpPlatformError(error);
    logDocumentCreatePermissionGrantFailed(logger, context, created, permissionGrantError);
  }

  return {
    permissionGrantFailed,
    permissionGrantSkipped,
    permissionGrantError,
  };
}

function logDocumentIndexLifecycleResult({
  logger = noopHttpLogger,
  account,
  created,
  indexedDocument,
}) {
  logDocumentLifecycleTransition(logger, {
    accountId: account.id,
    documentId: created.document_id || null,
    from: "created",
    to: "indexed",
  });

  if (indexedDocument?.verified) {
    logDocumentLifecycleTransition(logger, {
      accountId: account.id,
      documentId: created.document_id || null,
      from: "indexed",
      to: "verified",
    });
    return;
  }

  logDocumentLifecycleTransition(logger, {
    accountId: account.id,
    documentId: created.document_id || null,
    from: "indexed",
    to: "verify_failed",
  });
}

async function persistIndexFailureLifecycleRecord({
  account,
  created,
  folderToken,
  content,
  createdAt,
  logger = noopHttpLogger,
  error,
}) {
  try {
    upsertApiLifecycleDocument({
      account,
      externalKey: `drive:${created.document_id}`,
      created,
      folderToken,
      content,
      status: "index_failed",
      failureReason: String(error?.message || "index_failed"),
      createdAt,
    });
    logDocumentLifecycleTransition(logger, {
      accountId: account.id,
      documentId: created.document_id || null,
      from: "created",
      to: "index_failed",
    });
  } catch (lifecycleError) {
    logDocumentLifecycleTransition(logger, {
      accountId: account.id,
      documentId: created.document_id || null,
      from: "created",
      to: "index_failed",
      error: lifecycleError,
    });
  }
}

async function handleDocumentCreateIndexBoundary({
  context,
  created,
  folderToken,
  content,
  createdAt,
  logger = noopHttpLogger,
}) {
  try {
    const indexedDocument = await indexApiCreatedDocument({
      account: context.account,
      created,
      folderToken,
      content,
    });
    const companyBrainSync = indexedDocument?.verified
      ? await ingestVerifiedDocumentToCompanyBrain({
          account: context.account,
          row: indexedDocument?.document_row,
          logger,
        })
      : null;
    logDocumentIndexLifecycleResult({
      logger,
      account: context.account,
      created,
      indexedDocument,
    });
    logger.info("document_create_indexed", {
      stage: "document_index_schema_normalized",
      account_id: context.account.id,
      document_id: created.document_id || null,
      index_document_id: indexedDocument?.document_row?.id || null,
      source: "api",
    });
    return {
      ok: true,
      indexed: true,
      verified: indexedDocument?.verified === true,
      ingested: companyBrainSync?.success === true,
      indexed_document_id: indexedDocument?.document_row?.id || null,
      company_brain_sync: companyBrainSync,
    };
  } catch (error) {
    await persistIndexFailureLifecycleRecord({
      account: context.account,
      created,
      folderToken,
      content,
      createdAt,
      logger,
      error,
    });
    logger.warn("document_create_index_failed", {
      stage: "document_index_schema_normalized",
      account_id: context.account.id,
      document_id: created.document_id || null,
      error: logger.compactError(error),
    });
    return {
      ok: false,
      indexed: false,
      verified: false,
      ingested: false,
      error,
    };
  }
}

function cleanupRolledBackCreatedDocumentArtifacts({
  accountId,
  documentId,
  mutationAudit = null,
} = {}) {
  const normalizedAccountId = String(accountId || "").trim();
  const normalizedDocumentId = String(documentId || "").trim();
  if (!normalizedAccountId || !normalizedDocumentId) {
    return {
      deleted_document_rows: 0,
      deleted_source_rows: 0,
      deleted_company_brain_rows: 0,
      deleted_chunk_fts_rows: 0,
    };
  }

  return runRepositoryTransaction(() => {
    const documentRows = db.prepare(
      "SELECT id FROM lark_documents WHERE account_id = ? AND document_id = ?",
    ).all(normalizedAccountId, normalizedDocumentId);
    const selectChunkIds = db.prepare("SELECT id FROM lark_chunks WHERE document_id = ?");
    const deleteChunkFts = db.prepare("DELETE FROM lark_chunks_fts WHERE chunk_id = ?");
    let deletedChunkFtsRows = 0;

    for (const row of documentRows) {
      const chunkRows = selectChunkIds.all(row.id);
      for (const chunkRow of chunkRows) {
        deletedChunkFtsRows += deleteChunkFts.run(chunkRow.id).changes;
      }
    }

    const deletedCompanyBrainRows = db.prepare(
      "DELETE FROM company_brain_docs WHERE account_id = ? AND doc_id = ?",
    ).run(normalizedAccountId, normalizedDocumentId).changes;
    const deletedSourceRows = db.prepare(
      "DELETE FROM lark_sources WHERE account_id = ? AND external_id = ?",
    ).run(normalizedAccountId, normalizedDocumentId).changes;
    const deletedDocumentRows = db.prepare(
      "DELETE FROM lark_documents WHERE account_id = ? AND document_id = ?",
    ).run(normalizedAccountId, normalizedDocumentId).changes;

    if (deletedChunkFtsRows > 0) {
      recordNestedMutation(mutationAudit, {
        phase: "rollback",
        action: "delete_document_chunk_fts",
        targetId: normalizedDocumentId,
      });
    }
    if (deletedCompanyBrainRows > 0) {
      recordNestedMutation(mutationAudit, {
        phase: "rollback",
        action: "delete_company_brain_doc",
        targetId: normalizedDocumentId,
      });
    }
    if (deletedSourceRows > 0) {
      recordNestedMutation(mutationAudit, {
        phase: "rollback",
        action: "delete_document_source",
        targetId: normalizedDocumentId,
      });
    }
    if (deletedDocumentRows > 0) {
      recordNestedMutation(mutationAudit, {
        phase: "rollback",
        action: "delete_document_lifecycle_seed",
        targetId: normalizedDocumentId,
      });
    }

    return {
      deleted_document_rows: deletedDocumentRows,
      deleted_source_rows: deletedSourceRows,
      deleted_company_brain_rows: deletedCompanyBrainRows,
      deleted_chunk_fts_rows: deletedChunkFtsRows,
    };
  });
}

async function rollbackCreatedDocumentTransaction({
  accessToken,
  accountId,
  rollbackState = null,
  mutationAudit = null,
} = {}) {
  const state =
    rollbackState && typeof rollbackState === "object" && !Array.isArray(rollbackState)
      ? rollbackState
      : {};
  const details = {
    deleted_document_id: null,
    local_cleanup: {
      deleted_document_rows: 0,
      deleted_source_rows: 0,
      deleted_company_brain_rows: 0,
      deleted_chunk_fts_rows: 0,
    },
  };
  const errors = [];
  let externalDeleteSucceeded = !String(state.created_document_id || "").trim();

  await withLarkWriteExecutionContext({
    api_name: "document_create_rollback",
    action: "document_create_rollback",
    pathname: "internal:doc/create/rollback",
    account_id: accountId || null,
  }, async () => {
    if (!String(state.created_document_id || "").trim()) {
      return;
    }

    try {
      await getHttpService(
        "deleteDocument",
        async (token, documentId) => deleteDriveItem(token, documentId, "docx", "user"),
      )(accessToken, state.created_document_id);
      details.deleted_document_id = state.created_document_id;
      externalDeleteSucceeded = true;
      recordNestedMutation(mutationAudit, {
        phase: "rollback",
        action: "delete_document",
        targetId: state.created_document_id,
      });
    } catch (error) {
      errors.push(`delete_document:${error instanceof Error ? error.message : String(error)}`);
    }
  });

  if (externalDeleteSucceeded && String(state.created_document_id || "").trim()) {
    try {
      details.local_cleanup = cleanupRolledBackCreatedDocumentArtifacts({
        accountId,
        documentId: state.created_document_id,
        mutationAudit,
      });
    } catch (error) {
      errors.push(`cleanup_local_state:${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (errors.length) {
    const rollbackError = new Error(errors.join("; "));
    rollbackError.details = details;
    throw rollbackError;
  }

  return details;
}

function upsertApiLifecycleDocument({
  account,
  externalKey,
  created,
  folderToken,
  content = null,
  status,
  indexedAt = null,
  verifiedAt = null,
  failureReason = null,
  createdAt = null,
}) {
  return upsertDocument({
    account_id: account.id,
    source_id: null,
    source_type: "docx",
    external_key: externalKey,
    external_id: created?.document_id || null,
    file_token: created?.document_id || null,
    document_id: created?.document_id || null,
    title: created?.title || null,
    url: created?.url || null,
    parent_path: "/",
    revision: created?.revision_id || null,
    updated_at_remote: indexedAt || createdAt || nowIso(),
    raw_text: content || null,
    meta_json: buildApiDocumentMetadata({
      account,
      documentId: created?.document_id || null,
      title: created?.title || null,
      folderToken,
      createdAt,
    }),
    active: 1,
    status,
    indexed_at: indexedAt || null,
    verified_at: verifiedAt || null,
    failure_reason: failureReason || null,
  });
}

async function indexApiCreatedDocument({
  account,
  created,
  folderToken,
  content,
}) {
  if (!account?.id || !created?.document_id) {
    return null;
  }

  const externalKey = `drive:${created.document_id}`;
  const existingDocument = getDocumentByExternalKey(account.id, externalKey);
  let existingMeta = null;
  try {
    existingMeta = existingDocument?.meta_json ? JSON.parse(existingDocument.meta_json) : null;
  } catch {
    existingMeta = null;
  }

  const createdAt = existingMeta?.created_at || nowIso();
  const indexedAt = nowIso();
  const metadata = buildApiDocumentMetadata({
    account,
    documentId: created.document_id,
    title: created.title,
    folderToken,
    createdAt,
  });
  const requiredShape = {
    doc_id: true,
    source: true,
    created_at: true,
    creator: {
      account_id: true,
      open_id: true,
    },
    title: true,
    folder_token: true,
  };

  function missingKeys(meta, shape) {
    const misses = [];
    if (!meta || typeof meta !== "object") {
      return ["(root)"];
    }
    for (const [key, value] of Object.entries(shape)) {
      if (!(key in meta)) {
        misses.push(key);
        continue;
      }
      if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const nested of missingKeys(meta[key], value)) {
          misses.push(nested === "(root)" ? key : `${key}.${nested}`);
        }
      }
    }
    return misses;
  }

  return runRepositoryTransaction(() => {
    const sourceRow = upsertSource({
      account_id: account.id,
      source_type: "drive",
      external_key: externalKey,
      external_id: created.document_id,
      title: created.title || null,
      url: created.url || null,
      parent_external_key: folderToken ? `drive:${folderToken}` : null,
      parent_path: "/",
      updated_at_remote: indexedAt,
      meta_json: metadata,
    });

    const indexedDocument = upsertApiLifecycleDocument({
      account,
      externalKey,
      created,
      folderToken,
      content,
      status: "indexed",
      indexedAt,
      createdAt,
    });

    const sourceMeta = sourceRow?.meta_json ? JSON.parse(sourceRow.meta_json) : null;
    const documentMeta = indexedDocument?.meta_json ? JSON.parse(indexedDocument.meta_json) : null;
    const verified =
      JSON.stringify(sourceMeta) === JSON.stringify(documentMeta) &&
      missingKeys(sourceMeta, requiredShape).length === 0 &&
      missingKeys(documentMeta, requiredShape).length === 0;

    if (!verified) {
      const failedDocument = upsertApiLifecycleDocument({
        account,
        externalKey,
        created,
        folderToken,
        content,
        status: "verify_failed",
        indexedAt,
        verifiedAt: null,
        failureReason: "metadata_mismatch",
        createdAt,
      });
      return {
        source_row: sourceRow,
        document_row: failedDocument,
        verified: false,
        failure_reason: "metadata_mismatch",
      };
    }

    const verifiedAt = nowIso();
    const verifiedDocument = upsertApiLifecycleDocument({
      account,
      externalKey,
      created,
      folderToken,
      content,
      status: "verified",
      indexedAt,
      verifiedAt,
      createdAt,
    });

    return {
      source_row: sourceRow,
      document_row: verifiedDocument,
      verified: true,
    };
  });
}

// ---------------------------------------------------------------------------
// Review-adjacent helper builders
// ---------------------------------------------------------------------------

function buildCloudDocPreviewPlan(result) {
  return {
    target_folders: Array.isArray(result?.target_folders) ? result.target_folders : [],
    moves: Array.isArray(result?.moves) ? result.moves : [],
  };
}

function buildCloudDocScopeObjective({ folderToken, options }) {
  if (folderToken) {
    return folderToken;
  }
  return options?.spaceId || options?.parentNodeToken || options?.spaceName || "wiki_scope";
}

function buildCloudDocScopeMeta({
  scopeType,
  folderToken = "",
  spaceId = "",
  parentNodeToken = "",
  previewPlan = null,
}) {
  return {
    scope_type: scopeType,
    folder_token: folderToken,
    space_id: spaceId,
    parent_node_token: parentNodeToken,
    ...(previewPlan ? { preview_plan: previewPlan } : {}),
  };
}

function buildCloudDocWorkflowScope(scopeKey) {
  return {
    session_key: scopeKey,
    trace_id: createTraceId(),
  };
}

function respondCloudDocPreviewRequired(res, message) {
  jsonResponse(res, 409, {
    ok: false,
    error: "preview_required",
    message,
  });
}

async function ensureCloudDocPreviewReviewTasks({
  accountId,
  scope,
  scopeKey,
  objective,
  previewPlan,
  meta,
}) {
  await ensureCloudDocWorkflowTask({
    accountId,
    scope,
    workflowState: "previewing",
    routingHint: "cloud_doc_preview",
    objective,
    scopeKey,
    meta: {
      ...meta,
      preview_plan: previewPlan,
    },
  });
  await ensureCloudDocWorkflowTask({
    accountId,
    scope,
    workflowState: "awaiting_review",
    routingHint: "cloud_doc_review_pending",
    objective,
    scopeKey,
    meta: {
      ...meta,
      preview_plan: previewPlan,
    },
  });
}

function hasCloudDocPreviewPlan(previewPlan = null) {
  return Array.isArray(previewPlan?.moves) && Array.isArray(previewPlan?.target_folders);
}

function buildDocumentRewritePreviewResponse({
  context,
  result,
  confirmation,
  workflowScope,
}) {
  return {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "document_rewrite_from_comments_preview",
    trace_id: workflowScope.trace_id,
    preview_required: true,
    ...result,
    confirmation_id: confirmation.confirmation_id,
    confirmation_type: confirmation.confirmation_type,
    confirmation_expires_at: confirmation.expires_at,
    rewrite_preview: confirmation.preview,
    rewrite_preview_card: confirmation.preview_card,
  };
}

function buildDocumentRewriteApplyResponse({
  context,
  documentId,
  confirmation,
  applied,
  finalized,
  workflowScope,
}) {
  return {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "document_rewrite_from_comments_apply",
    trace_id: workflowScope.trace_id,
    document_id: documentId,
    applied: true,
    resolve_comments: Boolean(confirmation.resolve_comments),
    change_summary: confirmation.change_summary || [],
    update_result: applied.update_result,
    resolved_comment_ids: applied.resolved_comment_ids,
    workflow_state: finalized?.task?.workflow_state || applied.workflow_state || "applying",
    verification: finalized?.verification || null,
  };
}

function respondDocumentRewriteFailure(res, statusCode, error, message, extra = {}) {
  jsonResponse(res, statusCode, {
    ok: false,
    error,
    ...(message ? { message } : {}),
    ...extra,
  });
}

function buildWriteGuardMessage(guard = {}) {
  if (guard.reason === "policy_enforcement_blocked") {
    return cleanText(guard?.policy_enforcement?.message) || "External write is blocked by write policy enforcement.";
  }
  if (guard.reason === "confirmation_required") {
    return "External write requires explicit confirmation before apply.";
  }
  if (guard.reason === "preview_write_blocked") {
    return "Preview mode cannot execute external writes.";
  }
  if (guard.reason === "verifier_incomplete") {
    return "External write is blocked until preview/review verification is complete.";
  }
  return "External write is blocked by write guard.";
}

function getWriteGuardStatusCode(guard = {}) {
  if (guard.require_confirmation) {
    return 409;
  }
  return 409;
}

function buildCloudDocOrganizeResponse({
  context,
  apply,
  result,
  finalized = null,
}) {
  return {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: apply ? "organize_apply" : "organize_preview",
    workflow_state: finalized?.task?.workflow_state || (apply ? "applying" : "awaiting_review"),
    verification: finalized?.verification || null,
    ...result,
  };
}

function buildWikiOrganizeResponse({
  context,
  apply,
  result,
  finalized = null,
}) {
  return {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: apply ? "wiki_organize_apply" : "wiki_organize_preview",
    workflow_state: finalized?.task?.workflow_state || (apply ? "applying" : "awaiting_review"),
    verification: finalized?.verification || null,
    ...result,
  };
}

function buildRequestAbortReason({
  code = "request_cancelled",
  pathname = "",
  timeoutMs = null,
} = {}) {
  const normalizedCode = normalizeText(code) === "request_timeout" ? "request_timeout" : "request_cancelled";
  return {
    name: "AbortError",
    code: normalizedCode,
    message: normalizedCode === "request_timeout"
      ? `Request timed out after ${Number(timeoutMs || 0)}ms.`
      : "Request was cancelled before completion.",
    pathname: normalizeText(pathname) || null,
    ...(Number.isFinite(Number(timeoutMs)) ? { timeout_ms: Number(timeoutMs) } : {}),
  };
}

function resolveRequestAbortInfo({ signal = null, error = null } = {}) {
  const source = signal?.aborted ? signal.reason || error : error;
  if (!source && !signal?.aborted) {
    return null;
  }

  const codeCandidate = normalizeText(source?.code || error?.code || "") || null;
  const nameCandidate = normalizeText(source?.name || error?.name || "") || null;
  if (!signal?.aborted && codeCandidate !== "request_timeout" && codeCandidate !== "request_cancelled" && nameCandidate !== "AbortError") {
    return null;
  }

  return {
    code: codeCandidate === "request_timeout" ? "request_timeout" : "request_cancelled",
    message: normalizeText(source?.message || error?.message)
      || (codeCandidate === "request_timeout"
        ? "Request timed out before completion."
        : "Request was cancelled before completion."),
    timeout_ms: Number.isFinite(Number(source?.timeout_ms))
      ? Number(source.timeout_ms)
      : Number.isFinite(Number(error?.timeout_ms))
        ? Number(error.timeout_ms)
        : null,
  };
}

function emitRequestTimeoutAlert({
  traceId = null,
  requestId = null,
  pathname = null,
  routeName = null,
  timeoutMs = null,
} = {}) {
  emitRateLimitedAlert({
    code: "request_timeout",
    scope: "http",
    dedupeKey: `request_timeout:${routeName || pathname || "unknown"}`,
    message: "HTTP request timed out before completion.",
    details: {
      trace_id: traceId,
      request_id: requestId,
      pathname: pathname || null,
      route_name: routeName || null,
      timeout_ms: Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : null,
    },
  });
}

async function runHttpRoute(logger, routeName, fn, { signal = null } = {}) {
  const routeLogger = (logger || noopHttpLogger).child(routeName, { route: routeName });
  routeLogger.__abort_signal = signal || logger?.__abort_signal || null;
  const startedAt = Date.now();
  routeLogger.info("route_started");
  try {
    const result = await fn(routeLogger, { signal: routeLogger.__abort_signal });
    const abortInfo = resolveRequestAbortInfo({ signal: routeLogger.__abort_signal });
    if (abortInfo) {
      throw Object.assign(new Error(abortInfo.message), {
        name: "AbortError",
        code: abortInfo.code,
        timeout_ms: abortInfo.timeout_ms,
      });
    }
    routeLogger.info("route_succeeded", {
      duration_ms: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    const abortInfo = resolveRequestAbortInfo({ signal: routeLogger.__abort_signal, error });
    if (abortInfo) {
      routeLogger[abortInfo.code === "request_timeout" ? "error" : "warn"]("route_failed", {
        duration_ms: Date.now() - startedAt,
        error: abortInfo.code,
        error_message: abortInfo.message,
        timeout_ms: abortInfo.timeout_ms,
        aborted: true,
      });
      throw Object.assign(new Error(abortInfo.message), {
        name: "AbortError",
        code: abortInfo.code,
        timeout_ms: abortInfo.timeout_ms,
      });
    }
    routeLogger.error("route_failed", {
      duration_ms: Date.now() - startedAt,
      error: routeLogger.compactError(error),
    });
    throw error;
  }
}

async function readJsonBody(req) {
  if (req.method !== "POST" && req.method !== "PUT" && req.method !== "PATCH") {
    return {};
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function buildSearchParamObject(searchParams) {
  const result = {};
  for (const [key, value] of searchParams.entries()) {
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      const existing = result[key];
      result[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
      continue;
    }
    result[key] = value;
  }
  return result;
}

function readRequestHeader(headers = {}, name = "") {
  const normalizedName = normalizeText(name).toLowerCase();
  if (!normalizedName || !headers || typeof headers !== "object") {
    return "";
  }
  const rawValue = headers[normalizedName] ?? headers[name];
  return normalizeText(Array.isArray(rawValue) ? rawValue[0] : rawValue) || "";
}

function normalizeTrafficSource(value = "") {
  const normalized = cleanText(value).toLowerCase();
  if (normalized === "real" || normalized === "test" || normalized === "replay") {
    return normalized;
  }
  return "";
}

function resolveRequestTrafficSource({ req, requestUrl } = {}) {
  const explicitSource = normalizeTrafficSource(
    readRequestHeader(req?.headers, "x-lobster-traffic-source")
    || readRequestHeader(req?.headers, "x-traffic-source")
    || requestUrl?.searchParams?.get("traffic_source")
    || "",
  );
  if (explicitSource) {
    return explicitSource;
  }

  const replayHint = readRequestHeader(req?.headers, "x-lobster-replay")
    || readRequestHeader(req?.headers, "x-idempotency-replay")
    || requestUrl?.searchParams?.get("replay")
    || "";
  if (/^(?:1|true|yes)$/i.test(replayHint)) {
    return "replay";
  }

  const userAgent = readRequestHeader(req?.headers, "user-agent");
  if (SYNTHETIC_REQUEST_USER_AGENT_PATTERN.test(userAgent)) {
    return "test";
  }

  return "real";
}

function buildRequestTrafficMetadata({ req, requestUrl } = {}) {
  return {
    traffic_source: resolveRequestTrafficSource({ req, requestUrl }),
    request_backed: true,
  };
}

function buildRequestInputTrace({ req, requestUrl, body }) {
  const query = buildSearchParamObject(requestUrl.searchParams);
  const normalizedBody = body && typeof body === "object" && !Array.isArray(body)
    ? body
    : body == null
      ? null
      : { raw_body: String(body) };
  const requestTraffic = buildRequestTrafficMetadata({ req, requestUrl });

  return sanitizeTracePayload({
    method: req.method || "GET",
    pathname: requestUrl.pathname,
    traffic_source: requestTraffic.traffic_source,
    request_backed: requestTraffic.request_backed,
    query,
    body: normalizedBody,
  });
}

function getRequestIdempotencyKey(body) {
  if (!body || Array.isArray(body) || typeof body !== "object") {
    return "";
  }
  return typeof body.idempotency_key === "string" ? body.idempotency_key.trim() : "";
}

function cloneReplayPayload(payload, traceId) {
  if (payload == null || Array.isArray(payload) || typeof payload !== "object") {
    return payload;
  }
  return {
    ...payload,
    trace_id: traceId || payload.trace_id || null,
  };
}

function createBufferedResponse(actualRes, onEnd) {
  const headers = new Map();

  return {
    __trace_id: actualRes.__trace_id,
    __request_id: actualRes.__request_id,
    __pathname: actualRes.__pathname,
    __monitor_payload: null,
    statusCode: 200,
    setHeader(name, value) {
      headers.set(name, value);
    },
    getHeader(name) {
      return headers.get(name);
    },
    removeHeader(name) {
      headers.delete(name);
    },
    writeHead(statusCode, extraHeaders = {}) {
      this.statusCode = Number.parseInt(String(statusCode || "200"), 10) || 200;
      for (const [name, value] of Object.entries(extraHeaders || {})) {
        headers.set(name, value);
      }
    },
    end(serialized = "") {
      onEnd({
        statusCode: this.statusCode,
        headers: Object.fromEntries(headers.entries()),
        serialized,
        payload: this.__monitor_payload,
      });
    },
  };
}

function flushBufferedResponse(actualRes, { statusCode = 200, headers = {}, serialized = "", payload = null } = {}) {
  actualRes.__monitor_payload = payload;
  actualRes.writeHead(statusCode, headers);
  actualRes.end(serialized);
}

async function prepareIdempotentRequest({ req, res, requestUrl, body, logger = noopHttpLogger } = {}) {
  const method = normalizeText(req?.method)?.toUpperCase() || "GET";
  if (!["POST", "PUT", "PATCH"].includes(method)) {
    return { replayed: false, res, finalizeError() {} };
  }

  const idempotencyKey = getRequestIdempotencyKey(body);
  if (!idempotencyKey) {
    return { replayed: false, res, finalizeError() {} };
  }

  const accountId = getAccountId(requestUrl, body);
  const scopeKey = buildHttpIdempotencyScopeKey({
    accountId,
    method,
    pathname: requestUrl?.pathname,
    idempotencyKey,
  });
  if (!scopeKey) {
    return { replayed: false, res, finalizeError() {} };
  }

  const existing = getHttpIdempotencyRecord({ scopeKey });
  if (existing) {
    logger.info("request_idempotency_replayed", {
      idempotency_key: idempotencyKey,
      pathname: requestUrl?.pathname || null,
      account_id: accountId || null,
      source: "db",
      traffic_source: "replay",
      original_trace_id: existing.first_trace_id,
    });
    jsonResponse(res, existing.status_code, cloneReplayPayload(existing.response_payload, res.__trace_id));
    return { replayed: true, res, finalizeError() {} };
  }

  const inFlight = inFlightIdempotentRequests.get(scopeKey);
  if (inFlight) {
    logger.info("request_idempotency_waiting", {
      idempotency_key: idempotencyKey,
      pathname: requestUrl?.pathname || null,
      account_id: accountId || null,
      source: "in_flight",
      traffic_source: "replay",
    });
    const awaitedRecord = await inFlight.promise.catch(() => null);
    const replayRecord = awaitedRecord || getHttpIdempotencyRecord({ scopeKey });
    if (replayRecord) {
      jsonResponse(res, replayRecord.status_code, cloneReplayPayload(replayRecord.response_payload, res.__trace_id));
      return { replayed: true, res, finalizeError() {} };
    }
    return { replayed: false, res, finalizeError() {} };
  }

  let settled = false;
  let resolveRecord;
  let rejectRecord;
  const promise = new Promise((resolve, reject) => {
    resolveRecord = resolve;
    rejectRecord = reject;
  });
  inFlightIdempotentRequests.set(scopeKey, { promise });

  const bufferedRes = createBufferedResponse(res, ({ statusCode, headers, serialized, payload }) => {
    try {
      const record = storeHttpIdempotencyRecord({
        accountId,
        method,
        pathname: requestUrl?.pathname,
        idempotencyKey,
        statusCode,
        responsePayload: payload,
        firstTraceId: res.__trace_id,
        firstRequestId: res.__request_id,
      });
      settled = true;
      resolveRecord(record);
    } catch (error) {
      logger.error("request_idempotency_persist_failed", {
        idempotency_key: idempotencyKey,
        pathname: requestUrl?.pathname || null,
        account_id: accountId || null,
        error: logger.compactError(error),
      });
      settled = true;
      rejectRecord(error);
    } finally {
      inFlightIdempotentRequests.delete(scopeKey);
    }

    flushBufferedResponse(res, {
      statusCode,
      headers,
      serialized,
      payload,
    });
  });

  return {
    replayed: false,
    res: bufferedRes,
    finalizeError(error) {
      if (settled) {
        return;
      }
      settled = true;
      inFlightIdempotentRequests.delete(scopeKey);
      rejectRecord(error);
    },
  };
}

async function invokeAgentBridge(handler, { requestUrl, body, logger, res, action }) {
  let capturedStatusCode = 200;
  let capturedPayload = null;

  const captureRes = {
    __trace_id: res?.__trace_id,
    writeHead(statusCode) {
      capturedStatusCode = statusCode;
    },
    end(serialized) {
      try {
        capturedPayload = serialized ? JSON.parse(String(serialized).trim()) : null;
      } catch {
        capturedPayload = {
          ok: false,
          error: "agent_bridge_invalid_json_response",
          raw: serialized == null ? null : String(serialized),
        };
      }
    },
  };

  await handler(captureRes, requestUrl, body, logger);

  const traceId = capturedPayload?.trace_id || res?.__trace_id || null;
  const data = capturedPayload && typeof capturedPayload === "object"
    ? Object.fromEntries(Object.entries(capturedPayload).filter(([key]) => key !== "ok" && key !== "action" && key !== "trace_id"))
    : null;
  const ok = Boolean(capturedPayload?.ok);

  logger.info("agent_bridge_completed", {
    stage: "agent_bridge",
    action,
    ok,
    status_code: capturedStatusCode,
  });

  jsonResponse(res, capturedStatusCode, {
    ok,
    action,
    data,
    trace_id: traceId,
  });
}

async function resolveAccountContext(accountId) {
  const tokenState = await getHttpService("getValidUserTokenState", getValidUserTokenState)(accountId);
  const validToken = tokenState?.status === "valid" ? tokenState.token : null;
  const context = validToken
    ? await getHttpService("getStoredAccountContext", getStoredAccountContext)(
      validToken.account_id || tokenState?.account?.id || accountId
    )
    : null;

  return {
    status: tokenState?.status || "missing",
    reason: tokenState?.reason || null,
    error: tokenState?.error || null,
    account: context?.account || tokenState?.account || null,
    token: validToken,
  };
}

async function requireUserContext(res, accountId, logger = noopHttpLogger) {
  logger.info("auth_context_resolve_started", {
    account_id: accountId || null,
  });
  const context = await resolveAccountContext(accountId);
  if (!context?.token?.access_token) {
    const reauthRequired = context?.status === "reauth_required";
    logger.warn(reauthRequired ? "auth_context_reauth_required" : "auth_context_missing_user_token", {
      account_id: accountId || null,
    });
    if (reauthRequired) {
      emitOauthReauthAlert({
        accountId: context?.account?.id || accountId || null,
        scope: "http.require_user_context",
        pathname: res?.__pathname || null,
        reason: context?.reason || "reauth_required",
      });
    }
    jsonResponse(res, 401, reauthRequired
      ? {
        ok: false,
        error: "oauth_reauth_required",
        login_url: `${oauthBaseUrl}/oauth/lark/login`,
        message: "Stored token expired and refresh failed. Reauthorize Lobster with Lark.",
      }
      : {
        ok: false,
        error: "missing_user_access_token",
        login_url: `${oauthBaseUrl}/oauth/lark/login`,
        message: "Open the login URL first to grant Lobster access to your Lark account.",
      });
    return null;
  }

  logger.info("auth_context_resolve_succeeded", {
    account_id: context.account?.id || accountId || null,
  });
  return context;
}

function getAccountId(requestUrl, body) {
  return requestUrl.searchParams.get("account_id") || body.account_id || undefined;
}

function getSessionKey(requestUrl, body) {
  return requestUrl.searchParams.get("session_key") || body.session_key || undefined;
}

async function handleAuthStatus(res, accountId, logger = noopHttpLogger) {
  const stored = await getHttpService("getStoredUserToken", getStoredUserToken)(accountId);
  if (!stored?.access_token) {
    logger.warn("auth_status_missing_stored_token", {
      account_id: accountId || null,
    });
    jsonResponse(res, 200, {
      ok: false,
      authorized: false,
      login_url: `${oauthBaseUrl}/oauth/lark/login`,
    });
    return;
  }

  const context = await resolveAccountContext(accountId);
  if (!context) {
    logger.warn("auth_status_refresh_failed", {
      account_id: accountId || null,
    });
    emitOauthReauthAlert({
      accountId,
      scope: "http.auth_status",
      pathname: res?.__pathname || null,
      reason: "resolve_account_context_failed",
    });
    jsonResponse(res, 200, {
      ok: false,
      authorized: false,
      login_url: `${oauthBaseUrl}/oauth/lark/login`,
      message: "Stored token is expired and could not be refreshed.",
    });
    return;
  }

  if (!context.token?.access_token) {
    logger.warn("auth_status_refresh_failed", {
      account_id: accountId || null,
    });
    emitOauthReauthAlert({
      accountId: context?.account?.id || accountId || null,
      scope: "http.auth_status",
      pathname: res?.__pathname || null,
      reason: context?.reason || "missing_access_token_after_refresh",
    });
    jsonResponse(res, 200, {
      ok: false,
      authorized: false,
      login_url: `${oauthBaseUrl}/oauth/lark/login`,
      message: "Stored token is expired and could not be refreshed.",
    });
    return;
  }

  const profile = await getUserProfile(context.token.access_token);
  logger.info("auth_status_ready", {
    account_id: context.account.id,
  });
  jsonResponse(res, 200, {
    ok: true,
    authorized: true,
    account_id: context.account.id,
    scope: context.token.scope,
    expires_at: context.token.expires_at,
    user: {
      name: profile.name,
      open_id: profile.open_id,
      union_id: profile.union_id,
      user_id: profile.user_id,
      email: profile.email || profile.enterprise_email,
    },
  });
}

async function handleRuntimeResolveScopes(res, body) {
  const scope = resolveLarkBindingRuntime(body || {});
  jsonResponse(res, 200, {
    ok: true,
    action: "runtime_resolve_scopes",
    ...scope,
  });
}

async function handleRuntimeSessions(res) {
  const sessions = await listResolvedSessions();
  jsonResponse(res, 200, {
    ok: true,
    action: "runtime_sessions_list",
    total: sessions.length,
    items: sessions,
  });
}

async function handleSync(res, requestUrl, body, mode) {
  const accountId = getAccountId(requestUrl, body);
  const context = await requireUserContext(res, accountId);
  if (!context) {
    return;
  }

  const summary = await runSync({
    account: context.account,
    accessToken: context.token,
    mode,
  });

  jsonResponse(res, 200, {
    ok: true,
    ...summary,
  });
}

async function handleDriveList(res, requestUrl, body) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) {
    return;
  }

  const folderToken = requestUrl.searchParams.get("folder_token") || body.folder_token || undefined;
  const pageToken = requestUrl.searchParams.get("page_token") || body.page_token || undefined;
  const data = folderToken
    ? await listDriveFolder(context.token, folderToken, pageToken)
    : await listDriveRoot(context.token, pageToken);

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    source: "drive.v1.files",
    folder_token: folderToken || null,
    ...data,
  });
}

async function handleDriveCreateFolder(res, requestUrl, body) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) {
    return;
  }

  const folderToken = String(body.folder_token || "").trim();
  const name = String(body.name || "").trim();

  if (!folderToken || !name) {
    jsonResponse(res, 400, { ok: false, error: "missing_folder_token_or_name" });
    return;
  }

  const execution = await executeCanonicalLarkMutation({
    action: "create_drive_folder",
    pathname: "/api/drive/create-folder",
    accountId: context.account.id,
    accessToken: context.token,
    resourceId: folderToken,
    scopeKey: `drive:${folderToken}`,
    payload: {
      folder_token: folderToken,
      name,
    },
    originalRequest: body,
    budget: {
      sessionKey: context.account.id,
      scopeKey: `drive:${folderToken}`,
      payload: {
        folder_token: folderToken,
        name,
      },
    },
    performWrite: async ({ accessToken }) => createDriveFolder(accessToken, folderToken, name),
  });
  if (!execution.ok) {
    const executionData = getRuntimeExecutionData(execution);
    jsonResponse(res, 409, {
      ok: false,
      error: execution.error,
      message: executionData?.message,
      write_guard: executionData?.write_guard || null,
    });
    return;
  }
  const result = execution.result;
  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "create_folder",
    ...result,
  });
}

async function handleDriveMove(res, requestUrl, body) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) {
    return;
  }

  const fileToken = String(body.file_token || "").trim();
  const folderToken = String(body.folder_token || "").trim();
  const type = String(body.type || "").trim();

  if (!fileToken || !folderToken || !type) {
    jsonResponse(res, 400, { ok: false, error: "missing_file_token_type_or_folder_token" });
    return;
  }

  const execution = await executeCanonicalLarkMutation({
    action: "move_drive_item",
    pathname: "/api/drive/move",
    accountId: context.account.id,
    accessToken: context.token,
    resourceId: fileToken,
    scopeKey: `drive:${folderToken}`,
    payload: {
      file_token: fileToken,
      type,
      folder_token: folderToken,
    },
    originalRequest: body,
    budget: {
      sessionKey: context.account.id,
      scopeKey: `drive:${folderToken}`,
      documentId: fileToken,
      targetDocumentId: folderToken,
      payload: {
        file_token: fileToken,
        type,
        folder_token: folderToken,
      },
    },
    performWrite: async ({ accessToken }) => moveDriveItem(accessToken, fileToken, type, folderToken),
  });
  if (!execution.ok) {
    const executionData = getRuntimeExecutionData(execution);
    jsonResponse(res, 409, {
      ok: false,
      error: execution.error,
      message: executionData?.message,
      write_guard: executionData?.write_guard || null,
    });
    return;
  }
  const result = execution.result;
  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "move",
    ...result,
  });
}

async function handleDriveTaskStatus(res, requestUrl, body) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) {
    return;
  }

  const taskId = requestUrl.searchParams.get("task_id") || body.task_id || "";
  if (!String(taskId).trim()) {
    jsonResponse(res, 400, { ok: false, error: "missing_task_id" });
    return;
  }

  const result = await checkDriveTask(context.token, String(taskId));
  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "task_status",
    ...result,
  });
}

async function handleDriveDelete(res, requestUrl, body) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) {
    return;
  }

  const fileToken = String(body.file_token || "").trim();
  const type = String(body.type || "").trim();

  if (!fileToken || !type) {
    jsonResponse(res, 400, { ok: false, error: "missing_file_token_or_type" });
    return;
  }

  const execution = await executeCanonicalLarkMutation({
    action: "delete_drive_item",
    pathname: "/api/drive/delete",
    accountId: context.account.id,
    accessToken: context.token,
    resourceId: fileToken,
    scopeKey: `drive:${fileToken}`,
    payload: {
      file_token: fileToken,
      type,
    },
    originalRequest: body,
    budget: {
      sessionKey: context.account.id,
      scopeKey: `drive:${fileToken}`,
      documentId: fileToken,
      payload: {
        file_token: fileToken,
        type,
      },
    },
    performWrite: async ({ accessToken }) => deleteDriveItem(accessToken, fileToken, type),
  });
  if (!execution.ok) {
    const executionData = getRuntimeExecutionData(execution);
    jsonResponse(res, 409, {
      ok: false,
      error: execution.error,
      message: executionData?.message,
      write_guard: executionData?.write_guard || null,
    });
    return;
  }
  const result = execution.result;
  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "delete",
    ...result,
  });
}

async function handleDriveOrganize(res, requestUrl, body, apply, logger = noopHttpLogger) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body), logger);
  if (!context) {
    return;
  }

  let folderToken = String(body.folder_token || requestUrl.searchParams.get("folder_token") || "").trim();
  if (!folderToken) {
    folderToken =
      (await getHttpService("resolveDriveRootFolderToken", resolveDriveRootFolderToken)(
        context.token
      )) || "";
  }
  if (!folderToken) {
    logger.warn("drive_organize_missing_folder_token", {
      account_id: context.account.id,
      apply,
    });
    jsonResponse(res, 400, { ok: false, error: "missing_folder_token" });
    return;
  }

  const options = {
    recursive: body.recursive !== false && requestUrl.searchParams.get("recursive") !== "false",
    includeFolders: body.include_folders === true || requestUrl.searchParams.get("include_folders") === "true",
    accountId: context.account.id,
  };
  const scopeKey = buildCloudDocWorkflowScopeKey({ folderToken });
  const objective = buildCloudDocScopeObjective({ folderToken });
  const scopeMeta = buildCloudDocScopeMeta({
    scopeType: "drive_folder",
    folderToken,
  });
  const workflowScope = buildCloudDocWorkflowScope(scopeKey);

  logger.info("drive_organize_started", {
    account_id: context.account.id,
    apply,
    recursive: options.recursive,
    include_folders: options.includeFolders,
  });
  let applyingTask = null;
  let canonicalRequest = null;
  if (!apply) {
    await ensureCloudDocWorkflowTask({
      accountId: context.account.id,
      scope: workflowScope,
      workflowState: "scoping",
      routingHint: "cloud_doc_scoping",
      objective,
      scopeKey,
      meta: scopeMeta,
    });
  } else {
    applyingTask = await markCloudDocApplying({
      accountId: context.account.id,
      scope: workflowScope,
      scopeKey,
      meta: scopeMeta,
    });
    canonicalRequest = buildDriveOrganizeApplyCanonicalRequest({
      pathname: "/api/drive/organize/apply",
      method: "POST",
      folderToken,
      context: {
        scopeKey,
        idempotencyKey: getRequestIdempotencyKey(body),
        confirmed: apply === true,
        verifierCompleted: hasCloudDocPreviewPlan(applyingTask?.meta?.preview_plan),
        reviewRequiredActive: true,
      },
      originalRequest: body,
    });
  }
  const mutationExecution = apply
    ? await runCanonicalLarkMutation({
        action: "drive_organize_apply",
        pathname: "/api/drive/organize/apply",
        accountId: context.account.id,
        accessToken: context.token,
        logger,
        traceId: res.__trace_id || null,
        canonicalRequest,
        payload: {
          folder_token: folderToken,
          recursive: options.recursive,
          include_folders: options.includeFolders,
        },
        verifierProfile: "cloud_doc_v1",
        verifierInput: {
          scope_key: scopeKey,
          scope_type: "drive_folder",
          preview_plan: applyingTask?.meta?.preview_plan || null,
          evidence: [
            {
              type: "file_updated",
              summary: `drive_scope:${folderToken}`,
            },
            {
              type: "API_call_success",
              summary: "drive_organize_apply_succeeded",
            },
          ],
        },
        budget: {
          sessionKey: context.account.id,
          scopeKey,
          targetDocumentId: folderToken,
          payload: {
            folder_token: folderToken,
            recursive: options.recursive,
            include_folders: options.includeFolders,
          },
          previewPlan: applyingTask?.meta?.preview_plan || null,
        },
        performWrite: async ({ accessToken }) => getHttpService("applyDriveOrganization", applyDriveOrganization)(
          accessToken,
          folderToken,
          options,
        ),
      })
    : null;
  if (apply && !mutationExecution.ok) {
    respondCloudDocPreviewRequired(
      res,
      getRuntimeExecutionData(mutationExecution)?.message || "Drive organize apply is blocked by write policy.",
    );
    return;
  }
  const execution = apply ? getRuntimeExecutionData(mutationExecution) : null;
  if (apply && !execution?.ok) {
    respondCloudDocPreviewRequired(res, execution?.message || "Drive organize apply is blocked by write policy.");
    return;
  }
  const result = apply
    ? execution.result
    : await getHttpService("previewDriveOrganization", previewDriveOrganization)(
        context.token,
        folderToken,
        options
      );
  logger.info("drive_organize_completed", {
    account_id: context.account.id,
    apply,
    task_id: result.task_id || null,
    total_items: Array.isArray(result.items) ? result.items.length : null,
  });
  if (!apply) {
    await ensureCloudDocPreviewReviewTasks({
      accountId: context.account.id,
      scope: workflowScope,
      scopeKey,
      objective,
      previewPlan: buildCloudDocPreviewPlan(result),
      meta: scopeMeta,
    });
  }
  const structuredResult = buildCloudDocStructuredResult({
    scopeKey,
    scopeType: "drive_folder",
    preview: apply
      ? buildCloudDocPreviewPlan(applyingTask?.meta?.preview_plan)
      : result,
    apply: apply ? result : null,
    mode: apply ? "apply" : "preview",
  });
  const finalized = apply
    ? await finalizeCloudDocWorkflowTask({
        accountId: context.account.id,
        scope: workflowScope,
        scopeKey,
        structuredResult,
        extraEvidence: [
          {
            type: "file_updated",
            summary: `drive_scope:${folderToken}`,
          },
          {
            type: "API_call_success",
            summary: "drive_organize_apply_succeeded",
          },
        ],
      })
    : null;

  jsonResponse(res, 200, buildCloudDocOrganizeResponse({
    context,
    apply,
    result,
    finalized,
  }));
}

async function handleWikiCreateNode(res, requestUrl, body) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) {
    return;
  }

  const spaceId = String(body.space_id || "").trim();
  const title = String(body.title || "").trim();
  const parentNodeToken = String(body.parent_node_token || "").trim() || undefined;

  if (!spaceId || !title) {
    jsonResponse(res, 400, { ok: false, error: "missing_space_id_or_title" });
    return;
  }

  const execution = await executeCanonicalLarkMutation({
    action: "create_wiki_node",
    pathname: "/api/wiki/create-node",
    accountId: context.account.id,
    accessToken: context.token,
    resourceId: parentNodeToken || spaceId,
    scopeKey: `wiki:${spaceId}:${parentNodeToken || "root"}`,
    payload: {
      space_id: spaceId,
      title,
      parent_node_token: parentNodeToken || null,
    },
    originalRequest: body,
    budget: {
      sessionKey: context.account.id,
      scopeKey: `wiki:${spaceId}:${parentNodeToken || "root"}`,
      targetDocumentId: parentNodeToken || null,
      payload: {
        space_id: spaceId,
        title,
        parent_node_token: parentNodeToken || null,
      },
    },
    performWrite: async ({ accessToken }) => createWikiNode(accessToken, spaceId, title, parentNodeToken),
  });
  if (!execution.ok) {
    const executionData = getRuntimeExecutionData(execution);
    jsonResponse(res, 409, {
      ok: false,
      error: execution.error,
      message: executionData?.message,
      write_guard: executionData?.write_guard || null,
    });
    return;
  }
  const result = execution.result;
  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "create_wiki_node",
    ...result,
  });
}

async function handleWikiMove(res, requestUrl, body) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) {
    return;
  }

  const spaceId = String(body.space_id || "").trim();
  const nodeToken = String(body.node_token || "").trim();
  const targetParentToken = String(body.target_parent_token || "").trim();
  const targetSpaceId = String(body.target_space_id || "").trim() || undefined;

  if (!spaceId || !nodeToken || !targetParentToken) {
    jsonResponse(res, 400, { ok: false, error: "missing_space_id_node_token_or_target_parent_token" });
    return;
  }

  const execution = await executeCanonicalLarkMutation({
    action: "move_wiki_node",
    pathname: "/api/wiki/move",
    accountId: context.account.id,
    accessToken: context.token,
    resourceId: nodeToken,
    scopeKey: `wiki:${spaceId}:${targetParentToken}`,
    payload: {
      space_id: spaceId,
      node_token: nodeToken,
      target_parent_token: targetParentToken,
      target_space_id: targetSpaceId || null,
    },
    originalRequest: body,
    budget: {
      sessionKey: context.account.id,
      scopeKey: `wiki:${spaceId}:${targetParentToken}`,
      documentId: nodeToken,
      targetDocumentId: targetParentToken,
      payload: {
        space_id: spaceId,
        node_token: nodeToken,
        target_parent_token: targetParentToken,
        target_space_id: targetSpaceId || null,
      },
    },
    performWrite: async ({ accessToken }) => moveWikiNode(
      accessToken,
      spaceId,
      nodeToken,
      targetParentToken,
      targetSpaceId,
    ),
  });
  if (!execution.ok) {
    const executionData = getRuntimeExecutionData(execution);
    jsonResponse(res, 409, {
      ok: false,
      error: execution.error,
      message: executionData?.message,
      write_guard: executionData?.write_guard || null,
    });
    return;
  }
  const result = execution.result;
  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "move_wiki_node",
    ...result,
  });
}

async function handleWikiOrganize(res, requestUrl, body, apply, logger = noopHttpLogger) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body), logger);
  if (!context) {
    return;
  }

  const options = {
    spaceId: String(body.space_id || requestUrl.searchParams.get("space_id") || "").trim() || undefined,
    spaceName: String(body.space_name || requestUrl.searchParams.get("space_name") || "").trim() || undefined,
    parentNodeToken:
      String(body.parent_node_token || requestUrl.searchParams.get("parent_node_token") || "").trim() || undefined,
    recursive: body.recursive === true || requestUrl.searchParams.get("recursive") === "true",
    includeContainers:
      body.include_containers === true || requestUrl.searchParams.get("include_containers") === "true",
    accountId: context.account.id,
  };
  const scopeKey = buildCloudDocWorkflowScopeKey({
    spaceId: options.spaceId,
    parentNodeToken: options.parentNodeToken,
    spaceName: options.spaceName,
  });
  const objective = buildCloudDocScopeObjective({ options });
  const scopeMeta = buildCloudDocScopeMeta({
    scopeType: "wiki_scope",
    spaceId: options.spaceId || "",
    parentNodeToken: options.parentNodeToken || "",
  });
  const workflowScope = buildCloudDocWorkflowScope(scopeKey);

  logger.info("wiki_organize_started", {
    account_id: context.account.id,
    apply,
    has_space_id: Boolean(options.spaceId),
    has_parent_node_token: Boolean(options.parentNodeToken),
    recursive: options.recursive,
  });
  let applyingTask = null;
  let canonicalRequest = null;
  if (!apply) {
    await ensureCloudDocWorkflowTask({
      accountId: context.account.id,
      scope: workflowScope,
      workflowState: "scoping",
      routingHint: "cloud_doc_scoping",
      objective,
      scopeKey,
      meta: scopeMeta,
    });
  } else {
    applyingTask = await markCloudDocApplying({
      accountId: context.account.id,
      scope: workflowScope,
      scopeKey,
      meta: scopeMeta,
    });
    canonicalRequest = buildWikiOrganizeApplyCanonicalRequest({
      pathname: "/api/wiki/organize/apply",
      method: "POST",
      resourceId: options.spaceId || options.parentNodeToken || options.spaceName || "",
      context: {
        scopeKey,
        idempotencyKey: getRequestIdempotencyKey(body),
        confirmed: apply === true,
        verifierCompleted: hasCloudDocPreviewPlan(applyingTask?.meta?.preview_plan),
        reviewRequiredActive: true,
      },
      originalRequest: body,
    });
  }
  const mutationExecution = apply
    ? await runCanonicalLarkMutation({
        action: "wiki_organize_apply",
        pathname: "/api/wiki/organize/apply",
        accountId: context.account.id,
        accessToken: context.token,
        logger,
        traceId: res.__trace_id || null,
        canonicalRequest,
        payload: {
          space_id: options.spaceId || null,
          space_name: options.spaceName || null,
          parent_node_token: options.parentNodeToken || null,
          recursive: options.recursive,
          include_containers: options.includeContainers,
        },
        verifierProfile: "cloud_doc_v1",
        verifierInput: {
          scope_key: scopeKey,
          scope_type: "wiki_scope",
          preview_plan: applyingTask?.meta?.preview_plan || null,
          evidence: [
            {
              type: "file_updated",
              summary: `wiki_scope:${options.parentNodeToken || options.spaceId || "root"}`,
            },
            {
              type: "API_call_success",
              summary: "wiki_organize_apply_succeeded",
            },
          ],
        },
        budget: {
          sessionKey: context.account.id,
          scopeKey,
          targetDocumentId: options.parentNodeToken || options.spaceId || null,
          payload: {
            space_id: options.spaceId || null,
            space_name: options.spaceName || null,
            parent_node_token: options.parentNodeToken || null,
            recursive: options.recursive,
            include_containers: options.includeContainers,
          },
          previewPlan: applyingTask?.meta?.preview_plan || null,
        },
        performWrite: async ({ accessToken }) => getHttpService("applyWikiOrganization", applyWikiOrganization)(
          accessToken,
          options,
        ),
      })
    : null;
  if (apply && !mutationExecution.ok) {
    respondCloudDocPreviewRequired(
      res,
      getRuntimeExecutionData(mutationExecution)?.message || "Wiki organize apply is blocked by write policy.",
    );
    return;
  }
  const execution = apply ? getRuntimeExecutionData(mutationExecution) : null;
  if (apply && !execution?.ok) {
    respondCloudDocPreviewRequired(res, execution?.message || "Wiki organize apply is blocked by write policy.");
    return;
  }
  const result = apply
    ? execution.result
    : await getHttpService("previewWikiOrganization", previewWikiOrganization)(
        context.token,
        options
      );
  logger.info("wiki_organize_completed", {
    account_id: context.account.id,
    apply,
    total_items: Array.isArray(result.items) ? result.items.length : null,
    task_id: result.task_id || null,
  });
  if (!apply) {
    await ensureCloudDocPreviewReviewTasks({
      accountId: context.account.id,
      scope: workflowScope,
      scopeKey,
      objective,
      previewPlan: buildCloudDocPreviewPlan(result),
      meta: scopeMeta,
    });
  }
  const structuredResult = buildCloudDocStructuredResult({
    scopeKey,
    scopeType: "wiki_scope",
    preview: apply
      ? buildCloudDocPreviewPlan(applyingTask?.meta?.preview_plan)
      : result,
    apply: apply ? result : null,
    mode: apply ? "apply" : "preview",
  });
  const finalized = apply
    ? await finalizeCloudDocWorkflowTask({
        accountId: context.account.id,
        scope: workflowScope,
        scopeKey,
        structuredResult,
        extraEvidence: [
          {
            type: "file_updated",
            summary: `wiki_scope:${options.spaceId || options.parentNodeToken || options.spaceName || "unknown"}`,
          },
          {
            type: "API_call_success",
            summary: "wiki_organize_apply_succeeded",
          },
        ],
      })
    : null;

  jsonResponse(res, 200, buildWikiOrganizeResponse({
    context,
    apply,
    result,
    finalized,
  }));
}

async function handleDocumentRead(res, requestUrl, body) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) {
    return;
  }

  const documentId = resolveDocumentIdFromRequest(requestUrl, body);
  if (!documentId) {
    respondDocumentRewriteFailure(res, 400, "missing_document_id");
    return;
  }

  const result = await getHttpService("readDocumentFromRuntime", readDocumentFromRuntime)({
    accountId: context.account.id,
    accessToken: context.token,
    documentId,
    pathname: requestUrl?.pathname || "/api/doc/read",
    logger: null,
  });
  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "document_read",
    ...result,
  });
}

async function handleDocumentCreate(
  res,
  requestUrl,
  body,
  logger = noopHttpLogger,
  { requireEntryGovernance = false } = {},
) {
  assertLarkWriteAllowed();
  const context = await requireUserContext(res, getAccountId(requestUrl, body), logger);
  if (!context) {
    return;
  }

  const {
    title,
    folderToken: requestedFolderToken,
    content,
    source,
    owner,
    intent,
    type,
    confirm,
    confirmationId,
  } = buildDocumentCreateInput(body);
  const pathname = requireEntryGovernance ? "/agent/docs/create" : "/api/doc/create";
  const idempotencyKey = getRequestIdempotencyKey(body);
  const writePolicy = buildCreateDocWritePolicy({
    folderToken: requestedFolderToken,
    idempotencyKey,
  });

  if (!title) {
    logger.warn("document_create_missing_title");
    respondDocumentWriteFailure(res, 400, "missing_document_title");
    return;
  }

  if (requireEntryGovernance) {
    const entryGovernance = validateDocumentCreateEntryGovernance({
      source,
      owner,
      intent,
      type,
    });
    if (!entryGovernance.ok) {
      logger.warn("document_create_entry_governance_blocked", {
        account_id: context.account.id,
        missing_fields: entryGovernance.missing_fields,
        source: entryGovernance.governance?.source || null,
        owner: entryGovernance.governance?.owner || null,
        intent: entryGovernance.governance?.intent || null,
        type: entryGovernance.governance?.type || null,
        write_policy: writePolicy,
      });
      respondDocumentWriteFailure(res, 400, entryGovernance.error, {
        message: entryGovernance.message,
        missing_fields: entryGovernance.missing_fields,
      });
      return;
    }
  }

  const autoConfirmLegacyAgentCreate = requireEntryGovernance === true && !confirmationId;
  const createRollbackState = {};
  const mutationAudit = {
    boundary: "create_doc",
    nested_mutations: [],
  };
  const createRuntime = await runDocumentCreateMutation({
    pathname,
    accountId: context.account.id,
    account: context.account,
    accessToken: context.token,
    logger,
    traceId: res.__trace_id || null,
    originalRequest: body,
    title,
    requestedFolderToken,
    content,
    source,
    owner,
    intent,
    type,
    confirm,
    confirmationId,
    idempotencyKey,
    autoConfirmWithoutConfirmation: autoConfirmLegacyAgentCreate,
    rollback: async () => rollbackCreatedDocumentTransaction({
      accessToken: context.token,
      accountId: context.account.id,
      rollbackState: createRollbackState,
      mutationAudit,
    }),
    audit: mutationAudit,
    performWrite: async ({ accessToken, folderToken, createGuard, writePolicy }) => {
        let created;
        try {
          created = await getHttpService("createDocument", createDocument)(
            accessToken,
            title,
            folderToken,
            "user",
            { source: source || "api_doc_create" },
          );
          createRollbackState.created_document_id = created?.document_id || null;
          recordNestedMutation(mutationAudit, {
            phase: "execute",
            action: "create_document",
            targetId: created?.document_id || null,
          });
        } catch (error) {
          await persistCreateFailedLifecycleRecord({
            account: context.account,
            res,
          title,
          folderToken,
          logger,
          error,
        });
          throw error;
        }

        const createdAt = nowIso();
        await persistCreatedLifecycleSeed({
          account: context.account,
          created,
          folderToken,
          createdAt,
          logger,
        });
        recordNestedMutation(mutationAudit, {
          phase: "execute",
          action: "persist_document_lifecycle_seed",
          targetId: created?.document_id || null,
        });
        logger.info("document_create_create_succeeded", {
          account_id: context.account.id,
          document_id: created.document_id || null,
          folder_token: folderToken || null,
        });

        const {
          permissionGrantFailed,
          permissionGrantSkipped,
          permissionGrantError,
        } = await applyDocumentManagerPermissionGrant({
          context,
          created,
          logger,
        });
        if (permissionGrantFailed) {
          const error = new Error("document_create_permission_grant_failed");
          error.details = permissionGrantError;
          throw error;
        }
        if (!permissionGrantSkipped) {
          recordNestedMutation(mutationAudit, {
            phase: "execute",
            action: "grant_document_permission",
            targetId: created?.document_id || null,
          });
        }

        let writeResult = null;
        let initialContentWriteFailed = false;
        let initialContentWriteError = null;
        let indexedContent = content || null;
        if (content && created.document_id) {
          try {
            writeResult = await getHttpService("updateDocument", updateDocument)(
              accessToken,
              created.document_id,
              content,
              "replace",
            );
          } catch (error) {
            initialContentWriteFailed = true;
            initialContentWriteError = extractHttpPlatformError(error);
            indexedContent = null;
            logDocumentCreateInitialContentWriteFailed(
              logger,
              context,
              created,
              initialContentWriteError,
            );
            const writeError = new Error("document_create_initial_content_write_failed");
            writeError.details = initialContentWriteError;
            throw writeError;
          }
          recordNestedMutation(mutationAudit, {
            phase: "execute",
            action: "update_document",
            targetId: created?.document_id || null,
          });
        }

        const indexBoundary = await handleDocumentCreateIndexBoundary({
          context,
          created,
          folderToken,
          content: indexedContent,
          createdAt,
          logger,
        });
        if (indexBoundary?.indexed) {
          recordNestedMutation(mutationAudit, {
            phase: "execute",
            action: "index_document",
            targetId: created?.document_id || null,
          });
        }
        if (indexBoundary?.ingested) {
          recordNestedMutation(mutationAudit, {
            phase: "execute",
            action: "ingest_company_brain_doc",
            targetId: created?.document_id || null,
          });
        }
        logger.info("document_create_completed", {
          account_id: context.account.id,
          document_id: created.document_id || null,
          wrote_initial_content: Boolean(writeResult),
          initial_content_write_failed: initialContentWriteFailed,
          permission_grant_failed: permissionGrantFailed,
          permission_grant_skipped: permissionGrantSkipped,
          write_policy: writePolicy,
        });

        return {
          created,
          permissionGrantFailed,
          permissionGrantSkipped,
          permissionGrantError,
          writeResult,
          initialContentWriteFailed,
          initialContentWriteError,
          indexBoundary,
        };
      },
  });
  const createRuntimeData = getRuntimeExecutionData(createRuntime) || {};
  const createGuard = createRuntimeData.create_guard || null;
  const resolvedWritePolicy = createRuntimeData.write_policy || writePolicy;
  const folderToken = createRuntimeData.resolved_folder_token || null;

  if (createRuntimeData.stage === "guard_blocked") {
    logger.warn("document_create_guard_blocked", {
      account_id: context.account.id,
      tenant_key: context.account?.tenant_key || null,
      error: createRuntime.error,
      requested_folder_token: createRuntimeData.requested_folder_token,
      resolved_folder_token: createRuntimeData.resolved_folder_token,
      demo_like: createGuard?.classification?.demo_like === true,
      write_policy: resolvedWritePolicy,
    });
    respondDocumentWriteFailure(res, createRuntimeData.statusCode, createRuntime.error, {
      message: createRuntimeData.message,
      requested_folder_token: createRuntimeData.requested_folder_token,
      resolved_folder_token: createRuntimeData.resolved_folder_token,
      demo_like: createGuard?.classification?.demo_like === true,
    });
    return;
  }

  if (createRuntimeData.stage === "preview_ready") {
    logger.info("document_create_preview_ready", {
      account_id: context.account.id,
      requested_folder_token: createRuntimeData.requested_folder_token,
      resolved_folder_token: createRuntimeData.resolved_folder_token,
      confirmation_id: createRuntimeData.preview?.confirmation_id || null,
      has_initial_content: Boolean(content),
      demo_like: createGuard?.classification?.demo_like === true,
      write_policy: resolvedWritePolicy,
    });
    respondDocumentWriteSuccess(res, 200, buildDocumentCreatePreviewResult({
      context,
      preview: createRuntimeData.preview,
    }));
    return;
  }

  if (createRuntimeData.auto_confirmed) {
    logger.info("document_create_agent_bridge_auto_confirmed", {
      account_id: context.account.id,
      requested_folder_token: createRuntimeData.requested_folder_token,
      resolved_folder_token: createRuntimeData.resolved_folder_token,
      confirmation_id: createRuntimeData.confirmation_id || null,
      has_initial_content: Boolean(content),
      demo_like: createGuard?.classification?.demo_like === true,
      write_policy: resolvedWritePolicy,
    });
  }

  logger.info("document_create_started", {
    account_id: context.account.id,
    has_folder_token: Boolean(folderToken),
    requested_folder_token: createRuntimeData.requested_folder_token,
    resolved_folder_token: createRuntimeData.resolved_folder_token,
    has_initial_content: Boolean(content),
    demo_like: createGuard?.classification?.demo_like === true,
    write_policy: resolvedWritePolicy,
  });

  const mutationExecution = createRuntimeData.mutation_execution;
  if (!mutationExecution.ok) {
    const mutationExecutionData = getRuntimeExecutionData(mutationExecution);
    if (mutationExecution.error === "write_policy_enforcement_blocked") {
      respondDocumentWriteFailure(res, 409, "write_policy_enforcement_blocked", {
        message: mutationExecutionData?.message,
        violation_types: Array.isArray(mutationExecutionData?.violation_types)
          ? mutationExecutionData.violation_types
          : [],
      });
      return;
    }
    respondWriteExecutionFailure(
      res,
      mutationExecution,
      mutationExecution.error === "execution_failed" ? 500 : 409,
    );
    return;
  }

  const execution = getRuntimeExecutionData(mutationExecution);
  if (!execution?.ok) {
    respondWriteExecutionFailure(res, execution);
    return;
  }
  const {
    created,
    permissionGrantFailed,
    permissionGrantSkipped,
    permissionGrantError,
    writeResult,
    initialContentWriteFailed,
    initialContentWriteError,
    indexBoundary,
  } = execution.result;

  if (indexBoundary?.verified === true && indexBoundary?.company_brain_sync?.success !== true) {
    logger.error("document_create_company_brain_sync_failed", {
      stage: "company_brain_ingest",
      account_id: context.account.id,
      document_id: created?.document_id || null,
      error: indexBoundary?.company_brain_sync?.error || "company_brain_sync_failed",
      company_brain_stage: indexBoundary?.company_brain_sync?.stage || null,
    });
    if (respondCompanyBrainSyncFailure(res, indexBoundary.company_brain_sync, {
      message: "Document create completed, but company-brain ingest/review sync failed.",
      extra: {
        account_id: context.account.id,
        auth_mode: "user_access_token",
        action: "document_create",
        document_id: created?.document_id || null,
      },
    })) {
      return;
    }
  }

  respondDocumentWriteSuccess(res, 200, buildDocumentCreateResult({
    context,
    created,
    permissionGrantFailed,
    permissionGrantSkipped,
    permissionGrantError,
    writeResult,
    initialContentWriteFailed,
    initialContentWriteError,
  }));
}

async function handleDocumentLifecycleList(res, requestUrl, body, logger = noopHttpLogger) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body), logger);
  if (!context) {
    return;
  }

  const status = String(requestUrl.searchParams.get("status") || body.status || "").trim();
  if (!status) {
    jsonResponse(res, 400, { ok: false, error: "missing_document_lifecycle_status" });
    return;
  }

  const limitRaw = Number.parseInt(
    String(requestUrl.searchParams.get("limit") || body.limit || "50").trim(),
    10,
  );
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
  const items = listDocumentsByStatus(context.account.id, status, limit).map(buildDocumentLifecycleView);

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "document_lifecycle_list",
    status,
    total: items.length,
    items,
  });
}

async function handleDocumentLifecycleSummary(res, requestUrl, body, logger = noopHttpLogger) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body), logger);
  if (!context) {
    return;
  }

  const summary = summarizeDocumentLifecycle(context.account.id);
  logger.info("document_lifecycle_summary", {
    stage: "document_lifecycle_summary",
    account_id: context.account.id,
    ...summary,
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "document_lifecycle_summary",
    summary,
  });
}

async function handleRuntimeInfo(res, requestUrl, body, logger = noopHttpLogger) {
  try {
    const result = {
      db_path: getDbPath(),
      node_pid: process.pid,
      cwd: process.cwd(),
      service_start_time: serviceStartTime,
    };

    logger.info("runtime_info", {
      stage: "runtime_info",
      action: "get_runtime_info",
      kind: "runtime_info",
      ...result,
    });

    jsonResponse(res, 200, buildExecutionEnvelope({
      ok: true,
      action: "get_runtime_info",
      data: result,
    }));
  } catch (err) {
    logger.error("runtime_info_failed", {
      stage: "runtime_info",
      action: "get_runtime_info",
      error: logger.compactError?.(err) || { message: err?.message || "runtime_exception" },
    });
    jsonResponse(res, 500, buildExecutionEnvelope({
      ok: false,
      action: "get_runtime_info",
      error: err,
    }));
  }
}

async function handleMonitoringRequests(res, requestUrl) {
  const limit = requestUrl.searchParams.get("limit") || "50";
  const items = listRecentRequests({ limit });
  jsonResponse(res, 200, {
    ok: true,
    total: items.length,
    items,
  });
}

async function handleMonitoringErrors(res, requestUrl) {
  const limit = requestUrl.searchParams.get("limit") || "10";
  const items = listRecentErrors({ limit });
  jsonResponse(res, 200, {
    ok: true,
    total: items.length,
    items,
  });
}

async function handleMonitoringLatestError(res) {
  jsonResponse(res, 200, {
    ok: true,
    item: getLatestError(),
  });
}

async function handleMonitoringMetrics(res) {
  jsonResponse(res, 200, {
    ok: true,
    metrics: getRequestMetrics(),
  });
}

async function handleMonitoringLearningSummary(res, requestUrl, body, logger = noopHttpLogger) {
  const summary = buildAgentLearningSummary({
    lookbackHours: requestUrl.searchParams.get("lookback_hours") || body.lookback_hours,
    requestLimit: requestUrl.searchParams.get("request_limit") || body.request_limit,
    minSampleSize: requestUrl.searchParams.get("min_sample_size") || body.min_sample_size,
    maxRoutingItems: requestUrl.searchParams.get("max_routing_items") || body.max_routing_items,
    maxToolItems: requestUrl.searchParams.get("max_tool_items") || body.max_tool_items,
  });
  logger.info("monitoring_learning_summary_completed", {
    sampled_requests: summary.sampled_requests,
    routing_issue_count: summary.routing_issues.length,
    high_success_tool_count: summary.high_success_tools.length,
    low_success_tool_count: summary.low_success_tools.length,
    draft_proposal_count: summary.draft_proposals.length,
  });
  jsonResponse(res, 200, {
    ok: true,
    summary,
  });
}

async function handleLearningImprovementGeneration(res, requestUrl, body, logger = noopHttpLogger) {
  const accountId = getAccountId(requestUrl, body);
  const sessionKey = getSessionKey(requestUrl, body);
  logger.info("learning_improvement_generation_started", {
    account_id: accountId || null,
    session_key: sessionKey || null,
  });
  const result = await generateLearningLoopImprovementProposals({
    accountId,
    sessionKey,
    lookbackHours: requestUrl.searchParams.get("lookback_hours") || body.lookback_hours,
    requestLimit: requestUrl.searchParams.get("request_limit") || body.request_limit,
    minSampleSize: requestUrl.searchParams.get("min_sample_size") || body.min_sample_size,
    maxRoutingItems: requestUrl.searchParams.get("max_routing_items") || body.max_routing_items,
    maxToolItems: requestUrl.searchParams.get("max_tool_items") || body.max_tool_items,
  });
  logger.info("learning_improvement_generation_completed", {
    account_id: accountId || null,
    session_key: sessionKey || null,
    proposal_count: result.proposals.length,
  });
  jsonResponse(res, 200, {
    ok: true,
    total: result.proposals.length,
    summary: result.summary,
    items: result.proposals,
  });
}

async function handleMonitoringDashboard(res, requestUrl) {
  const dashboard = getMonitoringDashboard({
    recentLimit: requestUrl.searchParams.get("requests_limit") || requestUrl.searchParams.get("recent_limit") || "10",
    errorLimit: requestUrl.searchParams.get("errors_limit") || requestUrl.searchParams.get("error_limit") || "10",
  });
  htmlResponse(res, 200, renderMonitoringDashboardPage({
    dashboard,
    traceId: res.__trace_id || null,
  }));
}

async function handleAgentCreateDoc(res, requestUrl, body, logger = noopHttpLogger) {
  await invokeAgentBridge((bridgeRes, bridgeRequestUrl, bridgeBody, bridgeLogger) => (
    handleDocumentCreate(
      bridgeRes,
      bridgeRequestUrl,
      bridgeBody,
      bridgeLogger,
      { requireEntryGovernance: true },
    )
  ), {
    requestUrl,
    body,
    logger,
    res,
    action: "create_doc",
  });
}

async function handleAgentListCompanyBrainDocs(res, requestUrl, body, logger = noopHttpLogger) {
  const context = await resolveCompanyBrainReadContext(res, requestUrl, body, logger);
  if (!context) {
    return;
  }

  const limit = parseCompanyBrainLimit(requestUrl, body);
  const readExecution = await runCompanyBrainRead({
    action: "list_company_brain_docs",
    context,
    payload: { limit },
    pathname: requestUrl?.pathname || "/agent/company-brain/docs",
    logger,
  });
  const result = getCompanyBrainReadResult(readExecution);

  logCompanyBrainCollectionRead(logger, "company_brain_list", {
    accountId: context.account.id,
    limit,
    total: result?.data?.total || 0,
  });

  logger.info("agent_bridge_completed", {
    stage: "agent_bridge",
    action: "list_company_brain_docs",
    ok: result.success === true,
    status_code: result.success === true ? 200 : 400,
  });

  jsonResponse(res, result.success === true ? 200 : 400, buildCompanyBrainAgentResult(res, "list_company_brain_docs", result));
}

async function handleAgentSearchCompanyBrainDocs(res, requestUrl, body, logger = noopHttpLogger) {
  const context = await resolveCompanyBrainReadContext(res, requestUrl, body, logger);
  if (!context) {
    return;
  }

  const q = parseCompanyBrainSearchQuery(requestUrl, body);
  const topK = parseCompanyBrainLimit(requestUrl, body, 5);
  const readExecution = await runCompanyBrainRead({
    action: "search_company_brain_docs",
    context,
    payload: {
      q,
      top_k: topK,
    },
    pathname: requestUrl?.pathname || "/agent/company-brain/search",
    logger,
  });
  const result = getCompanyBrainReadResult(readExecution);

  logCompanyBrainCollectionRead(logger, "company_brain_search", {
    accountId: context.account.id,
    q,
    limit: topK,
    total: result?.data?.total || 0,
  });

  logger.info("agent_bridge_completed", {
    stage: "agent_bridge",
    action: "search_company_brain_docs",
    ok: result.success === true,
    status_code: result.success === true ? 200 : 400,
  });

  jsonResponse(res, result.success === true ? 200 : 400, buildCompanyBrainAgentResult(res, "search_company_brain_docs", result));
}

async function handleAgentGetCompanyBrainDocDetail(res, requestUrl, body, logger = noopHttpLogger) {
  const context = await resolveCompanyBrainReadContext(res, requestUrl, body, logger);
  if (!context) {
    return;
  }

  const docId = parseCompanyBrainDocId(requestUrl, body);
  const readExecution = await runCompanyBrainRead({
    action: "get_company_brain_doc_detail",
    context,
    payload: { doc_id: docId },
    pathname: requestUrl?.pathname || "/agent/company-brain/docs/:doc_id",
    logger,
  });
  const result = getCompanyBrainReadResult(readExecution);

  logCompanyBrainDetailRead(logger, {
    accountId: context.account.id,
    docId,
    found: result.success === true,
  });

  const statusCode = result.success === true
    ? 200
    : result.error === "not_found"
      ? 404
      : 400;

  logger.info("agent_bridge_completed", {
    stage: "agent_bridge",
    action: "get_company_brain_doc_detail",
    ok: result.success === true,
    status_code: statusCode,
  });

  jsonResponse(res, statusCode, buildCompanyBrainAgentResult(res, "get_company_brain_doc_detail", result));
}

async function handleAgentListApprovedCompanyBrainKnowledge(res, requestUrl, body, logger = noopHttpLogger) {
  const context = await resolveCompanyBrainReadContext(res, requestUrl, body, logger);
  if (!context) {
    return;
  }

  const limit = parseCompanyBrainLimit(requestUrl, body);
  const readExecution = await runCompanyBrainRead({
    action: "list_approved_company_brain_knowledge",
    context,
    payload: { limit },
    pathname: requestUrl?.pathname || "/agent/company-brain/approved/docs",
    logger,
  });
  const result = getCompanyBrainReadResult(readExecution);

  logCompanyBrainCollectionRead(logger, "company_brain_approved_list", {
    accountId: context.account.id,
    limit,
    total: result?.data?.total || 0,
  });

  logger.info("agent_bridge_completed", {
    stage: "agent_bridge",
    action: "list_approved_company_brain_knowledge",
    ok: result.success === true,
    status_code: getCompanyBrainAgentStatusCode(result),
  });

  jsonResponse(
    res,
    getCompanyBrainAgentStatusCode(result),
    buildCompanyBrainAgentResult(res, "list_approved_company_brain_knowledge", result),
  );
}

async function handleAgentSearchApprovedCompanyBrainKnowledge(res, requestUrl, body, logger = noopHttpLogger) {
  const context = await resolveCompanyBrainReadContext(res, requestUrl, body, logger);
  if (!context) {
    return;
  }

  const q = parseCompanyBrainSearchQuery(requestUrl, body);
  const topK = parseCompanyBrainLimit(requestUrl, body, 5);
  const readExecution = await runCompanyBrainRead({
    action: "search_approved_company_brain_knowledge",
    context,
    payload: {
      q,
      top_k: topK,
    },
    pathname: requestUrl?.pathname || "/agent/company-brain/approved/search",
    logger,
  });
  const result = getCompanyBrainReadResult(readExecution);

  logCompanyBrainCollectionRead(logger, "company_brain_approved_search", {
    accountId: context.account.id,
    q,
    limit: topK,
    total: result?.data?.total || 0,
  });

  logger.info("agent_bridge_completed", {
    stage: "agent_bridge",
    action: "search_approved_company_brain_knowledge",
    ok: result.success === true,
    status_code: getCompanyBrainAgentStatusCode(result),
  });

  jsonResponse(
    res,
    getCompanyBrainAgentStatusCode(result),
    buildCompanyBrainAgentResult(res, "search_approved_company_brain_knowledge", result),
  );
}

async function handleAgentGetApprovedCompanyBrainKnowledgeDetail(res, requestUrl, body, logger = noopHttpLogger) {
  const context = await resolveCompanyBrainReadContext(res, requestUrl, body, logger);
  if (!context) {
    return;
  }

  const docId = parseCompanyBrainDocId(requestUrl, body);
  const readExecution = await runCompanyBrainRead({
    action: "get_approved_company_brain_knowledge_detail",
    context,
    payload: { doc_id: docId },
    pathname: requestUrl?.pathname || "/agent/company-brain/approved/docs/:doc_id",
    logger,
  });
  const result = getCompanyBrainReadResult(readExecution);
  const statusCode = getCompanyBrainAgentStatusCode(result);

  logCompanyBrainDetailRead(logger, {
    accountId: context.account.id,
    docId,
    found: result.success === true,
  });

  logger.info("agent_bridge_completed", {
    stage: "agent_bridge",
    action: "get_approved_company_brain_knowledge_detail",
    ok: result.success === true,
    status_code: statusCode,
  });

  jsonResponse(
    res,
    statusCode,
    buildCompanyBrainAgentResult(res, "get_approved_company_brain_knowledge_detail", result),
  );
}

async function handleAgentReviewCompanyBrainDoc(res, requestUrl, body, logger = noopHttpLogger) {
  const context = await resolveCompanyBrainReadContext(res, requestUrl, body, logger);
  if (!context) {
    return;
  }

  const docId = parseCompanyBrainDocId(requestUrl, body);
  const canonicalRequest = buildCompanyBrainReviewCanonicalRequest({
    pathname: "/agent/company-brain/review",
    method: "POST",
    docId,
    actor: {
      accountId: context.account.id,
    },
    context: {
      idempotencyKey: getRequestIdempotencyKey(body),
      confirmed: true,
      verifierCompleted: true,
      reviewRequiredActive: true,
    },
    originalRequest: body,
  });
  const mutationExecution = await runMutation({
    action: "review_company_brain_doc",
    payload: body,
    context: {
      pathname: "/agent/company-brain/review",
      account_id: context.account.id,
      trace_id: res.__trace_id || null,
      logger,
      canonical_request: canonicalRequest,
      verifier_profile: "knowledge_write_v1",
      verifier_input: {
        account_id: context.account.id,
        doc_id: docId,
        expected_write: "review_state",
      },
    },
    execute: async () => reviewCompanyBrainDocAction({
      accountId: context.account.id,
      docId,
      title: body?.title ?? body?.candidate?.title,
      action: body?.action,
      targetStage: body?.target_stage,
      limit: parseCompanyBrainLimit(requestUrl, body, 6),
      overlapSignal: body?.overlap_signal === true || body?.candidate?.overlap_signal === true,
      replacesExisting: body?.replaces_existing === true || body?.candidate?.replaces_existing === true,
    }),
  });
  const result = mutationExecution.ok
    ? getRuntimeExecutionData(mutationExecution)
    : buildCompanyBrainRuntimeBlockedResult({
        docId,
        error: mutationExecution.error,
      });
  const statusCode = mutationExecution.ok
    ? getCompanyBrainAgentStatusCode(result)
    : 409;

  logger.info("company_brain_review", {
    stage: "company_brain_review",
    action: "review_company_brain_doc",
    account_id: context.account.id,
    doc_id: docId || null,
    ok: result.success === true,
    status_code: statusCode,
    review_status: result?.data?.review_state?.status || null,
  });

  jsonResponse(res, statusCode, buildCompanyBrainAgentResult(res, "review_company_brain_doc", result));
}

async function handleAgentCheckCompanyBrainConflicts(res, requestUrl, body, logger = noopHttpLogger) {
  const context = await resolveCompanyBrainReadContext(res, requestUrl, body, logger);
  if (!context) {
    return;
  }

  const docId = parseCompanyBrainDocId(requestUrl, body);
  const canonicalRequest = buildCompanyBrainConflictCanonicalRequest({
    pathname: "/agent/company-brain/conflicts",
    method: "POST",
    docId,
    actor: {
      accountId: context.account.id,
    },
    context: {
      idempotencyKey: getRequestIdempotencyKey(body),
      confirmed: true,
      verifierCompleted: true,
      reviewRequiredActive: true,
    },
    originalRequest: body,
  });
  const mutationExecution = await runMutation({
    action: "check_company_brain_conflicts",
    payload: body,
    context: {
      pathname: "/agent/company-brain/conflicts",
      account_id: context.account.id,
      trace_id: res.__trace_id || null,
      logger,
      canonical_request: canonicalRequest,
      verifier_profile: "knowledge_write_v1",
      verifier_input: {
        account_id: context.account.id,
        doc_id: docId,
        expected_write: "review_state_optional",
      },
    },
    execute: async () => checkCompanyBrainConflictAction({
      accountId: context.account.id,
      docId,
      title: body?.title ?? body?.candidate?.title,
      action: body?.action,
      targetStage: body?.target_stage,
      limit: parseCompanyBrainLimit(requestUrl, body, 6),
      overlapSignal: body?.overlap_signal === true || body?.candidate?.overlap_signal === true,
      replacesExisting: body?.replaces_existing === true || body?.candidate?.replaces_existing === true,
    }),
  });
  if (!mutationExecution.ok) {
    const result = buildCompanyBrainRuntimeBlockedResult({
      docId,
      error: mutationExecution.error,
    });
    logger.warn("company_brain_conflict_check", {
      stage: "company_brain_conflict_check",
      action: "check_company_brain_conflicts",
      account_id: context.account.id,
      doc_id: docId || null,
      ok: false,
      status_code: 409,
      error: mutationExecution.error || "mutation_verifier_blocked",
    });
    jsonResponse(res, 409, buildCompanyBrainAgentResult(res, "check_company_brain_conflicts", result));
    return;
  }
  const result = getRuntimeExecutionData(mutationExecution);
  if (result?.success !== true) {
    const statusCode = getCompanyBrainAgentStatusCode(result);
    logger.warn("company_brain_conflict_check", {
      stage: "company_brain_conflict_check",
      action: "check_company_brain_conflicts",
      account_id: context.account.id,
      doc_id: docId || null,
      ok: false,
      status_code: statusCode,
      error: result?.error || "business_error",
      conflict_state: result?.data?.conflict_state || null,
      conflict_items: Array.isArray(result?.data?.conflict_items) ? result.data.conflict_items.length : 0,
    });
    jsonResponse(res, statusCode, buildCompanyBrainAgentResult(res, "check_company_brain_conflicts", result));
    return;
  }

  logger.info("company_brain_conflict_check", {
    stage: "company_brain_conflict_check",
    action: "check_company_brain_conflicts",
    account_id: context.account.id,
    doc_id: docId || null,
    ok: true,
    status_code: 200,
    conflict_state: result?.data?.conflict_state || null,
    conflict_items: Array.isArray(result?.data?.conflict_items) ? result.data.conflict_items.length : 0,
  });

  jsonResponse(res, 200, buildCompanyBrainAgentResult(res, "check_company_brain_conflicts", result));
}

async function handleAgentCompanyBrainApprovalTransition(res, requestUrl, body, logger = noopHttpLogger) {
  const context = await resolveCompanyBrainReadContext(res, requestUrl, body, logger);
  if (!context) {
    return;
  }

  const docId = parseCompanyBrainDocId(requestUrl, body);
  const canonicalRequest = buildCompanyBrainApprovalTransitionCanonicalRequest({
    pathname: "/agent/company-brain/approval-transition",
    method: "POST",
    docId,
    actor: {
      accountId: context.account.id,
    },
    context: {
      idempotencyKey: getRequestIdempotencyKey(body),
      confirmed: true,
      verifierCompleted: true,
      reviewRequiredActive: true,
    },
    originalRequest: body,
  });
  const mutationExecution = await runMutation({
    action: "approval_transition_company_brain_doc",
    payload: body,
    context: {
      pathname: "/agent/company-brain/approval-transition",
      account_id: context.account.id,
      trace_id: res.__trace_id || null,
      logger,
      canonical_request: canonicalRequest,
      verifier_profile: "knowledge_write_v1",
      verifier_input: {
        account_id: context.account.id,
        doc_id: docId,
        expected_write: "review_state",
        expected_status: cleanText(body?.decision).toLowerCase() === "approve" ? "approved" : "rejected",
      },
    },
    execute: async () => approvalTransitionCompanyBrainDocAction({
      accountId: context.account.id,
      docId,
      decision: body?.decision,
      notes: body?.notes,
      actor: body?.actor,
    }),
  });
  const result = mutationExecution.ok
    ? getRuntimeExecutionData(mutationExecution)
    : buildCompanyBrainRuntimeBlockedResult({
        docId,
        error: mutationExecution.error,
      });
  const statusCode = mutationExecution.ok
    ? getCompanyBrainAgentStatusCode(result)
    : 409;

  logger.info("company_brain_approval_transition", {
    stage: "company_brain_approval_transition",
    action: "approval_transition_company_brain_doc",
    account_id: context.account.id,
    doc_id: docId || null,
    ok: result.success === true,
    status_code: statusCode,
    decision: result?.data?.decision || null,
    review_status: result?.data?.review_state?.status || null,
  });

  jsonResponse(res, statusCode, buildCompanyBrainAgentResult(res, "approval_transition_company_brain_doc", result));
}

async function handleAgentApplyApprovedCompanyBrainKnowledge(res, requestUrl, body, logger = noopHttpLogger) {
  const context = await resolveCompanyBrainReadContext(res, requestUrl, body, logger);
  if (!context) {
    return;
  }

  const docId = parseCompanyBrainDocId(requestUrl, body);
  const approvalState = getCompanyBrainApprovalState({
    accountId: context.account.id,
    docId,
  }) || {
    review_state: null,
    approval: null,
  };
  const canonicalRequest = buildCompanyBrainApplyCanonicalRequest({
    pathname: "/agent/company-brain/docs/:doc_id/apply",
    method: "POST",
    docId,
    actor: {
      accountId: context.account.id,
    },
    context: {
      idempotencyKey: getRequestIdempotencyKey(body),
      externalWrite: false,
      confirmed: true,
      verifierCompleted: true,
      reviewRequiredActive: true,
    },
    originalRequest: body,
  });
  const mutationExecution = await runMutation({
    action: "apply_company_brain_approved_knowledge",
    payload: body,
    context: {
      pathname: "/agent/company-brain/docs/:doc_id/apply",
      account_id: context.account.id,
      trace_id: res.__trace_id || null,
      logger,
      canonical_request: canonicalRequest,
      verifier_profile: "knowledge_write_v1",
      verifier_input: {
        account_id: context.account.id,
        doc_id: docId,
        expected_write: "approved_knowledge",
      },
    },
    execute: async () => applyApprovedCompanyBrainKnowledgeAction({
      accountId: context.account.id,
      docId,
      actor: body?.actor,
      sourceStage: body?.source_stage,
    }),
  });
  const result = mutationExecution.ok
    ? getRuntimeExecutionData(mutationExecution)
    : buildCompanyBrainRuntimeBlockedResult({
        docId,
        error: mutationExecution.error,
        approvalState,
      });
  const statusCode = mutationExecution.ok
    ? getCompanyBrainAgentStatusCode(result)
    : 409;

  logger.info("company_brain_apply", {
    stage: "company_brain_apply",
    action: "apply_company_brain_approved_knowledge",
    account_id: context.account.id,
    doc_id: docId || null,
    ok: result.success === true,
    status_code: statusCode,
    approved_at: result?.data?.approval?.approved_at || null,
  });

  jsonResponse(res, statusCode, buildCompanyBrainAgentResult(res, "apply_company_brain_approved_knowledge", result));
}

async function handleAgentIngestLearningDoc(res, requestUrl, body, logger = noopHttpLogger) {
  const context = await resolveCompanyBrainReadContext(res, requestUrl, body, logger);
  if (!context) {
    return;
  }

  const docId = parseCompanyBrainDocId(requestUrl, body);
  const canonicalRequest = buildIngestLearningDocCanonicalRequest({
    pathname: "/agent/company-brain/learning/ingest",
    method: "POST",
    docId,
    actor: {
      accountId: context.account.id,
    },
    context: {
      idempotencyKey: getRequestIdempotencyKey(body),
      confirmed: true,
      verifierCompleted: true,
      reviewRequiredActive: false,
    },
    originalRequest: body,
  });
  const mutationExecution = await runMutation({
    action: "ingest_learning_doc",
    payload: body,
    context: {
      pathname: "/agent/company-brain/learning/ingest",
      account_id: context.account.id,
      trace_id: res.__trace_id || null,
      logger,
      canonical_request: canonicalRequest,
      verifier_profile: "knowledge_write_v1",
      verifier_input: {
        account_id: context.account.id,
        doc_id: docId,
        expected_write: "learning_state",
      },
    },
    execute: async () => ingestLearningDocAction({
      accountId: context.account.id,
      docId,
    }),
  });
  const result = mutationExecution.ok
    ? getRuntimeExecutionData(mutationExecution)
    : buildCompanyBrainRuntimeBlockedResult({
        docId,
        error: mutationExecution.error,
      });
  const statusCode = mutationExecution.ok
    ? (
        result.success === true
          ? 200
          : result.error === "not_found"
            ? 404
            : 400
      )
    : 409;

  logger.info("company_brain_learning", {
    stage: "company_brain_learning",
    action: "ingest_learning_doc",
    account_id: context.account.id,
    doc_id: docId || null,
    ok: result.success === true,
    status_code: statusCode,
  });

  jsonResponse(res, statusCode, buildCompanyBrainAgentResult(res, "ingest_learning_doc", result));
}

async function handleAgentUpdateLearningState(res, requestUrl, body, logger = noopHttpLogger) {
  const context = await resolveCompanyBrainReadContext(res, requestUrl, body, logger);
  if (!context) {
    return;
  }

  const docId = parseCompanyBrainDocId(requestUrl, body);
  const canonicalRequest = buildUpdateLearningStateCanonicalRequest({
    pathname: "/agent/company-brain/learning/state",
    method: "POST",
    docId,
    actor: {
      accountId: context.account.id,
    },
    context: {
      idempotencyKey: getRequestIdempotencyKey(body),
      confirmed: true,
      verifierCompleted: true,
      reviewRequiredActive: false,
    },
    originalRequest: body,
  });
  const mutationExecution = await runMutation({
    action: "update_learning_state",
    payload: body,
    context: {
      pathname: "/agent/company-brain/learning/state",
      account_id: context.account.id,
      trace_id: res.__trace_id || null,
      logger,
      canonical_request: canonicalRequest,
      verifier_profile: "knowledge_write_v1",
      verifier_input: {
        account_id: context.account.id,
        doc_id: docId,
        expected_write: "learning_state",
      },
    },
    execute: async () => updateLearningStateAction({
      accountId: context.account.id,
      docId,
      status: body?.status,
      notes: body?.notes,
      tags: Array.isArray(body?.tags) ? body.tags : null,
      key_concepts: Array.isArray(body?.key_concepts) ? body.key_concepts : null,
    }),
  });
  const result = mutationExecution.ok
    ? getRuntimeExecutionData(mutationExecution)
    : buildCompanyBrainRuntimeBlockedResult({
        docId,
        error: mutationExecution.error,
      });
  const statusCode = mutationExecution.ok
    ? (
        result.success === true
          ? 200
          : result.error === "not_found"
            ? 404
            : 400
      )
    : 409;

  logger.info("company_brain_learning", {
    stage: "company_brain_learning",
    action: "update_learning_state",
    account_id: context.account.id,
    doc_id: docId || null,
    ok: result.success === true,
    status_code: statusCode,
  });

  jsonResponse(res, statusCode, buildCompanyBrainAgentResult(res, "update_learning_state", result));
}

async function handleAgentRuntimeInfo(res, requestUrl, body, logger = noopHttpLogger) {
  await invokeAgentBridge(handleRuntimeInfo, {
    requestUrl,
    body,
    logger,
    res,
    action: "get_runtime_info",
  });
}

async function handleCompanyBrainDocsList(res, requestUrl, body, logger = noopHttpLogger) {
  const context = await resolveCompanyBrainReadContext(res, requestUrl, body, logger);
  if (!context) {
    return;
  }

  const limit = parseCompanyBrainLimit(requestUrl, body);
  const readExecution = await runCompanyBrainRead({
    action: "list_company_brain_docs",
    context,
    payload: { limit },
    pathname: requestUrl?.pathname || "/api/company-brain/docs",
    logger,
  });
  const result = getCompanyBrainReadResult(readExecution);
  if (result.success !== true) {
    respondCompanyBrainReadFailure(res, getCompanyBrainAgentStatusCode(result), result.error || "business_error");
    return;
  }
  const items = Array.isArray(result?.data?.items) ? result.data.items.map(buildCompanyBrainDocView) : [];

  logCompanyBrainCollectionRead(logger, "company_brain_list", {
    accountId: context.account.id,
    limit,
    total: Number(result?.data?.total || items.length),
  });

  respondCompanyBrainReadSuccess(res, 200, buildCompanyBrainCollectionResult(context, "company_brain_docs_list", {
    limit,
    total: Number(result?.data?.total || items.length),
    items,
  }));
}

async function handleCompanyBrainDocDetail(res, requestUrl, body, logger = noopHttpLogger) {
  const context = await resolveCompanyBrainReadContext(res, requestUrl, body, logger);
  if (!context) {
    return;
  }

  const docId = parseCompanyBrainDocId(requestUrl, body);
  const readExecution = await runCompanyBrainRead({
    action: "get_company_brain_doc_detail",
    context,
    payload: { doc_id: docId },
    pathname: requestUrl?.pathname || "/api/company-brain/docs/:doc_id",
    logger,
  });
  const result = getCompanyBrainReadResult(readExecution);
  if (result.success !== true) {
    logCompanyBrainDetailRead(logger, {
      accountId: context.account.id,
      docId,
      found: false,
    });
    respondCompanyBrainReadFailure(res, getCompanyBrainAgentStatusCode(result), result.error || "business_error");
    return;
  }
  const item = buildCompanyBrainDocView(result?.data?.doc || null);

  logCompanyBrainDetailRead(logger, {
    accountId: context.account.id,
    docId,
    found: true,
  });

  respondCompanyBrainReadSuccess(res, 200, buildCompanyBrainDetailResult(context, item));
}

async function handleCompanyBrainSearch(res, requestUrl, body, logger = noopHttpLogger) {
  const context = await resolveCompanyBrainReadContext(res, requestUrl, body, logger);
  if (!context) {
    return;
  }

  const q = parseCompanyBrainSearchQuery(requestUrl, body);
  const topK = parseCompanyBrainLimit(requestUrl, body, 5);
  const readExecution = await runCompanyBrainRead({
    action: "search_company_brain_docs",
    context,
    payload: {
      q,
      top_k: topK,
    },
    pathname: requestUrl?.pathname || "/api/company-brain/search",
    logger,
  });
  const result = getCompanyBrainReadResult(readExecution);
  if (result.success !== true) {
    respondCompanyBrainReadFailure(res, getCompanyBrainAgentStatusCode(result), result.error || "business_error");
    return;
  }
  const items = Array.isArray(result?.data?.items) ? result.data.items.map(buildCompanyBrainDocView) : [];

  logCompanyBrainCollectionRead(logger, "company_brain_search", {
    accountId: context.account.id,
    q,
    limit: topK,
    total: Number(result?.data?.total || items.length),
  });

  respondCompanyBrainReadSuccess(res, 200, buildCompanyBrainCollectionResult(context, "company_brain_docs_search", {
    q,
    limit: topK,
    total: Number(result?.data?.total || items.length),
    items,
  }));
}

async function handleDocumentLifecycleRetry(res, requestUrl, body, logger = noopHttpLogger) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body), logger);
  if (!context) {
    return;
  }

  const documentId = String(body.document_id || requestUrl.searchParams.get("document_id") || "").trim();
  const externalKey = String(body.external_key || requestUrl.searchParams.get("external_key") || "").trim();
  if (!documentId && !externalKey) {
    jsonResponse(res, 400, { ok: false, error: "missing_document_id_or_external_key" });
    return;
  }

  const row = documentId
    ? getDocumentByDocumentId(context.account.id, documentId)
    : getDocumentByExternalKey(context.account.id, externalKey);

  if (!row) {
    jsonResponse(res, 404, { ok: false, error: "document_lifecycle_record_not_found" });
    return;
  }

  if (row.status === "create_failed") {
    jsonResponse(res, 409, {
      ok: false,
      error: "document_lifecycle_retry_not_supported",
      message: "create_failed must be retried manually from a new create request.",
      item: buildDocumentLifecycleView(row),
    });
    return;
  }

  if (row.status !== "index_failed" && row.status !== "verify_failed") {
    jsonResponse(res, 409, {
      ok: false,
      error: "document_lifecycle_status_not_retryable",
      item: buildDocumentLifecycleView(row),
    });
    return;
  }

  let parsedMeta = null;
  try {
    parsedMeta = row.meta_json ? JSON.parse(row.meta_json) : null;
  } catch {
    parsedMeta = null;
  }

  const created = {
    document_id: row.document_id || null,
    revision_id: row.revision || null,
    title: row.title || null,
    url: row.url || null,
  };
  const folderToken = parsedMeta?.folder_token || null;
  const retried = await indexApiCreatedDocument({
    account: context.account,
    created,
    folderToken,
    content: row.raw_text || "",
  }).catch((error) => {
    upsertApiLifecycleDocument({
      account: context.account,
      externalKey: row.external_key,
      created,
      folderToken,
      content: row.raw_text || "",
      status: "index_failed",
      failureReason: String(error?.message || "index_failed"),
      createdAt: parsedMeta?.created_at || row.created_at || nowIso(),
    });
    logger.warn("document_lifecycle_retry", {
      stage: "document_lifecycle_retry",
      account_id: context.account.id,
      document_id: row.document_id || null,
      from: row.status,
      to: "index_failed",
    });
    throw error;
  });

  if (row.status === "index_failed") {
    logger.info("document_lifecycle_retry", {
      stage: "document_lifecycle_retry",
      account_id: context.account.id,
      document_id: row.document_id || null,
      from: "index_failed",
      to: "indexed",
    });
  }

  const finalState = retried?.verified ? "verified" : "verify_failed";
  logger[finalState === "verified" ? "info" : "warn"]("document_lifecycle_retry", {
    stage: "document_lifecycle_retry",
    account_id: context.account.id,
    document_id: row.document_id || null,
    from: row.status === "verify_failed" ? "verify_failed" : "indexed",
    to: finalState,
  });

  const refreshed = getDocumentByExternalKey(context.account.id, row.external_key) || row;
  const companyBrainSync = finalState === "verified"
    ? await ingestVerifiedDocumentToCompanyBrain({
        account: context.account,
        row: refreshed,
        logger,
      })
    : null;
  if (finalState === "verified" && companyBrainSync?.success !== true) {
    logger.error("document_lifecycle_retry_company_brain_sync_failed", {
      stage: "company_brain_ingest",
      account_id: context.account.id,
      document_id: row.document_id || null,
      error: companyBrainSync?.error || "company_brain_sync_failed",
      company_brain_stage: companyBrainSync?.stage || null,
    });
    if (respondCompanyBrainSyncFailure(res, companyBrainSync, {
      message: "Document lifecycle retry verified the document, but company-brain ingest/review sync failed.",
      extra: {
        account_id: context.account.id,
        auth_mode: "user_access_token",
        action: "document_lifecycle_retry",
        item: buildDocumentLifecycleView(refreshed),
      },
    })) {
      return;
    }
  }
  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "document_lifecycle_retry",
    item: buildDocumentLifecycleView(refreshed),
  });
}

async function handleDocumentUpdate(res, requestUrl, body, logger = noopHttpLogger) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body), logger);
  if (!context) {
    return;
  }

  const {
    documentId,
    content,
    mode,
    confirm,
    confirmationId,
    targetHeading,
    targetPosition,
  } = buildDocumentUpdateInput(requestUrl, body);
  const explicitWriteTarget = buildExplicitDocumentWriteTarget(body);
  const writesImmediately = !confirm && mode !== "replace" && !targetHeading;
  const earlyExplicitTargetFailure =
    (confirm || writesImmediately)
      ? buildExplicitDocumentWriteTargetFailure(body)
      : null;

  if (earlyExplicitTargetFailure) {
    logger.warn("document_update_missing_explicit_write_target", {
      account_id: context.account.id,
      preview_document_id: documentId || null,
      missing_fields: earlyExplicitTargetFailure.extra?.missing_fields || [],
    });
    respondDocumentWriteFailure(
      res,
      earlyExplicitTargetFailure.statusCode,
      earlyExplicitTargetFailure.error,
      earlyExplicitTargetFailure.extra,
    );
    return;
  }

  if (!documentId || !content) {
    logger.warn("document_update_missing_args", {
      has_document_id: Boolean(documentId),
      has_content: Boolean(content),
    });
    jsonResponse(res, 400, { ok: false, error: "missing_document_id_or_content" });
    return;
  }

  if (targetHeading && mode === "replace") {
    respondDocumentWriteFailure(
      res,
      400,
      "unsupported_target_mode",
      { message: "Heading-targeted update currently supports append semantics only." },
    );
    return;
  }

  let resolvedMode = mode;
  let resolvedContent = content;
  let targeting = null;
  let currentDocument = null;
  let pendingReplaceConfirmation = null;

  if (targetHeading) {
    try {
      currentDocument = await getHttpService("readDocumentFromRuntime", readDocumentFromRuntime)({
        accountId: context.account.id,
        accessToken: context.token,
        documentId,
        pathname: requestUrl?.pathname || "/api/doc/update",
        logger: null,
      });
      const targeted = applyHeadingTargetedInsert(currentDocument.content, content, {
        heading: targetHeading,
        position: targetPosition,
      });
      resolvedMode = "replace";
      resolvedContent = targeted.content;
      targeting = targeted.targeting;
    } catch (error) {
      const failure = buildDocumentTargetingFailure(error);
      if (!failure) {
        throw error;
      }
      logger.warn("document_update_targeting_failed", {
        account_id: context.account.id,
        document_id: documentId,
        target_heading: targetHeading,
        error: failure.error,
      });
      respondDocumentWriteFailure(res, failure.statusCode, failure.error, failure.extra);
      return;
    }
  }

  if (resolvedMode === "replace") {
    logger.info("document_replace_preview_or_apply_started", {
      account_id: context.account.id,
      document_id: documentId,
      confirm,
      target_heading: targetHeading || null,
    });
    const current = currentDocument
      || await getHttpService("readDocumentFromRuntime", readDocumentFromRuntime)({
        accountId: context.account.id,
        accessToken: context.token,
        documentId,
        pathname: requestUrl?.pathname || "/api/doc/update",
        logger: null,
      });
    currentDocument = current;

    if (!confirm) {
      const preview = await createDocumentReplaceConfirmation({
        accountId: context.account.id,
        documentId,
        title: current.title,
        currentRevisionId: current.revision_id,
        currentContent: current.content,
        proposedContent: resolvedContent,
      });

      respondDocumentWriteSuccess(res, 200, buildDocumentReplacePreviewResult({
        context,
        preview,
        targeting,
        message: targetHeading
          ? "Heading-targeted update needs explicit confirmation. Re-submit with confirm=true, document_id, section_heading, and confirmation_id."
          : undefined,
      }));
      return;
    }

    const explicitTargetFailure = buildExplicitDocumentWriteTargetFailure(body);
    if (explicitTargetFailure) {
      logger.warn("document_update_missing_explicit_write_target", {
        account_id: context.account.id,
        preview_document_id: documentId,
        missing_fields: explicitTargetFailure.extra?.missing_fields || [],
      });
      respondDocumentWriteFailure(
        res,
        explicitTargetFailure.statusCode,
        explicitTargetFailure.error,
        explicitTargetFailure.extra,
      );
      return;
    }

    const finalDocumentId = explicitWriteTarget.documentId;
    if (!confirmationId) {
      respondDocumentWriteFailure(
        res,
        400,
        "missing_confirmation_id",
        { message: "Replace mode requires confirmation_id when confirm=true." },
      );
      return;
    }

    pendingReplaceConfirmation = await peekDocumentReplaceConfirmation({
      confirmationId,
      accountId: context.account.id,
      documentId: finalDocumentId,
      proposedContent: resolvedContent,
    });

    if (!pendingReplaceConfirmation) {
      respondDocumentWriteFailure(
        res,
        400,
        "invalid_or_expired_confirmation",
        { message: "The replace confirmation is missing, expired, or no longer matches this document/content." },
      );
      return;
    }

    if (
      pendingReplaceConfirmation.current_revision_id &&
      current.revision_id &&
      pendingReplaceConfirmation.current_revision_id !== current.revision_id
    ) {
      respondDocumentWriteFailure(
        res,
        409,
        "stale_confirmation",
        {
          message: "The document changed after preview. Create a new replace preview first.",
          current_revision_id: current.revision_id,
        },
      );
      return;
    }
  }

  const explicitTargetFailure = buildExplicitDocumentWriteTargetFailure(body);
  if (explicitTargetFailure) {
    logger.warn("document_update_missing_explicit_write_target", {
      account_id: context.account.id,
      preview_document_id: documentId,
      missing_fields: explicitTargetFailure.extra?.missing_fields || [],
    });
    respondDocumentWriteFailure(
      res,
      explicitTargetFailure.statusCode,
      explicitTargetFailure.error,
      explicitTargetFailure.extra,
    );
    return;
  }
  const finalDocumentId = explicitWriteTarget.documentId;

  logger.info("document_update_started", {
    account_id: context.account.id,
    document_id: finalDocumentId,
    mode: resolvedMode,
    target_heading: targetHeading || null,
  });
  const canonicalRequest = buildUpdateDocCanonicalRequest({
    pathname: "/api/doc/update",
    method: "POST",
    documentId: finalDocumentId,
    actor: {
      accountId: context.account.id,
    },
    context: {
      actionType: resolvedMode === "replace" ? "replace" : "update",
      confirmRequired: resolvedMode === "replace",
      idempotencyKey: getRequestIdempotencyKey(body),
      confirmed: resolvedMode === "replace"
        ? confirm === true && Boolean(confirmationId)
        : true,
      verifierCompleted: true,
      reviewRequiredActive: false,
    },
    originalRequest: body,
  });
  const mutationExecution = await runCanonicalLarkMutation({
    action: "update_doc",
    pathname: "/api/doc/update",
    accountId: context.account.id,
    accessToken: context.token,
    logger,
    traceId: res.__trace_id || null,
    canonicalRequest,
    payload: {
      document_id: finalDocumentId,
      content: resolvedContent,
      mode: resolvedMode,
      target_heading: targetHeading || null,
      target_position: targetPosition || null,
      confirmation_id: confirmationId || null,
      confirm: confirm === true,
    },
    confirmation: resolvedMode === "replace"
      ? {
          kind: "document_replace",
          requireConfirm: true,
          confirm,
          requireConfirmationId: true,
          confirmationId,
          pending: pendingReplaceConfirmation,
          consume: async () => consumeDocumentReplaceConfirmation({
            confirmationId,
            accountId: context.account.id,
            documentId: finalDocumentId,
            proposedContent: resolvedContent,
          }),
        }
      : {
          kind: "document_update",
          requireConfirm: false,
          confirm,
        },
    budget: {
      sessionKey: context.account.id,
      scopeKey: `document:${finalDocumentId}`,
      documentId: finalDocumentId,
      targetDocumentId: finalDocumentId,
      content: resolvedContent,
      payload: {
        mode: resolvedMode,
        target_heading: targetHeading || null,
        target_position: targetPosition || null,
      },
    },
    performWrite: async ({ accessToken }) => getHttpService("updateDocument", updateDocument)(
      accessToken,
      finalDocumentId,
      resolvedContent,
      resolvedMode,
    ),
  });
  if (!mutationExecution.ok) {
    respondWriteExecutionFailure(
      res,
      mutationExecution,
      mutationExecution.error === "execution_failed" ? 500 : 409,
    );
    return;
  }
  const execution = getRuntimeExecutionData(mutationExecution);
  if (!execution?.ok) {
    respondWriteExecutionFailure(res, execution, execution.error === "execution_failed" ? 500 : 409);
    return;
  }
  const result = execution.result;
  logger.info("document_update_completed", {
    account_id: context.account.id,
    document_id: finalDocumentId,
    mode: resolvedMode,
    target_heading: targetHeading || null,
  });
  const reviewSyncExecution = await runCompanyBrainReviewSyncMutation({
    accountId: context.account.id,
    docId: finalDocumentId,
    title: currentDocument?.title || null,
    action: "update_doc",
    targetStage: "mirror",
    pathname: "internal:company-brain/update-doc-review",
    logger,
    traceId: res.__trace_id || null,
  });
  if (!reviewSyncExecution?.ok) {
    logger.error("document_company_brain_update_review_stage_failed", {
      stage: "company_brain_review_state",
      account_id: context.account.id,
      doc_id: finalDocumentId,
      error: reviewSyncExecution?.error || "mutation_verifier_blocked",
      verifier: getRuntimeExecutionData(reviewSyncExecution)?.verifier || null,
    });
    respondWriteExecutionFailure(
      res,
      reviewSyncExecution,
      reviewSyncExecution?.error === "execution_failed" ? 500 : 409,
    );
    return;
  }
  const reviewResult = getRuntimeExecutionData(reviewSyncExecution);
  if (reviewResult?.success !== true) {
    logger.error("document_company_brain_update_review_stage_failed", {
      stage: "company_brain_review_state",
      account_id: context.account.id,
      doc_id: finalDocumentId,
      error: reviewResult?.error || "business_error",
      review_state: reviewResult?.data?.review_state || null,
      approval_state: reviewResult?.data?.approval_state || null,
    });
    respondDocumentWriteFailure(
      res,
      getCompanyBrainAgentStatusCode(reviewResult),
      reviewResult?.error || "company_brain_review_sync_failed",
      {
        message: "Document update completed, but company-brain review sync failed.",
        review_state: reviewResult?.data?.review_state || null,
        approval_state: reviewResult?.data?.approval_state || null,
      },
    );
    return;
  }
  const intakeBoundary = reviewResult?.data?.intake_boundary || null;
  logger.info("document_company_brain_update_boundary", {
    stage: "company_brain_write_intake_boundary",
    account_id: context.account.id,
    doc_id: finalDocumentId,
    intake_state: intakeBoundary?.intake_state || null,
    review_status: intakeBoundary?.review_status || null,
    review_required: intakeBoundary?.review_required === true,
    conflict_check_required: intakeBoundary?.conflict_check_required === true,
    approval_required_for_formal_source: intakeBoundary?.approval_required_for_formal_source === true,
    target_stage: intakeBoundary?.target_stage || null,
  });
  respondDocumentWriteSuccess(res, 200, buildDocumentUpdateResult({
    context,
    mode: resolvedMode,
    result,
    targeting,
  }));
}

async function handleDocumentComments(res, requestUrl, body) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) {
    return;
  }

  const documentId = resolveDocumentIdFromRequest(requestUrl, body);
  if (!documentId) {
    jsonResponse(res, 400, { ok: false, error: "missing_document_id" });
    return;
  }

  const includeSolved = String(requestUrl.searchParams.get("include_solved") || body.include_solved || "").trim();
  const result = await getHttpService("listDocumentCommentsFromRuntime", listDocumentCommentsFromRuntime)({
    accountId: context.account.id,
    accessToken: context.token,
    documentId,
    includeSolved: includeSolved === "true",
    pathname: requestUrl?.pathname || "/api/doc/comments",
    logger: null,
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "document_comments",
    ...result,
  });
}

async function handleDocumentRewriteFromComments(res, requestUrl, body, logger = noopHttpLogger) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body), logger);
  if (!context) {
    return;
  }

  const documentId = resolveDocumentIdFromRequest(requestUrl, body);
  if (!documentId) {
    jsonResponse(res, 400, { ok: false, error: "missing_document_id" });
    return;
  }

  const commentIds = Array.isArray(body.comment_ids)
    ? body.comment_ids.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const apply = body.apply === true;
  const confirm = body.confirm === true;
  const confirmationId = String(body.confirmation_id || "").trim();
  const resolveComments = Boolean(body.resolve_comments);
  const workflowScope = buildDocumentRewriteWorkflowScope(documentId);

  if (!apply) {
    const preview = await getHttpService("prepareDocumentCommentRewritePreview", prepareDocumentCommentRewritePreview)({
      accountId: context.account.id,
      accessToken: context.token,
      documentId,
      scope: workflowScope,
      includeSolved: Boolean(body.include_solved),
      commentIds,
      resolveComments,
      route: "document_rewrite_from_comments_preview",
      readDocumentFn: getHttpService("readDocumentFromRuntime", readDocumentFromRuntime),
      rewriteDocumentFn: getHttpService("rewriteDocumentFromComments", rewriteDocumentFromComments),
    });
    const { result, confirmation } = preview;
    if (!result.comment_count) {
      jsonResponse(res, 200, {
        ok: true,
        account_id: context.account.id,
        auth_mode: "user_access_token",
        action: "document_rewrite_from_comments_preview",
        ...result,
      });
      return;
    }
    jsonResponse(res, 200, buildDocumentRewritePreviewResponse({
      context,
      result,
      confirmation,
      workflowScope,
    }));
    return;
  }
  const applyState = await loadDocumentCommentRewriteApplyState({
    accountId: context.account.id,
    documentId,
    confirmationId,
    scope: workflowScope,
  });

  const canonicalRequest = buildDocumentCommentRewriteApplyCanonicalRequest({
    pathname: "/api/doc/rewrite-from-comments",
    method: "POST",
    documentId,
    actor: {
      accountId: context.account.id,
    },
    context: {
      idempotencyKey: getRequestIdempotencyKey(body),
      confirmed: confirm === true && Boolean(confirmationId),
      verifierCompleted: applyState.reviewReady,
      reviewRequiredActive: true,
    },
    originalRequest: body,
  });
  const rewriteRollbackState = {};
  const mutationAudit = {
    boundary: "document_comment_rewrite_apply",
    nested_mutations: [],
  };
  const mutationExecution = await runCanonicalLarkMutation({
    action: "document_comment_rewrite_apply",
    pathname: "/api/doc/rewrite-from-comments",
    accountId: context.account.id,
    accessToken: context.token,
    logger,
    traceId: res.__trace_id || null,
    canonicalRequest,
    audit: mutationAudit,
    rollback: async () => rollbackRewrittenDocument(context.token, documentId, {
      rollbackState: rewriteRollbackState,
      mutationAudit,
      updateDocumentFn: getHttpService("updateDocument", updateDocument),
      resolveCommentFn: getHttpService("resolveDocumentComment", resolveDocumentComment),
    }),
    payload: {
      document_id: documentId,
      confirmation_id: confirmationId,
      comment_ids: applyState.pendingConfirmation?.comment_ids || [],
      resolve_comments: applyState.pendingConfirmation?.resolve_comments === true,
    },
    confirmation: {
      kind: "comment_rewrite",
      requireConfirm: true,
      confirm,
      requireConfirmationId: true,
      confirmationId,
      pending: applyState.pendingConfirmation,
      peek: async () => peekCommentRewriteConfirmation({
        confirmationId,
        accountId: context.account.id,
        documentId,
      }),
      validate: async ({ confirmation }) => {
        const current = await getHttpService("readDocumentFromRuntime", readDocumentFromRuntime)({
          accountId: context.account.id,
          accessToken: context.token,
          documentId,
          pathname: requestUrl?.pathname || "/api/doc/rewrite-from-comments",
          logger: null,
        });
        if (
          confirmation?.current_revision_id
          && current?.revision_id
          && confirmation.current_revision_id !== current.revision_id
        ) {
          return {
            ok: false,
            statusCode: 409,
            error: "stale_confirmation",
            message: "The document changed after preview. Generate a fresh rewrite preview first.",
            extra: {
              current_revision_id: current.revision_id,
            },
          };
        }
        return {
          ok: true,
          confirmation,
        };
      },
      consume: async () => consumeCommentRewriteConfirmation({
        confirmationId,
        accountId: context.account.id,
        documentId,
      }),
      invalidMessage: "The rewrite confirmation is missing or expired. Generate a fresh preview first.",
    },
    budget: ({ confirmation }) => ({
      sessionKey: context.account.id,
      scopeKey: workflowScope,
      documentId,
      targetDocumentId: documentId,
      content: confirmation?.rewritten_content || "",
      payload: {
        confirmation_id: confirmationId,
        comment_ids: confirmation?.comment_ids || [],
        resolve_comments: confirmation?.resolve_comments === true,
      },
      essential: true,
    }),
    performWrite: async ({ accessToken, confirmation }) => {
        const applyingTask = await markDocRewriteApplying({
          accountId: context.account.id,
          scope: workflowScope,
          confirmationId,
          meta: buildDocumentRewriteTaskMeta("document_rewrite_from_comments_apply", {
            confirmation_id: confirmationId,
          }),
        });
        if (!applyingTask?.id) {
          throw new Error("doc_rewrite_review_not_ready");
        }

        return applyRewrittenDocument(
          accessToken,
          documentId,
          confirmation.rewritten_content,
          {
            patchPlan: confirmation.patch_plan || [],
            resolveCommentIds: confirmation.resolve_comments ? confirmation.comment_ids : [],
            rollbackState: rewriteRollbackState,
            mutationAudit,
            readDocument: getHttpService("readDocumentFromRuntime", readDocumentFromRuntime),
            updateDocumentFn: getHttpService("updateDocument", updateDocument),
            resolveCommentFn: getHttpService("resolveDocumentComment", resolveDocumentComment),
          },
        );
      },
  });
  if (!mutationExecution.ok) {
    respondDocumentRewriteFailure(
      res,
      Number(getRuntimeExecutionData(mutationExecution)?.statusCode || (mutationExecution.error === "execution_failed" ? 500 : 409)),
      mutationExecution.error,
      getRuntimeExecutionData(mutationExecution)?.message,
      {
        write_guard: getRuntimeExecutionData(mutationExecution)?.write_guard || null,
        ...(Array.isArray(getRuntimeExecutionData(mutationExecution)?.violation_types)
          ? { violation_types: getRuntimeExecutionData(mutationExecution).violation_types }
          : {}),
      },
    );
    return;
  }
  const execution = getRuntimeExecutionData(mutationExecution);
  if (!execution?.ok) {
    respondDocumentRewriteFailure(
      res,
      Number(getRuntimeExecutionData(execution)?.statusCode || (execution.error === "execution_failed" ? 500 : 409)),
      execution.error,
      getRuntimeExecutionData(execution)?.message,
      { write_guard: getRuntimeExecutionData(execution)?.write_guard || null },
    );
    return;
  }
  const confirmation = applyState.pendingConfirmation;
  const applied = execution.result;
  const finalized = await finalizeDocRewriteWorkflowTask({
    accountId: context.account.id,
    scope: workflowScope,
    structuredResult: applied.structured_result,
    extraEvidence: [
      {
        type: "file_updated",
        summary: `document:${documentId}`,
      },
      {
        type: "API_call_success",
        summary: "document_rewrite_apply_succeeded",
      },
    ],
  });

  jsonResponse(res, 200, buildDocumentRewriteApplyResponse({
    context,
    documentId,
    confirmation,
    applied,
    finalized,
    workflowScope,
  }));
}

async function handleDocumentCommentSuggestionCard(res, requestUrl, body) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) {
    return;
  }

  const documentId = resolveDocumentIdFromRequest(requestUrl, body);
  if (!documentId) {
    jsonResponse(res, 400, { ok: false, error: "missing_document_id" });
    return;
  }

  const result = await getHttpService("generateDocumentCommentSuggestionCard", generateDocumentCommentSuggestionCard)({
    accessToken: context.token,
    accountId: context.account.id,
    documentId,
    messageId: String(body.message_id || body.notify_message_id || "").trim(),
    replyInThread: body.reply_in_thread === true,
    resolveComments: Boolean(body.resolve_comments),
    markSeen: body.mark_seen !== false,
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "document_comment_suggestion_card",
    ...result,
  });
}

async function handleDocumentCommentSuggestionPoll(res) {
  const result = await runCommentSuggestionPollOnce();
  jsonResponse(res, 200, result);
}

async function handleMeetingProcess(res, requestUrl, body, logger = noopHttpLogger) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body), logger);
  if (!context) {
    return;
  }

  const transcriptText = normalizeText(
    body.content || body.transcript || body.text || body.merged_text || "",
  );
  if (!transcriptText) {
    logger.warn("meeting_process_missing_content");
    jsonResponse(res, 400, { ok: false, error: "missing_meeting_content" });
    return;
  }

  const metadata = typeof body.metadata === "object" && body.metadata ? body.metadata : {};
  logger.info("meeting_process_started", {
    account_id: context.account.id,
    chat_id: String(body.chat_id || body.group_id || "").trim() || null,
    transcript_chars: transcriptText.length,
  });
  const result = await meetingCoordinator.processMeetingPreview({
    accountId: context.account.id,
    accessToken: context.token,
    transcriptText,
    metadata,
    chatId: String(body.chat_id || body.group_id || "").trim(),
    groupChatId: String(body.group_chat_id || body.target_chat_id || body.chat_id || "").trim(),
    projectName: String(body.project_name || "").trim(),
    sourceMeetingId: String(body.source_meeting_id || "").trim(),
  });
  logger.info("meeting_process_completed", {
    account_id: context.account.id,
    confirmation_id: result.confirmation_id || null,
    group_chat_id: result.group_chat_id || null,
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "meeting_process_preview",
    ...result,
  });
}

async function handleMeetingConfirm(res, requestUrl, body, logger = noopHttpLogger) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body), logger);
  if (!context) {
    return;
  }

  const confirmationId = String(body.confirmation_id || "").trim();
  if (!confirmationId) {
    logger.warn("meeting_confirm_missing_confirmation_id");
    jsonResponse(res, 400, { ok: false, error: "missing_confirmation_id" });
    return;
  }

  const pendingConfirmation = await peekMeetingWriteConfirmation({
    confirmationId,
    accountId: context.account.id,
  });
  const canonicalRequest = pendingConfirmation
    ? buildMeetingConfirmWriteCanonicalRequest({
        pathname: "/api/meeting/confirm",
        method: "POST",
        confirmationId,
        targetDocumentId: pendingConfirmation.target_document_id,
        actor: {
          accountId: context.account.id,
        },
        context: {
          idempotencyKey: getRequestIdempotencyKey(body),
          confirmed: true,
          verifierCompleted: Boolean(
            normalizeText(pendingConfirmation.summary_content)
            && normalizeText(pendingConfirmation.doc_entry_content),
          ),
          reviewRequiredActive: false,
        },
        originalRequest: body,
      })
    : null;

  logger.info("meeting_confirm_started", {
    account_id: context.account.id,
    confirmation_id: confirmationId,
  });
  const result = await meetingCoordinator.confirmMeetingWrite({
    accountId: context.account.id,
    accessToken: context.token,
    confirmationId,
    logger,
    canonicalRequest,
    traceId: res.__trace_id || null,
    pathname: "/api/meeting/confirm",
  });
  if (!result) {
    logger.warn("meeting_confirm_invalid_or_expired", {
      account_id: context.account.id,
      confirmation_id: confirmationId,
    });
    jsonResponse(res, 400, {
      ok: false,
      error: "invalid_or_expired_confirmation",
      message: "Meeting confirmation is missing, expired, or no longer matches this account.",
    });
    return;
  }
  if (
    result.ok === false
    && (result.error === "write_guard_denied" || result.error === "write_policy_enforcement_blocked")
  ) {
    logger.warn("meeting_confirm_blocked_by_write_guard", {
      account_id: context.account.id,
      confirmation_id: confirmationId,
      write_guard: result.write_guard || null,
    });
    jsonResponse(res, getWriteGuardStatusCode(result.write_guard), {
      ok: false,
      error: result.error,
      message: result.message,
      write_guard: result.write_guard || null,
    });
    return;
  }

  logger.info("meeting_confirm_completed", {
    account_id: context.account.id,
    confirmation_id: confirmationId,
    document_id: result.target_document?.document_id || null,
  });
  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "meeting_confirm_write",
    ...result,
  });
}

async function handleMeetingConfirmPage(res, requestUrl, body, logger = noopHttpLogger) {
  const accountId = getAccountId(requestUrl, body);
  const context = await resolveAccountContext(accountId);
  if (!context?.token?.access_token) {
    htmlResponse(
      res,
      401,
      [
        "<h1>龍蝦需要先登入 Lark</h1>",
        `<p><a href="${oauthBaseUrl}/oauth/lark/login">先完成授權</a>，再回來點一次確認按鈕。</p>`,
      ].join(""),
    );
    return;
  }

  const confirmationId = String(requestUrl.searchParams.get("confirmation_id") || "").trim();
  if (!confirmationId) {
    htmlResponse(res, 400, "<h1>缺少 confirmation_id</h1>");
    return;
  }

  const pendingConfirmation = await peekMeetingWriteConfirmation({
    confirmationId,
    accountId: context.account.id,
  });
  const canonicalRequest = pendingConfirmation
    ? buildMeetingConfirmWriteCanonicalRequest({
        pathname: "/meeting/confirm",
        method: "GET",
        confirmationId,
        targetDocumentId: pendingConfirmation.target_document_id,
        actor: {
          accountId: context.account.id,
        },
        context: {
          confirmed: true,
          verifierCompleted: Boolean(
            normalizeText(pendingConfirmation.summary_content)
            && normalizeText(pendingConfirmation.doc_entry_content),
          ),
          reviewRequiredActive: false,
        },
        originalRequest: {
          account_id: context.account.id,
          confirmation_id: confirmationId,
        },
      })
    : null;

  const result = await meetingCoordinator.confirmMeetingWrite({
    accountId: context.account.id,
    accessToken: context.token,
    confirmationId,
    canonicalRequest,
    traceId: res.__trace_id || null,
    pathname: "/meeting/confirm",
  });

  if (!result) {
    htmlResponse(
      res,
      400,
      "<h1>確認失效或已使用</h1><p>請重新執行 /meeting 產生新的待確認摘要。</p>",
    );
    return;
  }
  if (
    result.ok === false
    && (result.error === "write_guard_denied" || result.error === "write_policy_enforcement_blocked")
  ) {
    htmlResponse(
      res,
      getWriteGuardStatusCode(result.write_guard),
      `<h1>外部寫入被阻擋</h1><p>${result.message || buildWriteGuardMessage(result.write_guard)}</p>`,
    );
    return;
  }

  htmlResponse(
    res,
    200,
    [
      "<h1>已完成會議文檔寫入</h1>",
      `<p>會議類型：${result.meeting_type}</p>`,
      `<p>文檔：${result.target_document.title || result.target_document.document_id}</p>`,
      result.write_result?.deduplicated
        ? "<p>這次內容與現有紀要重複，因此未重複插入。</p>"
        : "<p>新紀要已插在文檔最上方。</p>",
    ].join(""),
  );
}

async function handleMessagesList(res, requestUrl, body, logger = noopHttpLogger) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body), logger);
  if (!context) {
    return;
  }

  const containerId = String(requestUrl.searchParams.get("container_id") || body.container_id || "").trim();
  const containerIdType = String(
    requestUrl.searchParams.get("container_id_type") || body.container_id_type || "chat",
  ).trim();

  if (!containerId) {
    logger.warn("messages_list_missing_container_id");
    jsonResponse(res, 400, { ok: false, error: "missing_container_id" });
    return;
  }

  logger.info("messages_list_started", {
    account_id: context.account.id,
    container_id_type: containerIdType,
  });
  const result = await listMessages(context.token, containerId, {
    containerIdType,
    startTime: requestUrl.searchParams.get("start_time") || body.start_time || undefined,
    endTime: requestUrl.searchParams.get("end_time") || body.end_time || undefined,
    sortType: requestUrl.searchParams.get("sort_type") || body.sort_type || undefined,
    pageToken: requestUrl.searchParams.get("page_token") || body.page_token || undefined,
  });
  logger.info("messages_list_completed", {
    account_id: context.account.id,
    total: result.items?.length || result.total || null,
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "messages_list",
    ...result,
  });
}

async function handleMessageSearch(res, requestUrl, body) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) {
    return;
  }

  const containerId = String(requestUrl.searchParams.get("container_id") || body.container_id || "").trim();
  const keyword = String(requestUrl.searchParams.get("q") || body.q || body.keyword || "").trim();
  const containerIdType = String(
    requestUrl.searchParams.get("container_id_type") || body.container_id_type || "chat",
  ).trim();
  const limit = Number.parseInt(requestUrl.searchParams.get("limit") || body.limit || "20", 10);

  if (!containerId || !keyword) {
    jsonResponse(res, 400, { ok: false, error: "missing_container_id_or_query" });
    return;
  }

  const result = await searchMessages(context.token, containerId, keyword, {
    containerIdType,
    startTime: requestUrl.searchParams.get("start_time") || body.start_time || undefined,
    endTime: requestUrl.searchParams.get("end_time") || body.end_time || undefined,
    sortType: requestUrl.searchParams.get("sort_type") || body.sort_type || undefined,
    limit: Number.isFinite(limit) ? Math.max(1, Math.min(limit, 50)) : 20,
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "messages_search",
    ...result,
  });
}

async function handleMessageGet(res, requestUrl, body, messageId) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) {
    return;
  }

  const result = await getMessage(context.token, messageId);
  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "message_get",
    ...result,
  });
}

async function handleMessageReply(res, requestUrl, body, logger = noopHttpLogger) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body), logger);
  if (!context) {
    return;
  }

  const messageId = String(body.message_id || "").trim();
  const content = String(body.content || body.text || "").trim();
  const replyInThread = body.reply_in_thread === true;
  const cardTitle = typeof body.card_title === "string" ? body.card_title.trim() : undefined;

  if (!messageId || !content) {
    logger.warn("message_reply_missing_args", {
      has_message_id: Boolean(messageId),
      has_content: Boolean(content),
    });
    jsonResponse(res, 400, { ok: false, error: "missing_message_id_or_content" });
    return;
  }

  logger.info("message_reply_started", {
    account_id: context.account.id,
    reply_in_thread: replyInThread,
    as_card: Boolean(cardTitle),
  });
  const execution = await executeCanonicalLarkMutation({
    action: "message_reply",
    pathname: requestUrl.pathname,
    accountId: context.account.id,
    accessToken: context.token,
    logger,
    resourceId: messageId,
    scopeKey: `message:${messageId}`,
    idempotencyKey: getRequestIdempotencyKey(body),
    payload: {
      message_id: messageId,
      content,
      reply_in_thread: replyInThread,
      card_title: cardTitle || null,
    },
    originalRequest: body,
    budget: {
      sessionKey: context.account.id,
      scopeKey: `message:${messageId}`,
      documentId: messageId,
      targetDocumentId: messageId,
      content,
      payload: {
        message_id: messageId,
        content,
        reply_in_thread: replyInThread,
        card_title: cardTitle || null,
      },
      idempotencyKey: getRequestIdempotencyKey(body),
    },
    performWrite: async ({ accessToken }) => replyMessage(accessToken, messageId, content, {
      replyInThread,
      cardTitle,
    }),
  });
  if (!execution.ok) {
    respondWriteExecutionFailure(res, execution);
    return;
  }
  const result = execution.result;
  logger.info("message_reply_completed", {
    account_id: context.account.id,
    message_id: messageId,
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: cardTitle ? "message_reply_card" : "message_reply",
    ...result,
  });
}

async function handleCalendarPrimary(res, requestUrl, body) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) {
    return;
  }

  const result = await getPrimaryCalendar(context.token);
  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "calendar_primary",
    ...result,
  });
}

async function handleCalendarEvents(res, requestUrl, body) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) {
    return;
  }

  const calendarId = String(requestUrl.searchParams.get("calendar_id") || body.calendar_id || "").trim();
  if (!calendarId) {
    jsonResponse(res, 400, { ok: false, error: "missing_calendar_id" });
    return;
  }

  const result = await listCalendarEvents(context.token, calendarId, {
    pageToken: requestUrl.searchParams.get("page_token") || body.page_token || undefined,
    startTime: requestUrl.searchParams.get("start_time") || body.start_time || undefined,
    endTime: requestUrl.searchParams.get("end_time") || body.end_time || undefined,
    anchorTime: requestUrl.searchParams.get("anchor_time") || body.anchor_time || undefined,
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "calendar_events",
    ...result,
  });
}

async function handleCalendarSearch(res, requestUrl, body) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) {
    return;
  }

  const calendarId = String(body.calendar_id || requestUrl.searchParams.get("calendar_id") || "").trim();
  const query = String(body.q || body.query || requestUrl.searchParams.get("q") || "").trim();
  if (!calendarId || !query) {
    jsonResponse(res, 400, { ok: false, error: "missing_calendar_id_or_query" });
    return;
  }

  const result = await searchCalendarEvents(context.token, calendarId, query);
  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "calendar_search",
    ...result,
  });
}

async function handleCalendarCreateEvent(res, requestUrl, body, logger = noopHttpLogger) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body), logger);
  if (!context) {
    return;
  }

  const calendarId = String(body.calendar_id || "").trim();
  const summary = String(body.summary || "").trim();
  const startTime = String(body.start_time || "").trim();
  const endTime = String(body.end_time || "").trim();

  if (!calendarId || !summary || !startTime || !endTime) {
    logger.warn("calendar_create_event_missing_args", {
      account_id: context.account.id,
      has_calendar_id: Boolean(calendarId),
      has_summary: Boolean(summary),
      has_start_time: Boolean(startTime),
      has_end_time: Boolean(endTime),
    });
    jsonResponse(res, 400, { ok: false, error: "missing_calendar_id_summary_start_time_or_end_time" });
    return;
  }

  const reminders = Array.isArray(body.reminders)
    ? body.reminders.map((value) => Number.parseInt(`${value}`, 10)).filter(Number.isFinite)
    : [];

  logger.info("calendar_create_event_started", {
    account_id: context.account.id,
    calendar_id: calendarId,
    reminders: reminders.length,
  });
  const eventPayload = {
    summary,
    description: typeof body.description === "string" ? body.description.trim() : undefined,
    startTime,
    endTime,
    timezone: typeof body.timezone === "string" && body.timezone.trim() ? body.timezone.trim() : "Asia/Taipei",
    reminders,
  };
  const execution = await executeCanonicalLarkMutation({
    action: "calendar_create_event",
    pathname: requestUrl.pathname,
    accountId: context.account.id,
    accessToken: context.token,
    logger,
    resourceId: calendarId,
    scopeKey: `calendar:${calendarId}`,
    idempotencyKey: getRequestIdempotencyKey(body),
    payload: {
      calendar_id: calendarId,
      ...eventPayload,
    },
    originalRequest: body,
    budget: {
      sessionKey: context.account.id,
      scopeKey: `calendar:${calendarId}`,
      targetDocumentId: calendarId,
      content: JSON.stringify(eventPayload),
      payload: {
        calendar_id: calendarId,
        ...eventPayload,
      },
      idempotencyKey: getRequestIdempotencyKey(body),
    },
    performWrite: async ({ accessToken }) => getHttpService("createCalendarEvent", createCalendarEvent)(
      accessToken,
      calendarId,
      eventPayload,
    ),
  });
  if (!execution.ok) {
    respondWriteExecutionFailure(res, execution);
    return;
  }
  const result = execution.result;
  logger.info("calendar_create_event_completed", {
    account_id: context.account.id,
    calendar_id: calendarId,
    event_id: result.event?.event_id || result.data?.event_id || null,
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "calendar_create_event",
    ...result,
  });
}

async function handleTasksList(res, requestUrl, body) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) {
    return;
  }

  const completedParam = requestUrl.searchParams.get("completed");
  const completed =
    typeof body.completed === "boolean"
      ? body.completed
      : completedParam === "true"
        ? true
        : completedParam === "false"
          ? false
          : undefined;

  const result = await listTasks(context.token, {
    pageToken: requestUrl.searchParams.get("page_token") || body.page_token || undefined,
    startCreateTime: requestUrl.searchParams.get("start_create_time") || body.start_create_time || undefined,
    endCreateTime: requestUrl.searchParams.get("end_create_time") || body.end_create_time || undefined,
    completed,
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "tasks_list",
    ...result,
  });
}

async function handleTaskGet(res, requestUrl, body, taskId, logger = noopHttpLogger) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body), logger);
  if (!context) {
    return;
  }

  logger.info("task_get_started", {
    account_id: context.account.id,
    task_id: taskId,
  });
  const result = await getHttpService("getTask", getTask)(context.token, taskId);
  logger.info("task_get_completed", {
    account_id: context.account.id,
    task_id: taskId,
  });
  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "task_get",
    ...result,
  });
}

async function handleTaskCreate(res, requestUrl, body, logger = noopHttpLogger) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body), logger);
  if (!context) {
    return;
  }

  const summary = String(body.summary || "").trim();
  if (!summary) {
    logger.warn("task_create_missing_summary", {
      account_id: context.account.id,
    });
    jsonResponse(res, 400, { ok: false, error: "missing_task_summary" });
    return;
  }

  logger.info("task_create_started", {
    account_id: context.account.id,
    has_due_time: Boolean(body.due_time),
    has_link_url: Boolean(body.link_url),
  });
  const taskPayload = {
    summary,
    description: typeof body.description === "string" ? body.description.trim() : undefined,
    dueTime: typeof body.due_time === "string" ? body.due_time.trim() : undefined,
    timezone: typeof body.timezone === "string" && body.timezone.trim() ? body.timezone.trim() : "Asia/Taipei",
    linkUrl: typeof body.link_url === "string" ? body.link_url.trim() : undefined,
    linkTitle: typeof body.link_title === "string" ? body.link_title.trim() : undefined,
  };
  const execution = await executeCanonicalLarkMutation({
    action: "task_create",
    pathname: requestUrl.pathname,
    accountId: context.account.id,
    accessToken: context.token,
    logger,
    resourceId: context.account.id,
    scopeKey: `task:create:${context.account.id}`,
    idempotencyKey: getRequestIdempotencyKey(body),
    payload: taskPayload,
    originalRequest: body,
    budget: {
      sessionKey: context.account.id,
      scopeKey: `task:create:${context.account.id}`,
      content: JSON.stringify(taskPayload),
      payload: taskPayload,
      idempotencyKey: getRequestIdempotencyKey(body),
    },
    performWrite: async ({ accessToken }) => getHttpService("createTask", createTask)(accessToken, taskPayload),
  });
  if (!execution.ok) {
    respondWriteExecutionFailure(res, execution);
    return;
  }
  const result = execution.result;
  logger.info("task_create_completed", {
    account_id: context.account.id,
    task_id: result.task?.task_id || result.data?.task_id || null,
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "task_create",
    ...result,
  });
}

async function handleBitableAppCreate(res, requestUrl, body) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) return;

  const name = String(body.name || "").trim();
  if (!name) {
    jsonResponse(res, 400, { ok: false, error: "missing_bitable_name" });
    return;
  }

  const appPayload = {
    name,
    folderToken: typeof body.folder_token === "string" ? body.folder_token.trim() : undefined,
    timeZone: typeof body.time_zone === "string" ? body.time_zone.trim() : undefined,
    customizedConfig: typeof body.customized_config === "boolean" ? body.customized_config : undefined,
    sourceAppToken: typeof body.source_app_token === "string" ? body.source_app_token.trim() : undefined,
    copyTypes: Array.isArray(body.copy_types) ? body.copy_types : undefined,
    apiType: typeof body.api_type === "string" ? body.api_type.trim() : undefined,
  };
  const execution = await executeCanonicalLarkMutation({
    action: "bitable_app_create",
    pathname: requestUrl.pathname,
    accountId: context.account.id,
    accessToken: context.token,
    resourceId: appPayload.folderToken || context.account.id,
    scopeKey: `bitable_app:${appPayload.folderToken || "root"}`,
    idempotencyKey: getRequestIdempotencyKey(body),
    payload: appPayload,
    originalRequest: body,
    budget: {
      sessionKey: context.account.id,
      scopeKey: `bitable_app:${appPayload.folderToken || "root"}`,
      targetDocumentId: appPayload.folderToken || null,
      content: JSON.stringify(appPayload),
      payload: appPayload,
      idempotencyKey: getRequestIdempotencyKey(body),
    },
    performWrite: async ({ accessToken }) => getHttpService("createBitableApp", createBitableApp)(accessToken, appPayload),
  });
  if (!execution.ok) {
    respondWriteExecutionFailure(res, execution);
    return;
  }
  const result = execution.result;

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "bitable_app_create",
    ...result,
  });
}

async function handleBitableAppGet(res, requestUrl, body, appToken) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) return;

  const result = await getBitableApp(context.token, appToken);
  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "bitable_app_get",
    ...result,
  });
}

async function handleBitableAppUpdate(res, requestUrl, body, appToken) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) return;

  const appPayload = {
    name: typeof body.name === "string" ? body.name.trim() : undefined,
    isAdvanced: typeof body.is_advanced === "boolean" ? body.is_advanced : undefined,
  };
  const execution = await executeCanonicalLarkMutation({
    action: "bitable_app_update",
    pathname: requestUrl.pathname,
    accountId: context.account.id,
    accessToken: context.token,
    resourceId: appToken,
    scopeKey: `bitable_app:${appToken}`,
    idempotencyKey: getRequestIdempotencyKey(body),
    payload: {
      app_token: appToken,
      ...appPayload,
    },
    originalRequest: body,
    budget: {
      sessionKey: context.account.id,
      scopeKey: `bitable_app:${appToken}`,
      documentId: appToken,
      targetDocumentId: appToken,
      content: JSON.stringify(appPayload),
      payload: {
        app_token: appToken,
        ...appPayload,
      },
      idempotencyKey: getRequestIdempotencyKey(body),
    },
    performWrite: async ({ accessToken }) => getHttpService("updateBitableApp", updateBitableApp)(
      accessToken,
      appToken,
      appPayload,
    ),
  });
  if (!execution.ok) {
    respondWriteExecutionFailure(res, execution);
    return;
  }
  const result = execution.result;

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "bitable_app_update",
    ...result,
  });
}

async function handleBitableTablesList(res, requestUrl, body, appToken) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) return;

  const pageSize = Number.parseInt(requestUrl.searchParams.get("page_size") || body.page_size || "50", 10);
  const result = await listBitableTables(context.token, appToken, {
    pageToken: requestUrl.searchParams.get("page_token") || body.page_token || undefined,
    pageSize: Number.isFinite(pageSize) ? Math.max(1, Math.min(pageSize, 100)) : 50,
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "bitable_tables_list",
    ...result,
  });
}

async function handleBitableTableCreate(res, requestUrl, body, appToken) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) return;

  const name = String(body.name || "").trim();
  if (!name) {
    jsonResponse(res, 400, { ok: false, error: "missing_table_name" });
    return;
  }

  const tablePayload = {
    name,
    defaultViewName: typeof body.default_view_name === "string" ? body.default_view_name.trim() : undefined,
    fields: Array.isArray(body.fields) ? body.fields : [],
  };
  const execution = await executeCanonicalLarkMutation({
    action: "bitable_table_create",
    pathname: requestUrl.pathname,
    accountId: context.account.id,
    accessToken: context.token,
    resourceId: appToken,
    scopeKey: `bitable_table:${appToken}`,
    idempotencyKey: getRequestIdempotencyKey(body),
    payload: {
      app_token: appToken,
      ...tablePayload,
    },
    originalRequest: body,
    budget: {
      sessionKey: context.account.id,
      scopeKey: `bitable_table:${appToken}`,
      documentId: appToken,
      targetDocumentId: appToken,
      content: JSON.stringify(tablePayload),
      payload: {
        app_token: appToken,
        ...tablePayload,
      },
      idempotencyKey: getRequestIdempotencyKey(body),
    },
    performWrite: async ({ accessToken }) => getHttpService("createBitableTable", createBitableTable)(
      accessToken,
      appToken,
      tablePayload,
    ),
  });
  if (!execution.ok) {
    respondWriteExecutionFailure(res, execution);
    return;
  }
  const result = execution.result;

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "bitable_table_create",
    ...result,
  });
}

async function handleBitableRecordsList(res, requestUrl, body, appToken, tableId, logger = noopHttpLogger) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body), logger);
  if (!context) return;

  const pageSize = Number.parseInt(requestUrl.searchParams.get("page_size") || body.page_size || "50", 10);
  const fieldNames = requestUrl.searchParams.getAll("field_name");
  logger.info("bitable_records_list_started", {
    account_id: context.account.id,
    app_token: appToken,
    table_id: tableId,
    page_size: Number.isFinite(pageSize) ? Math.max(1, Math.min(pageSize, 100)) : 50,
  });
  const result = await getHttpService("listBitableRecords", listBitableRecords)(
    context.token,
    appToken,
    tableId,
    {
    pageToken: requestUrl.searchParams.get("page_token") || body.page_token || undefined,
    pageSize: Number.isFinite(pageSize) ? Math.max(1, Math.min(pageSize, 100)) : 50,
    viewId: requestUrl.searchParams.get("view_id") || body.view_id || undefined,
    fieldNames: fieldNames.length ? fieldNames : Array.isArray(body.field_names) ? body.field_names : undefined,
    sort: requestUrl.searchParams.get("sort") || body.sort || undefined,
    filter: requestUrl.searchParams.get("filter") || body.filter || undefined,
    automaticFields: body.automatic_fields === true || requestUrl.searchParams.get("automatic_fields") === "true",
    userIdType: requestUrl.searchParams.get("user_id_type") || body.user_id_type || undefined,
    }
  );
  logger.info("bitable_records_list_completed", {
    account_id: context.account.id,
    app_token: appToken,
    table_id: tableId,
    total_items: Array.isArray(result.items) ? result.items.length : null,
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "bitable_records_list",
    ...result,
  });
}

async function handleBitableRecordsSearch(res, requestUrl, body, appToken, tableId, logger = noopHttpLogger) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body), logger);
  if (!context) return;

  logger.info("bitable_records_search_started", {
    account_id: context.account.id,
    app_token: appToken,
    table_id: tableId,
    has_filter: body.filter != null,
  });
  const result = await getHttpService("searchBitableRecords", searchBitableRecords)(
    context.token,
    appToken,
    tableId,
    {
    pageToken: typeof body.page_token === "string" ? body.page_token.trim() : undefined,
    pageSize: Number.isFinite(Number(body.page_size)) ? Math.max(1, Math.min(Number(body.page_size), 100)) : 50,
    viewId: typeof body.view_id === "string" ? body.view_id.trim() : undefined,
    fieldNames: Array.isArray(body.field_names) ? body.field_names : undefined,
    sort: Array.isArray(body.sort) ? body.sort : [],
    filter: body.filter,
    automaticFields: body.automatic_fields === true,
    userIdType: typeof body.user_id_type === "string" ? body.user_id_type.trim() : undefined,
    }
  );
  logger.info("bitable_records_search_completed", {
    account_id: context.account.id,
    app_token: appToken,
    table_id: tableId,
    total_items: Array.isArray(result.items) ? result.items.length : null,
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "bitable_records_search",
    ...result,
  });
}

async function handleBitableRecordCreate(res, requestUrl, body, appToken, tableId, logger = noopHttpLogger) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body), logger);
  if (!context) return;

  if (!body.fields || typeof body.fields !== "object") {
    logger.warn("bitable_record_create_missing_fields", {
      account_id: context.account.id,
      app_token: appToken,
      table_id: tableId,
    });
    jsonResponse(res, 400, { ok: false, error: "missing_record_fields" });
    return;
  }

  logger.info("bitable_record_create_started", {
    account_id: context.account.id,
    app_token: appToken,
    table_id: tableId,
  });
  const recordPayload = {
    fields: body.fields,
    userIdType: typeof body.user_id_type === "string" ? body.user_id_type.trim() : undefined,
    clientToken: typeof body.client_token === "string" ? body.client_token.trim() : undefined,
    ignoreConsistencyCheck: body.ignore_consistency_check === true,
  };
  const execution = await executeCanonicalLarkMutation({
    action: "bitable_record_create",
    pathname: requestUrl.pathname,
    accountId: context.account.id,
    accessToken: context.token,
    logger,
    resourceId: tableId,
    scopeKey: `bitable_record:${appToken}:${tableId}`,
    idempotencyKey: getRequestIdempotencyKey(body),
    payload: {
      app_token: appToken,
      table_id: tableId,
      ...recordPayload,
    },
    originalRequest: body,
    budget: {
      sessionKey: context.account.id,
      scopeKey: `bitable_record:${appToken}:${tableId}`,
      targetDocumentId: tableId,
      content: JSON.stringify(recordPayload),
      payload: {
        app_token: appToken,
        table_id: tableId,
        ...recordPayload,
      },
      idempotencyKey: getRequestIdempotencyKey(body),
    },
    performWrite: async ({ accessToken }) => getHttpService("createBitableRecord", createBitableRecord)(
      accessToken,
      appToken,
      tableId,
      recordPayload,
    ),
  });
  if (!execution.ok) {
    respondWriteExecutionFailure(res, execution);
    return;
  }
  const result = execution.result;
  logger.info("bitable_record_create_completed", {
    account_id: context.account.id,
    app_token: appToken,
    table_id: tableId,
    record_id: result.record?.record_id || result.data?.record_id || null,
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "bitable_record_create",
    ...result,
  });
}

async function handleBitableRecordGet(res, requestUrl, body, appToken, tableId, recordId, logger = noopHttpLogger) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body), logger);
  if (!context) return;

  logger.info("bitable_record_get_started", {
    account_id: context.account.id,
    app_token: appToken,
    table_id: tableId,
    record_id: recordId,
  });
  const result = await getHttpService("getBitableRecord", getBitableRecord)(
    context.token,
    appToken,
    tableId,
    recordId,
    {
    userIdType: requestUrl.searchParams.get("user_id_type") || body.user_id_type || undefined,
    withSharedUrl: requestUrl.searchParams.get("with_shared_url") === "true" || body.with_shared_url === true,
    automaticFields: requestUrl.searchParams.get("automatic_fields") === "true" || body.automatic_fields === true,
    }
  );
  logger.info("bitable_record_get_completed", {
    account_id: context.account.id,
    app_token: appToken,
    table_id: tableId,
    record_id: recordId,
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "bitable_record_get",
    ...result,
  });
}

async function handleBitableRecordUpdate(res, requestUrl, body, appToken, tableId, recordId, logger = noopHttpLogger) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body), logger);
  if (!context) return;

  if (!body.fields || typeof body.fields !== "object") {
    logger.warn("bitable_record_update_missing_fields", {
      account_id: context.account.id,
      app_token: appToken,
      table_id: tableId,
      record_id: recordId,
    });
    jsonResponse(res, 400, { ok: false, error: "missing_record_fields" });
    return;
  }

  logger.info("bitable_record_update_started", {
    account_id: context.account.id,
    app_token: appToken,
    table_id: tableId,
    record_id: recordId,
  });
  const recordPayload = {
    fields: body.fields,
    userIdType: typeof body.user_id_type === "string" ? body.user_id_type.trim() : undefined,
  };
  const execution = await executeCanonicalLarkMutation({
    action: "bitable_record_update",
    pathname: requestUrl.pathname,
    accountId: context.account.id,
    accessToken: context.token,
    logger,
    resourceId: recordId,
    scopeKey: `bitable_record:${appToken}:${tableId}`,
    idempotencyKey: getRequestIdempotencyKey(body),
    payload: {
      app_token: appToken,
      table_id: tableId,
      record_id: recordId,
      ...recordPayload,
    },
    originalRequest: body,
    budget: {
      sessionKey: context.account.id,
      scopeKey: `bitable_record:${appToken}:${tableId}`,
      documentId: recordId,
      targetDocumentId: tableId,
      content: JSON.stringify(recordPayload),
      payload: {
        app_token: appToken,
        table_id: tableId,
        record_id: recordId,
        ...recordPayload,
      },
      idempotencyKey: getRequestIdempotencyKey(body),
    },
    performWrite: async ({ accessToken }) => getHttpService("updateBitableRecord", updateBitableRecord)(
      accessToken,
      appToken,
      tableId,
      recordId,
      recordPayload,
    ),
  });
  if (!execution.ok) {
    respondWriteExecutionFailure(res, execution);
    return;
  }
  const result = execution.result;
  logger.info("bitable_record_update_completed", {
    account_id: context.account.id,
    app_token: appToken,
    table_id: tableId,
    record_id: recordId,
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "bitable_record_update",
    ...result,
  });
}

async function handleBitableRecordDelete(res, requestUrl, body, appToken, tableId, recordId, logger = noopHttpLogger) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body), logger);
  if (!context) return;

  logger.info("bitable_record_delete_started", {
    account_id: context.account.id,
    app_token: appToken,
    table_id: tableId,
    record_id: recordId,
  });
  const execution = await executeCanonicalLarkMutation({
    action: "bitable_record_delete",
    pathname: requestUrl.pathname,
    accountId: context.account.id,
    accessToken: context.token,
    logger,
    resourceId: recordId,
    scopeKey: `bitable_record:${appToken}:${tableId}`,
    idempotencyKey: getRequestIdempotencyKey(body),
    payload: {
      app_token: appToken,
      table_id: tableId,
      record_id: recordId,
    },
    originalRequest: body,
    budget: {
      sessionKey: context.account.id,
      scopeKey: `bitable_record:${appToken}:${tableId}`,
      documentId: recordId,
      targetDocumentId: tableId,
      content: recordId,
      payload: {
        app_token: appToken,
        table_id: tableId,
        record_id: recordId,
      },
      idempotencyKey: getRequestIdempotencyKey(body),
    },
    performWrite: async ({ accessToken }) => getHttpService("deleteBitableRecord", deleteBitableRecord)(
      accessToken,
      appToken,
      tableId,
      recordId,
    ),
  });
  if (!execution.ok) {
    respondWriteExecutionFailure(res, execution);
    return;
  }
  const result = execution.result;
  logger.info("bitable_record_delete_completed", {
    account_id: context.account.id,
    app_token: appToken,
    table_id: tableId,
    record_id: recordId,
  });
  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "bitable_record_delete",
    ...result,
  });
}

async function handleBitableRecordsBulkUpsert(res, requestUrl, body, appToken, tableId, logger = noopHttpLogger) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body), logger);
  if (!context) return;
  if (!Array.isArray(body.records) || !body.records.length) {
    logger.warn("bitable_records_bulk_upsert_missing_records", {
      account_id: context.account.id,
      app_token: appToken,
      table_id: tableId,
    });
    jsonResponse(res, 400, { ok: false, error: "missing_bulk_records" });
    return;
  }

  logger.info("bitable_records_bulk_upsert_started", {
    account_id: context.account.id,
    app_token: appToken,
    table_id: tableId,
    record_count: body.records.length,
  });
  const bulkPayload = {
    records: body.records,
    userIdType: body.user_id_type,
  };
  const execution = await executeCanonicalLarkMutation({
    action: "bitable_records_bulk_upsert",
    pathname: requestUrl.pathname,
    accountId: context.account.id,
    accessToken: context.token,
    logger,
    resourceId: tableId,
    scopeKey: `bitable_record:${appToken}:${tableId}`,
    idempotencyKey: getRequestIdempotencyKey(body),
    payload: {
      app_token: appToken,
      table_id: tableId,
      ...bulkPayload,
    },
    originalRequest: body,
    budget: {
      sessionKey: context.account.id,
      scopeKey: `bitable_record:${appToken}:${tableId}`,
      targetDocumentId: tableId,
      content: JSON.stringify(bulkPayload),
      payload: {
        app_token: appToken,
        table_id: tableId,
        ...bulkPayload,
      },
      idempotencyKey: getRequestIdempotencyKey(body),
    },
    performWrite: async ({ accessToken }) => getHttpService("bulkUpsertBitableRecords", bulkUpsertBitableRecords)(
      accessToken,
      appToken,
      tableId,
      bulkPayload,
    ),
  });
  if (!execution.ok) {
    respondWriteExecutionFailure(res, execution);
    return;
  }
  const result = execution.result;
  logger.info("bitable_records_bulk_upsert_completed", {
    account_id: context.account.id,
    app_token: appToken,
    table_id: tableId,
    total_records: Array.isArray(result.records) ? result.records.length : null,
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "bitable_records_bulk_upsert",
    ...result,
  });
}

async function handleSpreadsheetCreate(res, requestUrl, body) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) return;

  const title = String(body.title || "").trim();
  if (!title) {
    jsonResponse(res, 400, { ok: false, error: "missing_spreadsheet_title" });
    return;
  }

  const spreadsheetPayload = {
    title,
    folderToken: typeof body.folder_token === "string" ? body.folder_token.trim() : undefined,
  };
  const execution = await executeCanonicalLarkMutation({
    action: "spreadsheet_create",
    pathname: requestUrl.pathname,
    accountId: context.account.id,
    accessToken: context.token,
    resourceId: spreadsheetPayload.folderToken || context.account.id,
    scopeKey: `spreadsheet:create:${spreadsheetPayload.folderToken || "root"}`,
    idempotencyKey: getRequestIdempotencyKey(body),
    payload: spreadsheetPayload,
    originalRequest: body,
    budget: {
      sessionKey: context.account.id,
      scopeKey: `spreadsheet:create:${spreadsheetPayload.folderToken || "root"}`,
      targetDocumentId: spreadsheetPayload.folderToken || null,
      content: JSON.stringify(spreadsheetPayload),
      payload: spreadsheetPayload,
      idempotencyKey: getRequestIdempotencyKey(body),
    },
    performWrite: async ({ accessToken }) => getHttpService("createSpreadsheet", createSpreadsheet)(
      accessToken,
      spreadsheetPayload,
    ),
  });
  if (!execution.ok) {
    respondWriteExecutionFailure(res, execution);
    return;
  }
  const result = execution.result;

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "spreadsheet_create",
    ...result,
  });
}

async function handleSpreadsheetGet(res, requestUrl, body, spreadsheetToken) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) return;

  const result = await getSpreadsheet(context.token, spreadsheetToken);
  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "spreadsheet_get",
    ...result,
  });
}

async function handleSpreadsheetUpdate(res, requestUrl, body, spreadsheetToken) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) return;

  const title = String(body.title || "").trim();
  if (!title) {
    jsonResponse(res, 400, { ok: false, error: "missing_spreadsheet_title" });
    return;
  }

  const spreadsheetPayload = { title };
  const execution = await executeCanonicalLarkMutation({
    action: "spreadsheet_update",
    pathname: requestUrl.pathname,
    accountId: context.account.id,
    accessToken: context.token,
    resourceId: spreadsheetToken,
    scopeKey: `spreadsheet:${spreadsheetToken}`,
    idempotencyKey: getRequestIdempotencyKey(body),
    payload: {
      spreadsheet_token: spreadsheetToken,
      ...spreadsheetPayload,
    },
    originalRequest: body,
    budget: {
      sessionKey: context.account.id,
      scopeKey: `spreadsheet:${spreadsheetToken}`,
      documentId: spreadsheetToken,
      targetDocumentId: spreadsheetToken,
      content: JSON.stringify(spreadsheetPayload),
      payload: {
        spreadsheet_token: spreadsheetToken,
        ...spreadsheetPayload,
      },
      idempotencyKey: getRequestIdempotencyKey(body),
    },
    performWrite: async ({ accessToken }) => getHttpService("updateSpreadsheet", updateSpreadsheet)(
      accessToken,
      spreadsheetToken,
      spreadsheetPayload,
    ),
  });
  if (!execution.ok) {
    respondWriteExecutionFailure(res, execution);
    return;
  }
  const result = execution.result;
  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "spreadsheet_update",
    ...result,
  });
}

async function handleSpreadsheetSheetsList(res, requestUrl, body, spreadsheetToken) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) return;

  const result = await listSpreadsheetSheets(context.token, spreadsheetToken);
  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "spreadsheet_sheets_list",
    ...result,
  });
}

async function handleSpreadsheetSheetGet(res, requestUrl, body, spreadsheetToken, sheetId) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) return;

  const result = await getSpreadsheetSheet(context.token, spreadsheetToken, sheetId);
  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "spreadsheet_sheet_get",
    ...result,
  });
}

async function handleSpreadsheetReplace(res, requestUrl, body, spreadsheetToken, sheetId) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) return;

  const range = String(body.range || "").trim();
  const find = String(body.find || "").trim();
  const replacement = String(body.replacement || "").trim();
  if (!range || !find) {
    jsonResponse(res, 400, { ok: false, error: "missing_range_or_find" });
    return;
  }

  const replacePayload = {
    range,
    find,
    replacement,
    matchCase: body.match_case === true,
    matchEntireCell: body.match_entire_cell === true,
    searchByRegex: body.search_by_regex === true,
    includeFormulas: body.include_formulas === true,
  };
  const execution = await executeCanonicalLarkMutation({
    action: "spreadsheet_replace",
    pathname: requestUrl.pathname,
    accountId: context.account.id,
    accessToken: context.token,
    resourceId: sheetId,
    scopeKey: `spreadsheet:${spreadsheetToken}:${sheetId}`,
    idempotencyKey: getRequestIdempotencyKey(body),
    payload: {
      spreadsheet_token: spreadsheetToken,
      sheet_id: sheetId,
      ...replacePayload,
    },
    originalRequest: body,
    budget: {
      sessionKey: context.account.id,
      scopeKey: `spreadsheet:${spreadsheetToken}:${sheetId}`,
      documentId: spreadsheetToken,
      targetDocumentId: sheetId,
      content: JSON.stringify(replacePayload),
      payload: {
        spreadsheet_token: spreadsheetToken,
        sheet_id: sheetId,
        ...replacePayload,
      },
      idempotencyKey: getRequestIdempotencyKey(body),
    },
    performWrite: async ({ accessToken }) => getHttpService("replaceSpreadsheetCells", replaceSpreadsheetCells)(
      accessToken,
      spreadsheetToken,
      sheetId,
      replacePayload,
    ),
  });
  if (!execution.ok) {
    respondWriteExecutionFailure(res, execution);
    return;
  }
  const result = execution.result;

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "spreadsheet_replace",
    ...result,
  });
}

async function handleSpreadsheetReplaceBatch(res, requestUrl, body, spreadsheetToken, sheetId) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) return;
  if (!Array.isArray(body.replacements) || !body.replacements.length) {
    jsonResponse(res, 400, { ok: false, error: "missing_replacements" });
    return;
  }

  const batchPayload = { replacements: body.replacements };
  const execution = await executeCanonicalLarkMutation({
    action: "spreadsheet_replace_batch",
    pathname: requestUrl.pathname,
    accountId: context.account.id,
    accessToken: context.token,
    resourceId: sheetId,
    scopeKey: `spreadsheet:${spreadsheetToken}:${sheetId}`,
    idempotencyKey: getRequestIdempotencyKey(body),
    payload: {
      spreadsheet_token: spreadsheetToken,
      sheet_id: sheetId,
      ...batchPayload,
    },
    originalRequest: body,
    budget: {
      sessionKey: context.account.id,
      scopeKey: `spreadsheet:${spreadsheetToken}:${sheetId}`,
      documentId: spreadsheetToken,
      targetDocumentId: sheetId,
      content: JSON.stringify(batchPayload),
      payload: {
        spreadsheet_token: spreadsheetToken,
        sheet_id: sheetId,
        ...batchPayload,
      },
      idempotencyKey: getRequestIdempotencyKey(body),
    },
    performWrite: async ({ accessToken }) => getHttpService("replaceSpreadsheetCellsBatch", replaceSpreadsheetCellsBatch)(
      accessToken,
      spreadsheetToken,
      sheetId,
      batchPayload,
    ),
  });
  if (!execution.ok) {
    respondWriteExecutionFailure(res, execution);
    return;
  }
  const result = execution.result;

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "spreadsheet_replace_batch",
    ...result,
  });
}

async function handleCalendarFreebusy(res, requestUrl, body, logger = noopHttpLogger) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body), logger);
  if (!context) return;

  const timeMin = String(body.time_min || requestUrl.searchParams.get("time_min") || "").trim();
  const timeMax = String(body.time_max || requestUrl.searchParams.get("time_max") || "").trim();
  if (!timeMin || !timeMax) {
    logger.warn("calendar_freebusy_missing_args", {
      account_id: context.account.id,
      has_time_min: Boolean(timeMin),
      has_time_max: Boolean(timeMax),
    });
    jsonResponse(res, 400, { ok: false, error: "missing_time_min_or_time_max" });
    return;
  }

  logger.info("calendar_freebusy_started", {
    account_id: context.account.id,
    has_user_id: Boolean(body.user_id || requestUrl.searchParams.get("user_id")),
    has_room_id: Boolean(body.room_id || requestUrl.searchParams.get("room_id")),
  });
  const result = await getHttpService("listFreebusy", listFreebusy)(context.token, {
    timeMin,
    timeMax,
    userId: typeof body.user_id === "string" ? body.user_id.trim() : requestUrl.searchParams.get("user_id") || undefined,
    roomId: typeof body.room_id === "string" ? body.room_id.trim() : requestUrl.searchParams.get("room_id") || undefined,
    userIdType:
      (typeof body.user_id_type === "string" && body.user_id_type.trim()) ||
      requestUrl.searchParams.get("user_id_type") ||
      "open_id",
    includeExternalCalendar:
      body.include_external_calendar === true || requestUrl.searchParams.get("include_external_calendar") === "true",
    onlyBusy: body.only_busy === true || requestUrl.searchParams.get("only_busy") === "true",
  });
  logger.info("calendar_freebusy_completed", {
    account_id: context.account.id,
    items: Array.isArray(result.items) ? result.items.length : null,
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "calendar_freebusy",
    ...result,
  });
}

async function handleTaskCommentsList(res, requestUrl, body, taskId, logger = noopHttpLogger) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body), logger);
  if (!context) return;

  const pageSize = Number.parseInt(requestUrl.searchParams.get("page_size") || body.page_size || "50", 10);
  logger.info("task_comments_list_started", {
    account_id: context.account.id,
    task_id: taskId,
    page_size: Number.isFinite(pageSize) ? Math.max(1, Math.min(pageSize, 100)) : 50,
  });
  const result = await getHttpService("listTaskComments", listTaskComments)(context.token, taskId, {
    pageToken: requestUrl.searchParams.get("page_token") || body.page_token || undefined,
    pageSize: Number.isFinite(pageSize) ? Math.max(1, Math.min(pageSize, 100)) : 50,
    listDirection: requestUrl.searchParams.get("list_direction") || body.list_direction || undefined,
    userIdType: requestUrl.searchParams.get("user_id_type") || body.user_id_type || "open_id",
  });
  logger.info("task_comments_list_completed", {
    account_id: context.account.id,
    task_id: taskId,
    total_items: Array.isArray(result.items) ? result.items.length : null,
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "task_comments_list",
    ...result,
  });
}

async function handleTaskCommentCreate(res, requestUrl, body, taskId, logger = noopHttpLogger) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body), logger);
  if (!context) return;

  const content = String(body.content || "").trim();
  if (!content && !String(body.rich_content || "").trim()) {
    logger.warn("task_comment_create_missing_content", {
      account_id: context.account.id,
      task_id: taskId,
    });
    jsonResponse(res, 400, { ok: false, error: "missing_comment_content" });
    return;
  }

  logger.info("task_comment_create_started", {
    account_id: context.account.id,
    task_id: taskId,
    has_parent_id: Boolean(body.parent_id),
  });
  const commentPayload = {
    content: content || undefined,
    richContent: typeof body.rich_content === "string" ? body.rich_content.trim() : undefined,
    parentId: typeof body.parent_id === "string" ? body.parent_id.trim() : undefined,
    userIdType: typeof body.user_id_type === "string" ? body.user_id_type.trim() : undefined,
  };
  const execution = await executeCanonicalLarkMutation({
    action: "task_comment_create",
    pathname: requestUrl.pathname,
    accountId: context.account.id,
    accessToken: context.token,
    logger,
    resourceId: taskId,
    scopeKey: `task_comment:${taskId}`,
    idempotencyKey: getRequestIdempotencyKey(body),
    payload: {
      task_id: taskId,
      ...commentPayload,
    },
    originalRequest: body,
    budget: {
      sessionKey: context.account.id,
      scopeKey: `task_comment:${taskId}`,
      targetDocumentId: taskId,
      content: content || commentPayload.richContent || "",
      payload: {
        task_id: taskId,
        ...commentPayload,
      },
      idempotencyKey: getRequestIdempotencyKey(body),
    },
    performWrite: async ({ accessToken }) => getHttpService("createTaskComment", createTaskComment)(
      accessToken,
      taskId,
      commentPayload,
    ),
  });
  if (!execution.ok) {
    respondWriteExecutionFailure(res, execution);
    return;
  }
  const result = execution.result;
  logger.info("task_comment_create_completed", {
    account_id: context.account.id,
    task_id: taskId,
    comment_id: result.comment?.comment_id || result.data?.comment_id || null,
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "task_comment_create",
    ...result,
  });
}

async function handleTaskCommentGet(res, requestUrl, body, taskId, commentId, logger = noopHttpLogger) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body), logger);
  if (!context) return;

  logger.info("task_comment_get_started", {
    account_id: context.account.id,
    task_id: taskId,
    comment_id: commentId,
  });
  const result = await getHttpService("getTaskComment", getTaskComment)(context.token, taskId, commentId, {
    userIdType: requestUrl.searchParams.get("user_id_type") || body.user_id_type || "open_id",
  });
  logger.info("task_comment_get_completed", {
    account_id: context.account.id,
    task_id: taskId,
    comment_id: commentId,
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "task_comment_get",
    ...result,
  });
}

async function handleTaskCommentUpdate(res, requestUrl, body, taskId, commentId, logger = noopHttpLogger) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body), logger);
  if (!context) return;

  const content = String(body.content || "").trim();
  if (!content && !String(body.rich_content || "").trim()) {
    logger.warn("task_comment_update_missing_content", {
      account_id: context.account.id,
      task_id: taskId,
      comment_id: commentId,
    });
    jsonResponse(res, 400, { ok: false, error: "missing_comment_content" });
    return;
  }

  logger.info("task_comment_update_started", {
    account_id: context.account.id,
    task_id: taskId,
    comment_id: commentId,
  });
  const commentPayload = {
    content: content || undefined,
    richContent: typeof body.rich_content === "string" ? body.rich_content.trim() : undefined,
    userIdType: typeof body.user_id_type === "string" ? body.user_id_type.trim() : undefined,
  };
  const execution = await executeCanonicalLarkMutation({
    action: "task_comment_update",
    pathname: requestUrl.pathname,
    accountId: context.account.id,
    accessToken: context.token,
    logger,
    resourceId: commentId,
    scopeKey: `task_comment:${taskId}`,
    idempotencyKey: getRequestIdempotencyKey(body),
    payload: {
      task_id: taskId,
      comment_id: commentId,
      ...commentPayload,
    },
    originalRequest: body,
    budget: {
      sessionKey: context.account.id,
      scopeKey: `task_comment:${taskId}`,
      documentId: commentId,
      targetDocumentId: taskId,
      content: content || commentPayload.richContent || "",
      payload: {
        task_id: taskId,
        comment_id: commentId,
        ...commentPayload,
      },
      idempotencyKey: getRequestIdempotencyKey(body),
    },
    performWrite: async ({ accessToken }) => getHttpService("updateTaskComment", updateTaskComment)(
      accessToken,
      taskId,
      commentId,
      commentPayload,
    ),
  });
  if (!execution.ok) {
    respondWriteExecutionFailure(res, execution);
    return;
  }
  const result = execution.result;
  logger.info("task_comment_update_completed", {
    account_id: context.account.id,
    task_id: taskId,
    comment_id: commentId,
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "task_comment_update",
    ...result,
  });
}

async function handleTaskCommentDelete(res, requestUrl, body, taskId, commentId, logger = noopHttpLogger) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body), logger);
  if (!context) return;

  logger.info("task_comment_delete_started", {
    account_id: context.account.id,
    task_id: taskId,
    comment_id: commentId,
  });
  const execution = await executeCanonicalLarkMutation({
    action: "task_comment_delete",
    pathname: requestUrl.pathname,
    accountId: context.account.id,
    accessToken: context.token,
    logger,
    resourceId: commentId,
    scopeKey: `task_comment:${taskId}`,
    idempotencyKey: getRequestIdempotencyKey(body),
    payload: {
      task_id: taskId,
      comment_id: commentId,
    },
    originalRequest: body,
    budget: {
      sessionKey: context.account.id,
      scopeKey: `task_comment:${taskId}`,
      documentId: commentId,
      targetDocumentId: taskId,
      content: commentId,
      payload: {
        task_id: taskId,
        comment_id: commentId,
      },
      idempotencyKey: getRequestIdempotencyKey(body),
    },
    performWrite: async ({ accessToken }) => getHttpService("deleteTaskComment", deleteTaskComment)(
      accessToken,
      taskId,
      commentId,
    ),
  });
  if (!execution.ok) {
    respondWriteExecutionFailure(res, execution);
    return;
  }
  const result = execution.result;
  logger.info("task_comment_delete_completed", {
    account_id: context.account.id,
    task_id: taskId,
    comment_id: commentId,
  });
  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "task_comment_delete",
    ...result,
  });
}

async function handleMessageReactionsList(res, requestUrl, body, messageId) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) return;

  const pageSize = Number.parseInt(requestUrl.searchParams.get("page_size") || body.page_size || "50", 10);
  const result = await listMessageReactions(context.token, messageId, {
    reactionType: requestUrl.searchParams.get("reaction_type") || body.reaction_type || undefined,
    pageToken: requestUrl.searchParams.get("page_token") || body.page_token || undefined,
    pageSize: Number.isFinite(pageSize) ? Math.max(1, Math.min(pageSize, 100)) : 50,
    userIdType: requestUrl.searchParams.get("user_id_type") || body.user_id_type || "open_id",
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "message_reactions_list",
    ...result,
  });
}

async function handleMessageReactionCreate(res, requestUrl, body, messageId) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) return;

  const emojiType = String(body.emoji_type || body.reaction_type || "").trim();
  if (!emojiType) {
    jsonResponse(res, 400, { ok: false, error: "missing_emoji_type" });
    return;
  }

  const execution = await executeCanonicalLarkMutation({
    action: "message_reaction_create",
    pathname: requestUrl.pathname,
    accountId: context.account.id,
    accessToken: context.token,
    resourceId: messageId,
    scopeKey: `message_reaction:${messageId}`,
    idempotencyKey: getRequestIdempotencyKey(body),
    payload: {
      message_id: messageId,
      emoji_type: emojiType,
    },
    originalRequest: body,
    budget: {
      sessionKey: context.account.id,
      scopeKey: `message_reaction:${messageId}`,
      documentId: messageId,
      targetDocumentId: messageId,
      content: emojiType,
      payload: {
        message_id: messageId,
        emoji_type: emojiType,
      },
      idempotencyKey: getRequestIdempotencyKey(body),
    },
    performWrite: async ({ accessToken }) => getHttpService("createMessageReaction", createMessageReaction)(
      accessToken,
      messageId,
      emojiType,
    ),
  });
  if (!execution.ok) {
    respondWriteExecutionFailure(res, execution);
    return;
  }
  const result = execution.result;
  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "message_reaction_create",
    ...result,
  });
}

async function handleMessageReactionDelete(res, requestUrl, body, messageId, reactionId) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) return;

  const execution = await executeCanonicalLarkMutation({
    action: "message_reaction_delete",
    pathname: requestUrl.pathname,
    accountId: context.account.id,
    accessToken: context.token,
    resourceId: reactionId,
    scopeKey: `message_reaction:${messageId}`,
    idempotencyKey: getRequestIdempotencyKey(body),
    payload: {
      message_id: messageId,
      reaction_id: reactionId,
    },
    originalRequest: body,
    budget: {
      sessionKey: context.account.id,
      scopeKey: `message_reaction:${messageId}`,
      documentId: reactionId,
      targetDocumentId: messageId,
      content: reactionId,
      payload: {
        message_id: messageId,
        reaction_id: reactionId,
      },
      idempotencyKey: getRequestIdempotencyKey(body),
    },
    performWrite: async ({ accessToken }) => getHttpService("deleteMessageReaction", deleteMessageReaction)(
      accessToken,
      messageId,
      reactionId,
    ),
  });
  if (!execution.ok) {
    respondWriteExecutionFailure(res, execution);
    return;
  }
  const result = execution.result;
  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "message_reaction_delete",
    ...result,
  });
}

async function handleSearch(res, requestUrl, body, logger = noopHttpLogger) {
  const accountId = getAccountId(requestUrl, body);
  const q = requestUrl.searchParams.get("q") || body.q || "";
  const k = Number.parseInt(requestUrl.searchParams.get("k") || body.k || `${searchTopK}`, 10);

  if (!q.trim()) {
    logger.warn("knowledge_search_missing_query");
    jsonResponse(res, 400, { ok: false, error: "missing_query" });
    return;
  }

  try {
    logger.info("knowledge_search_started", {
      account_id: accountId || null,
      q_len: q.trim().length,
      k,
    });
    const { account, items } = await getHttpService("searchKnowledgeBase", searchKnowledgeBase)(accountId, q, k, {
      pathname: requestUrl?.pathname || "/search",
      logger,
    });
    logger.info("knowledge_search_completed", {
      account_id: account.id,
      total: items.length,
    });
    const normalizedItems = items.map((item) => ({
      ...item,
      document_id: item?.document_id || item?.metadata?.document_id || null,
      title: item?.title || item?.metadata?.title || null,
      url: item?.url || item?.metadata?.url || null,
      source_type: item?.source_type || item?.metadata?.source_type || null,
      chunk_index: item?.chunk_index ?? item?.metadata?.chunk_index ?? null,
      updated_at: item?.updated_at || item?.metadata?.updated_at || null,
    }));
    jsonResponse(res, 200, {
      ok: true,
      account_id: account.id,
      q,
      total: normalizedItems.length,
      items: normalizedItems,
    });
  } catch (error) {
    logger.warn("knowledge_search_failed", {
      account_id: accountId || null,
      error: logger.compactError(error),
    });
    jsonResponse(res, 401, {
      ok: false,
      error: "unauthorized",
      message: error.message,
      login_url: `${oauthBaseUrl}/oauth/lark/login`,
    });
  }
}

async function handleAnswer(res, requestUrl, body, logger = noopHttpLogger) {
  const q = requestUrl.searchParams.get("q") || body.q || "";

  if (!q.trim()) {
    logger.warn("knowledge_answer_missing_query");
    jsonResponse(res, 400, { ok: false, error: "missing_query" });
    return;
  }

  try {
    logger.info("knowledge_answer_started", {
      account_id: getAccountId(requestUrl, body) || null,
      q_len: q.trim().length,
    });
    const { plannerResult: result, plannerEnvelope: envelope, userResponse } = await runPlannerUserInputEdge({
      text: q,
      logger,
      baseUrl: oauthBaseUrl,
      authContext: resolveExplicitPlannerAuthContext(res, requestUrl, body),
      signal: logger?.__abort_signal || res?.__abort_signal || null,
      requestId: res?.__request_id || null,
      traceId: res?.__trace_id || null,
      handlerName: "handleAnswer",
      plannerExecutor: getHttpService("executePlannedUserInput", executePlannedUserInput),
    });
    logger.info("knowledge_answer_completed", {
      selected_action: envelope.action || null,
      ok: envelope.ok,
      planner_error: envelope.error || null,
    });
    const responseError = envelope.error || envelope.execution_result?.error || null;
    const statusCode = userResponse.ok === true
      ? 200
      : responseError === "request_timeout"
      ? 504
      : responseError === "missing_user_access_token" || responseError === "oauth_reauth_required"
        ? 401
        : envelope.error && !envelope.execution_result
        ? 422
        : 200;
    jsonResponse(res, statusCode, {
      ...userResponse,
      __hide_trace_id: true,
    });
  } catch (error) {
    const abortInfo = resolveRequestAbortInfo({
      signal: logger?.__abort_signal || res?.__abort_signal || null,
      error,
    });
    if (abortInfo) {
      logger.warn("knowledge_answer_aborted", {
        account_id: getAccountId(requestUrl, body) || null,
        error: abortInfo.code,
        error_message: abortInfo.message,
        timeout_ms: abortInfo.timeout_ms,
      });
      const userResponse = normalizeUserResponse({
        payload: {
          ok: false,
          answer: abortInfo.code === "request_timeout"
            ? "這次處理逾時了，我還沒有拿到可以安全交付的結果。"
            : "這次處理被中斷了，所以我先不回傳不完整結果。",
          sources: [],
          limitations: [
            "詳細 internal error 與 trace 已保留在 runtime/log，不直接暴露給使用者。",
          ],
        },
        requestText: q,
        logger,
        traceId: res?.__trace_id || null,
        handlerName: "handleAnswer",
      });
      jsonResponse(res, userResponse.ok === true ? 200 : abortInfo.code === "request_timeout" ? 504 : REQUEST_CANCELLED_STATUS_CODE, {
        ...userResponse,
        __hide_trace_id: true,
      });
      return;
    }
    logger.warn("knowledge_answer_failed", {
      account_id: getAccountId(requestUrl, body) || null,
      error: logger.compactError(error),
    });
    const userResponse = normalizeUserResponse({
      payload: {
        ok: false,
        answer: "系統內部處理失敗了，所以這次先不回傳不完整結果。",
        sources: [],
        limitations: [
          "詳細 internal error 與 trace 已保留在 runtime/log，不直接暴露給使用者。",
        ],
      },
      requestText: q,
      logger,
      traceId: res?.__trace_id || null,
      handlerName: "handleAnswer",
    });
    jsonResponse(res, userResponse.ok === true ? 200 : 500, {
      ...userResponse,
      __hide_trace_id: true,
    });
  }
}

async function handleSecureTaskStart(res, body) {
  const name = String(body.name || "lobster-secure-task").trim();
  if (!name) {
    jsonResponse(res, 400, { ok: false, error: "missing_task_name" });
    return;
  }
  const task = await getHttpService("startSecureTask", startSecureTask)(name);
  jsonResponse(res, 200, { ok: true, task });
}

async function handleSecureAction(res, taskId, body) {
  if (!body || typeof body !== "object" || !body.action || typeof body.action !== "object") {
    jsonResponse(res, 400, { ok: false, error: "missing_action" });
    return;
  }
  const result = await getHttpService("executeSecureAction", executeSecureAction)(taskId, body.action);
  if (result.status === "approval_required") {
    jsonResponse(res, 409, result);
    return;
  }
  jsonResponse(res, 200, result);
}

async function handleSecureTaskFinish(res, taskId, body) {
  const diff = await getHttpService("finishSecureTask", finishSecureTask)(taskId, Boolean(body.success));
  jsonResponse(res, 200, { ok: true, diff });
}

async function handleSecureTaskRollback(res, taskId, body) {
  const diff = await getHttpService("rollbackSecureTask", rollbackSecureTask)(taskId, Boolean(body.dry_run));
  jsonResponse(res, 200, { ok: true, diff });
}

async function handleSecurityStatus(res) {
  const status = await getHttpService("getSecurityStatus", getSecurityStatus)();
  jsonResponse(res, 200, status);
}

async function handleApprovalList(res) {
  const items = await getHttpService("listPendingApprovals", listPendingApprovals)();
  jsonResponse(res, 200, { ok: true, total: items.length, items });
}

async function handleApprovalResolution(res, requestId, body, approved) {
  const actor = typeof body.actor === "string" && body.actor.trim() ? body.actor.trim() : "openclaw";
  const result = await getHttpService("resolvePendingApproval", resolvePendingApproval)(requestId, approved, actor);
  jsonResponse(res, 200, result);
}

async function handleImprovementList(res, requestUrl, body, logger = noopHttpLogger) {
  const accountId = getAccountId(requestUrl, body);
  const status = String(requestUrl.searchParams.get("status") || body.status || "").trim();
  logger.info("improvement_list_started", {
    account_id: accountId || null,
    status: status || null,
  });
  const items = await listImprovementWorkflowProposals({ accountId, status });
  logger.info("improvement_list_completed", {
    account_id: accountId || null,
    total: items.length,
  });
  jsonResponse(res, 200, { ok: true, total: items.length, items });
}

async function handleImprovementResolution(res, proposalId, body, approved, logger = noopHttpLogger) {
  const actor = typeof body.actor === "string" && body.actor.trim() ? body.actor.trim() : "openclaw";
  logger.info("improvement_resolution_started", {
    proposal_id: proposalId,
    approved,
    actor,
  });
  const existing = await getImprovementWorkflowProposal(proposalId);
  if (!existing) {
    logger.warn("improvement_resolution_missing_proposal", {
      proposal_id: proposalId,
    });
    jsonResponse(res, 404, { ok: false, error: "proposal_not_found" });
    return;
  }
  const result = await resolveImprovementWorkflowProposal({ proposalId, approved, actor });
  logger.info("improvement_resolution_completed", {
    proposal_id: proposalId,
    status: result?.status || null,
  });
  jsonResponse(res, 200, { ok: true, item: result });
}

async function handleImprovementApply(res, proposalId, body, logger = noopHttpLogger) {
  const actor = typeof body.actor === "string" && body.actor.trim() ? body.actor.trim() : "openclaw";
  logger.info("improvement_apply_started", {
    proposal_id: proposalId,
    actor,
  });
  const existing = await getImprovementWorkflowProposal(proposalId);
  if (!existing) {
    logger.warn("improvement_apply_missing_proposal", {
      proposal_id: proposalId,
    });
    jsonResponse(res, 404, { ok: false, error: "proposal_not_found" });
    return;
  }
  try {
    const result = await applyImprovementWorkflowProposal({ proposalId, actor });
    logger.info("improvement_apply_completed", {
      proposal_id: proposalId,
      status: result?.status || null,
    });
    jsonResponse(res, 200, { ok: true, item: result });
  } catch (error) {
    logger.warn("improvement_apply_failed", {
      proposal_id: proposalId,
      error: logger.compactError(error),
    });
    jsonResponse(res, 409, {
      ok: false,
      error: "proposal_not_approved",
      message: "Improvement proposal must be approved before apply.",
    });
  }
}

export function startHttpServer({
  logger = console,
  port = oauthPort,
  listen = true,
  serviceOverrides = {},
  requestTimeoutMs = httpRequestTimeoutMs,
} = {}) {
  setActiveHttpServiceOverrides(serviceOverrides);
  const httpLogger = createRuntimeLogger({ logger, component: "http" });
  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url || "/", oauthBaseUrl);
    const requestStartedAt = Date.now();
    const requestStartedAtIso = nowIso();
    const traceId = createTraceId("http");
    const requestTraffic = buildRequestTrafficMetadata({ req, requestUrl });
    const requestId = normalizeText(Array.isArray(req.headers["x-request-id"]) ? req.headers["x-request-id"][0] : req.headers["x-request-id"])
      || createRequestId("http_request");
    const requestLogger = httpLogger.child("request", {
      trace_id: traceId,
      request_id: requestId,
      method: req.method || "GET",
      pathname: requestUrl.pathname,
      traffic_source: requestTraffic.traffic_source,
      request_backed: requestTraffic.request_backed,
      request_timeout_ms: Number.isFinite(Number(requestTimeoutMs)) ? Number(requestTimeoutMs) : null,
    });
    const abortController = new AbortController();
    const effectiveRequestTimeoutMs = Number.isFinite(Number(requestTimeoutMs)) && Number(requestTimeoutMs) > 0
      ? Number(requestTimeoutMs)
      : null;
    let requestCompleted = false;
    let responseFinished = false;
    let timeoutTriggered = false;
    res.__trace_id = traceId;
    res.__request_id = requestId;
    res.__pathname = requestUrl.pathname;
    res.__request_headers = req.headers;
    res.__traffic_source = requestTraffic.traffic_source;
    res.__request_backed = requestTraffic.request_backed;
    res.__monitor_payload = null;
    res.__abort_signal = abortController.signal;
    requestLogger.__abort_signal = abortController.signal;
    res.setHeader("X-Request-Id", requestId);
    res.setHeader("X-Trace-Id", traceId);
    requestLogger.info("request_started");
    let requestRecorded = false;
    const timeoutHandle = effectiveRequestTimeoutMs == null
      ? null
      : setTimeout(() => {
          if (requestCompleted || abortController.signal.aborted) {
            return;
          }
          timeoutTriggered = true;
          const abortReason = buildRequestAbortReason({
            code: "request_timeout",
            pathname: requestUrl.pathname,
            timeoutMs: effectiveRequestTimeoutMs,
          });
          abortController.abort(abortReason);
          emitRequestTimeoutAlert({
            traceId,
            requestId,
            pathname: requestUrl.pathname,
            routeName: res.__monitor_route || null,
            timeoutMs: effectiveRequestTimeoutMs,
          });
          requestLogger.error("request_timeout", {
            error: "request_timeout",
            error_message: abortReason.message,
            timeout_ms: effectiveRequestTimeoutMs,
            status_code: 504,
          });
          const userResponse = normalizeUserResponse({
            payload: {
              ok: false,
              answer: "這次處理逾時了，我還沒有拿到可以安全交付的結果。",
              sources: [],
              limitations: [
                "詳細 internal error 與 trace 已保留在 runtime/log，不直接暴露給使用者。",
                "可以稍後再試一次，或把需求縮小一點。",
              ],
            },
          });
          jsonResponse(res, 504, {
            ...userResponse,
            __hide_trace_id: true,
          });
        }, effectiveRequestTimeoutMs);
    const persistRequestRecord = () => {
      if (requestRecorded) {
        return;
      }
      requestRecorded = true;
      try {
        recordHttpRequest({
          traceId,
          requestId,
          method: req.method || "GET",
          pathname: requestUrl.pathname,
          routeName: res.__monitor_route || null,
          statusCode: res.statusCode,
          payload: res.__monitor_payload,
          durationMs: Date.now() - requestStartedAt,
          startedAt: requestStartedAtIso,
          finishedAt: nowIso(),
        });
      } catch (error) {
        requestLogger.error("request_monitor_persist_failed", {
          error: requestLogger.compactError(error),
        });
      }
    };
    res.on("finish", () => {
      responseFinished = true;
      requestCompleted = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      requestLogger.info("request_finished", {
        status_code: res.statusCode,
      });
      persistRequestRecord();
    });
    res.on("close", () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (!responseFinished && !abortController.signal.aborted) {
        const abortReason = buildRequestAbortReason({
          code: "request_cancelled",
          pathname: requestUrl.pathname,
        });
        abortController.abort(abortReason);
        requestLogger.warn("request_cancelled", {
          error: "request_cancelled",
          error_message: abortReason.message,
          status_code: REQUEST_CANCELLED_STATUS_CODE,
        });
        res.statusCode = REQUEST_CANCELLED_STATUS_CODE;
        captureResponsePayload(res, {
          ok: false,
          error: "request_cancelled",
          message: abortReason.message,
        });
      }
      requestCompleted = true;
      persistRequestRecord();
    });
    let body = {};
    let idempotentRequest = {
      replayed: false,
      res,
      finalizeError() {},
    };
    try {
      cleanupOauthStates();
      body = await readJsonBody(req).catch((error) => {
        requestLogger.warn("request_body_parse_failed", {
          error: requestLogger.compactError(error),
        });
        return {};
      });
      requestLogger.info("request_input", {
        request_input: buildRequestInputTrace({
          req,
          requestUrl,
          body,
        }),
      });
      idempotentRequest = await prepareIdempotentRequest({
        req,
        res,
        requestUrl,
        body,
        logger: requestLogger,
      });
      if (idempotentRequest.replayed) {
        return;
      }
      res = idempotentRequest.res || res;
      res.__abort_signal = abortController.signal;

      if (requestUrl.pathname === "/health") {
        jsonResponse(res, 200, { ok: true });
        return;
      }

      if (requestUrl.pathname === "/monitoring" && req.method === "GET") {
        await runHttpRoute(requestLogger, "monitoring_dashboard", () =>
          handleMonitoringDashboard(res, requestUrl)
        );
        return;
      }

      if (requestUrl.pathname === "/agent/security/status") {
        await handleSecurityStatus(res);
        return;
      }

      if (requestUrl.pathname === "/agent/approvals" && req.method === "GET") {
        await handleApprovalList(res);
        return;
      }

      if (requestUrl.pathname === "/agent/improvements" && req.method === "GET") {
        await runHttpRoute(requestLogger, "improvement_list", (routeLogger) =>
          handleImprovementList(res, requestUrl, body, routeLogger)
        );
        return;
      }

      if (requestUrl.pathname === "/agent/improvements/learning/generate" && req.method === "POST") {
        await runHttpRoute(requestLogger, "learning_improvement_generate", (routeLogger) =>
          handleLearningImprovementGeneration(res, requestUrl, body, routeLogger)
        );
        return;
      }

      if (requestUrl.pathname === "/agent/docs/create" && req.method === "POST") {
        await runHttpRoute(requestLogger, "agent_create_doc", (routeLogger) =>
          handleAgentCreateDoc(res, requestUrl, body, routeLogger)
        );
        return;
      }

      if (requestUrl.pathname === "/agent/company-brain/docs" && req.method === "GET") {
        await runHttpRoute(requestLogger, "agent_company_brain_docs_list", (routeLogger) =>
          handleAgentListCompanyBrainDocs(res, requestUrl, body, routeLogger)
        );
        return;
      }

      if (requestUrl.pathname === "/agent/company-brain/approved/docs" && req.method === "GET") {
        await runHttpRoute(requestLogger, "agent_company_brain_approved_docs_list", (routeLogger) =>
          handleAgentListApprovedCompanyBrainKnowledge(res, requestUrl, body, routeLogger)
        );
        return;
      }

      if (requestUrl.pathname === "/agent/company-brain/search" && req.method === "GET") {
        await runHttpRoute(requestLogger, "agent_company_brain_search", (routeLogger) =>
          handleAgentSearchCompanyBrainDocs(res, requestUrl, body, routeLogger)
        );
        return;
      }

      if (requestUrl.pathname === "/agent/company-brain/approved/search" && req.method === "GET") {
        await runHttpRoute(requestLogger, "agent_company_brain_approved_search", (routeLogger) =>
          handleAgentSearchApprovedCompanyBrainKnowledge(res, requestUrl, body, routeLogger)
        );
        return;
      }

      if (requestUrl.pathname === "/agent/company-brain/review" && req.method === "POST") {
        await runHttpRoute(requestLogger, "agent_company_brain_review", (routeLogger) =>
          handleAgentReviewCompanyBrainDoc(res, requestUrl, body, routeLogger)
        );
        return;
      }

      if (requestUrl.pathname === "/agent/company-brain/conflicts" && req.method === "POST") {
        await runHttpRoute(requestLogger, "agent_company_brain_conflicts", (routeLogger) =>
          handleAgentCheckCompanyBrainConflicts(res, requestUrl, body, routeLogger)
        );
        return;
      }

      if (requestUrl.pathname === "/agent/company-brain/approval-transition" && req.method === "POST") {
        await runHttpRoute(requestLogger, "agent_company_brain_approval_transition", (routeLogger) =>
          handleAgentCompanyBrainApprovalTransition(res, requestUrl, body, routeLogger)
        );
        return;
      }

      if (requestUrl.pathname === "/agent/company-brain/learning/ingest" && req.method === "POST") {
        await runHttpRoute(requestLogger, "agent_company_brain_learning_ingest", (routeLogger) =>
          handleAgentIngestLearningDoc(res, requestUrl, body, routeLogger)
        );
        return;
      }

      if (requestUrl.pathname === "/agent/company-brain/learning/state" && req.method === "POST") {
        await runHttpRoute(requestLogger, "agent_company_brain_learning_update", (routeLogger) =>
          handleAgentUpdateLearningState(res, requestUrl, body, routeLogger)
        );
        return;
      }

      if (/^\/agent\/company-brain\/docs\/[^/]+$/.test(requestUrl.pathname) && req.method === "GET") {
        await runHttpRoute(requestLogger, "agent_company_brain_doc_detail", (routeLogger) =>
          handleAgentGetCompanyBrainDocDetail(res, requestUrl, body, routeLogger)
        );
        return;
      }

      if (/^\/agent\/company-brain\/approved\/docs\/[^/]+$/.test(requestUrl.pathname) && req.method === "GET") {
        await runHttpRoute(requestLogger, "agent_company_brain_approved_doc_detail", (routeLogger) =>
          handleAgentGetApprovedCompanyBrainKnowledgeDetail(res, requestUrl, body, routeLogger)
        );
        return;
      }

      if (/^\/agent\/company-brain\/docs\/[^/]+\/apply$/.test(requestUrl.pathname) && req.method === "POST") {
        await runHttpRoute(requestLogger, "agent_company_brain_apply", (routeLogger) =>
          handleAgentApplyApprovedCompanyBrainKnowledge(res, requestUrl, body, routeLogger)
        );
        return;
      }

      if (requestUrl.pathname === "/agent/system/runtime-info" && req.method === "GET") {
        await runHttpRoute(requestLogger, "agent_runtime_info", (routeLogger) =>
          handleAgentRuntimeInfo(res, requestUrl, body, routeLogger)
        );
        return;
      }

      const approvalResolveMatch = requestUrl.pathname.match(/^\/agent\/approvals\/([^/]+)\/(approve|reject)$/);
      if (approvalResolveMatch && req.method === "POST") {
        await handleApprovalResolution(
          res,
          decodeURIComponent(approvalResolveMatch[1]),
          body,
          approvalResolveMatch[2] === "approve",
        );
        return;
      }

      const improvementResolveMatch = requestUrl.pathname.match(/^\/agent\/improvements\/([^/]+)\/(approve|reject)$/);
      if (improvementResolveMatch && req.method === "POST") {
        await runHttpRoute(requestLogger, "improvement_resolution", (routeLogger) =>
          handleImprovementResolution(
            res,
            decodeURIComponent(improvementResolveMatch[1]),
            body,
            improvementResolveMatch[2] === "approve",
            routeLogger,
          )
        );
        return;
      }

      const improvementApplyMatch = requestUrl.pathname.match(/^\/agent\/improvements\/([^/]+)\/apply$/);
      if (improvementApplyMatch && req.method === "POST") {
        await runHttpRoute(requestLogger, "improvement_apply", (routeLogger) =>
          handleImprovementApply(res, decodeURIComponent(improvementApplyMatch[1]), body, routeLogger)
        );
        return;
      }

      if (requestUrl.pathname === "/agent/tasks" && req.method === "POST") {
        await handleSecureTaskStart(res, body);
        return;
      }

      const taskActionMatch = requestUrl.pathname.match(/^\/agent\/tasks\/([^/]+)\/actions$/);
      if (taskActionMatch && req.method === "POST") {
        await handleSecureAction(res, decodeURIComponent(taskActionMatch[1]), body);
        return;
      }

      const taskFinishMatch = requestUrl.pathname.match(/^\/agent\/tasks\/([^/]+)\/finish$/);
      if (taskFinishMatch && req.method === "POST") {
        await handleSecureTaskFinish(res, decodeURIComponent(taskFinishMatch[1]), body);
        return;
      }

      const taskRollbackMatch = requestUrl.pathname.match(/^\/agent\/tasks\/([^/]+)\/rollback$/);
      if (taskRollbackMatch && req.method === "POST") {
        await handleSecureTaskRollback(res, decodeURIComponent(taskRollbackMatch[1]), body);
        return;
      }

      if (requestUrl.pathname === "/oauth/lark/login") {
        const state = buildOAuthState();
        pendingOauthStates.set(state, Date.now());
        res.writeHead(302, { Location: buildAuthorizeUrl(state) });
        res.end();
        return;
      }

      if (requestUrl.pathname === oauthCallbackPath) {
        const code = requestUrl.searchParams.get("code");
        const state = requestUrl.searchParams.get("state");

        if (!code || !state || !pendingOauthStates.has(state)) {
          htmlResponse(res, 400, "<h1>Lark OAuth failed</h1><p>Missing or invalid code/state.</p>");
          return;
        }

        pendingOauthStates.delete(state);
        const token = await exchangeCodeForUserToken(code);
        const profile = await getUserProfile(token.access_token);

        htmlResponse(
          res,
          200,
          `<h1>Lark OAuth success</h1>
<p>Signed in as ${profile.name || profile.en_name || profile.open_id || "unknown user"}.</p>
<ul>
  <li><a href="/api/auth/status">Auth status</a></li>
  <li><a href="/sync/full">Run full sync</a></li>
  <li><a href="/api/drive/root">Drive root</a></li>
  <li><a href="/api/wiki/spaces">Wiki spaces</a></li>
</ul>`,
        );
        return;
      }

      if (requestUrl.pathname === "/api/auth/status" && req.method === "GET") {
        await runHttpRoute(requestLogger, "auth_status", (routeLogger) =>
          handleAuthStatus(res, getAccountId(requestUrl, body), routeLogger)
        );
        return;
      }

      if (requestUrl.pathname === "/api/runtime/resolve-scopes" && req.method === "POST") {
        await handleRuntimeResolveScopes(res, body);
        return;
      }

      if (requestUrl.pathname === "/api/runtime/sessions" && req.method === "GET") {
        await handleRuntimeSessions(res);
        return;
      }

      if (requestUrl.pathname === "/api/drive/root" && req.method === "GET") {
        await runHttpRoute(requestLogger, "drive_root", () =>
          handleDriveList(res, requestUrl, body)
        );
        return;
      }

      if (requestUrl.pathname === "/api/drive/list" && req.method === "GET") {
        await runHttpRoute(requestLogger, "drive_list", () =>
          handleDriveList(res, requestUrl, body)
        );
        return;
      }

      if (requestUrl.pathname === "/api/drive/create-folder" && req.method === "POST") {
        await runHttpRoute(requestLogger, "drive_create_folder", () =>
          handleDriveCreateFolder(res, requestUrl, body)
        );
        return;
      }

      if (requestUrl.pathname === "/api/drive/move" && req.method === "POST") {
        await runHttpRoute(requestLogger, "drive_move", () =>
          handleDriveMove(res, requestUrl, body)
        );
        return;
      }

      if (requestUrl.pathname === "/api/drive/task-status" && req.method === "GET") {
        await runHttpRoute(requestLogger, "drive_task_status", () =>
          handleDriveTaskStatus(res, requestUrl, body)
        );
        return;
      }

      if (requestUrl.pathname === "/api/drive/delete" && req.method === "POST") {
        await runHttpRoute(requestLogger, "drive_delete", () =>
          handleDriveDelete(res, requestUrl, body)
        );
        return;
      }

      if (requestUrl.pathname === "/api/drive/organize/preview" && req.method === "POST") {
        await runHttpRoute(requestLogger, "drive_organize_preview", (routeLogger) =>
          handleDriveOrganize(res, requestUrl, body, false, routeLogger)
        );
        return;
      }

      if (requestUrl.pathname === "/api/drive/organize/apply" && req.method === "POST") {
        await runHttpRoute(requestLogger, "drive_organize_apply", (routeLogger) =>
          handleDriveOrganize(res, requestUrl, body, true, routeLogger)
        );
        return;
      }

      if (requestUrl.pathname === "/api/wiki/spaces" && req.method === "GET") {
        await runHttpRoute(requestLogger, "wiki_spaces", async (routeLogger) => {
          const context = await requireUserContext(res, getAccountId(requestUrl, body), routeLogger);
          if (!context) {
            return;
          }

          const data = await listWikiSpaces(
            context.token,
            requestUrl.searchParams.get("page_token") || undefined,
          );
          jsonResponse(res, 200, {
            ok: true,
            account_id: context.account.id,
            auth_mode: "user_access_token",
            source: "wiki.v2.spaces",
            ...data,
          });
        });
        return;
      }

      if (requestUrl.pathname === "/api/doc/read" && req.method === "GET") {
        await handleDocumentRead(res, requestUrl, body);
        return;
      }

      if (requestUrl.pathname === "/api/system/runtime-info" && req.method === "GET") {
        await runHttpRoute(requestLogger, "runtime_info", (routeLogger) =>
          handleRuntimeInfo(res, requestUrl, body, routeLogger)
        );
        return;
      }

      if (requestUrl.pathname === "/api/monitoring/requests" && req.method === "GET") {
        await runHttpRoute(requestLogger, "monitoring_requests", () =>
          handleMonitoringRequests(res, requestUrl)
        );
        return;
      }

      if (requestUrl.pathname === "/api/monitoring/errors" && req.method === "GET") {
        await runHttpRoute(requestLogger, "monitoring_errors", () =>
          handleMonitoringErrors(res, requestUrl)
        );
        return;
      }

      if (requestUrl.pathname === "/api/monitoring/errors/latest" && req.method === "GET") {
        await runHttpRoute(requestLogger, "monitoring_latest_error", () =>
          handleMonitoringLatestError(res)
        );
        return;
      }

      if (requestUrl.pathname === "/api/monitoring/metrics" && req.method === "GET") {
        await runHttpRoute(requestLogger, "monitoring_metrics", () =>
          handleMonitoringMetrics(res)
        );
        return;
      }

      if (requestUrl.pathname === "/api/monitoring/learning" && req.method === "GET") {
        await runHttpRoute(requestLogger, "monitoring_learning", (routeLogger) =>
          handleMonitoringLearningSummary(res, requestUrl, body, routeLogger)
        );
        return;
      }

      if (requestUrl.pathname === "/api/doc/lifecycle/summary" && req.method === "GET") {
        await runHttpRoute(requestLogger, "doc_lifecycle_summary", (routeLogger) =>
          handleDocumentLifecycleSummary(res, requestUrl, body, routeLogger)
        );
        return;
      }

      if (requestUrl.pathname === "/api/company-brain/docs" && req.method === "GET") {
        await runHttpRoute(requestLogger, "company_brain_docs_list", (routeLogger) =>
          handleCompanyBrainDocsList(res, requestUrl, body, routeLogger)
        );
        return;
      }

      if (requestUrl.pathname === "/api/company-brain/search" && req.method === "GET") {
        await runHttpRoute(requestLogger, "company_brain_docs_search", (routeLogger) =>
          handleCompanyBrainSearch(res, requestUrl, body, routeLogger)
        );
        return;
      }

      if (/^\/api\/company-brain\/docs\/[^/]+$/.test(requestUrl.pathname) && req.method === "GET") {
        await runHttpRoute(requestLogger, "company_brain_doc_detail", (routeLogger) =>
          handleCompanyBrainDocDetail(res, requestUrl, body, routeLogger)
        );
        return;
      }

      if (requestUrl.pathname === "/api/doc/lifecycle" && req.method === "GET") {
        await runHttpRoute(requestLogger, "doc_lifecycle_list", (routeLogger) =>
          handleDocumentLifecycleList(res, requestUrl, body, routeLogger)
        );
        return;
      }

      if (requestUrl.pathname === "/api/doc/lifecycle/retry" && req.method === "POST") {
        await runHttpRoute(requestLogger, "doc_lifecycle_retry", (routeLogger) =>
          handleDocumentLifecycleRetry(res, requestUrl, body, routeLogger)
        );
        return;
      }

      if (requestUrl.pathname === "/api/doc/create" && req.method === "POST") {
        await runHttpRoute(requestLogger, "doc_create", (routeLogger) =>
          handleDocumentCreate(res, requestUrl, body, routeLogger)
        );
        return;
      }

      if (requestUrl.pathname === "/api/doc/update" && req.method === "POST") {
        await runHttpRoute(requestLogger, "doc_update", (routeLogger) =>
          handleDocumentUpdate(res, requestUrl, body, routeLogger)
        );
        return;
      }

      if (requestUrl.pathname === "/api/doc/comments" && req.method === "GET") {
        await handleDocumentComments(res, requestUrl, body);
        return;
      }

      if (requestUrl.pathname === "/api/doc/rewrite-from-comments" && req.method === "POST") {
        await runHttpRoute(requestLogger, "doc_rewrite_from_comments", (routeLogger) =>
          handleDocumentRewriteFromComments(res, requestUrl, body, routeLogger)
        );
        return;
      }

      if (requestUrl.pathname === "/api/doc/comments/suggestion-card" && req.method === "POST") {
        await handleDocumentCommentSuggestionCard(res, requestUrl, body);
        return;
      }

      if (requestUrl.pathname === "/api/doc/comments/poll-suggestion-cards" && req.method === "POST") {
        await handleDocumentCommentSuggestionPoll(res);
        return;
      }

      if (requestUrl.pathname === "/api/meeting/process" && req.method === "POST") {
        await runHttpRoute(requestLogger, "meeting_process", (routeLogger) =>
          handleMeetingProcess(res, requestUrl, body, routeLogger)
        );
        return;
      }

      if (requestUrl.pathname === "/api/meeting/confirm" && req.method === "POST") {
        await runHttpRoute(requestLogger, "meeting_confirm", (routeLogger) =>
          handleMeetingConfirm(res, requestUrl, body, routeLogger)
        );
        return;
      }

      if (requestUrl.pathname === "/meeting/confirm" && req.method === "GET") {
        await runHttpRoute(requestLogger, "meeting_confirm_page", (routeLogger) =>
          handleMeetingConfirmPage(res, requestUrl, body, routeLogger)
        );
        return;
      }

      if (requestUrl.pathname === "/api/messages" && req.method === "GET") {
        await runHttpRoute(requestLogger, "messages_list", (routeLogger) =>
          handleMessagesList(res, requestUrl, body, routeLogger)
        );
        return;
      }

      if (requestUrl.pathname === "/api/messages/search" && req.method === "GET") {
        await handleMessageSearch(res, requestUrl, body);
        return;
      }

      if (requestUrl.pathname === "/api/messages/reply" && req.method === "POST") {
        await runHttpRoute(requestLogger, "message_reply", (routeLogger) =>
          handleMessageReply(res, requestUrl, body, routeLogger)
        );
        return;
      }

      if (requestUrl.pathname === "/api/messages/reply-card" && req.method === "POST") {
        await handleMessageReply(res, requestUrl, {
          ...body,
          card_title: body.card_title || body.title || "Lobster",
        });
        return;
      }

      const messageGetMatch = requestUrl.pathname.match(/^\/api\/messages\/([^/]+)$/);
      if (messageGetMatch && req.method === "GET") {
        await handleMessageGet(res, requestUrl, body, decodeURIComponent(messageGetMatch[1]));
        return;
      }

      if (requestUrl.pathname === "/api/calendar/primary" && req.method === "GET") {
        await runHttpRoute(requestLogger, "calendar_primary", () =>
          handleCalendarPrimary(res, requestUrl, body)
        );
        return;
      }

      if (requestUrl.pathname === "/api/calendar/events" && req.method === "GET") {
        await runHttpRoute(requestLogger, "calendar_events", () =>
          handleCalendarEvents(res, requestUrl, body)
        );
        return;
      }

      if (requestUrl.pathname === "/api/calendar/events/search" && req.method === "POST") {
        await runHttpRoute(requestLogger, "calendar_events_search", () =>
          handleCalendarSearch(res, requestUrl, body)
        );
        return;
      }

      if (requestUrl.pathname === "/api/calendar/events/create" && req.method === "POST") {
        await runHttpRoute(requestLogger, "calendar_events_create", (routeLogger) =>
          handleCalendarCreateEvent(res, requestUrl, body, routeLogger)
        );
        return;
      }

      if (requestUrl.pathname === "/api/tasks" && req.method === "GET") {
        await runHttpRoute(requestLogger, "tasks_list", () =>
          handleTasksList(res, requestUrl, body)
        );
        return;
      }

      if (requestUrl.pathname === "/api/tasks/create" && req.method === "POST") {
        await runHttpRoute(requestLogger, "task_create", (routeLogger) =>
          handleTaskCreate(res, requestUrl, body, routeLogger)
        );
        return;
      }

      const taskGetMatch = requestUrl.pathname.match(/^\/api\/tasks\/([^/]+)$/);
      if (taskGetMatch && req.method === "GET") {
        await runHttpRoute(requestLogger, "task_get", (routeLogger) =>
          handleTaskGet(res, requestUrl, body, decodeURIComponent(taskGetMatch[1]), routeLogger)
        );
        return;
      }

      if (requestUrl.pathname === "/api/bitable/apps/create" && req.method === "POST") {
        await runHttpRoute(requestLogger, "bitable_app_create", () =>
          handleBitableAppCreate(res, requestUrl, body)
        );
        return;
      }

      const bitableAppMatch = requestUrl.pathname.match(/^\/api\/bitable\/apps\/([^/]+)$/);
      if (bitableAppMatch && req.method === "GET") {
        await runHttpRoute(requestLogger, "bitable_app_get", () =>
          handleBitableAppGet(res, requestUrl, body, decodeURIComponent(bitableAppMatch[1]))
        );
        return;
      }
      if (bitableAppMatch && (req.method === "POST" || req.method === "PATCH")) {
        await runHttpRoute(requestLogger, "bitable_app_update", () =>
          handleBitableAppUpdate(res, requestUrl, body, decodeURIComponent(bitableAppMatch[1]))
        );
        return;
      }

      const bitableTablesMatch = requestUrl.pathname.match(/^\/api\/bitable\/apps\/([^/]+)\/tables$/);
      if (bitableTablesMatch && req.method === "GET") {
        await runHttpRoute(requestLogger, "bitable_tables_list", () =>
          handleBitableTablesList(res, requestUrl, body, decodeURIComponent(bitableTablesMatch[1]))
        );
        return;
      }

      const bitableTableCreateMatch = requestUrl.pathname.match(/^\/api\/bitable\/apps\/([^/]+)\/tables\/create$/);
      if (bitableTableCreateMatch && req.method === "POST") {
        await runHttpRoute(requestLogger, "bitable_table_create", () =>
          handleBitableTableCreate(res, requestUrl, body, decodeURIComponent(bitableTableCreateMatch[1]))
        );
        return;
      }

      const bitableRecordsMatch = requestUrl.pathname.match(/^\/api\/bitable\/apps\/([^/]+)\/tables\/([^/]+)\/records$/);
      if (bitableRecordsMatch && req.method === "GET") {
        await runHttpRoute(requestLogger, "bitable_records_list", (routeLogger) =>
          handleBitableRecordsList(
            res,
            requestUrl,
            body,
            decodeURIComponent(bitableRecordsMatch[1]),
            decodeURIComponent(bitableRecordsMatch[2]),
            routeLogger,
          )
        );
        return;
      }

      const bitableRecordsSearchMatch = requestUrl.pathname.match(/^\/api\/bitable\/apps\/([^/]+)\/tables\/([^/]+)\/records\/search$/);
      if (bitableRecordsSearchMatch && req.method === "POST") {
        await runHttpRoute(requestLogger, "bitable_records_search", (routeLogger) =>
          handleBitableRecordsSearch(
            res,
            requestUrl,
            body,
            decodeURIComponent(bitableRecordsSearchMatch[1]),
            decodeURIComponent(bitableRecordsSearchMatch[2]),
            routeLogger,
          )
        );
        return;
      }

      const bitableRecordCreateMatch = requestUrl.pathname.match(/^\/api\/bitable\/apps\/([^/]+)\/tables\/([^/]+)\/records\/create$/);
      if (bitableRecordCreateMatch && req.method === "POST") {
        await runHttpRoute(requestLogger, "bitable_record_create", (routeLogger) =>
          handleBitableRecordCreate(
            res,
            requestUrl,
            body,
            decodeURIComponent(bitableRecordCreateMatch[1]),
            decodeURIComponent(bitableRecordCreateMatch[2]),
            routeLogger,
          )
        );
        return;
      }

      const bitableRecordBulkMatch = requestUrl.pathname.match(/^\/api\/bitable\/apps\/([^/]+)\/tables\/([^/]+)\/records\/bulk-upsert$/);
      if (bitableRecordBulkMatch && req.method === "POST") {
        await runHttpRoute(requestLogger, "bitable_records_bulk_upsert", (routeLogger) =>
          handleBitableRecordsBulkUpsert(
            res,
            requestUrl,
            body,
            decodeURIComponent(bitableRecordBulkMatch[1]),
            decodeURIComponent(bitableRecordBulkMatch[2]),
            routeLogger,
          )
        );
        return;
      }

      const bitableRecordMatch = requestUrl.pathname.match(/^\/api\/bitable\/apps\/([^/]+)\/tables\/([^/]+)\/records\/([^/]+)$/);
      if (bitableRecordMatch && req.method === "GET") {
        await runHttpRoute(requestLogger, "bitable_record_get", (routeLogger) =>
          handleBitableRecordGet(
            res,
            requestUrl,
            body,
            decodeURIComponent(bitableRecordMatch[1]),
            decodeURIComponent(bitableRecordMatch[2]),
            decodeURIComponent(bitableRecordMatch[3]),
            routeLogger,
          )
        );
        return;
      }
      if (bitableRecordMatch && (req.method === "POST" || req.method === "PATCH")) {
        await runHttpRoute(requestLogger, "bitable_record_update", (routeLogger) =>
          handleBitableRecordUpdate(
            res,
            requestUrl,
            body,
            decodeURIComponent(bitableRecordMatch[1]),
            decodeURIComponent(bitableRecordMatch[2]),
            decodeURIComponent(bitableRecordMatch[3]),
            routeLogger,
          )
        );
        return;
      }
      if (bitableRecordMatch && req.method === "DELETE") {
        await runHttpRoute(requestLogger, "bitable_record_delete", (routeLogger) =>
          handleBitableRecordDelete(
            res,
            requestUrl,
            body,
            decodeURIComponent(bitableRecordMatch[1]),
            decodeURIComponent(bitableRecordMatch[2]),
            decodeURIComponent(bitableRecordMatch[3]),
            routeLogger,
          )
        );
        return;
      }

      if (requestUrl.pathname === "/api/sheets/spreadsheets/create" && req.method === "POST") {
        await handleSpreadsheetCreate(res, requestUrl, body);
        return;
      }

      const spreadsheetMatch = requestUrl.pathname.match(/^\/api\/sheets\/spreadsheets\/([^/]+)$/);
      if (spreadsheetMatch && req.method === "GET") {
        await handleSpreadsheetGet(res, requestUrl, body, decodeURIComponent(spreadsheetMatch[1]));
        return;
      }
      if (spreadsheetMatch && (req.method === "POST" || req.method === "PATCH")) {
        await handleSpreadsheetUpdate(res, requestUrl, body, decodeURIComponent(spreadsheetMatch[1]));
        return;
      }

      const spreadsheetSheetsMatch = requestUrl.pathname.match(/^\/api\/sheets\/spreadsheets\/([^/]+)\/sheets$/);
      if (spreadsheetSheetsMatch && req.method === "GET") {
        await handleSpreadsheetSheetsList(res, requestUrl, body, decodeURIComponent(spreadsheetSheetsMatch[1]));
        return;
      }

      const spreadsheetSheetMatch = requestUrl.pathname.match(/^\/api\/sheets\/spreadsheets\/([^/]+)\/sheets\/([^/]+)$/);
      if (spreadsheetSheetMatch && req.method === "GET") {
        await handleSpreadsheetSheetGet(
          res,
          requestUrl,
          body,
          decodeURIComponent(spreadsheetSheetMatch[1]),
          decodeURIComponent(spreadsheetSheetMatch[2]),
        );
        return;
      }

      const spreadsheetReplaceMatch = requestUrl.pathname.match(/^\/api\/sheets\/spreadsheets\/([^/]+)\/sheets\/([^/]+)\/replace$/);
      if (spreadsheetReplaceMatch && req.method === "POST") {
        await handleSpreadsheetReplace(
          res,
          requestUrl,
          body,
          decodeURIComponent(spreadsheetReplaceMatch[1]),
          decodeURIComponent(spreadsheetReplaceMatch[2]),
        );
        return;
      }

      const spreadsheetReplaceBatchMatch = requestUrl.pathname.match(/^\/api\/sheets\/spreadsheets\/([^/]+)\/sheets\/([^/]+)\/replace-batch$/);
      if (spreadsheetReplaceBatchMatch && req.method === "POST") {
        await handleSpreadsheetReplaceBatch(
          res,
          requestUrl,
          body,
          decodeURIComponent(spreadsheetReplaceBatchMatch[1]),
          decodeURIComponent(spreadsheetReplaceBatchMatch[2]),
        );
        return;
      }

      if (requestUrl.pathname === "/api/calendar/freebusy" && req.method === "POST") {
        await runHttpRoute(requestLogger, "calendar_freebusy", (routeLogger) =>
          handleCalendarFreebusy(res, requestUrl, body, routeLogger)
        );
        return;
      }

      const taskCommentsMatch = requestUrl.pathname.match(/^\/api\/tasks\/([^/]+)\/comments$/);
      if (taskCommentsMatch && req.method === "GET") {
        await runHttpRoute(requestLogger, "task_comments_list", (routeLogger) =>
          handleTaskCommentsList(res, requestUrl, body, decodeURIComponent(taskCommentsMatch[1]), routeLogger)
        );
        return;
      }
      if (taskCommentsMatch && req.method === "POST") {
        await runHttpRoute(requestLogger, "task_comment_create", (routeLogger) =>
          handleTaskCommentCreate(res, requestUrl, body, decodeURIComponent(taskCommentsMatch[1]), routeLogger)
        );
        return;
      }

      const taskCommentMatch = requestUrl.pathname.match(/^\/api\/tasks\/([^/]+)\/comments\/([^/]+)$/);
      if (taskCommentMatch && req.method === "GET") {
        await runHttpRoute(requestLogger, "task_comment_get", (routeLogger) =>
          handleTaskCommentGet(
            res,
            requestUrl,
            body,
            decodeURIComponent(taskCommentMatch[1]),
            decodeURIComponent(taskCommentMatch[2]),
            routeLogger,
          )
        );
        return;
      }
      if (taskCommentMatch && (req.method === "POST" || req.method === "PUT" || req.method === "PATCH")) {
        await runHttpRoute(requestLogger, "task_comment_update", (routeLogger) =>
          handleTaskCommentUpdate(
            res,
            requestUrl,
            body,
            decodeURIComponent(taskCommentMatch[1]),
            decodeURIComponent(taskCommentMatch[2]),
            routeLogger,
          )
        );
        return;
      }
      if (taskCommentMatch && req.method === "DELETE") {
        await runHttpRoute(requestLogger, "task_comment_delete", (routeLogger) =>
          handleTaskCommentDelete(
            res,
            requestUrl,
            body,
            decodeURIComponent(taskCommentMatch[1]),
            decodeURIComponent(taskCommentMatch[2]),
            routeLogger,
          )
        );
        return;
      }

      const messageReactionsMatch = requestUrl.pathname.match(/^\/api\/messages\/([^/]+)\/reactions$/);
      if (messageReactionsMatch && req.method === "GET") {
        await handleMessageReactionsList(res, requestUrl, body, decodeURIComponent(messageReactionsMatch[1]));
        return;
      }
      if (messageReactionsMatch && req.method === "POST") {
        await handleMessageReactionCreate(res, requestUrl, body, decodeURIComponent(messageReactionsMatch[1]));
        return;
      }

      const messageReactionMatch = requestUrl.pathname.match(/^\/api\/messages\/([^/]+)\/reactions\/([^/]+)$/);
      if (messageReactionMatch && req.method === "DELETE") {
        await handleMessageReactionDelete(
          res,
          requestUrl,
          body,
          decodeURIComponent(messageReactionMatch[1]),
          decodeURIComponent(messageReactionMatch[2]),
        );
        return;
      }

      if (requestUrl.pathname === "/api/wiki/create-node" && req.method === "POST") {
        await runHttpRoute(requestLogger, "wiki_create_node", () =>
          handleWikiCreateNode(res, requestUrl, body)
        );
        return;
      }

      if (requestUrl.pathname === "/api/wiki/move" && req.method === "POST") {
        await runHttpRoute(requestLogger, "wiki_move", () =>
          handleWikiMove(res, requestUrl, body)
        );
        return;
      }

      const wikiNodesMatch = requestUrl.pathname.match(/^\/api\/wiki\/spaces\/([^/]+)\/nodes$/);
      if (wikiNodesMatch && req.method === "GET") {
        await runHttpRoute(requestLogger, "wiki_nodes_list", async (routeLogger) => {
          const context = await requireUserContext(res, getAccountId(requestUrl, body), routeLogger);
          if (!context) {
            return;
          }

          const spaceId = decodeURIComponent(wikiNodesMatch[1]);
          const data = await listWikiSpaceNodes(
            context.token,
            spaceId,
            requestUrl.searchParams.get("parent_node_token") || undefined,
            requestUrl.searchParams.get("page_token") || undefined,
          );
          jsonResponse(res, 200, {
            ok: true,
            account_id: context.account.id,
            auth_mode: "user_access_token",
            source: "wiki.v2.space_node.list",
            space_id: spaceId,
            ...data,
          });
        });
        return;
      }

      if (requestUrl.pathname === "/api/wiki/organize/preview" && req.method === "POST") {
        await runHttpRoute(requestLogger, "wiki_organize_preview", (routeLogger) =>
          handleWikiOrganize(res, requestUrl, body, false, routeLogger)
        );
        return;
      }

      if (requestUrl.pathname === "/api/wiki/organize/apply" && req.method === "POST") {
        await runHttpRoute(requestLogger, "wiki_organize_apply", (routeLogger) =>
          handleWikiOrganize(res, requestUrl, body, true, routeLogger)
        );
        return;
      }

      if (requestUrl.pathname === "/sync/full" && req.method === "POST") {
        await handleSync(res, requestUrl, body, "full");
        return;
      }

      if (requestUrl.pathname === "/sync/incremental" && req.method === "POST") {
        await handleSync(res, requestUrl, body, "incremental");
        return;
      }

      if (requestUrl.pathname === "/search" && req.method === "GET") {
        await runHttpRoute(requestLogger, "knowledge_search", (routeLogger) =>
          handleSearch(res, requestUrl, body, routeLogger)
        );
        return;
      }

      if (requestUrl.pathname === "/answer" && req.method === "GET") {
        await runHttpRoute(requestLogger, "knowledge_answer", (routeLogger) =>
          handleAnswer(res, requestUrl, body, routeLogger)
        );
        return;
      }

      const allowedMethods = getAllowedMethodsForPath(requestUrl.pathname);
      if (allowedMethods && !allowedMethods.includes(req.method || "GET")) {
        methodNotAllowed(res, allowedMethods);
        return;
      }

      jsonResponse(res, 404, { ok: false, error: "not_found" });
    } catch (error) {
      idempotentRequest.finalizeError(error);
      const abortInfo = resolveRequestAbortInfo({ signal: abortController.signal, error });
      if (abortInfo) {
        if (abortInfo.code === "request_timeout") {
          if (!timeoutTriggered) {
            const userResponse = normalizeUserResponse({
              payload: {
                ok: false,
                answer: "這次處理逾時了，我還沒有拿到可以安全交付的結果。",
                sources: [],
                limitations: [
                  "詳細 internal error 與 trace 已保留在 runtime/log，不直接暴露給使用者。",
                  "可以稍後再試一次，或把需求縮小一點。",
                ],
              },
            });
            jsonResponse(res, 504, {
              ...userResponse,
              __hide_trace_id: true,
            });
          }
          return;
        }
        if (!responseFinished) {
          res.statusCode = REQUEST_CANCELLED_STATUS_CODE;
          captureResponsePayload(res, {
            ok: false,
            error: "request_cancelled",
            message: abortInfo.message,
          });
        }
        return;
      }
      if (isOAuthReauthRequiredError(error)) {
        emitOauthReauthAlert({
          accountId: getAccountId(requestUrl, body),
          scope: "http.request_catch",
          pathname: requestUrl.pathname,
          reason: error?.code || error?.name || "oauth_reauth_required",
        });
        jsonResponse(res, 401, {
          ok: false,
          error: "oauth_reauth_required",
          login_url: `${oauthBaseUrl}/oauth/lark/login`,
          message: "Stored token expired and refresh failed. Reauthorize Lobster with Lark.",
        });
        return;
      }
      requestLogger.error("request_failed", {
        error: requestLogger.compactError(error),
      });
      jsonResponse(res, 500, {
        ok: false,
        error: "internal_error",
        message: error.message,
      });
    }
  });

  if (listen) {
    server.listen(port, () => {
      httpLogger.info("server_listening", {
        action: "server_start",
        status: "listening",
        base_url: oauthBaseUrl,
        login_url: `${oauthBaseUrl}/oauth/lark/login`,
      });
    });
  }

  return server;
}
