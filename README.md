# 龙虾 Lark 长连接 Bot

这个目录现在是一套最小可运行的 Lark 长连接 bot，基于官方 `@larksuiteoapi/node-sdk`。

## 已配置

- `App ID`: `cli_a93aa8822178de19`
- `LARK_DOMAIN`: `lark`
- 凭据保存在本地 `.env`，并已加入 `.gitignore`

## 启动

```bash
npm install
npm run auth:check
npm start
```

## 当前行为

- 使用长连接模式接收 `im.message.receive_v1`
- 收到文本消息后，回复：`龙虾 已收到：<你的消息>`
- 若不是文本，回复固定提示，证明 bot 已接通

## 开发者后台需要确认

在 Lark Developer 后台确认以下配置：

1. 应用类型为自建应用。
2. 已开启 Bot 能力。
3. 事件订阅里开启长连接模式。
4. 已订阅事件 `im.message.receive_v1`。
5. 已授予发消息相关权限；如果收不到/发不出消息，优先检查消息权限和应用可见范围。
6. 把应用安装到目标租户，并把 bot 拉进需要测试的群或会话。

## 文件说明

- `src/index.mjs`: 长连接入口
- `src/config.mjs`: 环境变量和 SDK 配置
- `scripts/check-auth.mjs`: 直接校验 `App ID/App Secret` 是否可换到 token
