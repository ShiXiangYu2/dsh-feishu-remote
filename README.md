# 📱 DSH Feishu Remote

> Control your [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) agent from **Feishu / Lark** on your phone. Send a task by DM — get the result back in chat. **Fully working closed loop.**

[![dsh-plugin](https://img.shields.io/badge/dsh-plugin-4d7fff)](https://github.com/topics/dsh-plugin) [![DeepSeek Harness](https://img.shields.io/badge/deepseek--harness-plugin-4d7fff)](https://github.com/deepseek-ai/deepseek-harness) [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

## ✨ What it does

- 📨 **Feishu → Agent → Feishu**: DM your bot a task (e.g. `2+3等于几？`), a DSH agent runs it with your configured LLM, and the **answer comes back to the chat**.
- 📤 **Agent → Feishu**: the model gets a `feishu_send` tool to push results/notifications to any user or chat.
- 🤖 **Long connection**: uses `lark-cli`'s WebSocket event bus — **no public webhook server needed**, works on localhost/LAN/private servers.
- 🔒 **Secure**: reuses `lark-cli`'s OS-keychain credential storage and permission system; event listener runs unsandboxed by design (it must hold the WebSocket).

## 🚀 Install

### 0. Prerequisites

1. A Feishu/Lark **self-built app** with:
   - **Bot** ability enabled
   - Event subscription `im.message.receive_v1` (**long-connection** mode)
   - Permissions: `im:message`, `im:message:send_as_bot`, `im:message.p2p_msg:readonly`, `im:chat:read`, `im:resource`
   - A published version
   - (Setup in the [Feishu developer console](https://open.feishu.cn/app) — the CLI can enable the bot ability via API, but events/permissions need the console.)

2. `lark-cli` installed & authenticated once:

```sh
npm i -g @larksuite/cli
lark-cli config init            # paste your App ID / Secret
lark-cli auth login --recommend # scan QR to authorize
```

### 1. Install the plugin

```sh
dsh plugin --profile demo add github:ShiXiangYu2/dsh-feishu-remote
```

The bundle contains two pieces:
- `index.js` — the Cordis plugin: registers the `feishu_send` model tool and attempts an in-process event listener.
- `feishu-resident.mjs` — the **recommended resident launcher**: boots the web profile and runs the long-connection event loop in a detached process (see below).

### 2. Configure the model

The DSH profile must have a working LLM route (e.g. DeepSeek via SiliconFlow):

```yaml
# profile cordis.patch.yml
- id: llm-deepseek
  config:
    apiKeyEnv: SILICONFLOW_API_KEY
    baseURL: https://api.siliconflow.cn/v1
    thinking: disabled
    reasoningEffort: off
    models:
      - id: deepseek-ai/DeepSeek-V3.2
        name: DeepSeek-V3.2 (via SiliconFlow)
        contextWindow: 65536
        maxTokens: 8192

- id: agent-default-model
  config:
    provider: deepseek-official
    model: deepseek-ai/DeepSeek-V3.2
```

### 3. Run the resident (recommended)

The closed loop must live in a **long-lived process**. Use the included resident launcher:

```sh
# Adjust the absolute paths in feishu-resident.mjs (LARK_HOME, CLI) to your setup.
DSH_HOME=~/.dsh SILICONFLOW_API_KEY=sk-... \
  node --import tsx/esm feishu-resident.mjs
```

It boots the `web` profile, spawns `lark-cli event consume` as a detached process (holding stdin open via a `tail -f /dev/null` pipe so the listener never exits on EOF), and for each inbound DM: **ack → create agent → run task → extract final text → reply**.

### 4. Use it

DM your Feishu bot anything, e.g. `帮我总结一下 ~/projects 的 README` — the agent runs and the result comes back to the chat.

## 🛠 Tools

| Tool | Description |
|---|---|
| `feishu_send` | Model-facing: send a message to a Feishu user (`ou_`) or chat (`oc_`). |

## 🔌 How it works

```
Feishu DM ──► lark-cli event consume (WebSocket long-connection, detached process)
                  │  NDJSON event on stdout
                  ▼
        feishu-resident.mjs (long-lived process)
                  │  agents.create + followup(task) + whenIdle()
                  ▼
        final assistant text (ev.data.message.content)
                  │  lark-cli im +messages-send
                  ▼
        Feishu chat reply
```

## ⚠️ Notes

- **Why a resident process?** DSH's shell service binds background processes to the calling plugin fiber; a listener started inside a plugin's `apply()` is killed when the fiber settles. The resident launcher owns the listener in its own process, so it survives.
- **Text extraction**: the final answer is read from the session log's `assistant/message` events (`ev.data.message.content`, mirroring the official headless `summarize()`).
- Long tasks: replies are truncated to the final text block; very long runs may exceed Feishu message limits.
- lark-cli event output streams as NDJSON on **stdout** (stderr carries `[event]` log lines) — both are parsed.

## 📄 License

MIT
