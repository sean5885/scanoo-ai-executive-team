# Skill Routing Map

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## 目的

這份文件是外部 skill 層（位於 `~/.agents` 與 `~/.codex`）在 repo 內的技術鏡像。
它記錄：

- Lobster 面對常見任務時應優先用哪些 skill
- 哪些 skill 已完成 Codex 相容性審核
- 哪些 skill 已翻譯為繁體中文

## 目前已治理的 Skill 集合

### 流程 / 治理類 Skill

- `using-superpowers`
  - 主要用途：
    - 任務入口的 skill 路由
    - 強制先用 skill，不再直接裸跑
  - 典型場景：
    - 新任務
    - 任何可能命中既有 skill 的任務
- `skill-vetter`
  - 主要用途：
    - 審核 skill 安全性、權限範圍、Codex 適配性
  - 典型場景：
    - 安裝 skill 前
    - 修改 skill 前
- `skill-creator`
  - 主要用途：
    - 建立或修訂 skill 規格、觸發條件、參考資料與評估方式
  - 典型場景：
    - skill 更新
    - 觸發條件調整
    - skill 精簡
- `self-improvement`
  - 主要用途：
    - 沉澱重複失敗、糾正與升級提案
  - 典型場景：
    - 任務失敗後
    - 使用者糾正後
    - 發現更好 workflow 後
- `pua`
  - 主要用途：
    - 在同一問題多次失敗後，強制切換到高壓攻堅模式
  - 典型場景：
    - runtime 反覆失敗
    - debug 打轉
    - 想推給使用者手動處理時

### 交付 / 執行類 Skill

- `systematic-debugging`
  - 主要用途：
    - 以根因為先的 debugging
  - 典型場景：
    - 鏈路斷裂
    - 測試失敗
    - runtime regression
- `feishu-doc`
  - 主要用途：
    - Lark / Feishu 文件讀寫流程
  - 典型場景：
    - 文檔讀寫
    - wiki 抓取
    - 長文追加
- `meeting-notes`
  - 主要用途：
    - 產出結構化會議結果
  - 典型場景：
    - transcript 摘要
    - decisions / action items 萃取
    - knowledge / task 回寫準備
- `testing-expert`
  - 主要用途：
    - smoke / integration / regression 測試補強
  - 典型場景：
    - route 保護
    - chain 驗證
    - bug regression 鎖定
- `refactor`
  - 主要用途：
    - 在不改外部行為的前提下做最小重構
  - 典型場景：
    - 拆分不穩 workflow
    - 收斂 executor / server 膨脹
- `git-master`
  - 主要用途：
    - 帶防呆與回滾意識的 Git 操作
  - 典型場景：
    - repo 維護
    - branch / rebase / recovery

## 建議 Skill Stack

### Runtime failure / regression

1. `using-superpowers`
2. `systematic-debugging`
3. `testing-expert`
4. `self-improvement`
5. `pua` only after repeated failure

### Lark / Feishu 文件或知識流

1. `using-superpowers`
2. `feishu-doc`
3. `systematic-debugging` when chain is broken
4. `testing-expert` for regression coverage
5. `self-improvement`

### 會議流程

1. `using-superpowers`
2. `meeting-notes`
3. `feishu-doc` when doc writeback is involved
4. `testing-expert` for meeting chain verification
5. `self-improvement`

### Skill 治理工作

1. `using-superpowers`
2. `skill-vetter`
3. `skill-creator`
4. `self-improvement`

### 大型清理 / 程式碼品質工作

1. `using-superpowers`
2. `refactor`
3. `testing-expert`
4. `git-master` when version-control safety matters
5. `self-improvement`

## 本輪已完成審核與更新的 Skill

以下外部 skill 已在本輪完成審核與更新：

- `using-superpowers`
- `skill-vetter`
- `skill-creator` (`~/.agents` variant)
- `skill-creator` (`~/.codex/.system` variant)
- `systematic-debugging`
- `self-improvement`
- `pua`
- `feishu-doc`
- `meeting-notes`
- `testing-expert`
- `refactor`
- `git-master`

## 尚未完整審核的 Skill

全域 skill 清單大於本輪處理範圍。其餘 skill 建議依 Lobster 關聯度與風險高低分批審核，下一批優先順序如下：

- `document-formatter`
- `code-review`
- `data-analyst`
- `automation-workflows`
- `dev-browser`
- `playwright-cli`
- `frontend-ui-ux-engineer`
- `nano-image-generator`
