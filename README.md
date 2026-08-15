# 📱 DSH Feishu Remote

> Control your [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) agent from **Feishu / Lark** on your phone. Send a task by DM — get the result back in chat.

[![dsh-plugin](https://img.shields.io/badge/dsh-plugin-4d7fff)](https://github.com/topics/dsh-plugin) [![DeepSeek Harness](https://img.shields.io/badge/deepseek--harness-plugin-4d7fff)](https://github.com/deepseek-ai/deepseek-harness) [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

## ✨ What it does

- 📨 **Feishu → Agent**: DM your Feishu bot a task, a headless DSH agent runs it, and the result comes back to the chat.
- 📤 **Agent → Feishu**: the model gets a `feishu_send` tool to push results/notifications to any user or chat.
- 🤖 **Long connection**: uses `lark-cli`'s WebSocket event bus — **no public webhook server needed**, works on localhost/LAN.
- 🔒 **Secure**: reuses `lark-cli`'s OS-keychain credential storage and permission system.

## 🚀 Install

### 0. Prerequisites

- A Feishu/Lark **self-built app** with the **Bot** ability enabled, event subscription `im.message.receive_v1` (long-connection mode), and permissions `im:message`, `im:message:send_as_bot`, `im:message.p2p_msg:readonly`, `im:chat:read`, `im:resource` — all configured in the [Feishu developer console](https://open.feishu.cn/app).
- `lark-cli` installed & authenticated once:

```sh
npm i -g @larksuite/cli
lark-cli config init            # paste your App ID / Secret
lark-cli auth login --recommend # scan QR to authorize
```

### 1. Install the plugin

```sh
dsh plugin --profile demo add github:ShiXiangYu2/dsh-feishu-remote
```

### 2. Configure

```sh
export LARK_HOME="$HOME"        # where lark-cli config lives
export LARK_SEND_AS=bot         # bot (default) or user
dsh --profile demo
```

### 3. Use it

DM your Feishu bot: `帮我总结一下 ~/projects 的 README` — the agent runs and replies in Feishu.

## 🛠 Tools

| Tool | Description |
|---|---|
| `feishu_send` | Model-facing: send a message to a Feishu user (`ou_`) or chat (`oc_`). |

## 🔌 How it works

```
Feishu DM ──► lark-cli event consume (WebSocket long-connection)
                  │
                  ▼
        DSH agent session (agents.create)
                  │  agent.send(task) → whenIdle()
                  ▼
        result text ──► lark-cli im +messages-send ──► Feishu chat
```

## ⚠️ Notes

- The full agent task wiring uses DSH's headless agent API (`agents.create` + `agent.send`); requires the `dsh-agent-loop` provider to be loaded (it is in the default profile).
- Long tasks: the plugin currently awaits `whenIdle()`; very long runs may exceed Feishu's message size — replies are truncated to the final text block.
- See the [Feishu developer console](https://open.feishu.cn/app) for app setup details (abilities, permissions, event subscription, version release).

## 📄 License

MIT
