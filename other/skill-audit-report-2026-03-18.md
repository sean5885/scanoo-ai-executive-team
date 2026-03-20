# Skill 審核與更新報告

- 日期：2026-03-18
- 範圍：`~/.agents/skills`、`~/.codex/skills` 下所有含 `SKILL.md` 的 skill
- 審核流程：`skill-vetter`（安全 / 權限 / 適配）+ `skill-creator`（規格 / 設計 / 翻譯 / 結構）
- 全域修改：所有 `SKILL.md` 已統一重寫為繁體中文，補上用途、使用時機、限制、流程、輸出與風險欄位。

## /Users/seanhan/.agents/skills

### agent-tools
- 主要業務摘要：把大量外部 AI 能力統一收斂到單一 CLI，讓代理可快速調用生成、搜尋與自動化服務。
- 修改摘要：`SKILL.md` 已改寫為繁中統一格式；未搬移額外檔案
- 風險等級：`HIGH`

### biz-email-writer
- 主要業務摘要：把業務溝通需求快速轉成正式可寄送的郵件內容，降低跨語言與禮節風險。
- 修改摘要：`SKILL.md` 已改寫為繁中統一格式；未搬移額外檔案
- 風險等級：`LOW`

### code-review
- 主要業務摘要：在變更合併前提前抓出缺陷、回歸與安全問題，降低交付風險。
- 修改摘要：`SKILL.md` 已改寫為繁中統一格式；搬移至 `other/`：`SKILL.toon`
- 風險等級：`LOW`

### competitor-analysis
- 主要業務摘要：找出競品為何排名較高，以及可切入的內容與流量機會。
- 修改摘要：`SKILL.md` 已改寫為繁中統一格式；未搬移額外檔案
- 風險等級：`MEDIUM`

### content-strategy
- 主要業務摘要：把零散題材整理成可持續輸出的內容系統，支撐流量、品牌與轉換。
- 修改摘要：`SKILL.md` 已改寫為繁中統一格式；搬移至 `other/`：`evals`
- 風險等級：`LOW`

### copywriting
- 主要業務摘要：把產品價值轉成可轉換的文字，提升點擊、註冊與購買表現。
- 修改摘要：`SKILL.md` 已改寫為繁中統一格式；搬移至 `other/`：`evals`
- 風險等級：`LOW`

### data-analyst
- 主要業務摘要：把原始資料轉成可判讀的指標與決策依據。
- 修改摘要：`SKILL.md` 已改寫為繁中統一格式；未搬移額外檔案
- 風險等級：`MEDIUM`

### dev-browser
- 主要業務摘要：讓代理能在瀏覽器中逐步操作與驗證真實頁面流程，處理複雜互動任務。
- 修改摘要：`SKILL.md` 已改寫為繁中統一格式；未搬移額外檔案
- 風險等級：`HIGH`

### document-formatter
- 主要業務摘要：降低文件格式混亂與人工排版成本，提升對外輸出的專業度。
- 修改摘要：`SKILL.md` 已改寫為繁中統一格式；搬移至 `other/`：`example-before-after.html`, `template-formatted.html`
- 風險等級：`LOW`

### find-skills
- 主要業務摘要：降低能力探索成本，讓代理能快速找到可重用的 skill 而不是從零開始。
- 修改摘要：`SKILL.md` 已改寫為繁中統一格式；未搬移額外檔案
- 風險等級：`MEDIUM`

### frontend-ui-ux-engineer
- 主要業務摘要：加速從產品想法到可見介面的落地，提升視覺品質與體驗完整度。
- 修改摘要：`SKILL.md` 已改寫為繁中統一格式；未搬移額外檔案
- 風險等級：`LOW`

### git-master
- 主要業務摘要：降低版本控制操作失誤，保護工作樹與提交歷史。
- 修改摘要：`SKILL.md` 已改寫為繁中統一格式；未搬移額外檔案
- 風險等級：`MEDIUM`

### growth-hacking
- 主要業務摘要：加速社群帳號增長，透過平台機制與內容策略取得曝光與轉換。
- 修改摘要：`SKILL.md` 已改寫為繁中統一格式；未搬移額外檔案
- 風險等級：`LOW`

