import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const file = path.resolve(__dirname, "../evals/real-user-review.json");

function log(entry) {
  let data = [];
  if (fs.existsSync(file)) {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  }
  data.push(entry);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.log("Logged:", entry.task);
}

const [task, lane, action, result_quality, issue = ""] = process.argv.slice(2);

if (!task || !lane || !action || !result_quality) {
  console.log('Usage: node scripts/real-user-review-log.mjs "<task>" "<lane>" "<action>" "<result_quality>" "<issue>"');
  process.exit(1);
}

log({ task, lane, action, result_quality, issue });
