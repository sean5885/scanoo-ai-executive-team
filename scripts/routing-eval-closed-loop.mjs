import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  formatRoutingEvalReport,
  loadRoutingEvalSet,
  runRoutingEval,
} from "../src/routing-eval.mjs";
import { prepareRoutingEvalFixtureCandidates } from "../src/routing-eval-fixture-candidates.mjs";

const DEFAULT_BASE_DIR = path.resolve(process.cwd(), ".tmp/routing-eval-closed-loop");
const DEFAULT_DATASET_PATH = path.resolve(process.cwd(), "evals/routing-eval-set.mjs");
const DEFAULT_PREFER = "actual";
const POINTER_FILE = "latest-session.json";

function getArgValue(flag = "") {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return null;
  }
  return process.argv[index + 1] || null;
}

function getCommand() {
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg || arg.startsWith("--")) {
      if (arg && ["--out-dir", "--dataset", "--prefer", "--session"].includes(arg)) {
        index += 1;
      }
      continue;
    }
    return arg;
  }
  return "prepare";
}

function resolvePath(inputPath = "", fallbackPath = "") {
  if (inputPath) {
    return path.resolve(process.cwd(), inputPath);
  }
  return path.resolve(process.cwd(), fallbackPath);
}

function timestampToken(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function writeJson(filePath, payload) {
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function writeText(filePath, payload = "") {
  await writeFile(filePath, `${String(payload).replace(/\s*$/, "")}\n`, "utf8");
}

function buildSessionMetadata({
  sessionId,
  sessionDir,
  datasetPath,
  prefer,
  run,
  prepared,
}) {
  return {
    session_id: sessionId,
    session_dir: sessionDir,
    created_at: new Date().toISOString(),
    dataset_path: datasetPath,
    prefer,
    summary: {
      total_cases: run?.summary?.total_cases || 0,
      overall_accuracy_ratio: run?.summary?.overall?.accuracy_ratio || 0,
      overall_accuracy: run?.summary?.overall?.accuracy || 0,
      miss_count: run?.summary?.miss_count || 0,
      gate_ok: Boolean(run?.ok),
      candidate_count: Array.isArray(prepared?.fixture_candidates) ? prepared.fixture_candidates.length : 0,
    },
    artifacts: {
      initial_eval_json: path.join(sessionDir, "01-routing-eval.json"),
      initial_eval_report: path.join(sessionDir, "02-routing-eval-report.txt"),
      fixture_candidates_json: path.join(sessionDir, "03-routing-eval-candidates.json"),
      review_checklist: path.join(sessionDir, "04-review-checklist.md"),
      rerun_eval_json: path.join(sessionDir, "05-rerun-routing-eval.json"),
      rerun_eval_report: path.join(sessionDir, "06-rerun-routing-eval-report.txt"),
    },
  };
}

function buildReviewChecklist({
  sessionId,
  sessionDir,
  datasetPath,
  prefer,
  run,
  prepared,
}) {
  const summary = run?.summary || {};
  const candidateCount = Array.isArray(prepared?.fixture_candidates) ? prepared.fixture_candidates.length : 0;
  const updateExisting = (prepared?.fixture_candidates || [])
    .filter((item) => item?.suggested_dataset_action === "update_existing_fixture")
    .length;
  const addFixture = (prepared?.fixture_candidates || [])
    .filter((item) => item?.suggested_dataset_action === "add_fixture")
    .length;

  return [
    "# Routing Eval Closed-Loop Review Checklist",
    "",
    `- Session: \`${sessionId}\``,
    `- Session dir: \`${sessionDir}\``,
    `- Dataset: \`${datasetPath}\``,
    `- Prefer mode: \`${prefer}\``,
    `- Eval gate: ${run?.ok ? "pass" : "fail"}`,
    `- Overall accuracy: ${summary?.overall?.accuracy || 0}%`,
    `- Miss count: ${summary?.miss_count || 0}`,
    `- Fixture candidates: ${candidateCount}`,
    `- update_existing_fixture: ${updateExisting}`,
    `- add_fixture: ${addFixture}`,
    "",
    "## Fixed Flow",
    "",
    "1. Eval",
    `   - Inspect \`01-routing-eval.json\` and \`02-routing-eval-report.txt\`.`,
    "2. Candidates",
    "   - Inspect `03-routing-eval-candidates.json`.",
    "3. Review",
    "   - Reject candidates that would encode current wrong behavior as expected behavior.",
    "   - Keep only cases backed by intended checked-in routing behavior or missing dataset coverage.",
    "4. Dataset",
    `   - Update \`${datasetPath}\` manually.`,
    "   - `update_existing_fixture`: update the existing case `expected` block.",
    "   - `add_fixture`: add a new `createCase(...)` entry from `fixture_source`.",
    "5. Eval",
    "   - Rerun through the same entrypoint:",
    "   - `npm run routing:closed-loop -- rerun`",
    "",
    "## Decision Guardrails",
    "",
    "- Update baseline only after an intentional routing behavior change has already been approved and checked into code.",
    "- Add or adjust dataset only when the checked-in behavior is already correct but coverage or labeling is incomplete.",
    "- Escalate to routing-rule change when repeated misses show the actual route is wrong for the intended behavior.",
  ].join("\n");
}

async function updatePointer(baseDir, payload) {
  await writeJson(path.join(baseDir, POINTER_FILE), payload);
}

async function loadPointer(baseDir) {
  const pointerPath = path.join(baseDir, POINTER_FILE);
  try {
    return JSON.parse(await readFile(pointerPath, "utf8"));
  } catch (error) {
    throw new Error(
      `latest session pointer not found at ${pointerPath}; run \`npm run routing:closed-loop\` first`,
    );
  }
}

async function runPrepare({
  baseDir,
  datasetPath,
  prefer,
}) {
  const sessionId = `routing-eval-${timestampToken()}`;
  const sessionDir = path.join(baseDir, sessionId);
  await mkdir(sessionDir, { recursive: true });

  const testCases = await loadRoutingEvalSet(datasetPath);
  const run = await runRoutingEval({ testCases });
  const prepared = prepareRoutingEvalFixtureCandidates({
    run,
    testCases,
    prefer,
  });
  const report = formatRoutingEvalReport(run);
  const metadata = buildSessionMetadata({
    sessionId,
    sessionDir,
    datasetPath,
    prefer,
    run,
    prepared,
  });

  await writeJson(metadata.artifacts.initial_eval_json, run);
  await writeText(metadata.artifacts.initial_eval_report, report);
  await writeJson(metadata.artifacts.fixture_candidates_json, prepared);
  await writeText(
    metadata.artifacts.review_checklist,
    buildReviewChecklist({
      sessionId,
      sessionDir,
      datasetPath,
      prefer,
      run,
      prepared,
    }),
  );
  await writeJson(path.join(sessionDir, "session.json"), metadata);
  await updatePointer(baseDir, metadata);

  console.log([
    "Routing eval closed loop prepared.",
    `Session: ${sessionId}`,
    `Session dir: ${sessionDir}`,
    `Dataset: ${datasetPath}`,
    `Eval gate: ${run.ok ? "pass" : "fail"}`,
    `Fixture candidates: ${prepared.fixture_candidates?.length || 0}`,
    `Review checklist: ${metadata.artifacts.review_checklist}`,
    "Next: review candidates, update dataset manually, then run `npm run routing:closed-loop -- rerun`.",
  ].join("\n"));

  process.exitCode = run.ok && prepared.ok ? 0 : 1;
}

async function resolveRerunContext(baseDir, sessionInput) {
  if (sessionInput) {
    const sessionDir = resolvePath(sessionInput);
    const metadata = JSON.parse(await readFile(path.join(sessionDir, "session.json"), "utf8"));
    return {
      sessionDir,
      metadata,
    };
  }

  const metadata = await loadPointer(baseDir);
  return {
    sessionDir: metadata.session_dir,
    metadata,
  };
}

async function runRerun({
  baseDir,
  datasetPath,
  sessionInput,
}) {
  const { sessionDir, metadata } = await resolveRerunContext(baseDir, sessionInput);
  const effectiveDatasetPath = datasetPath || metadata?.dataset_path || DEFAULT_DATASET_PATH;
  const testCases = await loadRoutingEvalSet(effectiveDatasetPath);
  const run = await runRoutingEval({ testCases });
  const report = formatRoutingEvalReport(run);

  await writeJson(path.join(sessionDir, "05-rerun-routing-eval.json"), run);
  await writeText(path.join(sessionDir, "06-rerun-routing-eval-report.txt"), report);

  const nextMetadata = {
    ...metadata,
    dataset_path: effectiveDatasetPath,
    rerun_at: new Date().toISOString(),
    rerun_summary: {
      total_cases: run?.summary?.total_cases || 0,
      overall_accuracy_ratio: run?.summary?.overall?.accuracy_ratio || 0,
      overall_accuracy: run?.summary?.overall?.accuracy || 0,
      miss_count: run?.summary?.miss_count || 0,
      gate_ok: Boolean(run?.ok),
    },
  };
  await writeJson(path.join(sessionDir, "session.json"), nextMetadata);
  await updatePointer(baseDir, nextMetadata);

  console.log([
    "Routing eval closed loop rerun complete.",
    `Session dir: ${sessionDir}`,
    `Dataset: ${effectiveDatasetPath}`,
    `Eval gate: ${run.ok ? "pass" : "fail"}`,
    `Rerun report: ${path.join(sessionDir, "06-rerun-routing-eval-report.txt")}`,
  ].join("\n"));

  process.exitCode = run.ok ? 0 : 1;
}

function printHelp() {
  console.log([
    "Usage:",
    "  npm run routing:closed-loop",
    "  npm run routing:closed-loop -- prepare [--out-dir <dir>] [--dataset <path>] [--prefer actual|expected]",
    "  npm run routing:closed-loop -- rerun [--out-dir <dir>] [--dataset <path>] [--session <session-dir>]",
    "",
    "Commands:",
    "  prepare  Run eval, generate fixture candidates, and create a review checklist. Default.",
    "  rerun    Re-run eval after dataset review/update, using the latest session unless --session is provided.",
  ].join("\n"));
}

const command = getCommand();
const baseDir = resolvePath(getArgValue("--out-dir"), DEFAULT_BASE_DIR);
const datasetPath = getArgValue("--dataset")
  ? resolvePath(getArgValue("--dataset"))
  : DEFAULT_DATASET_PATH;
const prefer = getArgValue("--prefer") || DEFAULT_PREFER;
const sessionInput = getArgValue("--session");

try {
  await mkdir(baseDir, { recursive: true });

  if (!["actual", "expected"].includes(prefer)) {
    throw new Error(`Unsupported --prefer value: ${prefer}`);
  }

  if (command === "help" || command === "--help" || process.argv.includes("--help")) {
    printHelp();
  } else if (command === "prepare") {
    await runPrepare({
      baseDir,
      datasetPath,
      prefer,
    });
  } else if (command === "rerun") {
    await runRerun({
      baseDir,
      datasetPath: getArgValue("--dataset")
        ? datasetPath
        : null,
      sessionInput,
    });
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  if (!(command === "help" || command === "--help" || process.argv.includes("--help"))) {
    printHelp();
  }
  process.exit(1);
}
