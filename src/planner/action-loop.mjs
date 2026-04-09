import { createTaskAction } from '../actions/create-task-action.mjs';
import { updateDocAction } from '../actions/update-doc-action.mjs';
import { sendMessageAction } from '../actions/send-message-action.mjs';

export async function runActionLoop(plan, context) {
  const { action, params } = plan || {};

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
