import * as Lark from "@larksuiteoapi/node-sdk";
import { baseConfig, botName } from "./config.mjs";

const client = new Lark.Client(baseConfig);

function safeParseMessageContent(content) {
  if (!content) {
    return {};
  }

  try {
    return JSON.parse(content);
  } catch {
    return {};
  }
}

function buildReplyText(event) {
  const parsed = safeParseMessageContent(event?.message?.content);
  const incomingText = parsed.text?.trim();

  if (incomingText) {
    return `${botName} 已收到：${incomingText}`;
  }

  return `${botName} 已连上长连接，可以开始收消息了。`;
}

async function replyToChat(chatId, text) {
  return client.im.v1.message.create({
    params: {
      receive_id_type: "chat_id",
    },
    data: {
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text }),
    },
  });
}

const eventDispatcher = new Lark.EventDispatcher({}).register({
  "im.message.receive_v1": async (data) => {
    const chatId = data?.message?.chat_id;
    const senderType = data?.sender?.sender_type;

    console.log("Received event:", JSON.stringify(data, null, 2));

    if (!chatId) {
      console.warn("Skip event without chat_id");
      return;
    }

    if (senderType === "app") {
      console.log("Skip self-sent app message");
      return;
    }

    const replyText = buildReplyText(data);
    await replyToChat(chatId, replyText);
    console.log(`Replied to chat ${chatId}`);
  },
});

const wsClient = new Lark.WSClient({
  ...baseConfig,
  loggerLevel: Lark.LoggerLevel.info,
});

process.on("SIGINT", () => {
  console.log("Shutting down Lark WS client...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("Shutting down Lark WS client...");
  process.exit(0);
});

console.log(`Starting ${botName} with long connection...`);
wsClient.start({ eventDispatcher });
