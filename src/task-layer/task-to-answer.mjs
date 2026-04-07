import { cleanText } from "../message-intent-utils.mjs";

export function formatTaskLayerTaskLabel(task = "") {
  const normalized = cleanText(task);
  if (normalized === "copywriting") {
    return "文案";
  }
  if (normalized === "image") {
    return "圖片";
  }
  if (normalized === "publish") {
    return "發布";
  }
  return normalized || "未命名任務";
}

export function normalizeTaskLayerResult(taskLayerResult = null) {
  const tasks = Array.isArray(taskLayerResult?.tasks)
    ? taskLayerResult.tasks.map((task) => cleanText(task)).filter(Boolean)
    : [];
  const results = Array.isArray(taskLayerResult?.results)
    ? taskLayerResult.results
    : tasks.map((task) => {
        const taskName = cleanText(task);
        const status = cleanText(taskLayerResult?.summary?.[taskName]);
        if (status === "done") {
          return {
            task: taskName,
            ok: true,
            result: taskLayerResult?.data?.[taskName],
          };
        }
        const error = Array.isArray(taskLayerResult?.errors)
          ? taskLayerResult.errors.find((item) => cleanText(item?.task) === taskName)?.error
          : null;
        return {
          task: taskName,
          ok: false,
          error: cleanText(error) || "runtime_exception",
        };
      });
  const summary = tasks.reduce((output, task) => {
    output[task] = results.find((item) => cleanText(item?.task) === task)?.ok === true
      ? "done"
      : "failed";
    return output;
  }, {});
  const data = results.reduce((output, item) => {
    const task = cleanText(item?.task);
    if (task && item?.ok === true) {
      output[task] = item.result;
    }
    return output;
  }, {});
  const errors = results
    .filter((item) => item?.ok !== true)
    .map((item) => ({
      task: cleanText(item?.task) || null,
      error: cleanText(item?.error || "") || "runtime_exception",
    }))
    .filter((item) => item.task);
  const succeeded = results.filter((item) => item?.ok === true);
  const failed = results.filter((item) => item?.ok !== true);

  return {
    ok: succeeded.length > 0 || failed.length === 0,
    tasks,
    results,
    summary,
    data,
    errors,
    succeeded,
    failed,
  };
}

export function toUserFacing(taskLayerResult = null) {
  const normalized = normalizeTaskLayerResult(taskLayerResult);
  const {
    failed,
    succeeded,
    tasks,
  } = normalized;
  const taskSummary = tasks.map((task) => formatTaskLayerTaskLabel(task)).join("、");
  const answer = failed.length === 0
    ? `這輪先依多任務路徑拆成 ${tasks.length} 個子任務${taskSummary ? `：${taskSummary}` : ""}，並完成執行。`
    : succeeded.length > 0
      ? `這輪先依多任務路徑拆成 ${tasks.length} 個子任務${taskSummary ? `：${taskSummary}` : ""}，目前先完成其中 ${succeeded.length} 個。`
      : `這輪先依多任務路徑拆出 ${tasks.length} 個子任務${taskSummary ? `：${taskSummary}` : ""}，但目前都還沒有成功完成。`;
  const sources = [
    taskSummary ? `任務拆解：${taskSummary}。` : "",
    ...succeeded.map((item) => {
      const task = formatTaskLayerTaskLabel(item?.task || "");
      return `${task} 已完成執行。`;
    }),
  ].filter(Boolean);
  const limitations = failed.length > 0
    ? failed.map((item) => {
        const task = formatTaskLayerTaskLabel(item?.task || "");
        const error = cleanText(item?.error || "") || "runtime_exception";
        return `${task} 目前未完成：${error}。`;
      })
    : ["如果你要，我可以再把每個子任務展開成更完整的最終稿或後續步驟。"];

  return {
    ok: normalized.ok,
    answer,
    sources,
    limitations,
  };
}
