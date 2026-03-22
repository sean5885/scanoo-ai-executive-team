import fs from "fs";
import path from "path";
import { createDocIndex, addDoc, DocType } from "./doc-index.mjs";

export function loadDocsFromDir(dir) {
  const index = createDocIndex();
  const files = fs.readdirSync(dir);

  for (const f of files) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isFile() && f.endsWith(".md")) {
      const content = fs.readFileSync(p, "utf-8");
      addDoc(index, {
        id: f,
        type: DocType.COMPANY_BRAIN,
        content,
      });
    }
  }

  return index;
}
