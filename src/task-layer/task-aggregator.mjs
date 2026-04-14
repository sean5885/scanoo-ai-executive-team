export function aggregateResults({ tasks = [], results = [] } = {}) {
  const normalizedTasks = Array.isArray(tasks) ? tasks : [];
  const normalizedResults = Array.isArray(results) ? results : [];

  return normalizedResults.reduce((output, result) => {
    const task = result?.task;
    if (!task) {
      return output;
    }

    if (result?.ok === true) {
      output.data[task] = result.result;
      output.summary[task] = "done";
      return output;
    }

    const status = result?.status === "blocked" ? "blocked" : "failed";
    output.ok = false;
    output.summary[task] = status;
    const failure = {
      task,
      error: result?.error || "runtime_exception",
    };
    if (result?.blocked === true || status === "blocked") {
      failure.status = "blocked";
      failure.blocked = true;
    }
    if (typeof result?.failure_class === "string" && result.failure_class) {
      failure.failure_class = result.failure_class;
    }
    output.errors.push(failure);
    return output;
  }, {
    ok: normalizedResults.every((result) => result?.ok !== false),
    tasks: normalizedTasks,
    results: normalizedResults,
    summary: {},
    data: {},
    errors: [],
  });
}
