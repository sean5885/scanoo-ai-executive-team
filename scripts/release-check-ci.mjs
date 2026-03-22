const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (() => true);

try {
  let getReleaseCheckExitCode;
  let runReleaseCheck;
  let result;

  try {
    ({
      getReleaseCheckExitCode,
      runReleaseCheck,
    } = await import("../src/release-check.mjs"));
    result = await runReleaseCheck();
  } finally {
    process.stdout.write = originalWrite;
  }

  const report = result?.report || {
    overall_status: "fail",
    blocking_checks: ["system_regression"],
    suggested_next_step: "release-check 執行失敗，先看 system regression 的基礎模組：src/agent-registry.mjs、src/http-route-contracts.mjs、src/*-service.mjs。",
  };

  console.log(JSON.stringify(report, null, 2));
  process.exit(getReleaseCheckExitCode(report));
} catch (error) {
  process.stdout.write = originalWrite;
  console.error(`release-check ci error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
