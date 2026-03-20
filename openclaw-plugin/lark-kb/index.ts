import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
};

type PluginConfig = {
  baseUrl?: string;
  timeoutMs?: number;
};

const TOOL_OUTPUT_MAX_CHARS = Number.parseInt(process.env.OPENCLAW_TOOL_OUTPUT_MAX_CHARS || "2400", 10);
const toolExecutionContext = new AsyncLocalStorage<{
  action: string;
  params: Record<string, unknown>;
  requestId: string;
  traceId: string | null;
}>();

function createRequestId(prefix = "tool") {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function normalizeLogObject(value: unknown, fallbackKey = "value"): Record<string, unknown> {
  if (!value) {
    return {};
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>) };
  }
  if (Array.isArray(value)) {
    return { items: value };
  }
  return { [fallbackKey]: value };
}

function extractTraceId(value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim() || null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as { trace_id?: unknown }).trace_id !== "string") {
    return null;
  }
  return ((value as { trace_id?: string }).trace_id || "").trim() || null;
}

function extractToolResultLogData(result: unknown): Record<string, unknown> {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const toolResult = result as ToolResult;
    if (toolResult.details && typeof toolResult.details === "object" && !Array.isArray(toolResult.details)) {
      return { ...toolResult.details };
    }
  }
  return normalizeLogObject(result, "result");
}

function extractErrorLogData(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const details = normalizeLogObject((error as Error & { data?: unknown }).data, "data");
    const status = Number.isFinite(Number((error as Error & { status?: unknown }).status))
      ? { status: Number((error as Error & { status?: unknown }).status) }
      : {};
    return {
      ...status,
      ...details,
    };
  }
  return normalizeLogObject(error, "error");
}

function emitToolExecutionLog({
  requestId,
  action,
  params,
  success,
  data,
  error,
  traceId = null,
}: {
  requestId: string;
  action: string;
  params: Record<string, unknown>;
  success: boolean;
  data: Record<string, unknown>;
  error: string | null;
  traceId?: string | null;
}) {
  const sink = success ? console.info.bind(console) : console.error.bind(console);
  sink("lobster_tool_execution", {
    request_id: requestId,
    action,
    params: normalizeLogObject(params, "params"),
    result: {
      success,
      data: normalizeLogObject(data, "data"),
      error,
    },
    trace_id: traceId,
  });
}

function getConfig(api: { pluginConfig?: PluginConfig }) {
  const cfg = api.pluginConfig ?? {};
  return {
    baseUrl: (cfg.baseUrl || "http://127.0.0.1:3333").replace(/\/$/, ""),
    timeoutMs: typeof cfg.timeoutMs === "number" && cfg.timeoutMs > 0 ? cfg.timeoutMs : 20_000,
  };
}

