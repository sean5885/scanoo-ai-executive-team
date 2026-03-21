import { oauthBaseUrl } from "./config.mjs";
import { cleanText } from "./message-intent-utils.mjs";
import { ROUTING_NO_MATCH, isRoutingNoMatch } from "./planner-error-codes.mjs";
import { createPlannerFlow } from "./planner-flow-runtime.mjs";
import { route as routeDocQuery } from "./router.js";

const plannerDocQueryRuntimeContext = {
  active_doc: null,
  active_candidates: [],
  active_theme: null,
};

function buildDocQueryTraceEvent({
  eventType = "",
  userQuery = "",
  routedIntent = "",
  tool = "",
  hitCount = null,
  activeDoc = null,
  activeCandidates = [],
  formatterKind = "",
  traceId = null,
} = {}) {
  return {
    stage: "planner_doc_query_pipeline",
    event_type: cleanText(eventType) || null,
    user_query: cleanText(userQuery) || null,
    routed_intent: cleanText(routedIntent) || null,
    tool: cleanText(tool) || null,
    hit_count: Number.isInteger(hitCount) ? hitCount : null,
    active_doc_exists: Boolean(cleanText(activeDoc?.doc_id)),
    active_candidates_exists: Array.isArray(activeCandidates) && activeCandidates.length > 0,
    active_candidates_count: Array.isArray(activeCandidates) ? activeCandidates.length : 0,
    formatter_kind: cleanText(formatterKind) || null,
    trace_id: traceId || null,
  };
}

function logDocQueryTrace(logger = console, event = {}) {
  logger?.debug?.("planner_doc_query_pipeline", event);
}

function buildPlannerFormattedOutput({
  kind = "",
  title = "",
  docId = "",
  items = [],
  matchReason = "",
  contentSummary = "",
  learningStatus = "",
  learningConcepts = [],
  learningTags = [],
  found = null,
} = {}) {
  return {
    kind: cleanText(kind) || null,
    title: cleanText(title) || null,
    doc_id: cleanText(docId) || null,
    items: Array.isArray(items) ? items : [],
    match_reason: cleanText(matchReason) || null,
    content_summary: cleanText(contentSummary) || null,
    learning_status: cleanText(learningStatus) || null,
    learning_concepts: Array.isArray(learningConcepts) ? learningConcepts.map((item) => cleanText(item)).filter(Boolean) : [],
    learning_tags: Array.isArray(learningTags) ? learningTags.map((item) => cleanText(item)).filter(Boolean) : [],
    found: typeof found === "boolean" ? found : null,
  };
}

function normalizeActiveDoc(value = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const docId = cleanText(value.doc_id);
  if (!docId) {
    return null;
  }
  return {
    doc_id: docId,
    title: cleanText(value.title) || null,
  };
}

function normalizePlannerCandidates(items = []) {
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .map((item) => normalizeActiveDoc(item))
    .filter(Boolean)
    .slice(0, 5);
}

function resolvePlannerCandidateIndex(userIntent = "") {
  const normalizedIntent = cleanText(String(userIntent || ""));
  if (!normalizedIntent) {
    return null;
  }
  if (/第(?:1|一)份|第(?:1|一)個/.test(normalizedIntent)) {
    return 0;
  }
  if (/第(?:2|二)份|第(?:2|二)個/.test(normalizedIntent)) {
    return 1;
  }
  if (/第(?:3|三)份|第(?:3|三)個/.test(normalizedIntent)) {
    return 2;
  }
  if (/第(?:4|四)份|第(?:4|四)個/.test(normalizedIntent)) {
    return 3;
  }
  if (/第(?:5|五)份|第(?:5|五)個/.test(normalizedIntent)) {
    return 4;
  }
  return null;
}

function withFormattedOutput(result = null, formattedOutput = null) {
  if (!result || typeof result !== "object" || !formattedOutput) {
    return result;
  }
  return {
    ...result,
    formatted_output: formattedOutput,
  };
}

