import "dotenv/config";
import * as Lark from "@larksuiteoapi/node-sdk";
import os from "node:os";
import path from "node:path";

const requiredEnv = ["LARK_APP_ID", "LARK_APP_SECRET"];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

export function resolveDomain(value) {
  if (!value) {
    return Lark.Domain.Lark;
  }

  const normalized = value.toLowerCase();
  if (normalized === "lark") {
    return Lark.Domain.Lark;
  }
  if (normalized === "feishu") {
    throw new Error('This project is Lark-only. Set LARK_DOMAIN="lark", not "feishu".');
  }
  return value;
}

export function resolveDomainUrl(value) {
  const domain = resolveDomain(value);

  if (typeof domain === "string" && domain.startsWith("http")) {
    return domain.replace(/\/$/, "");
  }

  if (domain === Lark.Domain.Lark) {
    return "https://open.larksuite.com";
  }

  return String(domain).replace(/\/$/, "");
}

export const baseConfig = {
  appId: process.env.LARK_APP_ID,
  appSecret: process.env.LARK_APP_SECRET,
  domain: resolveDomain(process.env.LARK_DOMAIN),
  appType: Lark.AppType.SelfBuild,
};

export const botName = process.env.BOT_NAME || "龙虾";
export const apiBaseUrl = resolveDomainUrl(process.env.LARK_DOMAIN);
export const oauthPort = Number.parseInt(process.env.LARK_OAUTH_PORT || "3333", 10);
export const oauthBaseUrl =
  process.env.LARK_OAUTH_BASE_URL || `http://localhost:${oauthPort}`;
export const oauthCallbackPath =
  process.env.LARK_OAUTH_CALLBACK_PATH || "/oauth/lark/callback";
export const oauthRedirectUri = new URL(oauthCallbackPath, oauthBaseUrl).toString();
export const meetingConfirmPath =
  process.env.MEETING_CONFIRM_PATH || "/meeting/confirm";
export const oauthScopes =
  process.env.LARK_OAUTH_SCOPES ||
  "offline_access drive:drive docs:document.content:read docx:document:create docx:document:readonly docx:document:write_only wiki:wiki:readonly im:message:send_as_bot im:message:readonly im:chat im:message.group_msg im:message.p2p_msg:readonly";
export const tokenEncryptionSecret = process.env.LARK_TOKEN_ENCRYPTION_SECRET || "";
export const oauthAuthorizeUrl = `${apiBaseUrl}/open-apis/authen/v1/authorize`;
export const oauthTokenStorePath =
  process.env.LARK_OAUTH_TOKEN_STORE ||
  path.resolve(process.cwd(), ".data/lark-user-token.json");
export const sessionScopeStorePath =
  process.env.LARK_SESSION_SCOPE_STORE ||
  path.resolve(process.cwd(), ".data/lark-session-scopes.json");
export const docUpdateConfirmationStorePath =
  process.env.LARK_DOC_UPDATE_CONFIRMATION_STORE ||
  path.resolve(process.cwd(), ".data/doc-update-confirmations.json");
export const docCommentWatchStorePath =
  process.env.LARK_DOC_COMMENT_WATCH_STORE ||
  path.resolve(process.cwd(), ".data/doc-comment-watch.json");
export const docCommentSuggestionPollEnabled =
  String(process.env.LARK_COMMENT_SUGGESTION_POLL_ENABLED || "").toLowerCase() === "true";
export const docCommentSuggestionPollIntervalSeconds = Number.parseInt(
  process.env.LARK_COMMENT_SUGGESTION_POLL_INTERVAL_SECONDS || "300",
  10,
);
export const docCommentSuggestionWatchesPath =
  process.env.LARK_COMMENT_SUGGESTION_WATCHES ||
  path.resolve(process.cwd(), ".data/doc-comment-suggestion-watches.json");
export const agentWorkflowCheckpointStorePath =
  process.env.AGENT_WORKFLOW_CHECKPOINT_STORE ||
  path.resolve(process.cwd(), ".data/agent-workflow-checkpoints.json");
export const ragDbPath =
  process.env.RAG_SQLITE_PATH || path.resolve(process.cwd(), ".data/lark-rag.sqlite");
