import db from "./db.mjs";
import { listAllWikiSpaces } from "./lark-connectors.mjs";
import {
  createWikiNode,
  listWikiSpaceNodes,
  moveWikiNode,
} from "./lark-content.mjs";
import {
  classifyDocumentsSemantically,
  getSemanticClassifierInfo,
} from "./lark-drive-semantic-classifier.mjs";
import { buildParentPath, normalizeText } from "./text-utils.mjs";

const CONTENT_RULES = [
  {
    category: "工程技術",
    titleKeywords: ["工程", "技術基準", "技術後台", "架構", "api", "devops", "backend", "frontend"],
    contentKeywords: ["工程團隊", "技術標準", "技術系統", "資料庫", "事件流", "協議層", "後端", "前端", "第三方串接", "系統架構"],
  },
  {
    category: "產品需求",
    titleKeywords: ["產品", "需求", "prd", "功能", "藍圖", "流程", "ux", "roadmap", "spec"],
    contentKeywords: ["產品定位", "產品邏輯", "功能需求", "使用者", "用戶", "需求文檔", "產品藍圖", "sop", "交互", "體驗"],
  },
  {
    category: "OKR與計畫",
    titleKeywords: ["okr", "週報", "周報", "月報", "雙月", "季度", "責任對齊", "計畫"],
    contentKeywords: ["關鍵結果", "目標", "milestone", "進度", "週報", "月報", "季度目標", "年度目標"],
  },
  {
    category: "財務報銷",
    titleKeywords: ["報銷", "發票", "財務", "付款", "預算", "invoice", "budget"],
    contentKeywords: ["報銷", "發票", "付款", "預算", "費用", "成本", "採購", "請款"],
  },
  {
    category: "市場業務",
    titleKeywords: ["市場", "商業化", "變現", "廣告", "競品", "招商", "客戶", "商家", "campaign", "sales", "marketing"],
    contentKeywords: ["商業化", "變現", "流量", "商家", "客戶", "招商", "投放", "廣告", "競品", "市場先發", "轉化", "商業模式"],
  },
  {
    category: "人事行政",
    titleKeywords: ["人事", "行政", "招募", "招聘", "新人", "員工", "工時", "考勤", "職責卡", "role card"],
    contentKeywords: ["人事", "行政", "招募", "新人", "員工", "工時", "考勤", "薪資", "職責", "勞動"],
  },
  {
    category: "法務合約",
    titleKeywords: ["法務", "合約", "合同", "契約", "協議", "條款", "商標", "專利", "nda", "legal"],
    contentKeywords: ["法務", "合約", "合同", "契約", "條款", "商標", "專利", "授權", "保密", "智慧財產"],
  },
  {
    category: "投資公司",
    titleKeywords: ["投資", "董事", "監察人", "股東", "融資", "募資", "公司治理", "選票", "cap table", "board"],
    contentKeywords: ["董事", "監察人", "股東", "募資", "融資", "公司治理", "股權", "投資", "董事會", "股東協議"],
  },
];

const TYPE_FOLDERS = {
  doc: "文檔",
  docx: "文檔",
  sheet: "表格",
  bitable: "表格",
  slides: "簡報",
  file: "附件",
  shortcut: "快捷方式",
  mindnote: "腦圖",
};

const getDocumentByNodeStmt = db.prepare(`
  SELECT title, raw_text, source_type, file_token, document_id, parent_path, space_id, node_id
  FROM lark_documents
  WHERE account_id = ?
    AND active = 1
    AND (
      node_id = @node_id
      OR file_token = @file_token
      OR document_id = @file_token
      OR external_key = @wiki_key
    )
  ORDER BY
    CASE
      WHEN node_id = @node_id THEN 0
      WHEN file_token = @file_token THEN 1
      WHEN document_id = @file_token THEN 2
      WHEN external_key = @wiki_key THEN 3
      ELSE 4
    END,
    updated_at DESC
  LIMIT 1
`);

const getDocumentByTitleStmt = db.prepare(`
  SELECT title, raw_text, source_type, file_token, document_id, parent_path, space_id, node_id
  FROM lark_documents
  WHERE account_id = ?
    AND active = 1
    AND title = ?
  ORDER BY updated_at DESC
  LIMIT 1
`);