function summarizePlannerDocumentContent(content = "", maxLength = 180) {
  const normalized = cleanText(String(content || "").replace(/\s+/g, " "));
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength).trim()}...`;
}

function parsePlannerDocQueryReadResponse(rawText = "") {
  try {
    return JSON.parse(rawText);
  } catch {
    return {
      ok: false,
      error: "invalid_json",
      raw_text: rawText,
    };
  }
}

async function readPlannerDocumentContent({
  docId = "",
  baseUrl = oauthBaseUrl,
} = {}) {
  const normalizedDocId = cleanText(docId);
  if (!normalizedDocId) {
    return null;
  }

  const requestUrl = new URL("/api/doc/read", baseUrl);
  requestUrl.searchParams.set("document_id", normalizedDocId);

  try {
    const response = await fetch(requestUrl, { method: "GET" });
    const rawText = await response.text();
    const data = parsePlannerDocQueryReadResponse(rawText);
    if (!data?.ok) {
      return null;
    }
    return {
      title: cleanText(data.title) || null,
      content: cleanText(data.content) || "",
      trace_id: data.trace_id || null,
    };
  } catch {
    return null;
  }
}

function extractCompanyBrainEnvelope(executionResult = null) {
  const envelope = executionResult?.data;
  if (
    envelope
    && typeof envelope === "object"
    && !Array.isArray(envelope)
    && typeof envelope.success === "boolean"
  ) {
    return envelope;
  }
  return null;
}

function extractCompanyBrainPayload(executionResult = null) {
  const envelope = extractCompanyBrainEnvelope(executionResult);
  if (envelope) {
    return envelope.data && typeof envelope.data === "object" && !Array.isArray(envelope.data)
      ? envelope.data
      : {};
  }

  if (executionResult?.data && typeof executionResult.data === "object" && !Array.isArray(executionResult.data)) {
    return executionResult.data;
  }

  return executionResult && typeof executionResult === "object" ? executionResult : {};
}

function extractCompanyBrainItems(executionResult = null) {
  const payload = extractCompanyBrainPayload(executionResult);
  return Array.isArray(payload?.items)
    ? payload.items
    : Array.isArray(executionResult?.items)
      ? executionResult.items
      : [];
}

function extractCompanyBrainDetailDoc(executionResult = null) {
  const payload = extractCompanyBrainPayload(executionResult);
  if (payload?.doc && typeof payload.doc === "object" && !Array.isArray(payload.doc)) {
    return payload.doc;
  }
  if (payload?.item && typeof payload.item === "object" && !Array.isArray(payload.item)) {
    return payload.item;
  }
  return executionResult?.item || payload || executionResult?.data || executionResult || null;
}

function extractCompanyBrainLearningState(executionResult = null) {
  const payload = extractCompanyBrainPayload(executionResult);
  if (payload?.learning_state && typeof payload.learning_state === "object" && !Array.isArray(payload.learning_state)) {
    return payload.learning_state;
  }
  const detailDoc = extractCompanyBrainDetailDoc(executionResult);
  if (detailDoc?.learning_state && typeof detailDoc.learning_state === "object" && !Array.isArray(detailDoc.learning_state)) {
    return detailDoc.learning_state;
  }
  return null;
}

function extractPlannerCandidatesFromResult(selectedAction = "", executionResult = null) {
  if (!executionResult || typeof executionResult !== "object" || executionResult.ok !== true) {
    return [];
  }

  const normalizedAction = cleanText(selectedAction);
  if (normalizedAction === "search_company_brain_docs") {
    return normalizePlannerCandidates(extractCompanyBrainItems(executionResult));
  }

  if (normalizedAction === "search_and_detail_doc") {
    const results = Array.isArray(executionResult.results) ? executionResult.results : [];
    const searchResult = results.find((item) => [
      "company_brain_docs_search",
      "search_company_brain_docs",
    ].includes(cleanText(item?.action)));
    return normalizePlannerCandidates(extractCompanyBrainItems(searchResult));
  }

  return [];
}

function extractActiveDocFromPlannerResult(selectedAction = "", executionResult = null) {
  if (!executionResult || typeof executionResult !== "object" || executionResult.ok !== true) {
    return null;
  }

  function fromCandidate(candidate = null) {
    return normalizeActiveDoc(candidate);
  }

  if (cleanText(selectedAction) === "get_company_brain_doc_detail") {
    return fromCandidate(extractCompanyBrainDetailDoc(executionResult));
  }

  if (cleanText(selectedAction) === "search_and_detail_doc") {
    const results = Array.isArray(executionResult.results) ? executionResult.results : [];
    const detailResult = results.find((item) => [
      "company_brain_doc_detail",
      "get_company_brain_doc_detail",
    ].includes(cleanText(item?.action)));
    if (detailResult) {
      return fromCandidate(extractCompanyBrainDetailDoc(detailResult));
    }
    const candidates = extractPlannerCandidatesFromResult(selectedAction, executionResult);
    return candidates.length === 1 ? candidates[0] : null;
  }

  return null;
}

export function resetPlannerDocQueryRuntimeContext() {
  plannerDocQueryRuntimeContext.active_doc = null;
  plannerDocQueryRuntimeContext.active_candidates = [];
  plannerDocQueryRuntimeContext.active_theme = null;
}

export function hydratePlannerDocQueryRuntimeContext({
  activeDoc = null,
  activeCandidates = [],
  activeTheme = null,
} = {}) {
  plannerDocQueryRuntimeContext.active_doc = normalizeActiveDoc(activeDoc);
  plannerDocQueryRuntimeContext.active_candidates = normalizePlannerCandidates(activeCandidates);
  plannerDocQueryRuntimeContext.active_theme = cleanText(activeTheme) || null;
  return getPlannerDocQueryContext();
}

export function getPlannerDocQueryContext() {
  return {
    activeDoc: plannerDocQueryRuntimeContext.active_doc,
    activeCandidates: Array.isArray(plannerDocQueryRuntimeContext.active_candidates)
      ? plannerDocQueryRuntimeContext.active_candidates
      : [],
    activeTheme: cleanText(plannerDocQueryRuntimeContext.active_theme) || null,
  };
}

export function selectDocQueryAction(userIntent = "", {
  activeDoc = null,
  activeCandidates = [],
} = {}) {
  return routeDocQuery(userIntent, {
    activeDoc,
    activeCandidates,
  });
}

export function resolveDocQueryRoute({
  userIntent = "",
  payload = {},
  activeDoc = null,
  activeCandidates = [],
  logger = console,
} = {}) {
  const selectedAction = selectDocQueryAction(userIntent, {
    activeDoc,
    activeCandidates,
  });
  const action = isRoutingNoMatch(selectedAction) ? null : selectedAction;
  const routedPayload = buildDocQueryPayload({
    action,
    userIntent,
    payload,
    activeDoc,
    activeCandidates,
  });
  logDocQueryTrace(logger, buildDocQueryTraceEvent({
    eventType: "doc_query_route",
    userQuery: userIntent,
    routedIntent: action ? "hard_route" : "routing_no_match",
    tool: action,
    activeDoc,
    activeCandidates,
  }));
  return {
    action,
    payload: routedPayload,
    error: action ? null : ROUTING_NO_MATCH,
  };
}

export function buildDocQueryPayload({
  action = "",
  userIntent = "",
  payload = {},
  activeDoc = null,
  activeCandidates = [],
} = {}) {
  const effectivePayload = payload && typeof payload === "object" && !Array.isArray(payload)
    ? { ...payload }
    : {};
  const normalizedIntent = cleanText(String(userIntent || ""));
  const candidateIndex = resolvePlannerCandidateIndex(normalizedIntent);
  const selectedCandidate = Number.isInteger(candidateIndex) ? activeCandidates[candidateIndex] : null;

  if (action === "search_company_brain_docs") {
    if (!cleanText(effectivePayload.q) && normalizedIntent) {
      effectivePayload.q = normalizedIntent;
    }
    if (!cleanText(effectivePayload.query) && normalizedIntent) {
      effectivePayload.query = normalizedIntent;
    }
  }

  if (action === "search_and_detail_doc") {
    if (!cleanText(effectivePayload.q) && normalizedIntent) {
      effectivePayload.q = normalizedIntent;
    }
  }

  if (action === "get_company_brain_doc_detail") {
    if (!cleanText(effectivePayload.doc_id) && cleanText(selectedCandidate?.doc_id)) {
      effectivePayload.doc_id = cleanText(selectedCandidate.doc_id);
    }
    if (!cleanText(effectivePayload.doc_id) && cleanText(activeDoc?.doc_id)) {
      effectivePayload.doc_id = cleanText(activeDoc.doc_id);
    }
    if (!cleanText(effectivePayload.query) && normalizedIntent) {
      effectivePayload.query = normalizedIntent;
    }
  }

  return effectivePayload;
}

export async function formatDocQueryExecutionResult({
  selectedAction = "",
  executionResult = null,
  userIntent = "",
  payload = {},
  baseUrl = oauthBaseUrl,
  contentReader = readPlannerDocumentContent,
  logger = console,
} = {}) {
  if (!executionResult || typeof executionResult !== "object" || executionResult.ok !== true) {
    return executionResult;
  }

  const normalizedAction = cleanText(selectedAction);
  const normalizedPayload = payload && typeof payload === "object" && !Array.isArray(payload) ? { ...payload } : {};
  const normalizedIntent = cleanText(userIntent);

  if (normalizedAction === "search_company_brain_docs") {
    const items = extractCompanyBrainItems(executionResult);
    const result = withFormattedOutput(executionResult, buildPlannerFormattedOutput({
      kind: "search",
      items: items.map((item) => ({
        title: cleanText(item?.title) || null,
        doc_id: cleanText(item?.doc_id) || null,
      })),
      found: items.length > 0,
    }));
    logDocQueryTrace(logger, buildDocQueryTraceEvent({
      eventType: "doc_query_result",
      userQuery: userIntent,
      routedIntent: "search",
      tool: selectedAction,
      hitCount: items.length,
      activeDoc: plannerDocQueryRuntimeContext.active_doc,
      activeCandidates: plannerDocQueryRuntimeContext.active_candidates,
      formatterKind: result?.formatted_output?.kind,
      traceId: result?.trace_id || null,
    }));
    return result;
  }

  if (normalizedAction === "get_company_brain_doc_detail") {
    const detailItem = extractCompanyBrainDetailDoc(executionResult);
    const detailPayload = extractCompanyBrainPayload(executionResult);
    const learningState = extractCompanyBrainLearningState(executionResult);
    const docId = cleanText(detailItem?.doc_id);
    const title = cleanText(detailItem?.title);
    const contentResult = await contentReader({
      docId,
      baseUrl,
    });
    const result = withFormattedOutput(executionResult, buildPlannerFormattedOutput({
      kind: "detail",
      title: title || contentResult?.title || "",
      docId,
      contentSummary: cleanText(detailPayload?.summary?.overview)
        || cleanText(detailPayload?.summary?.snippet)
        || summarizePlannerDocumentContent(contentResult?.content || ""),
      learningStatus: cleanText(learningState?.status) || null,
      learningConcepts: Array.isArray(learningState?.key_concepts) ? learningState.key_concepts : [],
      learningTags: Array.isArray(learningState?.tags) ? learningState.tags : [],
      found: Boolean(docId),
    }));
    logDocQueryTrace(logger, buildDocQueryTraceEvent({
      eventType: "doc_query_result",
      userQuery: userIntent,
      routedIntent: "detail",
      tool: selectedAction,
      hitCount: docId ? 1 : 0,
      activeDoc: plannerDocQueryRuntimeContext.active_doc,
      activeCandidates: plannerDocQueryRuntimeContext.active_candidates,
      formatterKind: result?.formatted_output?.kind,
      traceId: result?.trace_id || null,
    }));
    return result;
  }

  if (normalizedAction === "search_and_detail_doc") {
    const results = Array.isArray(executionResult.results) ? executionResult.results : [];
    const searchResult = results.find((item) => [
      "company_brain_docs_search",
      "search_company_brain_docs",
    ].includes(cleanText(item?.action)));
    const detailResult = results.find((item) => [
      "company_brain_doc_detail",
      "get_company_brain_doc_detail",
    ].includes(cleanText(item?.action)));
    const searchItems = extractCompanyBrainItems(searchResult);
    const searchItem = searchItems[0] || null;
    const detailItem = extractCompanyBrainDetailDoc(detailResult) || searchItem || null;
    const detailPayload = extractCompanyBrainPayload(detailResult);
    const learningState = extractCompanyBrainLearningState(detailResult) || searchItem?.learning_state || null;

    if (!detailResult && searchItems.length === 0) {
      const result = withFormattedOutput(executionResult, buildPlannerFormattedOutput({
        kind: "search_and_detail_not_found",
        items: [],
        matchReason: cleanText(normalizedPayload.q) || normalizedIntent || "由搜尋結果命中",
        found: false,
      }));
      logDocQueryTrace(logger, buildDocQueryTraceEvent({
        eventType: "doc_query_result",
        userQuery: userIntent,
        routedIntent: "search_and_detail",
        tool: selectedAction,
        hitCount: 0,
        activeDoc: plannerDocQueryRuntimeContext.active_doc,
        activeCandidates: plannerDocQueryRuntimeContext.active_candidates,
        formatterKind: result?.formatted_output?.kind,
        traceId: result?.trace_id || null,
      }));
      return result;
    }

    if (!detailResult && searchItems.length > 1) {
      const result = withFormattedOutput(executionResult, buildPlannerFormattedOutput({
        kind: "search_and_detail_candidates",
        items: searchItems.slice(0, 5).map((item) => ({
          title: cleanText(item?.title) || null,
          doc_id: cleanText(item?.doc_id) || null,
        })),
        matchReason: cleanText(normalizedPayload.q) || normalizedIntent || "由搜尋結果命中",
        found: true,
      }));
      logDocQueryTrace(logger, buildDocQueryTraceEvent({
        eventType: "doc_query_result",
        userQuery: userIntent,
        routedIntent: "search_and_detail",
        tool: selectedAction,
        hitCount: searchItems.length,
        activeDoc: plannerDocQueryRuntimeContext.active_doc,
        activeCandidates: plannerDocQueryRuntimeContext.active_candidates,
        formatterKind: result?.formatted_output?.kind,
        traceId: result?.trace_id || null,
      }));
      return result;
    }

    const docId = cleanText(detailItem?.doc_id) || cleanText(searchItem?.doc_id);
    const title = cleanText(detailItem?.title) || cleanText(searchItem?.title);
    const contentResult = await contentReader({
      docId,
      baseUrl,
    });
    const result = withFormattedOutput(executionResult, buildPlannerFormattedOutput({
      kind: "search_and_detail",
      title: title || contentResult?.title || "",
      docId,
      matchReason: cleanText(normalizedPayload.q) || normalizedIntent || "由搜尋結果命中",
      contentSummary: cleanText(detailPayload?.summary?.overview)
        || cleanText(detailPayload?.summary?.snippet)
        || summarizePlannerDocumentContent(contentResult?.content || ""),
      learningStatus: cleanText(learningState?.status) || null,
      learningConcepts: Array.isArray(learningState?.key_concepts) ? learningState.key_concepts : [],
      learningTags: Array.isArray(learningState?.tags) ? learningState.tags : [],
      found: Boolean(docId),
    }));
    logDocQueryTrace(logger, buildDocQueryTraceEvent({
      eventType: "doc_query_result",
      userQuery: userIntent,
      routedIntent: "search_and_detail",
      tool: selectedAction,
      hitCount: searchItems.length,
      activeDoc: plannerDocQueryRuntimeContext.active_doc,
      activeCandidates: plannerDocQueryRuntimeContext.active_candidates,
      formatterKind: result?.formatted_output?.kind,
      traceId: result?.trace_id || null,
    }));
    return result;
  }

  return executionResult;
}

export function syncPlannerDocQueryContext({
  selectedAction = "",
  executionResult = null,
  activeTheme,
} = {}) {
  if (activeTheme !== undefined) {
    plannerDocQueryRuntimeContext.active_theme = cleanText(activeTheme) || null;
  }

  const nextActiveDoc = extractActiveDocFromPlannerResult(selectedAction, executionResult);
  if (nextActiveDoc) {
    plannerDocQueryRuntimeContext.active_doc = nextActiveDoc;
    plannerDocQueryRuntimeContext.active_candidates = [];
    return {
      activeDoc: plannerDocQueryRuntimeContext.active_doc,
      activeCandidates: plannerDocQueryRuntimeContext.active_candidates,
      activeTheme: plannerDocQueryRuntimeContext.active_theme,
    };
  }

  plannerDocQueryRuntimeContext.active_candidates = extractPlannerCandidatesFromResult(
    selectedAction,
    executionResult,
  );
  return {
    activeDoc: plannerDocQueryRuntimeContext.active_doc,
    activeCandidates: plannerDocQueryRuntimeContext.active_candidates,
    activeTheme: plannerDocQueryRuntimeContext.active_theme,
  };
}

function supportsDocQueryAction(action = "") {
  return [
    "search_company_brain_docs",
    "get_company_brain_doc_detail",
    "search_and_detail_doc",
  ].includes(cleanText(action));
}

const plannerDocQueryFlow = createPlannerFlow({
  id: "doc_query",
  supportsAction: supportsDocQueryAction,
  readContext() {
    return getPlannerDocQueryContext();
  },
  resetContext() {
    resetPlannerDocQueryRuntimeContext();
  },
  route({ userIntent = "", payload = {}, context = {}, logger = console } = {}) {
    return resolveDocQueryRoute({
      userIntent,
      payload,
      activeDoc: context.activeDoc,
      activeCandidates: context.activeCandidates,
      logger,
    });
  },
  shapePayload({ action = "", userIntent = "", payload = {}, context = {} } = {}) {
    return buildDocQueryPayload({
      action,
      userIntent,
      payload,
      activeDoc: context.activeDoc,
      activeCandidates: context.activeCandidates,
    });
  },
  async formatResult({
    selectedAction = "",
    executionResult = null,
    userIntent = "",
    payload = {},
    baseUrl = oauthBaseUrl,
    contentReader,
    logger = console,
  } = {}) {
    return formatDocQueryExecutionResult({
      selectedAction,
      executionResult,
      userIntent,
      payload,
      baseUrl,
      contentReader,
      logger,
    });
  },
  writeContext({ selectedAction = "", executionResult = null } = {}) {
    return syncPlannerDocQueryContext({
      selectedAction,
      executionResult,
      activeTheme: null,
    });
  },
});

export { plannerDocQueryFlow };
