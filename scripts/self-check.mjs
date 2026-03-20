import { runSystemSelfCheck } from "../src/system-self-check.mjs";

const result = await runSystemSelfCheck();
console.log(JSON.stringify(result, null, 2));

if (!result.ok) {
  process.exitCode = 1;
}
