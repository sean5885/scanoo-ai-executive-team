import { cleanText } from "./message-intent-utils.mjs";

function buildSpec({
  action = "",
  source = "",
  owner = "",
  intent = "",
  policyActionType = "",
  resourceType = "",
  confirmRequired = false,
  reviewRequired = "never",
  routeFixtures = [],
} = {}) {
  return Object.freeze({
    action: cleanText(action) || null,
    source: cleanText(source) || null,
    owner: cleanText(owner) || null,
    intent: cleanText(intent) || null,
    policy_action_type: cleanText(policyActionType) || null,
    resource_type: cleanText(resourceType) || null,
    confirm_required: confirmRequired === true,
    review_required: cleanText(reviewRequired) || "never",
    route_fixtures: Object.freeze(
      Array.isArray(routeFixtures)
        ? routeFixtures.map((fixture) => Object.freeze({
          pathname: cleanText(fixture.pathname) || null,
          method: cleanText(fixture.method || "POST").toUpperCase() || "POST",
          mode: cleanText(fixture.mode) || "observe",
          checks: Object.freeze({
            scope_key: fixture?.checks?.scope_key === true,
            idempotency_key: fixture?.checks?.idempotency_key === true,
            confirm_required: fixture?.checks?.confirm_required !== false,
            review_required: fixture?.checks?.review_required !== false,
          }),
          fixture_scope_key: cleanText(fixture.fixture_scope_key) || null,
          fixture_idempotency_key: cleanText(fixture.fixture_idempotency_key) || null,
        }))
        : [],
    ),
  });
}

function cloneSpec(spec = null) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    return null;
  }
  return {
    action: spec.action,
    source: spec.source,
    owner: spec.owner,
    intent: spec.intent,
    policy_action_type: spec.policy_action_type,
    resource_type: spec.resource_type,
    confirm_required: spec.confirm_required === true,
    review_required: spec.review_required,
    route_fixtures: Array.isArray(spec.route_fixtures)
      ? spec.route_fixtures.map((fixture) => ({
        pathname: fixture.pathname,
        method: fixture.method,
        mode: fixture.mode,
        checks: {
          scope_key: fixture?.checks?.scope_key === true,
          idempotency_key: fixture?.checks?.idempotency_key === true,
          confirm_required: fixture?.checks?.confirm_required === true,
          review_required: fixture?.checks?.review_required === true,
        },
        fixture_scope_key: fixture.fixture_scope_key,
        fixture_idempotency_key: fixture.fixture_idempotency_key,
      }))
      : [],
  };
}

