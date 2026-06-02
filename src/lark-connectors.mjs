import * as Lark from "@larksuiteoapi/node-sdk";
import { apiBaseUrl, baseConfig } from "./config.mjs";
import { resolveLarkRequestAuth } from "./lark-request-auth.mjs";
import { buildParentPath, markdownToPlainText, normalizeText } from "./text-utils.mjs";

const larkClient = new Lark.Client(baseConfig);
const WIKI_PAGE_SIZE = 50;

function withToken(accessToken) {
  return Lark.withUserAccessToken(accessToken);
}

async function resolveConnectorAuth(accessToken) {
  const auth = await resolveLarkRequestAuth(accessToken);
  return auth.accessToken;
}

function normalizeErrorSegment(value, maxLength = 160) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }
  return text.slice(0, maxLength);
}

function sleep(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

async function parseFetchErrorDetail(response) {
  const status = Number(response?.status || 0) || 0;
  const fallback = { status, code: null, msg: "" };
  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch {
    return fallback;
  }

  if (!bodyText) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(bodyText);
    return {
      status,
      code: Number.isFinite(Number(parsed?.code)) ? Number(parsed.code) : null,
      msg: normalizeErrorSegment(parsed?.msg || parsed?.message || ""),
    };
  } catch {
    return {
      status,
      code: null,
      msg: normalizeErrorSegment(bodyText),
    };
  }
}

function shouldRetryMessageResourceFetch(detail = {}) {
  const status = Number(detail?.status || 0) || 0;
  if (status === 429) {
    return true;
  }
  return status >= 500 && status <= 599;
}

function safeUrl(url, fallback) {
  return url || fallback || null;
}

function docUrl(token) {
  return token ? `https://larksuite.com/docx/${token}` : null;
}

function wikiSpaceUrl(spaceId) {
  return spaceId ? `https://larksuite.com/wiki/space/${spaceId}` : null;
}

