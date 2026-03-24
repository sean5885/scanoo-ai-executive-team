# Lark Quota Reduction Plan

## Goal

Reduce the repo's dependence on Lark server-side OpenAPI writes, lower avoidable API consumption, and standardize a `preview -> confirm -> write` architecture guarded by write budget and dedupe.

## Target Architecture

- Default all document mutations to preview-only.
- Require explicit confirm before any Lark writeback.
- Enforce a write budget guard with soft-limit preview fallback and hard-limit non-whitelist blocking.
- Add request fingerprint, idempotency, same-session duplicate suppression, and same-doc duplicate-content suppression to high-risk writes.
- Prefer MCP or Docs Add-on for read-side and in-doc interaction patterns where server-side OpenAPI is not strictly required.

## Inventory

| module/file | function name | api category | exact endpoint or sdk call | trigger source | estimated frequency | write/read/list/create/patch/delete | can_cache | can_dedupe | can_preview_first | can_require_confirmation | can_migrate_to_mcp | can_migrate_to_docs_addon | must_keep_server_api | risk | priority | proposed action |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `src/lark-user-auth.mjs` | `exchangeCodeForUserToken` | OAuth | `POST /open-apis/authen/v1/access_token` | `/oauth/lark/callback` | low per login | create | no | limited | no | no | no | no | yes | auth break blocks all downstream calls | P0 | keep on server; no migration |
| `src/lark-user-auth.mjs` | `refreshUserToken` | OAuth | `POST /open-apis/authen/v1/refresh_access_token` | request-time token refresh | medium bursty | patch | short TTL only | yes by token freshness | no | no | no | no | yes | refresh storms amplify quota during degraded auth | P0 | keep on server; add stronger refresh caching and backoff |
| `src/lark-user-auth.mjs` | `getTenantAccessToken` | OAuth | `POST /open-apis/auth/v3/tenant_access_token/internal` | tenant-token fallback flows | low-medium | create | short TTL only | yes | no | no | no | no | yes | fallback path is safety-critical for meeting/doc flows | P1 | keep on server; memoize by expiry |
| `src/lark-user-auth.mjs` | `getUserProfileFromLark` | Auth profile | `userClient.authen.v1.userInfo.get` | token persist / profile refresh | low | read | yes | yes | no | no | no | no | yes | wrong identity affects permission grant and session binding | P2 | cache by token/account until refresh |
| `src/lark-content.mjs` | `getDriveRootFolderMeta` / `resolveDriveRootFolderToken` | Drive | `GET /open-apis/drive/explorer/v2/root_folder/meta` | drive root browse / organize | medium | read | yes | yes | no | no | partial | no | mixed | repeated root lookup is avoidable | P2 | cache root token per account |
| `src/lark-content.mjs` | `listDriveFolder` / `listDriveRoot` | Drive | `userClient.drive.v1.file.list` | drive browse, sync, organizer preview | high | list | yes | yes | no | no | yes | no | no | recursive browse dominates quota during sync/preview | P0 | cache pages, narrow scope, avoid repeated root scans |
| `src/lark-content.mjs` | `createDriveFolder` | Drive | `userClient.drive.v1.file.createFolder` | drive organize apply | medium | create | no | yes | yes | yes | no | no | mixed | repeated folder creation can duplicate structure | P0 | keep server API; gate with preview + budget + fingerprint |
| `src/lark-content.mjs` | `moveDriveItem` | Drive | `userClient.drive.v1.file.move` | drive organize apply | medium-high batch | patch | no | yes | yes | yes | no | no | yes | duplicate move submissions waste async tasks | P0 | keep server API; require preview plan + idempotent apply |
| `src/lark-content.mjs` | `checkDriveTask` | Drive polling | `userClient.drive.v1.file.taskCheck` | `/api/drive/task-status` | unknown user-driven | read | yes | yes | no | no | partial | no | mixed | polling can become hot-loop if clients poll aggressively | P1 | add cache/backoff and prefer event/state reuse |
| `src/lark-content.mjs` | `listWikiSpaces` / `listWikiSpaceNodes` | Wiki | `userClient.wiki.v2.space.list`, `userClient.wiki.v2.spaceNode.list` | wiki browse, sync, organizer preview | high for sync/preview | list | yes | yes | no | no | yes | no | no | recursive scans are expensive on large spaces | P0 | cache tree pages and avoid full re-list on follow-ups |
| `src/lark-content.mjs` | `createWikiNode` | Wiki | `userClient.wiki.v2.spaceNode.create` | wiki organize apply | medium | create | no | yes | yes | yes | no | no | mixed | duplicate category-node creation causes clutter | P0 | keep server API; apply only from confirmed preview |
| `src/lark-content.mjs` | `moveWikiNode` | Wiki | `userClient.wiki.v2.spaceNode.move` | wiki organize apply | medium-high batch | patch | no | yes | yes | yes | no | no | yes | repeated move apply can churn tree state | P0 | keep server API; enforce preview-plan fingerprint |
| `src/lark-content.mjs` | `createDocument` | Docs | `userClient.docx.document.create` / `POST /open-apis/docx/v1/documents` | `/api/doc/create`, meeting doc auto-create | medium | create | no | yes | yes | yes | partial | partial | yes | direct create is expensive and irreversible without cleanup | P0 | preview-first create confirmation; budget-guard before create |
| `src/lark-content.mjs` | `ensureDocumentManagerPermission` | Drive permission | `userClient.drive.permissionMember.create`, `userClient.drive.permissionMember.update` | post-create doc permission repair | medium | create/patch | yes short-term | yes | no | no | no | no | yes | permission repair duplicates are common on retries | P1 | dedupe by `document_id + open_id + perm` and cache recent grants |
| `src/lark-content.mjs` | `getDocument` | Docs | `userClient.docx.document.get`, `userClient.docx.document.rawContent` | read, preview, rewrite, update, meeting prepend | high | read | yes | yes | no | no | yes | partial | no | repeated reads before write are necessary but cacheable in-session | P0 | cache doc snapshot by revision/session |
| `src/lark-content.mjs` | `listDocumentComments` | Docs comments | `userClient.drive.v1.fileComment.list` | comment review, rewrite preview, poller | high on watched docs | list | yes short-term | yes | yes | partial | partial | yes | no | poller + preview repeatedly list unresolved comments | P0 | cache unresolved comment pages and move poller toward event-driven |
| `src/lark-content.mjs` | `resolveDocumentComment` | Docs comments | `userClient.drive.v1.fileComment.patch` | rewrite apply | medium | patch | no | yes | yes | yes | no | partial | yes | accidental double-resolve is common on retries | P1 | resolve only after confirmed successful doc write and suppress duplicates |
| `src/lark-content.mjs` | `listAllDocumentBlocks` / `convertMarkdownToBlocks` / `updateDocument` | Docs write | `userClient.docx.v1.documentBlock.list`, `userClient.docx.document.convert`, `userClient.docx.v1.documentBlockChildren.batchDelete`, `userClient.docx.v1.documentBlockDescendant.create` | doc update, rewrite apply, meeting writeback | very high for large docs | read/create/delete | partial | yes | yes | yes | no | partial | yes | replace-based materialization multiplies API calls per write | P0 | keep server API; preview first; prefer append where possible; cache root block |
| `src/lark-content.mjs` | `replyMessage` / `sendMessage` | IM | `userClient.im.v1.message.reply`, `userClient.im.v1.message.create` | meeting preview cards, suggestion cards, chat replies | medium | create | no | yes | yes for cards | partial | partial | no | mixed | confirmation card replay can spam chats | P2 | dedupe by `message_id + card hash`; move in-doc suggestions to Docs Add-on when possible |
| `src/lark-content.mjs` | `listMessages` / `getMessage` / `searchMessages` | IM | `userClient.im.v1.message.list`, `get`, search paging path | chat history lookups | medium | read/list | yes | yes | no | no | partial | no | no | repeated history scans can be cached within session | P3 | cache recent history windows |
| `src/lark-content.mjs` | `createCalendarEvent` / `listCalendarEvents` / `searchCalendarEvents` / `listFreebusy` | Calendar | `userClient.calendar.v4.*` | meeting helpers, calendar routes | low-medium | create/read/list | yes for reads | yes | preview possible for create | yes | partial | no | mixed | event create should also move toward preview/confirm | P2 | keep server API for create/freebusy; cache reads |
| `src/lark-content.mjs` | `createTask` / task comment CRUD | Tasks | `userClient.task.v1.task.*`, `taskComment.*` | task routes, possible meeting follow-up | low-medium | create/read/patch/delete | partial | yes | preview possible for writes | yes | partial | no | mixed | write surfaces still bypass preview-first today | P2 | apply same budget/dedupe policy family later |
| `src/lark-content.mjs` | Bitable app/table/record CRUD | Bitable | `userClient.bitable.v1.app.*`, `appTable.*`, `appTableRecord.*` | bitable routes / pasted Bitable links | medium-high if data-heavy | create/read/list/search/patch/delete | yes for reads | yes | preview possible for create/update/delete | yes | partial | no | mixed | bulk upsert and record writes can burst quota fast | P1 | keep server API for writes; add preview/budget in next phase |
| `src/lark-content.mjs` | Spreadsheet CRUD / replace | Sheets | `userClient.sheets.v3.spreadsheet.*`, `spreadsheetSheet.*` | sheet routes | medium | create/read/patch | yes for reads | yes | preview possible for replace | yes | partial | no | mixed | replace-batch can be high-volume and should be budgeted | P2 | keep server API for now; add preview + dedupe later |
| `src/lark-connectors.mjs` | `fetchDocxPlainText` | Docs read for sync | `larkClient.docx.v1.document.rawContent`, fallback `larkClient.docs.v1.content.get` | sync indexing | very high in full sync | read | yes by revision | yes | no | no | yes | no | no | fallback doubles read cost when rawContent misses | P0 | cache by revision/content hash; avoid fallback unless needed |
| `src/lark-connectors.mjs` | `scanDriveTree` | Drive sync | recursive `drive.v1.file.list` | `/sync/full`, `/sync/incremental` | very high | list | yes | yes | no | no | partial | no | no | full-tree scans are the biggest read consumer | P0 | incremental cursoring, page cache, subtree targeting |
| `src/lark-connectors.mjs` | `scanWikiSpaceTree` / `listAllWikiSpaces` | Wiki sync | recursive `wiki.v2.space.list`, `wiki.v2.spaceNode.list` | `/sync/full`, `/sync/incremental` | very high | list | yes | yes | no | no | partial | no | no | full wiki scans are another top quota driver | P0 | cache space snapshots and move toward changed-only sync |
| `src/doc-comment-rewrite.mjs` | `rewriteDocumentFromComments` / `applyRewrittenDocument` | Rewrite workflow | `getDocument` + `listDocumentComments` + `updateDocument` + optional `resolveDocumentComment` | `/api/doc/rewrite-from-comments`, suggestion card flow | medium-high on active docs | read/patch | partial | yes | yes | yes | partial | yes | yes | preview/apply loop is valuable but expensive if polled blindly | P0 | keep apply on server; move preview UI toward Docs Add-on |
| `src/meeting-agent.mjs` | `processMeetingPreview` | Meeting preview | `sendMessage` card + preview document target lookup | `/api/meeting/process`, `/meeting` | medium | create/read | partial | yes | already preview-first | yes | partial | partial | yes | repeated preview cards can duplicate notifications | P1 | dedupe by summary hash and chat/session |
| `src/meeting-agent.mjs` | `confirmMeetingWrite` | Meeting writeback | `createManagedDocument` + `ensureDocumentManagerPermission` + `getDocument` + `updateDocument` | `/api/meeting/confirm`, `/meeting/confirm` | medium | create/read/replace | partial | yes | yes | yes | no | partial | yes | writeback may create docs and prepend large entries | P0 | keep on server; enforce budget guard and duplicate suppression |
| `src/lark-drive-organizer.mjs` | `previewDriveOrganization` / `applyDriveOrganization` | Drive organization | `listDriveFolder`, `createDriveFolder`, `moveDriveItem` | `/api/drive/organize/*` | high in organization sessions | list/create/patch | partial | yes | yes | yes | no | no | yes | preview recomputation and batch apply can be expensive | P0 | cache preview plan, confirm-before-apply, no auto-repeat |
| `src/lark-wiki-organizer.mjs` | `previewWikiOrganization` / `applyWikiOrganization` | Wiki organization | `listWikiSpaceNodes`, `createWikiNode`, `moveWikiNode` | `/api/wiki/organize/*` | high in organization sessions | list/create/patch | partial | yes | yes | yes | no | no | yes | large wiki trees amplify preview costs | P0 | cache preview plan and confirm-before-apply |
| `src/comment-suggestion-poller.mjs` + `src/comment-suggestion-workflow.mjs` | `runCommentSuggestionPollOnce` / `generateDocumentCommentSuggestionCard` | Polling + rewrite preview | `listDocumentComments` + `getDocument` + rewrite preview + optional `replyMessage` | interval poller every `LARK_COMMENT_SUGGESTION_POLL_INTERVAL_SECONDS` | high if many watched docs | list/read/create | partial | yes | yes | yes for reply/send | partial | yes | mixed | timer polling is the clearest avoidable quota burner | P0 | reduce frequency, cache seen state harder, prefer event-driven / Docs Add-on |

