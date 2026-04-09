export function renderExecutionResult(executionResult) {
  if (!executionResult || executionResult.type !== 'execution_result') {
    return '';
  }

  const steps = executionResult?.result?.steps || [];
  if (!steps.length) {
    return '已完成處理';
  }

  const lines = [];

  for (const step of steps) {
    const action = step?.action;
    const result = step?.result || {};
    const data = result?.result?.data || result?.result || {};

    if (action === 'send_message') {
      const messageId = data?.message_id || data?.data?.message_id;
      lines.push(messageId ? `已發送訊息（message_id: ${messageId}）` : '已發送訊息');
      continue;
    }

    if (action === 'update_doc') {
      const docId = data?.document_id || data?.doc_token || data?.document?.document_id;
      const revisionId = data?.revision_id;
      if (docId && revisionId) {
        lines.push(`已更新文件（doc: ${docId}, revision: ${revisionId}）`);
      } else if (docId) {
        lines.push(`已更新文件（doc: ${docId}）`);
      } else {
        lines.push('已更新文件');
      }
      continue;
    }

    if (action === 'create_task') {
      const title = data?.summary || data?.title;
      const url = data?.url;
      if (title && url) {
        lines.push(`已建立任務：${title}（${url}）`);
      } else if (title) {
        lines.push(`已建立任務：${title}`);
      } else {
        lines.push('已建立任務');
      }
      continue;
    }

    lines.push(`已執行動作：${action}`);
  }

  return lines.join('\n');
}
