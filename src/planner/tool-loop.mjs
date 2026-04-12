import { runActionLoop } from './action-loop.mjs';

const WRITE_ACTIONS = Object.freeze([
  'send_message',
  'update_doc',
  'create_task',
  'write_memory',
  'update_record',
]);

const READ_ONLY_SKILLS = Object.freeze([
  'search_and_summarize',
  'document_summarize',
  'search_company_brain_docs',
  'official_read_document',
]);

function normalizeText(value = '') {
  return String(value || '').trim();
}

function isWriteAction(action = '') {
  return WRITE_ACTIONS.includes(normalizeText(action));
}

function isReadOnlySkill(skillName = '') {
  return READ_ONLY_SKILLS.includes(normalizeText(skillName));
}

function resolveSelectedSkill(plan = {}, context = {}) {
  return normalizeText(
    context?.selected_skill
      || context?.skill_name
      || plan?.skill_name
      || plan?.selected_skill
      || ''
  );
}

function resolvePlannedAction(plan = {}, context = {}) {
  const candidates = [
    plan?.action,
    plan?.tool_action,
    context?.action,
    context?.tool_action,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeText(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return '';
}

export async function runToolLoop({ plan, context, max_steps = 3 }) {
  const selectedSkill = resolveSelectedSkill(plan, context);
  const plannedAction = resolvePlannedAction(plan, context);

  if (isReadOnlySkill(selectedSkill) && isWriteAction(plannedAction)) {
    return {
      ok: false,
      type: 'tool_loop',
      error: 'read_only_skill_cannot_execute_write_action',
      blocked: true,
      skill: selectedSkill,
      action: plannedAction,
    };
  }

  let currentPlan = plan;
  const steps = [];

  for (let i = 0; i < max_steps; i++) {
    if (!currentPlan || !currentPlan.action) break;

    const result = await runActionLoop(currentPlan, context);

    steps.push({
      step: i + 1,
      action: currentPlan.action,
      params: currentPlan.params || {},
      result
    });

    if (result?.blocked === true && result?.error === 'read_only_skill_cannot_execute_write_action') {
      return {
        ok: false,
        type: 'tool_loop',
        error: 'read_only_skill_cannot_execute_write_action',
        blocked: true,
        skill: result?.skill || selectedSkill || null,
        action: result?.action || normalizeText(currentPlan.action) || null,
        steps,
      };
    }

    if (!result || result.type !== 'action_executed') break;

    const nextAction = currentPlan.next_action;
    if (!nextAction || !nextAction.action) break;

    currentPlan = nextAction;
  }

  return {
    ok: true,
    type: 'tool_loop',
    steps
  };
}
