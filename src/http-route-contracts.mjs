import {
  getCompanyBrainLifecycleRouteContract,
} from "./company-brain-lifecycle-contract.mjs";
import { getDocumentCreateGovernanceContract } from "./lark-write-guard.mjs";
import {
  cloneWritePolicyRecord,
  getPhase1RouteWritePolicyFixture,
} from "./write-policy-contract.mjs";
import {
  getWritePolicyEnforcementFixture,
} from "./write-policy-enforcement.mjs";

const EXACT_METHODS = new Map([
  ["/health", ["GET"]],
  ["/monitoring", ["GET"]],
  ["/oauth/lark/login", ["GET"]],
  ["/api/auth/status", ["GET"]],
  ["/api/runtime/resolve-scopes", ["POST"]],
  ["/api/runtime/sessions", ["GET"]],
  ["/api/monitoring/requests", ["GET"]],
  ["/api/monitoring/errors", ["GET"]],
  ["/api/monitoring/errors/latest", ["GET"]],
  ["/api/monitoring/metrics", ["GET"]],
  ["/api/drive/root", ["GET"]],
  ["/api/drive/list", ["GET"]],
  ["/api/drive/create-folder", ["POST"]],
  ["/api/drive/move", ["POST"]],
  ["/api/drive/task-status", ["GET"]],
  ["/api/drive/delete", ["POST"]],
  ["/api/drive/organize/preview", ["POST"]],
  ["/api/drive/organize/apply", ["POST"]],
  ["/api/wiki/spaces", ["GET"]],
  ["/api/wiki/create-node", ["POST"]],
  ["/api/wiki/move", ["POST"]],
  ["/api/wiki/organize/preview", ["POST"]],
  ["/api/wiki/organize/apply", ["POST"]],
  ["/api/doc/read", ["GET"]],
  ["/api/doc/create", ["POST"]],
  ["/api/doc/update", ["POST"]],
  ["/api/doc/comments", ["GET"]],
  ["/api/doc/rewrite-from-comments", ["POST"]],
  ["/api/doc/comments/suggestion-card", ["POST"]],
  ["/api/doc/comments/poll-suggestion-cards", ["POST"]],
  ["/api/meeting/process", ["POST"]],
  ["/api/meeting/confirm", ["POST"]],
  ["/meeting/confirm", ["GET"]],
  ["/api/messages", ["GET"]],
  ["/api/messages/search", ["GET"]],
  ["/api/messages/reply", ["POST"]],
  ["/api/messages/reply-card", ["POST"]],
  ["/api/calendar/primary", ["GET"]],
  ["/api/calendar/events", ["GET"]],
  ["/api/calendar/events/search", ["POST"]],
  ["/api/calendar/events/create", ["POST"]],
  ["/api/calendar/freebusy", ["POST"]],
  ["/api/tasks", ["GET"]],
  ["/api/tasks/create", ["POST"]],
  ["/api/bitable/apps/create", ["POST"]],
  ["/api/sheets/spreadsheets/create", ["POST"]],
  ["/sync/full", ["POST"]],
  ["/sync/incremental", ["POST"]],
  ["/search", ["GET"]],
  ["/answer", ["GET"]],
  ["/agent/security/status", ["GET"]],
  ["/agent/approvals", ["GET"]],
  ["/agent/improvements", ["GET"]],
  ["/agent/docs/create", ["POST"]],
  ["/agent/company-brain/docs", ["GET"]],
  ["/agent/company-brain/search", ["GET"]],
  ["/agent/company-brain/approved/docs", ["GET"]],
  ["/agent/company-brain/approved/search", ["GET"]],
  ["/agent/company-brain/review", ["POST"]],
  ["/agent/company-brain/conflicts", ["POST"]],
  ["/agent/company-brain/approval-transition", ["POST"]],
  ["/agent/company-brain/learning/ingest", ["POST"]],
  ["/agent/company-brain/learning/state", ["POST"]],
  ["/agent/system/runtime-info", ["GET"]],
  ["/api/company-brain/search", ["GET"]],
  ["/agent/tasks", ["POST"]],
]);

