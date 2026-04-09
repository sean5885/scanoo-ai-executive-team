export async function createTaskAction({ token, title, due_time }) {
  if (!token) throw new Error('缺少 token');
  if (!title) throw new Error('缺少 title');

  const res = await fetch(
    'https://open.larksuite.com/open-apis/task/v2/tasks',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        summary: title,
        due: due_time || undefined
      })
    }
  );

  const data = await res.json();

  if (!res.ok) {
    throw new Error(`createTask 失敗: ${JSON.stringify(data)}`);
  }

  return data;
}
