import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";

async function createSelfCheckFixture(payload = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "truthful-acceptance-"));
  const filePath = path.join(dir, "self-check.json");
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return filePath;
}

test("truthful acceptance script reports pass when all A-grade checks pass", async () => {
  const fixturePath = await createSelfCheckFixture({
    truthful_completion_metrics: {
      version: "truthful_completion_metrics_v1",
      thresholds: {
        pdf_success_rate_min: 0.9,
        pdf_min_case_count: 50,
        fake_completion_rate_max: 0.02,
        verifier_coverage_rate_min: 1,
        parallel_ratio_min: 0.4,
        blocked_misreported_completed_max: 0,
        documentation_consistency_rate_min: 1,
      },
      metrics: {
        pdf_task_success_rate: 0.95,
        pdf_e2e_total: 55,
        fake_completion_rate: 0.01,
        verifier_coverage_rate: 1,
        parallel_ratio: 0.5,
        blocked_misreported_completed_count: 0,
        documentation_consistency_rate: 1,
      },
    },
    self_check_archive: {
      run_id: "self-check-fixture-pass",
    },
  });

  const output = execFileSync("node", ["scripts/truthful-completion-acceptance.mjs", "--from", fixturePath, "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
  });
  const parsed = JSON.parse(output);
  assert.equal(parsed.overall_status, "pass");
  assert.equal(parsed.failed_check_count, 0);
});

test("truthful acceptance script exits non-zero when thresholds fail", async () => {
  const fixturePath = await createSelfCheckFixture({
    truthful_completion_metrics: {
      version: "truthful_completion_metrics_v1",
      thresholds: {
        pdf_success_rate_min: 0.9,
        pdf_min_case_count: 50,
        fake_completion_rate_max: 0.02,
        verifier_coverage_rate_min: 1,
        parallel_ratio_min: 0.4,
        blocked_misreported_completed_max: 0,
        documentation_consistency_rate_min: 1,
      },
      metrics: {
        pdf_task_success_rate: 0.84,
        pdf_e2e_total: 49,
        fake_completion_rate: 0.03,
        verifier_coverage_rate: 0.95,
        parallel_ratio: 0.2,
        blocked_misreported_completed_count: 1,
        documentation_consistency_rate: 0.8,
      },
    },
  });

  let failed = false;
  try {
    execFileSync("node", ["scripts/truthful-completion-acceptance.mjs", "--from", fixturePath, "--json"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env,
    });
  } catch (error) {
    failed = true;
    const stdout = String(error?.stdout || "");
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.overall_status, "fail");
    assert.equal(parsed.failed_check_count > 0, true);
  }
  assert.equal(failed, true);
});
