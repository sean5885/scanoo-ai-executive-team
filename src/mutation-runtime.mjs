// Unified Mutation Runtime (skeleton)

export async function runMutation(input) {
  const { action, payload, context } = input;

  // 1. policy
  // TODO: evaluate policy

  // 2. guard
  // TODO: enforce guard

  // 3. evidence
  // TODO: attach evidence

  // 4. verifier
  // TODO: run verifier

  // 5. admission
  // TODO: final gate

  void payload;
  void context;

  // TEMP: passthrough (no-op)
  return {
    ok: true,
    action,
    note: "mutation runtime skeleton (no enforcement yet)",
  };
}
