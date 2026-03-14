# Learnings

## [LRN-20260311-001] correction

**Logged**: 2026-03-11T14:11:00+08:00
**Priority**: high
**Status**: pending
**Area**: config

### Summary
Lark document discovery must branch between Drive and Wiki instead of assuming Drive covers all content.

### Details
For Lark (`larksuite.com`), many documents live under Wiki knowledge spaces and will not appear from Drive root listing alone. The correct user-token discovery path is `drive/v1/files` for cloud drive folders and `wiki/v2/spaces` plus `wiki/v2/spaces/:space_id/nodes` for Wiki content.

### Suggested Action
When implementing Lark document browsing, expose both Drive root listing and Wiki space/node listing behind the same user OAuth flow, and do not treat empty Drive results as proof that the tenant has no documents.

### Metadata
- Source: user_feedback
- Related Files: src/index.mjs, src/lark-content.mjs
- Tags: lark, wiki, drive, oauth

---
