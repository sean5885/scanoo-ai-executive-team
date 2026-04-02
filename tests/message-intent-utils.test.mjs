import test from "node:test";
import assert from "node:assert/strict";

import { buildLaneFailureReply, resolveCapabilityLane } from "../src/capability-lane.mjs";
import {
  extractBitableReference,
  collectRelatedMessageIds,
  detectDocBoundaryIntent,
  extractDocumentId,
  normalizeMessageText,
} from "../src/message-intent-utils.mjs";

test("extractDocumentId 會從結構化 document_id 讀出非 doccn 型別 token", () => {
  const event = {
    message: {
      content: JSON.stringify({
        document_id: "MFK7dDFLFoVlOGxWCv5cTXKmnMh",
        title: "Shared doc",
      }),
    },
  };

  assert.equal(extractDocumentId(event), "MFK7dDFLFoVlOGxWCv5cTXKmnMh");
});

test("extractDocumentId 會從分享連結中擷取 doc token", () => {
  const event = {
    message: {
      content: JSON.stringify({
        text: "請看這份文件 https://larksuite.com/docx/doccnA1B2C3D4E5",
      }),
    },
  };

  assert.equal(extractDocumentId(event), "doccnA1B2C3D4E5");
});

test("extractBitableReference 會從 base 連結中擷取 app 與 table token", () => {
  const event = {
    message: {
      content: JSON.stringify({
        text: "幫我看這個 bitable https://tenant.larksuite.com/base/bscnA1B2C3D4?table=tblN9X8Y7&view=vewK3L2",
      }),
    },
  };

  assert.deepEqual(extractBitableReference(event), {
    url: "https://tenant.larksuite.com/base/bscnA1B2C3D4?table=tblN9X8Y7&view=vewK3L2",
    app_token: "bscnA1B2C3D4",
    table_id: "tblN9X8Y7",
    view_id: "vewK3L2",
    record_id: null,
  });
});

test("collectRelatedMessageIds 會去重 reply-chain message ids", () => {
  const event = {
    message: {
      parent_id: "om_parent",
      upper_message_id: "om_parent",
      root_id: "om_root",
    },
  };

  assert.deepEqual(collectRelatedMessageIds(event), ["om_parent", "om_root"]);
});

test("reply-chain 跟進訊息會切到 doc-editor lane", () => {
  const lane = resolveCapabilityLane(
    { chat_type: "group" },
    {
      message: {
        parent_id: "om_parent",
        content: JSON.stringify({
          text: "幫我看一下這份",
        }),
      },
    },
  );

  assert.equal(lane.capability_lane, "doc-editor");
});

test("一般群聊整理需求仍維持 group-shared-assistant", () => {
  const lane = resolveCapabilityLane(
    { chat_type: "group" },
    {
      message: {
        content: JSON.stringify({
          text: "幫我總結一下剛剛群裡討論",
        }),
      },
    },
  );

  assert.equal(lane.capability_lane, "group-shared-assistant");
});

test("文件整理需求會進 knowledge-assistant 而不是沿用最近對話 lane", () => {
  const lane = resolveCapabilityLane(
    { chat_type: "p2p" },
    {
      message: {
        content: JSON.stringify({
          text: "幫我整理文件重點",
        }),
      },
    },
  );

  assert.equal(lane.capability_lane, "knowledge-assistant");
});

test("company_brain 語意會直接進 knowledge-assistant", () => {
  const lane = resolveCapabilityLane(
    { chat_type: "p2p" },
    {
      message: {
        content: JSON.stringify({
          text: "請幫我看 company_brain 裡有哪些文件",
        }),
      },
    },
  );

  assert.equal(lane.capability_lane, "knowledge-assistant");
});

