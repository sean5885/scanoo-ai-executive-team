#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import shutil
from dataclasses import dataclass
from pathlib import Path


ROOTS = [
    Path("/Users/seanhan/.agents/skills"),
    Path("/Users/seanhan/.codex/skills"),
]


ALLOWED_TOP_LEVEL = {
    "SKILL.md",
    "references",
    "scripts",
    "assets",
    "other",
    "_meta.json",
    "hooks",
    "cache",
    "lib",
    "src",
    "templates",
    "profiles",
    "reference",
    "examples",
    "node_modules",
    "package.json",
    "package-lock.json",
    "bun.lock",
    "tsconfig.json",
    "vitest.config.ts",
    "server.sh",
    "index.js",
    "create.js",
    "append_simple.js",
    "download_file.js",
    "validate_patch.js",
    "input_guard.js",
    "inspect_meta.js",
    "fetch_mock.js",
    "setup_iter11.js",
    "feishu-client.js",
    "plugin.json",
    "config.json",
}


MOVE_TO_OTHER = {
    ".gitignore",
    ".learnings",
    "CREATION-LOG.md",
    "LICENSE",
    "LICENSE.txt",
    "PHASE2-PLAN.md",
    "PHASE3-PLAN.md",
    "PLAN.md",
    "README.md",
    "README_CN.md",
    "SKILL.toon",
    "code-quality-reviewer-prompt.md",
    "condition-based-waiting-example.ts",
    "condition-based-waiting.md",
    "defense-in-depth.md",
    "eval-viewer",
    "evals",
    "example-before-after.html",
    "find-polluter.sh",
    "implementer-prompt.md",
    "root-cause-tracing.md",
    "spec-reviewer-prompt.md",
    "template-formatted.html",
    "test-academic.md",
    "test-pressure-1.md",
    "test-pressure-2.md",
    "test-pressure-3.md",
}


REPORT_PATH = Path("/Users/seanhan/Documents/Playground/other/skill-audit-report-2026-03-18.json")


@dataclass(frozen=True)
class SkillSpec:
    description: str
    business_summary: str
    when_to_use: list[str]
    avoid_when: list[str]
    workflow: list[str]
    outputs: list[str]
    risk_level: str
    risk_notes: list[str]
    preconditions: list[str] | None = None
    prohibitions: list[str] | None = None