function scoreKeywordHits(text, keywords, weight) {
  const normalized = normalizeText(text).toLowerCase();
  if (!normalized) {
    return { score: 0, matches: [] };
  }

  const matches = keywords.filter((keyword) => normalized.includes(keyword.toLowerCase()));
  return {
    score: matches.length * weight,
    matches,
  };
}

function classifyByContent(title, text) {
  const scored = CONTENT_RULES.map((rule) => {
    const titleHits = scoreKeywordHits(title, rule.titleKeywords, 4);
    const contentHits = scoreKeywordHits(text, rule.contentKeywords, 1);
    return {
      category: rule.category,
      matches: [...titleHits.matches.map((hit) => `title:${hit}`), ...contentHits.matches.map((hit) => `content:${hit}`)],
      score: titleHits.score + contentHits.score,
    };
  }).filter((rule) => rule.score > 0);

  if (!scored.length) {
    return null;
  }

  scored.sort((a, b) => b.score - a.score || a.category.localeCompare(b.category, "zh-Hant"));
  const best = scored[0];
  const second = scored[1];
  const margin = best.score - (second?.score || 0);
  let confidence = 0.58;
  if (best.score >= 8 && margin >= 3) {
    confidence = 0.92;
  } else if (best.score >= 6 && margin >= 2) {
    confidence = 0.84;
  } else if (best.score >= 4 && margin >= 2) {
    confidence = 0.76;
  } else if (best.score >= 3) {
    confidence = 0.68;
  }
  return {
    category: best.category,
    reason: best.matches.slice(0, 3).join(","),
    confidence,
    method: "content",
  };
}

function classifyByTitle(name) {
  const normalized = normalizeText(name).toLowerCase();
  for (const rule of CONTENT_RULES) {
    const match = rule.titleKeywords.find((keyword) => normalized.includes(keyword.toLowerCase()));
    if (match) {
      return {
        category: rule.category,
        reason: `title:${match}`,
        confidence: 0.52,
        method: "title",
      };
    }
  }
  return null;
}

function findDocumentContext(accountId, item) {
  const row = getDocumentByNodeStmt.get(accountId, {
    node_id: item.node_token,
    file_token: item.obj_token,
    wiki_key: `wiki:${item.space_id}:${item.node_token}`,
  });
  if (row?.raw_text) {
    return row;
  }

  const byTitle = getDocumentByTitleStmt.get(accountId, item.title || "");
  if (byTitle?.raw_text) {
    return byTitle;
  }

  return null;
}

function classifyWikiNode(accountId, node) {
  const documentContext = findDocumentContext(accountId, node);
  const contentMatch = classifyByContent(node.title || "", documentContext?.raw_text || "");
  if (contentMatch) {
    return {
      ...contentMatch,
      content_source: documentContext
        ? {
            title: documentContext.title,
            source_type: documentContext.source_type,
          }
        : null,
    };
  }

  const titleMatch = classifyByTitle(node.title || "");
  if (titleMatch) {
    return titleMatch;
  }

  return {
    category: TYPE_FOLDERS[node.obj_type] || "其他",
    reason: `type:${node.obj_type || "unknown"}`,
    confidence: 0.35,
    method: "type",
    content_source: documentContext
      ? {
          title: documentContext.title,
          source_type: documentContext.source_type,
        }
      : null,
  };
}

async function listAllNodes(accessToken, spaceId, parentNodeToken, recursive, parentParts = []) {
  const items = [];
  let pageToken;
  let hasMore = true;

  while (hasMore) {
    const data = await listWikiSpaceNodes(accessToken, spaceId, parentNodeToken, pageToken);
    const rows = data.items || [];

    for (const node of rows) {
      const currentParts = [...parentParts, node.title];
      items.push({
        ...node,
        parent_path: buildParentPath(parentParts),
        path_parts: currentParts,
      });

      if (recursive && node.has_child) {
        const nested = await listAllNodes(accessToken, spaceId, node.node_token, true, currentParts);
        items.push(...nested);
      }
    }

    pageToken = data.page_token;
    hasMore = Boolean(data.has_more && pageToken);
  }

  return items;
}