test("runtime 健康查詢會直接進 knowledge-assistant", () => {
  const lane = resolveCapabilityLane(
    { chat_type: "p2p" },
    {
      message: {
        content: JSON.stringify({
          text: "現在 runtime 穩不穩？順便告訴我 db path 跟 pid",
        }),
      },
    },
  );

  assert.equal(lane.capability_lane, "knowledge-assistant");
  assert.equal(lane.lane_reason, "message_mentions_runtime_info");
});

test("delivery/onboarding 知識查詢即使沒寫文件也會進 knowledge-assistant", () => {
  const lane = resolveCapabilityLane(
    { chat_type: "p2p" },
    {
      message: {
        content: JSON.stringify({
          text: "請整理交付驗收流程",
        }),
      },
    },
  );

  assert.equal(lane.capability_lane, "knowledge-assistant");
  assert.equal(lane.lane_reason, "message_mentions_delivery_knowledge_lookup");
});

test("PRD 驗收條件問句不會被 delivery knowledge ingress 誤吸進 knowledge-assistant", () => {
  const lane = resolveCapabilityLane(
    { chat_type: "p2p" },
    {
      message: {
        content: JSON.stringify({
          text: "幫我整理 PRD 驗收條件",
        }),
      },
    },
  );

  assert.equal(lane.capability_lane, "personal-assistant");
  assert.equal(lane.lane_reason, "direct_message_default_lane");
});

test("最近對話總結需求不會被誤導到 knowledge-assistant", () => {
  const lane = resolveCapabilityLane(
    { chat_type: "p2p" },
    {
      message: {
        content: JSON.stringify({
          text: "幫我總結最近對話",
        }),
      },
    },
  );

  assert.equal(lane.capability_lane, "personal-assistant");
});

test("泛化風險問句不會被硬路由到 runtime lane", () => {
  const lane = resolveCapabilityLane(
    { chat_type: "p2p" },
    {
      message: {
        content: JSON.stringify({
          text: "這個方案風險",
        }),
      },
    },
  );

  assert.equal(lane.capability_lane, "personal-assistant");
  assert.equal(lane.lane_reason, "direct_message_default_lane");
});

test("泛化整理問句不會因為整理一詞被硬路由到文件 lane", () => {
  const lane = resolveCapabilityLane(
    { chat_type: "p2p" },
    {
      message: {
        content: JSON.stringify({
          text: "幫我整理會議",
        }),
      },
    },
  );

  assert.equal(lane.capability_lane, "personal-assistant");
});

test("detectDocBoundaryIntent 會把分類與保留視為高置信 doc-boundary", () => {
  const intent = detectDocBoundaryIntent("把知識庫文件分類後保留產品相關的");

  assert.equal(intent.mentions_company_brain, true);
  assert.equal(intent.wants_document_classification, true);
  assert.equal(intent.wants_document_boundary_selection, true);
  assert.equal(intent.is_high_confidence_doc_boundary, true);
});

test("normalizeMessageText 會保留結構化欄位供 lane 判斷", () => {
  const text = normalizeMessageText({
    message: {
      msg_type: "file",
      content: JSON.stringify({
        document_id: "MFK7dDFLFoVlOGxWCv5cTXKmnMh",
        title: "Spec doc",
      }),
    },
  });

  assert.match(text, /mfk7ddflfovlogxwcv5ctxkmnmh/);
  assert.match(text, /spec doc/i);
});

test("buildLaneFailureReply 會對 doc-editor 給出可操作的重試提示", () => {
  const text = buildLaneFailureReply(
    { capability_lane: "doc-editor" },
    { capability_lane: "doc-editor", lane_label: "文檔編輯助手" },
  );

  assert.match(text, /文檔編輯助手/);
  assert.match(text, /文件卡片|文件連結|document_id/);
});

test("buildLaneFailureReply 會對 knowledge-assistant 給出查詢重試提示", () => {
  const text = buildLaneFailureReply(
    { capability_lane: "knowledge-assistant" },
    { capability_lane: "knowledge-assistant", lane_label: "知識助手" },
  );

  assert.match(text, /知識助手/);
  assert.match(text, /更明確的關鍵字/);
});
