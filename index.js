/**
 * dsh-star —— Host 半
 *
 * 1. 订阅会话事件，缓存最近的助手回复全文
 * 2. 提供打分接口，记录星级
 * 3. 用宿主自己的 llm 通道分析某条回复，给出可勾选的改进建议
 * 4. 把用户选中的建议写进 AGENTS.md 的固定小节
 *
 * 数据落在 ~/.dsh/star/：
 *   ratings.jsonl  每轮一条
 *   report.md      统计报告
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'

const HOME = os.homedir()
const DIR = path.join(HOME, '.dsh', 'star')
const FILE = path.join(DIR, 'ratings.jsonl')
const REPORT = path.join(DIR, 'report.md')
const AGENTS = path.join(HOME, '.dsh', 'AGENTS.md')
const PREFIX = '/star'
const SECTION = '## 从打分学到的偏好'
const CACHE_MAX = 60

const pad = (n) => (n < 10 ? '0' + n : String(n))
const nowIso = () => {
  const d = new Date()
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  return (
    d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) +
    sign + pad(Math.floor(abs / 60)) + ':' + pad(abs % 60)
  )
}

function eventText(message) {
  if (message === undefined || message === null) return ''
  const content = message?.content
  if (typeof content === 'string') return content.slice(0, 6000)
  if (!Array.isArray(content)) return typeof message?.text === 'string' ? message.text.slice(0, 6000) : ''
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block?.type === 'image') parts.push('[图片]')
    else if (block?.type === 'tool-call') parts.push('[调用 ' + String(block?.name ?? '工具') + ']')
  }
  return parts.join('\n').slice(0, 6000)
}

const ANALYSIS_SYSTEM = [
  '你在帮用户把「对一条 AI 回复的评价」变成可长期执行的规则。',
  '用户会给你一条助手回复的全文，以及他给的星级（1~5，5 最好）。',
  '',
  '请给出 3~5 条**具体、可执行**的改进建议，每条一句话，20~40 字，',
  '用「以后……」或「不要……」这样的祈使句，写成能直接放进规则文件的样子。',
  '要针对这条回复的实际内容，不要写空话（如「提高质量」「加强沟通」）。',
  '如果评分很高，就写「保持……」类的建议。',
  '',
  '只输出一个 JSON 数组，不要解释、不要 markdown 代码块：',
  '["建议1","建议2","建议3"]',
].join('\n')

/**
 * 会话记录是 zstd 多帧文件，zstdDecompressSync 只解第一帧（实测只剩几百字节）。
 * 这里按帧魔数切分后逐帧解压。
 */
function zstdAllFrames(buf) {
  const parts = []
  let start = 0
  for (let i = 4; i < buf.length - 3; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) {
      parts.push(buf.subarray(start, i))
      start = i
    }
  }
  parts.push(buf.subarray(start))
  const out = []
  for (const p of parts) {
    try { out.push(zlib.zstdDecompressSync(p)) } catch { /* 坏帧跳过 */ }
  }
  return Buffer.concat(out)
}

/**
 * 读当前会话"正在用的"provider/model。
 * 直接复用主人在界面上选的那个，比自己猜 provider 稳得多
 * （机器上可能挂着几个 API key 渠道，挑错了就是 Authentication Fails）。
 */
function readSessionModel() {
  const dir = path.join(HOME, '.dsh', 'storages', 'session_projcache', 'sessions')
  let files = []
  try {
    files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
  } catch {
    return null
  }
  for (const item of files.slice(0, 3)) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, item.f), 'utf8'))
      const lu = j?.record?.rows?.modelSelection?.val?.lastUsed
      if (lu && lu.provider && lu.model) {
        return { provider: String(lu.provider), model: String(lu.model) }
      }
    } catch { /* 换下一个 */ }
  }
  return null
}

async function pickModelFromLlm(llm) {
  try {
    const providers = llm.listProviders() ?? []
    if (!Array.isArray(providers) || !providers.length) return null
    const provider = providers.find((p) => String(p?.id ?? '').startsWith('deepseek')) ?? providers[0]
    const models = (await llm.listModels(provider.id)) ?? []
    if (!Array.isArray(models) || !models.length) return null
    const model =
      models.find((m) => /flash|mini|lite/i.test(String(m?.id ?? ''))) ??
      models.find((m) => /chat|v3|4/i.test(String(m?.id ?? ''))) ??
      models[0]
    return { provider: provider.id, model: model.id }
  } catch {
    return null
  }
}

