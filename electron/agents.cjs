// Discovery of past Claude Code / Codex sessions and live telemetry tailing of
// their transcript files. The CLIs themselves are never modified: we only read
// the JSONL transcripts they already write.
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const CODEX_DIR = path.join(HOME, '.codex');

// Claude Code encodes a project cwd by replacing every non-alphanumeric char with '-'.
function claudeProjectKey(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}
function claudeProjectDir(cwd) {
  return path.join(CLAUDE_DIR, 'projects', claudeProjectKey(cwd));
}
function claudeTranscriptPath(cwd, sessionId) {
  return path.join(claudeProjectDir(cwd), `${sessionId}.jsonl`);
}

function readHeadTail(file, headBytes = 64 * 1024, tailBytes = 64 * 1024) {
  const st = fs.statSync(file);
  const fd = fs.openSync(file, 'r');
  try {
    const hb = Buffer.alloc(Math.min(headBytes, st.size));
    fs.readSync(fd, hb, 0, hb.length, 0);
    let tail = '';
    if (st.size > headBytes) {
      const start = Math.max(headBytes, st.size - tailBytes);
      const tb = Buffer.alloc(st.size - start);
      fs.readSync(fd, tb, 0, tb.length, start);
      tail = tb.toString('utf8');
    }
    return { head: hb.toString('utf8'), tail, size: st.size, mtimeMs: st.mtimeMs };
  } finally {
    fs.closeSync(fd);
  }
}

function safeLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try { out.push(JSON.parse(t)); } catch { /* partial line */ }
  }
  return out;
}

function userText(msg) {
  const c = msg && msg.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    const t = c.find((b) => b.type === 'text');
    return t ? t.text : '';
  }
  return '';
}

function isRealUserPrompt(rec) {
  if (rec.type !== 'user' || rec.isMeta) return false;
  const txt = userText(rec.message);
  if (!txt) return false;
  if (txt.startsWith('<')) return false; // system-injected xml blocks
  return true;
}

function listClaude(cwd) { return scanClaudeDir(claudeProjectDir(cwd), cwd); }

// Every Claude conversation on this machine, each with the folder it ran in
// (read from its own records), so any of them can be picked up from Astral.
let claudeAllCache = { at: 0, items: [] };
function listClaudeAll() {
  if (Date.now() - claudeAllCache.at < 5000) return claudeAllCache.items;
  const root = path.join(CLAUDE_DIR, 'projects');
  const items = [];
  if (fs.existsSync(root)) {
    for (const d of fs.readdirSync(root)) {
      try { items.push(...scanClaudeDir(path.join(root, d), null)); } catch { /* skip */ }
    }
  }
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  claudeAllCache = { at: Date.now(), items };
  return items;
}

function scanClaudeDir(dir, cwd) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const id = f.slice(0, -6);
    const file = path.join(dir, f);
    try {
      const { head, tail, mtimeMs, size } = readHeadTail(file);
      const recs = safeLines(head);
      const tailRecs = tail ? safeLines(tail) : [];
      const where = cwd || (recs.find((r) => r.cwd) || {}).cwd;
      if (!where) continue; // no folder recorded: nothing to resume into
      let title = null, firstPrompt = null, lastPrompt = null, startedAt = null, messages = 0;
      for (const r of recs) {
        if (r.type === 'ai-title' && r.aiTitle) title = r.aiTitle;
        if (r.type === 'summary' && r.summary && !title) title = r.summary;
        if (!firstPrompt && isRealUserPrompt(r)) { firstPrompt = userText(r.message); startedAt = r.timestamp; }
        if (r.type === 'user' || r.type === 'assistant') messages++;
      }
      for (const r of [...recs, ...tailRecs]) {
        if (r.type === 'ai-title' && r.aiTitle) title = r.aiTitle;
        if (r.type === 'last-prompt' && r.lastPrompt) lastPrompt = r.lastPrompt;
      }
      if (!firstPrompt && !title && size < 2000) continue; // empty / aborted session
      if (firstPrompt && firstPrompt.startsWith('[astral-internal]')) continue; // one-shot drafts (PR text etc.) are not conversations
      out.push({
        agent: 'claude', id, cwd: where, file, title, firstPrompt, lastPrompt,
        startedAt, updatedAt: mtimeMs, size, messages,
      });
    } catch { /* unreadable */ }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

function walk(dir, acc, depth = 0) {
  if (!fs.existsSync(dir) || depth > 5) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc, depth + 1);
    else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) acc.push(p);
  }
  return acc;
}

