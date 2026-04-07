import { classifyTask } from "./task-classifier.mjs";
import { TASK_SKILL_MAP } from "./task-skill-map.mjs";
import { aggregateResults } from "./task-aggregator.mjs";
import { sortTasks } from "./task-dependency.mjs";

export async function runTaskLayer(input, runSkill) {
  const tasks = sortTasks(classifyTask(input));
  const results = [];

  for (const task of tasks) {
    const skill = TASK_SKILL_MAP[task];
    if (!skill) {
      results.push({
        task,
        ok: false,
        error: "no_skill_mapped",
      });
      continue;
    }

    try {
      const result = await runSkill(skill, { input, task });
      results.push({ task, ok: true, result });
    } catch (error) {
      results.push({
        task,
        ok: false,
        error: error?.message || String(error),
      });
      // Fail soft: keep advancing remaining tasks even if one task fails.
      continue;
    }
  }

  return aggregateResults({ tasks, results });
}