async function resolveTargetSpace(accessToken, options = {}) {
  const spaces = await listAllWikiSpaces(accessToken);
  const requestedSpaceId = String(options.spaceId || "").trim();
  const requestedSpaceName = String(options.spaceName || "").trim();

  if (requestedSpaceId) {
    const found = spaces.find((space) => space.space_id === requestedSpaceId);
    if (!found) {
      throw new Error(`wiki_space_not_found:${requestedSpaceId}`);
    }
    return { space: found, spaces };
  }

  if (requestedSpaceName) {
    const found = spaces.find((space) => space.name === requestedSpaceName);
    if (!found) {
      throw new Error(`wiki_space_not_found:${requestedSpaceName}`);
    }
    return { space: found, spaces };
  }

  const myLibrary =
    spaces.find((space) => space.space_type === "my_library") ||
    spaces.find((space) => normalizeText(space.name).includes("我的文件資料庫")) ||
    spaces.find((space) => normalizeText(space.name).includes("我的文件资料库"));

  if (myLibrary) {
    return { space: myLibrary, spaces };
  }

  throw new Error(`wiki_default_space_not_found:${spaces.map((space) => `${space.name}(${space.space_id})`).join(", ")}`);
}

function buildSemanticCandidates(accountId, scannedItems, parentNodeToken, options) {
  const candidates = [];

  for (const item of scannedItems) {
    if (item.has_child && !options.includeContainers) {
      continue;
    }

    if (!options.recursive && item.parent_node_token !== parentNodeToken) {
      continue;
    }

    const documentContext = findDocumentContext(accountId, item);
    if (!documentContext?.raw_text) {
      continue;
    }

    const heuristic = classifyWikiNode(accountId, item);
    if (heuristic.method === "content" && heuristic.confidence >= 0.8) {
      continue;
    }

    candidates.push({
      id: item.node_token,
      title: item.title || documentContext.title || "",
      type: item.obj_type || "",
      parent_path: item.parent_path || "/",
      text: documentContext.raw_text,
      heuristic_category: heuristic.category,
      heuristic_reason: heuristic.reason,
      heuristic_confidence: heuristic.confidence,
      content_source: {
        title: documentContext.title,
        source_type: documentContext.source_type,
      },
    });
  }

  return candidates.sort((a, b) => (a.heuristic_confidence || 0) - (b.heuristic_confidence || 0));
}

function indexExistingCategoryNodes(rootNodes, parentNodeToken) {
  const folders = new Map();
  for (const node of rootNodes) {
    if ((node.parent_node_token || null) !== (parentNodeToken || null)) {
      continue;
    }
    folders.set(node.title, node);
  }
  return folders;
}

