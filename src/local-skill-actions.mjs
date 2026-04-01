import { execFile as execFileCb } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  access,
  constants,
  cp,
  mkdir,
  readdir,
  readFile,
  realpath,
} from "node:fs/promises";
import { cleanText } from "./message-intent-utils.mjs";

const execFile = promisify(execFileCb);

const HOME_DIR = os.homedir();
export const LOCAL_SKILL_INSTALL_ROOT = path.join(HOME_DIR, ".codex", "skills");
export const LOCAL_SKILL_DISCOVERY_ROOTS = Object.freeze([
  LOCAL_SKILL_INSTALL_ROOT,
  path.join(HOME_DIR, ".agents", "skills"),
]);
export const SKILL_INSTALLER_ROOT = path.join(HOME_DIR, ".codex", "skills", ".system", "skill-installer");
export const SKILL_INSTALLER_LIST_SCRIPT = path.join(SKILL_INSTALLER_ROOT, "scripts", "list-skills.py");
export const SKILL_INSTALLER_INSTALL_SCRIPT = path.join(SKILL_INSTALLER_ROOT, "scripts", "install-skill-from-github.py");
export const SKILL_INSTALLER_REPO = "openai/skills";
export const SKILL_INSTALLER_CURATED_PATH = "skills/.curated";

const PYTHON_BIN = "python3";
const LOCAL_SKILL_RESULT_LIMIT = 5;
const MIN_MATCH_SCORE = 60;

const SEMANTIC_SKILL_HINTS = Object.freeze([
  Object.freeze({
    patterns: [/多模態|多模|multimodal|vision|圖像|图片|image|影像|modal/iu],
    candidates: Object.freeze(["imagegen"]),
  }),
]);

function normalizeSkillQuery(value = "") {
  return cleanText(value)
    .toLowerCase()
    .replace(/[`"'“”‘’「」『』]/g, " ")
    .replace(/[._/]+/g, "-")
    .replace(/[^a-z0-9\u4e00-\u9fff-]+/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitTokens(value = "") {
  return normalizeSkillQuery(value).split(/\s+/).filter(Boolean);
}

function displayPath(value = "") {
  const normalized = cleanText(value);
  if (!normalized) {
    return "";
  }
  return normalized.startsWith(HOME_DIR)
    ? `~${normalized.slice(HOME_DIR.length)}`
    : normalized;
}

async function pathExists(targetPath = "") {
  try {
    await access(targetPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function safeRealpath(targetPath = "") {
  try {
    return await realpath(targetPath);
  } catch {
    return null;
  }
}

async function readSkillSummary(skillFilePath = "") {
  try {
    const raw = await readFile(skillFilePath, "utf8");
    const lines = String(raw || "")
      .split(/\r?\n/)
      .map((line) => cleanText(line.replace(/^#+\s*/, "")))
      .filter(Boolean);
    return cleanText(lines.find((line) => !/^skill$/i.test(line)) || "").slice(0, 180);
  } catch {
    return "";
  }
}

function buildSkillActionBoundaryLimitations({
  discoveryRoots = LOCAL_SKILL_DISCOVERY_ROOTS,
  installRoot = LOCAL_SKILL_INSTALL_ROOT,
  extra = [],
} = {}) {
  return [
    `目前只使用受控 skill 來源：本機目錄 ${discoveryRoots.map((item) => `\`${displayPath(item)}\``).join("、")}，以及 curated remote catalog \`${SKILL_INSTALLER_REPO}/${SKILL_INSTALLER_CURATED_PATH}\`。`,
    `安裝只會寫入 \`${displayPath(installRoot)}\`，不會打開任意 shell、任意路徑寫入或 package manager 安裝。`,
    ...extra.filter(Boolean),
  ];
}

function buildActionReply({
  answer = "",
  sources = [],
  limitations = [],
} = {}) {
  return {
    answer: cleanText(answer),
    sources: (Array.isArray(sources) ? sources : []).map((item) => cleanText(item)).filter(Boolean),
    limitations: (Array.isArray(limitations) ? limitations : []).map((item) => cleanText(item)).filter(Boolean),
  };
}

function normalizeRemoteSkillEntries(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      const name = cleanText(item?.name);
      if (!name) {
        return null;
      }
      return {
        name,
        installed: item?.installed === true,
        source: "remote_curated",
        remote_repo: SKILL_INSTALLER_REPO,
        remote_path: `${SKILL_INSTALLER_CURATED_PATH}/${name}`,
        summary: cleanText(item?.summary || "") || null,
      };
    })
    .filter(Boolean);
}

