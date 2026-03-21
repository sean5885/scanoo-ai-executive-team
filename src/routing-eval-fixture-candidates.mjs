import { inspect } from "node:util";

import { cleanText } from "./message-intent-utils.mjs";
import {
  FALLBACK_DISABLED,
  INVALID_ACTION,
  ROUTING_NO_MATCH,
} from "./planner-error-codes.mjs";
import {
  buildRoutingDiagnosticsSummary,
  buildRoutingEvalDecisionAdvice,
} from "./routing-eval-diagnostics.mjs";

export {
  buildRoutingEvalDecisionAdvice,
  formatRoutingEvalDecisionAdvice,
} from "./routing-eval-diagnostics.mjs";

const ROUTING_ERROR_CODES = [
  ROUTING_NO_MATCH,
  INVALID_ACTION,
  FALLBACK_DISABLED,
];

function cloneSerializable(value) {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value));
}

function normalizeRouteSnapshot(snapshot = {}) {
  return {
    lane: cleanText(snapshot?.lane) || null,
    planner_action: cleanText(snapshot?.planner_action) || null,
    agent_or_tool: cleanText(snapshot?.agent_or_tool) || null,
    ...(cleanText(snapshot?.route_source) ? { route_source: cleanText(snapshot.route_source) } : {}),
  };
}

function normalizeErrorMetric(metric = {}) {
  return {
    expected: Number(metric?.expected || 0),
    actual: Number(metric?.actual || 0),
    matched: Number(metric?.matched || 0),
    misses: Number(metric?.misses || 0),
  };
}

function extractRoutingErrorCode(...values) {
  for (const rawValue of values) {
    const value = cleanText(rawValue);
    if (!value) {
      continue;
    }
    const normalizedCode = value.startsWith("error:")
      ? cleanText(value.slice("error:".length))
      : value;
    if (ROUTING_ERROR_CODES.includes(normalizedCode)) {
      return normalizedCode;
    }
  }
  return null;
}

function deriveDatasetIdSuffix(category = "", caseId = "") {
  const normalizedCategory = cleanText(category);
  const normalizedCaseId = cleanText(caseId);
  if (normalizedCategory && normalizedCaseId.startsWith(`${normalizedCategory}-`)) {
    return normalizedCaseId.slice(normalizedCategory.length + 1);
  }
  return normalizedCaseId;
}

function buildCandidateIdSuffix(record = {}, prefer = "actual") {
  const category = cleanText(record?.category) || "routing";
  const sourceCaseId = cleanText(record?.source_case_id) || `${category}-candidate`;
  const sourceSuffix = deriveDatasetIdSuffix(category, sourceCaseId) || sourceCaseId;
  return `${sourceSuffix.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").toLowerCase()}_${prefer}`;
}

function buildSourceFixture(testCase = {}) {
  if (!testCase || typeof testCase !== "object" || Array.isArray(testCase)) {
    return null;
  }
  return {
    id: cleanText(testCase.id) || null,
    category: cleanText(testCase.category) || null,
    text: cleanText(testCase.text) || null,
    ...(cleanText(testCase.name) ? { name: cleanText(testCase.name) } : {}),
    expected: normalizeRouteSnapshot(testCase.expected || {}),
    ...(testCase.scope && typeof testCase.scope === "object" && !Array.isArray(testCase.scope)
      ? { scope: cloneSerializable(testCase.scope) }
      : {}),
    ...(testCase.context && typeof testCase.context === "object" && !Array.isArray(testCase.context)
      ? { context: cloneSerializable(testCase.context) }
      : {}),
    ...(testCase.message && typeof testCase.message === "object" && !Array.isArray(testCase.message)
      ? { message: cloneSerializable(testCase.message) }
      : {}),
  };
}

