import db from "./db.mjs";
import { createDriveFolder, listDriveFolder, moveDriveItem } from "./lark-content.mjs";
import { classifyDocumentsSemantically, getSemanticClassifierInfo } from "./lark-drive-semantic-classifier.mjs";
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
    titleKeywords: ["市場", "商業化", "變現", "業務", "廣告", "競品", "招商", "客戶", "商家", "campaign", "sales", "marketing"],
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
  folder: "資料夾",
};

function extractDocTokenFromUrl(url) {
  const text = String(url || "");
  const match = text.match(/\/(?:docx|docs|sheets|base|slides)\/([A-Za-z0-9]+)/);
  return match?.[1] || null;
}

const getDocumentByTokenStmt = db.prepare(`
  SELECT title, raw_text, source_type, file_token, document_id, parent_path
  FROM lark_documents
  WHERE account_id = ?
    AND active = 1
    AND (
      file_token = @token
      OR document_id = @token
      OR external_key = @drive_key
    )
  ORDER BY
    CASE
      WHEN document_id = @token THEN 0
      WHEN file_token = @token THEN 1
      WHEN external_key = @drive_key THEN 2
      ELSE 3
    END,
    updated_at DESC
  LIMIT 1
`);

const getDocumentByTitleStmt = db.prepare(`
  SELECT title, raw_text, source_type, file_token, document_id, parent_path
  FROM lark_documents
  WHERE account_id = ?
    AND active = 1
    AND title = ?
  ORDER BY updated_at DESC
  LIMIT 1
`);

function findDocumentContext(accountId, item) {
  const tokenCandidates = [item.token, extractDocTokenFromUrl(item.url)].filter(Boolean);
  for (const token of tokenCandidates) {
    const row = getDocumentByTokenStmt.get(accountId, {
      token,
      drive_key: `drive:${token}`,
    });
    if (row?.raw_text) {
      return row;
    }
  }

  const byTitle = getDocumentByTitleStmt.get(accountId, item.name || "");
  if (byTitle?.raw_text) {
    return byTitle;
  }

  return null;
}

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
    score: best.score,
    margin,
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

function classifyDriveItem(accountId, item) {
  if (item.type === "folder") {
    return {
      category: "資料夾",
      reason: "type:folder",
      confidence: 1,
      method: "folder",
    };
  }

  const documentContext = findDocumentContext(accountId, item);
  const contentMatch = classifyByContent(item.name || "", documentContext?.raw_text || "");
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

  const titleMatch = classifyByTitle(item.name || "");
  if (titleMatch) {
    return titleMatch;
  }

  const byType = TYPE_FOLDERS[item.type] || "其他";
  return {
    category: byType,
    reason: `type:${item.type || "unknown"}`,
    confidence: 0.35,
    method: "type",
  };
}