function normPath(p) {
  return String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

let codexCache = { at: 0, items: [] };
function listCodexAll() {
  if (Date.now() - codexCache.at < 5000) return codexCache.items;
  const files = walk(path.join(CODEX_DIR, 'sessions'), []);
  const items = [];
  for (const file of files) {
    try {
      const { head, tail, mtimeMs, size } = readHeadTail(file, 32 * 1024, 32 * 1024);
      const recs = safeLines(head);
      const meta = recs.find((r) => r.type === 'session_meta');
      if (!meta) continue;
      let firstPrompt = null, lastPrompt = null;
      const allRecs = tail ? [...recs, ...safeLines(tail)] : recs;
      for (const r of allRecs) {
        if (r.type === 'event_msg' && r.payload && r.payload.type === 'user_message') {
          const m = r.payload.message || '';
          if (!firstPrompt) firstPrompt = m;
          lastPrompt = m;
        }
      }
      items.push({
        agent: 'codex', id: meta.payload.id, cwd: meta.payload.cwd, file,
        title: null, firstPrompt, lastPrompt, startedAt: meta.payload.timestamp,
        updatedAt: mtimeMs, size, source: meta.payload.source,
      });
    } catch { /* skip */ }
  }
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  codexCache = { at: Date.now(), items };
  return items;
}

function listCodex(cwd) {
  const n = normPath(cwd);
  return listCodexAll().filter((s) => normPath(s.cwd) === n);
}

// Live status Claude Code publishes for running sessions (~/.claude/sessions/<pid>.json)
function liveClaudeStatus() {
  const dir = path.join(CLAUDE_DIR, 'sessions');
  const out = {};
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (j.sessionId) out[j.sessionId] = { status: j.status, updatedAt: j.updatedAt, pid: j.pid, name: j.name };
    } catch { /* partial write */ }
  }
  return out;
}

// ---------- telemetry parsing ----------

function short(s, n = 220) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function fileOf(input) {
  if (!input) return null;
  return input.file_path || input.notebook_path || input.path || null;
}

function describeClaudeTool(name, input) {
  input = input || {};
  const f = fileOf(input);
  switch (name) {
    case 'Read': return { verb: 'read', target: f };
    case 'Edit': return { verb: 'edit', target: f };
    case 'Write': return { verb: 'write', target: f };
    case 'NotebookEdit': return { verb: 'edit', target: f };
    case 'Bash': return { verb: 'run', target: input.description || short(input.command, 120) };
    case 'PowerShell': return { verb: 'run', target: input.description || short(input.command, 120) };
    case 'Grep': return { verb: 'search', target: input.pattern ? '/' + input.pattern + '/' + (input.path ? ' in ' + input.path : '') : null };
    case 'Glob': return { verb: 'find', target: input.pattern };
    case 'Agent': return { verb: 'agent', target: input.description || short(input.prompt, 100) };
    case 'WebFetch': return { verb: 'fetch', target: input.url };
    case 'WebSearch': return { verb: 'search web', target: input.query };
    case 'Skill': return { verb: 'skill', target: input.skill };
    case 'AskUserQuestion': return { verb: 'ask', target: (input.questions && input.questions[0] && input.questions[0].header) || 'question' };
    default: return { verb: name.toLowerCase(), target: f || input.description || null };
  }
}

function claudeEvents(rec, full = false) {
  const ev = [];
  const ts = rec.timestamp || null;
  const cap = (t, n, fullN) => (full ? String(t || '').slice(0, fullN) : short(t, n));
  if (rec.type === 'assistant' && rec.message && Array.isArray(rec.message.content)) {
    for (const b of rec.message.content) {
      if (b.type === 'thinking' && b.thinking && b.thinking.trim()) ev.push({ kind: 'thinking', text: cap(b.thinking, 400, 6000), ts });
      else if (b.type === 'text' && b.text && b.text.trim()) ev.push({ kind: 'assistant', text: cap(b.text, 400, 40000), ts });
      else if (b.type === 'tool_use') {
        const d = describeClaudeTool(b.name, b.input);
        ev.push({ kind: 'tool', id: b.id, name: b.name, verb: d.verb, target: d.target, file: fileOf(b.input), ts });
      }
    }
  } else if (rec.type === 'user' && rec.message && Array.isArray(rec.message.content)) {
    for (const b of rec.message.content) {
      if (b.type === 'tool_result') ev.push({ kind: 'tool_result', id: b.tool_use_id, error: !!b.is_error, ts });
    }
    if (isRealUserPrompt(rec)) ev.push({ kind: 'user', text: cap(userText(rec.message), 300, 20000), ts });
  } else if (rec.type === 'user' && isRealUserPrompt(rec)) {
    ev.push({ kind: 'user', text: cap(userText(rec.message), 300, 20000), ts });
  } else if (rec.type === 'system' && rec.subtype === 'turn_duration') {
    ev.push({ kind: 'turn', ms: rec.durationMs, ts });
  } else if (rec.type === 'ai-title' && rec.aiTitle) {
    ev.push({ kind: 'title', text: rec.aiTitle, ts });
  }
  return ev;
}