function scoreSemanticHint(entry = {}, query = "") {
  if (!cleanText(entry?.name) || !query) {
    return 0;
  }
  for (const hint of SEMANTIC_SKILL_HINTS) {
    if (!hint.patterns.some((pattern) => pattern.test(query))) {
      continue;
    }
    if ((hint.candidates || []).includes(cleanText(entry.name))) {
      return 65;
    }
  }
  return 0;
}

function scoreSkillMatch(entry = {}, query = "") {
  const normalizedQuery = normalizeSkillQuery(query);
  const normalizedName = normalizeSkillQuery(entry.name || "");
  const summary = normalizeSkillQuery(entry.summary || "");
  const queryTokens = splitTokens(normalizedQuery);

  if (!normalizedQuery) {
    return 0;
  }
  if (normalizedName === normalizedQuery) {
    return 120;
  }
  if (normalizedName.startsWith(normalizedQuery)) {
    return 100;
  }
  if (normalizedName.includes(normalizedQuery)) {
    return 90;
  }
  if (queryTokens.length > 0 && queryTokens.every((token) => normalizedName.includes(token))) {
    return 80;
  }
  if (summary.includes(normalizedQuery)) {
    return 70;
  }
  if (queryTokens.length > 0 && queryTokens.every((token) => summary.includes(token))) {
    return 60;
  }
  return scoreSemanticHint(entry, query);
}

function rankSkillMatches(catalog = [], query = "") {
  return (Array.isArray(catalog) ? catalog : [])
    .map((entry) => ({
      ...entry,
      match_score: scoreSkillMatch(entry, query),
    }))
    .filter((entry) => entry.match_score >= MIN_MATCH_SCORE)
    .sort((left, right) => (
      right.match_score - left.match_score
      || Number(right.installed) - Number(left.installed)
      || left.name.localeCompare(right.name)
    ));
}

function buildMatchLabel(entry = {}) {
  if (entry.source === "remote_curated") {
    return `\`${entry.name}\`${entry.installed ? "（已安裝）" : "（可安裝）"}：${entry.remote_repo}/${entry.remote_path}`;
  }
  return `\`${entry.name}\`${entry.installed ? "（已安裝）" : "（可安裝）"}：${displayPath(entry.path)}`;
}

function selectSingleSkillMatch(matches = []) {
  if (!Array.isArray(matches) || matches.length === 0) {
    return {
      ok: false,
      error: "not_found",
      match: null,
    };
  }

  const [top, next] = matches;
  if (next && next.match_score === top.match_score && normalizeSkillQuery(next.name) !== normalizeSkillQuery(top.name)) {
    return {
      ok: false,
      error: "ambiguous_match",
      match: null,
      candidates: matches.slice(0, 3),
    };
  }

  return {
    ok: true,
    error: null,
    match: top,
  };
}

async function runInstallerCommand(args = [], {
  commandRunner = execFile,
  cwd = SKILL_INSTALLER_ROOT,
} = {}) {
  const { stdout } = await commandRunner(PYTHON_BIN, args, {
    cwd,
    env: process.env,
    maxBuffer: 1024 * 1024 * 8,
  });
  return String(stdout || "");
}

export async function listRemoteInstallableSkills({
  commandRunner = execFile,
} = {}) {
  if (!(await pathExists(SKILL_INSTALLER_LIST_SCRIPT))) {
    return {
      ok: false,
      error: "installer_unavailable",
      items: [],
    };
  }

  try {
    const raw = await runInstallerCommand([SKILL_INSTALLER_LIST_SCRIPT, "--format", "json"], {
      commandRunner,
    });
    return {
      ok: true,
      error: null,
      items: normalizeRemoteSkillEntries(JSON.parse(raw)),
    };
  } catch {
    return {
      ok: false,
      error: "remote_catalog_unavailable",
      items: [],
    };
  }
}

