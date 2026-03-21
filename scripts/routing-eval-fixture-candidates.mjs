import { readFile } from "node:fs/promises";

function getArgValue(flag = "") {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return null;
  }
  return process.argv[index + 1] || null;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function loadRunInput(runRoutingEval) {
  const inputPath = getArgValue("--input");
  if (inputPath) {
    return JSON.parse(await readFile(inputPath, "utf8"));
  }

  const stdin = await readStdin();
  if (stdin.trim()) {
    return JSON.parse(stdin);
  }

  return runRoutingEval();
}

async function loadPreviousRunInput() {
  const inputPath = getArgValue("--previous");
  if (!inputPath) {
    return null;
  }
  return JSON.parse(await readFile(inputPath, "utf8"));
}

const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (() => true);

const [
  routingEvalModule,
  fixtureCandidatesModule,
] = await Promise.all([
  import("../src/routing-eval.mjs"),
  import("../src/routing-eval-fixture-candidates.mjs"),
]);

process.stdout.write = originalWrite;

const { loadRoutingEvalSet, runRoutingEval } = routingEvalModule;
const { prepareRoutingEvalFixtureCandidates } = fixtureCandidatesModule;
const prefer = getArgValue("--prefer") || "actual";
const datasetPath = getArgValue("--dataset");

try {
  const run = await loadRunInput(runRoutingEval);
  const previousRun = await loadPreviousRunInput();
  const testCases = datasetPath
    ? await loadRoutingEvalSet(datasetPath)
    : await loadRoutingEvalSet();
  const prepared = prepareRoutingEvalFixtureCandidates({
    run,
    previousRun,
    testCases,
    prefer,
  });

  console.log(JSON.stringify(prepared, null, 2));
  process.exitCode = prepared.ok ? 0 : 1;
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    validation_issues: [
      error instanceof Error ? error.message : String(error),
    ],
    source_summary: {
      total_cases: 0,
      miss_count: 0,
      overall_accuracy_ratio: 0,
      overall_accuracy: 0,
      gate_ok: false,
      min_accuracy_ratio: 0,
    },
    trend: {
      available: false,
      status: "unknown",
      accuracy_ratio: {
        current: 0,
        previous: null,
        delta: null,
      },
    },
    decision_advice: {
      trend: {
        available: false,
        status: "unknown",
        accuracy_ratio: {
          current: 0,
          previous: null,
          delta: null,
        },
      },
      warnings: [],
      recommendations: [],
      minimal_decision: {
        action: "observe_only",
        severity: "info",
        kind: "trend",
        summary: "No actionable drift detected from trend or error breakdown.",
      },
    },
    conversion_input: {
      source_summary: {
        total_cases: 0,
        miss_count: 0,
        overall_accuracy_ratio: 0,
        overall_accuracy: 0,
        gate_ok: false,
        min_accuracy_ratio: 0,
      },
      top_miss_cases_input: [],
      error_breakdown_input: [],
    },
    fixture_candidates: [],
  }, null, 2));
  process.exitCode = 1;
}
