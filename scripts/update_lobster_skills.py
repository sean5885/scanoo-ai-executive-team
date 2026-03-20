from pathlib import Path
from textwrap import dedent


SKILL_UPDATES = {
    Path("/Users/seanhan/.agents/skills/using-superpowers/SKILL.md"): dedent(
        """\
        ---
        name: using-superpowers
        description: 啟動任何任務前先判斷並使用合適的 skill。只要有合理機率命中 skill，就先載入 skill，再開始回答、提問、搜尋、改碼或執行指令。
        ---

        # 使用 Superpowers

        這個 skill 是所有 skill 的入口規範。你的工作不是直接上手做事，而是先判斷「現在該用哪些 skill」。

        ## 優先級

        1. 使用者明確要求、repo 內 `AGENTS.md`、工作區規範
        2. skill 規範
        3. 平台預設行為

        如果 skill 與使用者或 repo 規範衝突，以使用者與 repo 規範為準。

        ## 什麼時候一定要用 skill

        只要符合以下任一條件，就必須先用 skill：

        - 使用者明確點名某個 skill
        - 任務明顯符合某個 skill 的用途
        - 你懷疑某個 skill 可能有幫助，即使只有小機率

        ## Codex 工作方式

        在 Codex 中：

        1. 先打開對應 skill 的 `SKILL.md`
        2. 只讀足夠完成當前任務的片段
        3. 如果 skill 有 `scripts/`、`references/`、`assets/`，優先重用，不要重寫一份新的
        4. 開工前用一句話說明你正在用哪些 skill，以及原因

        ## 推薦順序

        先流程 skill，再領域 skill：

        1. 流程 skill
           - `systematic-debugging`
           - `skill-vetter`
           - `skill-creator`
           - `self-improvement`
           - `pua`
        2. 領域 skill
           - `feishu-doc`
           - `meeting-notes`
           - `testing-expert`
           - `refactor`
           - `git-master`

        ## 標準流程

        1. 收到任務
        2. 判斷是否命中 skill
        3. 載入最小必要 skill
        4. 宣告本輪使用的 skill stack
        5. 按 skill 流程做事
        6. 若任務失敗、被糾正、或發現更好的做法，補用 `self-improvement`

        ## 禁止事項

        - 不可先動手再回頭補 skill
        - 不可明明命中 skill 卻硬用一般能力裸跑
        - 不可一次載入一堆不相關 skill，造成 context 污染
        - 不可把「我記得這個 skill 在說什麼」當成已使用 skill

        ## 最小自檢

        開始前確認：

        - 這個任務有沒有明顯對應的 skill？
        - 我是不是用了最小但足夠的 skill 組合？
        - 我有沒有先用流程 skill，再用領域 skill？
        """
    ),
    Path("/Users/seanhan/.codex/skills/skill-vetter/SKILL.md"): dedent(
        """\
        ---
        name: skill-vetter
        version: 1.1.0
        description: 安全優先的 skill 審核器。用於安裝、引入、更新或接受任何外部 skill 前的安全性、相容性、權限範圍與 Codex 適配審核。
        ---

        # Skill Vetter

        這個 skill 用來回答兩件事：

        1. 這個 skill 安不安全？
        2. 這個 skill 是否真的適合目前的 Codex / Lobster 工作流？

        ## 何時使用

        - 安裝新 skill 之前
        - 從 GitHub、ClawdHub、他人分享來源引入 skill 時
        - 想修改既有 skill，又不確定會不會破壞現有流程時
        - 想確認某個 skill 是否適合 Codex / Lobster 使用時

        ## 審核面向

        ### 1. 來源可信度

        檢查：

        - skill 來源
        - 作者是否可信
        - 是否長期維護
        - 是否有版本資訊

        ### 2. 安全風險

        看到以下任一項，至少標記高風險：

        - 對未知網址 `curl` / `wget`
        - 主動外傳資料
        - 要求憑證、token、API key
        - 讀取 `~/.ssh`、`~/.aws`、`~/.config` 等敏感路徑且沒有充分理由
        - 存取記憶、身份、cookie、session 類檔案
        - 執行 `eval` / `exec`
        - 未說明就安裝套件
        - 要求 sudo / root / 高權限
        - 修改工作區外系統檔
        - 混淆、壓縮、base64 解碼不明內容

        ### 3. Codex 適配性

        檢查：

        - 觸發條件是否清楚
        - workflow 是否可在 Codex 中落地
        - 是否依賴不存在的工具
        - 是否要求過多 context
        - 是否與 repo `AGENTS.md` 或系統規範衝突
        - 是否會造成過度觸發、亂觸發、長篇空話或流程僵化

        ### 4. 權限與範圍

        檢查：

        - 需要讀哪些檔
        - 需要寫哪些檔
        - 需要跑哪些命令
        - 是否需要網路
        - 是否真的只拿到完成任務所需的最小權限

        ## 風險等級

        - `LOW`：純文檔、格式化、輕量流程指引
        - `MEDIUM`：檔案讀寫、API、瀏覽器、自動化
        - `HIGH`：憑證、部署、金流、系統設定
        - `EXTREME`：root 權限、秘密資料、未知外傳行為

        ## 標準輸出

        請固定輸出：

        ```text
        Skill 審核報告
        - Skill：
        - 來源：
        - 版本：
        - 主要用途：
        - 主要風險：
        - 權限需求：
        - Codex 適配度：
        - 結論：
        - 建議處理：
        ```

        ## 結論規則

        - 安全且適配：`可使用`
        - 可用但需限制：`可使用，但需收斂`
        - 高風險需人工決策：`需人工審批`
        - 明顯危險：`不可使用`

        ## 最小自檢

        在給出結論前確認：

        - 我有看來源嗎？
        - 我有看權限嗎？
        - 我有看實際流程嗎？
        - 我有判斷是否適合 Codex / Lobster 嗎？
        - 我有把風險講成人話嗎？
        """
    ),
    Path("/Users/seanhan/.agents/skills/skill-creator/SKILL.md"): dedent(
        """\
        ---
        name: skill-creator
        description: 建立、修改、優化與評估 skill。當需要新增 skill、重寫 skill、翻譯 skill、精簡規格、補測試或提升觸發準確率時使用。
        ---

        # Skill Creator

        這個 skill 用來把 skill 從想法做成可穩定使用的規格，而不是只寫一份好看的 `SKILL.md`。

        ## 何時使用

        - 建立新 skill
        - 修改既有 skill
        - 翻譯 skill
        - 精簡過長或過度抽象的 skill
        - 提升 skill 的觸發描述與可執行性
        - 為 skill 補充測試案例與評估方法

        ## 工作原則

        ### 1. 先定義用途，再寫內容

        每個 skill 至少要先釐清：

        - 這個 skill 是幫誰解決什麼問題
        - 什麼情況一定要觸發
        - 什麼情況不該觸發
        - 使用後應產出什麼

        ### 2. 先短而強，再補參考資料

        - `SKILL.md` 放核心規則與流程
        - 太長的例子、參考、模板放到 `references/` 或 `assets/`
        - 不要把 skill 寫成教科書

        ### 3. 讓 skill 可被 Codex 真正執行

        檢查：

        - 是否依賴真實存在的工具
        - 是否能用最小上下文完成
        - 是否與工作區 `AGENTS.md` 相容
        - 是否有明確輸入、輸出、限制與失敗處理

        ## 建立 / 更新流程

        1. 捕捉使用情境
        2. 定義觸發條件
        3. 定義輸出格式
        4. 寫最小可用 `SKILL.md`
        5. 補 2 到 3 個真實測試案例
        6. 根據測試結果迭代

        ## 建議結構

        ```text
        skill-name/
        ├── SKILL.md
        ├── references/
        ├── scripts/
        └── assets/
        ```

        ## `SKILL.md` 必備欄位

        - name
        - description
        - 何時使用
        - 核心流程
        - 輸出格式
        - 限制 / 禁止事項
        - 必要時的測試建議

        ## 常見壞味道

        - 只有概念，沒有執行步驟
        - 只有步驟，沒有觸發條件
        - 太長，導致 context 浪費
        - 沒寫限制，導致 skill 亂觸發
        - 與現有 skill 重疊卻沒說邊界

        ## 交付標準

        一個合格的 skill 應該做到：

        - 何時該用，一眼能看懂
        - 何時不該用，也講清楚
        - Codex 能照著做，不靠猜
        - 與其他 skill 的邊界清楚
        - 有最小可驗證案例
        """
    ),
    Path("/Users/seanhan/.codex/skills/.system/skill-creator/SKILL.md"): dedent(
        """\
        ---
        name: skill-creator
        description: 建立與更新適合 Codex 的 skill。當你要新增 skill、調整規格、縮短 prompt、補 references/scripts/assets、或改善觸發精準度時使用。
        metadata:
          short-description: 建立或更新 skill
        ---

        # Skill Creator

        這個版本偏向 Codex 平台本身的 skill 設計規範。

        ## 目標

        把 skill 做成：

        - 觸發清楚
        - 流程可執行
        - context 成本低
        - 工具依賴真實
        - 能與使用者 / repo 規範共存

        ## 核心原則

        ### 短而強

        Codex 已經很強。skill 應該只補：

        - 模型不知道的流程
        - 特定工具的用法
        - 業務規則與限制
        - 易做錯的判斷邊界

        ### 適度自由

        - 高風險流程：規範要更明確
        - 低風險創意工作：保留更多自由度

        ### 漸進式揭露

        - `SKILL.md` 只放核心工作流
        - 長參考資料放 `references/`
        - 可重複腳本放 `scripts/`
        - 產出模板放 `assets/`

        ## 設計檢查表

        每次建立或更新 skill，請檢查：

        - 觸發描述是否足夠具體
        - 是否說清楚何時不用
        - 是否與現有 skill 重疊
        - 是否依賴不存在的工具
        - 是否需要 references / scripts / assets 拆層
        - 是否過長、過度說明、浪費 context

        ## 建議輸出

        在交付 skill 時，請同時說明：

        - 主要用途
        - 觸發條件
        - 不觸發條件
        - 主要輸出
        - 相依工具 / 檔案
        - 是否需要後續 eval
        """
    ),
    Path("/Users/seanhan/.agents/skills/systematic-debugging/SKILL.md"): dedent(
        """\
        ---
        name: systematic-debugging
        description: 遇到 bug、測試失敗、鏈路斷裂、奇怪回覆、效能退化或任何技術異常時優先使用。先找根因，再修問題。
        ---

        # Systematic Debugging

        隨便試 patch 只會讓問題越來越髒。這個 skill 的目的，是先找出根因，再做最小有效修正。

        ## 鐵律

        **沒有完成根因調查前，不准直接提修法。**

        ## 何時使用

        - 測試失敗
        - bug 重現
        - Lark / 文檔 / API / OAuth / DB 鏈路斷裂
        - 不符合預期的回覆或 workflow 掉 lane
        - 效能退化或 timeout

        ## 四階段流程

        ### Phase 1：根因調查

        1. 讀完整錯誤訊號
        2. 穩定重現
        3. 查最近變更
        4. 若是多組件系統，補診斷資訊確認壞在哪一層
        5. 追資料流到源頭

        ### Phase 2：模式比對

        1. 找可工作的相似案例
        2. 對照參考實作或文件
        3. 列出差異
        4. 確認依賴與前置條件

        ### Phase 3：假設與驗證

        1. 一次只立一個假設
        2. 用最小改動驗證
        3. 失敗就回頭重建假設
        4. 不知道就承認不知道，補資料，不裝懂

        ### Phase 4：實作與驗證

        1. 先有 failing case
        2. 一次做一個修正
        3. 驗證修好且沒炸別的地方
        4. 若連續多次修不好，停下來質疑架構，不要一直磨同一個點

        ## 必做輸出

        debug 回報至少要有：

        - 問題現象
        - 已驗證的事實
        - 假設
        - 驗證結果
        - 根因
        - 修法
        - 驗證方式
        - 可能的延伸風險

        ## 禁止事項

        - 先猜再修
        - 一次疊很多 patch
        - 沒看 log / stack trace / 原始輸入
        - 沒驗證就說修好了
        """
    ),
    Path("/Users/seanhan/.codex/skills/self-improving-agent/SKILL.md"): dedent(
        """\
        ---
        name: self-improvement
        description: 在失敗、被糾正、發現更好做法、能力缺口或外部工具異常時記錄 learnings，並把可重複發生的問題沉澱為規則、流程與升級提案。
        metadata:
        ---

        # Self-Improvement

        這個 skill 是 Lobster 閉環系統的學習層。目的不是寫日記，而是把錯誤轉成可追蹤、可修正、可升級的資產。

        ## 何時使用

        - 指令或工具執行失敗
        - 使用者糾正你
        - 發現系統缺能力
        - API / 外部工具異常
        - 發現更好的處理方式
        - 某種錯誤反覆出現

        ## 記錄去向

        - `.learnings/ERRORS.md`：錯誤、例外、失敗案例
        - `.learnings/LEARNINGS.md`：修正、知識缺口、最佳做法
        - `.learnings/FEATURE_REQUESTS.md`：缺失能力與使用者需求

        ## 最小工作流

        1. 記錄發生了什麼
        2. 記錄影響範圍
        3. 記錄已收集的 evidence
        4. 記錄真正根因或目前推測
        5. 記錄下次應如何避免
        6. 若屬於可系統化的問題，提出 improvement proposal

        ## 建議欄位

        - `Summary`
        - `What happened`
        - `Evidence`
        - `Impact`
        - `Suggested action`
        - `Pattern-Key`
        - `See Also`

        ## 什麼時候要升級到規則層

        以下情況應從 learnings 提升到 `AGENTS.md` / `RULES.md` / workflow：

        - 同類錯誤重複出現
        - 會造成 fake completion
        - 會導致工具空口亂答
        - 會讓使用者持續不信任系統
        - 可用 checklist 或 routing 規則防止

        ## 禁止事項

        - 只記錄結果，不記錄原因
        - 只記錄情緒，不記錄 evidence
        - 明明找到可複用規律，卻不提出升級建議
        """
    ),
    Path("/Users/seanhan/.codex/skills/pua/SKILL.md"): dedent(
        """\
        ---
        name: pua
        description: 在同一問題失敗 2 次以上、快要放棄、想叫使用者手動處理、或陷入被動循環時強制進入高壓、全鏈路、端到端的問題攻堅模式。不是首輪任務使用。
        version: 1.1.0
        homepage: https://openpua.ai
        license: MIT
        ---

        # PUA 萬能激勵引擎

        這個 skill 不是拿來演戲，是拿來強制中止擺爛、猜測、被動等待、推給使用者手動處理。

        ## 觸發條件

        只有在以下情況才用：

        - 同一問題已失敗 2 次以上
        - 你正打算說「請手動處理」
        - 你正在重複同一種做法
        - 你想把責任推給環境，但還沒驗證
        - 使用者已經明確不滿

        ## 三條鐵律

        1. 沒有窮盡方案前，不准說「無法解決」
        2. 先查後問，先做後問
        3. 不只修眼前一點，要補上下游與同類風險

        ## 標準動作

        ### 第一步：停下來辨識你是不是在原地打轉

        列出：

        - 已試過什麼
        - 哪些其實只是同一路線的小變體
        - 還有哪些本質不同的方向沒試

        ### 第二步：強制完成這些檢查

        - 讀完整錯誤訊號
        - 搜尋關鍵錯誤或關鍵限制
        - 讀原始文件 / 原始程式 / 原始 payload
        - 驗證前置假設
        - 試一個相反方向的假設
        - 補最小重現或最小 PoC

        ### 第三步：端到端思考

        檢查：

        - 只修了一點，還是整條鏈真的通了？
        - 修好後有沒有驗證？
        - 同類問題會不會在別處再發生？

        ## 壓力升級

        - 第 2 次失敗：換本質不同方案
        - 第 3 次失敗：列 3 個全新假設並逐個驗證
        - 第 4 次以上：補最小隔離環境與 PoC，必要時質疑現有架構

        ## 合格輸出

        當你真的還無法解決時，只能交付結構化失敗報告：

        - 已驗證事實
        - 已排除可能性
        - 問題邊界
        - 建議下一步
        - 可交接資訊

        ## 禁止事項

        - 直接叫使用者自己做
        - 沒驗證就怪環境
        - 重複同一路線卻假裝很努力
        - 用漂亮話掩蓋沒有進展
        """
    ),
    Path("/Users/seanhan/.codex/skills/feishu-doc/SKILL.md"): dedent(
        """\
        ---
        name: feishu-doc
        description: 讀取、建立、寫入與更新飛書（Lark / Feishu）Wiki、Docs、Sheets、Bitable。當任務涉及文件讀寫、內容抽取、長文寫入、或需要把結果落地到飛書時使用。
        tags: [feishu, lark, wiki, doc, sheet, document, reader, writer]
        ---

        # Feishu Doc

        這個 skill 用來處理飛書 / Lark 文件，不是單純貼字，而是要把讀寫流程做穩。

        ## 何時使用

        - 讀取 Lark Docs / Wiki / Sheets / Bitable
        - 建立新文檔
        - 覆寫文檔內容
        - 追加長文內容
        - 依 block 做精準更新

        ## 主要能力

        - `Read`：讀文檔與內容
        - `Create`：建立空白文檔
        - `Write`：以 Markdown 覆寫文檔
        - `Append`：分段追加內容
        - `Blocks`：列出、讀取、更新、刪除指定 block

        ## 長文處理規則

        內容很長時，不要一次整份覆寫。請改成：

        1. 先建立文檔拿到 `doc_token`
        2. 把內容切成邏輯段落
        3. 逐段 append

        ## 前置條件

        - 已有有效的 Lark / Feishu 授權
        - 已配置對應 token / app id / app secret
        - 寫入前確認你真的知道要寫到哪份文檔

        ## 建議輸出

        處理完成後，至少回報：

        - 操作類型（讀 / 建 / 寫 / 追加 / block 更新）
        - 目標文檔
        - 是否成功
        - 產出的 `doc_token` / link / 變更摘要

        ## 禁止事項

        - 沒調用工具卻說已讀到或已寫入
        - 長文一次覆寫導致失敗
        - 不知道目標文檔時仍硬寫
        """
    ),
    Path("/Users/seanhan/.agents/skills/meeting-notes/SKILL.md"): dedent(
        """\
        ---
        name: meeting-notes
        description: 會議筆記、會議紀要、決議整理與待辦追蹤 skill。當任務涉及會議逐字稿、討論摘要、行動項、決策、owner、deadline、風險與 follow-up 建議時使用。
        license: MIT
        metadata:
          author: awesome-llm-apps
          version: "1.1.0"
        ---

        # Meeting Notes

        這個 skill 要輸出的不是流水帳，而是可執行的會議結果。

        ## 何時使用

        - 整理會議記錄
        - 產出會議摘要
        - 萃取決議與待辦
        - 需要指定 owner / deadline
        - 需要把會議內容轉成後續任務或知識提案

        ## 必備輸出

        每份結果至少要包含：

        - `summary`
        - `decisions`
        - `action_items`
        - `owner`
        - `deadline`
        - `risks`
        - `open_questions`
        - `knowledge_writeback`
        - `task_writeback`

        ## 建議格式

        ```markdown
        # [會議名稱]

        ## 摘要
        - ...

        ## 決議
        - ...

        ## 行動項
        | 任務 | Owner | Deadline | 狀態 |

        ## 風險
        - ...

        ## 待確認問題
        - ...

        ## 知識回寫建議
        - ...

        ## 任務回寫建議
        - ...
        ```

        ## 驗證規則

        交付前檢查：

        - action items 是否有 owner
        - deadline 是否缺失
        - decisions 是否清楚
        - 是否有風險與未決問題
        - 是否需要進 knowledge proposal / conflict / task pipeline

        ## 禁止事項

        - 把會議逐字稿直接當紀要
        - 沒有 owner 或 deadline 就說整理完成
        - 沒有決議卻假裝有結論
        """
    ),
    Path("/Users/seanhan/.agents/skills/testing-expert/SKILL.md"): dedent(
        """\
        ---
        name: testing-expert
        description: 單元、整合、E2E、smoke、regression 測試專家。當任務涉及測試補強、鏈路驗證、回歸保護、trace 斷點檢查或穩定性治理時使用。
        ---

        # Testing Expert

        這個 skill 的重點不是追求漂亮覆蓋率，而是讓高風險鏈路真的可驗證、可回歸。

        ## 何時使用

        - 補單元測試
        - 補 integration / E2E
        - 建立 smoke / regression
        - 驗證 route / handler / tool / formatter 鏈路
        - 修完 bug 後補防回歸

        ## Lobster 優先測試順序

        1. route / command 命中
        2. 核心 tool 鏈路
        3. 文檔 / 群組 / 確認流
        4. knowledge / meeting / image
        5. 高風險寫入路徑

        ## 測試類型

        - Unit：邏輯分支與 schema
        - Integration：模組間真實接線
        - Smoke：最小成功路徑
        - Regression：針對真實失敗案例鎖住

        ## 交付標準

        每次補測至少回答：

        - 這個測試保護哪條鏈路？
        - 成功條件是什麼？
        - 失敗後能看出斷在哪一層嗎？

        ## 禁止事項

        - 只補 happy path，忽略高風險失敗場景
        - 只驗 function，不驗整條鏈路
        - 修 bug 不補 regression
        """
    ),
    Path("/Users/seanhan/.agents/skills/refactor/SKILL.md"): dedent(
        """\
        ---
        name: refactor
        description: 以最小改動改善可維護性且不改外部行為。適用於抽函式、拆大模組、命名改善、刪除重複邏輯、縮小耦合與逐步清理技術債。
        license: MIT
        ---

        # Refactor

        重構不是重寫。目標是讓系統更穩、更清楚、更好改，但外部行為保持不變。

        ## 何時使用

        - 代碼太難讀
        - 模組太大
        - 重複邏輯太多
        - 每次改功能都很痛
        - 需要為後續功能鋪路

        ## 核心規則

        1. 行為不變
        2. 小步提交
        3. 先有測試或至少有可驗證基準
        4. 一次只做一件事
        5. 不混進新功能

        ## Lobster 適用重點

        - 優先拆高風險大檔，例如 router / executor / server
        - 優先把容易反覆壞掉的 workflow 拉成獨立模組
        - 每次重構都要補回歸或 smoke

        ## 禁止事項

        - 以重構為名偷改邏輯
        - 沒驗證就宣稱更穩
        - 大拆大改導致無法回滾
        """
    ),
    Path("/Users/seanhan/.agents/skills/git-master/SKILL.md"): dedent(
        """\
        ---
        name: git-master
        description: 所有 Git 任務都應優先使用的 skill，包含安全檢查、分支策略、衝突處理、歷史修復、危險操作防呆與平台差異處理。
        ---

        # Git Master

        這個 skill 的目標是：在做任何 Git 操作時，先保命，再做事。

        ## 何時使用

        - 任何 Git 任務
        - branch / merge / rebase / cherry-pick
        - 衝突處理
        - reset / revert / force push
        - 歷史修復
        - GitHub / Bitbucket / Azure DevOps 差異處理

        ## 第一原則

        危險操作前一定先：

        1. 看 `git status`
        2. 看最近 commit
        3. 說清楚風險
        4. 必要時先建 backup branch
        5. 讓使用者決定是否繼續

        ## Commit 規則

        先確認使用者偏好：

        - 幫他自動 commit
        - 只 stage，不 commit
        - 只提供指令，由他手動操作

        ## Lobster 額外規則

        - 不要為了整理歷史而破壞可回滾性
        - 沒有使用者明確同意，不做 destructive Git 操作
        - 技術鏡像更新若要進版控，優先和對應 code 改動一起提交

        ## 禁止事項

        - 不經確認就 `reset --hard`
        - 不經確認就 `push --force`
        - 不檢查現狀就給危險指令
        """
    ),
}


def main() -> None:
    for path, content in SKILL_UPDATES.items():
        path.write_text(content, encoding="utf-8")
        print(f"updated {path}")


if __name__ == "__main__":
    main()
