import { execSync } from "child_process";

function run(cmd) {
  try {
    const out = execSync(cmd, { stdio: "pipe" }).toString();
    console.log(`\n=== ${cmd} ===\n${out}`);
    return true;
  } catch (e) {
    console.log(`\n=== ${cmd} FAILED ===\n${e.stdout?.toString()}`);
    return false;
  }
}

let ok = true;

// 1. retrieval
ok = run("node scripts/retrieval-eval.mjs") && ok;

// 2. routing
ok = run("node tests/routing-eval-lite.mjs") && ok;

// 3. real-world retrieval
ok = run("node scripts/retrieval-realworld-eval.mjs") && ok;

// 4. doc workflow
ok = run("node scripts/doc-workflow-eval.mjs") && ok;

// 5. runtime workflow
ok = run("node scripts/runtime-workflow-eval.mjs") && ok;

// summary
console.log("\nREGRESSION RESULT:", ok ? "PASS" : "FAIL");

if (!ok) {
  process.exit(1);
}
