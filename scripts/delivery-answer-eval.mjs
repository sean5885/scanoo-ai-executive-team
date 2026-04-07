import { buildPlannedUserInputEnvelope, resetPlannerRuntimeContext, runPlannerToolFlow } from "../src/executive-planner.mjs";
import { cleanText } from "../src/message-intent-utils.mjs";
import { normalizeUserResponse, renderUserResponseText } from "../src/user-response-normalizer.mjs";
import { deliveryAnswerEvals } from "../evals/delivery-answer-eval.mjs";

const noopLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const GENERIC_PATTERNS = [
  /我已先按目前已索引的文件/u,
  /我先沒有整理出可直接交付的內容/u,
  /我先沒有整理出足夠內容/u,
  /換個說法/u,
  /補一點上下文/u,
];

function normalizeText(value = "") {
  return cleanText(String(value || "")).toLowerCase();
}

function buildExecuteLikeResult(runtimeResult = {}, params = {}) {
  return {
    ok: runtimeResult?.execution_result?.ok === true,
    action: runtimeResult?.selected_action || null,
    params,
    error: runtimeResult?.execution_result?.ok === false
      ? runtimeResult?.execution_result?.error || null
      : null,
    execution_result: runtimeResult?.execution_result || null,
    formatted_output: runtimeResult?.formatted_output || null,
    trace_id: runtimeResult?.trace_id || null,
    why: null,
    alternative: null,
  };
}

function adaptEnvelopeForCurrentNormalizer(envelope = {}) {
  return {
    ...envelope,
    execution_result: {
      ...(envelope?.execution_result && typeof envelope.execution_result === "object" ? envelope.execution_result : {}),
    },
  };
}

function inferExecutedTarget(runtimeResult = {}, testCase = {}) {
  const action = cleanText(runtimeResult?.selected_action || "");
  if (action === cleanText(testCase.expected_planner_action || "")) {
    return `tool:${action}`;
  }
  return action ? `tool:${action}` : "none";
}

function looksGenericReply(text = "") {
  const normalized = cleanText(text);
  if (!normalized || normalized.length < 24) {
    return true;
  }
  return GENERIC_PATTERNS.some((pattern) => pattern.test(normalized));
}

function matchesAny(text = "", items = []) {
  const normalized = normalizeText(text);
  return (Array.isArray(items) ? items : []).some((item) => normalized.includes(normalizeText(item)));
}

function matchesAll(text = "", items = []) {
  const normalized = normalizeText(text);
  return (Array.isArray(items) ? items : []).every((item) => normalized.includes(normalizeText(item)));
}

function classifyResult({
  testCase = {},
  runtimeResult = {},
  userResponse = {},
  renderedText = "",
} = {}) {
  const executedTarget = inferExecutedTarget(runtimeResult, testCase);
  if (testCase.tool_required === true && !executedTarget.startsWith("tool:")) {
    return {
      quality: "tool_omission",
      executedTarget,
    };
  }

  if (looksGenericReply(renderedText)) {
    return {
      quality: "generic_reply",
      executedTarget,
    };
  }

  const answer = userResponse?.answer || "";
  const rejectPatterns = Array.isArray(testCase.quality?.reject_answer_patterns)
    ? testCase.quality.reject_answer_patterns
    : [];
  const rejectHit = rejectPatterns.some((pattern) => normalizeText(answer).includes(normalizeText(pattern)));
  const includeAllPass = matchesAll(answer, testCase.quality?.answer_must_include_all || []);
  const includeAnyItems = testCase.quality?.answer_must_include_any || [];
  const includeAnyPass = includeAnyItems.length === 0 ? true : matchesAny(answer, includeAnyItems);

  if (rejectHit || !includeAllPass || !includeAnyPass) {
    return {
      quality: "weak_answer",
      executedTarget,
    };
  }

  return {
    quality: "good_answer",
    executedTarget,
  };
}

async function runSingleCase(testCase = {}) {
  resetPlannerRuntimeContext();
  const fixture = testCase.fixture || {};
  const runtimeResult = await runPlannerToolFlow({
    userIntent: testCase.user_text,
    payload: {
      limit: 5,
      q: testCase.user_text,
      query: testCase.user_text,
    },
    logger: noopLogger,
    async dispatcher({ action }) {
      if (action === "search_company_brain_docs") {
        return {
          ok: true,
          action: "company_brain_docs_search",
          items: [
            {
              doc_id: fixture.doc_id,
              title: fixture.title,
              url: fixture.url,
              summary: {
                snippet: fixture.search_snippet,
                overview: fixture.content_summary,
              },
            },
          ],
          trace_id: `${testCase.id}:search`,
        };
      }
      return {
        ok: true,
        action: "company_brain_doc_detail",
        item: {
          doc_id: fixture.doc_id,
          title: fixture.title,
          url: fixture.url,
        },
        data: {
          summary: {
            snippet: fixture.search_snippet,
            overview: fixture.content_summary,
          },
        },
        trace_id: `${testCase.id}:detail`,
      };
    },
    async presetRunner({ preset }) {
      return {
        ok: true,
        preset,
        steps: [
          { action: "search_company_brain_docs" },
          { action: "get_company_brain_doc_detail" },
        ],
        results: [
          {
            ok: true,
            action: "company_brain_docs_search",
            items: [
              {
                doc_id: fixture.doc_id,
                title: fixture.title,
                url: fixture.url,
                summary: {
                  snippet: fixture.search_snippet,
                  overview: fixture.content_summary,
                },
              },
            ],
            trace_id: `${testCase.id}:search`,
          },
          {
            ok: true,
            action: "company_brain_doc_detail",
            item: {
              doc_id: fixture.doc_id,
              title: fixture.title,
              url: fixture.url,
            },
            data: {
              summary: {
                snippet: fixture.search_snippet,
                overview: fixture.content_summary,
              },
            },
            trace_id: `${testCase.id}:detail`,
          },
        ],
        trace_id: `${testCase.id}:preset`,
        stopped: false,
        stopped_at_step: null,
      };
    },
    async contentReader() {
      return {
        title: fixture.title,
        content: fixture.content,
      };
    },
  });

  const envelope = buildPlannedUserInputEnvelope(buildExecuteLikeResult(runtimeResult, {
    limit: 5,
    q: testCase.user_text,
    query: testCase.user_text,
  }));
  const userResponse = normalizeUserResponse({
    plannerEnvelope: adaptEnvelopeForCurrentNormalizer(envelope),
  });
  const renderedText = renderUserResponseText(userResponse);
  const classification = classifyResult({
    testCase,
    runtimeResult,
    userResponse,
    renderedText,
  });

  return {
    id: testCase.id,
    user_text: testCase.user_text,
    expected_action: testCase.expected_planner_action,
    actual_action: runtimeResult?.selected_action || null,
    quality: classification.quality,
    executed_target: classification.executedTarget,
    answer: userResponse.answer,
    sources: userResponse.sources,
    limitations: userResponse.limitations,
  };
}

function summarize(results = []) {
  const counts = results.reduce((acc, item) => {
    acc[item.quality] = (acc[item.quality] || 0) + 1;
    return acc;
  }, {});

  return {
    total: results.length,
    counts: {
      generic_reply: counts.generic_reply || 0,
      tool_omission: counts.tool_omission || 0,
      weak_answer: counts.weak_answer || 0,
      good_answer: counts.good_answer || 0,
    },
  };
}

const results = [];
for (const testCase of deliveryAnswerEvals) {
  results.push(await runSingleCase(testCase));
}

const summary = summarize(results);
console.log(JSON.stringify({ summary, results }, null, 2));