async function installRemoteCuratedSkill({
  skillName = "",
  commandRunner = execFile,
} = {}) {
  if (!(await pathExists(SKILL_INSTALLER_INSTALL_SCRIPT))) {
    return {
      ok: false,
      error: "installer_unavailable",
    };
  }

  try {
    await runInstallerCommand([
      SKILL_INSTALLER_INSTALL_SCRIPT,
      "--repo",
      SKILL_INSTALLER_REPO,
      "--path",
      `${SKILL_INSTALLER_CURATED_PATH}/${skillName}`,
    ], {
      commandRunner,
    });
    return {
      ok: true,
      error: null,
    };
  } catch {
    return {
      ok: false,
      error: "remote_install_failed",
    };
  }
}

export async function discoverLocalSkills({
  discoveryRoots = LOCAL_SKILL_DISCOVERY_ROOTS,
  installRoot = LOCAL_SKILL_INSTALL_ROOT,
} = {}) {
  const roots = Array.isArray(discoveryRoots)
    ? [...new Set(discoveryRoots.map((item) => cleanText(item)).filter(Boolean))]
    : [];
  const installRootRealpath = await safeRealpath(installRoot);
  const catalog = [];

  for (const rootPath of roots) {
    if (!(await pathExists(rootPath))) {
      continue;
    }
    const rootRealpath = await safeRealpath(rootPath);
    let entries = [];
    try {
      entries = await readdir(rootPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry?.isDirectory?.()) {
        continue;
      }

      const skillPath = path.join(rootPath, entry.name);
      const skillFile = path.join(skillPath, "SKILL.md");
      if (!(await pathExists(skillFile))) {
        continue;
      }

      const skillRealpath = await safeRealpath(skillPath);
      const installed = Boolean(
        installRootRealpath
        && skillRealpath
        && (skillRealpath === installRootRealpath || skillRealpath.startsWith(`${installRootRealpath}${path.sep}`))
      );
      catalog.push({
        name: cleanText(entry.name),
        path: skillPath,
        realpath: skillRealpath,
        skill_file: skillFile,
        root_path: rootPath,
        root_realpath: rootRealpath,
        installed,
        source: "local",
        summary: await readSkillSummary(skillFile),
      });
    }
  }

  return catalog.sort((left, right) => (
    Number(right.installed) - Number(left.installed)
    || left.name.localeCompare(right.name)
  ));
}

function buildSuggestionLines(matches = []) {
  return (Array.isArray(matches) ? matches : [])
    .slice(0, 3)
    .map((entry) => `${buildMatchLabel(entry)}${entry.match_score <= 60 ? "；屬於接近候選，不是同名 skill" : ""}`);
}

export async function findLocalSkill({
  query = "",
  discoveryRoots = LOCAL_SKILL_DISCOVERY_ROOTS,
  installRoot = LOCAL_SKILL_INSTALL_ROOT,
  remoteCatalogProvider = listRemoteInstallableSkills,
} = {}) {
  const normalizedQuery = cleanText(query);
  const localCatalog = await discoverLocalSkills({ discoveryRoots, installRoot });
  const remoteCatalogResult = await remoteCatalogProvider();
  const remoteCatalog = remoteCatalogResult?.ok === true
    ? normalizeRemoteSkillEntries(remoteCatalogResult.items)
    : [];
  const matches = rankSkillMatches([...localCatalog, ...remoteCatalog], normalizedQuery).slice(0, LOCAL_SKILL_RESULT_LIMIT);

  const answer = matches.length > 0
    ? `我找到 ${matches.length} 個和「${normalizedQuery || "本機 skill"}」相關的受控 skill 候選。`
    : `我有查本機與 curated remote skill 來源，但沒找到和「${normalizedQuery || "本機 skill"}」對得上的受控 skill。`;
  const sources = matches.length > 0
    ? matches.map((entry) => (
      `${buildMatchLabel(entry)}${entry.summary ? `；摘要：${entry.summary}` : ""}`
    ))
    : [
      `已搜尋本機目錄：${discoveryRoots.map((item) => displayPath(item)).join("、")}`,
      remoteCatalogResult?.ok === true
        ? `已搜尋 curated remote catalog：${SKILL_INSTALLER_REPO}/${SKILL_INSTALLER_CURATED_PATH}`
        : "curated remote catalog 目前無法讀取",
    ];

  return {
    ok: true,
    action: "find_local_skill",
    public_reply: buildActionReply({
      answer,
      sources,
      limitations: buildSkillActionBoundaryLimitations({
        discoveryRoots,
        installRoot,
        extra: remoteCatalogResult?.ok === true
          ? []
          : ["這次無法讀取 curated remote catalog，所以結果只保證已檢查本機來源。"],
      }),
    }),
  };
}

