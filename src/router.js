import {
  extractCloudOrganizationScopedSubject,
  looksLikeCloudOrganizationReReviewRequest,
} from "./cloud-doc-organization-workflow.mjs";
import { cleanText } from "./message-intent-utils.mjs";
import { ROUTING_NO_MATCH } from "./planner-error-codes.mjs";

const DOC_SEARCH_INTENT_RE = /找|搜尋|搜索|查|search/i;
const DOC_SUMMARY_INTENT_RE = /整理|解釋|解释/;
const DOC_DETAIL_CONTENT_INTENT_RE = /打開|打开|讀|读|內容|内容|寫了什麼|写了什么/;
const DOC_PRONOUN_FOLLOW_UP_INTENT_RE = /這份文件|这份文件|那份文件|那個文件|那个文件|這個文件|这个文件|這份|这份|那份|這個|这个|那個|那个|這篇|这篇|那篇|這則|这则|那則|那则/;
const DOC_ORDINAL_FOLLOW_UP_INTENT_RE = /第(?:1|一|2|二|3|三|4|四|5|五)份|第(?:1|一|2|二|3|三|4|四|5|五)個|打開第(?:1|一|2|二|3|三|4|四|5|五)/;

function buildRouteDecision({
  action = "",
  preset = "",
  error = "",
  routingReason = "",
} = {}) {
  const normalizedAction = cleanText(action);
  const normalizedPreset = cleanText(preset);
  const normalizedError = cleanText(error);
  const normalizedRoutingReason = cleanText(routingReason) || "routing_no_match";
  const selectedTarget = normalizedAction || normalizedPreset || null;
  const targetKind = normalizedAction
    ? "action"
    : normalizedPreset
      ? "preset"
      : "error";

  return {
    selected_target: selectedTarget,
    target_kind: targetKind,
    routing_reason: normalizedRoutingReason,
    ...(normalizedAction ? { action: normalizedAction } : {}),
    ...(normalizedPreset ? { preset: normalizedPreset } : {}),
    ...(!selectedTarget ? { error: normalizedError || ROUTING_NO_MATCH } : {}),
  };
}

function getRouteTarget(routeDecision = null) {
  if (typeof routeDecision === "string") {
    return cleanText(routeDecision);
  }
  if (!routeDecision || typeof routeDecision !== "object" || Array.isArray(routeDecision)) {
    return "";
  }
  return cleanText(routeDecision.selected_target || routeDecision.action || routeDecision.preset || "");
}

function hasDocSearchIntent(text = "") {
  return DOC_SEARCH_INTENT_RE.test(String(text || ""));
}

function hasDocSummaryIntent(text = "") {
  return DOC_SUMMARY_INTENT_RE.test(String(text || ""));
}

function hasDocDetailContentIntent(text = "") {
  return DOC_DETAIL_CONTENT_INTENT_RE.test(String(text || ""));
}

function hasDocPronounFollowUpIntent(text = "") {
  return DOC_PRONOUN_FOLLOW_UP_INTENT_RE.test(String(text || ""));
}

function hasDocOrdinalFollowUpIntent(text = "") {
  return DOC_ORDINAL_FOLLOW_UP_INTENT_RE.test(String(text || ""));
}

function hasScopedDocExclusionSearchIntent(text = "") {
  const normalized = cleanText(String(text || ""));
  return Boolean(normalized)
    && looksLikeCloudOrganizationReReviewRequest(normalized)
    && Boolean(extractCloudOrganizationScopedSubject(normalized));
}

function selectUniqueRouteCandidate(candidates = []) {
  const normalizedCandidates = Array.isArray(candidates)
    ? candidates.filter((candidate) => candidate && typeof candidate === "object")
    : [];
  if (normalizedCandidates.length === 0) {
    return null;
  }

  const uniqueTargets = new Set(
    normalizedCandidates
      .map((candidate) => cleanText(candidate.action) || `preset:${cleanText(candidate.preset)}`)
      .filter(Boolean),
  );

  return uniqueTargets.size === 1 ? normalizedCandidates[0] : null;
}

function resolveFollowUpRouteCandidate(text = "", {
  activeDoc = null,
  activeCandidates = [],
} = {}) {
  const candidates = [];
  const wantsOrdinalFollowUp = hasDocOrdinalFollowUpIntent(text);

  if (
    Array.isArray(activeCandidates)
    && activeCandidates.length > 0
    && wantsOrdinalFollowUp
  ) {
    candidates.push({
      action: "get_company_brain_doc_detail",
      routingReason: "doc_query_active_candidate_detail",
    });
  }

  if (
    !wantsOrdinalFollowUp
    && cleanText(activeDoc?.doc_id)
    && (hasDocPronounFollowUpIntent(text) || hasDocDetailContentIntent(text))
  ) {
    candidates.push({
      action: "get_company_brain_doc_detail",
      routingReason: "doc_query_active_doc_detail",
    });
  }

  return selectUniqueRouteCandidate(candidates);
}

function resolveDocRouteCandidate(text = "", {
  searchIntent = false,
  activeDoc = null,
} = {}) {
  if (searchIntent) {
    return null;
  }

  const candidates = [];

  if (hasDocSummaryIntent(text)) {
    candidates.push({
      preset: "search_and_detail_doc",
      routingReason: "doc_query_search_and_detail",
    });
  }

  if (
    !cleanText(activeDoc?.doc_id)
    && (hasDocPronounFollowUpIntent(text) || hasDocDetailContentIntent(text))
  ) {
    candidates.push({
      preset: "search_and_detail_doc",
      routingReason: "doc_query_search_and_detail",
    });
  }

  return selectUniqueRouteCandidate(candidates);
}

function route(q = "", { activeDoc = null, activeCandidates = [] } = {}) {
  const text = String(q || "");
  const wantsSearch = hasDocSearchIntent(text);
  const wantsScopedExclusionSearch = hasScopedDocExclusionSearchIntent(text);
  const followUpRoute = resolveFollowUpRouteCandidate(text, {
    activeDoc,
    activeCandidates,
  });
  if (followUpRoute) {
    return buildRouteDecision(followUpRoute);
  }

  if (wantsScopedExclusionSearch) {
    return buildRouteDecision({
      action: "search_company_brain_docs",
      routingReason: "doc_query_search",
    });
  }

  const docRoute = resolveDocRouteCandidate(text, {
    searchIntent: wantsSearch,
    activeDoc,
  });
  if (docRoute) {
    return buildRouteDecision(docRoute);
  }

  if (wantsSearch) {
    return buildRouteDecision({
      action: "search_company_brain_docs",
      routingReason: "doc_query_search",
    });
  }

  return buildRouteDecision({
    error: ROUTING_NO_MATCH,
    routingReason: "routing_no_match",
  });
}

export { hasDocDetailContentIntent };
export { hasDocPronounFollowUpIntent };
export { hasDocSearchIntent };
export { hasDocSummaryIntent };
export { hasScopedDocExclusionSearchIntent };
export { getRouteTarget };
export { route };
export default { route };
