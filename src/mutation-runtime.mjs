// Unified Mutation Runtime (skeleton)

export async function runMutation({ action, payload, context, execute }) {

  // 1. policy
  // TODO

  // 2. guard
  // TODO

  // 3. evidence
  // TODO

  // 4. verifier
  // TODO

  // 5. admission
  // TODO

  if (typeof execute !== "function") {
    void payload;
    void context;

    return { ok: false, error: "missing_execute" };
  }

  const mode = context?.execution_mode || "passthrough";
  const start = Date.now();

  let result;
  try {
    if (mode === "controlled") {
      // controlled: 明確走 runtime 控制入口（目前仍調 execute，但已分流）
      result = await execute({
        action,
        payload,
        context,
        controlled: true,
      });
    } else {
      // passthrough
      result = await execute({
        action,
        payload,
        context,
      });
    }
  } catch {
    return {
      ok: false,
      action,
      error: "execution_failed",
      meta: {
        execution_mode: mode,
        duration_ms: Date.now() - start,
      },
    };
  }

  return {
    ok: true,
    action,
    result,
    meta: {
      execution_mode: mode,
      duration_ms: Date.now() - start,
    },
  };
}
