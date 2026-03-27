# Mutation Governance Phase1 - Admission Contract Baseline

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Status

This document is the unified admission contract baseline for Phase 1 Mutation Governance.

- all later mutation-route convergence work must follow this schema and logic
- no route may drift from this baseline unless a versioned successor is introduced
- before `v2`, this document must remain frozen
- this document is the Step 2 frozen baseline (`Baseline v1`)
- all later execution work must align to it exactly

## Step 2 Revised

Phase 1 的 unified admission adapter 仍維持一個非常窄的 contract，核心原則是：

- 所有 route 在進 execute 前，先被轉成同一個 request shape
- adapter 不判斷業務，只做 orchestration
- route/workflow-specific prereq 若還存在，必須在 canonical request 建立前完成，adapter 不直接讀 route-local payload 判斷
- `company-brain` 的 lifecycle gate 不進 adapter

## Fixed Input Schema

所有 route 進 adapter 前，都必須先產生這個 shape：

```json
{
  "action_type": "create_doc | update_doc | meeting_confirm_write | rewrite_apply | organize_apply | company_brain_apply",
  "resource_type": "doc | doc_container | drive_folder | wiki_space | company_brain_doc",
  "resource_id": "string | null",
  "actor": {
    "source": "string",
    "owner": "string",
    "account_id": "string | null"
  },
  "context": {
    "pathname": "string | null",
    "method": "string | null",
    "scope_key": "string | null",
    "idempotency_key": "string | null",
    "external_write": "boolean",
    "confirmed": "boolean",
    "verifier_completed": "boolean",
    "review_required_active": "boolean"
  },
  "original_request": "opaque object"
}
```

約束：

- `original_request` 可以保留原始 route payload，但 adapter 不得依賴其中任何 route-specific 欄位做分支。
- adapter 只能讀固定欄位：`action_type/resource_type/resource_id/actor/context`。
- `context` 只能放 shared control signals，不能放 meeting/rewrite/company-brain 專屬業務欄位。

## Fixed Output Schema

adapter 固定只回這個 shape：

```json
{
  "allowed": true,
  "reason": "string | null",
  "policy_snapshot": {
    "policy_version": "write_policy_v1",
    "source": "string | null",
    "owner": "string | null",
    "intent": "string | null",
    "action_type": "string | null",
    "external_write": "boolean",
    "confirm_required": "boolean",
    "review_required": "never | conditional | always | null",
    "scope_key": "string | null",
    "idempotency_key": "string | null"
  },
  "guard_result": {
    "decision": "allow | deny",
    "reason": "string | null",
    "error_code": "string | null",
    "policy_enforcement": "object | null"
  },
  "evidence_id": "string | null",
  "trace_id": "string | null"
}
```

約束：

- `allowed/reason` 是 adapter 的唯一 admission 結論。
- `policy_snapshot` 是 normalize 後的 shared write policy。
- `guard_result` 只放 shared write guard 結果，不帶 route 專屬資料。
- `evidence_id/trace_id` 是 observability 證據，不承載業務判斷。

## Adapter Allowed Responsibilities

adapter 只能做四件事：

1. normalize  
把 route input 轉成固定 schema，再產生 `policy_snapshot`

2. call `write_guard`  
只呼叫既有 shared `write_guard`

3. emit evidence  
產生統一 `evidence_id/trace_id` 與 admission trace

4. return decision  
把 `write_guard` 結果包成固定 output schema

adapter 不可做：

- meeting completeness 判斷
- rewrite patch readiness 判斷
- cloud-doc preview/scope matching 判斷
- company-brain approval/lifecycle 判斷

## Route-to-Canonical Mapping

目前 checked-in canonical mapping 已不只六條 route，而是分成兩層：

1. explicit builders for high-risk doc / meeting / company-brain paths
2. registry-backed external write mapping from `/Users/seanhan/Documents/Playground/src/external-mutation-registry.mjs`

