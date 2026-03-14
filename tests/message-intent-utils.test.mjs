import test from "node:test";
import assert from "node:assert/strict";

import { buildLaneFailureReply, resolveCapabilityLane } from "../src/capability-lane.mjs";
import {
  collectRelatedMessageIds,
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
