# Skill Audit Summary

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## 範圍

這份文件整理了第一批已完成審核與繁中化的外部 skill。這些 skill 會直接影響 Lobster 的執行品質、除錯品質、文檔處理品質與持續改進能力。

## 審核方法

本輪審核主要依據 `using-superpowers`、`skill-vetter`、`skill-creator` 這三條流程，重點放在：

- Codex 相容性
- Lobster workflow 適配度
- 觸發條件清晰度
- token 成本
- 避免過長、過硬、過制度化說明
- 繁體中文翻譯

## 已更新 Skill 與主要業務摘要

### 1. `using-superpowers`

- 主要業務角色：
  - 在任務開始前明確決定 skill 使用策略
- 主要修改：
  - 翻成繁中
  - 對齊使用者 / repo 規範優先級
  - 明確最小 skill stack
- 主要價值：
  - 減少裸跑與品質漂移

### 2. `skill-vetter`

- 主要業務角色：
  - 在採用 skill 前做安全與適配性審核
- 主要修改：
  - 翻成繁中
  - 新增 Codex / Lobster 相容性檢查
  - 改成清楚的中文審核報告格式
- 主要價值：
  - 降低引入危險或不適配 skill 的風險

### 3. `skill-creator` (`~/.agents`)

- 主要業務角色：
  - 建立與修訂真正可上線使用的 skill
- 主要修改：
  - 翻成繁中
  - 收斂概念性空話
  - 聚焦觸發條件、輸出與最小 eval loop
- 主要價值：
  - 讓 skill 迭代從理論變成實作

### 4. `skill-creator` (`~/.codex/.system`)

- 主要業務角色：
  - Codex 平台內的 skill 設計規範
- 主要修改：
  - 翻成繁中
  - 強化 progressive disclosure 與 context 成本意識
  - 明確 trigger overlap 與缺失依賴檢查
- 主要價值：
  - 提升 Codex 專用 skill 的規格品質

### 5. `systematic-debugging`

- 主要業務角色：
  - Lobster runtime 問題的根因式除錯
- 主要修改：
  - 翻成繁中
  - 收斂為更嚴格的四階段 workflow
  - 強化 evidence、最小修正與驗證
- 主要價值：
  - 減少不經診斷就 patch

### 6. `self-improvement`

- 主要業務角色：
  - 把失敗與糾正沉澱成可重複使用的升級資產
- 主要修改：
  - 翻成繁中
  - 對齊 Lobster 的 closed-loop improvement 模型
  - 明確何時要升級為規則或 workflow
- 主要價值：
  - 支撐持續可靠性提升

### 7. `pua`

- 主要業務角色：
  - 反覆失敗後的高壓恢復流程
- 主要修改：
  - 由簡中改為繁中
  - 收斂成更可用的升級式 workflow
  - 保留「不可太早放棄」的核心
- 主要價值：
  - 避免過早退回手動處理

### 8. `feishu-doc`

- 主要業務角色：
  - Feishu / Lark 文檔讀寫與長文追加
- 主要修改：
  - 翻成繁中
  - 明確長文 chunking 規則
  - 強化「無 evidence 不可聲稱已寫入」
- 主要價值：
  - 這是 Lobster 的核心交付層之一

### 9. `meeting-notes`

- 主要業務角色：
  - 把 transcript 或會議筆記轉成結構化結果
- 主要修改：
  - 翻成繁中
  - 對齊 Lobster meeting schema
  - 補 owner / deadline / knowledge / task writeback 檢查
- 主要價值：
  - 讓 meeting 輸出更接近真正的 executive workflow

### 10. `testing-expert`

- 主要業務角色：
  - 為脆弱鏈路補 smoke / integration / regression 保護
- 主要修改：
  - 翻成繁中
  - 對齊 Lobster 的真實高風險鏈路
  - 強調 chain verification，不追求虛榮覆蓋率
- 主要價值：
  - 防止 routing 與 workflow continuity 反覆回歸

### 11. `refactor`

- 主要業務角色：
  - 低風險清理不穩定代碼
- 主要修改：
  - 翻成繁中
  - 對齊最小改動、保留行為的重構原則
  - 明確提到拆分不穩定 workflow
- 主要價值：
  - 支援可靠性治理，又不必大重寫

### 12. `git-master`

- 主要業務角色：
  - 安全的 Git 操作與回滾防護
- 主要修改：
  - 將關鍵規則翻成繁中
  - 保留 destructive-operation guardrails
  - 對齊 Lobster 偏好的可回滾變更
- 主要價值：
  - 降低維護時誤傷 Git 歷史或工作樹的風險

## 本輪主要業務成果

這一批不直接新增面向終端使用者的新功能，但它帶來的是營運層面的提升：

- 任務執行更一致
- debug workflow 更乾淨
- 會議輸出品質更高
- Lark 文檔操作更穩
- 測試與重構更可靠
- 後續 Lobster 升級的 skill 治理基礎更完整

## 後續工作

這只是第一批。其餘全域 skill 仍需依關聯度與風險高低分批審核與繁中化。