export async function verifyLocalSkill({
  query = "",
  discoveryRoots = LOCAL_SKILL_DISCOVERY_ROOTS,
  installRoot = LOCAL_SKILL_INSTALL_ROOT,
} = {}) {
  const catalog = await discoverLocalSkills({ discoveryRoots, installRoot });
  const matches = rankSkillMatches(catalog, query);
  const selection = selectSingleSkillMatch(matches);

  if (!selection.ok) {
    if (selection.error === "ambiguous_match") {
      return {
        ok: true,
        action: "verify_local_skill",
        public_reply: buildActionReply({
          answer: `已完成檢查，但「${cleanText(query)}」目前對應到多個相近的本機 skill，還不能唯一驗證。`,
          sources: [
            `候選 skill：${(selection.candidates || []).map((entry) => `\`${entry.name}\``).join("、")}`,
          ],
          limitations: buildSkillActionBoundaryLimitations({
            discoveryRoots,
            installRoot,
            extra: ["如果你要我直接驗證，請再補完整 skill 名稱。", "這次只驗證本機 skill 目錄與 `SKILL.md` 是否存在，未執行 skill 內容。"],
          }),
        }),
      };
    }

    return {
      ok: true,
      action: "verify_local_skill",
      public_reply: buildActionReply({
        answer: `沒找到「${cleanText(query)}」這個本機 skill。`,
        sources: [
          `已搜尋受控本機目錄：${discoveryRoots.map((item) => displayPath(item)).join("、")}`,
        ],
        limitations: buildSkillActionBoundaryLimitations({
          discoveryRoots,
          installRoot,
          extra: ["這次只驗證本機 skill 目錄與 `SKILL.md` 是否存在，未執行 skill 內容。"],
        }),
      }),
    };
  }

  const match = selection.match;
  const answer = match.installed
    ? `已驗證「${match.name}」目前已安裝。`
    : `已驗證「${match.name}」目前可找到來源，但還沒安裝到 \`${displayPath(installRoot)}\`。`;
  const sources = [
    `命中 skill：${buildMatchLabel(match)}`,
    `驗證依據：已找到 \`${displayPath(match.skill_file)}\``,
  ];

  return {
    ok: true,
    action: "verify_local_skill",
    public_reply: buildActionReply({
      answer,
      sources,
      limitations: buildSkillActionBoundaryLimitations({
        discoveryRoots,
        installRoot,
        extra: ["這次只驗證本機 skill 目錄與 `SKILL.md` 是否存在，未執行 skill 內容。"],
      }),
    }),
  };
}

async function installFromLocalSource({
  sourceMatch = null,
  discoveryRoots = LOCAL_SKILL_DISCOVERY_ROOTS,
  installRoot = LOCAL_SKILL_INSTALL_ROOT,
} = {}) {
  const destinationPath = path.join(installRoot, sourceMatch.name);
  const destinationSkillFile = path.join(destinationPath, "SKILL.md");

  try {
    await mkdir(installRoot, { recursive: true });
    if (await pathExists(destinationPath)) {
      return {
        ok: false,
        action: "install_local_skill",
        public_reply: buildActionReply({
          answer: `沒能安裝「${sourceMatch.name}」。失敗在寫入安裝目錄這一步。`,
          sources: [
            `目標目錄已存在：${displayPath(destinationPath)}`,
          ],
          limitations: buildSkillActionBoundaryLimitations({
            discoveryRoots,
            installRoot,
            extra: ["目前最小版本不會覆寫既有 skill 目錄。"],
          }),
        }),
      };
    }

    await cp(sourceMatch.path, destinationPath, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });

    if (!(await pathExists(destinationSkillFile))) {
      return {
        ok: false,
        action: "install_local_skill",
        public_reply: buildActionReply({
          answer: `沒能安裝「${sourceMatch.name}」。失敗在安裝後驗證這一步。`,
          sources: [
            `來源：${displayPath(sourceMatch.path)}`,
            `安裝目標：${displayPath(destinationPath)}`,
            "結果：安裝後沒有找到 `SKILL.md`。",
          ],
          limitations: buildSkillActionBoundaryLimitations({
            discoveryRoots,
            installRoot,
          }),
        }),
      };
    }

    return {
      ok: true,
      action: "install_local_skill",
      public_reply: buildActionReply({
        answer: `已安裝本機 skill「${sourceMatch.name}」。`,
        sources: [
          `來源：${displayPath(sourceMatch.path)}`,
          `安裝位置：${displayPath(destinationPath)}`,
          `驗證依據：已找到 \`${displayPath(destinationSkillFile)}\``,
        ],
        limitations: buildSkillActionBoundaryLimitations({
          discoveryRoots,
          installRoot,
        }),
      }),
    };
  } catch {
    return {
      ok: false,
      action: "install_local_skill",
      public_reply: buildActionReply({
        answer: `沒能安裝「${sourceMatch.name}」。失敗在複製到安裝目錄這一步。`,
        sources: [
          `來源：${displayPath(sourceMatch.path)}`,
          `安裝目標：${displayPath(destinationPath)}`,
        ],
        limitations: buildSkillActionBoundaryLimitations({
          discoveryRoots,
          installRoot,
          extra: ["這次已隱藏內部例外細節，只保留對外可讀的失敗說明。"],
        }),
      }),
    };
  }
}

export async function installLocalSkill({
  query = "",
  discoveryRoots = LOCAL_SKILL_DISCOVERY_ROOTS,
  installRoot = LOCAL_SKILL_INSTALL_ROOT,
  remoteCatalogProvider = listRemoteInstallableSkills,
  remoteInstaller = installRemoteCuratedSkill,
} = {}) {
  const normalizedQuery = cleanText(query);
  const localCatalog = await discoverLocalSkills({ discoveryRoots, installRoot });
  const installedMatches = rankSkillMatches(localCatalog.filter((entry) => entry.installed), normalizedQuery);
  const installedSelection = selectSingleSkillMatch(installedMatches);

  if (installedSelection.ok) {
    const installedMatch = installedSelection.match;
    return {
      ok: true,
      action: "install_local_skill",
      public_reply: buildActionReply({
        answer: `「${installedMatch.name}」已經在本機安裝，不需要重複安裝。`,
        sources: [
          `安裝位置：${displayPath(installedMatch.path)}`,
          `驗證依據：已找到 \`${displayPath(installedMatch.skill_file)}\``,
        ],
        limitations: buildSkillActionBoundaryLimitations({
          discoveryRoots,
          installRoot,
        }),
      }),
    };
  }

  const localSourceMatches = rankSkillMatches(localCatalog.filter((entry) => entry.installed !== true), normalizedQuery);
  const localSourceSelection = selectSingleSkillMatch(localSourceMatches);
  if (localSourceSelection.ok) {
    return installFromLocalSource({
      sourceMatch: localSourceSelection.match,
      discoveryRoots,
      installRoot,
    });
  }

  const remoteCatalogResult = await remoteCatalogProvider();
  const remoteCatalog = remoteCatalogResult?.ok === true
    ? normalizeRemoteSkillEntries(remoteCatalogResult.items)
    : [];
  const remoteMatches = rankSkillMatches(remoteCatalog.filter((entry) => entry.installed !== true), normalizedQuery);
  const remoteSelection = selectSingleSkillMatch(remoteMatches);

  if (remoteSelection.ok) {
    const remoteMatch = remoteSelection.match;
    if (Number(remoteMatch?.match_score || 0) < 80) {
      const suggestions = buildSuggestionLines([remoteMatch]);
      return {
        ok: false,
        action: "install_local_skill",
        public_reply: buildActionReply({
          answer: `我有先幫你找可安裝 skill，但「${normalizedQuery}」目前只命中語意相近候選，還不會直接自動安裝。`,
          sources: [
            `已搜尋 curated remote catalog：${SKILL_INSTALLER_REPO}/${SKILL_INSTALLER_CURATED_PATH}`,
            ...(suggestions.length > 0 ? [`最接近的候選：${suggestions.join("；")}`] : []),
          ],
          limitations: buildSkillActionBoundaryLimitations({
            discoveryRoots,
            installRoot,
            extra: ["如果你要我直接安裝，請給我更接近實際 skill 名稱的關鍵字。"],
          }),
        }),
      };
    }
    const installResult = await remoteInstaller({
      skillName: remoteMatch.name,
    });
    if (installResult?.ok !== true) {
      return {
        ok: false,
        action: "install_local_skill",
        public_reply: buildActionReply({
          answer: `沒能安裝「${remoteMatch.name}」。失敗在執行 curated remote installer 這一步。`,
          sources: [
            `安裝來源：${remoteMatch.remote_repo}/${remoteMatch.remote_path}`,
          ],
          limitations: buildSkillActionBoundaryLimitations({
            discoveryRoots,
            installRoot,
            extra: ["這次已隱藏內部例外細節，只保留對外可讀的失敗說明。"],
          }),
        }),
      };
    }

    const destinationSkillFile = path.join(installRoot, remoteMatch.name, "SKILL.md");
    if (!(await pathExists(destinationSkillFile))) {
      return {
        ok: false,
        action: "install_local_skill",
        public_reply: buildActionReply({
          answer: `沒能安裝「${remoteMatch.name}」。失敗在安裝後驗證這一步。`,
          sources: [
            `安裝來源：${remoteMatch.remote_repo}/${remoteMatch.remote_path}`,
            `安裝目標：${displayPath(path.join(installRoot, remoteMatch.name))}`,
          ],
          limitations: buildSkillActionBoundaryLimitations({
            discoveryRoots,
            installRoot,
          }),
        }),
      };
    }

    return {
      ok: true,
      action: "install_local_skill",
      public_reply: buildActionReply({
        answer: `已從 curated remote catalog 安裝 skill「${remoteMatch.name}」。`,
        sources: [
          `安裝來源：${remoteMatch.remote_repo}/${remoteMatch.remote_path}`,
          `安裝位置：${displayPath(path.join(installRoot, remoteMatch.name))}`,
          `驗證依據：已找到 \`${displayPath(destinationSkillFile)}\``,
        ],
        limitations: buildSkillActionBoundaryLimitations({
          discoveryRoots,
          installRoot,
          extra: ["如果要立即在 Codex 內使用，通常還需要重新載入或重啟對應 runtime。"],
        }),
      }),
    };
  }

  const suggestions = buildSuggestionLines(rankSkillMatches([...localCatalog, ...remoteCatalog], normalizedQuery));
  const sources = [
    `已搜尋本機來源：${discoveryRoots.map((item) => displayPath(item)).join("、")}`,
    remoteCatalogResult?.ok === true
      ? `已搜尋 curated remote catalog：${SKILL_INSTALLER_REPO}/${SKILL_INSTALLER_CURATED_PATH}`
      : "curated remote catalog 目前無法讀取",
    ...(suggestions.length > 0
      ? [`最接近的候選：${suggestions.join("；")}`]
      : []),
  ];

  return {
    ok: false,
    action: "install_local_skill",
    public_reply: buildActionReply({
      answer: `沒能安裝「${normalizedQuery}」。失敗在查找可安裝 skill 這一步。`,
      sources,
      limitations: buildSkillActionBoundaryLimitations({
        discoveryRoots,
        installRoot,
        extra: [
          remoteCatalogResult?.ok === true
            ? "如果你要我直接安裝，最好給我更接近實際 skill 名稱的關鍵字。"
            : "這次無法讀取 curated remote catalog，所以結果只保證已檢查本機來源。",
        ],
      }),
    }),
  };
}

export async function executeLocalSkillTask({
  intent = "",
  query = "",
  discoveryRoots = LOCAL_SKILL_DISCOVERY_ROOTS,
  installRoot = LOCAL_SKILL_INSTALL_ROOT,
  remoteCatalogProvider = listRemoteInstallableSkills,
  remoteInstaller = installRemoteCuratedSkill,
} = {}) {
  const normalizedIntent = cleanText(intent);
  if (normalizedIntent === "skill_find_request") {
    return findLocalSkill({ query, discoveryRoots, installRoot, remoteCatalogProvider });
  }
  if (normalizedIntent === "skill_install_request") {
    return installLocalSkill({
      query,
      discoveryRoots,
      installRoot,
      remoteCatalogProvider,
      remoteInstaller,
    });
  }
  if (normalizedIntent === "skill_verify_request") {
    return verifyLocalSkill({ query, discoveryRoots, installRoot });
  }

  return {
    ok: false,
    action: null,
    public_reply: buildActionReply({
      answer: "這次沒有命中受控的 skill 任務。",
      sources: [],
      limitations: buildSkillActionBoundaryLimitations({
        discoveryRoots,
        installRoot,
      }),
    }),
  };
}