## Top 10 API Consumers

1. `src/lark-sync-service.mjs` -> `scanDriveTree` + `scanWikiSpaceTree` + `fetchDocxPlainText`
   Reason: full-tree traversal plus per-doc content extraction scales with corpus size.
2. `src/lark-drive-organizer.mjs` -> `previewDriveOrganization`
   Reason: recursive folder scans rerun on every re-preview.
3. `src/lark-wiki-organizer.mjs` -> `previewWikiOrganization`
   Reason: recursive wiki node listing is expensive on large spaces.
4. `src/lark-content.mjs` -> `updateDocument`
   Reason: replace path fans out to block list, convert, delete, and descendant create.
5. `src/doc-comment-rewrite.mjs` -> rewrite preview/apply
   Reason: reads doc, lists comments, then may replace doc and patch comments.
6. `src/comment-suggestion-poller.mjs`
   Reason: interval polling repeatedly lists unresolved comments and may send cards.
7. `src/meeting-agent.mjs` -> `confirmMeetingWrite`
   Reason: may create a doc, grant permission, read existing content, and rewrite doc.
8. `src/lark-content.mjs` -> `getDocument`
   Reason: reused by update, rewrite, meeting, and detail reads.
9. `src/lark-content.mjs` -> Drive/Wiki browse list functions
   Reason: browse, sync, and organize all rely on the same list endpoints.
