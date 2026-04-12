import { resolveToolContract } from './tool-layer-contract.mjs';

export async function executeTool(action, args = {}, ctx = {}) {
  const contract = resolveToolContract(action);
  if (!contract) {
    return { ok: false, error: 'unknown_tool_action' };
  }

  try {
    // --- mock execution layer (可替換為真實 API / DB / service) ---
    let result = null;

    if (action === 'search_company_brain_docs') {
      const query = args?.q ?? args?.query ?? '';
      result = { docs: [`result for ${query}`] };
    }

    if (action === 'official_read_document') {
      result = { content: `document: ${args.document_ref}` };
    }

    if (action === 'answer_user_directly') {
      result = { answer: args.answer };
    }

    return {
      ok: true,
      action,
      result,
      next: contract.on_success_next,
    };
  } catch (e) {
    return {
      ok: false,
      error: 'tool_execution_failed',
      next: contract.on_failure_next,
    };
  }
}
