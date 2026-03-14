# Lark Lobster vs Feishu Official Plugin

這份文件只根據目前程式碼與這次讀到的飛書官方插件文檔整理。

來源：

- 飛書官方插件文檔：`MFK7dDFLFoVlOGxWCv5cTXKmnMh`
- 目前本 repo：
  - `/Users/seanhan/Documents/Playground/src`
  - `/Users/seanhan/Documents/Playground/openclaw-plugin/lark-kb`
  - `/Users/seanhan/Documents/Playground/README.md`

## 目前已具備

- 使用者 OAuth 授權
- Drive 瀏覽
- Drive 建資料夾 / 移動 / 刪除 / 任務狀態查詢
- Wiki space / node 瀏覽
- Wiki 建節點 / 移動
- Drive / Wiki 文件整理
- 知識同步、搜尋、問答
- 本機安全工作流包裝

## 這一輪已補上

- `docx` 直接讀取
- `docx` 直接建立
- `docx` 直接更新
  - append
  - replace
- `doc` 評論改稿建議卡
  - 只抓新的未解評論
  - 先出卡片與 confirmation
  - 不直接覆寫正文
  - 已可接成定時輪詢或手動 poll workflow

對應新增 API：

- `GET /api/doc/read`
- `POST /api/doc/create`
- `POST /api/doc/update`
  - `replace` 現在是 preview-first，不再直接覆寫
- `POST /api/doc/comments/suggestion-card`
- `POST /api/doc/comments/poll-suggestion-cards`

對應新增 plugin tools：

- `lark_doc_read`
- `lark_doc_create`
- `lark_doc_update`
  - `replace` 需要先拿 `confirmation_id` 再確認套用
- `lark_doc_comment_suggestion_card`

## 官方能力對照後，這一輪已再補上

### 訊息工作台

- 群聊 / 會話歷史讀取
- 關鍵字訊息搜尋
- 讀單條訊息
- 文字回覆
- 簡單卡片回覆

### 日程與任務

- 取得主日曆
- 列日程
- 搜尋日程
- 建立日程
- 列任務
- 查任務
- 建立任務

對應新增 API：

- `GET /api/messages`
- `GET /api/messages/search`
- `GET /api/messages/:message_id`
- `POST /api/messages/reply`
- `POST /api/messages/reply-card`
- `GET /api/calendar/primary`
- `GET /api/calendar/events`
- `POST /api/calendar/events/search`
- `POST /api/calendar/events/create`
- `GET /api/tasks`
- `GET /api/tasks/:task_id`
- `POST /api/tasks/create`

對應新增 plugin tools：

- `lark_messages_list`
- `lark_messages_search`
- `lark_message_get`
- `lark_message_reply`
- `lark_message_reply_card`
- `lark_calendar_primary`
- `lark_calendar_events`
- `lark_calendar_search`
- `lark_calendar_create_event`
- `lark_tasks_list`
- `lark_task_get`
- `lark_task_create`

## 目前仍缺

### 官方示例裡我們還沒有完整補齊的

- 根據「未讀」消息做真正未讀語義摘要
- 把群消息自動整理進多維表格並分類
- 會議待辦 -> 自動完成文檔初稿的專用工作流
- 根據歷史消息做個人顧問 / 長期建議
- 語音輸入潤色後直接代發
- 會議紀要自動抽取
- 日報 / 周報 / 未讀總結工作流

### 協作資料能力

- 多維表格建立 / 表列出 / 記錄 CRUD / 篩選搜尋
- 電子表格建立 / 讀取 / 工作表查看 / 單元格替換

### 互動層能力

- 更完整的卡片模板與流式更新
- thread-level 獨立上下文策略
- 表情 reaction 已補基礎 CRUD
- 合併轉發工作流仍未補
- 以使用者身份代發
- 多機器人對應多 agent

### lane 對應執行策略

- `group-shared-assistant`
  - 群聊摘要
  - 群內回覆草稿
- `personal-assistant`
  - 個人日程 / 任務 / 私聊工作流
- `doc-editor`
  - 文檔閱讀
  - 評論改稿建議卡
- `knowledge-assistant`
  - 知識問答
  - 基於文件做整理

## 最值得繼續補的順序