function buildConversionRecord(result = {}, sourceFixture = null, sourceKind = "") {
  const expectedCode = extractRoutingErrorCode(
    result?.expected?.planner_action,
    result?.expected?.agent_or_tool,
  );
  const actualCode = extractRoutingErrorCode(
    result?.actual?.planner_action,
    result?.actual?.agent_or_tool,
  );

  return {
    source_case_id: cleanText(result?.id) || cleanText(sourceFixture?.id) || null,
    source_kind: cleanText(sourceKind) || null,
    category: cleanText(result?.category) || cleanText(sourceFixture?.category) || null,
    text: cleanText(result?.text) || cleanText(sourceFixture?.text) || null,
    name: cleanText(sourceFixture?.name) || null,
    miss_dimensions: Array.isArray(result?.miss_dimensions)
      ? result.miss_dimensions.map((item) => cleanText(item)).filter(Boolean)
      : [],
    current_expected: normalizeRouteSnapshot(result?.expected || sourceFixture?.expected || {}),
    observed_actual: normalizeRouteSnapshot(result?.actual || {}),
    error_codes: {
      expected: expectedCode,
      actual: actualCode,
    },
    source_fixture: sourceFixture ? cloneSerializable(sourceFixture) : null,
  };
}

function buildErrorRole(expectedCode = "", actualCode = "", targetCode = "") {
  if (expectedCode === targetCode && actualCode === targetCode) {
    return "matched";
  }
  if (expectedCode === targetCode) {
    return "expected_only";
  }
  if (actualCode === targetCode) {
    return "actual_only";
  }
  return null;
}

function buildSourceSummary(run = {}) {
  return {
    total_cases: Number(run?.summary?.total_cases || 0),
    miss_count: Number(run?.summary?.miss_count || 0),
    overall_accuracy_ratio: Number(run?.summary?.overall?.accuracy_ratio || 0),
    overall_accuracy: Number(run?.summary?.overall?.accuracy || 0),
    gate_ok: Boolean(run?.ok),
    min_accuracy_ratio: Number(run?.threshold?.min_accuracy_ratio || 0),
  };
}

function indexTestCasesById(testCases = []) {
  return new Map(
    (Array.isArray(testCases) ? testCases : [])
      .map((testCase) => {
        const id = cleanText(testCase?.id);
        return id ? [id, buildSourceFixture(testCase)] : null;
      })
      .filter(Boolean),
  );
}

function formatCreateCaseSnippet({ category = "", idSuffix = "", text = "", expected = {}, options = {} } = {}) {
  const args = [
    inspect(category, { breakLength: Infinity }),
    inspect(idSuffix, { breakLength: Infinity }),
    inspect(text, { breakLength: Infinity }),
    inspect(expected, { depth: null, compact: false, sorted: true, breakLength: 80 }),
  ];

  if (options && Object.keys(options).length > 0) {
    args.push(inspect(options, { depth: null, compact: false, sorted: true, breakLength: 80 }));
  }

  return `createCase(\n  ${args.join(",\n  ")}\n)`;
}

function mergeSeedRecord(seeds, record = {}, sourceReference = {}) {
  const key = cleanText(record?.source_case_id) || `${cleanText(record?.category)}:${cleanText(record?.text)}`;
  if (!key) {
    return;
  }

  const existing = seeds.get(key);
  if (!existing) {
    seeds.set(key, {
      ...cloneSerializable(record),
      source_references: [sourceReference].filter((item) => cleanText(item?.type)),
      source_kinds: [cleanText(record?.source_kind)].filter(Boolean),
      involved_error_codes: [...new Set([
        record?.error_codes?.expected,
        record?.error_codes?.actual,
      ].filter(Boolean))],
    });
    return;
  }

  if (cleanText(record?.source_kind) && !existing.source_kinds.includes(cleanText(record.source_kind))) {
    existing.source_kinds.push(cleanText(record.source_kind));
  }

  if (cleanText(sourceReference?.type)) {
    const referenceKey = `${cleanText(sourceReference.type)}:${cleanText(sourceReference.error_code)}:${cleanText(sourceReference.error_role)}`;
    const hasReference = existing.source_references.some((item) => (
      `${cleanText(item?.type)}:${cleanText(item?.error_code)}:${cleanText(item?.error_role)}` === referenceKey
    ));
    if (!hasReference) {
      existing.source_references.push(sourceReference);
    }
  }

  for (const code of [record?.error_codes?.expected, record?.error_codes?.actual]) {
    if (cleanText(code) && !existing.involved_error_codes.includes(cleanText(code))) {
      existing.involved_error_codes.push(cleanText(code));
    }
  }

  if (!existing.source_fixture && record?.source_fixture) {
    existing.source_fixture = cloneSerializable(record.source_fixture);
  }

  if (Array.isArray(record?.miss_dimensions)) {
    for (const dimension of record.miss_dimensions) {
      const normalized = cleanText(dimension);
      if (normalized && !existing.miss_dimensions.includes(normalized)) {
        existing.miss_dimensions.push(normalized);
      }
    }
  }
}