10. `src/lark-content.mjs` -> Bitable record write family
   Reason: potentially bursty bulk data workloads; not yet gated by preview/budget.

## Migration Recommendation

### Migrate To MCP

- Read-only document lookup, drive/wiki browse, search, and list flows.
- Company-brain style retrieval or planner-side knowledge browsing that does not need direct mutation.
- Session-scoped preview retrieval where the server currently acts mostly as a thin proxy.

### Migrate To Docs Add-on

- Comment rewrite preview, in-doc suggestion rendering, and explicit confirm UI.
- Document update preview/confirm flows, especially heading-targeted insert preview.
- Human-in-the-loop document drafting where an in-doc confirmation affordance is better than chat cards.

### Keep As Server API

- OAuth exchange, refresh, tenant-token fallback, and permission repair.
- Sync/indexing, lifecycle persistence, and company-brain mirror ingest.
- Meeting writeback, drive/wiki batch organization apply, and any flow that coordinates multiple Lark surfaces plus local state.
- Budget guard, dedupe memory, and approval/verification boundaries.

## Polling Review

| flow | current behavior | really necessary | reduce frequency | event-driven alternative | cache opportunity | proposed action |
| --- | --- | --- | --- | --- | --- | --- |
| comment suggestion poller | fixed interval scan of watched docs | only partially | yes | document comment events / Docs Add-on open state | yes | default to disabled or slower interval unless watch count is tiny |
| drive task status | user/client-triggered polling | sometimes | yes | task completion webhook if available; otherwise backoff polling | yes | add result cache and exponential backoff |
| sync drive/wiki full tree paging | full scan loops until `has_more=false` | only for full sync | yes by incremental mode | changed-only incremental sync | yes | prioritize cursor/incremental sync and subtree sync |
| document block paging for replace writes | loops over all blocks before replace | currently yes for replace | not much | append-only or patch-like write path when safe | yes by root-block cache | avoid replace when append or targeted update is enough |

## Risk Note

- `POST /api/doc/create` and `POST /api/doc/update` now becoming preview-first can break callers that assumed immediate mutation.
- Soft-limit budget fallback will keep some writes in preview even when confirm is present; operators must understand this is intentional fail-soft behavior.
- Hard-limit blocking can delay meeting/doc writeback until a whitelist or budget reset path is available.
- Duplicate suppression may reject legitimate repeated writes if callers do not vary content or session scope intentionally.
- Append-preview currently materializes a full-document preview snapshot, which is safer for confirmation but can slightly differ from pure append semantics in edge formatting cases.
- Organizer apply flows now depend more heavily on preview-plan continuity; clients that skip preview or re-POST apply blindly will be blocked.
