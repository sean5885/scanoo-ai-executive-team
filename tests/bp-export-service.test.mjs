import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateBusinessPlanArtifacts, buildBusinessPlanMarkdown } from "../src/bp-export-service.mjs";

const MODEL_JSON = JSON.stringify({
  company_name: "Scanoo",
  title: "Scanoo 商業計畫書",
  subtitle: "把實體流量轉成可持續互動與成交",
  executive_summary: "Scanoo 透過掃碼互動把現場流量轉成可持續會員資產。",
  problem: "市集與活動現場常見流量高、轉化低、缺少後續追蹤。",
  solution: "提供掃碼互動頁、會員承接與商家後台。",
  target_customer: "市集主辦方、展會主辦、快閃活動品牌。",
  market: "活動與展會數位化需求上升，商家需要更可量化的導流工具。",
  competition: "與單純加 LINE 或單點表單工具相比，Scanoo 更重視中段互動與轉化。",
  business_model: "SaaS 年費加活動方案費，另可收企業客製服務費。",
  go_to_market: "先從既有合作市集與展會切入，再用案例擴散到品牌與場館端。",
  traction: "已有大型活動驗證可提升互動與名單收集效率。",
  financial_plan: "前期以產品化與商務拓展為主，控制人事與導入成本。",
  roadmap: "先完善標準化產品，再擴展分析報表與 CRM 串接。",
  risks: "市場教育成本與導入週期是主要風險。",
  funding_ask: "希望募集 300 萬台幣，用於產品開發與商務拓展。",
  next_steps: ["補齊 3 個客戶案例", "整理標準銷售簡報", "建立 KPI 儀表板"],
  slides: [
    {
      title: "市場痛點",
      bullets: ["現場流量大但留存低", "互動資料分散", "主辦方難量化成效"],
      speaker_notes: "先讓投資人理解這不是單點工具問題，而是漏斗斷層。",
    },
    {
      title: "解決方案",
      bullets: ["掃碼互動入口", "會員承接頁", "數據追蹤後台"],
      speaker_notes: "說明產品如何承接從曝光到互動的中段流程。",
    },
  ],
});

test("buildBusinessPlanMarkdown renders core sections", () => {
  const markdown = buildBusinessPlanMarkdown({
    title: "Scanoo 商業計畫書",
    executive_summary: "摘要",
    problem: "痛點",
    solution: "方案",
    next_steps: ["下一步 1"],
    slides: [{ title: "投影片 1", bullets: ["重點 1"], speaker_notes: "" }],
  });
  assert.match(markdown, /# Scanoo 商業計畫書/);
  assert.match(markdown, /## 執行摘要/);
  assert.match(markdown, /## 下一步/);
  assert.match(markdown, /## 簡報骨架/);
});

test("generateBusinessPlanArtifacts writes json md docx pdf pptx", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bp-export-test-"));
  const result = await generateBusinessPlanArtifacts({
    brief: "Scanoo 想把活動現場掃碼互動做成可規模化的 SaaS 產品。",
    companyName: "Scanoo",
    outputDir: tempDir,
    fileBaseName: "scanoo-bp",
    generateTextFn: async () => MODEL_JSON,
  });

  assert.equal(result.plan.company_name, "Scanoo");
  assert.equal(result.plan.title, "Scanoo 商業計畫書");
  assert.equal(Array.isArray(result.plan.slides), true);
  assert.equal(result.plan.slides.length >= 2, true);

  const artifactPaths = Object.values(result.artifacts);
  for (const artifactPath of artifactPaths) {
    if (artifactPath === tempDir) {
      continue;
    }
    const stat = await fs.stat(artifactPath);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.size > 0, true);
  }

  const payload = JSON.parse(await fs.readFile(result.artifacts.json_path, "utf8"));
  assert.equal(payload.title, "Scanoo 商業計畫書");
  const markdown = await fs.readFile(result.artifacts.markdown_path, "utf8");
  assert.match(markdown, /市場痛點|痛點/);
});
