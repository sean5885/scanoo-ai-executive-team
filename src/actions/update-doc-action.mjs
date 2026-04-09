import { updateDocument } from '../lark-content.mjs';
import { executeLarkWrite } from '../execute-lark-write.mjs';

function isAsciiText(value = '') {
  return !/[^\x20-\x7E]/.test(value);
}

function inferTokenType(token = '', explicitType = '') {
  if (explicitType === 'tenant' || explicitType === 'user') {
    return explicitType;
  }
  return String(token || '').startsWith('t-') ? 'tenant' : 'user';
}

export async function updateDocAction({
  token,
  token_type,
  doc_token,
  content,
  mode = 'append'
}) {
  if (!token) throw new Error('缺少 token');
  if (!doc_token) throw new Error('缺少 doc_token');
  if (!content) throw new Error('缺少 content');
  if (!isAsciiText(token)) {
    throw new Error('token 必須為 ASCII 字元（請使用真實英數 token，勿使用中文佔位字串）');
  }
  if (!isAsciiText(doc_token)) {
    throw new Error('doc_token 必須為 ASCII 字元（請使用真實 doc_token，勿使用中文佔位字串）');
  }

  const normalizedTokenType = inferTokenType(token, token_type);
  const execution = await executeLarkWrite({
    apiName: 'planner_update_doc_action',
    action: 'update_doc',
    pathname: 'internal:planner/action-loop/update_doc',
    accessToken: { access_token: token, token_type: normalizedTokenType },
    budget: {
      scopeKey: `document:${doc_token}`,
      documentId: doc_token,
      targetDocumentId: doc_token,
      content,
      payload: {
        mode
      }
    },
    performWrite: async ({ accessToken }) => updateDocument(
      accessToken,
      doc_token,
      content,
      mode,
      normalizedTokenType
    )
  });

  if (!execution?.ok) {
    throw new Error(`updateDoc 被拒絕: ${JSON.stringify(execution)}`);
  }

  return execution.result;
}