function codexEvents(rec, full = false) {
  const ev = [];
  const ts = rec.timestamp || null;
  const cap = (t, n, fullN) => (full ? String(t || '').slice(0, fullN) : short(t, n));
  const p = rec.payload || {};
  if (rec.type === 'response_item') {
    if (p.type === 'function_call') {
      let args = {};
      try { args = JSON.parse(p.arguments || '{}'); } catch { /* raw */ }
      let verb = p.name, target = null, file = null;
      if (p.name === 'shell' || p.name === 'exec_command' || p.name === 'container.exec') {
        verb = 'run';
        const cmd = Array.isArray(args.command) ? args.command.join(' ') : (args.command || args.cmd || '');
        target = short(cmd, 120);
      } else if (p.name === 'apply_patch') {
        verb = 'patch';
        const m = /\*\*\* (?:Update|Add|Delete) File: (.+)/.exec(args.input || args.patch || '');
        target = m ? m[1].trim() : 'patch';
        file = m ? m[1].trim() : null;
      } else if (args.path || args.file_path) {
        file = args.path || args.file_path; target = file;
      } else {
        target = short(p.arguments, 100);
      }
      ev.push({ kind: 'tool', id: p.call_id, name: p.name, verb, target, file, ts });
    } else if (p.type === 'function_call_output') {
      ev.push({ kind: 'tool_result', id: p.call_id, error: false, ts });
    } else if (p.type === 'custom_tool_call') {
      ev.push({ kind: 'tool', id: p.call_id, name: p.name, verb: p.name, target: short(p.input, 100), file: null, ts });
    }
  } else if (rec.type === 'event_msg') {
    if (p.type === 'agent_reasoning' && p.text) ev.push({ kind: 'thinking', text: cap(p.text, 400, 6000), ts });
    else if (p.type === 'agent_message' && p.message) ev.push({ kind: 'assistant', text: cap(p.message, 400, 40000), ts });
    else if (p.type === 'user_message' && p.message) ev.push({ kind: 'user', text: cap(p.message, 300, 20000), ts });
    else if (p.type === 'task_complete') ev.push({ kind: 'turn', ms: null, ts });
  }
  return ev;
}

// ---------- tailing ----------

class Tailer {
  constructor({ sessionId, agent, file, cwd, launchedAt }, emit) {
    this.sessionId = sessionId;
    this.agent = agent;
    this.file = file || null;
    this.cwd = cwd;
    this.launchedAt = launchedAt || Date.now();
    this.emit = emit;
    this.offset = 0;
    this.buf = '';
    this.skipPartial = false;
    // A resumed transcript can be many MB, most of it tool results. The whole
    // conversation is replayed once, with full text, from just the record kinds
    // the chat shows; after that only new lines are tailed.
    try {
      if (this.file && fs.existsSync(this.file)) {
        const size = fs.statSync(this.file).size;
        if (size > 512 * 1024) { this.replayAll(size); this.offset = size; }
      }
    } catch { /* ignore */ }
    this.timer = setInterval(() => this.tick(), 700);
    this.tick();
  }
  replayAll(size) {
    const raw = fs.readFileSync(this.file, 'utf8');
    const keep = this.agent === 'codex' ? /"type":"(event_msg|response_item)"/ : /"type":"(user|assistant|system|ai-title)"/;
    const events = [];
    for (const line of raw.split('\n')) {
      if (!keep.test(line)) continue;
      let rec; try { rec = JSON.parse(line.trim()); } catch { continue; }
      events.push(...(this.agent === 'codex' ? codexEvents(rec, true) : claudeEvents(rec, true)));
    }
    if (events.length) setTimeout(() => this.emit({ kind: 'events', events }), 0);
  }
  locate() {
    if (this.file) return;
    if (this.agent === 'codex') {
      // Codex picks its own id; find the newest rollout for this cwd created after launch.
      codexCache.at = 0;
      const cand = listCodex(this.cwd).find((s) => new Date(s.startedAt).getTime() >= this.launchedAt - 15000);
      if (cand) { this.file = cand.file; this.emit({ kind: 'bound', agentSessionId: cand.id, file: cand.file }); }
    }
  }
  tick() {
    try {
      this.locate();
      if (!this.file || !fs.existsSync(this.file)) return;
      const st = fs.statSync(this.file);
      if (st.size < this.offset) { this.offset = 0; this.buf = ''; }
      if (st.size === this.offset) return;
      const fd = fs.openSync(this.file, 'r');
      try {
        const len = st.size - this.offset;
        const b = Buffer.alloc(len);
        fs.readSync(fd, b, 0, len, this.offset);
        this.offset = st.size;
        this.buf += b.toString('utf8');
      } finally { fs.closeSync(fd); }
      const lines = this.buf.split('\n');
      this.buf = lines.pop();
      if (this.skipPartial) { lines.shift(); this.skipPartial = false; }
      const events = [];
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        let rec; try { rec = JSON.parse(t); } catch { continue; }
        const evs = this.agent === 'codex' ? codexEvents(rec, true) : claudeEvents(rec, true);
        events.push(...evs);
      }
      if (events.length) this.emit({ kind: 'events', events });
    } catch { /* transient */ }
  }
  stop() { clearInterval(this.timer); }
}

