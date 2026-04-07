const TASK_PATTERNS = [
  ["copywriting", /(文案|撰寫|寫作|copy)/i],
  ["image", /(圖片|圖像|配圖|插圖|image)/i],
  ["publish", /(發布|發佈|發文|上線|publish)/i],
];

export function classifyTask(input = "") {
  const text = String(input);
  const tasks = [];

  for (const [task, pattern] of TASK_PATTERNS) {
    if (pattern.test(text)) {
      tasks.push(task);
    }
  }

  return tasks;
}
