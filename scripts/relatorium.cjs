// Builds an HTML report of the time and tokens spent with Claude Code in one project.
// Usage: node relatorium.cjs <project folder> [--no-open]
// Prints one JSON line with the summary; writes the HTML under ~/.claude/relatorium/.
'use strict'
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFileSync, spawn } = require('child_process')

const projectDir = path.resolve(process.argv[2] || process.cwd())
const shouldOpen = !process.argv.includes('--no-open')
const claudeDir = path.join(os.homedir(), '.claude')
const projectsDir = path.join(claudeDir, 'projects')

// Gaps longer than these count as a pause, not work.
const IDLE_GAP_MS = 30 * 60 * 1000
const AGENT_GAP_MS = 10 * 60 * 1000
const WINDOW_MS = 5 * 60 * 60 * 1000 // a Claude usage window

// USD per million tokens. Opus/Sonnet/Haiku 5.5 read off the costs Claude Code records.
const PRICES = [
  [/opus-5/, { in: 4, out: 20, read: 0.2 }],
  [/sonnet-5/, { in: 2, out: 10, read: 0.1 }],
  [/haiku-5/, { in: 0.5, out: 2.5, read: 0.025 }],
  [/fable/, { in: 4, out: 20, read: 0.2 }],
  [/opus-4-[5-9]/, { in: 5, out: 25, read: 0.5 }],
  [/opus/, { in: 15, out: 75, read: 1.5 }],
  [/sonnet/, { in: 3, out: 15, read: 0.3 }],
  [/haiku/, { in: 1, out: 5, read: 0.1 }],
]
const priceOf = model => (PRICES.find(([re]) => re.test(model)) || [null, { in: 4, out: 20, read: 0.2 }])[1]

function costOf(model, u) {
  const p = priceOf(model)
  const w5 = u.cache_creation?.ephemeral_5m_input_tokens
  const w1 = u.cache_creation?.ephemeral_1h_input_tokens
  const write = u.cache_creation_input_tokens || 0
  const writeCost = w5 !== undefined || w1 !== undefined
    ? (w5 || 0) * p.in * 1.25 + (w1 || 0) * p.in * 2
    : write * p.in * 1.25
  return ((u.input_tokens || 0) * p.in + (u.output_tokens || 0) * p.out +
    (u.cache_read_input_tokens || 0) * p.read + writeCost) / 1e6
}

const encode = p => p.replace(/[^A-Za-z0-9]/g, '-')

function projectFolders() {
  const key = encode(projectDir).toLowerCase()
  if (!fs.existsSync(projectsDir)) return []
  return fs.readdirSync(projectsDir).filter(name => {
    const n = name.toLowerCase()
    return n === key || n.startsWith(key + '--claude-worktrees-')
  }).map(name => path.join(projectsDir, name))
}

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n')
  } catch {
    return []
  }
}

function isRealPrompt(row) {
  if (row.type !== 'user' || row.isMeta || row.isSidechain) return false
  const c = row.message?.content
  if (typeof c === 'string') return !c.startsWith('<') || c.startsWith('<command-name>')
  return Array.isArray(c) && c.some(b => b.type === 'text') && !c.some(b => b.type === 'tool_result')
}