SPECS: dict[str, SkillSpec] = {
    "agent-tools": SkillSpec(
        description="透過 `inference.sh` CLI 執行雲端 AI 應用，涵蓋影像、影片、LLM、搜尋、3D 與 Twitter 自動化。",
        business_summary="把大量外部 AI 能力統一收斂到單一 CLI，讓代理可快速調用生成、搜尋與自動化服務。",
        when_to_use=[
            "使用者明確提到 `inference.sh`、`infsh`、模型名稱或要執行 AI app。",
            "需要快速呼叫雲端生成式模型、搜尋服務或社群自動化流程。",
            "任務需要上傳本地檔案到 AI app 做推理或轉換。",
        ],
        avoid_when=[
            "本地既有工具已足以完成，且不需要額外雲端模型。",
            "沒有網路、沒有登入，或不允許呼叫第三方服務。",
        ],
        workflow=[
            "確認目標 app、輸入格式、是否需要登入與本地檔案上傳。",
            "優先使用最小可行指令驗證 app 可用，再擴大到完整流程。",
            "回報執行結果、產出位置、task id 或失敗原因。",
        ],
        outputs=["所用 app / 模型", "輸入摘要", "輸出結果或檔案位置", "失敗原因與下一步"],
        risk_level="HIGH",
        risk_notes=["需網路與第三方服務", "可能涉及登入、API 配額與外部資料傳輸"],
        preconditions=[
            "已確認使用者允許呼叫第三方 AI 服務與外部網路。",
            "若需要登入、token 或計費額度，必須先確認可用性與責任邊界。",
            "若要上傳本地檔案，必須確認上傳目標、資料敏感度與檔案路徑。",
        ],
        prohibitions=[
            "不可未經確認就上傳敏感檔案、憑證、客戶資料或私人內容。",
            "不可在未說明成本與副作用時直接執行可能產生費用的 app。",
            "不可把第三方服務的回應當成已驗證事實，除非另有證據支持。",
        ],
    ),
    "automation-workflows": SkillSpec(
        description="設計與實作自動化工作流，協助個體經營者節省時間並放大營運效率。",
        business_summary="把重複性作業轉成可維護的自動化流程，降低人工成本並提升可擴展性。",
        when_to_use=["需要辨識可自動化作業。", "要設計 Zapier、Make、n8n 等工作流。", "要優化既有自動化流程。"],
        avoid_when=["只是單次任務，不值得建立流程。", "需求與觸發條件仍非常模糊。", "問題其實是策略不清，而不是流程缺自動化。"],
        workflow=["界定觸發條件、輸入、輸出、例外與人工介入點。", "選定工具、節點順序與資料流。", "定義驗證、告警、維護責任與失敗回復方式。"],
        outputs=["trigger", "input", "steps", "error_handling", "monitoring", "maintenance_risk"],
        risk_level="MEDIUM",
        risk_notes=["可能連接外部服務與憑證", "需要避免過度自動化造成誤操作"],
        preconditions=["應先知道流程目前如何手動執行，以及哪一步最耗時、最容易出錯。"],
        prohibitions=["不可在不知道例外處理與失敗回復方式前就宣稱流程可上線。", "不可只列工具名稱而沒有明確的 trigger、action、error path。"],
    ),
    "biz-email-writer": SkillSpec(
        description="撰寫與改寫韓文商務郵件、公文與中英文郵件，能依情境調整語氣與格式。",
        business_summary="把業務溝通需求快速轉成正式可寄送的郵件內容，降低跨語言與禮節風險。",
        when_to_use=["需要撰寫商務郵件、公文、回覆、婉拒、公告或會議邀請。", "需要調整韓文郵件的正式度與標題結構。"],
        avoid_when=["使用者只要閒聊訊息或社群文案。", "需要法律審核而非文字潤飾。"],
        workflow=["確認收件對象、目的、語氣與語言。", "生成主旨、內文與必要附件說明。", "檢查禮貌層級、日期、稱謂與行動要求。"],
        outputs=["郵件主旨", "正文", "語氣說明", "可直接寄送版本"],
        risk_level="LOW",
        risk_notes=["主要是內容品質與禮節風險", "避免虛構事實或承諾"],
    ),
    "code-review": SkillSpec(
        description="進行程式碼審查，聚焦品質、安全性、效能風險與測試覆蓋。",
        business_summary="在變更合併前提前抓出缺陷、回歸與安全問題，降低交付風險。",
        when_to_use=["審查 PR、commit 或變更集。", "需要找 bug、設計風險或缺漏測試。", "需要安全與效能角度的審核。"],
        avoid_when=["需求是直接實作功能，不是審查。", "缺少變更內容，無法形成具體 findings。"],
        workflow=["先理解變更目的與範圍。", "依架構、正確性、安全、效能、測試逐層檢查。", "以 findings 為主輸出，附檔案與行號。"],
        outputs=["嚴重度排序 findings", "開放問題", "測試缺口", "次要變更摘要"],
        risk_level="LOW",
        risk_notes=["主要風險是審查不完整或過度主觀", "需避免沒有證據的評論"],
    ),
    "competitor-analysis": SkillSpec(
        description="分析競品的 SEO、GEO、內容策略、反向連結與 AI 引用模式。",
        business_summary="找出競品為何排名較高，以及可切入的內容與流量機會。",
        when_to_use=["使用者要做競品分析、競品 SEO、排名差異分析。", "需要理解競品關鍵字、內容佈局與 AI 可見度。"],
        avoid_when=["只要產生單篇內容，沒有競品比較需求。", "沒有可分析的競品或搜尋情境。"],
        workflow=["確認目標站點、關鍵字與比較維度。", "收集排名、內容與引用訊號。", "整理差距、優先機會與對策。"],
        outputs=["競品清單", "關鍵差距", "可執行機會", "風險與假設"],
        risk_level="MEDIUM",
        risk_notes=["通常需要外部搜尋資料", "應避免把推測當成事實"],
    ),
    "content-strategy": SkillSpec(
        description="規劃內容策略、主題群集、內容路線圖與編輯節奏。",
        business_summary="把零散題材整理成可持續輸出的內容系統，支撐流量、品牌與轉換。",
        when_to_use=["需要決定寫什麼、先做哪些內容。", "要建立內容主題群集或編輯日曆。"],
        avoid_when=["只要完成單篇文案。", "需求侷限於單一社群貼文。"],
        workflow=["定義受眾、目標與內容邊界。", "整理題材、優先順序與分發通路。", "輸出可執行 roadmap 與衡量方式。"],
        outputs=["內容支柱", "主題清單", "優先順序", "發佈節奏"],
        risk_level="LOW",
        risk_notes=["主要是策略失焦風險", "應避免脫離實際資源與商業目標"],
    ),
    "copywriting": SkillSpec(
        description="撰寫與優化網站與行銷頁文案，包括首頁、落地頁、定價頁與 CTA。",
        business_summary="把產品價值轉成可轉換的文字，提升點擊、註冊與購買表現。",
        when_to_use=["需要重寫或強化網站文案。", "需要 headline、subheadline、CTA 或價值主張。"],
        avoid_when=["只是要翻譯原文，不需要轉換導向文案。", "需求是正式商務郵件而非頁面文案。"],
        workflow=["確認受眾、產品價值與轉換目標。", "重寫關鍵訊息與 CTA。", "檢查語氣一致性與可讀性。"],
        outputs=["頁面文案", "訊息主軸", "CTA 建議", "可測試版本"],
        risk_level="LOW",
        risk_notes=["主要是訊息失真或誇大承諾", "應保持與產品真實能力一致"],
    ),
    "data-analyst": SkillSpec(
        description="提供 SQL、pandas 與統計分析能力，用於探索資料、建立查詢與整理洞察。",
        business_summary="把原始資料轉成可判讀的指標與決策依據。",
        when_to_use=["要分析資料集、寫 SQL、使用 pandas。", "需要統計摘要、趨勢或資料清理。"],
        avoid_when=["需求不是資料分析。", "沒有資料或分析目標。"],
        workflow=["理解資料來源與分析問題。", "清理資料並執行查詢或統計。", "輸出洞察、限制與後續建議。"],
        outputs=["分析摘要", "查詢或處理方法", "關鍵指標", "限制說明"],
        risk_level="MEDIUM",
        risk_notes=["可能涉及敏感資料", "需避免樣本不足或錯誤推論"],
    ),
    "dev-browser": SkillSpec(
        description="以可持久化頁面狀態的瀏覽器自動化方式完成導航、填表、擷取與網站測試。",
        business_summary="讓代理能在瀏覽器中逐步操作與驗證真實頁面流程，處理複雜互動任務。",
        when_to_use=["需要瀏覽器自動化、表單填寫、截圖、擷取資料或網站測試。", "需要連到使用者現有瀏覽器 session 或在新 Chromium 執行。"],
        avoid_when=["只需 HTTP 層抓資料或靜態檔分析。", "沒有明確互動目標。"],
        workflow=["先決定 standalone 或 extension mode。", "用小腳本逐步執行單一動作並觀察頁面狀態。", "以截圖、snapshot 或頁面資訊驗證結果。"],
        outputs=["執行模式", "操作步驟", "頁面狀態證據", "成功或失敗結果"],
        risk_level="HIGH",
        risk_notes=["可能涉及登入、cookie 與真實網站寫入操作", "需小心自動化副作用"],
        preconditions=[
            "已確認是讀取流程還是會對網站產生寫入、副作用或送出操作。",
            "若使用 extension mode，必須確認會話所連到的帳號與授權範圍。",
            "執行前應明確知道目標頁面、預期操作與成功判準。",
        ],
        prohibitions=[
            "不可在未確認的情況下送出表單、下單、發文、付款或修改真實資料。",
            "不可把登入態頁面的資訊外傳到不必要的位置。",
            "不可用大型腳本一次做多個高風險動作，應逐步驗證後再往下。",
        ],
    ),
    "document-formatter": SkillSpec(
        description="整理與統一文件格式，輸出一致、可讀的文檔結果。",
        business_summary="降低文件格式混亂與人工排版成本，提升對外輸出的專業度。",
        when_to_use=["需要清理文件樣式。", "要把不一致的格式統一成標準版型。"],
        avoid_when=["任務重點在內容策略而不是格式。", "使用者明確要求保留原樣不動。", "文件結構本身就是交付重點，不應被重新編排。"],
        workflow=["先辨識既有結構、層級與格式規則。", "只做最小必要格式整理，不破壞原有資訊結構。", "確認段落、標題、表格與版面一致，且沒有結構性損壞。"],
        outputs=["格式化後文件", "主要調整點", "保留的原始結構", "未處理限制"],
        risk_level="LOW",
        risk_notes=["主要風險是破壞原有版型", "應保留既有結構與內容"],
        preconditions=["應先知道文件是否有既有模板、欄位順序、法規格式或不可改動區塊。"],
        prohibitions=["不可為了美觀重排文件結構、欄位順序或資訊階層。", "不可修改內容語意來替代格式整理。"],
    ),
    "feishu-common": SkillSpec(
        description="提供 Feishu skill 共用的驗證、token 取得、重試與 API 呼叫封裝。",
        business_summary="把飛書 API 的共通認證與容錯邏輯集中，降低各 skill 重複實作與認證失敗風險。",
        when_to_use=["其他 Feishu skill 需要共用驗證與 API helper。", "要統一 token 快取、重試與授權請求。"],
        avoid_when=["單純內容寫作，不涉及 Feishu API。", "不需要共用 helper。"],
        workflow=["先確認相依 skill 與授權設定。", "透過共用 helper 發送授權與 API 請求。", "回報 token 或請求層的成功與失敗原因。"],
        outputs=["相依關係說明", "使用方式", "可用 helper 列表"],
        risk_level="HIGH",
        risk_notes=["涉及 token 與 API 認證", "錯誤處理不當可能影響多個 Feishu skill"],
        preconditions=[
            "已確認 app id、app secret、tenant token 或相依授權機制存在且可用。",
            "已確認只有授權過的 Feishu skill 會引用共用 helper。",
        ],
        prohibitions=[
            "不可把 token、secret 或憑證內容寫入報告、log 或版本控制。",
            "不可在未釐清授權範圍時擴大共用 helper 的寫入能力。",
        ],
    ),
    "feishu-doc": SkillSpec(
        description="讀取、建立、寫入與更新飛書文件、Wiki、Sheets 與 Bitable。",
        business_summary="把文件型任務直接落地到 Lark / Feishu，支撐讀寫、長文追加與精準 block 更新。",
        when_to_use=["需要讀寫 Lark Docs / Wiki / Sheets / Bitable。", "需要把內容真正寫入飛書而不是只產生文字。"],
        avoid_when=["不確定目標文件或未取得授權。", "只需本地草稿，不必寫回飛書。"],
        workflow=["確認文檔目標與授權。", "依任務選擇讀取、建立、覆寫、追加或 block 操作。", "以 token、連結與變更摘要回報結果。"],
        outputs=["操作類型", "目標文檔", "成功狀態", "doc token / link / 變更摘要"],
        risk_level="HIGH",
        risk_notes=["涉及真實文件寫入", "需要避免誤寫與長文覆寫失敗"],
        preconditions=[
            "已確認目標文檔、空間、權限與預期寫入方式。",
            "若內容很長，必須先切段並採用 append 或 block 級操作。",
            "寫入前應明確區分讀取、建立、覆寫與追加。",
        ],
        prohibitions=[
            "不可在目標文檔不明確時直接寫入。",
            "不可把未驗證內容、推測內容或敏感資料直接寫回長期文件。",
            "不可在未備妥成功證據時聲稱已完成寫入。",
        ],
    ),
    "find-skills": SkillSpec(
        description="協助找出、比較與安裝適合的 skill 或能力擴充。",
        business_summary="降低能力探索成本，讓代理能快速找到可重用的 skill 而不是從零開始。",
        when_to_use=["使用者在問有沒有 skill、怎麼做某件事、要找擴充能力。", "需要列出、比較或安裝可用 skill。"],
        avoid_when=["已明確指定現有 skill 並可直接執行。", "只是一般知識問答。", "問題本身不需要 skill，直接回答更快更準。"],
        workflow=["先辨識任務缺口與實際需要的能力。", "先比對現有 skill 是否已能覆蓋，再評估外部 skill 或安裝來源。", "回報候選 skill、命中理由、風險與推薦順序。"],
        outputs=["candidate_skills", "match_reason", "installation_required", "risk_assessment", "priority"],
        risk_level="MEDIUM",
        risk_notes=["若涉及外部安裝需做安全審核", "避免推薦不相容或過度廣泛的 skill"],
        preconditions=["應先確認目前已安裝 skill 是否足夠，再考慮外部 skill。"],
        prohibitions=["不可跳過相容性與安全審核就推薦安裝外部 skill。", "不可只因名稱相近就判定 skill 合適，必須看用途與邊界。"],
    ),
    "frontend-ui-ux-engineer": SkillSpec(
        description="在沒有設計稿時直接產出高辨識度、可實作的前端 UI/UX。",
        business_summary="加速從產品想法到可見介面的落地，提升視覺品質與體驗完整度。",
        when_to_use=["需要設計並實作前端頁面或介面細節。", "沒有設計稿但要做出有方向感的 UI。"],
        avoid_when=["任務不是前端介面。", "只是做極小的樣式修補，不需要整體設計判斷。"],
        workflow=["先判斷是沿用既有設計系統，還是可以自由建立新視覺方向。", "若有設計系統，優先遵循元件、間距、字體與互動規則；若無，建立明確視覺語言與版面。", "補上關鍵互動、響應式與使用體驗細節，並回報設計路徑。"],
        outputs=["DesignSystem 或 FreeDesign 路徑判斷", "介面實作", "視覺方向", "互動重點與相容性注意事項"],
        risk_level="LOW",
        risk_notes=["主要是與既有設計不一致的風險", "應優先尊重現有設計系統"],
        preconditions=["應先確認產品是否已有設計系統、品牌規範或既有 UI pattern。"],
        prohibitions=["不可在有既有設計系統時擅自改寫核心視覺語言。", "不可只追求視覺效果而忽略可用性、響應式與可實作性。"],
    ),
    "git-master": SkillSpec(
        description="安全處理 Git 任務，涵蓋分支策略、衝突、歷史修復與危險操作防呆。",
        business_summary="降低版本控制操作失誤，保護工作樹與提交歷史。",
        when_to_use=["需要檢查 Git 狀態、分支、差異或提交歷史。", "涉及衝突處理、rebase、cherry-pick、回滾或歷史修復。", "要執行可能影響遠端或工作樹的高風險 Git 操作。"],
        avoid_when=["任務與 Git 無關。", "只是要閱讀程式碼內容，無需版本控制操作。"],
        workflow=["先檢查工作樹、目前分支、未提交變更與遠端狀態。", "判斷操作風險，區分安全讀取、可逆修改與破壞性修改。", "執行最安全的 Git 路徑，並回報結果、風險與後續建議。"],
        outputs=["當前 Git 狀態", "預計或已執行的 Git 操作", "風險確認點", "下一步或回退建議"],
        risk_level="MEDIUM",
        risk_notes=["可能影響版本歷史與工作樹", "應避免未經同意的破壞性操作"],
        preconditions=["執行前應確認目前分支、未提交變更與是否有他人工作尚未整合。", "若操作會改寫歷史或影響遠端，必須先明確說明風險與影響範圍。"],
        prohibitions=["不可在未確認的情況下執行 `reset --hard`、`checkout --`、`push --force`、大範圍 rebase 或其他破壞性操作。", "不可忽略工作樹中的既有變更或擅自覆蓋他人修改。"],
    ),
    "growth-hacking": SkillSpec(
        description="針對小紅書等平台設計快速增長與病毒式擴散策略。",
        business_summary="加速社群帳號增長，透過平台機制與內容策略取得曝光與轉換。",
        when_to_use=["要快速增長小紅書追蹤或設計成長策略。", "需要平台機制導向的實驗方案。"],
        avoid_when=["只要一般品牌文案，不需要成長策略。", "沒有明確平台與目標指標。"],
        workflow=["定義平台、目標受眾與增長指標。", "設計內容、分發與實驗機制。", "輸出優先級與追蹤方式。"],
        outputs=["strategy", "hypothesis", "experiment_design", "metrics", "risks"],
        risk_level="LOW",
        risk_notes=["主要是策略不適配平台", "避免違反平台規則"],
        preconditions=["應先知道平台、受眾、增長目標與可接受的實驗邊界。"],
        prohibitions=["不可給違反平台規則、灰產或無法驗證的增長手法。", "不可只列戰術而沒有假設、量測指標與風險。"],
    ),
    "marketing-ideas": SkillSpec(
        description="為 SaaS 或軟體產品產生行銷想法、成長策略與推廣方向。",
        business_summary="在卡住時快速擴充行銷選項，找到可優先測試的成長機會。",
        when_to_use=["需要行銷點子、增長想法或推廣策略。", "不知道下一步該怎麼推廣產品。"],
        avoid_when=["已經有明確執行渠道與詳細計畫。", "需要的是特定渠道的專業執行。"],
        workflow=["確認產品、受眾與商業目標。", "列出多個可行渠道與打法。", "按成本、速度與影響排序。"],
        outputs=["idea", "context", "cost", "speed", "impact", "priority"],
        risk_level="LOW",
        risk_notes=["主要是點子過散或不可執行", "需與產品階段相符"],
        preconditions=["應先知道產品階段、目標受眾與主要商業目標。"],
        prohibitions=["不可只給空泛 brainstorm 而沒有情境、成本、速度與優先級。", "不可把不適合當前產品階段的打法當成通用建議。"],
    ),
    "meeting-notes": SkillSpec(
        description="整理會議逐字稿、紀要、決議與待辦，補齊 owner、deadline、風險與 follow-up。",
        business_summary="把會議內容轉成可追蹤的結構化輸出，避免只停留在摘要。",
        when_to_use=["處理會議逐字稿、筆記、討論記錄。", "需要決議、待辦與風險整理。"],
        avoid_when=["沒有會議內容來源。", "只是一般文章摘要。"],
        workflow=["整理會議背景、參與者與主要議題。", "抽出決議、action items、owner、deadline 與衝突點。", "補齊風險、開放問題、知識回寫與任務回寫建議。"],
        outputs=["summary", "decisions", "action_items", "owner", "deadline", "risks", "open_questions", "conflicts", "knowledge_writeback", "task_writeback", "follow_up_recommendations"],
        risk_level="LOW",
        risk_notes=["主要風險是遺漏 owner 或 deadline", "不能把未確認事項寫成既定決議"],
        preconditions=["應先有逐字稿、錄音整理、筆記或其他可追溯的會議內容來源。"],
        prohibitions=["不可省略 action item 的 owner 或 deadline。", "不可把討論中的提案直接寫成已決議事項。"],
    ),
    "nano-image-generator": SkillSpec(
        description="使用 Nano Banana Pro 生成圖像，支援圖示、Logo、Banner、插圖與風格延續。",
        business_summary="快速產出可用的視覺素材，支援參考圖與風格一致性需求。",
        when_to_use=["需要生成視覺資產。", "要維持既有風格或使用參考圖。"],
        avoid_when=["需求只是文字內容。", "不允許使用外部模型或產生圖片。"],
        workflow=["確認用途、尺寸、風格與參考圖。", "生成 prompt 與必要限制。", "回報產物、版本與可調方向。"],
        outputs=["提示詞摘要", "圖片用途", "輸出結果", "可迭代方向"],
        risk_level="MEDIUM",
        risk_notes=["通常涉及外部模型與素材輸入", "應避免侵犯版權或風格混淆"],
    ),
    "performance-optimization": SkillSpec(
        description="優化應用程式效能，包括前端、資料庫、快取、載入時間與效能瓶頸。",
        business_summary="提升速度與資源效率，降低延遲、成本與可用性風險。",
        when_to_use=["需要改善載入時間、bundle、資料庫查詢或整體效能。", "需要定位效能瓶頸。"],
        avoid_when=["問題是功能錯誤而非效能。", "沒有可觀測指標或基線。"],
        workflow=["建立效能基線與瓶頸假設。", "對應前端、後端或資料層優化。", "驗證改善幅度與副作用。"],
        outputs=["瓶頸摘要", "優化方案", "驗證方式", "風險與取捨"],
        risk_level="MEDIUM",
        risk_notes=["效能調整可能引入行為變更", "需驗證快取與資源釋放"],
    ),
    "playwright-cli": SkillSpec(
        description="使用 Playwright CLI 做瀏覽器互動、自動化測試、截圖與資料擷取。",
        business_summary="在可程式化瀏覽器環境中完成測試與互動任務，適合腳本化流程。",
        when_to_use=["需要 Playwright 自動化、截圖、表單互動或網頁測試。", "需要對網頁行為做腳本式驗證。"],
        avoid_when=["已有更適合的本地工具或 dev-browser。", "任務不需真實瀏覽器互動。"],
        workflow=["確認頁面目標與互動步驟。", "撰寫或執行 Playwright 腳本。", "收集輸出、截圖與驗證結果。"],
        outputs=["腳本或指令", "互動結果", "截圖 / 擷取內容", "失敗診斷"],
        risk_level="MEDIUM",
        risk_notes=["可能涉及登入與網站寫入", "需避免無意識重複操作"],
        preconditions=[
            "已確認目標頁面、互動步驟與是否屬於只讀測試或真實寫入。",
            "若要登入或使用現有帳號，必須先確認授權範圍與副作用。",
        ],
        prohibitions=[
            "不可在不清楚後果時執行送出、刪除、付款或帳號設定變更。",
            "不可省略截圖、log 或其他可驗證輸出就宣稱完成。",
        ],
    ),
    "pptx": SkillSpec(
        description="建立、修改與分析簡報檔，處理版面、內容與 speaker notes。",
        business_summary="把簡報製作與編修流程標準化，提升輸出品質與速度。",
        when_to_use=["主要輸入或輸出是 `.pptx`。", "需要建立或修改簡報內容與版面。"],
        avoid_when=["產出不是簡報。", "只是一般文字摘要。"],
        workflow=["確認簡報目的、受眾與檔案來源。", "調整投影片內容、結構與樣式。", "驗證可讀性與交付格式。"],
        outputs=["簡報檔", "修改摘要", "版面或講稿說明"],
        risk_level="LOW",
        risk_notes=["主要風險是版面跑掉或資訊不一致", "需保留既有模板風格"],
    ),
    "proactive-agent": SkillSpec(
        description="把代理從被動執行者升級成能預判需求、保留記憶、持續改進的主動協作系統。",
        business_summary="建立更可靠的代理運作模式，讓系統能在長期互動中學習、修復與升級。",
        when_to_use=["要設計主動型 agent、記憶架構或自我修復機制。", "需要 reverse prompting、alignment 與安全強化。", "需要把 learnings 轉成持續改進能力。"],
        avoid_when=["只是單次簡單任務。", "沒有 agent 系統設計需求。", "只是要包裝一般執行流程，不涉及 agent 架構。"],
        workflow=["界定 agent 設計範圍，只聚焦在主動行為、記憶治理與自我改進。", "定義代理目標、記憶與安全邊界。", "輸出可落地的規則、腳本、提案或流程。"],
        outputs=["agent 設計範圍", "記憶 / 對齊策略", "自我改進提案", "風險邊界與治理方式"],
        risk_level="MEDIUM",
        risk_notes=["涉及長期記憶與自動化行為", "需嚴防越權與錯誤自我放大"],
        preconditions=["應先確認需求真的落在 agent-design、memory 或 self-improvement，而不是一般功能開發。"],
        prohibitions=["不可把一般任務自動包裝成主動型 agent 設計問題。", "不可在沒有治理與邊界時鼓勵代理持續自動擴權。"],
    ),
    "pua": SkillSpec(
        description="在同一問題連續失敗、多次卡住或接近放棄時，進入高壓端到端問題攻堅模式。",
        business_summary="避免代理在困難問題上反覆空轉，強迫切換到更有力度的排障與交付方式。",
        when_to_use=["同一問題在同一鏈路上失敗至少兩次。", "代理開始被動循環、重複空話或想把工作推回給使用者。"],
        avoid_when=["首輪任務。", "問題仍可用正常流程快速完成。", "阻塞來自明確外部 deadlock，已無法透過本地攻堅解除。"],
        workflow=["確認是否已達 failures >= 2 的啟動條件，並重設目標與阻塞點。", "強化端到端驗證、鏈路檢查與證據收集。", "持續推進直到拿到明確 evidence，或確認進入真正 deadlock 後停止升壓並升級處理。"],
        outputs=["啟動原因", "阻塞點", "攻堅策略", "evidence", "停止條件或升級建議"],
        risk_level="MEDIUM",
        risk_notes=["容易帶來過度干預", "只應在卡關場景啟用"],
        preconditions=["應先確認失敗次數、失敗型態與目前是否真的卡在同一條鏈路。"],
        prohibitions=["不可在只失敗一次或問題尚未充分調查時啟動高壓模式。", "不可在已確認 deadlock 後仍無限加壓而不升級或停止。"],
    ),
    "refactor": SkillSpec(
        description="用最小改動改善可維護性，不改外部行為。",
        business_summary="在不改產品輸出的前提下降低技術債與維護成本。",
        when_to_use=["需要抽函式、拆模組、去重或改善命名。", "要降低耦合但不改外部行為。"],
        avoid_when=["需求其實是功能新增或行為改動。"],
        workflow=["先界定不可改變的外部行為與影響範圍。", "做最小結構調整並說明 impact analysis。", "以測試、對照或其他證據驗證沒有回歸。"],
        outputs=["重構摘要", "保留行為清單", "impact analysis", "驗證結果"],
        risk_level="LOW",
        risk_notes=["主要風險是引入行為回歸", "需保留現有接口與輸出"],
        preconditions=["應先知道哪些輸入、輸出、接口與副作用不能改。"],
        prohibitions=["不可把功能改動包裝成重構。", "不可沒有 impact analysis 或回歸驗證就宣稱重構安全。"],
    ),
    "security-audit": SkillSpec(
        description="執行安全審核，涵蓋 Web、API、滲透測試、漏洞掃描與安全強化。",
        business_summary="提前找出高風險漏洞與防護缺口，降低資安事故機率。",
        when_to_use=["需要做安全審計、漏洞盤點或硬化建議。", "要檢查 Web、API 或系統暴露面。"],
        avoid_when=["任務只是一般功能開發。", "缺少系統範圍與測試邊界。"],
        workflow=["定義審核範圍與威脅面。", "檢查認證、授權、輸入驗證與相依性。", "輸出風險、證據與修補優先序。"],
        outputs=["風險列表", "證據", "嚴重度", "修補建議"],
        risk_level="HIGH",
        risk_notes=["可能涉及敏感系統與安全測試", "需避免未授權攻擊行為"],
        preconditions=[
            "已確認審核範圍、授權邊界與禁止測試項目。",
            "已區分被動檢查、設定審視與主動測試的層級。",
            "若涉及生產環境，必須優先採用低風險觀察方式。",
        ],
        prohibitions=[
            "不可在未授權的情況下進行攻擊性測試、破壞性 payload 或高頻掃描。",
            "不可把弱證據推論成已確認漏洞。",
            "不可在沒有修補建議與證據的情況下只丟結論。",
        ],
    ),
    "seo-geo-optimizer": SkillSpec(
        description="分析並優化 SEO、GEO、AEO 與 AI 平台可見度，支援多種內容格式與平台。",
        business_summary="提升網站在搜尋引擎、AI 回答引擎與社群分發中的可見度與可引用性。",
        when_to_use=["需要 SEO / GEO / AEO 審核與優化。", "要檢查 metadata、schema、關鍵字與平台適配。"],
        avoid_when=["需求不是可見度優化。", "沒有可分析內容或頁面。"],
        workflow=["盤點內容與平台目標。", "分析 metadata、結構化資料、實體與缺口。", "輸出可執行優化與報告。"],
        outputs=["審核摘要", "平台別建議", "優先修正項", "輸出格式建議"],
        risk_level="MEDIUM",
        risk_notes=["可能依賴外部搜尋與平台規則", "應避免過度堆砌關鍵字"],
        preconditions=[
            "已確認分析對象、目標平台與語言 / 地區邊界。",
            "若引用外部搜尋結果，必須保留來源與時效性說明。",
        ],
        prohibitions=[
            "不可以堆砌關鍵字取代結構化優化與內容品質改善。",
            "不可把外部平台短期波動直接當成穩定策略。",
        ],
    ),
    "self-improving-agent": SkillSpec(
        description="在失敗、被糾正、發現更好做法或工具異常時記錄 learnings，並把經驗沉澱成規則、流程與升級提案。",
        business_summary="把錯誤與修正經驗轉成可累積的系統改進，而不是每次重犯同樣問題。",
        when_to_use=["發生失敗、被糾正、發現能力缺口或外部工具異常。", "需要把 learnings 轉成長期可用的改進提案。"],
        avoid_when=["只是單次簡單任務，沒有可重複的學習價值。"],
        workflow=["記錄事件、原因與學到的事。", "整理成規則、流程或 prompt 改進。", "區分自動套用、提案或人工審批模式。"],
        outputs=["learning 記錄", "改進提案", "適用模式", "風險與影響"],
        risk_level="LOW",
        risk_notes=["主要風險是把未驗證經驗寫成硬規則", "需區分事實、提案與假設"],
    ),
    "skill-creator": SkillSpec(
        description="建立、修改、優化、翻譯與評估 skill，讓 skill 變成可穩定執行的規格。",
        business_summary="把零散想法整理成可運作的 skill，提升觸發準確率、維護性與可驗證性。",
        when_to_use=["需要新增、更新、翻譯或重構 skill。", "需要補測試案例、收斂規格或改善觸發邊界。"],
        avoid_when=["只是單次任務，不需要沉澱成 skill。"],
        workflow=["先定義用途、觸發條件與邊界。", "用最小可用 `SKILL.md` 落地。", "補測試案例並迭代。"],
        outputs=["skill 規格", "觸發條件", "輸出格式", "測試建議"],
        risk_level="LOW",
        risk_notes=["主要風險是過度抽象或亂觸發", "需與實際工具與工作流相容"],
    ),
    "skill-vetter": SkillSpec(
        description="對外部或既有 skill 做安全、權限、相容性與 Codex 適配審核。",
        business_summary="在引入或修改 skill 前先控風險，避免不安全或不適配的能力進入系統。",
        when_to_use=["安裝新 skill 前。", "引入外部 skill、修改既有 skill 或做相容性審核時。"],
        avoid_when=["任務不是 skill 審核。"],
        workflow=["檢查來源可信度、權限與實際流程。", "評估 Codex / Lobster 適配性。", "以固定格式輸出結論與處理建議。"],
        outputs=["審核報告", "風險等級", "主要風險", "處理結論"],
        risk_level="LOW",
        risk_notes=["本身是審核工具，核心風險在判斷失準", "必須用實際檔案與流程作證據"],
    ),
    "smithery-ai-cli": SkillSpec(
        description="透過 Smithery CLI 尋找、連接並使用 MCP 工具與 skill。",
        business_summary="把外部整合、MCP 連線與工具探索集中到單一 CLI 入口。",
        when_to_use=["要找新的工具、整合、MCP 服務或 skill。", "需要連接外部服務例如 GitHub、Notion、Slack、資料庫。"],
        avoid_when=["現有工具已足夠。", "不允許外部整合或安裝。"],
        workflow=["明確定義所需能力與外部系統。", "用 Smithery CLI 搜尋與連接。", "驗證權限、可用性與後續使用方式。"],
        outputs=["候選整合", "連接結果", "使用建議", "風險提醒"],
        risk_level="HIGH",
        risk_notes=["涉及外部連線、憑證與安裝", "需做安全與最小權限審核"],
        preconditions=[
            "已確認要連接的外部服務、資料範圍與最小權限需求。",
            "若涉及安裝或授權，必須先完成來源與相容性審核。",
        ],
        prohibitions=[
            "不可在未審核來源時安裝或啟用外部 skill / MCP。",
            "不可要求或暴露超出任務所需的憑證與權限。",
            "不可忽略連線後可能產生的資料外傳風險。",
        ],
    ),
    "social-content": SkillSpec(
        description="為 LinkedIn、X、Instagram、TikTok、Facebook 等平台建立與優化社群內容。",
        business_summary="把內容轉成平台適配的社群素材，提升曝光、互動與追蹤成長。",
        when_to_use=["需要貼文、thread、內容日曆或平台優化。", "要把既有內容改寫成社群版本。"],
        avoid_when=["需要的是整體內容策略而非社群執行。", "不是社群平台內容。"],
        workflow=["確認平台、受眾與轉換目標。", "產生內容角度與格式。", "調整節奏、CTA 與互動鉤子。"],
        outputs=["貼文草稿", "平台化調整", "發佈建議", "後續追蹤指標"],
        risk_level="LOW",
        risk_notes=["主要風險是平台不適配或語氣失真", "需避免過度模板化"],
    ),
    "subagent-driven-development": SkillSpec(
        description="在同一個 session 內用新鮮子代理執行獨立實作任務，並做規格與品質雙階段審查。",
        business_summary="把多任務開發拆成可平行、可審查的工作單元，提高交付品質與速度。",
        when_to_use=["已經有實作計畫，且任務彼此獨立。", "要在同一 session 內協調多個子代理執行與審查。"],
        avoid_when=["任務高度耦合。", "還在需求探索或沒有明確 plan。"],
        workflow=["抽出任務與上下文。", "派發 implementer，再做 spec review 與 code quality review。", "逐項完成後做最終總審。"],
        outputs=["任務拆解", "子代理結果", "審查意見", "完成狀態"],
        risk_level="MEDIUM",
        risk_notes=["涉及多代理協作與上下文切分", "需避免把阻塞工作錯派出去"],
    ),
    "systematic-debugging": SkillSpec(
        description="遇到 bug、失敗或異常時，先找根因再做最小有效修正。",
        business_summary="把除錯流程從亂試 patch 轉成可驗證、可重現的根因定位與修復。",
        when_to_use=["測試失敗、bug、鏈路斷裂、timeout 或異常回覆。", "需要根因分析與驗證。"],
        avoid_when=["只是一般功能開發。", "沒有錯誤訊號也沒有可重現現象。"],
        workflow=["讀完整錯誤訊號並穩定重現。", "比對可工作案例與差異。", "逐一假設驗證，再做最小修正並回歸測試。"],
        outputs=["現象", "已驗證事實", "根因", "修法", "驗證結果"],
        risk_level="LOW",
        risk_notes=["主要風險是跳過根因直接修", "必須避免一次堆疊多個 patch"],
    ),
    "tavily-search": SkillSpec(
        description="使用 Tavily API 做 AI 最佳化網路搜尋，回傳精簡且相關的結果。",
        business_summary="讓代理能快速取得外部網路資訊，支援需要搜尋與摘要的任務。",
        when_to_use=["需要 Tavily 搜尋或網路檢索。", "要以 AI 友善格式取得外部結果。"],
        avoid_when=["不需要外部資訊。", "網路不可用或不允許外部查詢。"],
        workflow=["確認查詢目標與限制。", "執行搜尋並整理關鍵結果。", "標示來源與不足之處。"],
        outputs=["查詢摘要", "主要結果", "來源", "侷限說明"],
        risk_level="MEDIUM",
        risk_notes=["涉及外部搜尋與時效性", "需避免無來源結論"],
        preconditions=[
            "已確認任務確實需要外部即時資訊，而不是本地可回答問題。",
            "查詢時應明確限制主題、時間範圍與可信來源類型。",
        ],
        prohibitions=[
            "不可把搜尋摘要當成原始事實來源，應保留來源鏈接或出處。",
            "不可在高風險領域省略時效性與資料不足說明。",
        ],
    ),
    "testing-expert": SkillSpec(
        description="規劃與補強單元、整合、E2E、smoke 與 regression 測試。",
        business_summary="提升系統回歸保護與驗證品質，降低改動後的未知風險。",
        when_to_use=["需要新增或強化測試。", "需要驗證鏈路、回歸保護或 trace。"],
        avoid_when=["任務不需要測試策略。"],
        workflow=["先定義應驗證的風險與行為。", "選擇適合的測試層級與案例。", "執行並回報 coverage 與殘餘風險。"],
        outputs=["測試目標與風險", "測試層級與案例清單", "執行方式與結果", "未覆蓋項目與殘餘風險"],
        risk_level="LOW",
        risk_notes=["主要風險是測試無法覆蓋關鍵路徑", "應避免只測 happy path"],
        preconditions=["應先知道要保護的行為、失敗條件與可接受的測試範圍。"],
        prohibitions=["不可只給泛泛建議而不指出具體測試層級與案例。", "不可把未執行的測試寫成已驗證結果。"],
    ),
    "user-research": SkillSpec(
        description="規劃、執行並整理使用者研究，包括訪談、可用性測試與問卷。",
        business_summary="把產品決策建立在真實使用者訊號上，而不是內部猜測。",
        when_to_use=["需要使用者研究計畫、訪綱、可用性測試或問卷設計。"],
        avoid_when=["只是一般市場靈感發想。", "沒有明確研究目標。"],
        workflow=["定義研究問題與對象。", "設計方法、題目與紀錄方式。", "整理洞察、模式與建議。"],
        outputs=["研究問題與目標對象", "研究方法與樣本假設", "訪綱 / 問卷 / 測試腳本", "洞察摘要、限制與建議"],
        risk_level="LOW",
        risk_notes=["主要風險是問題設計偏差", "應避免把少量訪談過度泛化"],
        preconditions=["應先釐清研究問題、受眾類型與預期決策用途。"],
        prohibitions=["不可在樣本不足或方法不匹配時給過度泛化結論。", "不可把假設寫成研究已證實的發現。"],
    ),
    "using-superpowers": SkillSpec(
        description="在開始任務前先判斷是否有合適 skill，提升解題效率與正確性。",
        business_summary="讓代理優先重用既有能力，不要忽略可直接套用的 skill。",
        when_to_use=["啟動任何新任務時。", "懷疑有 skill 可覆蓋需求時。"],
        avoid_when=["已明確使用適合的 skill。"],
        workflow=["先辨識任務類型與輸出物。", "比對是否有明確命中的 skill，以及是否真的比直接處理更合適。", "只載入最小必要 skill，並說明命中或未命中的原因後再開始執行。"],
        outputs=["命中的 skill 或未命中判斷", "選用理由", "未選用其他 skill 的原因"],
        risk_level="LOW",
        risk_notes=["主要風險是過度觸發或漏觸發", "需保持最小必要 skill 原則"],
        preconditions=["應先理解任務本身，而不是為了使用 skill 而找 skill。"],
        prohibitions=["不可把多個邊界重疊的 skill 一次全部套上。", "不可在沒有合理命中依據時硬套 skill。"],
    ),
    "web-design-guidelines": SkillSpec(
        description="檢查 UI 程式碼是否符合 Web 介面設計與可及性指引。",
        business_summary="在設計與開發之間建立品質門檻，降低可用性與一致性問題。",
        when_to_use=["要審查 UI、無障礙、設計最佳實務或 UX 合規性。"],
        avoid_when=["不是 UI / UX 任務。"],
        workflow=["檢查版面、資訊層級、互動與可及性。", "指出不符合準則的地方。", "給出修正方向與風險。"],
        outputs=["問題描述", "使用者影響與嚴重度", "對應準則或最佳實務", "修正建議"],
        risk_level="LOW",
        risk_notes=["主要風險是準則套用過度機械", "應依實際設計系統判斷"],
        preconditions=["應先知道審查對象是既有設計系統內的頁面，還是可自由發揮的新介面。"],
        prohibitions=["不可只給抽象審美評論而沒有具體問題與修正方向。", "不可忽略既有設計系統與產品上下文，硬套通用規範。"],
    ),
    "web-quality-audit": SkillSpec(
        description="對網站做效能、可及性、SEO 與最佳實務的整體品質審核。",
        business_summary="一次性檢視網站品質面向，找出對體驗與流量最有影響的缺口。",
        when_to_use=["要做網站品質、Lighthouse、SEO 或可及性審核。"],
        avoid_when=["需求只是修改單一 UI 細節。"],
        workflow=["確認要審核的站點與頁面。", "蒐集品質指標與主要問題。", "輸出優先修正項與驗證方式。"],
        outputs=["品質摘要", "主要問題", "修正優先序", "驗證建議"],
        risk_level="MEDIUM",
        risk_notes=["若涉及真站掃描需注意寫入與頻率", "結果應以證據與量測為基礎"],
    ),
    "xlsx": SkillSpec(
        description="凡是主要輸入或輸出為試算表檔案時使用，支援建立、編修、清理與轉換 `.xlsx`、`.xlsm`、`.csv`、`.tsv`。",
        business_summary="把表格型任務直接交付成可用的試算表文件，保留公式、格式與可重算能力。",
        when_to_use=["使用者要讀、改、修、整理或產出 Excel / CSV 類檔案。", "交付物必須是試算表檔。"],
        avoid_when=["主要交付物不是試算表。", "需求只是口頭分析或 HTML 報告。"],
        workflow=["確認來源檔、目標格式與是否需保留模板。", "用適合工具處理資料、格式與公式。", "若有公式，必做重算與錯誤檢查。"],
        outputs=["輸出檔案", "主要修改", "公式 / 格式驗證", "殘餘限制"],
        risk_level="MEDIUM",
        risk_notes=["可能破壞既有模板或公式", "必須避免交付含公式錯誤的檔案"],
        preconditions=[
            "已確認來源檔、輸出格式與是否要保留既有模板樣式。",
            "若修改公式或模型，必須安排重算與錯誤檢查步驟。",
        ],
        prohibitions=[
            "不可用硬編碼數值取代應保留的 Excel 公式。",
            "不可在未驗證公式錯誤、格式或工作表引用前交付檔案。",
        ],
    ),
}


