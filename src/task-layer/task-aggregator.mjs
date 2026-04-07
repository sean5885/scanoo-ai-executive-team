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

    output.ok = false;
    output.summary[task] = "failed";
    output.errors.push({
      task,
      error: result?.error || "runtime_exception",
    });
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
