# Scanoo 後台迭代規劃拆解

來源基礎：

- [/Users/seanhan/Documents/Playground/scanoo_web_backend_function_map.md](/Users/seanhan/Documents/Playground/scanoo_web_backend_function_map.md)

這份文件的目的是把既有功能盤點，轉成可直接用於產品迭代討論的三種輸出：

1. 功能樹
2. 角色旅程
3. 下一版產品優先級建議

不假設未看見的能力，只基於已盤點的真實結構做拆解。

## 1. 功能樹

### 1.1 認證與帳號

- 登入
- 註冊
- 註冊成功
- 忘記密碼
- 更新密碼
- auth callback / confirm / error
- 個人帳號設定
- profile 編輯
- password 更新

### 1.2 平台管理

- admin dashboard
- users 管理
- merchants 管理
- BD 指派
- owner 邀請
- 平台 QR fleet 監控
- governance 面板
- logs 面板

### 1.3 商家管理

- merchant 列表
- merchant 搜尋 / 分頁
- merchant 建立
- merchant 編輯
- merchant 詳情
- merchant 軟刪除 / 還原 / 永久刪除
- 條款接受狀態
- company / tax / industry / contact 資訊管理

### 1.4 分店管理

- store 列表
- 依 merchant 建立 store
- 編輯 store
- store 詳情
- deleted stores 管理
- store detail 聚合
- store staff 入口
- store QR 入口

### 1.5 公開店頁與頁面配置

- public store page
- page builder
- page components
- store components 儲存
- unit layer 覆蓋
- payment channels
- menus
- WiFi QR 進階選項

### 1.6 QR 與入口管理

- 平台 QR 列表
- store QR 列表
- 最新 QR
- 指定 QR 查詢
- QR 刪除
- 一般 QR / WiFi QR
- QR print
- print sheet
- fleet health / scan metrics

### 1.7 Unit / 點位管理

- 建立 unit
- 批量建立 unit
- 更新 unit
- 更新 unit config
- 刪除 unit
- 批量刪除 unit
- 啟用 / 停用 unit
- 依 store 查 units
- unit 級配置覆蓋

### 1.8 菜單與素材

- merchant menus
- menu uploader
- 公開頁菜單呈現
- 菜單排序
- PDF / 圖片資產管理

### 1.9 成員與角色權限

- owner 邀請
- staff / store_manager 邀請
- pending invitations
- resend password reset
- update member email
- remove staff
- membership manager
- member actions

### 1.10 Dashboard / 分析

- owner dashboard
- admin dashboard
- BD dashboard
- merchant track stats
- QR 數量統計
- 趨勢圖
- 點擊圖
- demo mode

### 1.11 Staff Mode

- store online / offline
- 今日 scans
- digital QR support
- feature grid
- node status
- 現場支援區塊
- 問題回報區塊

### 1.12 治理與審計

目前已存在 UI 或骨架：

- governance issue panel
- logs table
- severity / activity logs
- 搜尋 / 篩選 / 抽屜

目前仍偏半成品：

- 真實治理資料源
- 真實 audit log source
- 異常處理閉環

## 2. 功能樹視角下的產品分層

### 平台層

- users
- merchants
- BD ownership
- fleet monitoring
- governance
- logs

### 商家層

- merchant profile
- stores
- menus
- staff / invitations
- page builder
- payment channels

### 門店層

- store page
- qrcodes
- units
- store staff
- scans / node health

### 現場層

- staff mode
- digital QR
- unit-based operational entry
- node status
- 現場問題支援

## 3. 角色旅程

### 3.1 Super Admin

核心目標：

- 開通商家
- 管理平台健康
- 看全域風險

主要旅程：

1. 登入 admin
2. 建立 merchant 或查看 merchant 狀態
3. 指派 BD
4. 確認 owner 是否完成開通
5. 監看 QR fleet 與平台健康
6. 查看 governance / logs
7. 介入異常 merchant 或 store

目前痛點：

- 治理與 log 偏 mock
- fleet 有監控面板，但異常處置閉環不完整

### 3.2 BD

核心目標：

- 把商家導入成功
- 協助品牌完成 store 開設與 QR 落地

主要旅程：

1. 登入 BD dashboard
2. 查看自己名下 merchants
3. 建立或補齊 merchant 資料
4. 協助建立第一批 stores
5. 檢查店頁 / QR / menu 是否可用
6. 交接給 owner 或 store manager

目前痛點：

- 還沒有很強的 onboarding checklist
- 缺 BD 任務流與異常追蹤流

### 3.3 Owner

核心目標：

- 管理品牌與門店
- 完成公開頁配置
- 管好店內角色與入口內容

主要旅程：

1. 收到邀請並登入
2. 補齊 merchant 基本資料
3. 建立或檢查 store
4. 編輯 store page / menus / payment channels
5. 建立 units
6. 管理 staff / store manager
7. 看店鋪掃碼與營運數據

目前痛點：

- 配置能力很多，但缺「推薦下一步」
- 缺從開店到可營運的標準引導流程