### marketing-ideas
- 主要業務摘要：在卡住時快速擴充行銷選項，找到可優先測試的成長機會。
- 修改摘要：`SKILL.md` 已改寫為繁中統一格式；搬移至 `other/`：`evals`
- 風險等級：`LOW`

### meeting-notes
- 主要業務摘要：把會議內容轉成可追蹤的結構化輸出，避免只停留在摘要。
- 修改摘要：`SKILL.md` 已改寫為繁中統一格式；未搬移額外檔案
- 風險等級：`LOW`

### nano-image-generator
- 主要業務摘要：快速產出可用的視覺素材，支援參考圖與風格一致性需求。
- 修改摘要：`SKILL.md` 已改寫為繁中統一格式；搬移至 `other/`：`README.md`, `README_CN.md`
- 風險等級：`MEDIUM`

### performance-optimization
- 主要業務摘要：提升速度與資源效率，降低延遲、成本與可用性風險。
- 修改摘要：`SKILL.md` 已改寫為繁中統一格式；搬移至 `other/`：`SKILL.toon`
- 風險等級：`MEDIUM`

### playwright-cli
- 主要業務摘要：在可程式化瀏覽器環境中完成測試與互動任務，適合腳本化流程。
- 修改摘要：`SKILL.md` 已改寫為繁中統一格式；未搬移額外檔案
- 風險等級：`MEDIUM`

### pptx
- 主要業務摘要：把簡報製作與編修流程標準化，提升輸出品質與速度。
- 修改摘要：`SKILL.md` 已改寫為繁中統一格式；未搬移額外檔案
- 風險等級：`LOW`

### refactor
- 主要業務摘要：在不改產品輸出的前提下降低技術債與維護成本。
- 修改摘要：`SKILL.md` 已改寫為繁中統一格式；未搬移額外檔案
- 風險等級：`LOW`

### security-audit
- 主要業務摘要：提前找出高風險漏洞與防護缺口，降低資安事故機率。
- 修改摘要：`SKILL.md` 已改寫為繁中統一格式；未搬移額外檔案
- 風險等級：`HIGH`

### seo-geo-optimizer
- 主要業務摘要：提升網站在搜尋引擎、AI 回答引擎與社群分發中的可見度與可引用性。
- 修改摘要：`SKILL.md` 已改寫為繁中統一格式；搬移至 `other/`：`.gitignore`, `LICENSE`, `PHASE2-PLAN.md`, `PHASE3-PLAN.md`, `PLAN.md`, `README.md`
- 風險等級：`MEDIUM`

### skill-creator
- 主要業務摘要：把零散想法整理成可運作的 skill，提升觸發準確率、維護性與可驗證性。
- 修改摘要：`SKILL.md` 已改寫為繁中統一格式；搬移至 `other/`：`LICENSE.txt`, `eval-viewer`
- 風險等級：`LOW`

### smithery-ai-cli
- 主要業務摘要：把外部整合、MCP 連線與工具探索集中到單一 CLI 入口。
- 修改摘要：`SKILL.md` 已改寫為繁中統一格式；未搬移額外檔案
- 風險等級：`HIGH`

### social-content
- 主要業務摘要：把內容轉成平台適配的社群素材，提升曝光、互動與追蹤成長。
- 修改摘要：`SKILL.md` 已改寫為繁中統一格式；搬移至 `other/`：`evals`
- 風險等級：`LOW`

### subagent-driven-development
- 主要業務摘要：把多任務開發拆成可平行、可審查的工作單元，提高交付品質與速度。
- 修改摘要：`SKILL.md` 已改寫為繁中統一格式；搬移至 `other/`：`code-quality-reviewer-prompt.md`, `implementer-prompt.md`, `spec-reviewer-prompt.md`
- 風險等級：`MEDIUM`

### systematic-debugging
- 主要業務摘要：把除錯流程從亂試 patch 轉成可驗證、可重現的根因定位與修復。
- 修改摘要：`SKILL.md` 已改寫為繁中統一格式；搬移至 `other/`：`CREATION-LOG.md`, `condition-based-waiting-example.ts`, `condition-based-waiting.md`, `defense-in-depth.md`, `find-polluter.sh`, `root-cause-tracing.md`, `test-academic.md`, `test-pressure-1.md`, `test-pressure-2.md`, `test-pressure-3.md`
- 風險等級：`LOW`

