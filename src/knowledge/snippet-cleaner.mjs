export function cleanSnippet(text, keyword) {
  if (!text) return '';

  let t = text.trim();

  // 去掉 markdown heading
  t = t.replace(/^#{1,6}\s+/gm, '');

  // 去掉 markdown link 外殼，保留文字
  t = t.replace(/\[([^\]]+)\]\(([^)]+)?\)/g, '$1');

  // 去掉清單殘片與反引號
  t = t.replace(/^\s*[-*+]\s+/gm, '');
  t = t.replace(/`+/g, '');

  // 去掉 mac / unix 絕對路徑
  t = t.replace(/\/Users\/[^\s]+/g, '');
  t = t.replace(/\/[A-Za-z0-9._\-\/]+/g, (m) => {
    return m.includes(' ') ? m : '';
  });

  // 去掉標題型前綴
  t = t.replace(/^(Loop Runbook|Purpose|Overview|Summary)\s+/i, '');
  t = t.replace(/^[A-Za-z\s\/]+-\s*/, '');
  if (/^[A-Za-z\s]+\/[A-Za-z\s]+$/.test(t)) return '';

  // 空白正規化
  t = t.replace(/\s+/g, ' ').trim();

  // 保留 keyword 附近
  const k = (keyword || '').toLowerCase();
  const lower = t.toLowerCase();
  const i = lower.indexOf(k);

  if (i !== -1) {
    const start = Math.max(0, i - 60);
    const end = Math.min(t.length, i + 60);
    t = t.slice(start, end);
  }

  // 收尾清理
  t = t.replace(/^[^A-Za-z\u4e00-\u9fa5]+/, '').trim();

  // 長度限制
  if (t.length > 120) t = t.slice(0, 120) + '...';

  return t.trim();
}
