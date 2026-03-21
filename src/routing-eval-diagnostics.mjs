import { cleanText } from "./message-intent-utils.mjs";
import {
  buildComparableRoutingSummary,
  buildRoutingTrendReport,
} from "./routing-eval.mjs";
import {
  FALLBACK_DISABLED,
  INVALID_ACTION,
  ROUTING_NO_MATCH,
} from "./planner-error-codes.mjs";

const ROUTING_ERROR_CODES = [
  ROUTING_NO_MATCH,
  INVALID_ACTION,
  FALLBACK_DISABLED,
];

function normalizeErrorMetric(metric = {}) {
  return {
    expected: Number(metric?.expected || 0),
    actual: Number(metric?.actual || 0),
    matched: Number(metric?.matched || 0),
    misses: Number(metric?.misses || 0),
  };
}

function buildZeroErrorMetric() {
  return {
    expected: 0,
    actual: 0,
    matched: 0,
    misses: 0,
  };
}

function buildSignedNumber(value = 0, precision = 4) {
  const normalized = Number(value || 0);
  return `${normalized >= 0 ? "+" : ""}${normalized.toFixed(precision)}`;
}

function hasCoverageGap(metric = {}) {
  return Number(metric?.misses || 0) > 0 || Number(metric?.actual || 0) > Number(metric?.matched || 0);
}

function hasFallbackDisabledRisk(metric = {}) {
  return Number(metric?.actual || 0) > 0 || Number(metric?.misses || 0) > 0;
}

function normalizeDecisionTrend(trendReport = {}) {
  const accuracyDelta = trendReport?.delta?.accuracy_ratio || null;
  let status = "unknown";

  if (trendReport?.available && accuracyDelta) {
    if (Number(accuracyDelta.delta || 0) < 0) {
      status = "declined";
    } else if (Number(accuracyDelta.delta || 0) === 0) {
      status = "stable";
    } else {
      status = "improved";
    }
  }

  return {
    available: Boolean(trendReport?.available),
    status,
    accuracy_ratio: accuracyDelta
      ? {
          current: Number(accuracyDelta.current || 0),
          previous: Number(accuracyDelta.previous || 0),
          delta: Number(accuracyDelta.delta || 0),
        }
      : {
          current: Number(trendReport?.current?.comparable_summary?.accuracy_ratio || 0),
          previous: null,
          delta: null,
        },
  };
}

function buildRecommendation({
  action = "",
  severity = "info",
  kind = "",
  summary = "",
  errorCode = null,
  metric = null,
} = {}) {
  return {
    action: cleanText(action) || null,
    severity: cleanText(severity) || "info",
    kind: cleanText(kind) || null,
    summary: cleanText(summary) || null,
    ...(cleanText(errorCode) ? { error_code: cleanText(errorCode) } : {}),
    ...(metric ? { metric: normalizeErrorMetric(metric) } : {}),
  };
}

function buildMinimalDecision(recommendations = [], trend = {}) {
  const priority = new Map([
    ["manual_review_high_risk", 0],
    ["warn_accuracy_decline", 1],
    ["check_routing_rule", 2],
    ["review_fixture_coverage", 3],
    ["no_change", 4],
    ["observe_only", 5],
  ]);

  if (Array.isArray(recommendations) && recommendations.length > 0) {
    return [...recommendations]
      .sort((left, right) => (
        (priority.get(cleanText(left?.action)) ?? Number.MAX_SAFE_INTEGER)
        - (priority.get(cleanText(right?.action)) ?? Number.MAX_SAFE_INTEGER)
      ))[0];
  }

  if (trend?.status === "stable") {
    return buildRecommendation({
      action: "no_change",
      severity: "info",
      kind: "trend",
      summary: "Accuracy remained stable; recommend no routing, fallback, or dataset change.",
    });
  }

  return buildRecommendation({
    action: "observe_only",
    severity: "info",
    kind: "trend",
    summary: "No actionable drift detected from trend or error breakdown.",
  });
}

function collectChangedEntries(record = {}, predicate = () => false) {
  return Object.entries(record || {}).filter(([, value]) => predicate(value));
}

