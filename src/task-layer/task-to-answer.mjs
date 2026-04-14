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
            status: "done",
            ok: true,
            result: taskLayerResult?.data?.[taskName],
          };
        }
        const error = Array.isArray(taskLayerResult?.errors)
          ? taskLayerResult.errors.find((item) => cleanText(item?.task) === taskName)?.error
          : null;
        return {
          task: taskName,
          status: "failed",
          ok: false,
          error: cleanText(error) || "runtime_exception",
        };
      });
  const normalizedResults = results.map((item) => ({
    ...item,
    status: cleanText(item?.status || "") || (item?.ok === true ? "done" : "failed"),
    ok: item?.ok === true,
  }));
  const summary = tasks.reduce((output, task) => {
    output[task] = normalizedResults.find((item) => cleanText(item?.task) === task)?.status === "done"
      ? "done"
      : "failed";
    return output;
  }, {});
  const data = normalizedResults.reduce((output, item) => {
    const task = cleanText(item?.task);
    if (task && item?.status === "done") {
      output[task] = item.result;
    }
    return output;
  }, {});
  const errors = normalizedResults
    .filter((item) => item?.status !== "done")
    .map((item) => ({
      task: cleanText(item?.task) || null,
      error: cleanText(item?.error || "") || "runtime_exception",
    }))
    .filter((item) => item.task);
  const succeeded = normalizedResults.filter((item) => item?.status === "done");
  const failed = normalizedResults.filter((item) => item?.status !== "done");
  const partial = succeeded.length > 0 && failed.length > 0;

  return {
    ok: succeeded.length > 0 || failed.length === 0,
    partial,
    tasks,
    results: normalizedResults,
    summary,
    data,
    errors,
    succeeded,
    failed,
  };
}

function extractTextCandidate(value) {
  const normalized = cleanText(value);
  return normalized || "";
}

function pickFirstText(value, keys = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }

  for (const key of keys) {
    const candidate = extractTextCandidate(value?.[key]);
    if (candidate) {
      return candidate;
    }
  }

  return "";
}

function renderCopywritingAnswer(data = {}) {
  const raw = data.copywriting;
  const content = typeof raw === "string"
    ? extractTextCandidate(raw)
    : pickFirstText(raw, ["copywriting", "answer", "content", "text", "draft", "caption", "body"]);

  return content ? `文案：${content}` : "";
}

function renderImageAnswer(data = {}) {
  const raw = data.image;
  const asset = typeof raw === "string"
    ? extractTextCandidate(raw)
    : pickFirstText(raw, ["url", "image", "path", "file", "asset"]);

  if (!raw) {
    return "";
  }

  return asset
    ? `圖片：已生成（${asset}）`
    : "圖片：已生成（可下載或查看）";
}

function renderPublishAnswer(data = {}) {
  const raw = data.publish;
  if (!raw) {
    return "";
  }

  const destination = typeof raw === "string"
    ? extractTextCandidate(raw)
    : pickFirstText(raw, ["channel", "platform", "destination", "target"]);

  return destination
    ? `發布：已完成（${destination}）`
    : "發布：已完成";
}

function explainTaskFailure(error = "") {
  const normalized = cleanText(error);
  if (!normalized || normalized === "runtime_exception") {
    return "執行路徑目前沒有穩定完成。";
  }
  if (normalized === "no_skill_mapped") {
    return "目前沒有可用執行能力可直接完成這一步。";
  }
  return `這一步目前未完成（${normalized}）。`;
}

export function toUserFacing(taskLayerResult = null) {
  const normalized = normalizeTaskLayerResult(taskLayerResult);
  const {
    data,
    failed,
    succeeded,
    tasks,
  } = normalized;
  const taskSummary = tasks.map((task) => formatTaskLayerTaskLabel(task)).join("、");
  const answerParts = [
    renderCopywritingAnswer(data),
    renderImageAnswer(data),
    renderPublishAnswer(data),
  ].filter(Boolean);
  const answer = answerParts.length > 0
    ? answerParts.join("\n")
    : failed.length === 0
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
    ? [
        ...failed.map((item) => {
          const task = formatTaskLayerTaskLabel(item?.task || "");
          return `${task} ${explainTaskFailure(item?.error || "")}`;
        }),
        "下一步：你可以讓我直接重試失敗項目，或指定要優先完成的子任務。",
      ]
    : ["下一步：如果你要，我可以把每個子任務展開成更完整的最終稿或後續步驟。"];

  return {
    ok: normalized.ok,
    partial: normalized.partial,
    answer,
    sources,
    limitations,
  };
}
