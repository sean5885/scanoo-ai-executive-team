import { classifyTask } from "./task-classifier.mjs";
import { TASK_SKILL_MAP } from "./task-skill-map.mjs";

export async function runTaskLayer(input, runSkill) {
  const tasks = classifyTask(input);
  const results = [];

  for (const task of tasks) {
    const skill = TASK_SKILL_MAP[task];
    if (!skill) {
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
    }
  }

  return { tasks, results };
}