### 3.4 Store Manager

核心目標：

- 把單店營運跑順
- 管 staff 與店內點位

主要旅程：

1. 進入 store detail 或 staff mode
2. 看 today scans / node status
3. 檢查 QR 是否可用
4. 管理 staff
5. 看店鋪公開頁狀態
6. 回報現場問題

目前痛點：

- staff mode 雖有真資料，但支援流程還沒閉環
- 異常不能自然流回平台治理

### 3.5 Staff

核心目標：

- 在現場快速確認入口能不能用
- 處理基本營運問題

主要旅程：

1. 進入 staff mode
2. 查看 online / offline 狀態
3. 查看今日 scans
4. 檢查 digital QR
5. 處理節點異常或尋求支援

目前痛點：

- 目前更像狀態面板，不像完整現場工作台

## 4. 角色旅程中的關鍵斷點

### 斷點 1：開通流程沒有完整產品化

目前有 merchant / store / invitation / page components 的真骨架，  
但缺的是：

- 開通 checklist
- 缺什麼資料的明確提示
- 何時算「可上線」的狀態定義

### 斷點 2：頁面配置已存在，但營運建議不夠

目前 owner 可以配很多內容，  
但系統還沒有明確告訴他：

- 哪些是必填
- 哪些配置最影響轉化
- 哪些門店還沒配置完成

### 斷點 3：治理與 log 還沒變成真閉環

這是目前最明顯的產品成熟度缺口之一。

已有：

- governance UI
- logs UI
- fleet monitor

還沒有：

- 真異常事件來源
- 指派責任人
- 處置流程
- 處置完成回寫

### 斷點 4：staff mode 還沒成為現場任務工具

目前能看狀態，  
但還不能真正完成：

- 問題回報
- 指派處理
- 追蹤修復

## 5. 下一版產品優先級建議

下面不是技術工單，而是產品層優先級。

### P0：商家開通閉環

原因：

- 這是 BD、owner、平台三個角色的共同主流程
- 直接影響商家能否真正上線

建議功能：

- merchant onboarding checklist
- store ready status
- owner onboarding guide
- 缺資料提示
- 可上線條件檢查

成功標準：

- 新 merchant 從建立到第一家店可上線的時間下降
- owner 不需要靠人工問答才能完成配置

### P0：Store / Page / QR 上線狀態可視化

原因：

- 目前功能不少，但缺少「現在是否可營運」的統一狀態

建議功能：

- store readiness score
- page completeness
- menu completeness
- payment completeness
- QR health

成功標準：

- owner / BD 一眼可知哪家店還沒完成
- 降低人工檢查成本

### P1：Staff Mode 升級成現場工作台

原因：

- 現在 staff mode 已有真資料，是最值得擴的現場入口

建議功能：

- 異常回報
- 節點失效回報
- 快速檢查清單
- 問題分類
- 回報後指派與追蹤

成功標準：

- staff mode 不只看數據，也能發起處理

### P1：Governance / Logs 真實化

原因：

- 現在 UI 已經有方向，但資料還偏 mock
- 這塊一旦接真，整個平台成熟度會明顯提升

建議功能：

- 真實 audit event source
- merchant / store / QR / member 事件流
- governance issue source
- issue owner / status / resolution
- severity 與操作記錄

成功標準：

- governance panel 變成真的運營中台，而不是展示面板

### P1：Unit 精細化營運

原因：

- unit 是你們很有價值、但很容易被低估的模型

建議功能：

- unit templates
- 不同 unit 對應不同內容
- unit performance 對比
- unit 層級 QR 與內容策略

成功標準：

- 同一家店內不同場景入口可被精細化管理

### P2：BD 任務化工具

原因：

- BD 現在有 merchant ownership，但缺少任務層工具

建議功能：

- BD onboarding tasks
- merchant activation tasks
- follow-up reminders
- store launch checklist

成功標準：

- BD 不再只靠手動追進度

## 6. 建議的下一版產品主題

如果只選一個主題，我建議不是再做更多 CRUD，  
而是做：

`從開通到可營運的閉環產品化`

可以拆成一句更準的版本：

`Merchant / Store Go-Live Operating System`

因為你們現在最成熟的核心其實是：

- 商家
- 分店
- 公開頁
- QR
- 多角色

真正欠缺的是把這些能力變成「可上線、可追蹤、可治理」的一條主流程。

## 7. 最適合立刻開做的版本

### 版本主題

Scanoo Go-Live Console v1

### 版本範圍

- merchant onboarding checklist
- store readiness
- page / menu / payment / QR completeness
- owner / BD 共用上線視圖
- staff 異常回報最小版

### 不建議這一版先做的事

- 大規模重做 governance UI
- 複雜 AI 功能
- 過度擴張 analytics 指標

原因：

- 現在最大價值不是更炫，而是把主流程做閉環

## 8. 一句話總結

下一版最值得的方向，不是把後台做得更大，而是把 `商家開通 -> 分店配置 -> QR 上線 -> 現場可營運 -> 異常可回報` 這條主流程做完整。