def display_name(skill_name: str) -> str:
    return " ".join(part.capitalize() for part in skill_name.replace("_", "-").split("-"))


def top_level_items(skill_dir: Path) -> list[Path]:
    return sorted(path for path in skill_dir.iterdir())


def move_extras(skill_dir: Path) -> list[str]:
    moved: list[str] = []
    other_dir = skill_dir / "other"
    for item in top_level_items(skill_dir):
        if item.name in ALLOWED_TOP_LEVEL:
            continue
        if item.name not in MOVE_TO_OTHER:
            continue
        other_dir.mkdir(exist_ok=True)
        target = other_dir / item.name
        if target.exists():
            if target.is_dir():
                shutil.rmtree(target)
            else:
                target.unlink()
        shutil.move(str(item), str(target))
        moved.append(item.name)
    return moved


def detected_support_paths(skill_dir: Path) -> list[str]:
    support = []
    for name in ("references", "scripts", "assets", "src", "lib", "templates", "profiles", "reference", "examples", "hooks"):
        if (skill_dir / name).exists():
            support.append(name)
    if (skill_dir / "other").exists():
        support.append("other")
    return support


def build_skill_markdown(skill_name: str, skill_dir: Path, spec: SkillSpec) -> str:
    lines: list[str] = [
        "---",
        f"name: {skill_name}",
        f"description: {spec.description}",
        "---",
        "",
        f"# {display_name(skill_name)}",
        "",
        f"這個 skill 的主要用途是：{spec.business_summary}",
        "",
        "## 何時使用",
    ]
    lines.extend(f"- {item}" for item in spec.when_to_use)
    lines.extend(
        [
            "",
            "## 不該使用",
        ]
    )
    lines.extend(f"- {item}" for item in spec.avoid_when)
    lines.extend(
        [
            "",
            "## 核心流程",
        ]
    )
    for index, step in enumerate(spec.workflow, start=1):
        lines.append(f"{index}. {step}")
    lines.extend(
        [
            "",
            "## 建議輸出",
        ]
    )
    lines.extend(f"- {item}" for item in spec.outputs)
    if spec.preconditions:
        lines.extend(["", "## 前置條件"])
        lines.extend(f"- {item}" for item in spec.preconditions)
    if skill_name == "meeting-notes":
        lines.extend(
            [
                "",
                "## Schema 說明",
                "- `action_items`：array；每項至少含 `title`、`owner`、`deadline`。",
                "- `owner`：array；為 `action_items` 中 owner 的彙總列表。",
                "- `deadline`：array；為 `action_items` 中 deadline 的彙總列表。",
            ]
        )
    lines.extend(
        [
            "",
            "## 安全與風險",
            f"- 風險等級：`{spec.risk_level}`",
        ]
    )
    lines.extend(f"- {item}" for item in spec.risk_notes)
    if spec.prohibitions:
        lines.extend(["", "## 禁止事項"])
        lines.extend(f"- {item}" for item in spec.prohibitions)

    support_paths = detected_support_paths(skill_dir)
    if support_paths:
        lines.extend(["", "## 目錄說明"])
        for name in support_paths:
            if name == "other":
                lines.append("- `other/`：非核心 skill 文件、規劃稿、評測或歷史材料。")
            elif name == "references":
                lines.append("- `references/`：延伸說明與操作參考。")
            elif name == "scripts":
                lines.append("- `scripts/`：可直接執行的輔助腳本。")
            elif name == "assets":
                lines.append("- `assets/`：模板、素材或靜態資產。")
            else:
                lines.append(f"- `{name}/`：此 skill 的支援程式或資料。")

    lines.extend(
        [
            "",
            "## 審核要求",
            "- 不可假裝已完成查找、寫入、搜尋或外部操作。",
            "- 若需要外部工具、網路、憑證或寫入權限，必須明確確認前置條件。",
            "- 任何結論都應以實際輸出、檔案變更或工具結果作為依據。",
            "- 若任務來自 HTTP / runtime / 多步驟工作流，回報時應保留或引用 `trace_id`，方便 verifier 與 self-check 對照日志。"
            if skill_name in {"meeting-notes", "automation-workflows", "find-skills", "pua", "proactive-agent"}
            else "",
            "",
        ]
    )
    return "\n".join(line for line in lines if line != "")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--file",
        action="append",
        default=[],
        help="Process only the specified SKILL.md file or its parent skill directory. Repeatable.",
    )
    args = parser.parse_args()

    selected_dirs: set[Path] | None = None
    if args.file:
        selected_dirs = set()
        for raw in args.file:
            path = Path(raw).expanduser().resolve()
            skill_dir = path.parent if path.name == "SKILL.md" else path
            if not (skill_dir / "SKILL.md").exists():
                raise FileNotFoundError(f"SKILL.md not found for: {raw}")
            selected_dirs.add(skill_dir)

    reports: list[dict[str, object]] = []
    for root in ROOTS:
        for skill_dir in sorted(path for path in root.iterdir() if path.is_dir()):
            if not (skill_dir / "SKILL.md").exists():
                continue
            if selected_dirs is not None and skill_dir.resolve() not in selected_dirs:
                continue
            skill_name = skill_dir.name
            spec = SPECS.get(skill_name)
            if spec is None:
                raise KeyError(f"Missing spec for skill: {skill_name}")
            moved = move_extras(skill_dir)
            skill_md = skill_dir / "SKILL.md"
            skill_md.write_text(build_skill_markdown(skill_name, skill_dir, spec), encoding="utf-8")
            reports.append(
                {
                    "skill": skill_name,
                    "path": str(skill_dir),
                    "business_summary": spec.business_summary,
                    "risk_level": spec.risk_level,
                    "moved_to_other": moved,
                    "support_paths": detected_support_paths(skill_dir),
                }
            )
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(json.dumps(reports, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
