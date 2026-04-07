export const TASK_ORDER = ["copywriting", "image", "publish"];

function getTaskOrderIndex(task) {
  const index = TASK_ORDER.indexOf(task);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

export function sortTasks(tasks = []) {
  return [...tasks].sort((a, b) => getTaskOrderIndex(a) - getTaskOrderIndex(b));
}