async function callJson(
  api: { pluginConfig?: PluginConfig },
  path: string,
  init?: RequestInit,
): Promise<{ status: number; data: unknown }> {
  const cfg = getConfig(api);
  const executionContext = toolExecutionContext.getStore();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(`${cfg.baseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(executionContext?.requestId ? { "X-Request-Id": executionContext.requestId } : {}),
        ...(init?.headers ?? {}),
      },
      signal: controller.signal,
    });
    const text = await res.text();
    let data: unknown = null;
    if (text.trim()) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }
    if (executionContext && !executionContext.traceId) {
      executionContext.traceId = extractTraceId(data);
    }
    return { status: res.status, data };
  } finally {
    clearTimeout(timeout);
  }
}

function trimText(value: unknown, maxChars = 220) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
}

function summarizeArray(items: unknown[], depth: number, maxDepth: number): unknown[] {
  const head = items.slice(0, 6).map((item) => summarizePayload(item, depth + 1, maxDepth));
  if (items.length > 6) {
    head.push({ _truncated_items: items.length - 6 });
  }
  return head;
}

function summarizeObject(payload: Record<string, unknown>, depth: number, maxDepth: number) {
  if (depth >= maxDepth) {
    return { _summary: `object(${Object.keys(payload).length})` };
  }

  const preferredKeys = [
    "ok",
    "message",
    "error",
    "account_id",
    "document_id",
    "title",
    "url",
    "items",
    "sources",
    "answer",
    "provider",
    "status",
    "summary",
    "change_summary",
    "patch_plan",
    "results",
    "moves",
    "created_folders",
    "target_folders",
  ];

  const orderedKeys = [
    ...preferredKeys.filter((key) => key in payload),
    ...Object.keys(payload).filter((key) => !preferredKeys.includes(key)),
  ].slice(0, 20);

  const result: Record<string, unknown> = {};
  for (const key of orderedKeys) {
    result[key] = summarizePayload(payload[key], depth + 1, maxDepth);
  }
  if (Object.keys(payload).length > orderedKeys.length) {
    result._truncated_keys = Object.keys(payload).length - orderedKeys.length;
  }
  return result;
}

function summarizePayload(payload: unknown, depth = 0, maxDepth = 3): unknown {
  if (payload == null) {
    return payload;
  }
  if (typeof payload === "string") {
    return trimText(payload, 260);
  }
  if (typeof payload !== "object") {
    return payload;
  }
  if (Array.isArray(payload)) {
    return summarizeArray(payload, depth, maxDepth);
  }
  return summarizeObject(payload as Record<string, unknown>, depth, maxDepth);
}

function compactAnswerPayload(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return payload;
  }
  const data = payload as Record<string, unknown>;
  const sources = Array.isArray(data.sources) ? data.sources : [];
  return {
    ok: data.ok,
    account_id: data.account_id,
    provider: data.provider,
    answer: trimText(data.answer, TOOL_OUTPUT_MAX_CHARS),
    source_preview: sources.slice(0, 6),
    total_sources: sources.length,
  };
}

function compactDocumentPayload(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return payload;
  }
  const data = payload as Record<string, unknown>;
  return {
    ok: data.ok,
    document_id: data.document_id,
    title: data.title,
    url: data.url,
    revision_id: data.revision_id,
    content_preview: trimText(data.content, TOOL_OUTPUT_MAX_CHARS),
    content_length: data.content_length,
    mode: data.mode,
    update_result: summarizePayload(data.update_result),
    change_summary: Array.isArray(data.change_summary) ? summarizeArray(data.change_summary as unknown[], 0, 2) : data.change_summary,
  };
}

function compactMessagePayload(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return payload;
  }
  const data = payload as Record<string, unknown>;
  const items = Array.isArray(data.items) ? data.items : [];
  return {
    ok: data.ok,
    chat_id: data.chat_id,
    message_id: data.message_id,
    items: items.slice(0, 6).map((item) => summarizePayload(item, 1, 2)),
    total_items: items.length,
    has_more: data.has_more,
  };
}

function compactByTitle(title: string, payload: unknown) {
  if (title.includes("lark_kb_answer") || title.includes("lark_kb_search")) {
    return compactAnswerPayload(payload);
  }
  if (title.includes("lark_doc_")) {
    return compactDocumentPayload(payload);
  }
  if (title.includes("lark_messages_")) {
    return compactMessagePayload(payload);
  }
  if (title.includes("organize")) {
    return title.includes("wiki") ? compactWikiOrganizePayload(payload) : compactDriveOrganizePayload(payload);
  }
  return summarizePayload(payload);
}

function formatResult(title: string, payload: unknown): ToolResult {
  const compacted = compactByTitle(title, payload);
  return {
    content: [{ type: "text", text: `${title}\n${JSON.stringify(compacted, null, 2)}` }],
    details: typeof compacted === "object" && compacted ? (compacted as Record<string, unknown>) : undefined,
  };
}

function cleanStringParam(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function firstCapture(text: string, patterns: RegExp[]) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }
  return "";
}

function extractBitableReferenceFromUrl(value: unknown) {
  const raw = cleanStringParam(value);
  if (!raw) {
    return null;
  }

  const appToken = firstCapture(raw, [/\/base\/([A-Za-z0-9_-]+)/i]);
  if (!appToken) {
    return null;
  }

  return {
    appToken,
    tableId: firstCapture(raw, [/[?&#](?:table|table_id|tableId)=([A-Za-z0-9_-]+)/i]),
    viewId: firstCapture(raw, [/[?&#](?:view|view_id|viewId)=([A-Za-z0-9_-]+)/i]),
    recordId: firstCapture(raw, [/[?&#](?:record|record_id|recordId)=([A-Za-z0-9_-]+)/i]),
  };
}

function resolveBitableContext(
  toolName: string,
  params: Record<string, unknown>,
  { requireTableId = false, requireRecordId = false } = {},
) {
  const fromUrl = extractBitableReferenceFromUrl(params.url);
  const appToken = cleanStringParam(params.app_token) || fromUrl?.appToken || "";
  const tableId = cleanStringParam(params.table_id) || fromUrl?.tableId || "";
  const viewId = cleanStringParam(params.view_id) || fromUrl?.viewId || "";
  const recordId = cleanStringParam(params.record_id) || fromUrl?.recordId || "";

  if (!appToken) {
    throw new Error(`${toolName} requires app_token or a Bitable base url`);
  }
  if (requireTableId && !tableId) {
    throw new Error(`${toolName} requires table_id or a Bitable url that includes table=...`);
  }
  if (requireRecordId && !recordId) {
    throw new Error(`${toolName} requires record_id or a Bitable url that includes record=...`);
  }

  return {
    appToken,
    tableId,
    viewId,
    recordId,
  };
}

function compactDriveOrganizePayload(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return payload;
  }

  const data = payload as Record<string, unknown>;
  const targetFolders = Array.isArray(data.target_folders) ? data.target_folders : [];
  const moves = Array.isArray(data.moves) ? data.moves : [];
  const createdFolders = Array.isArray(data.created_folders) ? data.created_folders : [];

  return {
    ok: data.ok,
    account_id: data.account_id,
    auth_mode: data.auth_mode,
    action: data.action,
    folder_token: data.folder_token,
    recursive: data.recursive,
    include_folders: data.include_folders,
    semantic_classifier: data.semantic_classifier,
    scanned_total: data.scanned_total,
    movable_total: data.movable_total,
    moves_submitted: data.moves_submitted,
    target_folder_names: targetFolders
      .map((item) => (item && typeof item === "object" ? String((item as Record<string, unknown>).name || "") : ""))
      .filter(Boolean),
    created_folder_names: createdFolders
      .map((item) => (item && typeof item === "object" ? String((item as Record<string, unknown>).name || "") : ""))
      .filter(Boolean),
    move_preview: moves.slice(0, 12).map((item) => {
      const row = item as Record<string, unknown>;
      return {
        name: row.name,
        type: row.type,
        target_folder_name: row.target_folder_name,
        reason: row.reason,
        status: row.status,
        task_id: row.task_id,
      };
    }),
    move_preview_truncated: moves.length > 12,
    total_move_records: moves.length,
  };
}

function compactWikiOrganizePayload(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return payload;
  }

  const data = payload as Record<string, unknown>;
  const targetFolders = Array.isArray(data.target_folders) ? data.target_folders : [];
  const moves = Array.isArray(data.moves) ? data.moves : [];
  const createdFolders = Array.isArray(data.created_folders) ? data.created_folders : [];
  const spaces = Array.isArray(data.available_spaces) ? data.available_spaces : [];

  return {
    ok: data.ok,
    account_id: data.account_id,
    auth_mode: data.auth_mode,
    action: data.action,
    space_id: data.space_id,
    space_name: data.space_name,
    space_type: data.space_type,
    parent_node_token: data.parent_node_token,
    recursive: data.recursive,
    include_containers: data.include_containers,
    semantic_classifier: data.semantic_classifier,
    scanned_total: data.scanned_total,
    movable_total: data.movable_total,
    moves_submitted: data.moves_submitted,
    available_spaces: spaces.slice(0, 12),
    target_folder_names: targetFolders
      .map((item) => (item && typeof item === "object" ? String((item as Record<string, unknown>).name || "") : ""))
      .filter(Boolean),
    created_folder_names: createdFolders
      .map((item) => (item && typeof item === "object" ? String((item as Record<string, unknown>).title || "") : ""))
      .filter(Boolean),
    move_preview: moves.slice(0, 12).map((item) => {
      const row = item as Record<string, unknown>;
      return {
        name: row.name,
        type: row.type,
        target_folder_name: row.target_folder_name,
        reason: row.reason,
        status: row.status,
      };
    }),
    move_preview_truncated: moves.length > 12,
    total_move_records: moves.length,
  };
}

function toQuery(params: Record<string, unknown>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    query.set(key, String(value));
  }
  const encoded = query.toString();
  return encoded ? `?${encoded}` : "";
}

function errorFromResponse(operation: string, status: number, data: unknown): Error {
  const details =
    typeof data === "object" && data && "message" in data
      ? String((data as { message?: unknown }).message || "")
      : JSON.stringify(data);
  const error = new Error(`${operation} failed (${status}): ${details}`) as Error & {
    status?: number;
    data?: Record<string, unknown>;
    trace_id?: string | null;
  };
  error.status = status;
  error.data = normalizeLogObject(data, "data");
  error.trace_id = extractTraceId(data);
  return error;
}

function withToolExecutionLogging(tool: {
  name?: string;
  execute?: (id: string, params: Record<string, unknown>) => Promise<ToolResult>;
  [key: string]: unknown;
}) {
  if (typeof tool.execute !== "function") {
    return tool;
  }

  const originalExecute = tool.execute.bind(tool);

  return {
    ...tool,
    async execute(id: string, params: Record<string, unknown>) {
      const requestId = createRequestId("openclaw_tool");
      const context = {
        action: String(tool.name || "").trim(),
        params: params && typeof params === "object" && !Array.isArray(params) ? { ...params } : {},
        requestId,
        traceId: null as string | null,
      };

      return toolExecutionContext.run(context, async () => {
        try {
          const result = await originalExecute(id, params);
          emitToolExecutionLog({
            requestId,
            action: context.action,
            params: context.params,
            success: true,
            data: extractToolResultLogData(result),
            error: null,
            traceId: context.traceId,
          });
          return result;
        } catch (error) {
          emitToolExecutionLog({
            requestId,
            action: context.action,
            params: context.params,
            success: false,
            data: extractErrorLogData(error),
            error: error instanceof Error ? error.message : String(error),
            traceId: context.traceId || extractTraceId((error as { trace_id?: unknown })?.trace_id),
          });
          throw error;
        }
      });
    },
  };
}

export default function register(api: { registerTool: Function; pluginConfig?: PluginConfig }) {
  const originalRegisterTool = api.registerTool.bind(api);
  api.registerTool = (tool: Record<string, unknown>, options?: Record<string, unknown>) => (
    originalRegisterTool(withToolExecutionLogging(tool), options)
  );

  api.registerTool(
    {
      name: "lark_kb_status",
      description:
        "Check whether the user-authorized Lark knowledge base is online and whether OAuth authorization is complete. Use this before sync/search when Lark knowledge looks unavailable.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          account_id: { type: "string" }
        }
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const query = toQuery({ account_id: params.account_id });
        const health = await callJson(api, "/health");
        const auth = await callJson(api, `/api/auth/status${query}`);
        return formatResult("lark_kb_status", {
          health_status: health.status,
          health: health.data,
          auth_status: auth.status,
          auth: auth.data,
        });
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_kb_sync",
      description:
        "Run a full or incremental sync from the user's Lark Drive/Docs/Wiki into the local knowledge base. Use this after the user finishes OAuth, before answering broad company-knowledge questions, and before organizing documents when fresh content understanding matters.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          mode: { type: "string", enum: ["full", "incremental"] },
          account_id: { type: "string" }
        }
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const mode = params.mode === "full" ? "full" : "incremental";
        const body = JSON.stringify({
          account_id: typeof params.account_id === "string" ? params.account_id : undefined,
        });
        const result = await callJson(api, `/sync/${mode}`, {
          method: "POST",
          body,
        });
        if (result.status >= 400) {
          throw errorFromResponse(`lark_kb_sync:${mode}`, result.status, result.data);
        }
        return formatResult(`lark_kb_sync:${mode}`, result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_kb_search",
      description:
        "Search the user-authorized Lark knowledge base across synced Drive/Docs/Wiki content. Prefer this over direct per-document browsing when the user asks about company knowledge in general.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          q: { type: "string" },
          k: { type: "number" },
          account_id: { type: "string" }
        },
        required: ["q"]
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const query = toQuery({
          q: params.q,
          k: params.k,
          account_id: params.account_id,
        });
        const result = await callJson(api, `/search${query}`);
        if (result.status >= 400) {
          throw errorFromResponse("lark_kb_search", result.status, result.data);
        }
        return formatResult("lark_kb_search", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_kb_answer",
      description:
        "Answer a question from the user-authorized Lark knowledge base and return cited sources. Use this when the user asks questions about internal Lark docs without sharing specific links.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          q: { type: "string" },
          k: { type: "number" },
          account_id: { type: "string" }
        },
        required: ["q"]
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const query = toQuery({
          q: params.q,
          k: params.k,
          account_id: params.account_id,
        });
        const result = await callJson(api, `/answer${query}`);
        if (result.status >= 400) {
          throw errorFromResponse("lark_kb_answer", result.status, result.data);
        }
        return formatResult("lark_kb_answer", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_doc_read",
      description:
        "Read a Lark docx document directly with the authorized user OAuth token. Use this when the user gives a specific document id or asks to inspect one document in detail.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          document_id: { type: "string" },
          document_url: { type: "string" },
          account_id: { type: "string" }
        },
        required: []
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const query = toQuery({
          document_id: params.document_id,
          document_url: params.document_url,
          account_id: params.account_id,
        });
        const result = await callJson(api, `/api/doc/read${query}`);
        if (result.status >= 400) {
          throw errorFromResponse("lark_doc_read", result.status, result.data);
        }
        return formatResult("lark_doc_read", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_doc_create",
      description:
        "Create a new Lark docx document in the user's Drive and optionally write initial content into it. Use this when the user asks you to draft a new document.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          folder_token: { type: "string" },
          content: { type: "string" },
          account_id: { type: "string" }
        },
        required: ["title"]
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const result = await callJson(api, "/api/doc/create", {
          method: "POST",
          body: JSON.stringify({
            title: params.title,
            folder_token: params.folder_token,
            content: params.content,
            account_id: params.account_id,
          }),
        });
        if (result.status >= 400) {
          throw errorFromResponse("lark_doc_create", result.status, result.data);
        }
        return formatResult("lark_doc_create", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_doc_update",
      description:
        "Append to or replace the content of an existing Lark docx document using the authorized user OAuth token. You can also target one markdown heading section with target_heading. Replace mode, and heading-targeted updates, are preview-first: the first call returns a confirmation_id, and only a second call with confirm=true applies the overwrite.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          document_id: { type: "string" },
          document_url: { type: "string" },
          content: { type: "string" },
          mode: { type: "string", enum: ["append", "replace"] },
          target_heading: { type: "string" },
          target_position: { type: "string", enum: ["end_of_section", "after_heading"] },
          confirmation_id: { type: "string" },
          confirm: { type: "boolean" },
          account_id: { type: "string" }
        },
        required: ["content"]
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const result = await callJson(api, "/api/doc/update", {
          method: "POST",
          body: JSON.stringify({
            document_id: params.document_id,
            document_url: params.document_url,
            content: params.content,
            mode: params.mode === "replace" ? "replace" : "append",
            target_heading: params.target_heading,
            target_position: params.target_position,
            confirmation_id: params.confirmation_id,
            confirm: params.confirm === true,
            account_id: params.account_id,
          }),
        });
        if (result.status >= 400) {
          throw errorFromResponse("lark_doc_update", result.status, result.data);
        }
        return formatResult("lark_doc_update", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_doc_comments",
      description:
        "List comments on one Lark docx document. Use this before proposing document edits based on reviewer feedback.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          document_id: { type: "string" },
          document_url: { type: "string" },
          include_solved: { type: "boolean" },
          account_id: { type: "string" }
        },
        required: []
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const query = toQuery({
          document_id: params.document_id,
          document_url: params.document_url,
          include_solved: params.include_solved === true ? "true" : undefined,
          account_id: params.account_id,
        });
        const result = await callJson(api, `/api/doc/comments${query}`);
        if (result.status >= 400) {
          throw errorFromResponse("lark_doc_comments", result.status, result.data);
        }
        return formatResult("lark_doc_comments", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_doc_rewrite_from_comments",
      description:
        "Rewrite a Lark docx draft based on document comments. Preview first. Real apply requires confirmation_id plus confirm=true.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          document_id: { type: "string" },
          document_url: { type: "string" },
          comment_ids: {
            type: "array",
            items: { type: "string" }
          },
          include_solved: { type: "boolean" },
          apply: { type: "boolean" },
          confirmation_id: { type: "string" },
          confirm: { type: "boolean" },
          resolve_comments: { type: "boolean" },
          account_id: { type: "string" }
        },
        required: []
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const result = await callJson(api, "/api/doc/rewrite-from-comments", {
          method: "POST",
          body: JSON.stringify({
            document_id: params.document_id,
            document_url: params.document_url,
            comment_ids: params.comment_ids,
            include_solved: params.include_solved === true,
            apply: params.apply === true,
            confirmation_id: params.confirmation_id,
            confirm: params.confirm === true,
            resolve_comments: params.resolve_comments === true,
            account_id: params.account_id,
          }),
        });
        if (result.status >= 400) {
          throw errorFromResponse("lark_doc_rewrite_from_comments", result.status, result.data);
        }
        return formatResult("lark_doc_rewrite_from_comments", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_doc_comment_suggestion_card",
      description:
        "Detect new unresolved comments on a Lark doc, generate a rewrite preview, and return a human-readable suggestion card. Optionally send that card as a reply to a message_id.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          document_id: { type: "string" },
          document_url: { type: "string" },
          message_id: { type: "string" },
          reply_in_thread: { type: "boolean" },
          resolve_comments: { type: "boolean" },
          mark_seen: { type: "boolean" },
          account_id: { type: "string" }
        },
        required: []
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const result = await callJson(api, "/api/doc/comments/suggestion-card", {
          method: "POST",
          body: JSON.stringify({
            document_id: params.document_id,
            document_url: params.document_url,
            message_id: params.message_id,
            reply_in_thread: params.reply_in_thread === true,
            resolve_comments: params.resolve_comments === true,
            mark_seen: params.mark_seen !== false,
            account_id: params.account_id,
          }),
        });
        if (result.status >= 400) {
          throw errorFromResponse("lark_doc_comment_suggestion_card", result.status, result.data);
        }
        return formatResult("lark_doc_comment_suggestion_card", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_messages_list",
      description:
        "List recent Lark chat history for a chat or other supported container. Use this to gather message context before drafting a reply or summary.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          container_id: { type: "string" },
          container_id_type: { type: "string" },
          start_time: { type: "string" },
          end_time: { type: "string" },
          sort_type: { type: "string", enum: ["ByCreateTimeAsc", "ByCreateTimeDesc"] },
          page_token: { type: "string" },
          account_id: { type: "string" }
        },
        required: ["container_id"]
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const query = toQuery({
          container_id: params.container_id,
          container_id_type: params.container_id_type,
          start_time: params.start_time,
          end_time: params.end_time,
          sort_type: params.sort_type,
          page_token: params.page_token,
          account_id: params.account_id,
        });
        const result = await callJson(api, `/api/messages${query}`);
        if (result.status >= 400) {
          throw errorFromResponse("lark_messages_list", result.status, result.data);
        }
        return formatResult("lark_messages_list", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_messages_search",
      description:
        "Search recent Lark chat history inside one chat container by keyword. Use this to find relevant context before replying or summarizing.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          container_id: { type: "string" },
          container_id_type: { type: "string" },
          q: { type: "string" },
          start_time: { type: "string" },
          end_time: { type: "string" },
          sort_type: { type: "string", enum: ["ByCreateTimeAsc", "ByCreateTimeDesc"] },
          limit: { type: "number" },
          account_id: { type: "string" }
        },
        required: ["container_id", "q"]
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const query = toQuery({
          container_id: params.container_id,
          container_id_type: params.container_id_type,
          q: params.q,
          start_time: params.start_time,
          end_time: params.end_time,
          sort_type: params.sort_type,
          limit: params.limit,
          account_id: params.account_id,
        });
        const result = await callJson(api, `/api/messages/search${query}`);
        if (result.status >= 400) {
          throw errorFromResponse("lark_messages_search", result.status, result.data);
        }
        return formatResult("lark_messages_search", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_message_get",
      description:
        "Get one specific Lark message by message_id. Use this when the user references a concrete message or a thread root.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          message_id: { type: "string" },
          account_id: { type: "string" }
        },
        required: ["message_id"]
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const query = toQuery({ account_id: params.account_id });
        const result = await callJson(api, `/api/messages/${encodeURIComponent(String(params.message_id))}${query}`);
        if (result.status >= 400) {
          throw errorFromResponse("lark_message_get", result.status, result.data);
        }
        return formatResult("lark_message_get", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_message_reply",
      description:
        "Reply to a Lark message with plain text. Optionally keep the reply inside the original thread.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          message_id: { type: "string" },
          content: { type: "string" },
          reply_in_thread: { type: "boolean" },
          account_id: { type: "string" }
        },
        required: ["message_id", "content"]
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const result = await callJson(api, "/api/messages/reply", {
          method: "POST",
          body: JSON.stringify({
            message_id: params.message_id,
            content: params.content,
            reply_in_thread: params.reply_in_thread === true,
            account_id: params.account_id,
          }),
        });
        if (result.status >= 400) {
          throw errorFromResponse("lark_message_reply", result.status, result.data);
        }
        return formatResult("lark_message_reply", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_message_reply_card",
      description:
        "Reply to a Lark message with a simple interactive card built from title and content. Use this when the output should be clearer than plain text.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          message_id: { type: "string" },
          title: { type: "string" },
          content: { type: "string" },
          reply_in_thread: { type: "boolean" },
          account_id: { type: "string" }
        },
        required: ["message_id", "title", "content"]
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const result = await callJson(api, "/api/messages/reply-card", {
          method: "POST",
          body: JSON.stringify({
            message_id: params.message_id,
            title: params.title,
            card_title: params.title,
            content: params.content,
            reply_in_thread: params.reply_in_thread === true,
            account_id: params.account_id,
          }),
        });
        if (result.status >= 400) {
          throw errorFromResponse("lark_message_reply_card", result.status, result.data);
        }
        return formatResult("lark_message_reply_card", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_calendar_primary",
      description:
        "Get the authorized user's primary Lark calendar. Use this before creating or searching events when no calendar_id is known.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          account_id: { type: "string" }
        }
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const query = toQuery({ account_id: params.account_id });
        const result = await callJson(api, `/api/calendar/primary${query}`);
        if (result.status >= 400) {
          throw errorFromResponse("lark_calendar_primary", result.status, result.data);
        }
        return formatResult("lark_calendar_primary", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_calendar_events",
      description:
        "List events in a specific Lark calendar. Use this to inspect schedules, recent events, or an event window.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          calendar_id: { type: "string" },
          page_token: { type: "string" },
          start_time: { type: "string" },
          end_time: { type: "string" },
          anchor_time: { type: "string" },
          account_id: { type: "string" }
        },
        required: ["calendar_id"]
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const query = toQuery({
          calendar_id: params.calendar_id,
          page_token: params.page_token,
          start_time: params.start_time,
          end_time: params.end_time,
          anchor_time: params.anchor_time,
          account_id: params.account_id,
        });
        const result = await callJson(api, `/api/calendar/events${query}`);
        if (result.status >= 400) {
          throw errorFromResponse("lark_calendar_events", result.status, result.data);
        }
        return formatResult("lark_calendar_events", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_calendar_search",
      description:
        "Search events inside one Lark calendar by query text.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          calendar_id: { type: "string" },
          q: { type: "string" },
          account_id: { type: "string" }
        },
        required: ["calendar_id", "q"]
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const result = await callJson(api, "/api/calendar/events/search", {
          method: "POST",
          body: JSON.stringify({
            calendar_id: params.calendar_id,
            q: params.q,
            account_id: params.account_id,
          }),
        });
        if (result.status >= 400) {
          throw errorFromResponse("lark_calendar_search", result.status, result.data);
        }
        return formatResult("lark_calendar_search", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_calendar_create_event",
      description:
        "Create a new Lark calendar event using unix timestamps in milliseconds as strings.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          calendar_id: { type: "string" },
          summary: { type: "string" },
          description: { type: "string" },
          start_time: { type: "string" },
          end_time: { type: "string" },
          timezone: { type: "string" },
          reminders: { type: "array", items: { type: "number" } },
          account_id: { type: "string" }
        },
        required: ["calendar_id", "summary", "start_time", "end_time"]
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const result = await callJson(api, "/api/calendar/events/create", {
          method: "POST",
          body: JSON.stringify({
            calendar_id: params.calendar_id,
            summary: params.summary,
            description: params.description,
            start_time: params.start_time,
            end_time: params.end_time,
            timezone: params.timezone,
            reminders: params.reminders,
            account_id: params.account_id,
          }),
        });
        if (result.status >= 400) {
          throw errorFromResponse("lark_calendar_create_event", result.status, result.data);
        }
        return formatResult("lark_calendar_create_event", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_tasks_list",
      description:
        "List Lark tasks related to the authorized user.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          completed: { type: "boolean" },
          page_token: { type: "string" },
          start_create_time: { type: "string" },
          end_create_time: { type: "string" },
          account_id: { type: "string" }
        }
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const query = toQuery({
          completed: params.completed,
          page_token: params.page_token,
          start_create_time: params.start_create_time,
          end_create_time: params.end_create_time,
          account_id: params.account_id,
        });
        const result = await callJson(api, `/api/tasks${query}`);
        if (result.status >= 400) {
          throw errorFromResponse("lark_tasks_list", result.status, result.data);
        }
        return formatResult("lark_tasks_list", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_task_get",
      description:
        "Get one specific Lark task by task_id.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          task_id: { type: "string" },
          account_id: { type: "string" }
        },
        required: ["task_id"]
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const query = toQuery({ account_id: params.account_id });
        const result = await callJson(api, `/api/tasks/${encodeURIComponent(String(params.task_id))}${query}`);
        if (result.status >= 400) {
          throw errorFromResponse("lark_task_get", result.status, result.data);
        }
        return formatResult("lark_task_get", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_task_create",
      description:
        "Create a new Lark task. Use this for follow-ups, action items, or task conversion from chat context.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          summary: { type: "string" },
          description: { type: "string" },
          due_time: { type: "string" },
          timezone: { type: "string" },
          link_url: { type: "string" },
          link_title: { type: "string" },
          account_id: { type: "string" }
        },
        required: ["summary"]
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const result = await callJson(api, "/api/tasks/create", {
          method: "POST",
          body: JSON.stringify({
            summary: params.summary,
            description: params.description,
            due_time: params.due_time,
            timezone: params.timezone,
            link_url: params.link_url,
            link_title: params.link_title,
            account_id: params.account_id,
          }),
        });
        if (result.status >= 400) {
          throw errorFromResponse("lark_task_create", result.status, result.data);
        }
        return formatResult("lark_task_create", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_bitable_app_create",
      description:
        "Create a Lark Bitable app. Use this when the user wants a new multi-dimensional table workspace.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          folder_token: { type: "string" },
          time_zone: { type: "string" },
          account_id: { type: "string" }
        },
        required: ["name"]
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const result = await callJson(api, "/api/bitable/apps/create", {
          method: "POST",
          body: JSON.stringify({
            name: params.name,
            folder_token: params.folder_token,
            time_zone: params.time_zone,
            account_id: params.account_id,
          }),
        });
        if (result.status >= 400) throw errorFromResponse("lark_bitable_app_create", result.status, result.data);
        return formatResult("lark_bitable_app_create", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_bitable_app_get",
      description:
        "Get one Lark Bitable app. Accepts either app_token or a full Bitable base URL.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          app_token: { type: "string" },
          url: { type: "string" },
          account_id: { type: "string" }
        },
        required: []
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const { appToken } = resolveBitableContext("lark_bitable_app_get", params);
        const query = toQuery({ account_id: params.account_id });
        const result = await callJson(api, `/api/bitable/apps/${encodeURIComponent(appToken)}${query}`);
        if (result.status >= 400) throw errorFromResponse("lark_bitable_app_get", result.status, result.data);
        return formatResult("lark_bitable_app_get", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_bitable_tables_list",
      description:
        "List all tables inside one Lark Bitable app. Accepts either app_token or a full Bitable base URL.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          app_token: { type: "string" },
          url: { type: "string" },
          page_token: { type: "string" },
          page_size: { type: "number" },
          account_id: { type: "string" }
        },
        required: []
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const { appToken } = resolveBitableContext("lark_bitable_tables_list", params);
        const query = toQuery({
          page_token: params.page_token,
          page_size: params.page_size,
          account_id: params.account_id,
        });
        const result = await callJson(api, `/api/bitable/apps/${encodeURIComponent(appToken)}/tables${query}`);
        if (result.status >= 400) throw errorFromResponse("lark_bitable_tables_list", result.status, result.data);
        return formatResult("lark_bitable_tables_list", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_bitable_table_create",
      description:
        "Create one table inside a Lark Bitable app. Accepts either app_token or a full Bitable base URL.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          app_token: { type: "string" },
          url: { type: "string" },
          name: { type: "string" },
          default_view_name: { type: "string" },
          fields: { type: "array", items: { type: "object" } },
          account_id: { type: "string" }
        },
        required: ["name"]
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const { appToken } = resolveBitableContext("lark_bitable_table_create", params);
        const result = await callJson(api, `/api/bitable/apps/${encodeURIComponent(appToken)}/tables/create`, {
          method: "POST",
          body: JSON.stringify({
            name: params.name,
            default_view_name: params.default_view_name,
            fields: params.fields,
            account_id: params.account_id,
          }),
        });
        if (result.status >= 400) throw errorFromResponse("lark_bitable_table_create", result.status, result.data);
        return formatResult("lark_bitable_table_create", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_bitable_records_list",
      description:
        "List records in one Bitable table. Accepts either app_token plus table_id, or a Bitable URL that already includes the target table.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          app_token: { type: "string" },
          url: { type: "string" },
          table_id: { type: "string" },
          page_token: { type: "string" },
          page_size: { type: "number" },
          view_id: { type: "string" },
          account_id: { type: "string" }
        },
        required: []
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const { appToken, tableId, viewId } = resolveBitableContext("lark_bitable_records_list", params, {
          requireTableId: true,
        });
        const query = toQuery({
          page_token: params.page_token,
          page_size: params.page_size,
          view_id: params.view_id || viewId,
          account_id: params.account_id,
        });
        const result = await callJson(
          api,
          `/api/bitable/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records${query}`,
        );
        if (result.status >= 400) throw errorFromResponse("lark_bitable_records_list", result.status, result.data);
        return formatResult("lark_bitable_records_list", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_bitable_records_search",
      description:
        "Filter or search records in one Bitable table. Accepts either app_token plus table_id, or a Bitable URL that already includes the target table.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          app_token: { type: "string" },
          url: { type: "string" },
          table_id: { type: "string" },
          filter: { type: "object" },
          field_names: { type: "array", items: { type: "string" } },
          sort: { type: "array", items: { type: "object" } },
          page_size: { type: "number" },
          page_token: { type: "string" },
          view_id: { type: "string" },
          account_id: { type: "string" }
        },
        required: []
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const { appToken, tableId, viewId } = resolveBitableContext("lark_bitable_records_search", params, {
          requireTableId: true,
        });
        const result = await callJson(
          api,
          `/api/bitable/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/search`,
          {
            method: "POST",
            body: JSON.stringify({
              filter: params.filter,
              field_names: params.field_names,
              sort: params.sort,
              page_size: params.page_size,
              page_token: params.page_token,
              view_id: params.view_id || viewId,
              account_id: params.account_id,
            }),
          },
        );
        if (result.status >= 400) throw errorFromResponse("lark_bitable_records_search", result.status, result.data);
        return formatResult("lark_bitable_records_search", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_bitable_record_create",
      description:
        "Create one record in a Bitable table. Accepts either app_token plus table_id, or a Bitable URL that already includes the target table.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          app_token: { type: "string" },
          url: { type: "string" },
          table_id: { type: "string" },
          fields: { type: "object" },
          account_id: { type: "string" }
        },
        required: ["fields"]
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const { appToken, tableId } = resolveBitableContext("lark_bitable_record_create", params, {
          requireTableId: true,
        });
        const result = await callJson(
          api,
          `/api/bitable/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/create`,
          {
            method: "POST",
            body: JSON.stringify({
              fields: params.fields,
              account_id: params.account_id,
            }),
          },
        );
        if (result.status >= 400) throw errorFromResponse("lark_bitable_record_create", result.status, result.data);
        return formatResult("lark_bitable_record_create", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_bitable_record_update",
      description:
        "Update one record in a Bitable table. Accepts either raw tokens or a Bitable URL that already includes the target table and record.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          app_token: { type: "string" },
          url: { type: "string" },
          table_id: { type: "string" },
          record_id: { type: "string" },
          fields: { type: "object" },
          account_id: { type: "string" }
        },
        required: ["fields"]
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const { appToken, tableId, recordId } = resolveBitableContext("lark_bitable_record_update", params, {
          requireTableId: true,
          requireRecordId: true,
        });
        const result = await callJson(
          api,
          `/api/bitable/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}`,
          {
            method: "POST",
            body: JSON.stringify({
              fields: params.fields,
              account_id: params.account_id,
            }),
          },
        );
        if (result.status >= 400) throw errorFromResponse("lark_bitable_record_update", result.status, result.data);
        return formatResult("lark_bitable_record_update", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_bitable_record_delete",
      description:
        "Delete one record from a Bitable table. Accepts either raw tokens or a Bitable URL that already includes the target table and record.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          app_token: { type: "string" },
          url: { type: "string" },
          table_id: { type: "string" },
          record_id: { type: "string" },
          account_id: { type: "string" }
        },
        required: []
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const { appToken, tableId, recordId } = resolveBitableContext("lark_bitable_record_delete", params, {
          requireTableId: true,
          requireRecordId: true,
        });
        const query = toQuery({ account_id: params.account_id });
        const result = await callJson(
          api,
          `/api/bitable/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}${query}`,
          {
            method: "DELETE",
          },
        );
        if (result.status >= 400) throw errorFromResponse("lark_bitable_record_delete", result.status, result.data);
        return formatResult("lark_bitable_record_delete", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_spreadsheet_create",
      description:
        "Create a Lark spreadsheet.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          folder_token: { type: "string" },
          account_id: { type: "string" }
        },
        required: ["title"]
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const result = await callJson(api, "/api/sheets/spreadsheets/create", {
          method: "POST",
          body: JSON.stringify({
            title: params.title,
            folder_token: params.folder_token,
            account_id: params.account_id,
          }),
        });
        if (result.status >= 400) throw errorFromResponse("lark_spreadsheet_create", result.status, result.data);
        return formatResult("lark_spreadsheet_create", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_spreadsheet_sheets",
      description:
        "List sheets inside a spreadsheet.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          spreadsheet_token: { type: "string" },
          account_id: { type: "string" }
        },
        required: ["spreadsheet_token"]
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const query = toQuery({ account_id: params.account_id });
        const result = await callJson(api, `/api/sheets/spreadsheets/${encodeURIComponent(String(params.spreadsheet_token))}/sheets${query}`);
        if (result.status >= 400) throw errorFromResponse("lark_spreadsheet_sheets", result.status, result.data);
        return formatResult("lark_spreadsheet_sheets", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_spreadsheet_replace",
      description:
        "Replace matching cells inside one sheet range.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          spreadsheet_token: { type: "string" },
          sheet_id: { type: "string" },
          range: { type: "string" },
          find: { type: "string" },
          replacement: { type: "string" },
          account_id: { type: "string" }
        },
        required: ["spreadsheet_token", "sheet_id", "range", "find", "replacement"]
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const result = await callJson(
          api,
          `/api/sheets/spreadsheets/${encodeURIComponent(String(params.spreadsheet_token))}/sheets/${encodeURIComponent(String(params.sheet_id))}/replace`,
          {
            method: "POST",
            body: JSON.stringify({
              range: params.range,
              find: params.find,
              replacement: params.replacement,
              account_id: params.account_id,
            }),
          },
        );
        if (result.status >= 400) throw errorFromResponse("lark_spreadsheet_replace", result.status, result.data);
        return formatResult("lark_spreadsheet_replace", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_calendar_freebusy",
      description:
        "Query busy or free slots for one user primary calendar or one room.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          time_min: { type: "string" },
          time_max: { type: "string" },
          user_id: { type: "string" },
          room_id: { type: "string" },
          only_busy: { type: "boolean" },
          include_external_calendar: { type: "boolean" },
          user_id_type: { type: "string" },
          account_id: { type: "string" }
        },
        required: ["time_min", "time_max"]
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const result = await callJson(api, "/api/calendar/freebusy", {
          method: "POST",
          body: JSON.stringify({
            time_min: params.time_min,
            time_max: params.time_max,
            user_id: params.user_id,
            room_id: params.room_id,
            only_busy: params.only_busy === true,
            include_external_calendar: params.include_external_calendar === true,
            user_id_type: params.user_id_type,
            account_id: params.account_id,
          }),
        });
        if (result.status >= 400) throw errorFromResponse("lark_calendar_freebusy", result.status, result.data);
        return formatResult("lark_calendar_freebusy", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_task_comments",
      description:
        "List comments on one task.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          task_id: { type: "string" },
          page_token: { type: "string" },
          page_size: { type: "number" },
          account_id: { type: "string" }
        },
        required: ["task_id"]
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const query = toQuery({
          page_token: params.page_token,
          page_size: params.page_size,
          account_id: params.account_id,
        });
        const result = await callJson(api, `/api/tasks/${encodeURIComponent(String(params.task_id))}/comments${query}`);
        if (result.status >= 400) throw errorFromResponse("lark_task_comments", result.status, result.data);
        return formatResult("lark_task_comments", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_task_comment_create",
      description:
        "Create a comment on one task.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          task_id: { type: "string" },
          content: { type: "string" },
          parent_id: { type: "string" },
          account_id: { type: "string" }
        },
        required: ["task_id", "content"]
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const result = await callJson(api, `/api/tasks/${encodeURIComponent(String(params.task_id))}/comments`, {
          method: "POST",
          body: JSON.stringify({
            content: params.content,
            parent_id: params.parent_id,
            account_id: params.account_id,
          }),
        });
        if (result.status >= 400) throw errorFromResponse("lark_task_comment_create", result.status, result.data);
        return formatResult("lark_task_comment_create", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_task_comment_update",
      description:
        "Update one task comment.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          task_id: { type: "string" },
          comment_id: { type: "string" },
          content: { type: "string" },
          account_id: { type: "string" }
        },
        required: ["task_id", "comment_id", "content"]
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const result = await callJson(
          api,
          `/api/tasks/${encodeURIComponent(String(params.task_id))}/comments/${encodeURIComponent(String(params.comment_id))}`,
          {
            method: "POST",
            body: JSON.stringify({
              content: params.content,
              account_id: params.account_id,
            }),
          },
        );
        if (result.status >= 400) throw errorFromResponse("lark_task_comment_update", result.status, result.data);
        return formatResult("lark_task_comment_update", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_task_comment_delete",
      description:
        "Delete one task comment.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          task_id: { type: "string" },
          comment_id: { type: "string" },
          account_id: { type: "string" }
        },
        required: ["task_id", "comment_id"]
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const query = toQuery({ account_id: params.account_id });
        const result = await callJson(
          api,
          `/api/tasks/${encodeURIComponent(String(params.task_id))}/comments/${encodeURIComponent(String(params.comment_id))}${query}`,
          {
            method: "DELETE",
          },
        );
        if (result.status >= 400) throw errorFromResponse("lark_task_comment_delete", result.status, result.data);
        return formatResult("lark_task_comment_delete", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_message_reactions",
      description:
        "List reactions on one message.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          message_id: { type: "string" },
          reaction_type: { type: "string" },
          page_token: { type: "string" },
          page_size: { type: "number" },
          account_id: { type: "string" }
        },
        required: ["message_id"]
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const query = toQuery({
          reaction_type: params.reaction_type,
          page_token: params.page_token,
          page_size: params.page_size,
          account_id: params.account_id,
        });
        const result = await callJson(api, `/api/messages/${encodeURIComponent(String(params.message_id))}/reactions${query}`);
        if (result.status >= 400) throw errorFromResponse("lark_message_reactions", result.status, result.data);
        return formatResult("lark_message_reactions", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_message_reaction_create",
      description:
        "Add one emoji reaction to a message.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          message_id: { type: "string" },
          emoji_type: { type: "string" },
          account_id: { type: "string" }
        },
        required: ["message_id", "emoji_type"]
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const result = await callJson(api, `/api/messages/${encodeURIComponent(String(params.message_id))}/reactions`, {
          method: "POST",
          body: JSON.stringify({
            emoji_type: params.emoji_type,
            account_id: params.account_id,
          }),
        });
        if (result.status >= 400) throw errorFromResponse("lark_message_reaction_create", result.status, result.data);
        return formatResult("lark_message_reaction_create", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_message_reaction_delete",
      description:
        "Delete one reaction from a message.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          message_id: { type: "string" },
          reaction_id: { type: "string" },
          account_id: { type: "string" }
        },
        required: ["message_id", "reaction_id"]
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const query = toQuery({ account_id: params.account_id });
        const result = await callJson(
          api,
          `/api/messages/${encodeURIComponent(String(params.message_id))}/reactions/${encodeURIComponent(String(params.reaction_id))}${query}`,
          {
            method: "DELETE",
          },
        );
        if (result.status >= 400) throw errorFromResponse("lark_message_reaction_delete", result.status, result.data);
        return formatResult("lark_message_reaction_delete", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_drive_list",
      description:
        "List a user's Lark Drive root or a specific folder using the authorized user OAuth token. Use this for real user-drive browsing, not app-identity Feishu drive access.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          folder_token: { type: "string" },
          page_token: { type: "string" },
          account_id: { type: "string" }
        }
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const query = toQuery({
          folder_token: params.folder_token,
          page_token: params.page_token,
          account_id: params.account_id,
        });
        const result = await callJson(api, `/api/drive/list${query}`);
        if (result.status >= 400) {
          throw errorFromResponse("lark_drive_list", result.status, result.data);
        }
        return formatResult("lark_drive_list", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_drive_create_folder",
      description:
        "Create a new folder inside a specific Lark Drive folder using the authorized user OAuth token.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          folder_token: { type: "string" },
          name: { type: "string" },
          account_id: { type: "string" }
        },
        required: ["folder_token", "name"]
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const result = await callJson(api, "/api/drive/create-folder", {
          method: "POST",
          body: JSON.stringify({
            folder_token: params.folder_token,
            name: params.name,
            account_id: params.account_id,
          }),
        });
        if (result.status >= 400) {
          throw errorFromResponse("lark_drive_create_folder", result.status, result.data);
        }
        return formatResult("lark_drive_create_folder", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_drive_move",
      description:
        "Move a file or folder to another Lark Drive folder using the authorized user OAuth token. Returns a task id when Lark performs the move asynchronously.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          file_token: { type: "string" },
          type: { type: "string" },
          folder_token: { type: "string" },
          account_id: { type: "string" }
        },
        required: ["file_token", "type", "folder_token"]
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const result = await callJson(api, "/api/drive/move", {
          method: "POST",
          body: JSON.stringify({
            file_token: params.file_token,
            type: params.type,
            folder_token: params.folder_token,
            account_id: params.account_id,
          }),
        });
        if (result.status >= 400) {
          throw errorFromResponse("lark_drive_move", result.status, result.data);
        }
        return formatResult("lark_drive_move", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_drive_task_status",
      description:
        "Check the status of an async Lark Drive task such as move or delete, using the authorized user OAuth token.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          task_id: { type: "string" },
          account_id: { type: "string" }
        },
        required: ["task_id"]
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const query = toQuery({
          task_id: params.task_id,
          account_id: params.account_id,
        });
        const result = await callJson(api, `/api/drive/task-status${query}`);
        if (result.status >= 400) {
          throw errorFromResponse("lark_drive_task_status", result.status, result.data);
        }
        return formatResult("lark_drive_task_status", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_drive_delete",
      description:
        "Delete a file or folder in Lark Drive using the authorized user OAuth token. Deleted items go to trash; deleting folders may return an async task id.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          file_token: { type: "string" },
          type: { type: "string" },
          account_id: { type: "string" }
        },
        required: ["file_token", "type"]
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const result = await callJson(api, "/api/drive/delete", {
          method: "POST",
          body: JSON.stringify({
            file_token: params.file_token,
            type: params.type,
            account_id: params.account_id,
          }),
        });
        if (result.status >= 400) {
          throw errorFromResponse("lark_drive_delete", result.status, result.data);
        }
        return formatResult("lark_drive_delete", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_drive_organize",
      description:
        "Preview or apply a folder organization plan for a Lark Drive folder or the user's Drive root. The safe default is preview mode; apply mode will create category folders and move matching items. Prefer preview first, summarize the plan, and only apply after explicit user confirmation.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          folder_token: { type: "string" },
          apply: { type: "boolean" },
          recursive: { type: "boolean" },
          include_folders: { type: "boolean" },
          account_id: { type: "string" }
        },
        required: []
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const path = params.apply === true
          ? "/api/drive/organize/apply"
          : "/api/drive/organize/preview";
        const method = params.apply === true ? "POST" : "POST";
        const result = await callJson(api, path, {
          method,
          body: JSON.stringify({
            folder_token: params.folder_token,
            recursive: params.recursive !== false,
            include_folders: params.include_folders === true,
            account_id: params.account_id,
          }),
        });
        if (result.status >= 400) {
          throw errorFromResponse("lark_drive_organize", result.status, result.data);
        }
        return formatResult("lark_drive_organize", compactDriveOrganizePayload(result.data));
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_wiki_spaces",
      description:
        "List the user-accessible Lark Wiki/Knowledge Base spaces. Use this when documents live in '我的文件資料庫' or another knowledge base rather than a Drive folder.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          account_id: { type: "string" }
        }
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const query = toQuery({ account_id: params.account_id });
        const result = await callJson(api, `/api/wiki/spaces${query}`);
        if (result.status >= 400) {
          throw errorFromResponse("lark_wiki_spaces", result.status, result.data);
        }
        return formatResult("lark_wiki_spaces", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_wiki_nodes",
      description:
        "List child nodes of a Lark Wiki/Knowledge Base space or a specific parent node using the authorized user OAuth token.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          space_id: { type: "string" },
          parent_node_token: { type: "string" },
          page_token: { type: "string" },
          account_id: { type: "string" }
        },
        required: ["space_id"]
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const query = toQuery({
          parent_node_token: params.parent_node_token,
          page_token: params.page_token,
          account_id: params.account_id,
        });
        const result = await callJson(api, `/api/wiki/spaces/${encodeURIComponent(String(params.space_id))}/nodes${query}`);
        if (result.status >= 400) {
          throw errorFromResponse("lark_wiki_nodes", result.status, result.data);
        }
        return formatResult("lark_wiki_nodes", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_wiki_create_node",
      description:
        "Create a new node inside a Lark Wiki/Knowledge Base space using the authorized user OAuth token.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          space_id: { type: "string" },
          title: { type: "string" },
          parent_node_token: { type: "string" },
          account_id: { type: "string" }
        },
        required: ["space_id", "title"]
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const result = await callJson(api, "/api/wiki/create-node", {
          method: "POST",
          body: JSON.stringify({
            space_id: params.space_id,
            title: params.title,
            parent_node_token: params.parent_node_token,
            account_id: params.account_id,
          }),
        });
        if (result.status >= 400) {
          throw errorFromResponse("lark_wiki_create_node", result.status, result.data);
        }
        return formatResult("lark_wiki_create_node", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_wiki_move",
      description:
        "Move a Lark Wiki/Knowledge Base node to another parent node, optionally across spaces, using the authorized user OAuth token.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          space_id: { type: "string" },
          node_token: { type: "string" },
          target_parent_token: { type: "string" },
          target_space_id: { type: "string" },
          account_id: { type: "string" }
        },
        required: ["space_id", "node_token", "target_parent_token"]
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const result = await callJson(api, "/api/wiki/move", {
          method: "POST",
          body: JSON.stringify({
            space_id: params.space_id,
            node_token: params.node_token,
            target_parent_token: params.target_parent_token,
            target_space_id: params.target_space_id,
            account_id: params.account_id,
          }),
        });
        if (result.status >= 400) {
          throw errorFromResponse("lark_wiki_move", result.status, result.data);
        }
        return formatResult("lark_wiki_move", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lark_wiki_organize",
      description:
        "Preview or apply an organization plan inside a Lark Wiki/Knowledge Base space. Use this for documents living in knowledge bases such as '我的文件資料庫', not just Drive folders. Safe default is preview; apply only after explicit user confirmation.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          space_id: { type: "string" },
          space_name: { type: "string" },
          parent_node_token: { type: "string" },
          apply: { type: "boolean" },
          recursive: { type: "boolean" },
          include_containers: { type: "boolean" },
          account_id: { type: "string" }
        },
        required: []
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const path = params.apply === true
          ? "/api/wiki/organize/apply"
          : "/api/wiki/organize/preview";
        const result = await callJson(api, path, {
          method: "POST",
          body: JSON.stringify({
            space_id: params.space_id,
            space_name: params.space_name,
            parent_node_token: params.parent_node_token,
            recursive: params.recursive === true,
            include_containers: params.include_containers === true,
            account_id: params.account_id,
          }),
        });
        if (result.status >= 400) {
          throw errorFromResponse("lark_wiki_organize", result.status, result.data);
        }
        return formatResult("lark_wiki_organize", compactWikiOrganizePayload(result.data));
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lobster_security_status",
      description:
        "Check whether the local lobster security wrapper is online, which approval mode it is using, and how many pending approvals exist.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      async execute() {
        const result = await callJson(api, "/agent/security/status");
        if (result.status >= 400) {
          throw errorFromResponse("lobster_security_status", result.status, result.data);
        }
        return formatResult("lobster_security_status", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lobster_security_start_task",
      description:
        "Start a new secure local task inside the controlled Lobster workspace. Use this before any secured file or command action.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
        },
        required: ["name"],
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const result = await callJson(api, "/agent/tasks", {
          method: "POST",
          body: JSON.stringify({ name: params.name }),
        });
        if (result.status >= 400) {
          throw errorFromResponse("lobster_security_start_task", result.status, result.data);
        }
        return formatResult("lobster_security_start_task", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lobster_security_run_action",
      description:
        "Run a secured local action through the Lobster security wrapper. Supported action types include read_file, write_file, command, http_request, search, and fetch.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          task_id: { type: "string" },
          action: { type: "object" },
        },
        required: ["task_id", "action"],
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const result = await callJson(api, `/agent/tasks/${encodeURIComponent(String(params.task_id))}/actions`, {
          method: "POST",
          body: JSON.stringify({ action: params.action }),
        });
        if (result.status >= 400 && result.status !== 409) {
          throw errorFromResponse("lobster_security_run_action", result.status, result.data);
        }
        return formatResult("lobster_security_run_action", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lobster_security_finish_task",
      description:
        "Finish a secured local task and get the diff summary for changed files inside the controlled workspace.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          task_id: { type: "string" },
          success: { type: "boolean" },
        },
        required: ["task_id"],
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const result = await callJson(api, `/agent/tasks/${encodeURIComponent(String(params.task_id))}/finish`, {
          method: "POST",
          body: JSON.stringify({ success: params.success === true }),
        });
        if (result.status >= 400) {
          throw errorFromResponse("lobster_security_finish_task", result.status, result.data);
        }
        return formatResult("lobster_security_finish_task", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lobster_security_rollback",
      description:
        "Preview or execute a rollback for a secured local task using the workspace snapshot manager.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          task_id: { type: "string" },
          dry_run: { type: "boolean" },
        },
        required: ["task_id"],
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const result = await callJson(api, `/agent/tasks/${encodeURIComponent(String(params.task_id))}/rollback`, {
          method: "POST",
          body: JSON.stringify({ dry_run: params.dry_run !== false }),
        });
        if (result.status >= 400) {
          throw errorFromResponse("lobster_security_rollback", result.status, result.data);
        }
        return formatResult("lobster_security_rollback", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lobster_security_list_approvals",
      description:
        "List pending high-risk actions that are waiting for human approval in the Lobster security wrapper.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      async execute() {
        const result = await callJson(api, "/agent/approvals");
        if (result.status >= 400) {
          throw errorFromResponse("lobster_security_list_approvals", result.status, result.data);
        }
        return formatResult("lobster_security_list_approvals", result.data);
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "lobster_security_resolve_approval",
      description:
        "Approve or reject one pending high-risk action. If approved, the wrapper automatically replays the queued action once.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          request_id: { type: "string" },
          decision: { type: "string", enum: ["approve", "reject"] },
          actor: { type: "string" },
        },
        required: ["request_id", "decision"],
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const result = await callJson(
          api,
          `/agent/approvals/${encodeURIComponent(String(params.request_id))}/${params.decision === "approve" ? "approve" : "reject"}`,
          {
            method: "POST",
            body: JSON.stringify({
              actor: typeof params.actor === "string" ? params.actor : undefined,
            }),
          },
        );
        if (result.status >= 400) {
          throw errorFromResponse("lobster_security_resolve_approval", result.status, result.data);
        }
        return formatResult("lobster_security_resolve_approval", result.data);
      },
    },
    { optional: true },
  );
}
