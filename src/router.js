function route(q = "", { activeDoc = null, activeCandidates = [] } = {}) {
  const text = String(q || "");
  if (/整理|解釋/.test(text)) return "search_and_detail_doc";
  if (/找|搜尋|查/.test(text)) return "search_company_brain_docs";
  if (
    Array.isArray(activeCandidates)
    && activeCandidates.length > 0
    && /第(?:1|一|2|二|3|三|4|四|5|五)份|第(?:1|一|2|二|3|三|4|四|5|五)個|打開第(?:1|一|2|二|3|三|4|四|5|五)/.test(text)
  ) {
    return "get_company_brain_doc_detail";
  }
  if (/這份文件|那份文件|這個文件|這份|那份|這個/.test(text)) {
    return activeDoc?.doc_id ? "get_company_brain_doc_detail" : "search_and_detail_doc";
  }
  if (/打開|讀|內容|寫了什麼/.test(text)) {
    return activeDoc?.doc_id ? "get_company_brain_doc_detail" : "search_and_detail_doc";
  }
  return null;
}

export { route };
export default { route };