function findLatestSessionFile() {
  const root = path.join(HOME, '.dsh', 'sessions')
  let best = null
  let dirs = []
  try { dirs = fs.readdirSync(root) } catch { return null }
  for (const d of dirs) {
    const p = path.join(root, d, 'session.v4.jsonl.zstd')
    try {
      const st = fs.statSync(p)
      if (!best || st.mtimeMs > best.t) best = { p, t: st.mtimeMs }
    } catch { /* 不是会话目录 */ }
  }
  // 有的会话多一层（workspace/session-id/）
  if (!best) {
    for (const d of dirs) {
      const base = path.join(root, d)
      let subs = []
      try { subs = fs.readdirSync(base) } catch { continue }
      for (const s of subs) {
        const p = path.join(base, s, 'session.v4.jsonl.zstd')
        try {
          const st = fs.statSync(p)
          if (!best || st.mtimeMs > best.t) best = { p, t: st.mtimeMs }
        } catch { /* 跳过 */ }
      }
    }
  }
  return best ? best.p : null
}

/**
 * 取某条回复的文字。先按 messageId 找那一步，再往前收集同轮的助手文本，
 * 因为一条回复会被拆成多步（引导句 + 工具调用 + 正文）。
 */
function readReplyText(messageId) {
  const file = findLatestSessionFile()
  if (!file) return ''
  let text = ''
  try {
    text = zstdAllFrames(fs.readFileSync(file)).toString('utf8')
  } catch {
    return ''
  }
  const lines = text.split('\n')
  const parsed = []
  for (const line of lines) {
    if (!line) continue
    try { parsed.push(JSON.parse(line)) } catch { /* 跳过坏行 */ }
  }
  const textOf = (msg) => {
    if (msg === undefined || msg === null) return ''
    const content = msg?.content
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return typeof msg?.text === 'string' ? msg.text : ''
    const parts = []
    for (const b of content) {
      if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    }
    return parts.join('\n')
  }
  const idOf = (ev) => String(ev?.data?.message?.id ?? ev?.data?.message?.messageId ?? ev?.data?.messageId ?? '')
  let idx = -1
  if (messageId) {
    for (let i = parsed.length - 1; i >= 0; i--) {
      if (parsed[i]?.type === 'assistant/message' && idOf(parsed[i]) === messageId) { idx = i; break }
    }
  }
  if (idx < 0) {
    // 没有 messageId（或匹配不上）：跳过正在跑的这一轮，取上一轮的最后一步
    let lastUser = -1
    for (let i = parsed.length - 1; i >= 0; i--) {
      if (parsed[i]?.type === 'user/message') { lastUser = i; break }
    }
    if (lastUser >= 0) {
      for (let i = lastUser - 1; i >= 0; i--) {
        if (parsed[i]?.type === 'assistant/message') { idx = i; break }
      }
    }
  }
  if (idx < 0) return ''
  // 一条回复会被拆成很多步（每步一条 assistant/message，正文往往在最后一步）。
  // 用 turn 编号把整轮的文字按顺序拼起来。
  const turnNo = parsed[idx]?.data?.turn
  const chunks = []
  let total = 0
  if (turnNo !== undefined && turnNo !== null) {
    for (const ev of parsed) {
      if (ev?.type !== 'assistant/message') continue
      if (ev?.data?.turn !== turnNo) continue
      const t = textOf(ev.data?.message ?? ev.data).trim()
      if (t === '') continue
      chunks.push(t)
      total += t.length
      if (total >= 4000) break
    }
  }
  if (chunks.length === 0) {
    const t = textOf(parsed[idx]?.data?.message ?? parsed[idx]?.data).trim()
    if (t !== '') chunks.push(t)
  }
  return chunks.join('\n\n').slice(0, 5000)
}

function extractJsonArray(text) {  const raw = String(text ?? '')
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end <= start) return null
  try {
    const arr = JSON.parse(raw.slice(start, end + 1))
    if (!Array.isArray(arr)) return null
    return arr.map((x) => String(x ?? '').trim()).filter((x) => x !== '').slice(0, 6)
  } catch {
    return null
  }
}