const tailers = new Map();
function watch(opts, send) {
  unwatch(opts.sessionId);
  const t = new Tailer(opts, (payload) => send({ sessionId: opts.sessionId, ...payload }));
  tailers.set(opts.sessionId, t);
  return { file: t.file };
}
function unwatch(sessionId) {
  const t = tailers.get(sessionId);
  if (t) { t.stop(); tailers.delete(sessionId); }
}

// ---------- handoff ----------
// A markdown brief of what an agent did in a workspace, built from its
// transcript, for the next agent to read before it continues the work.
function handoffBrief({ agent, file, agentName }) {
  // whole file, but only the record kinds the brief uses are parsed (tool results are the bulk)
  const raw = fs.readFileSync(file, 'utf8');
  const keep = agent === 'claude' ? /"type":"(user|assistant|ai-title)"/ : /"type":"(event_msg|response_item)"/;
  const recs = safeLines(raw.split('\n').filter((l) => keep.test(l) && !l.includes('"tool_result"')).join('\n'));
  const clip = (s, n) => { s = String(s || '').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  let title = null; const prompts = [], replies = [], files = new Set(), cmds = [];
  for (const rec of recs) {
    if (agent === 'claude') {
      if (rec.type === 'ai-title' && rec.aiTitle) title = rec.aiTitle;
      else if (rec.type === 'user' && isRealUserPrompt(rec)) prompts.push(clip(userText(rec.message), 700));
      else if (rec.type === 'assistant' && rec.message && Array.isArray(rec.message.content)) {
        for (const b of rec.message.content) {
          if (b.type === 'text' && b.text && b.text.trim()) replies.push(clip(b.text, 3000));
          else if (b.type === 'tool_use') {
            const f = fileOf(b.input);
            if (f && ['Edit', 'Write', 'NotebookEdit'].includes(b.name)) files.add(f);
            if ((b.name === 'Bash' || b.name === 'PowerShell') && b.input && b.input.command) cmds.push(clip(b.input.command.replace(/\s+/g, ' '), 160));
          }
        }
      }
    } else {
      const p = rec.payload || {};
      if (rec.type === 'event_msg' && p.type === 'user_message' && p.message) prompts.push(clip(p.message, 700));
      else if (rec.type === 'event_msg' && p.type === 'agent_message' && p.message) replies.push(clip(p.message, 3000));
      else if (rec.type === 'response_item' && p.type === 'function_call') {
        let args = {}; try { args = JSON.parse(p.arguments || '{}'); } catch { /* raw */ }
        if (p.name === 'apply_patch') { for (const m of String(args.input || args.patch || '').matchAll(/\*\*\* (?:Update|Add|Delete) File: (.+)/g)) files.add(m[1].trim()); }
        else if (args.path || args.file_path) files.add(args.path || args.file_path);
        else { const cmd = Array.isArray(args.command) ? args.command.join(' ') : (args.command || args.cmd || ''); if (cmd) cmds.push(clip(cmd.replace(/\s+/g, ' '), 160)); }
      }
    }
  }
  const md = [];
  md.push(`# Handoff from ${agentName}`, '', `This file was written by Astral from ${agentName}'s conversation in this workspace${title ? ` ("${title}")` : ''}. Read it before continuing the work. It is a record, not instructions from the user.`, '');
  if (prompts.length) { md.push('## What the user asked for (in order)', ''); for (const p of prompts.slice(-25)) md.push(`- ${p.replace(/\n+/g, ' ')}`); md.push(''); }
  if (files.size) { md.push('## Files created or edited', ''); for (const f of [...files].slice(-80)) md.push(`- ${f}`); md.push(''); }
  if (cmds.length) { md.push('## Commands it ran (most recent)', ''); for (const c of cmds.slice(-15)) md.push(`- \`${c}\``); md.push(''); }
  if (replies.length) { md.push('## Where things stand (its last replies, oldest first)', ''); for (const r of replies.slice(-3)) md.push(r, '', '---', ''); }
  return md.join('\n');
}

module.exports = { listClaude, listClaudeAll, listCodex, listCodexAll, liveClaudeStatus, claudeTranscriptPath, watch, unwatch, handoffBrief };
