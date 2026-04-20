import { cleanText } from "../src/message-intent-utils.mjs";
import {
  applyAutonomyIncidentDisposition,
  listAutonomyOpenIncidents,
} from "../src/task-runtime/autonomy-job-store.mjs";

const COMMAND = Object.freeze({
  listOpen: "list-open",
  disposition: "disposition",
});

const ALLOWED_DISPOSITION_ACTION = new Set([
  "ack_waiting_user",
  "ack_escalated",
  "resume_same_job",
]);

function printUsage() {
  console.log([
    "Usage:",
    "  node scripts/autonomy-operator-cli.mjs list-open [--limit <number>]",
    "  node scripts/autonomy-operator-cli.mjs disposition \\",
    "    --job-id <id> \\",
    "    --action <ack_waiting_user|ack_escalated|resume_same_job> \\",
    "    --reason <text> \\",
    "    --operator-id <id> \\",
    "    --request-id <id> \\",
    "    --expected-updated-at <iso8601>",
  ].join("\n"));
}

function printJson(payload = {}) {
  console.log(JSON.stringify(payload, null, 2));
}

function getArgValue(flag = "") {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return null;
  }
  return process.argv[index + 1] || null;
}

function normalizePositiveInteger(value, fallback = 100) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function readDispositionInput() {
  const jobId = cleanText(getArgValue("--job-id"));
  const action = cleanText(getArgValue("--action"));
  const reason = cleanText(getArgValue("--reason"));
  const operatorId = cleanText(getArgValue("--operator-id"));
  const requestId = cleanText(getArgValue("--request-id"));
  const expectedUpdatedAt = cleanText(getArgValue("--expected-updated-at"));
  const missingFields = [];
  if (!jobId) {
    missingFields.push("job_id");
  }
  if (!action) {
    missingFields.push("action");
  }
  if (!reason) {
    missingFields.push("reason");
  }
  if (!operatorId) {
    missingFields.push("operator_id");
  }
  if (!requestId) {
    missingFields.push("request_id");
  }
  if (!expectedUpdatedAt) {
    missingFields.push("expected_updated_at");
  }
  return {
    jobId,
    action,
    reason,
    operatorId,
    requestId,
    expectedUpdatedAt,
    missingFields,
  };
}

function runListOpen() {
  const explicitLimit = getArgValue("--limit");
  const positionalLimit = cleanText(process.argv[3]);
  const limit = normalizePositiveInteger(explicitLimit || positionalLimit, 100);
  const incidents = listAutonomyOpenIncidents({ limit });
  printJson({
    ok: true,
    command: COMMAND.listOpen,
    total: incidents.length,
    incidents,
  });
}

function runDisposition() {
  const input = readDispositionInput();
  if (input.missingFields.length > 0) {
    printJson({
      ok: false,
      error: "invalid_operator_disposition_input",
      missing_fields: input.missingFields,
    });
    process.exitCode = 1;
    return;
  }
  if (!ALLOWED_DISPOSITION_ACTION.has(input.action)) {
    printJson({
      ok: false,
      error: "invalid_operator_disposition_input",
      invalid_action: input.action,
      allowed_actions: Array.from(ALLOWED_DISPOSITION_ACTION),
    });
    process.exitCode = 1;
    return;
  }

  const result = applyAutonomyIncidentDisposition({
    jobId: input.jobId,
    action: input.action,
    reason: input.reason,
    operatorId: input.operatorId,
    requestId: input.requestId,
    precondition: {
      expected_updated_at: input.expectedUpdatedAt,
    },
    expected_updated_at: input.expectedUpdatedAt,
  });
  printJson(result);
  if (!result?.ok) {
    process.exitCode = 1;
  }
}

function main() {
  const command = cleanText(process.argv[2]).toLowerCase();
  if (!command || command === "--help" || command === "-h") {
    printUsage();
    return;
  }
  if (command === COMMAND.listOpen) {
    runListOpen();
    return;
  }
  if (command === COMMAND.disposition) {
    runDisposition();
    return;
  }
  printUsage();
  process.exitCode = 1;
}

main();
