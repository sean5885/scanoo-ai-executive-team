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

  return { ok: false, type: 'unsupported_action', action };
}
