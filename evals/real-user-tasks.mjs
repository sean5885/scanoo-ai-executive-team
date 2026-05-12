import {
  productionLikeCases,
  productionLikePackMap,
  productionLikePacks,
} from "./production-like/index.mjs";

export const legacyConversationSnapshotTasks = [
  {
    id: "meeting-organize-basic",
    message: "幫我整理會議",
    auth_mode: "tenant",
    expected: {
      capability_lane: "personal-assistant",
      chosen_action: "summarize_recent_dialogue",
      must_include: ["拿不到你的個人對話存取權限", "先貼內容", "幫你整理重點"],
    },
  },
  {
    id: "meeting-organize-todo",
    message: "幫我整理會議重點並列出待辦",
    auth_mode: "tenant",
    expected: {
      capability_lane: "personal-assistant",
      chosen_action: "summarize_recent_dialogue",
      must_include: ["重新登入後", "幫你整理重點"],
    },
  },
  {
    id: "proposal-risk",
    message: "這個方案風險在哪",
    auth_mode: "user",
    expected: {
      capability_lane: "personal-assistant",
      chosen_action: "general_assistant_action",
      must_include: ["風險盤點", "需求/範圍風險", "高/中/低風險分級"],
      disallow_generic_template: true,
    },
  },
  {
    id: "greeting",
    message: "你好",
    auth_mode: "user",
    expected: {
      capability_lane: "personal-assistant",
      chosen_action: "general_assistant_action",
      must_include: ["你好，我在", "不用先切模式"],
    },
  },
  {
    id: "today-first-step",
    message: "今天先做什麼",
    auth_mode: "user",
    expected: {
      capability_lane: "personal-assistant",
      chosen_action: "general_assistant_action",
      must_include: ["最能解鎖後續進度", "今天先做 3 件"],
      disallow_generic_template: true,
    },
  },
  {
    id: "vague-ideation",
    message: "幫我想一下",
    auth_mode: "user",
    expected: {
      capability_lane: "personal-assistant",
      chosen_action: "general_assistant_action",
      must_include: ["我可以先幫你把這件事接住", "你可以直接說要我整理什麼"],
    },
  },
  {
    id: "copy-no-send",
    message: "幫我寫文案但先不要發送",
    auth_mode: "user",
    expected: {
      capability_lane: "personal-assistant",
      chosen_action: "general_assistant_action",
      must_include: ["文案骨架", "目標受眾", "平台（FB/Email/官網）"],
      disallow_generic_template: true,
    },
  },
  {
    id: "next-step-push",
    message: "幫我想一下接下來怎麼推",
    auth_mode: "user",
    expected: {
      capability_lane: "personal-assistant",
      chosen_action: "general_assistant_action",
      must_include: ["目標 -> 路徑 -> 節點", "可執行節點"],
      disallow_generic_template: true,
    },
  },
  {
    id: "today-first-step-better",
    message: "今天先做什麼比較好",
    auth_mode: "user",
    expected: {
      capability_lane: "personal-assistant",
      chosen_action: "general_assistant_action",
      must_include: ["最能解鎖後續進度", "今天先做 3 件"],
      disallow_generic_template: true,
    },
  },
  {
    id: "proposal-risk-three-points",
    message: "這個方案風險在哪裡，先給我三點",
    auth_mode: "user",
    expected: {
      capability_lane: "personal-assistant",
      chosen_action: "general_assistant_action",
      must_include: ["風險盤點", "需求/範圍風險", "高/中/低風險分級"],
      disallow_generic_template: true,
    },
  },
];

export const realUserTaskPacks = Object.freeze({
  legacy_conversation_snapshot: Object.freeze({
    id: "legacy-conversation-snapshot",
    description: "原始 real-user 對話快照回歸包",
    cases: Object.freeze(legacyConversationSnapshotTasks),
  }),
  ...productionLikePackMap,
});

export {
  productionLikeCases,
  productionLikePacks,
};

export const tasks = legacyConversationSnapshotTasks;