function buildFixtureCandidate(record = {}, prefer = "actual") {
  const normalizedPrefer = prefer === "expected" ? "expected" : "actual";
  const sourceFixture = record?.source_fixture || null;
  const selectedRoute = normalizedPrefer === "expected"
    ? record?.current_expected || {}
    : record?.observed_actual || {};
  const fallbackRoute = normalizedPrefer === "expected"
    ? record?.observed_actual || {}
    : record?.current_expected || {};
  const category = cleanText(sourceFixture?.category || record?.category) || "routing";
  const targetCaseId = cleanText(sourceFixture?.id || record?.source_case_id) || null;
  const datasetIdSuffix = sourceFixture
    ? deriveDatasetIdSuffix(category, targetCaseId)
    : buildCandidateIdSuffix(record, normalizedPrefer);
  const expected = {
    lane: cleanText(selectedRoute?.lane || fallbackRoute?.lane) || null,
    planner_action: cleanText(selectedRoute?.planner_action || fallbackRoute?.planner_action) || null,
    agent_or_tool: cleanText(selectedRoute?.agent_or_tool || fallbackRoute?.agent_or_tool) || null,
  };
  const options = {
    ...(cleanText(sourceFixture?.name) ? { name: cleanText(sourceFixture.name) } : {}),
    ...(sourceFixture?.scope ? { scope: cloneSerializable(sourceFixture.scope) } : {}),
    ...(sourceFixture?.context ? { context: cloneSerializable(sourceFixture.context) } : {}),
    ...(sourceFixture?.message ? { message: cloneSerializable(sourceFixture.message) } : {}),
  };
  const fixture = {
    id: targetCaseId || `${category}-${datasetIdSuffix}`,
    category,
    text: cleanText(sourceFixture?.text || record?.text) || "",
    expected,
    ...(cleanText(sourceFixture?.name) ? { name: cleanText(sourceFixture.name) } : {}),
    ...(sourceFixture?.scope ? { scope: cloneSerializable(sourceFixture.scope) } : {}),
    ...(sourceFixture?.context ? { context: cloneSerializable(sourceFixture.context) } : {}),
    ...(sourceFixture?.message ? { message: cloneSerializable(sourceFixture.message) } : {}),
  };

  return {
    source_case_id: cleanText(record?.source_case_id) || null,
    source_kinds: Array.isArray(record?.source_kinds) ? record.source_kinds : [cleanText(record?.source_kind)].filter(Boolean),
    source_references: Array.isArray(record?.source_references) ? cloneSerializable(record.source_references) : [],
    source_fixture_found: Boolean(sourceFixture),
    suggested_dataset_action: sourceFixture ? "update_existing_fixture" : "add_fixture",
    target_case_id: targetCaseId,
    dataset_case: {
      category,
      id_suffix: datasetIdSuffix,
    },
    selection_basis: normalizedPrefer === "expected"
      ? "current_expected_route"
      : "observed_actual_route",
    lane: expected.lane,
    planner_action: expected.planner_action,
    agent_or_tool: expected.agent_or_tool,
    miss_dimensions: Array.isArray(record?.miss_dimensions) ? record.miss_dimensions : [],
    involved_error_codes: Array.isArray(record?.involved_error_codes) ? record.involved_error_codes : [],
    current_expected: cloneSerializable(record?.current_expected || {}),
    observed_actual: cloneSerializable(record?.observed_actual || {}),
    fixture,
    fixture_source: formatCreateCaseSnippet({
      category,
      idSuffix: datasetIdSuffix,
      text: fixture.text,
      expected,
      options,
    }),
  };
}

export function validateRoutingEvalRunForConversion(run = {}) {
  const issues = [];

  if (!run || typeof run !== "object" || Array.isArray(run)) {
    return ["routing eval conversion input must be an object"];
  }

  if (!Array.isArray(run?.results)) {
    issues.push("routing eval conversion input is missing results[]");
  }

  if (!run?.summary || typeof run.summary !== "object" || Array.isArray(run.summary)) {
    issues.push("routing eval conversion input is missing summary");
    return issues;
  }

  if (!Array.isArray(run.summary?.top_miss_cases)) {
    issues.push("routing eval conversion input is missing summary.top_miss_cases[]");
  }

  if (!run.summary?.error_breakdown || typeof run.summary.error_breakdown !== "object" || Array.isArray(run.summary.error_breakdown)) {
    issues.push("routing eval conversion input is missing summary.error_breakdown");
  }

  return issues;
}

