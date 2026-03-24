import * as Lark from "@larksuiteoapi/node-sdk";
import { apiBaseUrl, baseConfig } from "./config.mjs";
import { resolveLarkRequestAuth } from "./lark-request-auth.mjs";
import { createRuntimeLogger } from "./runtime-observability.mjs";
import {
  assertLarkWriteAllowed,
  assertDocumentCreateAllowed,
  assertDocumentCreateProbeAllowed,
  shouldAllowCreateRootFallback,
} from "./lark-write-guard.mjs";

const userClient = new Lark.Client(baseConfig);
const contentLogger = createRuntimeLogger({ logger: console, component: "lark_content" });
const WIKI_PAGE_SIZE = 50;
const DRIVE_PAGE_SIZE = 200;
const DOC_BLOCK_PAGE_SIZE = 500;
const MESSAGE_PAGE_SIZE = 50;
const TASK_PAGE_SIZE = 50;
const DOC_CREATE_PLATFORM_BLOCKED_CODE = 1063003;
const DOC_CREATE_DIAGNOSIS = {
  ROOT_BLOCKED: "ROOT_BLOCKED",
  FOLDER_BLOCKED: "FOLDER_BLOCKED",
  UNKNOWN: "UNKNOWN",
};

function destroyAgent(agent) {
  if (agent && typeof agent.destroy === "function") {
    agent.destroy();
  }
}

export function disposeLarkContentClientForTests() {
  const httpDefaults = userClient?.httpInstance?.defaults || {};
  destroyAgent(httpDefaults.httpAgent);
  destroyAgent(httpDefaults.httpsAgent);
}

function withAccessToken(accessToken, tokenType = "user") {
  if (tokenType === "tenant") {
    return Lark.withTenantToken(accessToken);
  }
  return Lark.withUserAccessToken(accessToken);
}

async function resolveContentAuth(accessToken, tokenType = "user") {
  return resolveLarkRequestAuth(accessToken, { tokenType });
}