1. 未讀消息工作台
2. richer card / thread reply strategy
3. task subtasks / 專用 task workflow
4. 合併轉發 / 以使用者身份代發
5. 會議待辦 -> 文檔初稿專用工作流

## 為什麼先補文檔能力

因為你目前最常用的工作場景仍然是：

- 看文件
- 整理文件
- 生成文件
- 更新文件

這一層補完後，Lobster 才比較接近「直接在 Lark 幹活」，而不是只會查知識與整理目錄。

## 注意

這次除了文檔寫入外，訊息能力也補了建議 scope：

- `docx:document:create`
- `docx:document:readonly`
- `docx:document:write_only`
- `im:message:send_as_bot`
- `im:message:readonly`
- `im:chat`
- `im:message.group_msg`
- `im:message.p2p_msg:readonly`

如果你之前已完成 OAuth，需要重新授權，新的訊息能力才會生效。

## 這一輪再補上的能力

- `bitable` 基礎 CRUD
  - 建立 app
  - 列 table
  - 建 table
  - 列 record
  - 搜 record
  - 建 / 改 / 刪 record
- `sheet` 基礎操作
  - 建 spreadsheet
  - 讀 spreadsheet
  - 列 sheet
  - 單元格替換
- `calendar`
  - busy-free 查詢
- `task`
  - comment CRUD
- `message`
  - reaction CRUD

對應新增 API：

- `POST /api/bitable/apps/create`
- `GET /api/bitable/apps/:app_token`
- `POST /api/bitable/apps/:app_token`
- `GET /api/bitable/apps/:app_token/tables`
- `POST /api/bitable/apps/:app_token/tables/create`
- `GET /api/bitable/apps/:app_token/tables/:table_id/records`
- `POST /api/bitable/apps/:app_token/tables/:table_id/records/search`
- `POST /api/bitable/apps/:app_token/tables/:table_id/records/create`
- `GET /api/bitable/apps/:app_token/tables/:table_id/records/:record_id`
- `POST /api/bitable/apps/:app_token/tables/:table_id/records/:record_id`
- `DELETE /api/bitable/apps/:app_token/tables/:table_id/records/:record_id`
- `POST /api/sheets/spreadsheets/create`
- `GET /api/sheets/spreadsheets/:spreadsheet_token`
- `POST /api/sheets/spreadsheets/:spreadsheet_token`
- `GET /api/sheets/spreadsheets/:spreadsheet_token/sheets`
- `GET /api/sheets/spreadsheets/:spreadsheet_token/sheets/:sheet_id`
- `POST /api/sheets/spreadsheets/:spreadsheet_token/sheets/:sheet_id/replace`
- `POST /api/calendar/freebusy`
- `GET /api/tasks/:task_id/comments`
- `POST /api/tasks/:task_id/comments`
- `GET /api/tasks/:task_id/comments/:comment_id`
- `POST /api/tasks/:task_id/comments/:comment_id`
- `DELETE /api/tasks/:task_id/comments/:comment_id`
- `GET /api/messages/:message_id/reactions`
- `POST /api/messages/:message_id/reactions`
- `DELETE /api/messages/:message_id/reactions/:reaction_id`

對應新增 plugin tools：

- `lark_bitable_app_create`
- `lark_bitable_tables_list`
- `lark_bitable_table_create`
- `lark_bitable_records_list`
- `lark_bitable_records_search`
- `lark_bitable_record_create`
- `lark_bitable_record_update`
- `lark_bitable_record_delete`
- `lark_spreadsheet_create`
- `lark_spreadsheet_sheets`
- `lark_spreadsheet_replace`
- `lark_calendar_freebusy`
- `lark_task_comments`
- `lark_task_comment_create`
- `lark_task_comment_update`
- `lark_task_comment_delete`
- `lark_message_reactions`
- `lark_message_reaction_create`
- `lark_message_reaction_delete`

## 這一輪再補上的能力

- 文檔評論列表
- 根據評論生成改稿預覽
- 經確認後直接把評論改稿套回 docx
- 可選擇在套用後同步把評論標成 solved

對應新增 API：

- `GET /api/doc/comments`
- `POST /api/doc/rewrite-from-comments`

對應新增 plugin tools：

- `lark_doc_comments`
- `lark_doc_rewrite_from_comments`
  - 已改成 preview / confirm，不再允許一次預覽後直接盲覆寫
