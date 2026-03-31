const GENERAL_ASSISTANT_REPLY = [
  "結論",
  "我可以先幫你把這件事接住。",
  "",
  "重點",
  "- 你可以直接說要我整理什麼、查什麼，或幫你起草什麼內容。",
  "",
  "下一步",
  "- 如果你願意，我可以先從這段對話、今天的日程、最近待辦，或一份文件開始。",
].join("\n");

const MEETING_PERMISSION_REPLY = [
  "結論",
  "要整理最近對話，我現在還拿不到你的個人對話存取權限。",
  "",
  "重點",
  "- 所以我這輪先沒辦法直接讀你的私聊歷史來整理。",
  "",
  "下一步",
  "- 等你重新登入後，我就能直接幫你整理；如果你現在先貼內容，我也可以先幫你整理重點。",
].join("\n");

export const tasks = [
  {
    id: "meeting-organize-basic",
    message: "幫我整理會議",
    auth_mode: "tenant",
    expected: {
      capability_lane: "personal-assistant",
      chosen_action: "summarize_recent_dialogue",
      reply_snapshot: MEETING_PERMISSION_REPLY,
      help_markers: ["先貼內容", "幫你整理重點"],
    },
  },
  {
    id: "meeting-organize-todo",
    message: "幫我整理會議重點並列出待辦",
    auth_mode: "tenant",
    expected: {
      capability_lane: "personal-assistant",
      chosen_action: "summarize_recent_dialogue",
      reply_snapshot: MEETING_PERMISSION_REPLY,
      help_markers: ["重新登入後", "幫你整理重點"],
    },
  },
  {
    id: "proposal-risk",
    message: "這個方案風險在哪",
    auth_mode: "user",
    expected: {
      capability_lane: "personal-assistant",
      chosen_action: "general_assistant_action",
      reply_snapshot: GENERAL_ASSISTANT_REPLY,
      help_markers: ["接住", "幫你起草"],
    },
  },
  {
    id: "greeting",
    message: "你好",
    auth_mode: "user",
    expected: {
      capability_lane: "personal-assistant",
      chosen_action: "general_assistant_action",
      reply_snapshot: GENERAL_ASSISTANT_REPLY,
      help_markers: ["接住", "幫你起草"],
    },
  },
  {
    id: "today-first-step",
    message: "今天先做什麼",
    auth_mode: "user",
    expected: {
      capability_lane: "personal-assistant",
      chosen_action: "general_assistant_action",
      reply_snapshot: GENERAL_ASSISTANT_REPLY,
      help_markers: ["接住", "今天的日程"],
    },
  },
  {
    id: "vague-ideation",
    message: "幫我想一下",
    auth_mode: "user",
    expected: {
      capability_lane: "personal-assistant",
      chosen_action: "general_assistant_action",
      reply_snapshot: GENERAL_ASSISTANT_REPLY,
      help_markers: ["整理什麼", "一份文件開始"],
    },
  },
  {
    id: "copy-no-send",
    message: "幫我寫文案但先不要發送",
    auth_mode: "user",
    expected: {
      capability_lane: "personal-assistant",
      chosen_action: "general_assistant_action",
      reply_snapshot: GENERAL_ASSISTANT_REPLY,
      help_markers: ["起草什麼內容", "這件事接住"],
    },
  },
  {
    id: "next-step-push",
    message: "幫我想一下接下來怎麼推",
    auth_mode: "user",
    expected: {
      capability_lane: "personal-assistant",
      chosen_action: "general_assistant_action",
      reply_snapshot: GENERAL_ASSISTANT_REPLY,
      help_markers: ["查什麼", "最近待辦"],
    },
  },
  {
    id: "today-first-step-better",
    message: "今天先做什麼比較好",
    auth_mode: "user",
    expected: {
      capability_lane: "personal-assistant",
      chosen_action: "general_assistant_action",
      reply_snapshot: GENERAL_ASSISTANT_REPLY,
      help_markers: ["今天的日程", "最近待辦"],
    },
  },
  {
    id: "proposal-risk-three-points",
    message: "這個方案風險在哪裡，先給我三點",
    auth_mode: "user",
    expected: {
      capability_lane: "personal-assistant",
      chosen_action: "general_assistant_action",
      reply_snapshot: GENERAL_ASSISTANT_REPLY,
      help_markers: ["查什麼", "起草什麼內容"],
    },
  },
];
