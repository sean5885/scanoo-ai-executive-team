export function buildRetryContextPack(ctx) {
  const {
    intent,
    slots,
    required_slots = [],
    waiting_user,
    last_failure,
    last_action,
    user_input_delta
  } = ctx || {};

  const fulfilled = Object.keys(slots || {}).filter(k => slots[k] != null);
  const missing = required_slots.filter(k => !fulfilled.includes(k));

  const continuation_ready = waiting_user && missing.length === 0;

  const degraded = !intent || (!continuation_ready && missing.length === required_slots.length);

  return {
    retry_allowed: true,
    degraded_retry: degraded,
    degraded_reason_codes: degraded ? ["no_context"] : [],
    resolved_intent: intent,
    latest_user_delta: user_input_delta,
    fulfilled_required_slots: fulfilled,
    truly_missing_required_slots: missing,
    waiting_state: waiting_user,
    resumable_step: continuation_ready ? last_action : null,
    last_failure_class: last_failure?.class,
    last_action,
    continuation_ready,
    resume_instead_of_retry: continuation_ready
  };
}
