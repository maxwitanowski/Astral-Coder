// Chat mode: Claude Code runs headless over its own stream-json protocol and
// Astral draws the conversation. Also owns the message queue, per-turn
// checkpoints (a private git tree captured before each turn), todo capture and
// the permission / question cards.
import { state } from './store.js';
import * as S from './store.js';
import { esc, ag, ic, md, toast, bus, modelOf, RUN, basename } from './core.js';
import { I } from './icons.js';
import { WORK } from './spinners.js';

export const isChat = (s) => s.agent === 'claude' && (s.mode || 'chat') === 'chat' && s.kind !== 'install';
export const chatS = (id) => state.chat[id] || (state.chat[id] = { msgs: [], alive: false, working: false, started: false, allow: new Set(), cur: null, hydrating: false, hydrated: false, fileHistory: false, pendingPrompt: null, queue: [], todos: [], lastCheckpoint: null, turnStart: 0 });
const cfg = { termLive: () => false, env: () => ({}), launchFor: (s) => ({ cwd: s.cwd, addDir: null }), effort: () => null, onResult: null, onAttention: null };
export function configure(c) { Object.assign(cfg, c); }
export const isLive = (s) => (isChat(s) ? chatS(s.id).alive : cfg.termLive(s.id));
export const isWorking = (s) => isChat(s) && chatS(s.id).working;
// busy = a turn is running, or the CLI is still starting: either way a new message waits
export const isBusy = (s) => { if (!isChat(s)) return false; const st = chatS(s.id); return !!(st.working || st.starting || (st.alive && !st.ready)); };
export const needsInput = (s) => isChat(s) && chatS(s.id).msgs.some((m) => (m.kind === 'perm' || m.kind === 'ask') && !m.resolved);

export function toolVerb(name, input) {
  input = input || {};
  const f = input.file_path || input.notebook_path || input.path;
  switch (name) {
    case 'Read': return ['read', f]; case 'Edit': case 'NotebookEdit': return ['edit', f]; case 'Write': return ['write', f];
    case 'Bash': case 'PowerShell': return ['run', input.description || input.command]; case 'Grep': return ['search', input.pattern];
    case 'Glob': return ['find', input.pattern]; case 'Agent': return ['agent', input.description]; case 'WebFetch': return ['fetch', input.url];
    case 'WebSearch': return ['web', input.query]; case 'Skill': return ['skill', input.skill]; case 'AskUserQuestion': return ['ask', 'question'];
    case 'TodoWrite': return ['todos', `${(input.todos || []).length} items`];
    default: return [name.toLowerCase(), f || input.description || JSON.stringify(input).slice(0, 80)];
  }
}
const VERB_ICON = { read: 'file', edit: 'pencil', write: 'file', run: 'terminal', search: 'search', find: 'search', agent: 'brain', fetch: 'globe', web: 'globe', skill: 'zap', ask: 'message', todos: 'listTodo' };
function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : '')).join('\n');
  return content ? JSON.stringify(content) : '';
}
function findTool(st, toolId) {
  for (let i = st.msgs.length - 1; i >= 0; i--) { const m = st.msgs[i]; if (m.kind === 'assistant') { const b = m.blocks.find((x) => x && x.type === 'tool_use' && x.id === toolId); if (b) return b; } }
  return null;
}
const raw = (id, obj) => window.astral.chat.send(id, obj);

function formatAttachments(atts) {
  if (!atts || !atts.filter((a) => a.kind !== 'image').length) return '';
  const lines = ['Attached context from the reviewer:'];
  for (const a of atts) {
    if (a.kind === 'image') continue; // sent as an image block, not text
    if (a.kind === 'comment') lines.push(`\n- ${a.file}${a.line ? `:${a.line}` : ''} — ${a.text}${a.snippet ? `\n  > ${a.snippet.split('\n').join('\n  > ')}` : ''}`);
    else if (a.kind === 'file') lines.push(`\n- file: ${a.path}`);
    else if (a.kind === 'text') lines.push(`\n${a.text}`);
  }
  return lines.join('\n') + '\n\n';
}

// Snapshot the working tree before the agent touches it, so each turn can show
// exactly what it changed. Never blocks a send for more than a moment.
async function checkpoint(s) {
  try {
    const r = await Promise.race([window.astral.git.snapshot(s.cwd), new Promise((res) => setTimeout(() => res(null), 4000))]);
    return r && r.ok ? r.tree : null;
  } catch { return null; }
}

