import {
  getCompanyBrainLifecycleRouteContract,
} from "./company-brain-lifecycle-contract.mjs";
import { getDocumentCreateGovernanceContract } from "./lark-write-guard.mjs";
import {
  buildCompanyBrainLearningUpdateWritePolicy,
  buildCompanyBrainLearningIngestWritePolicy,
  cloneWritePolicyRecord,
  getPhase1RouteWritePolicyFixture,
  listPhase1RouteWritePolicyFixtures,
} from "./write-policy-contract.mjs";
import {
  getWritePolicyEnforcementFixture,
} from "./write-policy-enforcement.mjs";
import { cleanText } from "./message-intent-utils.mjs";

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
  ["/api/monitoring/autonomy/receipt", ["GET"]],
  ["/api/monitoring/autonomy/final", ["GET"]],
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
  ["/agent/lark-plugin/dispatch", ["POST"]],
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

const WRITE_POLICY_FIXTURES = listPhase1RouteWritePolicyFixtures();

function findWritePolicyFixture({
  pathname = "",
  method = "",
  action = "",
} = {}) {
  const normalizedPathname = pathname;
  const normalizedMethod = method;
  const normalizedAction = action;

  if (normalizedPathname) {
    const matchedByPath = WRITE_POLICY_FIXTURES.find((fixture) => (
      fixture.pathname === normalizedPathname
      && (!normalizedMethod || fixture.method === normalizedMethod)
    ));
    if (matchedByPath) {
      return matchedByPath;
    }
  }

  if (normalizedAction) {
    const matchedByAction = WRITE_POLICY_FIXTURES.find((fixture) => (
      fixture.action === normalizedAction
      && (!normalizedMethod || fixture.method === normalizedMethod)
    ));
    if (matchedByAction) {
      return matchedByAction;
    }
  }

  return null;
}

function buildWriteRouteContract({
  action = "",
  pathname = "",
  method = "POST",
  delegatesTo = null,
} = {}) {
  const fixture = findWritePolicyFixture({
    pathname,
    method,
    action,
  });
  return {
    action,
    ...(delegatesTo ? { delegates_to: delegatesTo } : {}),
    write_policy: cloneWritePolicyRecord(fixture?.write_policy),
  };
}

const EXACT_ROUTE_CONTRACTS = new Map([
  ["/api/doc/create", {
    action: "create_doc",
    governance: getDocumentCreateGovernanceContract(),
    write_policy: getPhase1RouteWritePolicyFixture("/api/doc/create", "POST")?.write_policy,
  }],
  ["/agent/docs/create", {
    action: "create_doc",
    delegates_to: "/api/doc/create",
    governance: getDocumentCreateGovernanceContract(),
    write_policy: getPhase1RouteWritePolicyFixture("/agent/docs/create", "POST")?.write_policy,
  }],
  ["/api/drive/create-folder", buildWriteRouteContract({
    action: "create_drive_folder",
    pathname: "/api/drive/create-folder",
    method: "POST",
  })],
  ["/api/drive/move", buildWriteRouteContract({
    action: "move_drive_item",
    pathname: "/api/drive/move",
    method: "POST",
  })],
  ["/api/drive/delete", buildWriteRouteContract({
    action: "delete_drive_item",
    pathname: "/api/drive/delete",
    method: "POST",
  })],
  ["/api/doc/update", {
    action: "update_doc",
    write_policy: getPhase1RouteWritePolicyFixture("/api/doc/update", "POST")?.write_policy,
  }],
  ["/api/wiki/create-node", buildWriteRouteContract({
    action: "create_wiki_node",
    pathname: "/api/wiki/create-node",
    method: "POST",
  })],
  ["/api/wiki/move", buildWriteRouteContract({
    action: "move_wiki_node",
    pathname: "/api/wiki/move",
    method: "POST",
  })],
  ["/api/drive/organize/apply", {
    action: "drive_organize_apply",
    write_policy: getPhase1RouteWritePolicyFixture("/api/drive/organize/apply", "POST")?.write_policy,
  }],
  ["/api/wiki/organize/apply", {
    action: "wiki_organize_apply",
    write_policy: getPhase1RouteWritePolicyFixture("/api/wiki/organize/apply", "POST")?.write_policy,
  }],
  ["/api/doc/rewrite-from-comments", {
    action: "document_comment_rewrite_apply",
    write_policy: getPhase1RouteWritePolicyFixture("/api/doc/rewrite-from-comments", "POST")?.write_policy,
  }],
  ["/api/meeting/confirm", {
    action: "meeting_confirm_write",
    write_policy: getPhase1RouteWritePolicyFixture("/api/meeting/confirm", "POST")?.write_policy,
  }],
  ["/meeting/confirm", {
    action: "meeting_confirm_write",
    write_policy: getPhase1RouteWritePolicyFixture("/meeting/confirm", "GET")?.write_policy,
  }],
  ["/api/messages/reply", buildWriteRouteContract({
    action: "message_reply",
    pathname: "/api/messages/reply",
    method: "POST",
  })],
  ["/api/messages/reply-card", buildWriteRouteContract({
    action: "message_reply",
    pathname: "/api/messages/reply-card",
    method: "POST",
  })],
  ["/api/calendar/events/create", buildWriteRouteContract({
    action: "calendar_create_event",
    pathname: "/api/calendar/events/create",
    method: "POST",
  })],
  ["/api/tasks/create", buildWriteRouteContract({
    action: "task_create",
    pathname: "/api/tasks/create",
    method: "POST",
  })],
  ["/api/bitable/apps/create", buildWriteRouteContract({
    action: "bitable_app_create",
    pathname: "/api/bitable/apps/create",
    method: "POST",
  })],
  ["/api/sheets/spreadsheets/create", buildWriteRouteContract({
    action: "spreadsheet_create",
    pathname: "/api/sheets/spreadsheets/create",
    method: "POST",
  })],
  ["/agent/company-brain/learning/ingest", {
    action: "ingest_learning_doc",
    write_policy: buildCompanyBrainLearningIngestWritePolicy(),
  }],
  ["/agent/company-brain/learning/state", {
    action: "update_learning_state",
    write_policy: buildCompanyBrainLearningUpdateWritePolicy(),
  }],
]);

