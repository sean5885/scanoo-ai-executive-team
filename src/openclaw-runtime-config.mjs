import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { llmModel } from "./config.mjs";

const DEFAULT_OPENCLAW_CONFIG_PATH = path.join(os.homedir(), ".openclaw", "openclaw.json");
const RUNTIME_DIR = path.resolve(process.cwd(), ".data/openclaw-runtime");
const RUNTIME_CONFIG_PATH = path.join(RUNTIME_DIR, "openclaw.json");

let cachedRuntimeEnv = null;
let cachedSourceSignature = null;

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function statSignature(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "missing";
  }
}

function cloneJson(value) {
  return value == null ? null : JSON.parse(JSON.stringify(value));
}

function buildProviderQualifiedModelId(providerName = "", modelId = "") {
  const normalizedProviderName = String(providerName || "").trim();
  const normalizedModelId = String(modelId || "").trim();
  if (!normalizedProviderName || !normalizedModelId) {
    return "";
  }
  return `${normalizedProviderName}/${normalizedModelId}`;
}

function normalizeModelId(modelId = "", fallbackProviderName = "") {
  const normalized = String(modelId || "").trim();
  if (normalized) {
    return normalized;
  }
  const providerQualifiedFallback = buildProviderQualifiedModelId(fallbackProviderName, llmModel);
  return providerQualifiedFallback || llmModel;
}

function resolvePreferredProviderQualifiedModelId(config = {}) {
  const providers = config?.models?.providers && typeof config.models.providers === "object"
    ? config.models.providers
    : {};

  for (const [providerName, providerConfig] of Object.entries(providers)) {
    const providerModels = Array.isArray(providerConfig?.models) ? providerConfig.models : [];
    if (providerModels.some((item) => String(item?.id || "").trim() === llmModel)) {
      return buildProviderQualifiedModelId(providerName, llmModel);
    }
  }

  const currentPrimary = String(config?.agents?.defaults?.model?.primary || "").trim();
  const currentProviderName = currentPrimary.includes("/") ? currentPrimary.split("/")[0] : "";
  return normalizeModelId(currentPrimary, currentProviderName);
}

function forcePrimaryAgentModel(config = {}) {
  const next = cloneJson(config) || {};
  const targetModelId = resolvePreferredProviderQualifiedModelId(next);

  next.agents = next.agents && typeof next.agents === "object" ? next.agents : {};
  next.agents.defaults = next.agents.defaults && typeof next.agents.defaults === "object"
    ? next.agents.defaults
    : {};
  next.agents.defaults.model = {
    ...(next.agents.defaults.model && typeof next.agents.defaults.model === "object"
      ? next.agents.defaults.model
      : {}),
    primary: targetModelId,
  };

  if (Array.isArray(next.agents.list)) {
    next.agents.list = next.agents.list.map((agent) => ({
      ...agent,
      model: targetModelId,
      ...(agent?.tools && typeof agent.tools === "object" && Array.isArray(agent.tools.alsoAllow)
        ? {
            tools: {
              ...agent.tools,
              alsoAllow: agent.tools.alsoAllow.filter((item) => !String(item || "").startsWith("feishu_")),
            },
          }
        : {}),
    }));
  }

  return next;
}

export function sanitizeOpenClawRuntimeConfig(config = {}) {
  const next = forcePrimaryAgentModel(config);
  delete next.channels;

  if (next.tools && typeof next.tools === "object") {
    if (Array.isArray(next.tools.alsoAllow)) {
      next.tools.alsoAllow = next.tools.alsoAllow.filter((item) => !String(item || "").startsWith("feishu_"));
    }
    if (next.tools.media && typeof next.tools.media === "object") {
      next.tools.media = cloneJson(next.tools.media);
    }
  }

  if (next.plugins && typeof next.plugins === "object") {
    next.plugins = { ...next.plugins };
    if (Array.isArray(next.plugins.allow)) {
      next.plugins.allow = next.plugins.allow.filter((item) => String(item || "").trim() !== "feishu");
    }
    if (next.plugins.entries && typeof next.plugins.entries === "object") {
      const entries = { ...next.plugins.entries };
      delete entries.feishu;
      next.plugins.entries = entries;
    }
  }

  return next;
}

function buildRuntimeConfigEnv(sourcePath) {
  const config = readJsonFile(sourcePath);
  if (!config) {
    return null;
  }
  const sanitized = sanitizeOpenClawRuntimeConfig(config);
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.writeFileSync(RUNTIME_CONFIG_PATH, JSON.stringify(sanitized, null, 2));
  return {
    ...process.env,
    OPENCLAW_CONFIG_PATH: RUNTIME_CONFIG_PATH,
  };
}

export function getOpenClawExecutionEnv() {
  const sourcePath = process.env.OPENCLAW_CONFIG_PATH || DEFAULT_OPENCLAW_CONFIG_PATH;
  const sourceSignature = `${sourcePath}:${statSignature(sourcePath)}`;
  if (cachedRuntimeEnv && cachedSourceSignature === sourceSignature) {
    return cachedRuntimeEnv;
  }
  const runtimeEnv = buildRuntimeConfigEnv(sourcePath);
  cachedRuntimeEnv = runtimeEnv || process.env;
  cachedSourceSignature = sourceSignature;
  return cachedRuntimeEnv;
}