function readAll() {
  try {
    if (!fs.existsSync(FILE)) return []
    const lines = fs.readFileSync(FILE, 'utf8').split('\n')
    const out = []
    for (const line of lines) {
      if (!line.trim()) continue
      try { out.push(JSON.parse(line)) } catch { /* 跳过坏行 */ }
    }
    return out
  } catch {
    return []
  }
}

function append(entry) {
  fs.mkdirSync(DIR, { recursive: true })
  fs.appendFileSync(FILE, JSON.stringify(entry) + '\n', 'utf8')
}

function summarize(rows) {
  if (!rows.length) return { count: 0, avg: 0, buckets: [0, 0, 0, 0, 0] }
  const buckets = [0, 0, 0, 0, 0]
  let sum = 0
  for (const r of rows) {
    const s = Number(r.score)
    if (s >= 1 && s <= 5) { buckets[s - 1]++; sum += s }
  }
  return { count: rows.length, avg: Math.round((sum / rows.length) * 100) / 100, buckets }
}

function buildReport(rows) {
  const s = summarize(rows)
  const lines = ['# 打分偏好报告', '', '- 生成时间：' + nowIso(), '- 样本数：' + s.count, '- 平均分：' + s.avg, '', '## 分布', '']
  for (let i = 0; i < 5; i++) lines.push('- ' + (i + 1) + ' 星：' + s.buckets[i] + ' 次')
  lines.push('')
  const low = rows.filter((r) => Number(r.score) <= 2).slice(-8)
  const high = rows.filter((r) => Number(r.score) >= 4).slice(-8)
  if (low.length) {
    lines.push('## 低分片段', '')
    for (const r of low) lines.push('- ' + r.score + ' 星：' + String(r.excerpt || '').slice(0, 120).replace(/\n/g, ' '))
    lines.push('')
  }
  if (high.length) {
    lines.push('## 高分片段', '')
    for (const r of high) lines.push('- ' + r.score + ' 星：' + String(r.excerpt || '').slice(0, 120).replace(/\n/g, ' '))
    lines.push('')
  }
  return lines.join('\n')
}

/** 把选中的建议追加进 AGENTS.md 的固定小节（去重，最多 12 条）。 */
function appendRules(rules) {
  const clean = rules.map((r) => String(r ?? '').trim()).filter((r) => r !== '')
  if (!clean.length) return { ok: false, reason: '没有要写的建议' }
  try {
    let text = fs.existsSync(AGENTS) ? fs.readFileSync(AGENTS, 'utf8') : ''
    const re = new RegExp('^' + SECTION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*$', 'm')
    let existing = []
    if (re.test(text)) {
      const block = text.match(re)[0]
      existing = block.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim())
    }
    const merged = []
    for (const line of existing.concat(clean)) {
      if (line && !merged.includes(line)) merged.push(line)
    }
    const kept = merged.slice(-12)
    const block = SECTION + '\n\n' + kept.map((r) => '- ' + r).join('\n') + '\n'
    if (re.test(text)) text = text.replace(re, block)
    else {
      if (!text.endsWith('\n')) text += '\n'
      text += '\n' + block
    }
    const tmp = AGENTS + '.star.' + crypto.randomUUID() + '.tmp'
    fs.writeFileSync(tmp, text, 'utf8')
    fs.renameSync(tmp, AGENTS)
    return { ok: true, count: kept.length, added: kept.length - existing.length }
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) }
  }
}