function buildSemanticCandidates(accountId, scannedItems, rootFolderToken, options) {
  const candidates = [];

  for (const item of scannedItems) {
    if (item.type === "folder" && !options.includeFolders) {
      continue;
    }

    if (item.type === "folder" && item.parent_token === rootFolderToken) {
      continue;
    }

    const documentContext = findDocumentContext(accountId, item);
    if (!documentContext?.raw_text) {
      continue;
    }

    const heuristic = classifyDriveItem(accountId, item);
    if (heuristic.method === "content" && heuristic.confidence >= 0.8) {
      continue;
    }

    candidates.push({
      id: item.token,
      title: item.name || documentContext.title || "",
      type: item.type || "",
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

async function listAllInFolder(accessToken, folderToken) {
  const files = [];
  let pageToken;
  let hasMore = true;

  while (hasMore) {
    const data = await listDriveFolder(accessToken, folderToken, pageToken);
    files.push(...(data.files || []));
    pageToken = data.page_token;
    hasMore = Boolean(data.has_more && pageToken);
  }

  return files;
}

async function scanFolderTree(accessToken, folderToken, recursive, parentParts = []) {
  const items = [];
  const files = await listAllInFolder(accessToken, folderToken);

  for (const file of files) {
    const pathParts = [...parentParts, file.name];
    items.push({
      ...file,
      parent_path: buildParentPath(parentParts),
      path_parts: pathParts,
    });

    if (recursive && file.type === "folder") {
      const nested = await scanFolderTree(accessToken, file.token, true, pathParts);
      items.push(...nested);
    }
  }

  return items;
}

function indexExistingFolders(items, rootFolderToken) {
  const folders = new Map();
  for (const item of items) {
    if (item.type !== "folder") {
      continue;
    }
    if (item.parent_token !== rootFolderToken) {
      continue;
    }
    folders.set(item.name, item);
  }
  return folders;
}

function buildMovePlan(accountId, scannedItems, rootFolderToken, existingFolders, options, semanticResults = new Map()) {
  const moves = [];
  const targetFolders = new Map();

  for (const item of scannedItems) {
    if (item.parent_token === rootFolderToken && existingFolders.has(item.name)) {
      targetFolders.set(item.name, {
        name: item.name,
        token: item.token,
        existing: true,
      });
    }

    if (item.type === "folder" && !options.includeFolders) {
      continue;
    }

    if (item.type === "folder" && item.parent_token === rootFolderToken) {
      continue;
    }

    const semantic = semanticResults.get(item.token);
    const { category, reason, content_source } = semantic
      ? {
          category: semantic.category,
          reason: `semantic:${semantic.reason || semantic.category}`,
          content_source: semantic.content_source || null,
        }
      : classifyDriveItem(accountId, item);
    const targetFolder = existingFolders.get(category);
    const targetToken = targetFolder?.token || null;

    targetFolders.set(category, {
      name: category,
      token: targetToken,
      existing: Boolean(targetFolder),
    });

    if (item.type === "folder" && item.token === targetToken) {
      continue;
    }

    if (item.parent_token === targetToken) {
      continue;
    }

    if (item.parent_token === rootFolderToken && item.name === category && item.type === "folder") {
      continue;
    }

    moves.push({
      file_token: item.token,
      name: item.name,
      type: item.type,
      source_parent_token: item.parent_token || null,
      source_parent_path: item.parent_path || "/",
      target_folder_name: category,
      target_folder_token: targetToken,
      reason,
      content_source: content_source || null,
      url: item.url || null,
    });
  }

  return {
    targetFolders: [...targetFolders.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-Hant")),
    moves,
  };
}

export async function previewDriveOrganization(accessToken, folderToken, options = {}) {
  const recursive = options.recursive !== false;
  const includeFolders = options.includeFolders === true;
  const accountId = String(options.accountId || "").trim();
  const rootItems = await listAllInFolder(accessToken, folderToken);
  const scannedItems = recursive
    ? await scanFolderTree(accessToken, folderToken, true, [])
    : rootItems.map((item) => ({ ...item, parent_path: "/", path_parts: [item.name] }));
  const existingFolders = indexExistingFolders(rootItems, folderToken);
  let semanticResults = new Map();
  let semanticClassifier = null;

  if (accountId) {
    const candidates = buildSemanticCandidates(accountId, scannedItems, folderToken, { recursive, includeFolders });
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
    folderToken,
    existingFolders,
    { recursive, includeFolders },
    semanticResults,
  );

  return {
    folder_token: folderToken,
    recursive,
    include_folders: includeFolders,
    scanned_total: scannedItems.length,
    movable_total: plan.moves.length,
    semantic_classifier: semanticClassifier,
    target_folders: plan.targetFolders,
    moves: plan.moves,
  };
}

export async function applyDriveOrganization(accessToken, folderToken, options = {}) {
  const preview = await previewDriveOrganization(accessToken, folderToken, options);
  const folderMap = new Map(preview.target_folders.map((folder) => [folder.name, folder]));
  const createdFolders = [];
  const executedMoves = [];

  for (const folder of preview.target_folders) {
    if (folder.existing || folder.name === "資料夾") {
      continue;
    }

    const created = await createDriveFolder(accessToken, folderToken, folder.name);
    folderMap.set(folder.name, {
      ...folder,
      token: created.token,
      existing: true,
    });
    createdFolders.push({
      name: folder.name,
      token: created.token,
      url: created.url,
    });
  }

  for (const move of preview.moves) {
    const targetFolder = folderMap.get(move.target_folder_name);
    if (!targetFolder?.token) {
      executedMoves.push({
        ...move,
        status: "skipped",
        message: "missing_target_folder_token",
      });
      continue;
    }

    const result = await moveDriveItem(accessToken, move.file_token, move.type, targetFolder.token);
    executedMoves.push({
      ...move,
      target_folder_token: targetFolder.token,
      status: "submitted",
      task_id: result.task_id,
    });
  }

  return {
    ok: true,
    folder_token: folderToken,
    recursive: preview.recursive,
    include_folders: preview.include_folders,
    preview_plan: {
      target_folders: preview.target_folders,
      moves: preview.moves,
    },
    created_folders: createdFolders,
    moves_submitted: executedMoves.length,
    moves: executedMoves,
  };
}