export const chunkTargetSize = Number.parseInt(process.env.RAG_CHUNK_TARGET_SIZE || "1000", 10);
export const chunkOverlapSize = Number.parseInt(process.env.RAG_CHUNK_OVERLAP || "180", 10);
export const searchTopK = Number.parseInt(process.env.RAG_SEARCH_TOP_K || "6", 10);
export const llmBaseUrl =
  (process.env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
export const llmApiKey = process.env.LLM_API_KEY || "";
export const llmModel = process.env.LLM_MODEL || "gpt-4o-mini";
export const answerMaxContextChars = Number.parseInt(
  process.env.RAG_ANSWER_MAX_CONTEXT_CHARS || "12000",
  10,
);
export const answerPromptMaxTokens = Number.parseInt(process.env.RAG_ANSWER_PROMPT_MAX_TOKENS || "1800", 10);
export const answerRetrievedMaxTokens = Number.parseInt(process.env.RAG_ANSWER_RETRIEVED_MAX_TOKENS || "950", 10);
export const answerCheckpointMaxTokens = Number.parseInt(process.env.RAG_ANSWER_CHECKPOINT_MAX_TOKENS || "240", 10);
export const answerSnippetMaxChars = Number.parseInt(process.env.RAG_ANSWER_SNIPPET_MAX_CHARS || "280", 10);
export const embeddingDimensions = Number.parseInt(process.env.RAG_EMBEDDING_DIMENSIONS || "128", 10);
export const embeddingSearchTopK = Number.parseInt(process.env.RAG_EMBEDDING_TOP_K || "8", 10);
export const agentPromptLightRatio = Number.parseFloat(process.env.AGENT_PROMPT_LIGHT_RATIO || "0.60");
export const agentPromptRollingRatio = Number.parseFloat(process.env.AGENT_PROMPT_ROLLING_RATIO || "0.75");
export const agentPromptEmergencyRatio = Number.parseFloat(process.env.AGENT_PROMPT_EMERGENCY_RATIO || "0.85");
export const docRewritePromptMaxTokens = Number.parseInt(process.env.DOC_REWRITE_PROMPT_MAX_TOKENS || "2400", 10);
export const docRewriteDocumentMaxChars = Number.parseInt(process.env.DOC_REWRITE_DOCUMENT_MAX_CHARS || "3600", 10);
export const docRewriteCommentMaxChars = Number.parseInt(process.env.DOC_REWRITE_COMMENT_MAX_CHARS || "1800", 10);
export const semanticClassifierPromptMaxTokens = Number.parseInt(process.env.SEMANTIC_CLASSIFIER_PROMPT_MAX_TOKENS || "2200", 10);
export const openClawToolOutputMaxChars = Number.parseInt(process.env.OPENCLAW_TOOL_OUTPUT_MAX_CHARS || "2400", 10);
export const meetingPromptMaxTokens = Number.parseInt(process.env.MEETING_PROMPT_MAX_TOKENS || "2200", 10);
export const meetingDefaultChatId = String(process.env.MEETING_GROUP_CHAT_ID || "").trim();
export const meetingDocFolderToken = String(process.env.MEETING_DOC_FOLDER_TOKEN || "").trim();

export const lobsterSecurityProjectRoot =
  process.env.LOBSTER_SECURITY_PROJECT_ROOT || path.resolve(process.cwd(), "lobster_security");
export const lobsterSecurityConfigDir =
  process.env.LOBSTER_SECURITY_CONFIG_DIR || path.resolve(lobsterSecurityProjectRoot, "config");
export const lobsterSecurityPythonBin = process.env.LOBSTER_SECURITY_PYTHON || "python3";
export const lobsterSecurityApprovalMode =
  process.env.LOBSTER_SECURITY_APPROVAL_MODE || "strict";
export const lobsterSecurityExpectedVersion =
  process.env.LOBSTER_SECURITY_EXPECTED_VERSION || "0.1.0";
export const lobsterSecurityStateRoot =
  process.env.LOBSTER_SECURITY_STATE_ROOT || path.resolve(process.cwd(), ".data/lobster-security");
export const lobsterSecurityApprovalStorePath = path.resolve(
  lobsterSecurityStateRoot,
  "approval-decisions.json",
);
export const lobsterSecurityPendingStorePath = path.resolve(
  lobsterSecurityStateRoot,
  "pending-approvals.json",
);
export const lobsterSecurityWorkspaceRoot =
  process.env.LOBSTER_WORKSPACE_ROOT || path.join(os.homedir(), "lobster-workspace");
export const lobsterBindingStrategy =
  process.env.LOBSTER_BINDING_STRATEGY || "shared_workspace_per_peer_session";
export const lobsterSharedWorkspaceKey =
  process.env.LOBSTER_SHARED_WORKSPACE_KEY || "workspace:shared-company";
