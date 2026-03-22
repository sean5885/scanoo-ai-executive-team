export const cases = [
  {
    name: "basic meeting summary",
    transcript: `
今天確認 Scanoo 交付流程本週內要完成第一版。
韓笑負責整理交付 SOP，週三前完成。
Aria 負責驗收清單，週四前完成。
目前 blocker 是模板欄位還沒統一。
決議先不擴需求，先把單店導入跑通。
`,
    expected: {
      summary: "本次會議確認先完成交付流程第一版，先聚焦單店導入。",
      decisions: ["先不擴需求，先把單店導入跑通"],
      action_items: [
        {
          item: "整理交付 SOP",
          owner: "韓笑",
          deadline: "週三前",
        },
        {
          item: "驗收清單",
          owner: "Aria",
          deadline: "週四前",
        },
      ],
      blockers: ["模板欄位還沒統一"],
    },
  },
];
