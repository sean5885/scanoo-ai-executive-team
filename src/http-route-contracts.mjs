const EXACT_METHODS = new Map([
  ["/health", ["GET"]],
  ["/oauth/lark/login", ["GET"]],
  ["/api/auth/status", ["GET"]],
  ["/api/runtime/resolve-scopes", ["POST"]],
  ["/api/runtime/sessions", ["GET"]],
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
  ["/agent/tasks", ["POST"]],
]);

const REGEX_METHODS = [
  [/^\/agent\/approvals\/[^/]+\/(approve|reject)$/, ["POST"]],
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
