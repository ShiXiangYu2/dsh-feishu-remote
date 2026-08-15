import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'feishu-remote-plugin'
export const inject = ['tools', 'shell', 'agents', 'timer']

/**
 * dsh-feishu-remote: control your DeepSeek Harness agent from Feishu/Lark.
 *
 * Flow: user DMs the Feishu bot → `lark-cli event consume` long-connection
 * delivers the message → plugin creates a headless agent session, routes the
 * message via `agent.send()` → agent runs the task → result is sent back to
 * the Feishu chat via `lark-cli im +messages-send`.
 *
 * Prereqs:
 *   - lark-cli on PATH (`npm i -g @larksuite/cli`), configured & logged in
 *     (`lark-cli config init` + `lark-cli auth login`), app has the bot
 *     ability and `im.message.receive_v1` event subscription (long-connection).
 *   - `im:message:send_as_bot` (or `--as user` with send_as_user) granted.
 *
 * Env:
 *   LARK_HOME  - HOME to use for lark-cli config (default: process HOME)
 *   LARK_CLI   - lark-cli binary path (default: "lark-cli" on PATH)
 *   LARK_SEND_AS - "bot" (default) or "user"
 */

const ENV_HOME = process.env.LARK_HOME
const CLI = process.env.LARK_CLI || 'lark-cli'
const SEND_AS = process.env.LARK_SEND_AS || 'bot'

/** Run one lark-cli command with JSON args; returns parsed result. */
async function runLark(ctx, argv) {
  const shell = ctx.get('shell')
  if (shell === undefined) return { ok: false, error: 'shell service unavailable' }
  const parts = argv.map((a) => (/^[A-Za-z0-9_./:@=+-]+$/.test(a) ? a : JSON.stringify(a)))
  const command = `HOME=${JSON.stringify(ENV_HOME || process.env.HOME)} ${CLI} ${parts.join(' ')}`
  const spec = shell.resolve({ command, timeoutMs: 90000 })
  const result = await shell.run(spec)
  if (result.exitCode !== 0) {
    return { ok: false, error: `lark-cli exit ${result.exitCode}: ${result.stderr.text.slice(0, 300)}` }
  }
  try {
    const data = JSON.parse(result.stdout.text)
    if (data && data.ok === false) {
      return { ok: false, error: (data.error && data.error.message) || 'lark error', data }
    }
    return { ok: true, data }
  } catch {
    return { ok: true, data: null, raw: result.stdout.text }
  }
}

/** Send a text message to a user (ou_) or chat (oc_). */
async function sendTo(ctx, target, text) {
  const flag = String(target).startsWith('oc_') ? '--chat-id' : '--user-id'
  const r = await runLark(ctx, ['im', '+messages-send', flag, target, '--text', String(text), '--as', SEND_AS])
  return r.ok
}

/** Create a headless agent and run one task; returns the final message text. */
async function runAgentTask(ctx, task, senderId) {
  const agents = ctx.get('agents')
  if (agents === undefined || typeof agents.create !== 'function') {
    return { ok: false, error: 'agents service unavailable (is the agent-loop loaded?)' }
  }
  const sessionId = `feishu-${senderId.replace(/[^a-zA-Z0-9]/g, '').slice(-16)}-${Date.now().toString(36)}`
  let handle
  try {
    handle = await agents.create({
      sessionId,
      meta: { cwd: process.env.DSH_WORKSPACE_ROOT || process.env.PWD || '.', origin: 'subagent' },
      agentOptions: {},
    })
  } catch (e) {
    return { ok: false, error: `agent create failed: ${String((e && e.message) || e).slice(0, 300)}` }
  }
  try {
    const agent = handle.agent
    // Route the task into the agent's inbox and wake it.
    agent.send(
      {
        id: `feishu-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        role: 'user',
        content: [{ type: 'text', text: task }],
        source: { kind: 'user' },
      },
      'next-turn',
      true,
    )
    await agent.whenIdle()
    // Best-effort: read the final assistant message from the session projection.
    const lastText = readLastAssistantText(agent)
    return { ok: true, text: lastText || '✅ 任务已完成（无文本输出）' }
  } catch (e) {
    return { ok: false, error: `task run failed: ${String((e && e.message) || e).slice(0, 300)}` }
  } finally {
    try { await handle.dispose() } catch { /* ignore */ }
  }
}

/** Extract the last assistant text block from the agent's session log. */
function readLastAssistantText(agent) {
  try {
    const session = agent.session
    const events = typeof session?.toArray === 'function' ? session.toArray() : []
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]
      if (ev && ev.type === 'assistant' && Array.isArray(ev.content)) {
        for (let j = ev.content.length - 1; j >= 0; j--) {
          const b = ev.content[j]
          if (b && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
            return b.text.trim()
          }
        }
      }
    }
  } catch { /* ignore */ }
  return null
}

/** Register the model-facing feishu_send tool (agent can push to Feishu). */
function registerSendTool(ctx) {
  ctx.tools.register(defineTool({
    name: 'feishu_send',
    description: 'Send a message to a Feishu/Lark user (ou_) or chat (oc_). Push results or notifications to the user.',
    parameters: {
      target: { type: 'string', required: true, description: 'open_id (ou_xxx) or chat_id (oc_xxx).' },
      text: { type: 'string', required: true, description: 'Message text.' },
      as: { type: 'string', enum: ['user', 'bot'], description: 'Identity. Default: bot.' },
    },
    async execute(args) {
      const ok = await sendTo(ctx, args.target, args.text)
      return ok ? '✅ 已发送到飞书' : '❌ 发送失败'
    },
  }))
}

/**
 * Start the long-connection event listener. For each inbound DM message,
 * run it as an agent task and reply with the result.
 */
function startEventListener(ctx) {
  const shell = ctx.get('shell')
  if (shell === undefined) return
  const spec = shell.resolve({
    command: `HOME=${JSON.stringify(ENV_HOME || process.env.HOME)} ${CLI} event consume im.message.receive_v1 --as bot --timeout 0s --quiet`,
    timeoutMs: 0,
  })
  const proc = shell.start(spec)
  ctx.effect(() => { try { proc.kill?.() } catch { /* ignore */ } })

  // Poll the process output (readOutput is consuming; poll on a timer).
  const poll = () => {
    try {
      const read = proc.readOutput()
      const text = (read && read.text) || ''
      for (const raw of text.split('\n')) {
        const line = raw.trim()
        if (!line || line.startsWith('[')) continue
        try {
          const evt = JSON.parse(line)
          const content = evt.content || evt.text || ''
          const chatId = evt.chat_id || ''
          const senderId = (evt.sender && evt.sender.id) || evt.sender_id || chatId
          if (!content || !chatId) continue
          // Echo ack first, then run the task (fire-and-forget).
          sendTo(ctx, chatId, `🤖 收到，正在处理：${String(content).slice(0, 60)}…`).then(() => {
            return runAgentTask(ctx, String(content), String(senderId)).then((r) => {
              const reply = r.ok ? r.text : `❌ ${r.error}`
              return sendTo(ctx, chatId, reply).catch(() => {})
            })
          }).catch(() => {})
        } catch { /* malformed line */ }
      }
    } catch { /* process gone */ }
  }
  // lark-cli prints each event as one NDJSON line; poll every 500ms.
  ctx.interval?.(poll, 500)
}

export function apply(ctx) {
  registerSendTool(ctx)
  startEventListener(ctx)
}