function safeParseJson(value) {
  if (!value || typeof value !== "string") {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function unwrapResponse(response, fallbackMessage) {
  if (response.code !== 0) {
    throw new Error(response.msg || fallbackMessage);
  }

  return response.data || {};
}

function shouldRetryLarkMessageError(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("timeout") ||
    message.includes("temporar") ||
    message.includes("rate") ||
    message.includes("429") ||
    message.includes("502") ||
    message.includes("503") ||
    message.includes("504")
  );
}

async function withMessageRetry(operation) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === 1 || !shouldRetryLarkMessageError(error)) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function getDriveRootFolderMeta(accessToken) {
  const response = await fetch(`${apiBaseUrl}/open-apis/drive/explorer/v2/root_folder/meta`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
  const data = await response.json();
  if (!response.ok || data.code !== 0) {
    throw new Error(data.msg || "Failed to resolve Lark Drive root folder");
  }
  return data.data || {};
}

function extractLarkPlatformError(error) {
  const raw = error?.response?.data || null;
  const platformCode = Number.isFinite(Number(raw?.code)) ? Number(raw.code) : null;
  const platformMsg = raw?.msg || raw?.message || String(error?.message || "unknown_error");
  const logId = raw?.log_id || raw?.error?.log_id || null;
  return {
    http_status: Number.isFinite(Number(error?.response?.status)) ? Number(error.response.status) : null,
    platform_code: platformCode,
    platform_msg: platformMsg,
    log_id: logId,
    raw: raw || {
      message: String(error?.message || "unknown_error"),
    },
  };
}

function isDocCreatePlatformBlockedError(error) {
  return extractLarkPlatformError(error).platform_code === DOC_CREATE_PLATFORM_BLOCKED_CODE;
}

function buildDocCreateStructuredError({
  stage = "",
  tokenType = "user",
  title = "",
  folderToken = "",
  error,
  diagnosis = DOC_CREATE_DIAGNOSIS.UNKNOWN,
  probe = null,
} = {}) {
  const platform = extractLarkPlatformError(error);
  const payload = {
    stage,
    http_status: platform.http_status,
    platform_code: platform.platform_code,
    platform_msg: platform.platform_msg,
    log_id: platform.log_id,
    token_type: tokenType,
    title,
    folder_token: folderToken || null,
    diagnosis,
    probe,
    raw: platform.raw,
  };
  const structuredError = new Error(JSON.stringify(payload));
  structuredError.name = "LarkDocCreateError";
  Object.assign(structuredError, payload);
  return structuredError;
}

function logDocCreateDiagnostic({
  mode = "direct",
  tokenType = "user",
  folderToken = "",
  platformCode = null,
  platformMsg = "",
  logId = null,
} = {}) {
  contentLogger.info("lark_doc_create_diagnostic", {
    action: "document_create",
    status: "diagnostic",
    token_type: tokenType,
    has_folder_token: Boolean(folderToken),
    mode,
    code: platformCode,
    msg: platformMsg || null,
    log_id: logId || null,
  });
}

function normalizeDriveList(data) {
  return {
    files: data.files || [],
    page_token: data.next_page_token || null,
    has_more: Boolean(data.has_more),
  };
}

function normalizeDocumentUrl(documentId) {
  return documentId ? `https://larksuite.com/docx/${documentId}` : null;
}

async function createDocumentDirect(accessToken, title, folderToken, tokenType = "user") {
  const data = unwrapResponse(
    await userClient.docx.document.create(
      {
        data: {
          title,
          folder_token: folderToken || undefined,
        },
      },
      withAccessToken(accessToken, tokenType),
    ),
    "Failed to create Lark document",
  );

  const document = data.document || {};
  return {
    document_id: document.document_id || null,
    revision_id: document.revision_id || null,
    title: document.title || title,
    folder_token: folderToken || null,
    url: normalizeDocumentUrl(document.document_id || null),
  };
}

export async function probeDocumentCreateCapability(accessToken, title, folderToken, tokenType = "user", options = {}) {
  assertDocumentCreateProbeAllowed({
    title,
    source: options?.source || "doc_create_probe",
    requestedFolderToken: folderToken,
  });
  ({ accessToken, tokenType } = await resolveContentAuth(accessToken, tokenType));
  let folderOk = false;
  let rootOk = false;
  let folderError = null;
  let rootError = null;

  try {
    await createDocumentDirect(accessToken, title, folderToken, tokenType);
    folderOk = true;
  } catch (error) {
    folderError = extractLarkPlatformError(error);
    logDocCreateDiagnostic({
      mode: "probe",
      tokenType,
      folderToken,
      platformCode: folderError.platform_code,
      platformMsg: folderError.platform_msg,
      logId: folderError.log_id,
    });
  }

  try {
    await createDocumentDirect(accessToken, title, "", tokenType);
    rootOk = true;
  } catch (error) {
    rootError = extractLarkPlatformError(error);
    logDocCreateDiagnostic({
      mode: "probe",
      tokenType,
      folderToken: "",
      platformCode: rootError.platform_code,
      platformMsg: rootError.platform_msg,
      logId: rootError.log_id,
    });
  }

  let diagnosis = DOC_CREATE_DIAGNOSIS.UNKNOWN;
  if (!rootOk && !folderOk) {
    diagnosis = DOC_CREATE_DIAGNOSIS.ROOT_BLOCKED;
  } else if (rootOk && !folderOk) {
    diagnosis = DOC_CREATE_DIAGNOSIS.FOLDER_BLOCKED;
  }

  return {
    root_ok: rootOk,
    folder_ok: folderOk,
    diagnosis,
    root_error: rootError,
    folder_error: folderError,
  };
}

function normalizeDocumentContent(content) {
  return String(content || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

function extractRichTextElementsText(elements) {
  if (!Array.isArray(elements)) {
    return "";
  }

  return elements
    .map((element) => {
      if (!element || typeof element !== "object") {
        return "";
      }
      if (element.type === "text_run") {
        return element.text_run?.text || "";
      }
      if (element.type === "docs_link") {
        return element.docs_link?.url || "";
      }
      if (element.type === "person") {
        return element.person?.user_id ? `@${element.person.user_id}` : "";
      }
      return "";
    })
    .filter(Boolean)
    .join("")
    .trim();
}

function normalizeDocumentCommentReply(reply) {
  return {
    reply_id: reply?.reply_id || null,
    user_id: reply?.user_id || null,
    create_time: reply?.create_time || null,
    update_time: reply?.update_time || null,
    text: extractRichTextElementsText(reply?.content?.elements || []),
    images: reply?.extra?.image_list || [],
  };
}

function normalizeDocumentComment(item) {
  const replies = item?.reply_list?.replies || [];
  return {
    comment_id: item?.comment_id || null,
    user_id: item?.user_id || null,
    create_time: item?.create_time || null,
    update_time: item?.update_time || null,
    is_solved: Boolean(item?.is_solved),
    solved_time: item?.solved_time || null,
    solver_user_id: item?.solver_user_id || null,
    is_whole: typeof item?.is_whole === "boolean" ? item.is_whole : null,
    quote: item?.quote || "",
    replies: replies.map(normalizeDocumentCommentReply),
    latest_reply_text:
      replies.length > 0 ? normalizeDocumentCommentReply(replies[replies.length - 1]).text : "",
  };
}

function extractMessageText(item) {
  const content = item?.body?.content || "";
  const parsed = safeParseJson(content);
  if (parsed && typeof parsed === "object") {
    if (typeof parsed.text === "string") {
      return parsed.text.trim();
    }
    if (Array.isArray(parsed.content)) {
      const text = parsed.content
        .flat()
        .map((part) => (part && typeof part.text === "string" ? part.text : ""))
        .filter(Boolean)
        .join("");
      if (text) {
        return text.trim();
      }
    }
  }
  return String(content || "").trim();
}

function normalizeMessageItem(item) {
  return {
    message_id: item?.message_id || null,
    root_id: item?.root_id || null,
    parent_id: item?.parent_id || null,
    thread_id: item?.thread_id || null,
    upper_message_id: item?.upper_message_id || null,
    chat_id: item?.chat_id || null,
    msg_type: item?.msg_type || null,
    create_time: item?.create_time || null,
    update_time: item?.update_time || null,
    deleted: Boolean(item?.deleted),
    updated: Boolean(item?.updated),
    sender: item?.sender || null,
    mentions: item?.mentions || [],
    content: item?.body?.content || "",
    text: extractMessageText(item),
  };
}

function normalizeCalendar(data) {
  const calendar = data?.calendar || data || {};
  return {
    calendar_id: calendar.calendar_id || calendar.id || null,
    summary: calendar.summary || null,
    description: calendar.description || null,
    role: calendar.role || null,
    color: calendar.color || null,
    is_deleted: Boolean(calendar.is_deleted),
  };
}

function normalizeCalendarEvent(data) {
  const event = data?.event || data || {};
  return {
    event_id: event.event_id || event.id || null,
    summary: event.summary || null,
    description: event.description || null,
    status: event.status || null,
    calendar_id: event.calendar_id || null,
    start_time: event.start_time || null,
    end_time: event.end_time || null,
    visibility: event.visibility || null,
    attendee_ability: event.attendee_ability || null,
    free_busy_status: event.free_busy_status || null,
    location: event.location || null,
    meeting_url: event.vchat?.meeting_url || null,
  };
}

function normalizeTask(task) {
  return {
    task_id: task?.id || null,
    summary: task?.summary || null,
    description: task?.description || null,
    create_time: task?.create_time || null,
    update_time: task?.update_time || null,
    complete_time: task?.complete_time || null,
    due: task?.due || null,
    collaborator_ids: task?.collaborator_ids || [],
    follower_ids: task?.follower_ids || [],
    can_edit: typeof task?.can_edit === "boolean" ? task.can_edit : null,
    origin: task?.origin || null,
    repeat_rule: task?.repeat_rule || null,
  };
}

function normalizeBitableApp(data) {
  const app = data?.app || data || {};
  return {
    app_token: app.app_token || null,
    name: app.name || null,
    revision: app.revision ?? null,
    folder_token: app.folder_token || null,
    url: app.url || null,
    default_table_id: app.default_table_id || null,
    time_zone: app.time_zone || null,
    is_advanced: typeof app.is_advanced === "boolean" ? app.is_advanced : null,
  };
}

function normalizeBitableTable(item) {
  return {
    table_id: item?.table_id || null,
    revision: item?.revision ?? null,
    name: item?.name || null,
  };
}

function normalizeBitableRecord(item) {
  return {
    record_id: item?.record_id || null,
    fields: item?.fields || {},
    created_by: item?.created_by || null,
    created_time: item?.created_time ?? null,
    last_modified_by: item?.last_modified_by || null,
    last_modified_time: item?.last_modified_time ?? null,
    shared_url: item?.shared_url || null,
    record_url: item?.record_url || null,
  };
}

function normalizeSpreadsheet(data) {
  const spreadsheet = data?.spreadsheet || data || {};
  return {
    spreadsheet_token: spreadsheet.spreadsheet_token || spreadsheet.token || null,
    title: spreadsheet.title || spreadsheet.name || null,
    url: spreadsheet.url || null,
    folder_token: spreadsheet.folder_token || null,
    revision: spreadsheet.revision ?? null,
  };
}

function normalizeSpreadsheetSheet(item) {
  const sheet = item?.sheet || item || {};
  return {
    sheet_id: sheet.sheet_id || null,
    title: sheet.title || null,
    index: sheet.index ?? null,
    hidden: typeof sheet.hidden === "boolean" ? sheet.hidden : null,
    grid_properties: sheet.grid_properties || null,
    resource_type: sheet.resource_type || null,
    merges: sheet.merges || [],
  };
}

function normalizeTaskComment(item) {
  const comment = item?.comment || item || {};
  return {
    comment_id: comment.id || null,
    task_id: comment.task_id || null,
    content: comment.content || null,
    rich_content: comment.rich_content || null,
    parent_id: comment.parent_id || null,
    create_milli_time: comment.create_milli_time || null,
    creator_id: comment.creator_id || null,
  };
}

function normalizeMessageReaction(item) {
  return {
    reaction_id: item?.reaction_id || null,
    operator: item?.operator || null,
    action_time: item?.action_time || null,
    reaction_type: item?.reaction_type || null,
  };
}

export async function listDriveFolder(accessToken, folderToken, pageToken) {
  ({ accessToken } = await resolveContentAuth(accessToken));
  const data = unwrapResponse(
    await userClient.drive.v1.file.list(
      {
        params: {
          page_size: DRIVE_PAGE_SIZE,
          page_token: pageToken,
          folder_token: folderToken,
        },
      },
      Lark.withUserAccessToken(accessToken),
    ),
    "Failed to list Lark Drive folder",
  );

  return normalizeDriveList(data);
}

export async function listDriveRoot(accessToken, pageToken) {
  ({ accessToken } = await resolveContentAuth(accessToken));
  const result = await listDriveFolder(accessToken, undefined, pageToken);
  if (!pageToken) {
    try {
      const meta = await getDriveRootFolderMeta(accessToken);
      result.root_folder_token = meta.token || null;
    } catch {
      result.root_folder_token = result.files?.[0]?.parent_token || null;
    }
  }
  return result;
}

export async function resolveDriveRootFolderToken(accessToken) {
  ({ accessToken } = await resolveContentAuth(accessToken));
  const meta = await getDriveRootFolderMeta(accessToken);
  return meta.token || null;
}

export async function createDriveFolder(accessToken, folderToken, name) {
  assertLarkWriteAllowed();
  ({ accessToken } = await resolveContentAuth(accessToken));
  const data = unwrapResponse(
    await userClient.drive.v1.file.createFolder(
      {
        data: {
          name,
          folder_token: folderToken,
        },
      },
      Lark.withUserAccessToken(accessToken),
    ),
    "Failed to create Lark Drive folder",
  );

  return {
    token: data.token || null,
    url: data.url || null,
    folder_token: folderToken,
    name,
  };
}

export async function moveDriveItem(accessToken, fileToken, type, folderToken) {
  assertLarkWriteAllowed();
  ({ accessToken } = await resolveContentAuth(accessToken));
  const data = unwrapResponse(
    await userClient.drive.v1.file.move(
      {
        path: {
          file_token: fileToken,
        },
        data: {
          type,
          folder_token: folderToken,
        },
      },
      Lark.withUserAccessToken(accessToken),
    ),
    "Failed to move Lark Drive item",
  );

  return {
    task_id: data.task_id || null,
    file_token: fileToken,
    type,
    folder_token: folderToken,
  };
}

export async function deleteDriveItem(accessToken, fileToken, type, tokenType = "user") {
  assertLarkWriteAllowed();
  ({ accessToken, tokenType } = await resolveContentAuth(accessToken, tokenType));
  const data = unwrapResponse(
    await userClient.drive.v1.file.delete(
      {
        path: {
          file_token: fileToken,
        },
        params: {
          type,
        },
      },
      withAccessToken(accessToken, tokenType),
    ),
    "Failed to delete Lark Drive item",
  );

  return {
    task_id: data.task_id || null,
    file_token: fileToken,
    type,
  };
}

export async function checkDriveTask(accessToken, taskId) {
  ({ accessToken } = await resolveContentAuth(accessToken));
  const data = unwrapResponse(
    await userClient.drive.v1.file.taskCheck(
      {
        params: {
          task_id: taskId,
        },
      },
      Lark.withUserAccessToken(accessToken),
    ),
    "Failed to check Lark Drive task",
  );

  return {
    task_id: taskId,
    status: data.status || null,
  };
}

export async function listWikiSpaces(accessToken, pageToken) {
  ({ accessToken } = await resolveContentAuth(accessToken));
  const data = unwrapResponse(
    await userClient.wiki.v2.space.list(
      {
        params: {
          page_size: WIKI_PAGE_SIZE,
          page_token: pageToken,
        },
      },
      Lark.withUserAccessToken(accessToken),
    ),
    "Failed to list Lark Wiki spaces",
  );

  return {
    items: data.items || [],
    page_token: data.page_token || null,
    has_more: Boolean(data.has_more),
  };
}

export async function listWikiSpaceNodes(accessToken, spaceId, parentNodeToken, pageToken) {
  ({ accessToken } = await resolveContentAuth(accessToken));
  const data = unwrapResponse(
    await userClient.wiki.v2.spaceNode.list(
      {
        path: {
          space_id: spaceId,
        },
        params: {
          parent_node_token: parentNodeToken,
          page_size: WIKI_PAGE_SIZE,
          page_token: pageToken,
        },
      },
      Lark.withUserAccessToken(accessToken),
    ),
    "Failed to list Lark Wiki nodes",
  );

  return {
    items: data.items || [],
    page_token: data.page_token || null,
    has_more: Boolean(data.has_more),
  };
}

export async function createWikiNode(accessToken, spaceId, title, parentNodeToken) {
  assertLarkWriteAllowed();
  ({ accessToken } = await resolveContentAuth(accessToken));
  const data = unwrapResponse(
    await userClient.wiki.v2.spaceNode.create(
      {
        path: {
          space_id: spaceId,
        },
        data: {
          obj_type: "docx",
          node_type: "origin",
          parent_node_token: parentNodeToken,
          title,
        },
      },
      Lark.withUserAccessToken(accessToken),
    ),
    "Failed to create Lark Wiki node",
  );

  const node = data.node || {};
  return {
    space_id: node.space_id || spaceId,
    node_token: node.node_token || null,
    obj_token: node.obj_token || null,
    title: node.title || title,
    parent_node_token: node.parent_node_token || parentNodeToken || null,
    url: node.obj_token ? `https://larksuite.com/docx/${node.obj_token}` : null,
  };
}

export async function moveWikiNode(accessToken, spaceId, nodeToken, targetParentToken, targetSpaceId) {
  assertLarkWriteAllowed();
  ({ accessToken } = await resolveContentAuth(accessToken));
  const data = unwrapResponse(
    await userClient.wiki.v2.spaceNode.move(
      {
        path: {
          space_id: spaceId,
          node_token: nodeToken,
        },
        data: {
          target_parent_token: targetParentToken,
          target_space_id: targetSpaceId || spaceId,
        },
      },
      Lark.withUserAccessToken(accessToken),
    ),
    "Failed to move Lark Wiki node",
  );

  const node = data.node || {};
  return {
    space_id: node.space_id || targetSpaceId || spaceId,
    node_token: node.node_token || nodeToken,
    parent_node_token: node.parent_node_token || targetParentToken || null,
    title: node.title || null,
    obj_token: node.obj_token || null,
    url: node.obj_token ? `https://larksuite.com/docx/${node.obj_token}` : null,
  };
}

export async function createDocument(accessToken, title, folderToken, tokenType = "user", options = {}) {
  const createGuard = assertDocumentCreateAllowed({
    title,
    source: options?.source || "",
    requestedFolderToken: folderToken,
  });
  const resolvedFolderToken = createGuard.resolved_folder_token || "";
  ({ accessToken, tokenType } = await resolveContentAuth(accessToken, tokenType));
  try {
    const created = await createDocumentDirect(accessToken, title, resolvedFolderToken, tokenType);
    return {
      ...created,
      fallback_root: false,
    };
  } catch (error) {
    const directError = extractLarkPlatformError(error);
    logDocCreateDiagnostic({
      mode: "direct",
      tokenType,
      folderToken: resolvedFolderToken,
      platformCode: directError.platform_code,
      platformMsg: directError.platform_msg,
      logId: directError.log_id,
    });

    if (!resolvedFolderToken || !isDocCreatePlatformBlockedError(error)) {
      throw buildDocCreateStructuredError({
        stage: "docx_create_direct",
        tokenType,
        title,
        folderToken: resolvedFolderToken,
        error,
      });
    }

    if (!shouldAllowCreateRootFallback({ title, source: options?.source || "" })) {
      throw buildDocCreateStructuredError({
        stage: "docx_create_root_fallback_blocked",
        tokenType,
        title,
        folderToken: resolvedFolderToken,
        error,
      });
    }

    try {
      const fallbackCreated = await createDocumentDirect(accessToken, title, "", tokenType);
      logDocCreateDiagnostic({
        mode: "fallback",
        tokenType,
        folderToken: "",
        platformCode: null,
        platformMsg: "fallback_root_create_succeeded",
        logId: null,
      });
      return {
        ...fallbackCreated,
        requested_folder_token: resolvedFolderToken || null,
        fallback_root: true,
      };
    } catch (rootError) {
      const probe = {
        root_ok: false,
        folder_ok: false,
        diagnosis: DOC_CREATE_DIAGNOSIS.ROOT_BLOCKED,
        root_error: extractLarkPlatformError(rootError),
        folder_error: directError,
      };
      logDocCreateDiagnostic({
        mode: "fallback",
        tokenType,
        folderToken: "",
        platformCode: probe.root_error.platform_code,
        platformMsg: probe.root_error.platform_msg,
        logId: probe.root_error.log_id,
      });
      throw buildDocCreateStructuredError({
        stage: "docx_create_root_fallback",
        tokenType,
        title,
        folderToken: resolvedFolderToken,
        error: rootError,
        diagnosis: probe.diagnosis,
        probe,
      });
    }
  }
}

async function grantDocumentMemberPermission(accessToken, documentId, openId, tokenType = "user") {
  assertLarkWriteAllowed();
  if (!accessToken || !documentId || !openId) {
    return null;
  }

  const payload = {
    path: {
      token: documentId,
    },
    params: {
      type: "docx",
      need_notification: false,
    },
    data: {
      member_type: "openid",
      member_id: openId,
      type: "user",
      perm: "full_access",
      perm_type: "container",
    },
  };

  try {
    const data = unwrapResponse(
      await userClient.drive.permissionMember.create(
        payload,
        withAccessToken(accessToken, tokenType),
      ),
      "Failed to grant document full access",
    );
    return data.member || null;
  } catch (error) {
    const message = String(error?.message || "");
    if (!/exist|already|重复|已存在/i.test(message)) {
      throw error;
    }

    const data = unwrapResponse(
      await userClient.drive.permissionMember.update(
        {
          path: {
            token: documentId,
            member_id: openId,
          },
          params: {
            type: "docx",
            need_notification: false,
          },
          data: {
            member_type: "openid",
            perm: "full_access",
            perm_type: "container",
            type: "user",
          },
        },
        withAccessToken(accessToken, tokenType),
      ),
      "Failed to upgrade document member permission",
    );
    return data.member || null;
  }
}

export async function ensureDocumentManagerPermission(
  accessToken,
  documentId,
  {
    tokenType = "user",
    managerOpenId = "",
  } = {},
) {
  ({ accessToken, tokenType } = await resolveContentAuth(accessToken, tokenType));
  const permission = await grantDocumentMemberPermission(
    accessToken,
    documentId,
    managerOpenId,
    tokenType,
  );
  return {
    document_id: documentId || null,
    manager_open_id: managerOpenId || null,
    manager_permission: permission?.perm || null,
  };
}

export async function createManagedDocument(
  accessToken,
  title,
  folderToken,
  {
    tokenType = "user",
    managerOpenId = "",
    source = "",
  } = {},
) {
  ({ accessToken, tokenType } = await resolveContentAuth(accessToken, tokenType));
  const created = await createDocument(accessToken, title, folderToken, tokenType, { source });
  const permission = await ensureDocumentManagerPermission(accessToken, created.document_id, {
    tokenType,
    managerOpenId,
  });
  return {
    ...created,
    manager_open_id: managerOpenId || null,
    manager_permission: permission?.manager_permission || null,
  };
}

export async function getDocument(accessToken, documentId) {
  ({ accessToken } = await resolveContentAuth(accessToken));
  const meta = unwrapResponse(
    await userClient.docx.document.get(
      {
        path: {
          document_id: documentId,
        },
      },
      Lark.withUserAccessToken(accessToken),
    ),
    "Failed to get Lark document",
  );

  const raw = unwrapResponse(
    await userClient.docx.document.rawContent(
      {
        path: {
          document_id: documentId,
        },
      },
      Lark.withUserAccessToken(accessToken),
    ),
    "Failed to read Lark document raw content",
  );

  const document = meta.document || {};
  const content = String(raw.content || "");
  return {
    document_id: document.document_id || documentId,
    revision_id: document.revision_id || null,
    title: document.title || null,
    url: normalizeDocumentUrl(document.document_id || documentId),
    content,
    content_length: content.length,
  };
}

export async function listDocumentComments(
  accessToken,
  documentId,
  {
    fileType = "docx",
    isWhole,
    isSolved,
    pageSize = 50,
    pageToken,
  } = {},
) {
  ({ accessToken } = await resolveContentAuth(accessToken));
  const data = unwrapResponse(
    await userClient.drive.v1.fileComment.list(
      {
        path: {
          file_token: documentId,
        },
        params: {
          file_type: fileType,
          is_whole: typeof isWhole === "boolean" ? isWhole : undefined,
          is_solved: typeof isSolved === "boolean" ? isSolved : undefined,
          page_size: pageSize,
          page_token: pageToken,
        },
      },
      Lark.withUserAccessToken(accessToken),
    ),
    "Failed to list Lark document comments",
  );

  return {
    document_id: documentId,
    file_type: fileType,
    items: (data.items || []).map(normalizeDocumentComment),
    page_token: data.page_token || null,
    has_more: Boolean(data.has_more),
  };
}

export async function resolveDocumentComment(accessToken, documentId, commentId, isSolved = true, fileType = "docx") {
  assertLarkWriteAllowed();
  ({ accessToken } = await resolveContentAuth(accessToken));
  unwrapResponse(
    await userClient.drive.v1.fileComment.patch(
      {
        path: {
          file_token: documentId,
          comment_id: commentId,
        },
        params: {
          file_type: fileType,
        },
        data: {
          is_solved: Boolean(isSolved),
        },
      },
      Lark.withUserAccessToken(accessToken),
    ),
    "Failed to resolve Lark document comment",
  );

  return {
    document_id: documentId,
    comment_id: commentId,
    is_solved: Boolean(isSolved),
  };
}

async function listAllDocumentBlocks(accessToken, documentId, tokenType = "user") {
  const items = [];
  let pageToken = undefined;

  while (true) {
    const data = unwrapResponse(
      await userClient.docx.v1.documentBlock.list(
        {
          path: {
            document_id: documentId,
          },
          params: {
            page_size: DOC_BLOCK_PAGE_SIZE,
            page_token: pageToken,
          },
        },
        withAccessToken(accessToken, tokenType),
      ),
      "Failed to list Lark document blocks",
    );

    items.push(...(data.items || []));
    if (!data.has_more || !data.page_token) {
      break;
    }
    pageToken = data.page_token;
  }

  return items;
}

export function resolveDocumentWriteRootBlock(blocks) {
  return (
    // Descendant writes must target the writable page block, not the top-level
    // container root that can also appear in brand-new blank documents.
    blocks.find((item) => item?.page) ||
    blocks.find((item) => !item?.parent_id) ||
    blocks[0] ||
    null
  );
}

async function convertMarkdownToBlocks(accessToken, content, tokenType = "user") {
  const data = unwrapResponse(
    await userClient.docx.document.convert(
      {
        data: {
          content_type: "markdown",
          content,
        },
      },
      withAccessToken(accessToken, tokenType),
    ),
    "Failed to convert markdown into Lark document blocks",
  );

  return {
    first_level_block_ids: data.first_level_block_ids || [],
    blocks: data.blocks || [],
  };
}

export async function updateDocument(accessToken, documentId, content, mode = "append", tokenType = "user") {
  assertLarkWriteAllowed();
  ({ accessToken, tokenType } = await resolveContentAuth(accessToken, tokenType));
  const normalizedContent = normalizeDocumentContent(content);
  if (!normalizedContent) {
    throw new Error("missing_document_content");
  }

  const blocks = await listAllDocumentBlocks(accessToken, documentId, tokenType);
  const rootBlock = resolveDocumentWriteRootBlock(blocks);
  if (!rootBlock?.block_id) {
    throw new Error("missing_document_root_block");
  }

  if (mode === "replace" && Array.isArray(rootBlock.children) && rootBlock.children.length > 0) {
    unwrapResponse(
      await userClient.docx.v1.documentBlockChildren.batchDelete(
        {
          path: {
            document_id: documentId,
            block_id: rootBlock.block_id,
          },
          data: {
            start_index: 0,
            end_index: rootBlock.children.length,
          },
        },
        withAccessToken(accessToken, tokenType),
      ),
      "Failed to clear Lark document content",
    );
  }

  const converted = await convertMarkdownToBlocks(accessToken, normalizedContent, tokenType);
  if (!converted.first_level_block_ids.length || !converted.blocks.length) {
    return {
      document_id: documentId,
      mode,
      root_block_id: rootBlock.block_id,
      appended_blocks: 0,
    };
  }

  const writeResult = unwrapResponse(
    await userClient.docx.v1.documentBlockDescendant.create(
      {
        path: {
          document_id: documentId,
          block_id: rootBlock.block_id,
        },
        data: {
          index: mode === "replace" ? 0 : Array.isArray(rootBlock.children) ? rootBlock.children.length : 0,
          children_id: converted.first_level_block_ids,
          descendants: converted.blocks,
        },
      },
      withAccessToken(accessToken, tokenType),
    ),
    "Failed to write Lark document content",
  );

  return {
    document_id: documentId,
    mode,
    root_block_id: rootBlock.block_id,
    appended_blocks: converted.first_level_block_ids.length,
    revision_id: writeResult.document_revision_id || null,
    url: normalizeDocumentUrl(documentId),
  };
}

export async function listMessages(
  accessToken,
  containerId,
  {
    containerIdType = "chat",
    startTime,
    endTime,
    sortType = "ByCreateTimeDesc",
    pageSize = MESSAGE_PAGE_SIZE,
    pageToken,
  } = {},
) {
  ({ accessToken } = await resolveContentAuth(accessToken));
  const data = unwrapResponse(
    await userClient.im.v1.message.list(
      {
        params: {
          container_id_type: containerIdType,
          container_id: containerId,
          start_time: startTime,
          end_time: endTime,
          sort_type: sortType,
          page_size: pageSize,
          page_token: pageToken,
        },
      },
      Lark.withUserAccessToken(accessToken),
    ),
    "Failed to list Lark messages",
  );

  return {
    container_id_type: containerIdType,
    container_id: containerId,
    items: (data.items || []).map(normalizeMessageItem),
    page_token: data.page_token || null,
    has_more: Boolean(data.has_more),
  };
}

export async function getMessage(accessToken, messageId) {
  ({ accessToken } = await resolveContentAuth(accessToken));
  const data = unwrapResponse(
    await userClient.im.v1.message.get(
      {
        path: {
          message_id: messageId,
        },
      },
      Lark.withUserAccessToken(accessToken),
    ),
    "Failed to get Lark message",
  );

  return normalizeMessageItem(data);
}

export async function downloadMessageImage(accessToken, imageKey, tokenType = "user") {
  ({ accessToken, tokenType } = await resolveContentAuth(accessToken, tokenType));
  const response = await fetch(
    `${apiBaseUrl}/open-apis/im/v1/images/${encodeURIComponent(imageKey)}?type=message`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to download Lark image: ${response.status}`);
  }

  const contentType = response.headers.get("content-type") || "application/octet-stream";
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    image_key: imageKey,
    mime_type: contentType.split(";")[0].trim() || "application/octet-stream",
    bytes: buffer,
    token_type: tokenType,
  };
}

export async function searchMessages(
  accessToken,
  containerId,
  keyword,
  {
    containerIdType = "chat",
    startTime,
    endTime,
    sortType = "ByCreateTimeDesc",
    limit = 20,
  } = {},
) {
  ({ accessToken } = await resolveContentAuth(accessToken));
  const collected = [];
  let pageToken = undefined;
  let hasMore = true;
  const normalizedKeyword = String(keyword || "").trim().toLowerCase();

  while (hasMore && collected.length < limit) {
    const page = await listMessages(accessToken, containerId, {
      containerIdType,
      startTime,
      endTime,
      sortType,
      pageToken,
    });

    for (const item of page.items) {
      if (
        !normalizedKeyword ||
        item.text.toLowerCase().includes(normalizedKeyword) ||
        item.content.toLowerCase().includes(normalizedKeyword)
      ) {
        collected.push(item);
      }
      if (collected.length >= limit) {
        break;
      }
    }

    hasMore = page.has_more;
    pageToken = page.page_token || undefined;
    if (!pageToken) {
      break;
    }
  }

  return {
    container_id_type: containerIdType,
    container_id: containerId,
    keyword,
    total: collected.length,
    items: collected.slice(0, limit),
  };
}

export async function replyMessage(
  accessToken,
  messageId,
  content,
  { replyInThread = false, cardTitle, cardPayload } = {},
) {
  assertLarkWriteAllowed();
  ({ accessToken } = await resolveContentAuth(accessToken));
  const normalized = String(content || "").trim();
  if (!normalized && !cardPayload) {
    throw new Error("missing_message_content");
  }

  const isCard = Boolean(cardTitle || cardPayload);
  const payloadContent = isCard
    ? JSON.stringify(
        cardPayload || Lark.messageCard.defaultCard({
          title: String(cardTitle).trim() || "Lobster",
          content: normalized,
        }),
      )
    : JSON.stringify({ text: normalized });

  const data = await withMessageRetry(async () =>
    unwrapResponse(
      await userClient.im.v1.message.reply(
        {
          path: {
            message_id: messageId,
          },
          data: {
            msg_type: isCard ? "interactive" : "text",
            content: payloadContent,
            reply_in_thread: replyInThread,
          },
        },
        Lark.withUserAccessToken(accessToken),
      ),
      "Failed to reply to Lark message",
    ),
  );

  return normalizeMessageItem(data);
}

export async function sendMessage(
  accessToken,
  receiveId,
  content,
  { receiveIdType = "chat", cardTitle, cardPayload } = {},
) {
  assertLarkWriteAllowed();
  ({ accessToken } = await resolveContentAuth(accessToken));
  const normalized = String(content || "").trim();
  if (!normalized && !cardPayload) {
    throw new Error("missing_message_content");
  }

  const isCard = Boolean(cardTitle || cardPayload);
  const payloadContent = isCard
    ? JSON.stringify(
        cardPayload || Lark.messageCard.defaultCard({
          title: String(cardTitle).trim() || "Lobster",
          content: normalized,
        }),
      )
    : JSON.stringify({ text: normalized });

  const data = await withMessageRetry(async () =>
    unwrapResponse(
      await userClient.im.v1.message.create(
        {
          params: {
            receive_id_type: receiveIdType,
          },
          data: {
            receive_id: receiveId,
            msg_type: isCard ? "interactive" : "text",
            content: payloadContent,
          },
        },
        Lark.withUserAccessToken(accessToken),
      ),
      "Failed to send Lark message",
    ),
  );

  return normalizeMessageItem(data);
}

export async function getPrimaryCalendar(accessToken, tokenType = "user") {
  ({ accessToken, tokenType } = await resolveContentAuth(accessToken, tokenType));
  const data = unwrapResponse(
    await userClient.calendar.v4.calendar.primary(
      {},
      withAccessToken(accessToken, tokenType),
    ),
    "Failed to get primary Lark calendar",
  );

  return normalizeCalendar(data);
}

export async function listCalendarEvents(
  accessToken,
  calendarId,
  { pageSize = 50, pageToken, startTime, endTime, anchorTime } = {},
  tokenType = "user",
) {
  ({ accessToken, tokenType } = await resolveContentAuth(accessToken, tokenType));
  const data = unwrapResponse(
    await userClient.calendar.v4.calendarEvent.list(
      {
        path: {
          calendar_id: calendarId,
        },
        params: {
          page_size: pageSize,
          page_token: pageToken,
          start_time: startTime,
          end_time: endTime,
          anchor_time: anchorTime,
        },
      },
      withAccessToken(accessToken, tokenType),
    ),
    "Failed to list Lark calendar events",
  );

  return {
    calendar_id: calendarId,
    items: (data.items || []).map(normalizeCalendarEvent),
    page_token: data.page_token || null,
    has_more: Boolean(data.has_more),
  };
}

export async function searchCalendarEvents(accessToken, calendarId, query) {
  ({ accessToken } = await resolveContentAuth(accessToken));
  const data = unwrapResponse(
    await userClient.calendar.v4.calendarEvent.search(
      {
        path: {
          calendar_id: calendarId,
        },
        data: {
          query,
        },
      },
      Lark.withUserAccessToken(accessToken),
    ),
    "Failed to search Lark calendar events",
  );

  return {
    calendar_id: calendarId,
    query,
    items: (data.items || []).map(normalizeCalendarEvent),
    page_token: data.page_token || null,
    has_more: Boolean(data.has_more),
  };
}

export async function createCalendarEvent(
  accessToken,
  calendarId,
  { summary, description, startTime, endTime, timezone = "Asia/Taipei", reminders = [] },
) {
  assertLarkWriteAllowed();
  ({ accessToken } = await resolveContentAuth(accessToken));
  const data = unwrapResponse(
    await userClient.calendar.v4.calendarEvent.create(
      {
        path: {
          calendar_id: calendarId,
        },
        data: {
          summary,
          description,
          start_time: {
            timestamp: startTime,
            timezone,
          },
          end_time: {
            timestamp: endTime,
            timezone,
          },
          reminders: reminders.map((minutes) => ({ minutes })),
        },
      },
      Lark.withUserAccessToken(accessToken),
    ),
    "Failed to create Lark calendar event",
  );

  return normalizeCalendarEvent(data);
}

export async function listTasks(
  accessToken,
  { pageSize = TASK_PAGE_SIZE, pageToken, startCreateTime, endCreateTime, completed } = {},
) {
  ({ accessToken } = await resolveContentAuth(accessToken));
  const data = unwrapResponse(
    await userClient.task.v1.task.list(
      {
        params: {
          page_size: pageSize,
          page_token: pageToken,
          start_create_time: startCreateTime,
          end_create_time: endCreateTime,
          task_completed: typeof completed === "boolean" ? completed : undefined,
        },
      },
      Lark.withUserAccessToken(accessToken),
    ),
    "Failed to list Lark tasks",
  );

  return {
    items: (data.items || []).map(normalizeTask),
    page_token: data.page_token || null,
    has_more: Boolean(data.has_more),
  };
}

export async function getTask(accessToken, taskId) {
  ({ accessToken } = await resolveContentAuth(accessToken));
  const data = unwrapResponse(
    await userClient.task.v1.task.get(
      {
        path: {
          task_id: taskId,
        },
      },
      Lark.withUserAccessToken(accessToken),
    ),
    "Failed to get Lark task",
  );

  return normalizeTask(data.task || {});
}

export async function createTask(
  accessToken,
  { summary, description, dueTime, timezone = "Asia/Taipei", linkUrl, linkTitle },
) {
  assertLarkWriteAllowed();
  ({ accessToken } = await resolveContentAuth(accessToken));
  const data = unwrapResponse(
    await userClient.task.v1.task.create(
      {
        data: {
          summary,
          description,
          due: dueTime
            ? {
                time: dueTime,
                timezone,
              }
            : undefined,
          origin: {
            platform_i18n_name: "Lobster",
            href: linkUrl
              ? {
                  url: linkUrl,
                  title: linkTitle || summary,
                }
              : undefined,
          },
        },
      },
      Lark.withUserAccessToken(accessToken),
    ),
    "Failed to create Lark task",
  );

  return normalizeTask(data.task || {});
}

export async function createBitableApp(
  accessToken,
  { name, folderToken, timeZone, customizedConfig, sourceAppToken, copyTypes, apiType } = {},
) {
  assertLarkWriteAllowed();
  ({ accessToken } = await resolveContentAuth(accessToken));
  const data = unwrapResponse(
    await userClient.bitable.v1.app.create(
      {
        data: {
          name,
          folder_token: folderToken,
          time_zone: timeZone,
        },
        params: {
          customized_config: customizedConfig,
          source_app_token: sourceAppToken,
          copy_types: copyTypes,
          api_type: apiType,
        },
      },
      Lark.withUserAccessToken(accessToken),
    ),
    "Failed to create Lark Bitable app",
  );

  return normalizeBitableApp(data);
}

export async function getBitableApp(accessToken, appToken) {
  ({ accessToken } = await resolveContentAuth(accessToken));
  const data = unwrapResponse(
    await userClient.bitable.v1.app.get(
      {
        path: {
          app_token: appToken,
        },
      },
      Lark.withUserAccessToken(accessToken),
    ),
    "Failed to get Lark Bitable app",
  );

  return normalizeBitableApp(data);
}

export async function updateBitableApp(accessToken, appToken, { name, isAdvanced } = {}) {
  assertLarkWriteAllowed();
  ({ accessToken } = await resolveContentAuth(accessToken));
  const data = unwrapResponse(
    await userClient.bitable.v1.app.update(
      {
        path: {
          app_token: appToken,
        },
        data: {
          name,
          is_advanced: typeof isAdvanced === "boolean" ? isAdvanced : undefined,
        },
      },
      Lark.withUserAccessToken(accessToken),
    ),
    "Failed to update Lark Bitable app",
  );

  return normalizeBitableApp(data);
}

export async function listBitableTables(accessToken, appToken, { pageToken, pageSize = 50 } = {}) {
  ({ accessToken } = await resolveContentAuth(accessToken));
  const data = unwrapResponse(
    await userClient.bitable.v1.appTable.list(
      {
        path: {
          app_token: appToken,
        },
        params: {
          page_token: pageToken,
          page_size: pageSize,
        },
      },
      Lark.withUserAccessToken(accessToken),
    ),
    "Failed to list Lark Bitable tables",
  );

  return {
    app_token: appToken,
    items: (data.items || []).map(normalizeBitableTable),
    page_token: data.page_token || null,
    has_more: Boolean(data.has_more),
    total: data.total ?? null,
  };
}

export async function createBitableTable(
  accessToken,
  appToken,
  { name, defaultViewName, fields = [] } = {},
) {
  assertLarkWriteAllowed();
  ({ accessToken } = await resolveContentAuth(accessToken));
  const data = unwrapResponse(
    await userClient.bitable.v1.appTable.create(
      {
        path: {
          app_token: appToken,
        },
        data: {
          table: {
            name,
            default_view_name: defaultViewName,
            fields,
          },
        },
      },
      Lark.withUserAccessToken(accessToken),
    ),
    "Failed to create Lark Bitable table",
  );

  return {
    app_token: appToken,
    table_id: data.table_id || null,
    default_view_id: data.default_view_id || null,
    field_id_list: data.field_id_list || [],
  };
}

export async function listBitableRecords(
  accessToken,
  appToken,
  tableId,
  { pageToken, pageSize = 50, viewId, fieldNames, sort, filter, automaticFields, userIdType } = {},
) {
  ({ accessToken } = await resolveContentAuth(accessToken));
  const data = unwrapResponse(
    await userClient.bitable.v1.appTableRecord.list(
      {
        path: {
          app_token: appToken,
          table_id: tableId,
        },
        params: {
          page_token: pageToken,
          page_size: pageSize,
          view_id: viewId,
          field_names: fieldNames,
          sort,
          filter,
          automatic_fields: automaticFields,
          user_id_type: userIdType,
        },
      },
      Lark.withUserAccessToken(accessToken),
    ),
    "Failed to list Lark Bitable records",
  );

  return {
    app_token: appToken,
    table_id: tableId,
    items: (data.items || []).map(normalizeBitableRecord),
    page_token: data.page_token || null,
    has_more: Boolean(data.has_more),
    total: data.total ?? null,
  };
}

export async function searchBitableRecords(
  accessToken,
  appToken,
  tableId,
  { pageToken, pageSize = 50, viewId, fieldNames, sort = [], filter, automaticFields, userIdType } = {},
) {
  ({ accessToken } = await resolveContentAuth(accessToken));
  const data = unwrapResponse(
    await userClient.bitable.v1.appTableRecord.search(
      {
        path: {
          app_token: appToken,
          table_id: tableId,
        },
        params: {
          user_id_type: userIdType,
        },
        data: {
          page_token: pageToken,
          page_size: pageSize,
          view_id: viewId,
          field_names: fieldNames,
          sort,
          filter,
          automatic_fields: automaticFields,
        },
      },
      Lark.withUserAccessToken(accessToken),
    ),
    "Failed to search Lark Bitable records",
  );

  return {
    app_token: appToken,
    table_id: tableId,
    items: (data.items || []).map(normalizeBitableRecord),
    page_token: data.page_token || null,
    has_more: Boolean(data.has_more),
    total: data.total ?? null,
  };
}

export async function createBitableRecord(
  accessToken,
  appToken,
  tableId,
  { fields, userIdType, clientToken, ignoreConsistencyCheck } = {},
) {
  assertLarkWriteAllowed();
  ({ accessToken } = await resolveContentAuth(accessToken));
  const data = unwrapResponse(
    await userClient.bitable.v1.appTableRecord.create(
      {
        path: {
          app_token: appToken,
          table_id: tableId,
        },
        params: {
          user_id_type: userIdType,
          client_token: clientToken,
          ignore_consistency_check: ignoreConsistencyCheck,
        },
        data: {
          fields,
        },
      },
      Lark.withUserAccessToken(accessToken),
    ),
    "Failed to create Lark Bitable record",
  );

  return normalizeBitableRecord(data.record || {});
}

export async function getBitableRecord(
  accessToken,
  appToken,
  tableId,
  recordId,
  { userIdType, withSharedUrl, automaticFields } = {},
) {
  ({ accessToken } = await resolveContentAuth(accessToken));
  const data = unwrapResponse(
    await userClient.bitable.v1.appTableRecord.get(
      {
        path: {
          app_token: appToken,
          table_id: tableId,
          record_id: recordId,
        },
        params: {
          user_id_type: userIdType,
          with_shared_url: withSharedUrl,
          automatic_fields: automaticFields,
        },
      },
      Lark.withUserAccessToken(accessToken),
    ),
    "Failed to get Lark Bitable record",
  );

  return normalizeBitableRecord(data.record || {});
}

export async function updateBitableRecord(
  accessToken,
  appToken,
  tableId,
  recordId,
  { fields, userIdType } = {},
) {
  assertLarkWriteAllowed();
  ({ accessToken } = await resolveContentAuth(accessToken));
  const data = unwrapResponse(
    await userClient.bitable.v1.appTableRecord.update(
      {
        path: {
          app_token: appToken,
          table_id: tableId,
          record_id: recordId,
        },
        params: {
          user_id_type: userIdType,
        },
        data: {
          fields,
        },
      },
      Lark.withUserAccessToken(accessToken),
    ),
    "Failed to update Lark Bitable record",
  );

  return normalizeBitableRecord(data.record || {});
}

export async function bulkUpsertBitableRecords(
  accessToken,
  appToken,
  tableId,
  { records = [], userIdType } = {},
) {
  ({ accessToken } = await resolveContentAuth(accessToken));
  const items = [];
  for (const item of Array.isArray(records) ? records : []) {
    if (item?.record_id) {
      items.push(await updateBitableRecord(accessToken, appToken, tableId, item.record_id, {
        fields: item.fields || {},
        userIdType,
      }));
      continue;
    }
    items.push(await createBitableRecord(accessToken, appToken, tableId, {
      fields: item?.fields || {},
      userIdType,
    }));
  }
  return {
    app_token: appToken,
    table_id: tableId,
    total: items.length,
    items,
  };
}

export async function deleteBitableRecord(accessToken, appToken, tableId, recordId) {
  assertLarkWriteAllowed();
  ({ accessToken } = await resolveContentAuth(accessToken));
  const data = unwrapResponse(
    await userClient.bitable.v1.appTableRecord.delete(
      {
        path: {
          app_token: appToken,
          table_id: tableId,
          record_id: recordId,
        },
      },
      Lark.withUserAccessToken(accessToken),
    ),
    "Failed to delete Lark Bitable record",
  );

  return {
    app_token: appToken,
    table_id: tableId,
    record_id: recordId,
    deleted: data.deleted ?? true,
  };
}

export async function createSpreadsheet(accessToken, { title, folderToken } = {}) {
  assertLarkWriteAllowed();
  ({ accessToken } = await resolveContentAuth(accessToken));
  const data = unwrapResponse(
    await userClient.sheets.v3.spreadsheet.create(
      {
        data: {
          title,
          folder_token: folderToken,
        },
      },
      Lark.withUserAccessToken(accessToken),
    ),
    "Failed to create Lark spreadsheet",
  );

  return normalizeSpreadsheet(data);
}

export async function getSpreadsheet(accessToken, spreadsheetToken) {
  ({ accessToken } = await resolveContentAuth(accessToken));
  const data = unwrapResponse(
    await userClient.sheets.v3.spreadsheet.get(
      {
        path: {
          spreadsheet_token: spreadsheetToken,
        },
      },
      Lark.withUserAccessToken(accessToken),
    ),
    "Failed to get Lark spreadsheet",
  );

  return normalizeSpreadsheet(data);
}

export async function updateSpreadsheet(accessToken, spreadsheetToken, { title } = {}) {
  assertLarkWriteAllowed();
  ({ accessToken } = await resolveContentAuth(accessToken));
  const data = unwrapResponse(
    await userClient.sheets.v3.spreadsheet.patch(
      {
        path: {
          spreadsheet_token: spreadsheetToken,
        },
        data: {
          title,
        },
      },
      Lark.withUserAccessToken(accessToken),
    ),
    "Failed to update Lark spreadsheet",
  );

  return normalizeSpreadsheet(data);
}

export async function listSpreadsheetSheets(accessToken, spreadsheetToken) {
  ({ accessToken } = await resolveContentAuth(accessToken));
  const data = unwrapResponse(
    await userClient.sheets.v3.spreadsheetSheet.query(
      {
        path: {
          spreadsheet_token: spreadsheetToken,
        },
      },
      Lark.withUserAccessToken(accessToken),
    ),
    "Failed to list Lark spreadsheet sheets",
  );

  return {
    spreadsheet_token: spreadsheetToken,
    items: (data.sheets || []).map(normalizeSpreadsheetSheet),
  };
}

export async function getSpreadsheetSheet(accessToken, spreadsheetToken, sheetId) {
  ({ accessToken } = await resolveContentAuth(accessToken));
  const data = unwrapResponse(
    await userClient.sheets.v3.spreadsheetSheet.get(
      {
        path: {
          spreadsheet_token: spreadsheetToken,
          sheet_id: sheetId,
        },
      },
      Lark.withUserAccessToken(accessToken),
    ),
    "Failed to get Lark spreadsheet sheet",
  );

  return normalizeSpreadsheetSheet(data);
}

export async function replaceSpreadsheetCells(
  accessToken,
  spreadsheetToken,
  sheetId,
  { range, find, replacement, matchCase, matchEntireCell, searchByRegex, includeFormulas } = {},
) {
  assertLarkWriteAllowed();
  ({ accessToken } = await resolveContentAuth(accessToken));
  const data = unwrapResponse(
    await userClient.sheets.v3.spreadsheetSheet.replace(
      {
        path: {
          spreadsheet_token: spreadsheetToken,
          sheet_id: sheetId,
        },
        data: {
          find_condition: {
            range,
            match_case: matchCase,
            match_entire_cell: matchEntireCell,
            search_by_regex: searchByRegex,
            include_formulas: includeFormulas,
          },
          find,
          replacement,
        },
      },
      Lark.withUserAccessToken(accessToken),
    ),
    "Failed to replace Lark spreadsheet cells",
  );

  return {
    spreadsheet_token: spreadsheetToken,
    sheet_id: sheetId,
    replace_result: data.replace_result || null,
  };
}

export async function replaceSpreadsheetCellsBatch(
  accessToken,
  spreadsheetToken,
  sheetId,
  { replacements = [] } = {},
) {
  assertLarkWriteAllowed();
  ({ accessToken } = await resolveContentAuth(accessToken));
  const items = [];
  for (const replacement of Array.isArray(replacements) ? replacements : []) {
    items.push(await replaceSpreadsheetCells(accessToken, spreadsheetToken, sheetId, replacement));
  }
  return {
    spreadsheet_token: spreadsheetToken,
    sheet_id: sheetId,
    total: items.length,
    items,
  };
}

export async function listFreebusy(
  accessToken,
  { timeMin, timeMax, userId, roomId, userIdType = "open_id", includeExternalCalendar, onlyBusy } = {},
) {
  ({ accessToken } = await resolveContentAuth(accessToken));
  const data = unwrapResponse(
    await userClient.calendar.v4.freebusy.list(
      {
        params: {
          user_id_type: userIdType,
        },
        data: {
          time_min: timeMin,
          time_max: timeMax,
          user_id: userId,
          room_id: roomId,
          include_external_calendar: includeExternalCalendar,
          only_busy: onlyBusy,
        },
      },
      Lark.withUserAccessToken(accessToken),
    ),
    "Failed to query Lark freebusy",
  );

  return {
    time_min: timeMin,
    time_max: timeMax,
    user_id: userId || null,
    room_id: roomId || null,
    freebusy_list: data.freebusy_list || [],
  };
}

export async function listTaskComments(
  accessToken,
  taskId,
  { pageToken, pageSize = 50, listDirection, userIdType = "open_id" } = {},
) {
  ({ accessToken } = await resolveContentAuth(accessToken));
  const data = unwrapResponse(
    await userClient.task.v1.taskComment.list(
      {
        path: {
          task_id: taskId,
        },
        params: {
          page_token: pageToken,
          page_size: pageSize,
          list_direction: listDirection,
          user_id_type: userIdType,
        },
      },
      Lark.withUserAccessToken(accessToken),
    ),
    "Failed to list Lark task comments",
  );

  return {
    task_id: taskId,
    items: (data.items || []).map(normalizeTaskComment),
    page_token: data.page_token || null,
    has_more: Boolean(data.has_more),
  };
}

export async function getTaskComment(accessToken, taskId, commentId, { userIdType = "open_id" } = {}) {
  ({ accessToken } = await resolveContentAuth(accessToken));
  const data = unwrapResponse(
    await userClient.task.v1.taskComment.get(
      {
        path: {
          task_id: taskId,
          comment_id: commentId,
        },
        params: {
          user_id_type: userIdType,
        },
      },
      Lark.withUserAccessToken(accessToken),
    ),
    "Failed to get Lark task comment",
  );

  return normalizeTaskComment(data.comment || {});
}

export async function createTaskComment(
  accessToken,
  taskId,
  { content, richContent, parentId, userIdType = "open_id" } = {},
) {
  assertLarkWriteAllowed();
  ({ accessToken } = await resolveContentAuth(accessToken));
  const data = unwrapResponse(
    await userClient.task.v1.taskComment.create(
      {
        path: {
          task_id: taskId,
        },
        params: {
          user_id_type: userIdType,
        },
        data: {
          content,
          rich_content: richContent,
          parent_id: parentId,
        },
      },
      Lark.withUserAccessToken(accessToken),
    ),
    "Failed to create Lark task comment",
  );

  return normalizeTaskComment(data.comment || {});
}

export async function updateTaskComment(
  accessToken,
  taskId,
  commentId,
  { content, richContent, userIdType = "open_id" } = {},
) {
  assertLarkWriteAllowed();
  ({ accessToken } = await resolveContentAuth(accessToken));
  const data = unwrapResponse(
    await userClient.task.v1.taskComment.update(
      {
        path: {
          task_id: taskId,
          comment_id: commentId,
        },
        params: {
          user_id_type: userIdType,
        },
        data: {
          content,
          rich_content: richContent,
        },
      },
      Lark.withUserAccessToken(accessToken),
    ),
    "Failed to update Lark task comment",
  );

  return normalizeTaskComment(data.comment || {});
}

export async function deleteTaskComment(accessToken, taskId, commentId) {
  assertLarkWriteAllowed();
  ({ accessToken } = await resolveContentAuth(accessToken));
  unwrapResponse(
    await userClient.task.v1.taskComment.delete(
      {
        path: {
          task_id: taskId,
          comment_id: commentId,
        },
      },
      Lark.withUserAccessToken(accessToken),
    ),
    "Failed to delete Lark task comment",
  );

  return {
    task_id: taskId,
    comment_id: commentId,
    deleted: true,
  };
}

export async function listMessageReactions(
  accessToken,
  messageId,
  { reactionType, pageToken, pageSize = 50, userIdType = "open_id" } = {},
) {
  ({ accessToken } = await resolveContentAuth(accessToken));
  const data = unwrapResponse(
    await userClient.im.v1.messageReaction.list(
      {
        path: {
          message_id: messageId,
        },
        params: {
          reaction_type: reactionType,
          page_token: pageToken,
          page_size: pageSize,
          user_id_type: userIdType,
        },
      },
      Lark.withUserAccessToken(accessToken),
    ),
    "Failed to list Lark message reactions",
  );

  return {
    message_id: messageId,
    items: (data.items || []).map(normalizeMessageReaction),
    page_token: data.page_token || null,
    has_more: Boolean(data.has_more),
  };
}

export async function createMessageReaction(accessToken, messageId, emojiType) {
  assertLarkWriteAllowed();
  ({ accessToken } = await resolveContentAuth(accessToken));
  const data = unwrapResponse(
    await userClient.im.v1.messageReaction.create(
      {
        path: {
          message_id: messageId,
        },
        data: {
          reaction_type: {
            emoji_type: emojiType,
          },
        },
      },
      Lark.withUserAccessToken(accessToken),
    ),
    "Failed to create Lark message reaction",
  );

  return normalizeMessageReaction(data);
}

export async function deleteMessageReaction(accessToken, messageId, reactionId) {
  assertLarkWriteAllowed();
  ({ accessToken } = await resolveContentAuth(accessToken));
  const data = unwrapResponse(
    await userClient.im.v1.messageReaction.delete(
      {
        path: {
          message_id: messageId,
          reaction_id: reactionId,
        },
      },
      Lark.withUserAccessToken(accessToken),
    ),
    "Failed to delete Lark message reaction",
  );

  return normalizeMessageReaction(data);
}
