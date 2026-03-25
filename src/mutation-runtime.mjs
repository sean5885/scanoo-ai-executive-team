// Unified Mutation Runtime (skeleton)

export async function runMutation(input) {
  const { action, payload, context, execute } = input;

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

  let result;
  if (mode === "controlled") {
    // controlled（暫時仍走原 execute，之後再接管）
    result = await execute({
      action,
      payload,
      context,
    });
  } else {
    // passthrough
    result = await execute({
      action,
      payload,
      context,
    });
  }

  return {
    ok: true,
    action,
    result,
    meta: {
      execution_mode: mode,
    },
  };
}