const REGEX_ROUTE_CONTRACTS = [
  {
    pattern: /^\/api\/messages\/[^/]+\/reactions$/,
    method: "POST",
    contract: buildWriteRouteContract({
      action: "message_reaction_create",
      method: "POST",
    }),
  },
  {
    pattern: /^\/api\/messages\/[^/]+\/reactions\/[^/]+$/,
    method: "DELETE",
    contract: buildWriteRouteContract({
      action: "message_reaction_delete",
      method: "DELETE",
    }),
  },
  {
    pattern: /^\/api\/tasks\/[^/]+\/comments$/,
    method: "POST",
    contract: buildWriteRouteContract({
      action: "task_comment_create",
      method: "POST",
    }),
  },
  {
    pattern: /^\/api\/tasks\/[^/]+\/comments\/[^/]+$/,
    method: "PUT",
    contract: buildWriteRouteContract({
      action: "task_comment_update",
      method: "PATCH",
    }),
  },
  {
    pattern: /^\/api\/tasks\/[^/]+\/comments\/[^/]+$/,
    method: "PATCH",
    contract: buildWriteRouteContract({
      action: "task_comment_update",
      method: "PATCH",
    }),
  },
  {
    pattern: /^\/api\/tasks\/[^/]+\/comments\/[^/]+$/,
    method: "DELETE",
    contract: buildWriteRouteContract({
      action: "task_comment_delete",
      method: "DELETE",
    }),
  },
  {
    pattern: /^\/api\/bitable\/apps\/[^/]+$/,
    method: "PATCH",
    contract: buildWriteRouteContract({
      action: "bitable_app_update",
      method: "PATCH",
    }),
  },
  {
    pattern: /^\/api\/bitable\/apps\/[^/]+\/tables\/create$/,
    method: "POST",
    contract: buildWriteRouteContract({
      action: "bitable_table_create",
      method: "POST",
    }),
  },
  {
    pattern: /^\/api\/bitable\/apps\/[^/]+\/tables\/[^/]+\/records\/create$/,
    method: "POST",
    contract: buildWriteRouteContract({
      action: "bitable_record_create",
      method: "POST",
    }),
  },
  {
    pattern: /^\/api\/bitable\/apps\/[^/]+\/tables\/[^/]+\/records\/bulk-upsert$/,
    method: "POST",
    contract: buildWriteRouteContract({
      action: "bitable_records_bulk_upsert",
      method: "POST",
    }),
  },
  {
    pattern: /^\/api\/bitable\/apps\/[^/]+\/tables\/[^/]+\/records\/[^/]+$/,
    method: "POST",
    contract: buildWriteRouteContract({
      action: "bitable_record_update",
      method: "PATCH",
    }),
  },
  {
    pattern: /^\/api\/bitable\/apps\/[^/]+\/tables\/[^/]+\/records\/[^/]+$/,
    method: "PATCH",
    contract: buildWriteRouteContract({
      action: "bitable_record_update",
      method: "PATCH",
    }),
  },
  {
    pattern: /^\/api\/bitable\/apps\/[^/]+\/tables\/[^/]+\/records\/[^/]+$/,
    method: "DELETE",
    contract: buildWriteRouteContract({
      action: "bitable_record_delete",
      method: "DELETE",
    }),
  },
  {
    pattern: /^\/api\/sheets\/spreadsheets\/[^/]+$/,
    method: "POST",
    contract: buildWriteRouteContract({
      action: "spreadsheet_update",
      method: "PATCH",
    }),
  },
  {
    pattern: /^\/api\/sheets\/spreadsheets\/[^/]+$/,
    method: "PATCH",
    contract: buildWriteRouteContract({
      action: "spreadsheet_update",
      method: "PATCH",
    }),
  },
  {
    pattern: /^\/api\/sheets\/spreadsheets\/[^/]+\/sheets\/[^/]+\/replace$/,
    method: "POST",
    contract: buildWriteRouteContract({
      action: "spreadsheet_replace",
      method: "POST",
    }),
  },
  {
    pattern: /^\/api\/sheets\/spreadsheets\/[^/]+\/sheets\/[^/]+\/replace-batch$/,
    method: "POST",
    contract: buildWriteRouteContract({
      action: "spreadsheet_replace_batch",
      method: "POST",
    }),
  },
];

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

export function getRouteContract(pathname = "", method = "") {
  const methods = getAllowedMethodsForPath(pathname);
  if (!Array.isArray(methods) || methods.length === 0) {
    return null;
  }

  const normalizedMethod = cleanText(method).toUpperCase();
  const regexContract = REGEX_ROUTE_CONTRACTS.find((entry) => (
    entry.pattern.test(pathname)
    && (!normalizedMethod || entry.method === normalizedMethod)
  ))?.contract || null;
  const contract = EXACT_ROUTE_CONTRACTS.get(pathname) || regexContract || getCompanyBrainLifecycleRouteContract(pathname);
  return {
    pathname,
    methods,
    action: contract?.action || null,
    delegates_to: contract?.delegates_to || null,
    governance: contract?.governance || null,
    write_policy: cloneWritePolicyRecord(contract?.write_policy),
    write_policy_enforcement: getWritePolicyEnforcementFixture(pathname, normalizedMethod),
  };
}