const REGEX_METHODS = [
  [/^\/api\/company-brain\/docs\/[^/]+$/, ["GET"]],
  [/^\/agent\/company-brain\/docs\/[^/]+$/, ["GET"]],
  [/^\/agent\/company-brain\/approved\/docs\/[^/]+$/, ["GET"]],
  [/^\/agent\/company-brain\/docs\/[^/]+\/apply$/, ["POST"]],
  [/^\/agent\/approvals\/[^/]+\/(approve|reject)$/, ["POST"]],
  [/^\/agent\/improvements\/[^/]+\/(approve|reject)$/, ["POST"]],
  [/^\/agent\/improvements\/[^/]+\/apply$/, ["POST"]],
  [/^\/agent\/tasks\/[^/]+\/actions$/, ["POST"]],
  [/^\/agent\/tasks\/[^/]+\/finish$/, ["POST"]],
  [/^\/agent\/tasks\/[^/]+\/rollback$/, ["POST"]],
  [/^\/api\/wiki\/spaces\/[^/]+\/nodes$/, ["GET"]],
  [/^\/api\/messages\/[^/]+$/, ["GET"]],
  [/^\/api\/messages\/[^/]+\/reactions$/, ["GET", "POST"]],
  [/^\/api\/messages\/[^/]+\/reactions\/[^/]+$/, ["DELETE"]],
  [/^\/api\/tasks\/[^/]+$/, ["GET"]],
  [/^\/api\/tasks\/[^/]+\/comments$/, ["GET", "POST"]],
  [/^\/api\/tasks\/[^/]+\/comments\/[^/]+$/, ["GET", "POST", "PUT", "PATCH", "DELETE"]],
  [/^\/api\/bitable\/apps\/[^/]+$/, ["GET", "POST", "PATCH"]],
  [/^\/api\/bitable\/apps\/[^/]+\/tables$/, ["GET"]],
  [/^\/api\/bitable\/apps\/[^/]+\/tables\/create$/, ["POST"]],
  [/^\/api\/bitable\/apps\/[^/]+\/tables\/[^/]+\/records$/, ["GET"]],
  [/^\/api\/bitable\/apps\/[^/]+\/tables\/[^/]+\/records\/search$/, ["POST"]],
  [/^\/api\/bitable\/apps\/[^/]+\/tables\/[^/]+\/records\/create$/, ["POST"]],
  [/^\/api\/bitable\/apps\/[^/]+\/tables\/[^/]+\/records\/bulk-upsert$/, ["POST"]],
  [/^\/api\/bitable\/apps\/[^/]+\/tables\/[^/]+\/records\/[^/]+$/, ["GET", "POST", "PATCH", "DELETE"]],
  [/^\/api\/sheets\/spreadsheets\/[^/]+$/, ["GET", "POST", "PATCH"]],
  [/^\/api\/sheets\/spreadsheets\/[^/]+\/sheets$/, ["GET"]],
  [/^\/api\/sheets\/spreadsheets\/[^/]+\/sheets\/[^/]+$/, ["GET"]],
  [/^\/api\/sheets\/spreadsheets\/[^/]+\/sheets\/[^/]+\/replace$/, ["POST"]],
  [/^\/api\/sheets\/spreadsheets\/[^/]+\/sheets\/[^/]+\/replace-batch$/, ["POST"]],
];

const EXACT_ROUTE_CONTRACTS = new Map([
  ["/api/doc/create", {
    action: "create_doc",
    governance: getDocumentCreateGovernanceContract(),
    write_policy: getPhase1RouteWritePolicyFixture("/api/doc/create")?.write_policy,
  }],
  ["/agent/docs/create", {
    action: "create_doc",
    delegates_to: "/api/doc/create",
    governance: getDocumentCreateGovernanceContract(),
    write_policy: getPhase1RouteWritePolicyFixture("/agent/docs/create")?.write_policy,
  }],
  ["/api/doc/update", {
    action: "update_doc",
    write_policy: getPhase1RouteWritePolicyFixture("/api/doc/update")?.write_policy,
  }],
  ["/api/drive/organize/apply", {
    action: "drive_organize_apply",
    write_policy: getPhase1RouteWritePolicyFixture("/api/drive/organize/apply")?.write_policy,
  }],
  ["/api/wiki/organize/apply", {
    action: "wiki_organize_apply",
    write_policy: getPhase1RouteWritePolicyFixture("/api/wiki/organize/apply")?.write_policy,
  }],
  ["/api/doc/rewrite-from-comments", {
    action: "document_comment_rewrite_apply",
    write_policy: getPhase1RouteWritePolicyFixture("/api/doc/rewrite-from-comments")?.write_policy,
  }],
  ["/api/meeting/confirm", {
    action: "meeting_confirm_write",
    write_policy: getPhase1RouteWritePolicyFixture("/api/meeting/confirm")?.write_policy,
  }],
  ["/meeting/confirm", {
    action: "meeting_confirm_write",
    write_policy: getPhase1RouteWritePolicyFixture("/meeting/confirm")?.write_policy,
  }],
]);

export function getAllowedMethodsForPath(pathname) {
  if (EXACT_METHODS.has(pathname)) {
    return EXACT_METHODS.get(pathname);
  }

  for (const [pattern, methods] of REGEX_METHODS) {
    if (pattern.test(pathname)) {
      return methods;
    }
  }

  return null;
}

export function getRouteContract(pathname = "") {
  const methods = getAllowedMethodsForPath(pathname);
  if (!Array.isArray(methods) || methods.length === 0) {
    return null;
  }

  const contract = EXACT_ROUTE_CONTRACTS.get(pathname) || getCompanyBrainLifecycleRouteContract(pathname);
  return {
    pathname,
    methods,
    action: contract?.action || null,
    delegates_to: contract?.delegates_to || null,
    governance: contract?.governance || null,
    write_policy: cloneWritePolicyRecord(contract?.write_policy),
    write_policy_enforcement: getWritePolicyEnforcementFixture(pathname),
  };
}
