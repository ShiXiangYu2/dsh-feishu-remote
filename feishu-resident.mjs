/**
 * Feishu remote resident: full closed loop.
 *
 * 1. Boot the `web` profile (plugins mounted, incl. feishu-remote for the
 *    model-facing `feishu_send` tool and SiliconFlow model wiring).
 * 2. Spawn lark-cli's long-connection event listener as a detached process.
 * 3. For each inbound DM message:
 *      ack → create a headless DSH agent → route the task via agent.send()
 *      → wait for idle → read the final assistant text → reply in Feishu.
 *
 * Run:
 *   DSH_HOME=/root/dsh /.dsh SILICONFLOW_API_KEY=sk-... \
 *     node --import tsx/esm /root/dsh /feishu-resident.mjs
 */
import { runProfile } from '/www/wwwroot/deepseek-harness/apps/cli/src/profile-boot.ts'
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

const LOG = '/root/feishu-loop.log'
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`
  console.log(line)
  try { appendFileSync(LOG, line + '\n') } catch { /* ignore */ }
}

const HOME = '/root/dsh /larkenv/home'
const CLI = '/root/dsh /larkenv/cli/node_modules/.bin/lark-cli'
const SEND_AS = process.env.LARK_SEND_AS || 'bot'
const OWNER_OPEN_ID = 'ou_6d2d600eb79929f72542f44d6acd70d9' // 石祥雨

function q(s) { return `'${String(s).replace(/'/g, `'\\''`)}'` }

/** Send a text message to a Feishu user (ou_) or chat (oc_). */
function sendTo(target, text) {
  return new Promise((resolve) => {
    const flag = String(target).startsWith('oc_') ? '--chat-id' : '--user-id'
    const child = spawn('bash', ['-c',
      `HOME=${q(HOME)} ${q(CLI)} im +messages-send ${flag} ${q(String(target))} --text ${q(String(text))} --as ${SEND_AS}`],
      { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.on('close', () => {
      try {
        const ok = out.trim() && JSON.parse(out).ok !== false
        resolve(ok)
      } catch { resolve(false) }
    })
    child.on('error', () => resolve(false))
  })
}

/** Extract the last assistant text block from the agent's session log. */
function lastAssistantText(agent) {
  try {
    // Mirror the official headless summarize(): events carry
    // { type, data: { message: { content: [...] } } } — note the .data layer.
    const events = agent.session?.events || []
    let text = ''
    let started = false
    for (const ev of events) {
      if (ev.type === 'turn/start') { started = true; continue }
      if (!started) continue
      if (ev.type === 'assistant/message' && ev.data && Array.isArray(ev.data.message?.content)) {
        const joined = ev.data.message.content
          .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
          .join('')
        if (joined !== '') text = joined
      }
    }
    return text || null
  } catch (e) { /* ignore */ }
  return null
}

/** Create a headless agent, run one task, return the final text. */
async function runAgentTask(ctx, task, senderId) {
  // Mirror the official headless runner: await the loader, resolve the default
  // model, create the agent with explicit provider/model + model-selection
  // setup, then followup the task and wait for quiescence.
  try { await ctx.get('loader')?.await() } catch { /* ignore */ }
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  if (!agents || typeof agents.create !== 'function' || !defaultModel) {
    return { ok: false, error: 'agents/agentDefaultModel service unavailable' }
  }
  const selection = defaultModel.currentSelection()
  const sessionId = SessionId(`feishu-${String(senderId).replace(/[^a-zA-Z0-9]/g, '').slice(-12)}-${Date.now().toString(36)}`)
  let handle
  try {
    handle = await agents.create({
      sessionId,
      meta: { cwd: process.env.DSH_WORKSPACE_ROOT || process.env.PWD || '.', origin: 'subagent' },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: (agentCtx) => {
        // Wire the resolved model selection into the child agent's scope so
        // the agent can resolve its model at call time. IMPORTANT: use a
        // block body — returning installModelSelection's disposer would be
        // mistaken for a setupCommit (its .commit() is not a function).
        try {
          installModelSelection(agentCtx, { current: selection, assembled: undefined })
        } catch (e) { log('model selection setup warn: ' + String(e).slice(0, 120)) }
      },
    })
  } catch (e) {
    return { ok: false, error: `agent create failed: ${String((e && e.message) || e).slice(0, 300)}` }
  }
  try {
    const agent = handle.agent
    await agent.whenIdle()
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: task }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    const text = lastAssistantText(agent)
    return { ok: true, text: text || '✅ 任务已完成（无文本输出）' }
  } catch (e) {
    return { ok: false, error: `task run failed: ${String((e && e.message) || e).slice(0, 300)}` }
  } finally {
    try { await handle.dispose() } catch { /* ignore */ }
  }
}

async function main() {
  const { ctx, shutdown } = await runProfile({
    profile: 'web',
    patchFiles: ['/root/dsh /feishu-patch.yml'],
    args: ['--host', '127.0.0.1', '--port', '3100'],
  })
  console.log(`[resident] web booted (PID ${process.pid}); starting lark event listener…`)
  log('web booted')

  const child = spawn('bash', ['-c',
    `HOME=${q(HOME)} ${q(CLI)} event consume im.message.receive_v1 --as bot --timeout 0s --max-events 0 < <(tail -f /dev/null)`],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.unref()
  console.log(`[resident] lark listener pid=${child.pid}`)
  log('lark listener spawned pid=' + child.pid)

  // Parse one NDJSON line from the listener's output stream. Events arrive
  // on stdout; stderr carries `[event]` log lines (skipped by the JSON parse).
  const handleLine = (raw) => {
    const line = raw.trim()
    if (!line || line.startsWith('[')) return
    let evt
    try { evt = JSON.parse(line) } catch (e) { log('parse skip: ' + String(e).slice(0, 100)); return }
    const content = evt.content || ''
    const chatId = evt.chat_id || ''
    const senderId = evt.sender_id || chatId
    if (!content || !chatId) return
    log(`<< EVENT message from ${senderId}: ${String(content).slice(0, 60)}`)
    ;(async () => {
      await sendTo(chatId, `🤖 收到，正在处理：${String(content).slice(0, 60)}…`)
      log('ack sent')
      const r = await runAgentTask(ctx, String(content), String(senderId))
      const reply = r.ok ? r.text : `❌ ${r.error}`
      log(`>> reply: ${String(reply).slice(0, 80)}`)
      await sendTo(chatId, reply)
      log('reply sent')
    })().catch((e) => { const msg = String(e); log('handler error: ' + msg); console.error('[resident] handler error:', msg) })
  }

  // Buffer NDJSON from a stream and dispatch complete lines.
  const makeParser = (label) => {
    let buf = ''
    return (d) => {
      const chunk = String(d)
      buf += chunk
      log(`${label} chunk: ${chunk.slice(0, 120)}`)
      const lines = buf.split('\n')
      buf = lines.pop() || ''
      for (const line of lines) handleLine(line)
    }
  }
  child.stdout.on('data', makeParser('stdout'))
  child.stderr.on('data', makeParser('stderr'))
  child.on('exit', (code, sig) => { const msg = `lark listener exited code=${code} sig=${sig}`; log(msg); console.log(msg) })

  process.on('SIGTERM', () => { child.kill(); shutdown.interrupt(0) })
  process.on('SIGINT', () => { child.kill(); shutdown.interrupt(130) })
  setInterval(() => {}, 1 << 30)
}
main().catch((e) => { console.error('[resident] fatal:', e); process.exit(1) })