export const EXTERNAL_MUTATION_SPECS = Object.freeze([
  buildSpec({
    action: "create_doc",
    source: "create_doc",
    owner: "document_http_route",
    intent: "create_doc",
    policyActionType: "create",
    resourceType: "doc_container",
    confirmRequired: true,
    reviewRequired: "conditional",
    routeFixtures: [
      {
        pathname: "/api/doc/create",
        mode: "enforce",
        checks: {
          scope_key: true,
          idempotency_key: false,
          confirm_required: true,
          review_required: true,
        },
        fixture_scope_key: "drive:root",
      },
      {
        pathname: "/agent/docs/create",
        mode: "enforce",
        checks: {
          scope_key: true,
          idempotency_key: false,
          confirm_required: true,
          review_required: true,
        },
        fixture_scope_key: "drive:root",
      },
    ],
  }),
  buildSpec({
    action: "update_doc",
    source: "update_doc",
    owner: "document_http_route",
    intent: "update_doc",
    policyActionType: "update",
    resourceType: "doc",
    confirmRequired: false,
    reviewRequired: "conditional",
    routeFixtures: [
      {
        pathname: "/api/doc/update",
        mode: "warn",
        checks: {
          scope_key: true,
          idempotency_key: false,
          confirm_required: true,
          review_required: true,
        },
        fixture_scope_key: "document:doc-update",
      },
    ],
  }),
  buildSpec({
    action: "document_comment_rewrite_apply",
    source: "doc_comment_rewrite",
    owner: "doc_rewrite_workflow",
    intent: "rewrite_apply",
    policyActionType: "replace",
    resourceType: "doc",
    confirmRequired: true,
    reviewRequired: "never",
    routeFixtures: [
      {
        pathname: "/api/doc/rewrite-from-comments",
        mode: "warn",
        checks: {
          scope_key: true,
          idempotency_key: false,
          confirm_required: true,
          review_required: true,
        },
        fixture_scope_key: "doc-rewrite:doc-rewrite",
      },
    ],
  }),
  buildSpec({
    action: "drive_organize_apply",
    source: "cloud_doc_workflow",
    owner: "cloud_doc_workflow",
    intent: "drive_organize_apply",
    policyActionType: "move",
    resourceType: "drive_folder",
    confirmRequired: true,
    reviewRequired: "always",
    routeFixtures: [
      {
        pathname: "/api/drive/organize/apply",
        mode: "observe",
        checks: {
          scope_key: true,
          idempotency_key: true,
          confirm_required: true,
          review_required: true,
        },
        fixture_scope_key: "drive:folder",
      },
    ],
  }),
  buildSpec({
    action: "wiki_organize_apply",
    source: "cloud_doc_workflow",
    owner: "cloud_doc_workflow",
    intent: "wiki_organize_apply",
    policyActionType: "move",
    resourceType: "wiki_space",
    confirmRequired: true,
    reviewRequired: "always",
    routeFixtures: [
      {
        pathname: "/api/wiki/organize/apply",
        mode: "observe",
        checks: {
          scope_key: true,
          idempotency_key: true,
          confirm_required: true,
          review_required: true,
        },
        fixture_scope_key: "wiki:space",
      },
    ],
  }),
  buildSpec({
    action: "meeting_confirm_write",
    source: "meeting_confirm",
    owner: "meeting_agent",
    intent: "meeting_writeback",
    policyActionType: "writeback",
    resourceType: "doc",
    confirmRequired: true,
    reviewRequired: "never",
    routeFixtures: [
      {
        pathname: "/api/meeting/confirm",
        mode: "warn",
        checks: {
          scope_key: true,
          idempotency_key: false,
          confirm_required: true,
          review_required: true,
        },
        fixture_scope_key: "meeting-confirm:confirm",
      },
      {
        pathname: "/meeting/confirm",
        method: "GET",
        mode: "warn",
        checks: {
          scope_key: true,
          idempotency_key: false,
          confirm_required: true,
          review_required: true,
        },
        fixture_scope_key: "meeting-confirm:confirm",
      },
    ],
  }),
  buildSpec({
    action: "create_drive_folder",
    source: "drive_http_route",
    owner: "drive_http_route",
    intent: "create_drive_folder",
    policyActionType: "create",
    resourceType: "drive_folder",
    routeFixtures: [
      {
        pathname: "/api/drive/create-folder",
        mode: "enforce",
        checks: {
          scope_key: true,
          idempotency_key: false,
          confirm_required: true,
          review_required: true,
        },
        fixture_scope_key: "drive:folder",
      },
    ],
  }),
  buildSpec({
    action: "move_drive_item",
    source: "drive_http_route",
    owner: "drive_http_route",
    intent: "move_drive_item",
    policyActionType: "move",
    resourceType: "drive_item",
    routeFixtures: [
      {
        pathname: "/api/drive/move",
        mode: "enforce",
        checks: {
          scope_key: true,
          idempotency_key: false,
          confirm_required: true,
          review_required: true,
        },
        fixture_scope_key: "drive:folder",
      },
    ],
  }),
  buildSpec({
    action: "delete_drive_item",
    source: "drive_http_route",
    owner: "drive_http_route",
    intent: "delete_drive_item",
    policyActionType: "delete",
    resourceType: "drive_item",
    routeFixtures: [
      {
        pathname: "/api/drive/delete",
        mode: "enforce",
        checks: {
          scope_key: true,
          idempotency_key: false,
          confirm_required: true,
          review_required: true,
        },
        fixture_scope_key: "drive:item",
      },
    ],
  }),
  buildSpec({
    action: "create_wiki_node",
    source: "wiki_http_route",
    owner: "wiki_http_route",
    intent: "create_wiki_node",
    policyActionType: "create",
    resourceType: "wiki_node",
    routeFixtures: [
      {
        pathname: "/api/wiki/create-node",
        mode: "enforce",
        checks: {
          scope_key: true,
          idempotency_key: false,
          confirm_required: true,
          review_required: true,
        },
        fixture_scope_key: "wiki:space:root",
      },
    ],
  }),
  buildSpec({
    action: "move_wiki_node",
    source: "wiki_http_route",
    owner: "wiki_http_route",
    intent: "move_wiki_node",
    policyActionType: "move",
    resourceType: "wiki_node",
    routeFixtures: [
      {
        pathname: "/api/wiki/move",
        mode: "enforce",
        checks: {
          scope_key: true,
          idempotency_key: false,
          confirm_required: true,
          review_required: true,
        },
        fixture_scope_key: "wiki:space:parent",
      },
    ],
  }),
  buildSpec({
    action: "message_reply",
    source: "message_http_route",
    owner: "message_http_route",
    intent: "message_reply",
    policyActionType: "reply",
    resourceType: "message",
    routeFixtures: [
      {
        pathname: "/api/messages/reply",
        mode: "enforce",
        checks: {
          scope_key: true,
          idempotency_key: false,
          confirm_required: true,
          review_required: true,
        },
        fixture_scope_key: "message:message",
      },
      {
        pathname: "/api/messages/reply-card",
        mode: "enforce",
        checks: {
          scope_key: true,
          idempotency_key: false,
          confirm_required: true,
          review_required: true,
        },
        fixture_scope_key: "message:message",
      },
    ],
  }),
  buildSpec({
    action: "message_reaction_create",
    source: "message_http_route",
    owner: "message_http_route",
    intent: "message_reaction_create",
    policyActionType: "create",
    resourceType: "message",
    routeFixtures: [
      {
        pathname: "/api/messages/test-message/reactions",
        mode: "enforce",
        checks: {
          scope_key: true,
          idempotency_key: false,
          confirm_required: true,
          review_required: true,
        },
        fixture_scope_key: "message_reaction:test-message",
      },
    ],
  }),
  buildSpec({
    action: "message_reaction_delete",
    source: "message_http_route",
    owner: "message_http_route",
    intent: "message_reaction_delete",
    policyActionType: "delete",
    resourceType: "message",
    routeFixtures: [
      {
        pathname: "/api/messages/test-message/reactions/test-reaction",
        method: "DELETE",
        mode: "enforce",
        checks: {
          scope_key: true,
          idempotency_key: false,
          confirm_required: true,
          review_required: true,
        },
        fixture_scope_key: "message_reaction:test-message",
      },
    ],
  }),
  buildSpec({
    action: "calendar_create_event",
    source: "calendar_http_route",
    owner: "calendar_http_route",
    intent: "calendar_create_event",
    policyActionType: "create",
    resourceType: "calendar",
    routeFixtures: [
      {
        pathname: "/api/calendar/events/create",
        mode: "enforce",
        checks: {
          scope_key: true,
          idempotency_key: false,
          confirm_required: true,
          review_required: true,
        },
        fixture_scope_key: "calendar:primary",
      },
    ],
  }),
  buildSpec({
    action: "task_create",
    source: "task_http_route",
    owner: "task_http_route",
    intent: "task_create",
    policyActionType: "create",
    resourceType: "task",
    routeFixtures: [
      {
        pathname: "/api/tasks/create",
        mode: "enforce",
        checks: {
          scope_key: true,
          idempotency_key: false,
          confirm_required: true,
          review_required: true,
        },
        fixture_scope_key: "task:create",
      },
    ],
  }),
  buildSpec({
    action: "task_comment_create",
    source: "task_http_route",
    owner: "task_http_route",
    intent: "task_comment_create",
    policyActionType: "create",
    resourceType: "task_comment",
    routeFixtures: [
      {
        pathname: "/api/tasks/test-task/comments",
        mode: "enforce",
        checks: {
          scope_key: true,
          idempotency_key: false,
          confirm_required: true,
          review_required: true,
        },
        fixture_scope_key: "task_comment:test-task",
      },
    ],
  }),
  buildSpec({
    action: "task_comment_update",
    source: "task_http_route",
    owner: "task_http_route",
    intent: "task_comment_update",
    policyActionType: "update",
    resourceType: "task_comment",
    routeFixtures: [
      {
        pathname: "/api/tasks/test-task/comments/test-comment",
        method: "PATCH",
        mode: "enforce",
        checks: {
          scope_key: true,
          idempotency_key: false,
          confirm_required: true,
          review_required: true,
        },
        fixture_scope_key: "task_comment:test-task",
      },
    ],
  }),
  buildSpec({
    action: "task_comment_delete",
    source: "task_http_route",
    owner: "task_http_route",
    intent: "task_comment_delete",
    policyActionType: "delete",
    resourceType: "task_comment",
    routeFixtures: [
      {
        pathname: "/api/tasks/test-task/comments/test-comment",
        method: "DELETE",
        mode: "enforce",
        checks: {
          scope_key: true,
          idempotency_key: false,
          confirm_required: true,
          review_required: true,
        },
        fixture_scope_key: "task_comment:test-task",
      },
    ],
  }),
  buildSpec({
    action: "bitable_app_create",
    source: "bitable_http_route",
    owner: "bitable_http_route",
    intent: "bitable_app_create",
    policyActionType: "create",
    resourceType: "bitable_app",
    routeFixtures: [
      {
        pathname: "/api/bitable/apps/create",
        mode: "enforce",
        checks: {
          scope_key: true,
          idempotency_key: false,
          confirm_required: true,
          review_required: true,
        },
        fixture_scope_key: "bitable_app:root",
      },
    ],
  }),
  buildSpec({
    action: "bitable_app_update",
    source: "bitable_http_route",
    owner: "bitable_http_route",
    intent: "bitable_app_update",
    policyActionType: "update",
    resourceType: "bitable_app",
    routeFixtures: [
      {
        pathname: "/api/bitable/apps/test-app",
        method: "PATCH",
        mode: "enforce",
        checks: {
          scope_key: true,
          idempotency_key: false,
          confirm_required: true,
          review_required: true,
        },
        fixture_scope_key: "bitable_app:test-app",
      },
    ],
  }),
  buildSpec({
    action: "bitable_table_create",
    source: "bitable_http_route",
    owner: "bitable_http_route",
    intent: "bitable_table_create",
    policyActionType: "create",
    resourceType: "bitable_table",
    routeFixtures: [
      {
        pathname: "/api/bitable/apps/test-app/tables/create",
        mode: "enforce",
        checks: {
          scope_key: true,
          idempotency_key: false,
          confirm_required: true,
          review_required: true,
        },
        fixture_scope_key: "bitable_table:test-app",
      },
    ],
  }),
  buildSpec({
    action: "bitable_record_create",
    source: "bitable_http_route",
    owner: "bitable_http_route",
    intent: "bitable_record_create",
    policyActionType: "create",
    resourceType: "bitable_record",
    routeFixtures: [
      {
        pathname: "/api/bitable/apps/test-app/tables/test-table/records/create",
        mode: "enforce",
        checks: {
          scope_key: true,
          idempotency_key: false,
          confirm_required: true,
          review_required: true,
        },
        fixture_scope_key: "bitable_record:test-app:test-table",
      },
    ],
  }),
  buildSpec({
    action: "bitable_record_update",
    source: "bitable_http_route",
    owner: "bitable_http_route",
    intent: "bitable_record_update",
    policyActionType: "update",
    resourceType: "bitable_record",
    routeFixtures: [
      {
        pathname: "/api/bitable/apps/test-app/tables/test-table/records/test-record",
        method: "PATCH",
        mode: "enforce",
        checks: {
          scope_key: true,
          idempotency_key: false,
          confirm_required: true,
          review_required: true,
        },
        fixture_scope_key: "bitable_record:test-app:test-table",
      },
    ],
  }),
  buildSpec({
    action: "bitable_record_delete",
    source: "bitable_http_route",
    owner: "bitable_http_route",
    intent: "bitable_record_delete",
    policyActionType: "delete",
    resourceType: "bitable_record",
    routeFixtures: [
      {
        pathname: "/api/bitable/apps/test-app/tables/test-table/records/test-record",
        method: "DELETE",
        mode: "enforce",
        checks: {
          scope_key: true,
          idempotency_key: false,
          confirm_required: true,
          review_required: true,
        },
        fixture_scope_key: "bitable_record:test-app:test-table",
      },
    ],
  }),
  buildSpec({
    action: "bitable_records_bulk_upsert",
    source: "bitable_http_route",
    owner: "bitable_http_route",
    intent: "bitable_records_bulk_upsert",
    policyActionType: "upsert",
    resourceType: "bitable_record",
    routeFixtures: [
      {
        pathname: "/api/bitable/apps/test-app/tables/test-table/records/bulk-upsert",
        mode: "enforce",
        checks: {
          scope_key: true,
          idempotency_key: false,
          confirm_required: true,
          review_required: true,
        },
        fixture_scope_key: "bitable_record:test-app:test-table",
      },
    ],
  }),
  buildSpec({
    action: "spreadsheet_create",
    source: "sheet_http_route",
    owner: "sheet_http_route",
    intent: "spreadsheet_create",
    policyActionType: "create",
    resourceType: "spreadsheet",
    routeFixtures: [
      {
        pathname: "/api/sheets/spreadsheets/create",
        mode: "enforce",
        checks: {
          scope_key: true,
          idempotency_key: false,
          confirm_required: true,
          review_required: true,
        },
        fixture_scope_key: "spreadsheet:create",
      },
    ],
  }),
  buildSpec({
    action: "spreadsheet_update",
    source: "sheet_http_route",
    owner: "sheet_http_route",
    intent: "spreadsheet_update",
    policyActionType: "update",
    resourceType: "spreadsheet",
    routeFixtures: [
      {
        pathname: "/api/sheets/spreadsheets/test-sheet",
        method: "PATCH",
        mode: "enforce",
        checks: {
          scope_key: true,
          idempotency_key: false,
          confirm_required: true,
          review_required: true,
        },
        fixture_scope_key: "spreadsheet:test-sheet",
      },
    ],
  }),
  buildSpec({
    action: "spreadsheet_replace",
    source: "sheet_http_route",
    owner: "sheet_http_route",
    intent: "spreadsheet_replace",
    policyActionType: "replace",
    resourceType: "spreadsheet_sheet",
    routeFixtures: [
      {
        pathname: "/api/sheets/spreadsheets/test-sheet/sheets/test-sheet-id/replace",
        mode: "enforce",
        checks: {
          scope_key: true,
          idempotency_key: false,
          confirm_required: true,
          review_required: true,
        },
        fixture_scope_key: "spreadsheet:test-sheet:test-sheet-id",
      },
    ],
  }),
  buildSpec({
    action: "spreadsheet_replace_batch",
    source: "sheet_http_route",
    owner: "sheet_http_route",
    intent: "spreadsheet_replace_batch",
    policyActionType: "replace",
    resourceType: "spreadsheet_sheet",
    routeFixtures: [
      {
        pathname: "/api/sheets/spreadsheets/test-sheet/sheets/test-sheet-id/replace-batch",
        mode: "enforce",
        checks: {
          scope_key: true,
          idempotency_key: false,
          confirm_required: true,
          review_required: true,
        },
        fixture_scope_key: "spreadsheet:test-sheet:test-sheet-id",
      },
    ],
  }),
  buildSpec({
    action: "meeting_capture_create_document",
    source: "meeting_capture_runtime",
    owner: "lane_executor",
    intent: "meeting_capture_document_create",
    policyActionType: "create",
    resourceType: "doc_container",
  }),
  buildSpec({
    action: "meeting_capture_document_update",
    source: "meeting_capture_runtime",
    owner: "lane_executor",
    intent: "meeting_capture_document_update",
    policyActionType: "replace",
    resourceType: "doc",
  }),
  buildSpec({
    action: "meeting_capture_document_delete",
    source: "meeting_capture_runtime",
    owner: "lane_executor",
    intent: "meeting_capture_document_delete",
    policyActionType: "delete",
    resourceType: "doc",
  }),
]);

export function getExternalMutationSpec(action = "") {
  const normalizedAction = cleanText(action);
  if (!normalizedAction) {
    return null;
  }
  const matched = EXTERNAL_MUTATION_SPECS.find((spec) => spec.action === normalizedAction);
  return cloneSpec(matched || null);
}

export function listExternalMutationSpecs() {
  return EXTERNAL_MUTATION_SPECS.map((spec) => cloneSpec(spec));
}

export function listExternalMutationRouteFixtures() {
  return EXTERNAL_MUTATION_SPECS.flatMap((spec) => (
    Array.isArray(spec.route_fixtures)
      ? spec.route_fixtures.map((fixture) => ({
        action: spec.action,
        pathname: fixture.pathname,
        method: fixture.method,
        mode: fixture.mode,
        checks: {
          scope_key: fixture?.checks?.scope_key === true,
          idempotency_key: fixture?.checks?.idempotency_key === true,
          confirm_required: fixture?.checks?.confirm_required === true,
          review_required: fixture?.checks?.review_required === true,
        },
        fixture_scope_key: fixture.fixture_scope_key,
        fixture_idempotency_key: fixture.fixture_idempotency_key,
      }))
      : []
  ));
}
