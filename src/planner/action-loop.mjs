import { createTaskAction } from '../actions/create-task-action.mjs';
import { updateDocAction } from '../actions/update-doc-action.mjs';
import { sendMessageAction } from '../actions/send-message-action.mjs';

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

export async function runActionLoop(plan, context) {
  const { action, params } = plan || {};
  const selectedSkill = resolveSelectedSkill(plan, context);
  const normalizedAction = normalizeText(action);

  if (isReadOnlySkill(selectedSkill) && isWriteAction(normalizedAction)) {
    return {
      ok: false,
      type: 'blocked_action',
      error: 'read_only_skill_cannot_execute_write_action',
      blocked: true,
      skill: selectedSkill,
      action: normalizedAction,
    };
  }

  if (!action) {
    return { ok: true, type: 'no_action', message: plan?.answer || '' };
  }

  if (action === 'send_message') {
    const result = await sendMessageAction({
      token: context.token,
      chat_id: context.chat_id,
      content: params?.content
    });

    return {
      ok: true,
      type: 'action_executed',
      action: 'send_message',
      result
    };
  }

  if (action === 'update_doc') {
    const result = await updateDocAction({
      token: context.token,
      token_type: params?.token_type || context?.token_type,
      doc_token: params?.doc_token,
      content: params?.content,
      mode: params?.mode || 'append'
    });
    return { ok: true, type: 'action_executed', action: 'update_doc', result };
  }
  if (action === "create_task") {
    const result = await createTaskAction({
      token: context.token,
      title: params?.title,
      due_time: params?.due_time
    });
    return { ok: true, type: "action_executed", action: "create_task", result };
  }
  return { ok: false, type: 'unsupported_action', action };
}
