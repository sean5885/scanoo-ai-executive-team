/**
 * 將模型輸出統一成 plan 結構
 * 支援：
 * 1. 純文字回答
 * 2. 帶 action 的結構
 */

export function normalizePlan(output) {
  if (!output) return { answer: '' };

  // 已經是結構化
  if (typeof output === 'object') {
    return output;
  }

  // 嘗試 parse JSON（模型可能回字串）
  try {
    const parsed = JSON.parse(output);
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  } catch (e) {}

  // fallback：當作純回答
  return {
    answer: output
  };
}
