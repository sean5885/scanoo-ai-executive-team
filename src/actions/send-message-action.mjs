/**
 * 發送 Lark 訊息（最小可用版本）
 * 必填：
 * - token：使用者或 tenant access token
 * - chat_id：目標聊天 ID
 * - content：文字內容
 */
function isAsciiText(value = "") {
  return !/[^\x20-\x7E]/.test(value);
}

export async function sendMessageAction({ token, chat_id, content }) {
  // 基本參數檢查
  if (!token) throw new Error('缺少 token（授權憑證）');
  if (!chat_id) throw new Error('缺少 chat_id（聊天 ID）');
  if (!content) throw new Error('缺少 content（訊息內容）');
  if (!isAsciiText(token)) {
    throw new Error('token 必須為 ASCII 字元（請使用真實英數 token，勿使用中文佔位字串）');
  }
  if (!isAsciiText(chat_id)) {
    throw new Error('chat_id 必須為 ASCII 字元（請使用真實 chat_id，勿使用中文佔位字串）');
  }

  // 呼叫 Lark API 發送訊息
  const response = await fetch('https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=chat_id', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      receive_id: chat_id,
      msg_type: 'text',
      content: JSON.stringify({ text: content })
    })
  });

  // 解析回傳結果
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const data = contentType.includes('application/json')
    ? await response.json()
    : { raw: await response.text() };

  // 錯誤處理
  if (!response.ok) {
    throw new Error(`發送訊息失敗：${JSON.stringify(data)}`);
  }

  return data;
}
