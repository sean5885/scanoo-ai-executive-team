# File Organization Reply Spec

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Purpose

This spec defines how Lobster should present document-organization results to end users when the underlying operation comes from:

- `lark_drive_organize`
- `lark_wiki_organize`
- `/api/drive/organize/preview`
- `/api/drive/organize/apply`
- `/api/wiki/organize/preview`
- `/api/wiki/organize/apply`

The goal is to turn machine-shaped organization results into a human-readable organization report.

## Required Output Style

The reply must use:

1. `結論`
2. `重點`
3. `下一步`

The reply must not output:

- raw JSON
- markdown tables
- internal field dumps
- debug metadata blobs
- `semantic_classifier` object as-is

## User-Facing Goal

The user should be able to understand, at a glance:

- how many major groups were identified
- which documents belong to each group
- whether this is only a preview or already applied
- which items still need manual review

## Input Payloads to Support

The formatter should consume the compact organization payload shape already returned by plugin/service code:

- `folder_token` or `space_id`
- `space_name`
- `action`
- `scanned_total`
- `movable_total`
- `moves_submitted`
- `target_folder_names`
- `created_folder_names`
- `move_preview`
- `move_preview_truncated`
- `total_move_records`
- `semantic_classifier`

Each `move_preview` item may include:

- `name`
- `type`
- `target_folder_name`
- `reason`
- `status`
- `task_id`

## Rendering Rules

### 1. Header

Use a short title based on operation type:

- preview:
  - `你的文檔分類`
  - `你的知識庫整理建議`

- apply:
  - `你的文檔已整理`
  - `你的知識庫已整理`

### 2. Conclusion Section

First sentence must state:

- preview or applied
- number of primary groups
- total documents affected

Preferred pattern:

- `我先把這批文件整理成 3 個主題，共 26 份可移動文件。`
- `我已把這批文件按 4 個主題整理，已提交 18 筆移動。`

### 3. Grouping Section

Group documents by `target_folder_name`.

For each group:

- show group name
- show count
- list document names

Preferred pattern:

- `Scanoo/掃掃（13份）`
- `產品/技術（8份）`

Do not expose:

- raw folder token
- raw node token
- task ids unless user explicitly asks for execution tracking

### 4. Group Ordering

Sort groups by:

1. document count descending
2. then Chinese name ascending

This makes the most important category appear first.

### 5. Document Listing Rules

Inside each group:

- show only document names
- omit file ids and URLs by default
- cap each group display to 12 items
- if truncated, append one short note:
  - `其餘文件已省略，可再展開整理。`

### 6. Secondary Labeling

If `reason` patterns are reliable, sub-label inside a group may be used.

Allowed sub-label examples:

- `產品/技術`
- `流程/SOP`
- `商業化/競爭`
- `介紹/藍圖`
- `公司籌備`

Do not fabricate sub-labels if source signal is weak.

### 7. Preview vs Apply Difference

Preview should say:

- this is a suggestion
- not yet moved

Apply should say:

- action has been submitted or completed
- folders created if relevant

### 8. Semantic Classifier Handling

If `semantic_classifier.error` exists:

- do not dump the error object
- downgrade to one short sentence:
  - `這次分類主要依標題與現有內容規則整理，語義分類器未完整參與。`

If classifier worked:

- one short sentence is enough:
  - `這次也參考了文件內容語義，不只是檔名。`

### 9. Manual Review Bucket

If items cannot be confidently grouped, place them in:

- `待人工確認`
- `未完全確定`

Do not pretend everything is confidently classified.

When rendering any pending item list such as `待人工確認`, `待重新分配`, or `待覆核`, the user-facing reply must include concrete document locators instead of only a total count or a generic summary.

Minimum per-item fields:

- document title or another recognizable file name
- current pending status
- reason for the pending state
- one explicit action line when an item is locally actionable, for example `操作：標記完成`

For cloud-doc follow-up replies that are focused on pending-item cleanup, the visible text should be reorganized into:

- `結論`
- `摘要`
- `待處理清單`

In that checklist view, each pending item should keep only:

- `文件名`
- `狀態`
- `簡短原因`
- `操作`

Document name resolution in that checklist view should prefer:

- `title`
- `node_title`
- `document_title`
- `file_name`
- `name`

Only when none of the above are available should the renderer fall back to identifiers such as `document_id` or `file_token`.

Recommended locator fields when available:

- `parent_path`
- `document_id` / `file_token` / `node_id`
- source type

Those locator fields should be downgraded behind the checklist view or kept in machine-readable metadata; they should not be flattened into the same visible one-line pending-item summary.

When the reply exposes a local pending-item action, the machine-readable metadata should keep the action payload separate from the visible text and include at least:

- `action=mark_resolved`
- `document_id`
- `file_token`

### 10. Next Step Section

Always end with one clear next step prompt.

Allowed examples:

- `如果你要，我可以接著幫你把未分配的文件單獨列出來。`
- `如果你要，我可以再把這批整理成公司層、產品層、SOP 層。`
- `如果你確認這份 preview，可以直接幫你套用整理。`

## Prompt Template

Use this template when converting organization payload into user-facing reply.

```text
你是 Lobster 的文件整理助手。

你的任務是把「文件整理結果 payload」轉成給使用者看的整理報告。

目標：
1. 讓使用者一眼看懂這批文件被分成哪些主題
2. 不輸出 JSON、表格、debug 欄位、內部 token
3. 預設使用「結論 + 重點 + 下一步」
4. 若是 preview，要明說還沒真的移動
5. 若是 apply，要明說已提交或已完成整理

輸出限制：
- 不可輸出 raw JSON
- 不可輸出 markdown 表格
- 不可逐欄解釋 payload
- 不可編造不存在的分類
- 不可省略不確定性；若分類不穩，請用「待人工確認」

輸出格式：
結論：
用 1 到 2 句話總結這次整理結果

重點：
按分類群組列出，每組顯示「分類名（N份）」與文件名清單

下一步：
只給一個最自然的後續動作建議

輸入 payload：
{{organization_payload}}
```

## Output Contract

Minimum contract:

- must contain `結論：`
- must contain `重點：`
- must contain `下一步：`
- must contain at least one group heading with count
- must not contain `{` `}` style raw object dumps unless the document title itself contains them

## Example Output

```text
結論：
我先把這批文件整理成 3 個主題，共 26 份可移動文件。這版是整理建議，還沒真的移動。

重點：
Scanoo/掃掃（13份）
- 掃掃 Scanoo｜工程知識庫 1.0
- Scanoo 工程技術基準 v1.0
- 掃掃產品需求 飛書
- 1.2 產品功能架構

台灣相關（3份）
- 「2026」Scanoo 台灣市場進入戰略說明
- 台灣主播招募方案

娛樂/MCN（10份）
- 娛樂號剪輯流程
- 熱點短視頻製作流程 SOP
- 娛樂矩陣帳號數據分析報告

下一步：
如果你要，我可以接著把這批裡「還沒分配到穩定分類」的文件單獨列出來。
```

## Integration Points

This spec should be used by any future conversational layer that turns:

- organizer preview results
- organizer apply results
- plugin tool results

into final chat replies.

Current code note:

- the repo already returns compact machine payloads
- this spec defines the missing human-facing synthesis layer