### testing-expert
- 主要業務摘要：提升系統回歸保護與驗證品質，降低改動後的未知風險。
- 修改摘要：`SKILL.md` 已改寫為繁中統一格式；未搬移額外檔案
- 風險等級：`LOW`

### user-research
- 主要業務摘要：把產品決策建立在真實使用者訊號上，而不是內部猜測。
- 修改摘要：`SKILL.md` 已改寫為繁中統一格式；未搬移額外檔案
- 風險等級：`LOW`

### using-superpowers
- 主要業務摘要：讓代理優先重用既有能力，不要忽略可直接套用的 skill。
- 修改摘要：`SKILL.md` 已改寫為繁中統一格式；未搬移額外檔案
- 風險等級：`LOW`

### web-design-guidelines
- 主要業務摘要：在設計與開發之間建立品質門檻，降低可用性與一致性問題。
- 修改摘要：`SKILL.md` 已改寫為繁中統一格式；未搬移額外檔案
- 風險等級：`LOW`

### web-quality-audit
- 主要業務摘要：一次性檢視網站品質面向，找出對體驗與流量最有影響的缺口。
- 修改摘要：`SKILL.md` 已改寫為繁中統一格式；未搬移額外檔案
- 風險等級：`MEDIUM`

### xlsx
- 主要業務摘要：把表格型任務直接交付成可用的試算表文件，保留公式、格式與可重算能力。
- 修改摘要：`SKILL.md` 已改寫為繁中統一格式；搬移至 `other/`：`LICENSE.txt`
- 風險等級：`MEDIUM`

## /Users/seanhan/.codex/skills

### automation-workflows
- 主要業務摘要：把重複性作業轉成可維護的自動化流程，降低人工成本並提升可擴展性。
- 修改摘要：`SKILL.md` 已改寫為繁中統一格式；未搬移額外檔案
- 風險等級：`MEDIUM`

### feishu-common
- 主要業務摘要：把飛書 API 的共通認證與容錯邏輯集中，降低各 skill 重複實作與認證失敗風險。
- 修改摘要：`SKILL.md` 已改寫為繁中統一格式；未搬移額外檔案
- 風險等級：`HIGH`

### feishu-doc
- 主要業務摘要：把文件型任務直接落地到 Lark / Feishu，支撐讀寫、長文追加與精準 block 更新。
- 修改摘要：`SKILL.md` 已改寫為繁中統一格式；搬移至 `other/`：`README.md`
- 風險等級：`HIGH`

### find-skills
- 主要業務摘要：降低能力探索成本，讓代理能快速找到可重用的 skill 而不是從零開始。
- 修改摘要：`SKILL.md` 已改寫為繁中統一格式；未搬移額外檔案
- 風險等級：`MEDIUM`

### proactive-agent
- 主要業務摘要：建立更可靠的代理運作模式，讓系統能在長期互動中學習、修復與升級。
- 修改摘要：`SKILL.md` 已改寫為繁中統一格式；未搬移額外檔案
- 風險等級：`MEDIUM`

### pua
- 主要業務摘要：避免代理在困難問題上反覆空轉，強迫切換到更有力度的排障與交付方式。
- 修改摘要：`SKILL.md` 已改寫為繁中統一格式；未搬移額外檔案
- 風險等級：`MEDIUM`

### self-improving-agent
- 主要業務摘要：把錯誤與修正經驗轉成可累積的系統改進，而不是每次重犯同樣問題。
- 修改摘要：`SKILL.md` 已改寫為繁中統一格式；搬移至 `other/`：`.learnings`
- 風險等級：`LOW`

### skill-vetter
- 主要業務摘要：在引入或修改 skill 前先控風險，避免不安全或不適配的能力進入系統。
- 修改摘要：`SKILL.md` 已改寫為繁中統一格式；未搬移額外檔案
- 風險等級：`LOW`

### tavily-search
- 主要業務摘要：讓代理能快速取得外部網路資訊，支援需要搜尋與摘要的任務。
- 修改摘要：`SKILL.md` 已改寫為繁中統一格式；未搬移額外檔案
- 風險等級：`MEDIUM`