export function buildRoutingEvalDecisionAdvice({ run = {}, previousRun = null } = {}) {
  const breakdown = Object.fromEntries(
    ROUTING_ERROR_CODES.map((code) => [
      code,
      normalizeErrorMetric(run?.summary?.error_breakdown?.[code] || buildZeroErrorMetric()),
    ]),
  );
  const trendReport = buildRoutingTrendReport({
    currentRun: run,
    previousRun,
  });
  const trend = normalizeDecisionTrend(trendReport);
  const warnings = [];
  const recommendations = [];

  if (trend.status === "declined") {
    warnings.push({
      code: "accuracy_declined",
      severity: "warning",
      summary: `Accuracy ratio declined by ${buildSignedNumber(trend.accuracy_ratio.delta, 4)} compared with the previous run.`,
    });
    recommendations.push(buildRecommendation({
      action: "warn_accuracy_decline",
      severity: "warning",
      kind: "trend",
      summary: `Accuracy declined from ${trend.accuracy_ratio.previous} to ${trend.accuracy_ratio.current}; review before accepting further changes.`,
    }));
  }

  if (hasCoverageGap(breakdown[ROUTING_NO_MATCH])) {
    recommendations.push(buildRecommendation({
      action: "review_fixture_coverage",
      severity: "info",
      kind: "dataset",
      errorCode: ROUTING_NO_MATCH,
      metric: breakdown[ROUTING_NO_MATCH],
      summary: "ROUTING_NO_MATCH drift detected; review missing fixture coverage before changing routing logic.",
    }));
  }

  if (hasCoverageGap(breakdown[INVALID_ACTION])) {
    recommendations.push(buildRecommendation({
      action: "check_routing_rule",
      severity: "warning",
      kind: "routing_rule",
      errorCode: INVALID_ACTION,
      metric: breakdown[INVALID_ACTION],
      summary: "INVALID_ACTION drift detected; inspect routing rule and action contract instead of updating fallback or dataset blindly.",
    }));
  }

  if (hasFallbackDisabledRisk(breakdown[FALLBACK_DISABLED])) {
    recommendations.push(buildRecommendation({
      action: "manual_review_high_risk",
      severity: "high",
      kind: "risk",
      errorCode: FALLBACK_DISABLED,
      metric: breakdown[FALLBACK_DISABLED],
      summary: "FALLBACK_DISABLED observed; treat as high risk and require manual review.",
    }));
  }

  if (trend.status === "stable") {
    recommendations.push(buildRecommendation({
      action: "no_change",
      severity: "info",
      kind: "trend",
      summary: "Accuracy remained stable; recommend no change.",
    }));
  }

  return {
    trend,
    warnings,
    recommendations,
    minimal_decision: buildMinimalDecision(recommendations, trend),
  };
}

export function formatRoutingEvalDecisionAdvice(decisionAdvice = {}) {
  const trend = decisionAdvice?.trend || {
    status: "unknown",
    available: false,
    accuracy_ratio: {
      current: 0,
      previous: null,
      delta: null,
    },
  };
  const minimalDecision = decisionAdvice?.minimal_decision || buildMinimalDecision([], trend);
  const lines = [
    "Routing Decision Advice",
    `Trend: ${trend.status}`,
    trend.available
      ? `Accuracy ratio: ${trend.accuracy_ratio.current} vs ${trend.accuracy_ratio.previous} | delta ${buildSignedNumber(trend.accuracy_ratio.delta, 4)}`
      : `Accuracy ratio: ${trend.accuracy_ratio.current} | previous run unavailable`,
    `Decision: ${minimalDecision?.action || "observe_only"} | severity ${minimalDecision?.severity || "info"}`,
    minimalDecision?.summary || "No actionable drift detected from trend or error breakdown.",
  ];

  if (Array.isArray(decisionAdvice?.recommendations) && decisionAdvice.recommendations.length > 0) {
    lines.push("");
    lines.push("Recommendations");
    for (const recommendation of decisionAdvice.recommendations) {
      const scope = cleanText(recommendation?.error_code) || cleanText(recommendation?.kind) || "general";
      lines.push(`- ${scope}: ${recommendation.summary}`);
    }
  }

  return lines.join("\n");
}

export function buildRoutingDiagnosticsSummary({
  run = {},
  previousRun = null,
  currentLabel = "current",
  previousLabel = "previous",
} = {}) {
  const comparableSummary = buildComparableRoutingSummary(run?.summary || {});
  const trendReport = buildRoutingTrendReport({
    currentRun: run,
    previousRun,
    currentLabel,
    previousLabel,
  });
  const decisionAdvice = buildRoutingEvalDecisionAdvice({
    run,
    previousRun,
  });

  return {
    accuracy_ratio: Number(comparableSummary?.accuracy_ratio || 0),
    by_lane_accuracy: comparableSummary?.by_lane_accuracy || {},
    by_action_accuracy: comparableSummary?.by_action_accuracy || {},
    error_breakdown: comparableSummary?.error_breakdown || {},
    trend_report: trendReport,
    decision_advice: decisionAdvice,
  };
}