export function buildRoutingEvalConversionInput({ run = {}, testCases = [] } = {}) {
  const sourceCasesById = indexTestCasesById(testCases);
  const topMissCasesInput = (Array.isArray(run?.summary?.top_miss_cases) ? run.summary.top_miss_cases : [])
    .map((miss) => {
      const sourceFixture = sourceCasesById.get(cleanText(miss?.id)) || null;
      return buildConversionRecord(miss, sourceFixture, "top_miss_case");
    });

  const errorBreakdownInput = ROUTING_ERROR_CODES
    .map((code) => {
      const summaryMetric = normalizeErrorMetric(run?.summary?.error_breakdown?.[code] || buildZeroErrorMetric());
      const cases = (Array.isArray(run?.results) ? run.results : [])
        .map((result) => {
          const sourceFixture = sourceCasesById.get(cleanText(result?.id)) || null;
          const record = buildConversionRecord(result, sourceFixture, "routing_error_case");
          const errorRole = buildErrorRole(record?.error_codes?.expected, record?.error_codes?.actual, code);
          if (!errorRole) {
            return null;
          }
          return {
            ...record,
            error_code: code,
            error_role: errorRole,
          };
        })
        .filter(Boolean);

      if (
        summaryMetric.expected === 0
        && summaryMetric.actual === 0
        && summaryMetric.matched === 0
        && summaryMetric.misses === 0
        && cases.length === 0
      ) {
        return null;
      }

      return {
        error_code: code,
        summary: summaryMetric,
        cases,
      };
    })
    .filter(Boolean);

  return {
    source_summary: buildSourceSummary(run),
    top_miss_cases_input: topMissCasesInput,
    error_breakdown_input: errorBreakdownInput,
  };
}

export function prepareRoutingEvalFixtureCandidates({
  run = {},
  previousRun = null,
  testCases = [],
  prefer = "actual",
} = {}) {
  const issues = validateRoutingEvalRunForConversion(run);
  const decisionAdvice = buildRoutingEvalDecisionAdvice({
    run,
    previousRun,
  });
  const diagnosticsSummary = buildRoutingDiagnosticsSummary({
    run,
    previousRun,
  });
  if (!["actual", "expected"].includes(prefer)) {
    issues.push(`unsupported prefer mode: ${prefer}`);
  }

  if (issues.length > 0) {
    return {
      ok: false,
      validation_issues: issues,
      source_summary: buildSourceSummary(run),
      diagnostics_summary: diagnosticsSummary,
      trend: decisionAdvice.trend,
      decision_advice: decisionAdvice,
      conversion_input: {
        source_summary: buildSourceSummary(run),
        top_miss_cases_input: [],
        error_breakdown_input: [],
      },
      fixture_candidates: [],
    };
  }

  const conversionInput = buildRoutingEvalConversionInput({ run, testCases });
  const seeds = new Map();

  for (const record of conversionInput.top_miss_cases_input) {
    mergeSeedRecord(seeds, record, {
      type: "top_miss_case",
    });
  }

  for (const group of conversionInput.error_breakdown_input) {
    for (const record of group.cases || []) {
      mergeSeedRecord(seeds, record, {
        type: "routing_error_case",
        error_code: group.error_code,
        error_role: record.error_role,
      });
    }
  }

  const fixtureCandidates = [...seeds.values()]
    .sort((left, right) => (
      cleanText(left?.source_case_id).localeCompare(cleanText(right?.source_case_id))
    ))
    .map((record) => buildFixtureCandidate(record, prefer));

  return {
    ok: true,
    validation_issues: [],
    source_summary: conversionInput.source_summary,
    diagnostics_summary: diagnosticsSummary,
    trend: decisionAdvice.trend,
    decision_advice: decisionAdvice,
    conversion_input: conversionInput,
    fixture_candidates: fixtureCandidates,
  };
}