async function streamToBuffer(readable, maxBytes = 15 * 1024 * 1024) {
  if (!readable || typeof readable.on !== "function") {
    throw new Error("download_stream_unavailable");
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of readable) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new Error("download_stream_too_large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export async function listDriveFolderItems(accessToken, folderToken, pageToken) {
  accessToken = await resolveConnectorAuth(accessToken);
  const response = await larkClient.drive.v1.file.list(
    {
      params: {
        folder_token: folderToken,
        page_size: 200,
        page_token: pageToken,
      },
    },
    withToken(accessToken),
  );

  if (response.code !== 0) {
    throw new Error(response.msg || "Failed to list Lark Drive folder");
  }

  return response.data || {};
}

export async function scanDriveTree(accessToken, folderToken, parentParts = [], recursive = true) {
  accessToken = await resolveConnectorAuth(accessToken);
  const collected = [];
  let pageToken;
  let hasMore = true;

  while (hasMore) {
    const data = await listDriveFolderItems(accessToken, folderToken, pageToken);
    const items = data.files || [];

    for (const item of items) {
      const currentParts = [...parentParts, item.name];
      const parentPath = buildParentPath(parentParts);

      collected.push({
        source_type: "drive",
        external_key: `drive:${item.token}`,
        external_id: item.token,
        file_token: item.token,
        title: item.name,
        url: safeUrl(item.url, docUrl(item.token)),
        parent_external_key: folderToken ? `drive:${folderToken}` : null,
        parent_path: parentPath,
        updated_at_remote: item.modified_time || item.created_time || null,
        revision: item.modified_time || item.created_time || null,
        type: item.type,
        parent_parts: [...parentParts],
        path_parts: currentParts,
      });

      if (recursive && item.type === "folder") {
        const nested = await scanDriveTree(accessToken, item.token, currentParts, true);
        collected.push(...nested);
      }
    }

    pageToken = data.next_page_token;
    hasMore = Boolean(data.has_more && pageToken);
  }

  return collected;
}

export async function fetchDocxPlainText(accessToken, documentId) {
  accessToken = await resolveConnectorAuth(accessToken);
  let rawResponse = null;

  try {
    rawResponse = await larkClient.docx.v1.document.rawContent(
      {
        path: { document_id: documentId },
      },
      withToken(accessToken),
    );
  } catch (error) {
    rawResponse = error?.response?.data || null;
  }

  if (rawResponse?.code === 0 && rawResponse.data?.content) {
    return normalizeText(rawResponse.data.content);
  }

  const markdownResponse = await larkClient.docs.v1.content.get(
    {
      params: {
        doc_token: documentId,
        doc_type: "docx",
        content_type: "markdown",
      },
    },
    withToken(accessToken),
  );

  if (markdownResponse.code !== 0) {
    throw new Error(markdownResponse.msg || rawResponse.msg || "Failed to fetch docx content");
  }

  return markdownToPlainText(markdownResponse.data?.content || "");
}

export async function downloadDriveFileBuffer(accessToken, fileToken, {
  maxBytes = 15 * 1024 * 1024,
} = {}) {
  accessToken = await resolveConnectorAuth(accessToken);
  const download = await larkClient.drive.v1.file.download(
    {
      path: {
        file_token: fileToken,
      },
    },
    withToken(accessToken),
  );
  const stream = download?.getReadableStream?.();
  const buffer = await streamToBuffer(stream, maxBytes);
  return {
    buffer,
    headers: download?.headers && typeof download.headers === "object"
      ? download.headers
      : {},
    content_type: download?.headers?.["content-type"] || download?.headers?.["Content-Type"] || null,
  };
}

export async function downloadMessageFileResourceBuffer(accessToken, messageId, fileKey, {
  maxBytes = 15 * 1024 * 1024,
  maxAttempts = 3,
  retryDelayMs = 700,
} = {}) {
  const url = `${apiBaseUrl}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}?type=file`;
  const primaryAccessToken = await resolveConnectorAuth(accessToken);
  const attempts = Math.max(1, Number.parseInt(String(maxAttempts), 10) || 1);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(
      url,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${primaryAccessToken}`,
        },
      },
    );

    if (!response.ok) {
      const primaryErrorDetail = await parseFetchErrorDetail(response);
      const shouldRetry = attempt < attempts && shouldRetryMessageResourceFetch(primaryErrorDetail);
      if (shouldRetry) {
        await sleep(retryDelayMs * attempt);
        continue;
      }
      throw new Error([
        "message_file_resource_fetch_failed",
        `status=${primaryErrorDetail.status || 0}`,
        `attempt=${attempt}/${attempts}`,
        primaryErrorDetail.code !== null ? `code=${primaryErrorDetail.code}` : "",
        primaryErrorDetail.msg ? `msg=${primaryErrorDetail.msg}` : "",
      ].filter(Boolean).join(":"));
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new Error("download_stream_too_large");
    }

    return {
      buffer,
      content_type: response.headers.get("content-type") || null,
      headers: {
        "content-type": response.headers.get("content-type") || null,
      },
    };
  }
  throw new Error("message_file_resource_fetch_failed");
}

export async function listWikiSpaces(accessToken, pageToken) {
  accessToken = await resolveConnectorAuth(accessToken);
  const response = await larkClient.wiki.v2.space.list(
    {
      params: {
        page_size: WIKI_PAGE_SIZE,
        page_token: pageToken,
      },
    },
    withToken(accessToken),
  );

  if (response.code !== 0) {
    throw new Error(response.msg || "Failed to list Lark Wiki spaces");
  }

  return response.data || {};
}

export async function listWikiSpaceNodes(accessToken, spaceId, parentNodeToken, pageToken) {
  accessToken = await resolveConnectorAuth(accessToken);
  const response = await larkClient.wiki.v2.spaceNode.list(
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
    withToken(accessToken),
  );

  if (response.code !== 0) {
    throw new Error(response.msg || "Failed to list Lark Wiki nodes");
  }

  return response.data || {};
}

export async function scanWikiSpaceTree(
  accessToken,
  space,
  parentNodeToken,
  parentParts = [],
) {
  accessToken = await resolveConnectorAuth(accessToken);
  const collected = [];
  let pageToken;
  let hasMore = true;

  while (hasMore) {
    const data = await listWikiSpaceNodes(accessToken, space.space_id, parentNodeToken, pageToken);
    const nodes = data.items || [];

    for (const node of nodes) {
      const currentParts = [...parentParts, node.title];
      collected.push({
        source_type: "wiki",
        external_key: `wiki:${space.space_id}:${node.node_token}`,
        external_id: node.node_token,
        node_id: node.node_token,
        file_token: node.obj_token,
        document_id: node.obj_token,
        space_id: space.space_id,
        title: node.title,
        url: safeUrl(null, docUrl(node.obj_token)),
        parent_external_key: parentNodeToken ? `wiki:${space.space_id}:${parentNodeToken}` : `wiki-space:${space.space_id}`,
        parent_path: buildParentPath([space.name, ...parentParts]),
        updated_at_remote: node.obj_edit_time || node.node_create_time || null,
        revision: node.obj_edit_time || node.node_create_time || null,
        type: node.obj_type,
        parent_node_token: parentNodeToken || null,
        parent_parts: [space.name, ...parentParts],
        path_parts: [space.name, ...currentParts],
      });

      if (node.has_child) {
        const nested = await scanWikiSpaceTree(
          accessToken,
          space,
          node.node_token,
          currentParts,
        );
        collected.push(...nested);
      }
    }

    pageToken = data.page_token;
    hasMore = Boolean(data.has_more && pageToken);
  }

  return collected;
}

export async function listAllWikiSpaces(accessToken) {
  accessToken = await resolveConnectorAuth(accessToken);
  const spaces = [];
  let pageToken;
  let hasMore = true;

  while (hasMore) {
    const data = await listWikiSpaces(accessToken, pageToken);
    spaces.push(...(data.items || []));
    pageToken = data.page_token;
    hasMore = Boolean(data.has_more && pageToken);
  }

  return spaces.map((space) => ({
    ...space,
    url: wikiSpaceUrl(space.space_id),
    external_key: `wiki-space:${space.space_id}`,
  }));
}