export async function chatSend(s, text, { attachments = [] } = {}) {
  const st = chatS(s.id);
  const full = formatAttachments(attachments) + text;
  const msg = { kind: 'user', text, attachments: attachments.slice(), checkpoint: null, at: Date.now() };
  st.msgs.push(msg);
  st.working = true; st.turnStart = Date.now();
  s.working = true; S.save();
  S.emit('live'); scheduleChat(true);
  msg.checkpoint = await checkpoint(s);
  st.lastCheckpoint = msg.checkpoint;
  const ws = S.workspaceOfSession(s.id);
  if (ws && msg.checkpoint) { ws.checkpoints.push({ sessionId: s.id, tree: msg.checkpoint, at: msg.at, prompt: text.slice(0, 80) }); if (ws.checkpoints.length > 60) ws.checkpoints.splice(0, ws.checkpoints.length - 60); S.save(); }
  const images = attachments.filter((a) => a.kind === 'image').map((a) => ({ type: 'image', source: { type: 'base64', media_type: a.media_type, data: a.data } }));
  raw(s.id, { type: 'user', message: { role: 'user', content: [...images, { type: 'text', text: full }] } });
  scheduleChat(true);
}
export function chatInterrupt(s) { raw(s.id, { type: 'control_request', request_id: 'astral-' + Date.now(), request: { subtype: 'interrupt' } }); }
export async function chatSteer(s, text, opts) { const st = chatS(s.id); if (st.working) { chatInterrupt(s); await new Promise((r) => setTimeout(r, 350)); } return chatSend(s, text, opts); }
export function chatRespond(s, reqId, allow, input, always) {
  const st = chatS(s.id);
  const m = st.msgs.find((x) => (x.kind === 'perm' || x.kind === 'ask') && x.request_id === reqId);
  if (m) { m.resolved = allow ? 'allowed' : 'denied'; if (always && m.tool) st.allow.add(m.tool); }
  raw(s.id, { type: 'control_response', response: { subtype: 'success', request_id: reqId, response: allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Denied by the user in Astral' } } });
  S.emit('live'); scheduleChat();
}
export function chatAnswer(s, reqId, answers) {
  const st = chatS(s.id);
  const m = st.msgs.find((x) => x.kind === 'ask' && x.request_id === reqId);
  if (!m) return;
  m.resolved = 'answered'; m.answers = answers;
  raw(s.id, { type: 'control_response', response: { subtype: 'success', request_id: reqId, response: { behavior: 'allow', updatedInput: { ...m.input, answers } } } });
  S.emit('live'); scheduleChat();
}

// ---- queue ----
export function queueAdd(s, text, attachments = []) { const st = chatS(s.id); st.queue.push({ id: S.uid(), text, attachments }); scheduleChat(true); bus.emit('queue', s); }
export function queueRemove(s, id) { const st = chatS(s.id); st.queue = st.queue.filter((q) => q.id !== id); bus.emit('queue', s); }
export function queueUpdate(s, id, text) { const q = chatS(s.id).queue.find((x) => x.id === id); if (q) q.text = text; bus.emit('queue', s); }
export function queueSendNow(s, id) { const st = chatS(s.id); const i = st.queue.findIndex((q) => q.id === id); if (i < 0) return; const [q] = st.queue.splice(i, 1); chatSteer(s, q.text, { attachments: q.attachments }); bus.emit('queue', s); }
function drainQueue(s) {
  const st = chatS(s.id);
  if (!st.alive || st.working || !st.queue.length || st.queuePaused) return;
  const q = st.queue.shift();
  bus.emit('queue', s);
  chatSend(s, q.text, { attachments: q.attachments });
}

export async function launchChat(s, { resume = false, firstPrompt = null, attachments = [] } = {}) {
  const st = chatS(s.id);
  if (st.alive) { if (firstPrompt) chatSend(s, firstPrompt, { attachments }); return true; }
  if (st.starting) { if (firstPrompt) { if (st.pendingPrompt) queueAdd(s, firstPrompt, attachments); else st.pendingPrompt = { text: firstPrompt, attachments }; } return true; }
  // flags first: binding the session id below re-renders the app, and the
  // render must not see an unstarted chat and launch a second copy
  st.starting = true; st.started = true; st.working = false; st.pendingPrompt = firstPrompt ? { text: firstPrompt, attachments } : null;
  if (!s.agentSessionId) S.bindAgentSession(s.id, S.uid());
  const doResume = resume && !!s.agentSessionId;
  if (!st.msgs.length && !st.loadedHistory) { st.loadedHistory = true; try { const h = await window.astral.chat.historyLoad(s.id); if (Array.isArray(h) && h.length) { st.msgs = h; st.fileHistory = true; st.hydrated = true; st.allow = new Set(); for (const m of h) if (m.kind === 'assistant') for (const b of m.blocks || []) if (b && b.type === 'tool_use' && !b.done) b.done = true; } } catch { /* none */ } }
  st.hydrating = doResume && st.msgs.length === 0; st.resumed = doResume;
  const where = cfg.launchFor(s);
  const r = await window.astral.chat.start({ id: s.id, cwd: where.cwd, addDir: where.addDir, agentSessionId: s.agentSessionId, resume: doResume, model: modelOf(s), permissionMode: s.perm || 'auto', effort: cfg.effort(s), env: cfg.env(s) });
  st.starting = false;
  if (!r.ok) { toast(`Could not start Claude: ${r.error}`, true); st.started = false; S.setLive(s.id, 'dead'); return false; }
  st.alive = true;
  S.setLive(s.id, 'idle');
  state.events[s.id] = state.events[s.id] || [];
  window.astral.agents.watch({ sessionId: s.id, agent: 'claude', cwd: where.cwd, agentSessionId: s.agentSessionId, file: s.transcript, launchedAt: Date.now() });
  scheduleChat(true);
  return true;
}
export async function stopChat(s) { const st = chatS(s.id); await window.astral.chat.stop(s.id); st.alive = false; st.working = false; S.setLive(s.id, 'dead'); scheduleChat(true); }
export async function restartChat(s) { if (!isChat(s)) return; await stopChat(s); const st = chatS(s.id); st.started = false; return launchChat(s, { resume: !!s.agentSessionId }); }

// history for a resumed chat comes from the transcript the tailer replays
export function hydrateFromEvents(s, evs) {
  const st = chatS(s.id);
  let cur = null;
  const ensure = () => { if (!cur) { cur = { kind: 'assistant', id: 'h' + Math.random(), blocks: [] }; st.msgs.push(cur); } return cur; };
  for (const e of evs) {
    if (e.kind === 'user') { st.msgs.push({ kind: 'user', text: e.text, at: e.ts ? +new Date(e.ts) : null }); cur = null; }
    else if (e.kind === 'assistant') ensure().blocks.push({ type: 'text', text: e.text });
    else if (e.kind === 'thinking') ensure().blocks.push({ type: 'thinking', text: e.text });
    else if (e.kind === 'tool') ensure().blocks.push({ type: 'tool_use', id: e.id, name: e.name, input: {}, verb: e.verb, target: e.target, done: true, error: !!e.error, result: '' });
    else if (e.kind === 'turn') { st.msgs.push({ kind: 'turn', ms: e.ms }); cur = null; }
  }
}

// Text and tool calls a subagent makes arrive with parent_tool_use_id (from
// --forward-subagent-text); they are logged under that Agent step.
function handleSub(st, ev) {
  const t = findTool(st, ev.parent_tool_use_id); if (!t) return;
  if (ev.type !== 'assistant') return;
  t.sub = t.sub || [];
  for (const b of ((ev.message || {}).content || [])) {
    if (b.type === 'text' && b.text && b.text.trim()) t.sub.push({ t: 'text', text: b.text.trim() });
    else if (b.type === 'tool_use') { const [verb, target] = toolVerb(b.name, b.input || {}); t.sub.push({ t: 'tool', verb, target: target || b.name }); }
  }
  if (t.sub.length > 300) t.sub.splice(0, t.sub.length - 300);
}

window.astral.chat.onEvent((id, ev) => {
  const s = state.sessions.find((x) => x.id === id);
  if (!s) return;
  const st = chatS(id);
  if (ev.parent_tool_use_id) { handleSub(st, ev); scheduleChat(); return; }
  switch (ev.type) {
    case 'system':
      if (ev.subtype === 'init') {
        st.alive = true; st.ready = true; st.hydrating = false;
        st.model = ev.model || null;
        if (st.pendingPrompt) { const p = st.pendingPrompt; st.pendingPrompt = null; chatSend(s, p.text, { attachments: p.attachments }); }
        else drainQueue(s);
      }
      break;
    case 'stream_event': {
      const e = ev.event || {};
      if (e.type === 'message_start') { st.cur = { kind: 'assistant', id: e.message && e.message.id, blocks: [] }; st.msgs.push(st.cur); st.working = true; }
      else if (e.type === 'content_block_start') { if (!st.cur) { st.cur = { kind: 'assistant', id: null, blocks: [] }; st.msgs.push(st.cur); } const b = e.content_block || {}; st.cur.blocks[e.index] = b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: b.input || {}, json: '', done: false } : { type: b.type, text: b.text || b.thinking || '' }; }
      else if (e.type === 'content_block_delta' && st.cur) { const b = st.cur.blocks[e.index]; const d = e.delta || {}; if (b) { if (d.type === 'text_delta') b.text += d.text; else if (d.type === 'thinking_delta') b.text += d.thinking; else if (d.type === 'input_json_delta') b.json = (b.json || '') + d.partial_json; } }
      else if (e.type === 'content_block_stop' && st.cur) { const b = st.cur.blocks[e.index]; if (b && b.type === 'tool_use' && b.json) { try { b.input = JSON.parse(b.json); } catch { /* partial */ } } if (b && b.type === 'tool_use' && b.name === 'TodoWrite' && b.input && b.input.todos) { st.todos = b.input.todos; bus.emit('todos', s); } }
      else if (e.type === 'message_stop') st.cur = null;
      break;
    }
    case 'assistant': {
      const m = ev.message || {};
      let target = st.msgs.find((x) => x.kind === 'assistant' && x.id && x.id === m.id);
      if (!target) { target = { kind: 'assistant', id: m.id, blocks: [] }; st.msgs.push(target); }
      const prev = target.blocks;
      target.blocks = (m.content || []).map((b) => {
        if (b.type === 'tool_use') { const old = prev.find((x) => x && x.type === 'tool_use' && x.id === b.id) || {}; if (b.name === 'TodoWrite' && b.input && b.input.todos) { st.todos = b.input.todos; bus.emit('todos', s); } return { type: 'tool_use', id: b.id, name: b.name, input: b.input || {}, done: old.done || false, error: old.error || false, result: old.result || '' }; }
        return { type: b.type, text: b.type === 'thinking' ? b.thinking : (b.text || '') };
      });
      if (st.cur && st.cur.id === m.id) st.cur = target;
      break;
    }
    case 'user': {
      for (const b of (ev.message && Array.isArray(ev.message.content) ? ev.message.content : [])) {
        if (b.type === 'tool_result') { const t = findTool(st, b.tool_use_id); if (t) { t.done = true; t.error = !!b.is_error; t.result = resultText(b.content).slice(0, 12000); } }
      }
      break;
    }
    case 'control_request': {
      const req = ev.request || {};
      if (req.subtype === 'can_use_tool') {
        if (req.tool_name === 'AskUserQuestion') { st.msgs.push({ kind: 'ask', request_id: ev.request_id, input: req.input || {}, resolved: null }); if (cfg.onAttention) cfg.onAttention(s); }
        else if (st.allow.has(req.tool_name)) raw(id, { type: 'control_response', response: { subtype: 'success', request_id: ev.request_id, response: { behavior: 'allow', updatedInput: req.input } } });
        else { st.msgs.push({ kind: 'perm', request_id: ev.request_id, tool: req.tool_name, input: req.input || {}, resolved: null }); if (cfg.onAttention) cfg.onAttention(s); }
      } else raw(id, { type: 'control_response', response: { subtype: 'error', request_id: ev.request_id, error: `unsupported: ${req.subtype}` } });
      break;
    }
    case 'result': {
      st.working = false; st.cur = null; s.working = false; S.save();
      const turn = { kind: 'turn', ms: ev.duration_ms, cost: ev.total_cost_usd, error: !!ev.is_error, text: ev.is_error ? resultText(ev.result) : '', from: st.lastCheckpoint, diff: null };
      st.msgs.push(turn);
      if (turn.from) {
        window.astral.git.changes(s.cwd, turn.from).then((r) => { if (r && r.ok) { turn.diff = { files: r.files.length, add: r.add, del: r.del }; scheduleChat(); } }).catch(() => {});
      }
      if (cfg.onResult) cfg.onResult(s, ev);
      setTimeout(() => drainQueue(s), 200);
      break;
    }
    case 'exit': {
      st.alive = false; st.ready = false; st.working = false; st.cur = null; s.working = false; S.save(); persist(s, true);
      // A resume of a conversation that was never written (a chat that died
      // before its first reply) is restarted fresh under the same id, and the
      // message that was waiting goes out again.
      const noConvo = st.resumed && st.msgs.some((m) => m.kind === 'sys' && /No conversation found/i.test(m.text));
      if (noConvo && !st.retried) {
        st.retried = true; st.started = false;
        const lastUser = [...st.msgs].reverse().find((m) => m.kind === 'user');
        st.msgs = st.msgs.filter((m) => m.kind !== 'sys' && m.kind !== 'turn' && m !== lastUser);
        st.hydrating = false;
        setTimeout(() => launchChat(s, { resume: false, firstPrompt: lastUser ? lastUser.text : null, attachments: lastUser ? lastUser.attachments : [] }), 100);
        break;
      }
      st.msgs.push({ kind: 'sys', text: `Claude exited (${ev.code})`, err: ev.code !== 0 });
      break;
    }
    case 'stderr':
      if (ev.text && ev.text.trim() && !/^\s*$/.test(ev.text)) st.msgs.push({ kind: 'sys', text: ev.text.trim().slice(0, 600), err: true });
      break;
    default: break;
  }
  if (st.msgs.length > 800) st.msgs.splice(0, st.msgs.length - 800);
  scheduleChat();
  persist(s, ev.type === 'result');
  if (['result', 'exit', 'system', 'control_request'].includes(ev.type)) S.emit('live');
});

// ---- rendering ----
// history on disk: written a moment after the conversation changes, and right away
// when a turn ends. Images keep their preview but not the payload that went to Claude.
const persistTimers = new Map();
export function persist(s, now = false) {
  const st = state.chat[s.id]; if (!st || !st.msgs.length) return;
  const write = () => { persistTimers.delete(s.id); const msgs = st.msgs.map((m) => (m.kind === 'user' && m.attachments && m.attachments.length ? { ...m, attachments: m.attachments.map((a) => (a.kind === 'image' ? { ...a, data: undefined } : a)) } : m)); window.astral.chat.historySave(s.id, msgs).catch(() => {}); };
  clearTimeout(persistTimers.get(s.id));
  if (now) write(); else persistTimers.set(s.id, setTimeout(write, 1500));
}
let chatRaf = null, chatForce = false, target = { el: null, session: null };
export function mount(el, getSession) { target = { el, getSession }; }
export function scheduleChat(force = false) { chatForce = chatForce || force; if (chatRaf) return; chatRaf = requestAnimationFrame(() => { chatRaf = null; renderChat(chatForce); chatForce = false; }); }
export function lastAssistantText(s) {
  const st = chatS(s.id);
  for (let i = st.msgs.length - 1; i >= 0; i--) { const m = st.msgs[i]; if (m.kind === 'assistant') { const t = m.blocks.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n').trim(); if (t) return t; } }
  return '';
}

function toolRow(b, open) {
  const [verb, tgt] = b.verb ? [b.verb, b.target] : toolVerb(b.name, b.input);
  if (b.name === 'TodoWrite' && b.input && b.input.todos) {
    const todos = b.input.todos;
    return `<div class="todos-card"><div class="th">${ic('listTodo')}<span>Todos</span><span class="n">${todos.filter((t) => t.status === 'completed').length}/${todos.length}</span></div>${todos.map((t) => `<div class="todo ${t.status}">${t.status === 'completed' ? ic('checkCircle', 'i-sm') : t.status === 'in_progress' ? ic('arrowRight', 'i-sm') : ic('circle', 'i-sm')}<span>${esc(t.status === 'in_progress' ? (t.activeForm || t.content) : t.content)}</span></div>`).join('')}</div>`;
  }
  const isOpen = open.has(b.id);
  const cmd = b.input && b.input.command && b.input.description ? b.input.command : '';
  const sub = b.sub || [];
  const last = sub.length ? sub[sub.length - 1] : null;
  const subLive = !b.done && last ? `<div class="sub-live">${last.t === 'tool' ? `${esc(last.verb)} <span class="tg">${esc(last.target)}</span>` : esc(last.text.split('\n')[0].slice(0, 140))}</div>` : '';
  const subLog = sub.length ? `<div class="sublog">${sub.map((x) => x.t === 'tool' ? `<div class="sl-tool">${ic(VERB_ICON[x.verb] || 'zap', 'i-sm')}<span class="verb">${esc(x.verb)}</span><span class="tg">${esc(x.target)}</span></div>` : `<div class="sl-text md">${md(x.text)}</div>`).join('')}</div>` : '';
  return `<div class="tool ${b.done ? (b.error ? 'error done' : 'done') : 'pending'} ${isOpen ? 'is-open' : ''}" data-tool="${esc(b.id)}">
    <div class="th" data-tool-toggle="${esc(b.id)}">${ic(VERB_ICON[verb] || 'zap', 'i-sm')}<span class="verb">${esc(verb)}</span><span class="target" title="${esc(tgt || b.name)}">${esc(tgt || b.name)}</span>${sub.length ? `<span class="subn">${sub.filter((x) => x.t === 'tool').length} steps</span>` : ''}${b.error ? `<span class="err">failed</span>` : ''}<span class="chev">${I.chevronRight}</span></div>${subLive}
    <div class="out">${cmd ? `<div class="cmd">$ ${esc(cmd)}</div>` : ''}${subLog}${esc(b.result || (b.done ? '(no output)' : '…'))}</div></div>`;
}
function askCard(m) {
  const qs = (m.input && m.input.questions) || [];
  return `<div class="perm ask" data-ask="${esc(m.request_id)}"><div class="q">${ic('message')}<b>Claude has a question</b>${m.resolved ? `<span class="res">${esc(m.resolved)}</span>` : ''}</div>
    ${qs.map((q, qi) => `<div class="qq"><div class="qt">${esc(q.question || q.header || '')}</div>${m.resolved ? `<div class="qa">${esc((m.answers || {})[q.question] || '')}</div>` : `<div class="opts">${(q.options || []).map((o) => `<button class="opt" data-ask-opt="${esc(m.request_id)}" data-q="${qi}" data-label="${esc(o.label)}"><b>${esc(o.label)}</b>${o.description ? `<span>${esc(o.description)}</span>` : ''}</button>`).join('')}<button class="opt other" data-ask-other="${esc(m.request_id)}" data-q="${qi}"><b>Other…</b></button></div>`}</div>`).join('')}</div>`;
}
function permCard(m) {
  const [verb, tgt] = toolVerb(m.tool, m.input);
  const cmd = m.input && m.input.command ? m.input.command : '';
  return `<div class="perm" data-perm="${esc(m.request_id)}"><div class="q">${ic('alertCircle')}<b>Allow ${esc(m.tool)}?</b><span class="what">${esc(verb)} ${esc(tgt || '')}</span>${m.resolved ? `<span class="res">${esc(m.resolved)}</span>` : ''}</div>
    ${cmd || (m.input && (m.input.file_path || m.input.path)) ? `<pre>${esc(cmd || m.input.file_path || m.input.path)}</pre>` : ''}
    ${m.resolved ? '' : `<div class="acts"><button class="btn primary" data-perm-allow="${esc(m.request_id)}">Allow <kbd>↵</kbd></button><button class="btn" data-perm-always="${esc(m.request_id)}">Always allow ${esc(m.tool)}</button><button class="btn ghost" data-perm-deny="${esc(m.request_id)}">Deny <kbd>⌫</kbd></button></div>`}</div>`;
}

export function renderChat(force = false) {
  const el = target.el; if (!el) return;
  const s = target.getSession ? target.getSession() : null;
  if (!s || !isChat(s)) return;
  const st = chatS(s.id);
  if (el.dataset.session !== s.id) { el.dataset.session = s.id; el.innerHTML = ''; force = true; }
  const nearBottom = force || el.scrollHeight - el.scrollTop - el.clientHeight < 140;
  const open = new Set([...el.querySelectorAll('.tool.is-open')].map((x) => x.dataset.tool));
  const openThink = new Set([...el.querySelectorAll('details.think[open]')].map((x) => x.dataset.k));
  if (!st.msgs.length) {
    el.innerHTML = `<div class="chat-empty">${st.hydrating ? 'Loading the conversation…' : st.started ? (st.alive ? `<div class="big">Claude is ready.</div><div>Describe what you want done in this workspace.</div>` : 'Claude is not running. Send a message to start it.') : `<div class="big">Start the conversation.</div><div>Your message starts Claude Code in this workspace. Files, terminal and diff are on the right.</div>`}</div>`;
    return;
  }
  let html = '';
  st.msgs.forEach((m, i) => {
    if (m.kind === 'user') { const atts = (m.attachments || []).filter((a) => a.kind !== 'image'), imgs = (m.attachments || []).filter((a) => a.kind === 'image'); html += `<div class="msg user"><div class="bubble">${imgs.length ? `<div class="imgs">${imgs.map((a) => `<img src="${a.dataUrl}" alt="${esc(a.name)}" title="${esc(`${a.name} · ${a.w}×${a.h}`)}" data-img-zoom="1">`).join('')}</div>` : ''}${atts.length ? `<div class="atts">${atts.map((a) => `<span class="att">${ic(a.kind === 'comment' ? 'message' : 'paperclip', 'i-sm')}${esc(a.kind === 'comment' ? `${basename(a.file)}${a.line ? ':' + a.line : ''}` : a.kind === 'file' ? basename(a.path) : 'note')}</span>`).join('')}</div>` : ''}${esc(m.text)}</div></div>`; }
    else if (m.kind === 'sys') html += `<div class="sysline ${m.err ? 'err' : ''}">${esc(m.text)}</div>`;
    else if (m.kind === 'turn') html += `<div class="turn ${m.error ? 'err' : ''}"><span class="t">${m.error ? ic('xCircle', 'i-sm') : ic('checkCircle', 'i-sm')}${m.ms ? (m.ms / 1000).toFixed(1) + 's' : 'done'}</span>${m.cost ? `<span>$${m.cost.toFixed(2)}</span>` : ''}${m.diff ? (m.diff.files ? `<button class="turn-diff" data-turn-diff="${esc(m.from)}" title="Show what this turn changed">${ic('gitCompare', 'i-sm')}<span class="a">+${m.diff.add}</span><span class="d">−${m.diff.del}</span><span>${m.diff.files} file${m.diff.files === 1 ? '' : 's'}</span></button>` : '<span class="nochange">no file changes</span>') : ''}${m.error ? `<span class="errtext">${esc(m.text || 'error')}</span>` : ''}</div>`;
    else if (m.kind === 'perm') html += permCard(m);
    else if (m.kind === 'ask') html += askCard(m);
    else if (m.kind === 'assistant') {
      let body = '';
      const blocks = m.blocks.filter(Boolean);
      const isLast = i === st.msgs.length - 1;
      for (let j = 0; j < blocks.length; j++) {
        const b = blocks[j];
        const streaming = st.working && isLast && j === blocks.length - 1;
        if (b.type === 'text') { if (b.text && b.text.trim()) body += `<div class="md">${md(b.text)}</div>`; }
        else if (b.type === 'thinking') { if (b.text && b.text.trim()) { const k = `${i}-${j}`; body += `<details class="think ${streaming ? 'is-live' : ''}" data-k="${k}" ${openThink.has(k) ? 'open' : ''}><summary>${ic('brain', 'i-sm')}<span>${streaming ? 'Thinking…' : 'Thinking'}</span></summary><div>${esc(b.text)}</div></details>`; } }
        else if (b.type === 'tool_use') {
          let k = j; const group = [];
          while (k < blocks.length && blocks[k].type === 'tool_use') group.push(blocks[k++]);
          body += `<div class="steps">${group.map((t) => toolRow(t, open)).join('')}</div>`;
          j = k - 1;
        }
      }
      // the turn's spinner line stays until the result arrives: as the whole reply
      // while nothing has streamed yet, and under the content after that
      const live = st.working && isLast;
      if (!body && !live) return; // a reply that produced nothing visible (interrupted, or only a stop) has no row
      const line = `<div class="working">${WORK('claude', { mode: 'line', key: s.id, since: st.turnStart, hint: true, glyph: false })}</div>`;
      html += `<div class="msg assistant"><span class="who">${live ? WORK('claude') : ag('claude')}</span><div class="body">${body}${live ? line : ''}</div></div>`;
    }
  });
  const last = st.msgs[st.msgs.length - 1];
  if (st.working && last && last.kind === 'user') html += `<div class="msg assistant"><span class="who">${WORK('claude')}</span><div class="body"><div class="working">${WORK('claude', { mode: 'line', key: s.id, since: st.turnStart, hint: true, glyph: false })}</div></div></div>`;
  el.innerHTML = html;
  if (nearBottom) el.scrollTop = el.scrollHeight;
}