function buildMovePlan(accountId, scannedItems, parentNodeToken, existingCategories, options, semanticResults = new Map()) {
  const moves = [];
  const targetFolders = new Map();

  for (const item of scannedItems) {
    if ((item.parent_node_token || null) === (parentNodeToken || null) && existingCategories.has(item.title)) {
      targetFolders.set(item.title, {
        name: item.title,
        node_token: item.node_token,
        existing: true,
      });
    }

    if (item.has_child && !options.includeContainers) {
      continue;
    }

    if (!options.recursive && (item.parent_node_token || null) !== (parentNodeToken || null)) {
      continue;
    }

    const semantic = semanticResults.get(item.node_token);
    const { category, reason, content_source } = semantic
      ? {
          category: semantic.category,
          reason: `semantic:${semantic.reason || semantic.category}`,
          content_source: semantic.content_source || null,
        }
      : classifyWikiNode(accountId, item);

    const targetNode = existingCategories.get(category);
    const targetToken = targetNode?.node_token || null;

    targetFolders.set(category, {
      name: category,
      node_token: targetToken,
      existing: Boolean(targetNode),
    });

    if (item.node_token === targetToken) {
      continue;
    }

    if ((item.parent_node_token || null) === (targetToken || null)) {
      continue;
    }

    if ((item.parent_node_token || null) === (parentNodeToken || null) && item.title === category) {
      continue;
    }

    moves.push({
      node_token: item.node_token,
      file_token: item.obj_token || null,
      name: item.title,
      type: item.obj_type,
      source_parent_node_token: item.parent_node_token || null,
      source_parent_path: item.parent_path || "/",
      target_folder_name: category,
      target_node_token: targetToken,
      reason,
      content_source: content_source || null,
      url: item.obj_token ? `https://larksuite.com/docx/${item.obj_token}` : null,
    });
  }

  return {
    targetFolders: [...targetFolders.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-Hant")),
    moves,
  };
}

export async function previewWikiOrganization(accessToken, options = {}) {
  const recursive = options.recursive === true;
  const includeContainers = options.includeContainers === true;
  const accountId = String(options.accountId || "").trim();
  const { space, spaces } = await resolveTargetSpace(accessToken, options);
  const parentNodeToken = String(options.parentNodeToken || "").trim() || undefined;
  const rootNodes = await listAllNodes(accessToken, space.space_id, parentNodeToken, false, []);
  const scannedItems = recursive
    ? await listAllNodes(accessToken, space.space_id, parentNodeToken, true, [])
    : rootNodes;
  const existingCategories = indexExistingCategoryNodes(rootNodes, parentNodeToken);

  let semanticResults = new Map();
  let semanticClassifier = null;

  if (accountId) {
    const candidates = buildSemanticCandidates(accountId, scannedItems, parentNodeToken, {
      recursive,
      includeContainers,
    });
    if (candidates.length) {
      try {
        const results = await classifyDocumentsSemantically(candidates);
        semanticResults = new Map(
          candidates
            .filter((item) => results.has(item.id))
            .map((item) => [
              item.id,
              {
                ...results.get(item.id),
                content_source: item.content_source,
              },
            ]),
        );
        semanticClassifier = {
          ...getSemanticClassifierInfo(),
          classified_count: semanticResults.size,
          candidate_count: candidates.length,
        };
      } catch (error) {
        semanticClassifier = {
          ...getSemanticClassifierInfo(),
          error: error.message,
        };
      }
    }
  }

  const plan = buildMovePlan(
    accountId,
    scannedItems,
    parentNodeToken,
    existingCategories,
    { recursive, includeContainers },
    semanticResults,
  );

  return {
    space_id: space.space_id,
    space_name: space.name,
    space_type: space.space_type || null,
    parent_node_token: parentNodeToken || null,
    recursive,
    include_containers: includeContainers,
    scanned_total: scannedItems.length,
    movable_total: plan.moves.length,
    semantic_classifier: semanticClassifier,
    target_folders: plan.targetFolders,
    moves: plan.moves,
    available_spaces: spaces.map((item) => ({
      space_id: item.space_id,
      name: item.name,
      space_type: item.space_type || null,
    })),
  };
}

export async function applyWikiOrganization(accessToken, options = {}) {
  const preview = await previewWikiOrganization(accessToken, options);
  const parentNodeToken = preview.parent_node_token || undefined;
  const nodeMap = new Map(preview.target_folders.map((folder) => [folder.name, folder]));
  const createdFolders = [];
  const executedMoves = [];

  for (const folder of preview.target_folders) {
    if (folder.existing) {
      continue;
    }

    const created = await createWikiNode(accessToken, preview.space_id, folder.name, parentNodeToken);
    nodeMap.set(folder.name, {
      ...folder,
      node_token: created.node_token,
      existing: true,
    });
    createdFolders.push(created);
  }

  for (const move of preview.moves) {
    const target = nodeMap.get(move.target_folder_name);
    if (!target?.node_token) {
      executedMoves.push({
        ...move,
        status: "skipped",
        message: "missing_target_node_token",
      });
      continue;
    }

    const result = await moveWikiNode(accessToken, preview.space_id, move.node_token, target.node_token);
    executedMoves.push({
      ...move,
      target_node_token: target.node_token,
      status: "submitted",
      result,
    });
  }

  return {
    ok: true,
    space_id: preview.space_id,
    space_name: preview.space_name,
    parent_node_token: preview.parent_node_token,
    recursive: preview.recursive,
    include_containers: preview.include_containers,
    created_folders: createdFolders,
    moves_submitted: executedMoves.length,
    moves: executedMoves,
  };
}
