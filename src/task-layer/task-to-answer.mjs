import { cleanText } from "../message-intent-utils.mjs";
import { getSkillRegistryEntry } from "../skill-registry.mjs";

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
        const status = cleanText(taskLayerResult?.summary?.[taskName]).toLowerCase();
        const errorEntry = Array.isArray(taskLayerResult?.errors)
          ? taskLayerResult.errors.find((item) => cleanText(item?.task) === taskName)
          : null;
        if (status === "done") {
          return {
            task: taskName,
            status: "done",
            ok: true,
            result: taskLayerResult?.data?.[taskName],
          };
        }
        return {
          task: taskName,
          status: status === "blocked" ? "blocked" : "failed",
          ok: false,
          blocked: status === "blocked",
          failure_class: cleanText(errorEntry?.failure_class || "") || null,
          error: cleanText(errorEntry?.error || "") || "runtime_exception",
        };
      });
  const normalizedResults = results.map((item) => {
    const status = cleanText(item?.status || "").toLowerCase();
    const normalizedStatus = status === "done"
      ? "done"
      : status === "blocked"
        ? "blocked"
        : item?.ok === true
          ? "done"
          : "failed";
    return {
      ...item,
      status: normalizedStatus,
      ok: normalizedStatus === "done" && item?.ok === true,
      blocked: item?.blocked === true || normalizedStatus === "blocked",
      failure_class: cleanText(item?.failure_class || item?.details?.failure_class || "") || null,
      error: normalizedStatus === "done"
        ? null
        : cleanText(item?.error || item?.details?.reason || item?.details?.message || "") || "runtime_exception",
    };
  });
  const imageGuardedResults = normalizedResults.map((item) => {
    if (cleanText(item?.task) !== "image" || item?.status !== "done") {
      return item;
    }
    const imageAsset = extractImageAsset(item?.result);
    if (!isPlaceholderImageAsset(imageAsset)) {
      return item;
    }
    return {
      ...item,
      status: "blocked",
      ok: false,
      blocked: true,
      failure_class: "capability_gap",
      error: "placeholder_output_blocked",
      result: null,
    };
  });
  const guardedResults = imageGuardedResults.map((item) => {
    if (item?.status !== "done") {
      return item;
    }
    const task = cleanText(item?.task);
    const skill = resolveTaskSkillName(item);
    const registered = skill ? Boolean(getSkillRegistryEntry(skill)) : false;
    if (task !== "publish" && (!skill || registered)) {
      return item;
    }
    if (task === "publish" && skill && registered) {
      return item;
    }
    return {
      ...item,
      status: "failed",
      ok: false,
      blocked: false,
      failure_class: "contract_violation",
      error: "skill_not_registered",
      result: null,
    };
  });
  const summary = tasks.reduce((output, task) => {
    const status = guardedResults.find((item) => cleanText(item?.task) === task)?.status;
    output[task] = status === "done" ? "done" : status === "blocked" ? "blocked" : "failed";
    return output;
  }, {});
  const data = guardedResults.reduce((output, item) => {
    const task = cleanText(item?.task);
    if (task && item?.status === "done") {
      output[task] = item.result;
    }
    return output;
  }, {});
  const errors = guardedResults
    .filter((item) => item?.status !== "done")
    .map((item) => {
      const failure = {
        task: cleanText(item?.task) || null,
        error: cleanText(item?.error || "") || "runtime_exception",
      };
      if (item?.status === "blocked") {
        failure.status = "blocked";
        failure.blocked = true;
      }
      if (cleanText(item?.failure_class || "")) {
        failure.failure_class = cleanText(item.failure_class);
      }
      return failure;
    })
    .filter((item) => item.task);
  const succeeded = guardedResults.filter((item) => item?.status === "done");
  const failed = guardedResults.filter((item) => item?.status !== "done");
  const partial = succeeded.length > 0 && failed.length > 0;

  return {
    ok: succeeded.length > 0 || failed.length === 0,
    partial,
    tasks,
    results: guardedResults,
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

function extractImageAsset(raw = null) {
  if (typeof raw === "string") {
    return extractTextCandidate(raw);
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return "";
  }

  const direct = pickFirstText(raw, ["url", "image", "path", "file", "asset"]);
  if (direct) {
    return direct;
  }

  const nestedOutput = raw.output && typeof raw.output === "object" && !Array.isArray(raw.output)
    ? pickFirstText(raw.output, ["url", "image", "path", "file", "asset"])
    : "";
  if (nestedOutput) {
    return nestedOutput;
  }

  const nestedData = raw.data && typeof raw.data === "object" && !Array.isArray(raw.data)
    ? pickFirstText(raw.data, ["url", "image", "path", "file", "asset"])
    : "";
  return nestedData;
}

function isPlaceholderImageAsset(asset = "") {
  const normalized = extractTextCandidate(asset).toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("dummyimage.com")
    || normalized.includes("via.placeholder.com")
    || normalized.includes("placehold.co")
    || normalized.includes("placeholder")
  );
}

function resolveTaskSkillName(item = {}) {
  return cleanText(
    item?.skill
    || item?.result?.skill
    || item?.result?.handledBy
    || "",
  );
}

function renderCopywritingAnswer(data = {}) {
  const raw = data.copywriting;
  const directContent = typeof raw === "string"
    ? extractTextCandidate(raw)
    : pickFirstText(raw, ["copywriting", "answer", "content", "text", "draft", "caption", "body"]);
  const nestedOutputContent = !directContent && raw && typeof raw === "object" && !Array.isArray(raw)
    ? pickFirstText(raw.output, ["copywriting", "answer", "content", "text", "draft", "caption", "body", "summary"])
    : "";
  const content = directContent || nestedOutputContent;

  return content ? `文案：${content}` : "";
}

function renderImageAnswer(data = {}) {
  const raw = data.image;
  const asset = extractImageAsset(raw);

  if (!raw) {
    return "";
  }
  if (isPlaceholderImageAsset(asset)) {
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
  const nestedOutputDestination = !destination && raw && typeof raw === "object" && !Array.isArray(raw)
    ? pickFirstText(raw.output, ["channel", "platform", "destination", "target"])
    : "";
  const normalizedDestination = destination || nestedOutputDestination;

  return normalizedDestination
    ? `發布：已完成（${normalizedDestination}）`
    : "發布：已完成";
}

function explainTaskFailure(item = {}) {
  const normalized = cleanText(item?.error || "");
  const status = cleanText(item?.status || "").toLowerCase();
  const failureClass = cleanText(item?.failure_class || "").toLowerCase();
  if (normalized === "placeholder_output_blocked") {
    return "輸出被安全規則攔截（placeholder URL 不視為有效圖片結果）。";
  }
  if (
    normalized === "business_error"
    && failureClass === "capability_gap"
  ) {
    return "目前缺少可用 image backend，系統已 fail-closed 並阻擋偽成功輸出。";
  }
  if (status === "blocked") {
    return "這一步目前被阻擋，尚未滿足執行條件。";
  }
  if (!normalized || normalized === "runtime_exception") {
    return "執行路徑目前沒有穩定完成。";
  }
  if (normalized === "no_skill_mapped") {
    return "目前沒有可用執行能力可直接完成這一步。";
  }
  if (normalized === "skill_not_registered") {
    return "目前映射到的能力未在 checked-in skill registry 註冊，系統已 fail-closed。";
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
          return `${task} ${explainTaskFailure(item)}`;
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