export function apply(ctx) {
  const token = crypto.randomUUID().replace(/-/g, '')
  const recent = [] // { id, text, sessionId, ts }
  let llm = null

  ctx.on('session/event', (session, event) => {
    try {
      if (event?.type !== 'assistant/message') return
      const msg = event.data?.message ?? event.data
      const text = eventText(msg)
      if (!text) return
      const id = String(msg?.id ?? msg?.messageId ?? event.data?.messageId ?? '')
      recent.push({ id, text, sessionId: String(session?.id ?? ''), ts: Date.now() })
      while (recent.length > CACHE_MAX) recent.shift()
    } catch { /* 单条事件失败不影响其他 */ }
  })

  try {
    ctx.inject(['llm'], (llmCtx) => {
      try { llm = llmCtx?.llm ?? null } catch { llm = null }
    })
  } catch { llm = null }

  const isLocal = (req) => {
    const remote = String(req?.socket?.remoteAddress ?? '')
    const host = String(req?.headers?.host ?? '').toLowerCase()
    const remoteOk = remote === '' || remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
    const hostOk = host === '' || /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)
    return remoteOk && hostOk
  }

  const sendJson = (res, body, code = 200) => {
    try {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(body))
    } catch {
      try { res.end('{}') } catch { /* 连接已断 */ }
    }
  }

  const readBody = (req, limit = 256 * 1024) =>
    new Promise((resolve) => {
      let size = 0
      const chunks = []
      req.on('data', (c) => {
        size += c.length
        if (size > limit) { try { req.destroy() } catch {} ; resolve(''); return }
        chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', () => resolve(''))
    })

  async function pickModel() {
    if (!llm || typeof llm.stream !== 'function') return null
    // 1. 优先跟随当前会话正在用的模型：主人在界面上选的，走的是账号通道，肯定有额度。
    //    自己按名字猜很容易挑到带失效 API key 的 provider（踩过：Authentication Fails）。
    const fromSession = readSessionModel()
    if (fromSession) {
      try {
        const ps = llm.listProviders() ?? []
        if (Array.isArray(ps) && ps.some((p) => String(p?.id ?? '') === fromSession.provider)) {
          return fromSession
        }
      } catch { /* 继续回退 */ }
    }
    // 2. 回退：自己挑一个
    return pickModelFromLlm(llm)
  }

  async function analyze(text, score) {
    const target = await pickModel()
    if (!target) return { ok: false, reason: '没有可用的模型通道' }
    let out = ''
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 45000)
    if (typeof timer?.unref === 'function') timer.unref()
    try {
      const stream = llm.stream({
        provider: target.provider,
        model: target.model,
        system: ANALYSIS_SYSTEM,
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: '星级：' + score + '/5\n\n回复全文：\n' + text.slice(0, 4000) }],
        }],
        temperature: 0.3,
        maxTokens: 700,
        signal: controller.signal,
      })
      for await (const chunk of stream) {
        if (chunk === null || chunk === undefined) continue
        if (chunk.type === 'text-delta') out += String(chunk.text ?? '')
        else if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
          const f = chunk.reason.failure ?? {}
          return { ok: false, reason: '模型返回错误：' + String(f.message ?? f.code ?? JSON.stringify(chunk.reason)).slice(0, 300) }
        }
      }
    } catch (error) {
      return { ok: false, reason: '请求失败：' + String(error?.message ?? error) }
    } finally {
      clearTimeout(timer)
    }
    const list = extractJsonArray(out)
    if (!list || !list.length) return { ok: false, reason: '模型输出无法解析', raw: out.slice(0, 300) }
    return { ok: true, suggestions: list, model: target.model }
  }

  ctx.inject(['webServer'], (webCtx) => {
    const server = webCtx?.webServer
    if (!server) return

    const route = (p, handler) => {
      try {
        ctx.effect(() => server.register({ kind: 'exact', path: PREFIX + p, handler }), 'star.route' + p)
      } catch (error) {
        ctx.logger?.warn?.('star: 路由注册失败 ' + p + ' ' + String(error?.message ?? error))
      }
    }

    const bodyOf = (req) => new Promise((resolve) => {
      readBody(req).then((raw) => {
        try { resolve(JSON.parse(raw || '{}')) } catch { resolve({}) }
      })
    })

    route('/state', (req, res) => {
      if (!isLocal(req)) return sendJson(res, { ok: false, reason: 'local only' }, 403)
      try {
        const url = new URL(req.url, 'http://127.0.0.1')
        const messageId = String(url.searchParams.get('messageId') || '')
        const rows = readAll()
        const hit = messageId ? rows.find((r) => String(r.messageId) === messageId) : null
        sendJson(res, {
          ok: true,
          score: hit ? Number(hit.score) : 0,
          summary: summarize(rows),
          hasModel: Boolean(llm),
        })
      } catch (error) {
        sendJson(res, { ok: false, reason: String(error?.message ?? error) }, 500)
      }
    })

    route('/rate', async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, { ok: false, reason: 'POST only' }, 405)
      if (!isLocal(req)) return sendJson(res, { ok: false, reason: 'local only' }, 403)
      try {
        const body = await bodyOf(req)
        const score = Number(body.score)
        const messageId = String(body.messageId || '')
        if (!messageId) return sendJson(res, { ok: false, reason: '缺少 messageId' }, 400)
        if (!(score >= 1 && score <= 5)) return sendJson(res, { ok: false, reason: '分数必须是 1~5' }, 400)
        const hit = recent.find((r) => r.id === messageId) ?? null
        append({
          ts: nowIso(),
          messageId,
          sessionId: String(body.sessionId || ''),
          score,
          excerpt: hit ? hit.text.slice(0, 400) : String(body.excerpt || '').slice(0, 400),
        })
        const rows = readAll()
        if (rows.length >= 3) {
          try { fs.writeFileSync(REPORT, buildReport(rows), 'utf8') } catch { /* 报告失败不影响评分 */ }
        }
        sendJson(res, { ok: true, score, summary: summarize(rows) })
      } catch (error) {
        sendJson(res, { ok: false, reason: String(error?.message ?? error) }, 400)
      }
    })

    route('/analyze', async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, { ok: false, reason: 'POST only' }, 405)
      if (!isLocal(req)) return sendJson(res, { ok: false, reason: 'local only' }, 403)
      try {
        const body = await bodyOf(req)
        const messageId = String(body.messageId || '')
        const score = Number(body.score) || 0
        let text = ''
        const hit = recent.find((r) => r.id === messageId)
        if (hit) text = hit.text
        if (!text) text = readReplyText(messageId)
        if (!text) return sendJson(res, { ok: false, reason: '拿不到这条回复的内容' }, 404)
        const result = await analyze(text, score)
        sendJson(res, result.ok ? { ok: true, suggestions: result.suggestions, model: result.model } : { ok: false, reason: result.reason, raw: result.raw })
      } catch (error) {
        sendJson(res, { ok: false, reason: String(error?.message ?? error) }, 500)
      }
    })

    route('/apply', async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, { ok: false, reason: 'POST only' }, 405)
      if (!isLocal(req)) return sendJson(res, { ok: false, reason: 'local only' }, 403)
      try {
        const body = await bodyOf(req)
        const picked = Array.isArray(body.picked) ? body.picked : []
        const result = appendRules(picked)
        sendJson(res, result.ok ? { ok: true, count: result.count, added: result.added } : { ok: false, reason: result.reason })
      } catch (error) {
        sendJson(res, { ok: false, reason: String(error?.message ?? error) }, 400)
      }
    })

    route('/debug', async (req, res) => {
      if (!isLocal(req)) return sendJson(res, { ok: false, reason: 'local only' }, 403)
      const info = { ok: true, hasLlm: Boolean(llm), providers: [], picked: null, error: '' }
      try {
        if (llm && typeof llm.listProviders === 'function') {
          const ps = llm.listProviders() ?? []
          for (const p of ps) {
            let models = []
            try { models = ((await llm.listModels(p.id)) ?? []).map((m) => String(m?.id ?? '')) } catch (e) { models = ['<listModels 失败: ' + String(e?.message ?? e) + '>'] }
            info.providers.push({ id: String(p?.id ?? ''), models })
          }
        }
        const target = await pickModel()
        info.picked = target
        if (!target) info.error = '没选出模型'
        else {
          const r = await analyze('测试：这是一条用于诊断的回复。', 3)
          info.probe = r.ok ? { suggestions: r.suggestions } : { error: r.reason, raw: r.raw }
        }
      } catch (e) {
        info.error = String(e?.message ?? e)
      }
      sendJson(res, info)
    })

    route('/report', (req, res) => {
      if (!isLocal(req)) return sendJson(res, { ok: false, reason: 'local only' }, 403)
      try {
        sendJson(res, { ok: true, report: fs.existsSync(REPORT) ? fs.readFileSync(REPORT, 'utf8') : '', summary: summarize(readAll()) })
      } catch (error) {
        sendJson(res, { ok: false, reason: String(error?.message ?? error) }, 500)
      }
    })
  })
}