export function formatRoutingDiagnosticsSummary(diagnosticsSummary = {}) {
  const decision = diagnosticsSummary?.decision_advice?.minimal_decision || {
    action: "observe_only",
    severity: "info",
    summary: "No actionable drift detected from trend or error breakdown.",
  };
  const trend = diagnosticsSummary?.decision_advice?.trend || diagnosticsSummary?.trend_report || {
    available: false,
    status: "unknown",
    accuracy_ratio: {
      current: Number(diagnosticsSummary?.accuracy_ratio || 0),
      previous: null,
      delta: null,
    },
  };
  const lines = [
    "Routing Diagnostics Summary",
    `Decision: ${decision.action || "observe_only"} | severity ${decision.severity || "info"}`,
    decision.summary || "No actionable drift detected from trend or error breakdown.",
    trend.available
      ? `Accuracy ratio: ${trend.accuracy_ratio.current} vs ${trend.accuracy_ratio.previous} | delta ${buildSignedNumber(trend.accuracy_ratio.delta, 4)} | trend ${trend.status}`
      : `Accuracy ratio: ${Number(diagnosticsSummary?.accuracy_ratio || 0)} | trend ${trend.status} | previous run unavailable`,
    "",
    "By lane accuracy",
  ];

  const byLaneEntries = Object.entries(diagnosticsSummary?.by_lane_accuracy || {});
  if (byLaneEntries.length === 0) {
    lines.push("- none");
  } else {
    for (const [lane, metric] of byLaneEntries) {
      lines.push(`- ${lane}: ${metric.accuracy_ratio} (${metric.hits}/${metric.total})`);
    }
  }

  lines.push("");
  lines.push("By action accuracy");
  const byActionEntries = Object.entries(diagnosticsSummary?.by_action_accuracy || {});
  if (byActionEntries.length === 0) {
    lines.push("- none");
  } else {
    for (const [action, metric] of byActionEntries) {
      lines.push(`- ${action}: ${metric.accuracy_ratio} (${metric.hits}/${metric.total})`);
    }
  }

  lines.push("");
  lines.push("Error breakdown");
  for (const code of ROUTING_ERROR_CODES) {
    const metric = normalizeErrorMetric(diagnosticsSummary?.error_breakdown?.[code] || buildZeroErrorMetric());
    lines.push(
      `- ${code}: expected ${metric.expected} | actual ${metric.actual} | matched ${metric.matched} | misses ${metric.misses}`,
    );
  }

  const trendDelta = diagnosticsSummary?.trend_report?.delta || null;
  if (trendDelta) {
    const laneChanges = collectChangedEntries(
      trendDelta.by_lane_accuracy,
      (metric) => metric?.status !== "unchanged",
    );
    const actionChanges = collectChangedEntries(
      trendDelta.by_action_accuracy,
      (metric) => metric?.status !== "unchanged",
    );
    const errorChanges = collectChangedEntries(
      trendDelta.error_breakdown,
      (metric) => (
        Number(metric?.expected?.delta || 0) !== 0
        || Number(metric?.actual?.delta || 0) !== 0
        || Number(metric?.matched?.delta || 0) !== 0
        || Number(metric?.misses?.delta || 0) !== 0
      ),
    );

    lines.push("");
    lines.push("Trend report");
    lines.push(`- Current: ${diagnosticsSummary?.trend_report?.current_label || "current"}`);
    lines.push(`- Previous: ${diagnosticsSummary?.trend_report?.previous_label || "none"}`);
    lines.push(`- Miss count delta: ${buildSignedNumber(trendDelta?.miss_count?.delta, 0)}`);
    lines.push(`- Case count delta: ${buildSignedNumber(trendDelta?.total_cases?.delta, 0)}`);

    lines.push("");
    lines.push("Trend lane changes");
    if (laneChanges.length === 0) {
      lines.push("- none");
    } else {
      for (const [lane, metric] of laneChanges) {
        const current = metric?.current
          ? `${metric.current.accuracy_ratio} (${metric.current.hits}/${metric.current.total})`
          : "none";
        const previous = metric?.previous
          ? `${metric.previous.accuracy_ratio} (${metric.previous.hits}/${metric.previous.total})`
          : "none";
        lines.push(
          `- ${lane}: ${current} vs ${previous} | delta ${metric.delta_accuracy_ratio === null ? "n/a" : buildSignedNumber(metric.delta_accuracy_ratio, 4)} | ${metric.status}`,
        );
      }
    }

    lines.push("");
    lines.push("Trend action changes");
    if (actionChanges.length === 0) {
      lines.push("- none");
    } else {
      for (const [action, metric] of actionChanges) {
        const current = metric?.current
          ? `${metric.current.accuracy_ratio} (${metric.current.hits}/${metric.current.total})`
          : "none";
        const previous = metric?.previous
          ? `${metric.previous.accuracy_ratio} (${metric.previous.hits}/${metric.previous.total})`
          : "none";
        lines.push(
          `- ${action}: ${current} vs ${previous} | delta ${metric.delta_accuracy_ratio === null ? "n/a" : buildSignedNumber(metric.delta_accuracy_ratio, 4)} | ${metric.status}`,
        );
      }
    }

    lines.push("");
    lines.push("Trend error changes");
    if (errorChanges.length === 0) {
      lines.push("- none");
    } else {
      for (const [code, metric] of errorChanges) {
        lines.push(
          `- ${code}: expected ${buildSignedNumber(metric.expected.delta, 0)} | actual ${buildSignedNumber(metric.actual.delta, 0)} | matched ${buildSignedNumber(metric.matched.delta, 0)} | misses ${buildSignedNumber(metric.misses.delta, 0)}`,
        );
      }
    }
  }

  if (Array.isArray(diagnosticsSummary?.decision_advice?.recommendations) && diagnosticsSummary.decision_advice.recommendations.length > 0) {
    lines.push("");
    lines.push("Decision advice");
    for (const recommendation of diagnosticsSummary.decision_advice.recommendations) {
      const scope = cleanText(recommendation?.error_code) || cleanText(recommendation?.kind) || "general";
      lines.push(`- ${scope}: ${recommendation.summary}`);
    }
  }

  return lines.join("\n");
}
