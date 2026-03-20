function cleanText(value) {
  return String(value || "").trim();
}

function firstMatch(text, patterns = []) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
    if (match?.[0]) {
      return match[0];
    }
  }
  return "";
}

export function extractLarkBitableReferenceFromText(value) {
  const raw = cleanText(value);
  if (!raw) {
    return null;
  }

  const appToken = firstMatch(raw, [
    /\/base\/([A-Za-z0-9_-]+)/i,
  ]);
  if (!appToken) {
    return null;
  }

  const url = firstMatch(raw, [/https?:\/\/[^\s<>"')]+/i]) || "";
  const tableId = firstMatch(raw, [
    /[?&#](?:table|table_id|tableId)=([A-Za-z0-9_-]+)/i,
  ]);
  const viewId = firstMatch(raw, [
    /[?&#](?:view|view_id|viewId)=([A-Za-z0-9_-]+)/i,
  ]);
  const recordId = firstMatch(raw, [
    /[?&#](?:record|record_id|recordId)=([A-Za-z0-9_-]+)/i,
  ]);

  return {
    url: url || raw,
    app_token: appToken,
    table_id: tableId || null,
    view_id: viewId || null,
    record_id: recordId || null,
  };
}
