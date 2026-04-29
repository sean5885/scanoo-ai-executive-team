import * as Lark from "@larksuiteoapi/node-sdk";
import { baseConfig } from "./config.mjs";
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

function safeUrl(url, fallback) {
  return url || fallback || null;
}

function docUrl(token) {
  return token ? `https://larksuite.com/docx/${token}` : null;
}

function wikiSpaceUrl(spaceId) {
  return spaceId ? `https://larksuite.com/wiki/space/${spaceId}` : null;
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
      const itemName = normalizeText(item.name || "");
      const itemMime = normalizeText(item.mime_type || item.mimeType || "");
      const extension = itemName.includes(".")
        ? itemName.split(".").pop().toLowerCase()
        : "";
      const resolvedType = item.type === "file" && (extension === "pdf" || itemMime === "application/pdf")
        ? "pdf"
        : item.type;

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
        type: resolvedType,
        mime: itemMime || null,
        ext: extension || null,
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

export async function fetchDriveFileBytes(accessToken, fileToken) {
  accessToken = await resolveConnectorAuth(accessToken);
  const response = await larkClient.drive.v1.file.download(
    {
      path: {
        file_token: fileToken,
      },
    },
    withToken(accessToken),
  );
  const stream = response?.getReadableStream?.();
  if (!stream) {
    throw new Error("Failed to download drive file stream");
  }

  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
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