高風險路徑仍維持 explicit builder：

- `create_doc`
  - `action_type = create_doc`
  - `resource_type = doc_container`
  - `resource_id = folder_token || null`

- `update_doc`
  - `action_type = update_doc`
  - `resource_type = doc`
  - `resource_id = document_id`

- `meeting_confirm_write`
  - `action_type = meeting_confirm_write`
  - `resource_type = doc`
  - `resource_id = target_document_id || null`

- `document_comment_rewrite_apply`
  - `action_type = rewrite_apply`
  - `resource_type = doc`
  - `resource_id = document_id`

- `drive_organize_apply`
  - `action_type = organize_apply`
  - `resource_type = drive_folder`
  - `resource_id = folder_token`

- `wiki_organize_apply`
  - `action_type = organize_apply`
  - `resource_type = wiki_space`
  - `resource_id = space_id || parent_node_token || space_name`

- `company-brain apply`
  - `action_type = company_brain_apply`
  - `resource_type = company_brain_doc`
  - `resource_id = doc_id`

registry-backed external write families 目前已納入 canonical admission surface：

- Drive
  - `create_drive_folder`
  - `move_drive_item`
  - `delete_drive_item`
- Wiki
  - `create_wiki_node`
  - `move_wiki_node`
- Message
  - `message_reply`
  - `message_reaction_create`
  - `message_reaction_delete`
- Calendar
  - `calendar_create_event`
- Task
  - `task_create`
  - `task_comment_create`
  - `task_comment_update`
  - `task_comment_delete`
- Bitable
  - `bitable_app_create`
  - `bitable_app_update`
  - `bitable_table_create`
  - `bitable_record_create`
  - `bitable_record_update`
  - `bitable_record_delete`
  - `bitable_records_bulk_upsert`
- Sheet
  - `spreadsheet_create`
  - `spreadsheet_update`
  - `spreadsheet_replace`
  - `spreadsheet_replace_batch`
- lane-executor meeting capture writes
  - `meeting_capture_create_document`
  - `meeting_capture_document_update`
  - `meeting_capture_document_delete`

這些 action 的 `action_type / resource_type / write-policy snapshot fallback` 目前都由 admission layer 透過 registry 解析，不再依賴每條 route 各自維護一份 partial allowlist。

## Adapter vs Lifecycle Gate

`company-brain apply` 的既有 lifecycle gate 必須留在 adapter 外面，而且先於 adapter。

順序應該是：

1. route-local prerequisite / lifecycle gate
2. gate pass 後，route 建 canonical request
3. call unified admission adapter
4. adapter 回 `allowed=true`
5. execute

原因很直接：

- lifecycle gate 是業務邏輯
- adapter 被限制不能寫業務邏輯
- 所以 lifecycle gate 不能搬進 adapter

這也表示：

- `company-brain apply` 的 authoritatve business decision 仍是既有 lifecycle/apply gate
- unified adapter 是 execute 前最後一層 shared admission orchestration
- 兩者不是互相取代，而是上下游關係

## Step 2 Definition of Done

Step 2 完成時，應該滿足：

- 六條 mutation route 都有明確 canonical request builder
- adapter input/output schema 固定且文件化
- adapter 不含 route-specific branching
- adapter 不含 company-brain lifecycle / meeting / rewrite / organize 業務邏輯
- `company-brain apply` 的 gate ordering 已明確寫成「lifecycle first, adapter second」

## Step 2 Risk Points

- 把 `original_request` 當成 adapter 決策依據，等於偷渡 route-specific 邏輯
- 把 `context` 做成萬用垃圾桶，最後又變成隱性分裂
- 把 company-brain lifecycle gate 塞進 adapter，違反 Phase 1 邊界
- 讓 `guard_result` 直接暴露 route-specific payload，破壞固定 schema

如果照這個定義走，Phase 1 的收斂點就很清楚了：先統一 request shape，再統一 admission envelope，不碰 execute 本身。
