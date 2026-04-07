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

function parseFloatOrDefault(value, fallback) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function isNodeTestRuntime() {
  return process.execArgv.some((arg) => arg === "--test" || arg.startsWith("--test-"));
}

function resolveWriteBudgetStorePath() {
  if (process.env.LARK_WRITE_BUDGET_STORE) {
    return process.env.LARK_WRITE_BUDGET_STORE;
  }
  if (isNodeTestRuntime()) {
    return path.join(os.tmpdir(), `playground-node-test-${process.pid}-lark-write-budget.json`);
  }
  return path.resolve(process.cwd(), ".data/lark-write-budget.json");
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
export const larkWriteBudgetStorePath = resolveWriteBudgetStorePath();
export const larkWriteBudgetWindowMs = Number.parseInt(
  process.env.LARK_WRITE_BUDGET_WINDOW_MS || String(24 * 60 * 60 * 1000),
  10,
);
export const larkWriteBudgetNearRatio = parseFloatOrDefault(
  process.env.LARK_WRITE_BUDGET_NEAR_RATIO || "0.8",
  0.8,
);
export const larkWriteBudgetSoftLimit = Number.parseInt(
  process.env.LARK_WRITE_BUDGET_SOFT_LIMIT || "40",
  10,
);
export const larkWriteBudgetHardLimit = Number.parseInt(
  process.env.LARK_WRITE_BUDGET_HARD_LIMIT || "60",
  10,
);
export const larkWriteBudgetDuplicateWindowMs = Number.parseInt(
  process.env.LARK_WRITE_BUDGET_DUPLICATE_WINDOW_MS || String(30 * 60 * 1000),
  10,
);
export const larkWriteBudgetHardWhitelist = String(process.env.LARK_WRITE_BUDGET_HARD_WHITELIST || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
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
export const executiveTaskStateStorePath =
  process.env.EXECUTIVE_TASK_STATE_STORE ||
  path.resolve(process.cwd(), ".data/executive-task-state.json");
export const executiveSessionMemoryStorePath =
  process.env.EXECUTIVE_SESSION_MEMORY_STORE ||
  path.resolve(process.cwd(), ".data/executive-session-memory.json");
export const executiveApprovedMemoryStorePath =
  process.env.EXECUTIVE_APPROVED_MEMORY_STORE ||
  path.resolve(process.cwd(), ".data/executive-approved-memory.json");
export const executivePendingProposalStorePath =
  process.env.EXECUTIVE_PENDING_PROPOSAL_STORE ||
  path.resolve(process.cwd(), ".data/executive-pending-proposals.json");
export const executiveReflectionStorePath =
  process.env.EXECUTIVE_REFLECTION_STORE ||
  path.resolve(process.cwd(), ".data/executive-reflections.json");
export const executiveImprovementStorePath =
  process.env.EXECUTIVE_IMPROVEMENT_STORE ||
  path.resolve(process.cwd(), ".data/executive-improvements.json");
export const plannerTaskLifecycleV1StorePath =
  process.env.PLANNER_TASK_LIFECYCLE_V1_STORE ||
  path.resolve(process.cwd(), ".data/planner-task-lifecycle-v1.json");
export const ragDbPath =
  process.env.RAG_SQLITE_PATH || path.resolve(process.cwd(), ".data/lark-rag.sqlite");
export const chunkTargetSize = Number.parseInt(process.env.RAG_CHUNK_TARGET_SIZE || "1000", 10);
export const chunkOverlapSize = Number.parseInt(process.env.RAG_CHUNK_OVERLAP || "180", 10);
export const searchTopK = Number.parseInt(process.env.RAG_SEARCH_TOP_K || "6", 10);
export const llmBaseUrl =
  (process.env.LLM_BASE_URL || process.env.OPENAI_API_BASE || process.env.OPENAI_BASE_URL || "https://api2.codexcn.com/v1").replace(/\/$/, "");
export const llmApiKey = process.env.LLM_API_KEY || "";
export const minimaxTextModel =
  String(process.env.MINIMAX_TEXT_MODEL || process.env.LLM_MODEL || "MiniMax-M2.7").trim() || "MiniMax-M2.7";
export const llmModel = minimaxTextModel;
export const llmOpenClawAgentId =
  String(process.env.LLM_OPENCLAW_AGENT || "lobster-backend").trim() || "lobster-backend";
export const llmOpenClawSessionPrefix =
  String(process.env.LLM_OPENCLAW_SESSION_PREFIX || "playground-llm").trim() || "playground-llm";
export const llmOpenClawTimeoutMs = Number.parseInt(process.env.LLM_OPENCLAW_TIMEOUT_MS || "90000", 10);
export const llmTemperature = 0.1;
export const llmTopP = clamp(parseFloatOrDefault(process.env.LLM_TOP_P || "0.75", 0.75), 0.7, 0.8);
export const llmJsonRetryMax = Number.parseInt(process.env.LLM_JSON_RETRY_MAX || "2", 10);
export const imageUnderstandingProvider =
  String(process.env.IMAGE_UNDERSTANDING_PROVIDER || "nano_banana").trim() || "nano_banana";
export const imageUnderstandingBaseUrl =
  (
    process.env.IMAGE_UNDERSTANDING_BASE_URL ||
    (imageUnderstandingProvider === "nano_banana"
      ? "https://generativelanguage.googleapis.com/v1beta"
      : llmBaseUrl)
  ).replace(/\/$/, "");
export const imageUnderstandingApiKey =
  process.env.IMAGE_UNDERSTANDING_API_KEY || process.env.NANO_BANANA_API_KEY || "";
export const imageUnderstandingModel =
  String(process.env.IMAGE_UNDERSTANDING_MODEL || process.env.NANO_BANANA_MODEL || "gemini-2.5-flash-image").trim() ||
  "gemini-2.5-flash-image";
export const imageUnderstandingPromptMaxTokens = Number.parseInt(
  process.env.IMAGE_UNDERSTANDING_PROMPT_MAX_TOKENS || "1200",
  10,
);
export const imageUnderstandingMaxResultChars = Number.parseInt(
  process.env.IMAGE_UNDERSTANDING_MAX_RESULT_CHARS || "420",
  10,
);
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
export const semanticClassifierJsonRetryMax = Number.parseInt(
  process.env.SEMANTIC_CLASSIFIER_JSON_RETRY_MAX || String(llmJsonRetryMax),
  10,
);
export const openClawToolOutputMaxChars = Number.parseInt(process.env.OPENCLAW_TOOL_OUTPUT_MAX_CHARS || "2400", 10);
export const larkPluginHybridDispatchEnabled =
  String(process.env.LARK_PLUGIN_HYBRID_DISPATCH_ENABLED || "true").toLowerCase() === "true";
export const larkDirectIngressPrimaryEnabled =
  String(process.env.LARK_DIRECT_INGRESS_PRIMARY_ENABLED || "false").toLowerCase() === "true";
export const meetingPromptMaxTokens = Number.parseInt(process.env.MEETING_PROMPT_MAX_TOKENS || "2200", 10);
export const meetingTranscriptPromptMaxChars = Number.parseInt(
  process.env.MEETING_TRANSCRIPT_PROMPT_MAX_CHARS || "3600",
  10,
);
export const meetingSummaryJsonRetryMax = Number.parseInt(
  process.env.MEETING_SUMMARY_JSON_RETRY_MAX || String(llmJsonRetryMax),
  10,
);
export const meetingDefaultChatId = String(process.env.MEETING_GROUP_CHAT_ID || "").trim();
export const meetingDocFolderToken = String(process.env.MEETING_DOC_FOLDER_TOKEN || "").trim();
export const meetingAudioCaptureEnabled =
  String(process.env.MEETING_AUDIO_CAPTURE_ENABLED || "true").toLowerCase() === "true";
export const meetingAudioFfmpegBin = String(process.env.MEETING_AUDIO_FFMPEG_BIN || "ffmpeg").trim() || "ffmpeg";
export const meetingAudioInputDeviceIndex = String(process.env.MEETING_AUDIO_INPUT_DEVICE_INDEX || "").trim();
export const meetingAudioCaptureDir =
  process.env.MEETING_AUDIO_CAPTURE_DIR || path.resolve(process.cwd(), ".data/meeting-audio");
export const meetingTranscribeProvider =
  String(process.env.MEETING_TRANSCRIBE_PROVIDER || "faster_whisper").trim() || "faster_whisper";
export const meetingTranscribeBaseUrl =
  (process.env.MEETING_TRANSCRIBE_BASE_URL || llmBaseUrl).replace(/\/$/, "");
export const meetingTranscribeApiKey = process.env.MEETING_TRANSCRIBE_API_KEY || llmApiKey;
export const meetingTranscribeModel = process.env.MEETING_TRANSCRIBE_MODEL || "whisper-1";
export const meetingTranscribeLanguage = String(process.env.MEETING_TRANSCRIBE_LANGUAGE || "zh").trim();
export const meetingTranscribeFasterWhisperPython =
  String(process.env.MEETING_TRANSCRIBE_FASTER_WHISPER_PYTHON || "python3").trim() || "python3";
export const meetingTranscribeFasterWhisperScript =
  process.env.MEETING_TRANSCRIBE_FASTER_WHISPER_SCRIPT ||
  path.resolve(process.cwd(), "scripts/transcribe-with-faster-whisper.py");
export const meetingTranscribeFasterWhisperModel =
  String(process.env.MEETING_TRANSCRIBE_FASTER_WHISPER_MODEL || "small").trim() || "small";
export const meetingTranscribeFasterWhisperDevice =
  String(process.env.MEETING_TRANSCRIBE_FASTER_WHISPER_DEVICE || "cpu").trim() || "cpu";
export const meetingTranscribeFasterWhisperComputeType =
  String(process.env.MEETING_TRANSCRIBE_FASTER_WHISPER_COMPUTE_TYPE || "int8").trim() || "int8";
export const meetingTranscribeFasterWhisperCacheDir =
  process.env.MEETING_TRANSCRIBE_FASTER_WHISPER_CACHE_DIR ||
  path.resolve(process.cwd(), ".data/faster-whisper");
export const runtimeGuardDisableCompetingLaunchAgents =
  String(process.env.RUNTIME_GUARD_DISABLE_COMPETING_LAUNCH_AGENTS || "true").toLowerCase() ===
  "true";
export const runtimeGuardCompetingLaunchLabels = String(
  process.env.RUNTIME_GUARD_COMPETING_LAUNCH_LABELS ||
    "ai.openclaw.gateway,lobster.core,lobster.gateway,lobster.worker",
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
export const runtimeMessageDedupWindowMs = Number.parseInt(
  process.env.RUNTIME_MESSAGE_DEDUP_WINDOW_MS || "120000",
  10,
);
export const httpRequestTimeoutMs = Number.parseInt(
  process.env.HTTP_REQUEST_TIMEOUT_MS || "60000",
  10,
);

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
