export const DocType = {
  COMPANY_BRAIN: "company_brain",
  SOP: "sop",
  KNOWLEDGE: "knowledge",
};

export function createDocIndex() {
  return {
    version: "v1",
    docs: [],
  };
}

export function addDoc(index, doc) {
  if (!doc.id || !doc.type || !doc.content) {
    throw new Error("invalid_doc");
  }
  index.docs.push({
    id: doc.id,
    type: doc.type,
    content: doc.content,
    created_at: Date.now(),
  });
  return index;
}

export function findDocById(index, id) {
  return index.docs.find((d) => d.id === id);
}

export function searchDocs(index, keyword) {
  return index.docs.filter((d) => d.content.includes(keyword));
}

export function searchDocsByKeyword(index, keyword) {
  return index.docs.filter((d) =>
    d.content.toLowerCase().includes(keyword.toLowerCase()),
  );
}
