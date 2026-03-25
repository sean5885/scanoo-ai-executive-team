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

  const result = await execute({
    action,
    payload,
    context,
  });

  return {
    ok: true,
    action,
    result,
    meta: {
      execution_mode: "passthrough",
    },
  };
}