function promptText(row) {
  const c = row.message?.content
  const t = typeof c === 'string' ? c : (c || []).filter(b => b.type === 'text').map(b => b.text).join(' ')
  return t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

// ---- read the project's transcripts ----
const sessions = new Map()
const seenMsg = new Set()
const tools = {}
const models = {}
const events = [] // { t, kind: 'prompt' | 'claude', sid }
const usageRows = [] // { t, tokens, cost }

function session(sid) {
  if (!sessions.has(sid)) sessions.set(sid, {
    id: sid, title: '', firstPrompt: '', start: Infinity, end: 0, prompts: 0, calls: 0,
    tokens: 0, output: 0, cost: 0, agents: 0, linesAdded: 0, linesRemoved: 0, times: [],
  })
  return sessions.get(sid)
}

function addUsage(row, s, isAgent) {
  const u = row.message?.usage
  if (!u) return
  const key = row.message.id || row.requestId || row.uuid
  if (seenMsg.has(key)) return
  seenMsg.add(key)
  const model = row.message.model || 'desconhecido'
  if (model === '<synthetic>') return
  const t = Date.parse(row.timestamp)
  const tokens = (u.input_tokens || 0) + (u.output_tokens || 0) +
    (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
  const cost = costOf(model, u)
  const m = models[model] ||= { model, calls: 0, input: 0, output: 0, read: 0, write: 0, cost: 0 }
  m.calls++; m.input += u.input_tokens || 0; m.output += u.output_tokens || 0
  m.read += u.cache_read_input_tokens || 0; m.write += u.cache_creation_input_tokens || 0; m.cost += cost
  s.calls++; s.tokens += tokens; s.output += u.output_tokens || 0; s.cost += cost
  if (!Number.isNaN(t)) usageRows.push({ t, tokens, cost, isAgent })
}

function readSession(file, sid) {
  const s = session(sid)
  for (const line of readLines(file)) {
    if (!line) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (row.type === 'custom-title' && row.customTitle) s.title = row.customTitle
    if (row.type === 'cost-state') {
      s.linesAdded = Math.max(s.linesAdded, row.totalLinesAdded || 0)
      s.linesRemoved = Math.max(s.linesRemoved, row.totalLinesRemoved || 0)
    }
    if (row.type !== 'user' && row.type !== 'assistant') continue
    const t = Date.parse(row.timestamp)
    if (Number.isNaN(t)) continue
    s.start = Math.min(s.start, t); s.end = Math.max(s.end, t); s.times.push(t)
    if (isRealPrompt(row)) {
      s.prompts++
      if (!s.firstPrompt) s.firstPrompt = promptText(row).slice(0, 90)
      events.push({ t, kind: 'prompt', sid })
    } else {
      events.push({ t, kind: 'claude', sid })
    }
    if (row.type === 'assistant') {
      addUsage(row, s, false)
      for (const b of row.message?.content || []) {
        if (b.type === 'tool_use') { const n = b.name.replace(/^mcp__(?:[^_]+_)?/, '').replace(/__/g, ' · '); tools[n] = (tools[n] || 0) + 1 }
      }
    }
  }
  const agentsDir = path.join(path.dirname(file), sid, 'subagents')
  if (fs.existsSync(agentsDir)) {
    for (const name of fs.readdirSync(agentsDir)) {
      if (!name.endsWith('.jsonl')) continue
      s.agents++
      for (const line of readLines(path.join(agentsDir, name))) {
        if (!line.includes('"usage"')) continue
        let row
        try { row = JSON.parse(line) } catch { continue }
        if (row.type === 'assistant') addUsage(row, s, true)
      }
    }
  }
  const titleFile = path.join(path.dirname(file), sid, 'custom-title.json')
  if (!s.title && fs.existsSync(titleFile)) {
    try { s.title = JSON.parse(fs.readFileSync(titleFile, 'utf8')).customTitle || '' } catch {}
  }
}

const folders = projectFolders()
for (const folder of folders) {
  for (const name of fs.readdirSync(folder)) {
    if (name.endsWith('.jsonl')) readSession(path.join(folder, name), name.slice(0, -6))
  }
}
for (const [id, s] of sessions) if (s.calls === 0 && s.prompts === 0) sessions.delete(id)

// ---- usage across every project, for the share ----
let allTokens = 0, allCost = 0
const allSeen = new Set()
function scanAll(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) { if (ent.name !== 'tool-results') scanAll(p); continue }
    if (!ent.name.endsWith('.jsonl')) continue
    for (const line of readLines(p)) {
      if (!line.includes('"usage"') || !line.includes('"assistant"')) continue
      let row
      try { row = JSON.parse(line) } catch { continue }
      const u = row.message?.usage
      if (row.type !== 'assistant' || !u || row.message.model === '<synthetic>') continue
      const key = row.message.id || row.requestId || row.uuid
      if (allSeen.has(key)) continue
      allSeen.add(key)
      allTokens += (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
      allCost += costOf(row.message.model || '', u)
    }
  }
}
try { if (fs.existsSync(projectsDir)) scanAll(projectsDir) } catch {}

// ---- time ----
events.sort((a, b) => a.t - b.t)
const segments = [] // active stretches: [start, end]
let activeMs = 0, agentMs = 0
for (let i = 0; i < events.length; i++) {
  const e = events[i]
  const last = segments[segments.length - 1]
  if (!last || e.t - last[1] > IDLE_GAP_MS) segments.push([e.t, e.t])
  else { activeMs += e.t - last[1]; last[1] = e.t }
  if (i > 0 && e.kind === 'claude' && e.t - events[i - 1].t <= AGENT_GAP_MS) agentMs += e.t - events[i - 1].t
}
// a short stretch still took some minutes
activeMs += segments.filter(([a, b]) => b - a < 60000).length * 2 * 60000

const first = events[0]?.t, last = events[events.length - 1]?.t

// Claude usage windows: one opens at a message and lasts 5 h.
const windows = []
for (const r of [...usageRows].sort((a, b) => a.t - b.t)) {
  const w = windows[windows.length - 1]
  if (!w || r.t >= w.start + WINDOW_MS) windows.push({ start: r.t, tokens: r.tokens, cost: r.cost })
  else { w.tokens += r.tokens; w.cost += r.cost }
}

// ---- per day ----
const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const days = {}
const day = k => (days[k] ||= { day: k, activeMs: 0, tokens: 0, cost: 0, prompts: 0 })
for (const [a, b] of segments) {
  // split a stretch at midnight
  let s = a
  while (s < b) {
    const d = new Date(s); const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
    const e = Math.min(b, midnight); day(dayKey(s)).activeMs += e - s; s = e
  }
  if (b - a < 60000) day(dayKey(a)).activeMs += 2 * 60000
}
for (const r of usageRows) { const d = day(dayKey(r.t)); d.tokens += r.tokens; d.cost += r.cost }
for (const e of events) if (e.kind === 'prompt') day(dayKey(e.t)).prompts++
const dayList = Object.values(days).sort((a, b) => a.day.localeCompare(b.day))
const hours = Array(24).fill(0)
for (const e of events) if (e.kind === 'prompt') hours[new Date(e.t).getHours()]++

// ---- git ----
let commits = null
try {
  const since = first ? new Date(first).toISOString() : undefined
  const args = ['-C', projectDir, 'rev-list', '--count', 'HEAD']
  if (since) args.push(`--since=${since}`)
  commits = Number(execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim())
} catch {}

// ---- totals ----
const sessionList = [...sessions.values()].sort((a, b) => a.start - b.start)
const sum = (list, f) => list.reduce((n, x) => n + f(x), 0)
const modelList = Object.values(models).sort((a, b) => b.cost - a.cost)
const totals = {
  tokens: sum(modelList, m => m.input + m.output + m.read + m.write),
  input: sum(modelList, m => m.input), output: sum(modelList, m => m.output),
  read: sum(modelList, m => m.read), write: sum(modelList, m => m.write),
  cost: sum(modelList, m => m.cost), calls: sum(modelList, m => m.calls),
  agentCost: sum(usageRows.filter(r => r.isAgent), r => r.cost),
  prompts: sum(sessionList, s => s.prompts), agents: sum(sessionList, s => s.agents),
  linesAdded: sum(sessionList, s => s.linesAdded), linesRemoved: sum(sessionList, s => s.linesRemoved),
}

// ---- formatting ----
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const fmtN = n => n >= 1e9 ? (n / 1e9).toFixed(2).replace('.', ',') + ' B' : n >= 1e6 ? (n / 1e6).toFixed(1).replace('.', ',') + ' M' : n >= 1e3 ? (n / 1e3).toFixed(1).replace('.', ',') + ' mil' : String(Math.round(n))
const fmtInt = n => Math.round(n).toLocaleString('pt-BR')
const fmtUSD = n => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtH = ms => { const m = Math.round(ms / 60000); const h = Math.floor(m / 60); return h ? `${h} h ${String(m % 60).padStart(2, '0')} min` : `${m} min` }
const fmtDate = t => new Date(t).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
const fmtDay = k => { const [y, m, d] = k.split('-'); return `${d}/${m}` }
const pct = (a, b) => b ? (a / b * 100).toFixed(1).replace('.', ',') + ' %' : '—'
const projectName = path.basename(projectDir)
const cacheShare = totals.tokens ? totals.read / totals.tokens : 0

function card(big, label, accent) {
  return `<div class="card${accent ? ' accent' : ''}"><div class="big">${big}</div><div class="label">${label}</div></div>`
}

function timelineSvg() {
  if (!first || last === first) return '<p class="muted">Pouca atividade para desenhar a linha do tempo.</p>'
  const W = 1000, H = 64, span = last - first, x = t => ((t - first) / span) * W
  let out = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="tl"><defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="var(--idle-bg)"/><line x1="0" y1="0" x2="0" y2="6" stroke="var(--idle)" stroke-width="2.5"/></pattern></defs>`
  out += `<rect x="0" y="20" width="${W}" height="24" fill="url(#hatch)" rx="3"/>`
  for (const [a, b] of segments) {
    const w = Math.max(2, x(b) - x(a))
    out += `<rect x="${x(a).toFixed(2)}" y="20" width="${w.toFixed(2)}" height="24" fill="var(--blue)"><title>${esc(fmtDate(a))} → ${esc(fmtDate(b))} · ${esc(fmtH(b - a))}</title></rect>`
  }
  // session starts
  for (const s of sessionList) {
    const sx = x(s.start).toFixed(2)
    out += `<line x1="${sx}" x2="${sx}" y1="12" y2="52" stroke="var(--fg)" stroke-width="1.2" opacity=".75"><title>${esc(s.title || s.firstPrompt || s.id)} · ${esc(fmtDate(s.start))}</title></line>`
  }
  out += '</svg>'
  const ticks = []
  const n = Math.min(6, Math.max(2, dayList.length))
  for (let i = 0; i < n; i++) { const t = first + span * i / (n - 1); ticks.push(`<span style="left:${(i / (n - 1) * 100).toFixed(2)}%">${esc(fmtDate(t))}</span>`) }
  return out + `<div class="ticks">${ticks.join('')}</div>`
}

function barChart(list, value, label, color, fmt) {
  if (!list.length) return '<p class="muted">Sem dados.</p>'
  const max = Math.max(...list.map(value)) || 1
  return `<div class="bars">${list.map(d => {
    const v = value(d)
    return `<div class="bar" title="${esc(label(d))}: ${esc(fmt(v))}"><div class="fill" style="height:${(v / max * 100).toFixed(1)}%;background:${color}"></div><div class="blabel">${esc(label(d))}</div></div>`
  }).join('')}</div>`
}

function hBars(rows, total) {
  const max = Math.max(...rows.map(r => r[1]), 1)
  return rows.map(([name, v, note]) => `<div class="hrow"><span class="hname">${esc(name)}</span><span class="htrack"><span class="hfill" style="width:${(v / max * 100).toFixed(1)}%"></span></span><span class="hval">${esc(note ?? fmtInt(v))}</span></div>`).join('')
}

const toolRows = Object.entries(tools).sort((a, b) => b[1] - a[1]).slice(0, 10)
const tokenRows = [
  ['Lidos do cache', totals.read, fmtN(totals.read)],
  ['Gravados no cache', totals.write, fmtN(totals.write)],
  ['Saída (respostas)', totals.output, fmtN(totals.output)],
  ['Entrada nova', totals.input, fmtN(totals.input)],
]
const generated = new Date()

const html = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Relatorium · ${esc(projectName)}</title>
<style>
:root{--bg:#0e0f12;--panel:#16181d;--panel2:#1c1f26;--line:#2a2e37;--fg:#eceef2;--muted:#8b90a0;--blue:#3b82f6;--violet:#a78bfa;--green:#34d399;--amber:#fbbf24;--idle:#3a3f4b;--idle-bg:#20232b}
*{box-sizing:border-box}html{color-scheme:dark}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1100px;margin:0 auto;padding:40px 20px 60px}
h1{font-size:34px;margin:0 0 4px;letter-spacing:-.02em}h2{font-size:22px;margin:40px 0 14px;letter-spacing:-.01em}
.eyebrow{color:var(--blue);font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;margin-bottom:6px}.sub{color:var(--muted);font-size:13px}.muted{color:var(--muted)}
.hero{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:22px 24px;margin-top:24px}
.hero .k{color:var(--muted);font-size:14px}.hero .v{font-size:64px;font-weight:700;letter-spacing:-.03em;line-height:1.1;margin:6px 0}
.hero p{margin:0;color:var(--muted);font-size:14px;max-width:820px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px;min-height:96px}
.card .big{font-size:23px;line-height:1.25;font-weight:700;letter-spacing:-.02em}.card .label{color:var(--muted);font-size:13px;margin-top:4px}
.card.accent .big{color:var(--blue)}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px}
.tl{width:100%;height:64px;display:block}.ticks{position:relative;height:18px;font-size:11px;color:var(--muted);margin:0 40px 0 0}
.ticks span{position:absolute;transform:translateX(-50%);white-space:nowrap}.ticks span:first-child{transform:none}.ticks span:last-child{transform:translateX(-100%)}
.legend{font-size:12px;color:var(--muted);margin-top:10px}.sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin:0 4px 0 10px;vertical-align:-1px}
.two{display:grid;grid-template-columns:1fr 1fr;gap:12px}.two>*{min-width:0}@media (max-width:760px){.two{grid-template-columns:1fr}.hero .v{font-size:46px}}
.bars{display:flex;align-items:flex-end;gap:4px;height:170px;padding-top:6px}
.bar{flex:1;display:flex;flex-direction:column;justify-content:flex-end;height:100%;min-width:0}
.fill{border-radius:4px 4px 0 0;min-height:2px}.blabel{font-size:10px;color:var(--muted);text-align:center;margin-top:4px;white-space:nowrap;overflow:hidden}
.hrow{display:grid;grid-template-columns:minmax(80px,190px) 1fr auto;gap:10px;align-items:center;font-size:13px;margin:7px 0}
.hname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.htrack{background:var(--panel2);border-radius:4px;height:10px;overflow:hidden}
.hfill{display:block;height:100%;background:var(--violet);border-radius:4px}.hval{text-align:right;color:var(--muted);font-variant-numeric:tabular-nums}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:9px 10px;border-bottom:1px solid var(--line);text-align:left}
th{color:var(--muted);font-weight:500}td.n{text-align:right;font-variant-numeric:tabular-nums}.scroll{overflow-x:auto}
.share{height:12px;background:var(--panel2);border-radius:6px;overflow:hidden;margin:10px 0 6px}.share i{display:block;height:100%;background:var(--green)}
footer{margin-top:40px;color:var(--muted);font-size:12px}
</style></head><body><main>
<div class="eyebrow">Relatorium</div>
<h1>${esc(projectName)} · os números</h1>
<div class="sub">${first ? esc(fmtDate(first)) + ' → ' + esc(fmtDate(last)) : 'sem atividade'} · ${esc(projectDir)} · gerado em ${esc(generated.toLocaleString('pt-BR'))}</div>

<div class="hero"><div class="k">Tempo trabalhado no projeto</div><div class="v">≈ ${esc(fmtH(activeMs))}</div>
<p>Somando só os trechos com atividade (pausas acima de ${IDLE_GAP_MS / 60000} min não contam), em ${sessionList.length} sessões do Claude ao longo de ${dayList.length} dias. O Claude esteve trabalhando por ${esc(fmtH(agentMs))} desse tempo, e o projeto custaria cerca de <b>${esc(fmtUSD(totals.cost))}</b> se fosse pago pela API.</p></div>

<h2>A linha do tempo</h2>
<div class="panel">${timelineSvg()}
<div class="legend"><span class="sw" style="background:var(--blue)"></span>trabalhando<span class="sw" style="background:var(--idle)"></span>parado<span class="sw" style="background:var(--fg);width:2px"></span>início de uma sessão · passe o mouse para ver detalhes</div></div>

<div class="grid" style="margin-top:12px">
${card('≈ ' + esc(fmtH(activeMs)), 'tempo ativo no projeto', true)}
${card(esc(fmtH(agentMs)), 'com o Claude trabalhando')}
${card(first ? esc(fmtH(last - first)) : '—', 'do primeiro ao último uso')}
${card(String(sessionList.length), 'sessões do Claude')}
${card(fmtInt(totals.prompts), 'mensagens suas')}
${card(String(windows.length), 'janelas de uso de 5 h tocadas')}
${card(fmtInt(totals.agents), 'subagentes executados')}
${commits !== null ? card(fmtInt(commits), 'commits no período') : ''}
${totals.linesAdded ? card('+' + fmtInt(totals.linesAdded), `linhas escritas (−${fmtInt(totals.linesRemoved)})`) : ''}
</div>

<h2>Tokens e custo</h2>
<div class="grid">
${card('≈ ' + esc(fmtN(totals.tokens)), 'tokens no total', true)}
${card(esc(pct(totals.read, totals.tokens)), 'lidos do cache: o Claude relê o contexto a cada passo')}
${card(fmtInt(totals.calls), 'chamadas à API')}
${card(esc(fmtN(totals.output)), 'tokens de saída')}
${card('≈ ' + esc(fmtUSD(totals.cost)), 'custo equivalente na API (no plano, conta como uso)', true)}
${card('≈ ' + esc(fmtUSD(totals.agentCost)), 'disso gasto por subagentes')}
${card(totals.cost && sessionList.length ? '≈ ' + esc(fmtUSD(totals.cost / sessionList.length)) : '—', 'por sessão, em média')}
${card(activeMs ? '≈ ' + esc(fmtUSD(totals.cost / (activeMs / 3600000))) : '—', 'por hora de trabalho')}
</div>

<div class="panel" style="margin-top:12px">
<div class="muted" style="font-size:13px">Fatia deste projeto em todo o seu uso do Claude Code (todas as pastas)</div>
<div class="share"><i style="width:${allTokens ? Math.min(100, totals.tokens / allTokens * 100).toFixed(1) : 0}%"></i></div>
<div style="font-size:13px"><b>${esc(pct(totals.tokens, allTokens))}</b> dos tokens · ${esc(fmtUSD(totals.cost))} de ${esc(fmtUSD(allCost))} no total</div>
</div>

<h2>Dia a dia</h2>
<div class="two">
<div class="panel"><div class="muted" style="font-size:13px;margin-bottom:6px">Horas ativas por dia</div>${barChart(dayList, d => d.activeMs, d => fmtDay(d.day), 'var(--blue)', fmtH)}</div>
<div class="panel"><div class="muted" style="font-size:13px;margin-bottom:6px">Custo equivalente por dia</div>${barChart(dayList, d => d.cost, d => fmtDay(d.day), 'var(--amber)', fmtUSD)}</div>
</div>
<div class="two" style="margin-top:12px">
<div class="panel"><div class="muted" style="font-size:13px;margin-bottom:6px">A que horas você manda mensagens</div>${barChart(hours.map((v, h) => ({ h, v })), d => d.v, d => (d.h % 3 ? '' : d.h + 'h'), 'var(--violet)', v => v + ' mensagens')}</div>
<div class="panel"><div class="muted" style="font-size:13px;margin-bottom:10px">Para onde foram os tokens</div>${hBars(tokenRows)}
<div class="muted" style="font-size:13px;margin:16px 0 4px">Por modelo</div>${hBars(modelList.map(m => [m.model.replace(/^claude-/, ''), m.cost, fmtUSD(m.cost)]))}</div>
</div>

${toolRows.length ? `<h2>Ferramentas mais usadas</h2><div class="panel">${hBars(toolRows)}</div>` : ''}

<h2>As sessões</h2>
<div class="panel scroll"><table><thead><tr><th>Início</th><th>Sessão</th><th class="n">Duração</th><th class="n">Mensagens</th><th class="n">Tokens</th><th class="n">Custo</th></tr></thead><tbody>
${[...sessionList].reverse().map(s => {
  let ms = 0
  const ts = s.times.sort((a, b) => a - b)
  for (let i = 1; i < ts.length; i++) { const g = ts[i] - ts[i - 1]; if (g <= IDLE_GAP_MS) ms += g }
  return `<tr><td>${esc(fmtDate(s.start))}</td><td>${esc(s.title || s.firstPrompt || s.id.slice(0, 8))}</td><td class="n">${esc(fmtH(ms))}</td><td class="n">${s.prompts}</td><td class="n">${esc(fmtN(s.tokens))}</td><td class="n">${esc(fmtUSD(s.cost))}</td></tr>`
}).join('')}
</tbody></table></div>

<footer><b>Relatorium</b> · calculado a partir dos históricos que o Claude Code guarda em ~/.claude/projects (${folders.length} pasta${folders.length === 1 ? '' : 's'}). Custos são estimativas pelo preço da API; numa assinatura eles contam como uso do limite, não como cobrança. Janela de uso = 5 h a partir da primeira mensagem.</footer>
</main></body></html>`

const outDir = path.join(claudeDir, 'relatorium')
fs.mkdirSync(outDir, { recursive: true })
const outFile = path.join(outDir, `${encode(projectName)}.html`)
fs.writeFileSync(outFile, html)

if (shouldOpen) {
  try {
    const opener = process.platform === 'win32' ? 'explorer.exe'
      : process.platform === 'darwin' ? 'open' : 'xdg-open'
    spawn(opener, [outFile], { detached: true, stdio: 'ignore' }).unref()
  } catch {}
}

process.stdout.write(JSON.stringify({
  file: outFile, project: projectName, sessions: sessionList.length, days: dayList.length,
  active: fmtH(activeMs), agent: fmtH(agentMs), tokens: fmtN(totals.tokens), cost: fmtUSD(totals.cost),
  windows: windows.length, share: pct(totals.tokens, allTokens), prompts: totals.prompts,
}) + '\n')
