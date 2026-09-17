// Astral — a Conductor-style console for parallel coding agents.
// Repositories hold workspaces; a workspace is a branch in its own git worktree
// with chats, a terminal, run scripts, a diff to review and a PR to ship.
import './styles.css';
import { TerminalManager } from './terminals.js';
import * as S from './store.js';
import { state } from './store.js';
import { I, brandSvg } from './icons.js';
import { WORK, hasSpinner } from './spinners.js';
import { imageFromBlob, imageFromDataUrl, imageFilesOf, isImageFile } from './images.js';
import logoMark from './assets/logo-mark.png';
import { REGISTRY, agentOf, installCommand, updateCommand, launchWith, hasModel } from './registry.js';
import { $, esc, basename, dirname, ic, ag, fmtTime, when, kb, slug, samePath, isInstalled, hasUpdate, updateCount, launchCmd, modelOf, modelLabel, pickCity, RUN, highlight, toast, menu, menuAt, closeCtx, modal, promptModal, confirmModal, hooks, sound, bus, LANG_BY_EXT , md } from './core.js';
import * as chat from './chat.js';
import * as diff from './diff.js';

const app = document.getElementById('app');
let PATHS = { home: '', workspacesRoot: '' };
const wsTab = {};          // wsId -> chat | notes | setup | run
const drawerTabs = {};     // wsId -> [{id,label}]
const drawerActive = {};   // wsId -> pty id
const attach = {};         // wsId -> [{kind:'file', path} | {kind:'image', id, name, media_type, data, dataUrl}]
const composerDraft = {};  // sessionId -> text
// Long pastes collapse to a "[Pasted text #1 +42 lines]" token in the composer,
// like Claude Code; the real text is kept here and put back when the message is sent.
const pastes = {};  // sessionId -> { n, items: { n: text } }
const PASTE_RE = /\[Pasted text #(\d+) \+\d+ (?:lines|chars)\]/g;
const isLongPaste = (t) => t.split('\n').length > 5 || t.length > 800;
function storePaste(sid, text) {
  const p = pastes[sid] || (pastes[sid] = { n: 0, items: {} });
  const n = ++p.n; p.items[n] = text;
  const lines = text.split('\n').length;
  return `[Pasted text #${n} +${lines > 1 ? `${lines} lines` : `${text.length} chars`}]`;
}
function expandPastes(sid, text) {
  const p = pastes[sid]; if (!p) return text;
  const out = text.replace(PASTE_RE, (m, n) => (p.items[n] !== undefined ? p.items[n] : m));
  pastes[sid] = { n: 0, items: {} };
  return out;
}
let ghCmd = null;

// ---------------------------------------------------------------- skeleton
app.innerHTML = `
  <aside class="sidebar">
    <div class="side-top drag">
      <span class="logo"><img class="mark" src="${logoMark}" alt="" draggable="false"><span>Astral</span></span>
      <span class="grow"></span>
      <button class="icon-btn no-drag" data-act="search" title="Search (Ctrl+K)">${ic('search')}</button>
      <button class="icon-btn no-drag" data-act="toggle-side" title="Hide sidebar (Ctrl+B)">${ic('panelLeft')}</button>
    </div>
    <div class="side-scroll" id="side-list"></div>
    <div class="side-foot">
      <button class="btn-new" data-act="new-workspace">${ic('plus')}<span>New workspace</span><kbd>Ctrl+N</kbd></button>
      <div class="side-links">
        <button class="nav-row" data-act="history" id="nav-history">${ic('archive')}<span>History</span><span class="count" id="hist-count"></span></button>
        <button class="nav-row" data-act="settings" id="nav-settings">${ic('cog')}<span>Settings</span><span class="count" id="upd-count"></span></button>
      </div>
    </div>
  </aside>
  <section class="main">
    <div class="topbar drag" id="topbar"></div>
    <div class="tabs-row" id="tabs"></div>
    <div class="content" id="content">
      <div class="chat" id="chat" hidden></div>
      <div class="term-main" id="term-main" hidden></div>
      <div class="page" id="page" hidden></div>
      <div class="empty" id="empty" hidden></div>
      <div class="preview" id="preview" hidden></div>
    </div>
    <div class="drawer" id="drawer" hidden>
      <div class="drawer-bar" id="drawer-bar"></div>
      <div class="drawer-host" id="term-drawer"></div>
    </div>
    <div class="composer-wrap" id="composer-wrap" hidden></div>
  </section>
  <aside class="panel">
    <div class="panel-tabs" id="panel-tabs"></div>
    <div class="panel-body" id="panel-body"></div>
  </aside>
  <div class="gutter left no-drag" id="gut-left" title="Drag to resize"></div>
  <div class="gutter right no-drag" id="gut-right" title="Drag to resize"></div>
  <div class="edge-top no-drag"></div>`;
// sidebar / panel widths: dragged at the gutters, remembered in ui settings
function applyWidths() { const r = document.documentElement.style; r.setProperty('--sidebar-w', (state.ui.sidebarW || 268) + 'px'); r.setProperty('--panel-w', (state.ui.panelW || 400) + 'px'); }
(() => {
  let drag = null;
  const start = (side) => (e) => { drag = { side, x: e.clientX, w: side === 'left' ? (state.ui.sidebarW || 268) : (state.ui.panelW || 400) }; app.classList.add('resizing'); document.body.style.cursor = 'col-resize'; e.preventDefault(); };
  $('gut-left').addEventListener('mousedown', start('left'));
  $('gut-right').addEventListener('mousedown', start('right'));
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (drag.side === 'left') state.ui.sidebarW = Math.max(200, Math.min(520, drag.w + dx));
    else state.ui.panelW = Math.max(280, Math.min(Math.max(280, window.innerWidth - 700), drag.w - dx));
    applyWidths();
  });
  window.addEventListener('mouseup', () => { if (drag) { drag = null; app.classList.remove('resizing'); document.body.style.cursor = ''; S.save(); tmMain.scheduleFit(); tmDrawer.scheduleFit(); } });
})();

// ---------------------------------------------------------------- terminals
// One manager for agents that draw their own TUI in the main area, one for the
// workspace terminal drawer. Both see every pty event and ignore ids they do
// not own.
const tmMain = new TerminalManager($('term-main'), {
  onActivity(id) { const l = state.live[id] || (state.live[id] = {}); l.lastOutput = Date.now(); },
  onExit(id) { if (id.startsWith('run:') || id.startsWith('setup:')) { S.emit('layout'); return; } S.setLive(id, 'dead'); window.astral.agents.unwatch(id); },
});
const tmDrawer = new TerminalManager($('term-drawer'), {
  onActivity() {},
  onExit(id) { if (id.startsWith('install:')) checkVersions(true); renderDrawer(); },
});
hooks.onModalClose = () => { tmMain.fitActive(); tmDrawer.fitActive(); focusInput(); };
chat.configure({
  termLive: (id) => tmMain.isLive(id),
  env: (s) => { const ws = S.workspaceOfSession(s.id); return ws ? envFor(ws) : {}; },
  launchFor: (s) => claudeLaunch(s),
  effort: (s) => s.effort || null,
  onResult: (s, ev) => onTurnDone(s, ev),
  onAttention: (s) => { const ws = S.workspaceOfSession(s.id); if (ws && (ws.id !== state.activeWorkspaceId || !state.winFocused)) { const l = state.live[s.id] || (state.live[s.id] = {}); l.attention = true; ws.unread = true; notify(ws, 'Claude needs your input'); } S.emit('live'); },
});
chat.mount($('chat'), () => { const s = S.activeSession(); return s && chat.isChat(s) && state.view === 'workspace' && (wsTab[state.activeWorkspaceId] || 'chat') === 'chat' ? s : null; });

function envFor(ws) {
  const repo = S.repoOf(ws);
  const g = state.git[repo ? repo.path : ws.path] || {};
  return { CONDUCTOR_WORKSPACE_NAME: ws.name, CONDUCTOR_WORKSPACE_PATH: ws.path, CONDUCTOR_ROOT_PATH: repo ? repo.path : ws.path, CONDUCTOR_DEFAULT_BRANCH: (repo && repo.base) || g.base || 'main', CONDUCTOR_PORT: String(ws.port || 0), CONDUCTOR_IS_LOCAL: '1', CONDUCTOR_SESSION_ID: ws.id, ASTRAL_WORKSPACE: ws.name };
}
function allocPort() { const used = state.workspaces.map((w) => w.port || 0); let p = 55000; while (used.includes(p)) p += 10; return p; }
function scriptsFor(ws) { const repo = S.repoOf(ws); return (repo && state.scripts[repo.id]) || { setup: '', run: '', archive: '', runs: {}, run_mode: 'concurrent', file_include_globs: ['.env*'] }; }
async function loadScripts(repo, force = false) {
  if (!repo) return null;
  if (!force && state.scripts[repo.id] && Date.now() - (state.scripts[repo.id].at || 0) < 30000) return state.scripts[repo.id];
  const s = await window.astral.conductor.settings(repo.path);
  state.scripts[repo.id] = { ...s, at: Date.now() };
  S.emit('scripts');
  return state.scripts[repo.id];
}

// ---------------------------------------------------------------- status
function statusOf(id) { return (state.live[id] && state.live[id].status) || 'dormant'; }
function attentionOf(id) { return !!(state.live[id] && state.live[id].attention); }
// when the current turn began: the chat's own clock, else the moment the live poll saw output
function workingSince(id) { const c = state.chat[id]; if (c && c.working && c.turnStart) return c.turnStart; return (state.live[id] && state.live[id].workingSince) || 0; }
const STATUS_LABEL = { working: 'Working', idle: 'Idle', dormant: 'Not running', dead: 'Exited' };
function wsStatus(ws) {
  const sessions = S.workspaceSessions(ws.id);
  const busy = sessions.find((s) => statusOf(s.id) === 'working');
  const working = !!busy;
  const input = sessions.some((s) => chat.needsInput(s) || attentionOf(s.id));
  const g = state.git[ws.path] || {};
  const pr = state.pr[ws.id] && state.pr[ws.id].pr;
  const failing = pr && pr.statusCheckRollup && pr.statusCheckRollup.some((c) => /FAIL|ERROR|CANCEL/i.test(c.conclusion || c.state || ''));
  let text, stripe, html = '';
  if (working) { text = 'Working'; stripe = 'working'; if (hasSpinner(busy.agent)) html = WORK(busy.agent, { mode: 'line', key: busy.id, since: workingSince(busy.id), glyph: false }); }
  else if (input) { text = 'Needs input'; stripe = 'attention'; }
  else if (pr && pr.state === 'MERGED') { text = 'Merged'; stripe = 'merged'; }
  else if (failing) { text = `PR #${pr.number} · checks failing`; stripe = 'failing'; }
  else if (pr && pr.state === 'OPEN') { text = `PR #${pr.number}${pr.isDraft ? ' draft' : ''}`; stripe = 'pr'; }
  else if (g.dirty) { text = `${g.dirty} uncommitted`; stripe = 'dirty'; }
  else if (g.ahead) { text = `${g.ahead} to push`; stripe = 'ahead'; }
  else if (g.isRepo) { text = 'Clean'; stripe = 'clean'; }
  else { text = ''; stripe = 'none'; }
  return { text, stripe, html, working, input, pr, busy };
}
function attentionList() { return state.workspaces.filter((w) => !w.archived && (w.unread || wsStatus(w).input)); }

// ---------------------------------------------------------------- theme
function applyTheme() {
  const t = state.ui.theme === 'system' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : state.ui.theme;
  document.documentElement.dataset.theme = t;
  document.documentElement.dataset.font = state.ui.font || 'system';
  // the skin only restyles: same layout, same controls, different clothes
  document.documentElement.dataset.skin = state.ui.skin || 'default';
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

// ---------------------------------------------------------------- sidebar
function renderSidebar() {
  const el = $('side-list');
  if (!state.repos.length) { el.innerHTML = `<div class="side-empty"><div>No repositories yet.</div><button class="btn primary" data-act="add-repo">${ic('folderPlus')}<span>Add repository</span></button></div>`; $('hist-count').textContent = ''; return; }
  const sortFn = state.ui.sidebarSort === 'created' ? (a, b) => b.createdAt - a.createdAt : (a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt);
  el.innerHTML = state.repos.map((r) => {
    const list = S.repoWorkspaces(r.id).sort(sortFn);
    const g = state.git[r.path] || {};
    return `<div class="repo" data-repo="${r.id}">
      <button class="repo-row" data-repo-menu="${r.id}" title="${esc(r.path)}"><span class="avatar">${esc(r.name.slice(0, 1).toUpperCase())}</span><span class="name">${esc(r.name)}</span>${g.base ? `<span class="base">${esc(g.base)}</span>` : ''}${ic('chevronDown', 'i-sm chev')}</button>
      ${list.length ? list.map((w) => {
        const st = wsStatus(w);
        const active = w.id === state.activeWorkspaceId && state.view === 'workspace';
        const pr = st.pr;
        const title = pr && pr.state !== 'MERGED' ? pr.title : (w.local ? ((state.git[w.path] || {}).branch || w.branch || 'Repository folder') : (w.branch || w.name));
        const ch = state.changes[w.id];
        const stats = ch && ch.ok && ch.mode === 'all' && (ch.add || ch.del) ? `<span class="stats"><span class="a">+${ch.add}</span><span class="d">−${ch.del}</span></span>` : '';
        return `<button class="ws-row ${active ? 'is-active' : ''} ${w.unread ? 'unread' : ''}" data-ws="${w.id}" title="${esc(w.path)}">
          <span class="stripe ${st.stripe}"></span>
          <span class="lines"><span class="t">${esc(title)}${w.local ? `<span class="local">local</span>` : ''}</span><span class="s">${w.local ? '' : esc(w.name) + ' · '}${st.html || esc(st.text)}${st.text ? ' · ' : ''}${esc(when(w.updatedAt))}</span></span>
          <span class="right">${st.working ? WORK(st.busy.agent) : st.input ? `<span class="need" title="Needs input">${ic('alertCircle', 'i-sm')}</span>` : w.unread ? '<span class="dot-unread"></span>' : ''}${stats}</span></button>`;
      }).join('') : `<div class="ws-none">No workspaces. <a data-act="new-workspace">Create one</a>.</div>`}
    </div>`;
  }).join('') + `<button class="add-repo-row" data-act="add-repo">${ic('plus', 'i-sm')}<span>Add repository</span></button>`;
  const archived = state.workspaces.filter((w) => w.archived).length;
  $('hist-count').textContent = archived || '';
  $('nav-history').classList.toggle('is-active', state.view === 'history');
  $('nav-settings').classList.toggle('is-active', state.view === 'settings');
  const u = updateCount(); $('upd-count').textContent = u ? `${u}↑` : '';
}

// ---------------------------------------------------------------- top bar
function renderTopbar() {
  const el = $('topbar');
  const ws = S.activeWorkspace();
  const win = `<div class="tools no-drag"><button class="icon-btn" data-act="toggle-panel" title="Toggle panel (Ctrl+\\)">${ic('panelRight')}</button><div class="winctl"><button data-win="minimize" title="Minimize">${I.winMin}</button><button data-win="maximize" title="Maximize" id="maxglyph">${I.winMax}</button><button data-win="close" class="close" title="Close">${I.winClose}</button></div></div>`;
  const reopen = state.ui.sidebarOpen ? '' : `<button class="icon-btn no-drag" data-act="toggle-side" title="Show sidebar">${ic('panelLeft')}</button>`;
  if (state.view === 'history') { el.innerHTML = `${reopen}<span class="title">${ic('archive')}History</span><span class="grow"></span>${win}`; return; }
  if (state.view === 'settings') { el.innerHTML = `${reopen}<span class="title">${ic('cog')}Settings</span><span class="grow"></span>${win}`; return; }
  if (!ws) { el.innerHTML = `${reopen}<span class="grow"></span>${win}`; return; }
  const g = state.git[ws.path] || {};
  const st = wsStatus(ws);
  const pr = st.pr;
  const scripts = scriptsFor(ws);
  const runAlive = tmMain.isLive('run:' + ws.id);
  const hasRun = !!(scripts.run || Object.keys(scripts.runs || {}).length);
  el.innerHTML = `${reopen}
    <div class="ws-title no-drag">
      <span class="name">${esc(ws.name)}</span>
      ${g.branch ? `<button class="chip branch" data-act="rename-branch" title="Branch · click to rename">${ic('gitBranch', 'i-sm')}<span>${esc(g.branch)}</span>${g.ahead || g.behind ? `<span class="ab">${g.ahead ? '↑' + g.ahead : ''}${g.behind ? '↓' + g.behind : ''}</span>` : ''}</button>` : ''}
      ${pr ? `<button class="chip pr ${pr.state.toLowerCase()} ${pr.isDraft ? 'draft' : ''}" data-act="open-pr" title="${esc(pr.title)}">${ic('gitPullRequest', 'i-sm')}<span>#${pr.number}</span></button>` : ''}
    </div>
    <span class="grow"></span>
    <div class="actions no-drag">
      <button class="pill-btn" data-act="open-in" title="Open workspace in…">${ic('externalLink', 'i-sm')}<span>Open in</span>${ic('chevronDown', 'i-sm')}</button>
      ${hasRun ? `<button class="pill-btn ${runAlive ? 'is-live' : ''}" data-act="run" title="${runAlive ? 'Stop the run script' : 'Run script (Ctrl+R)'}">${ic(runAlive ? 'stop' : 'play', 'i-sm')}<span>${runAlive ? 'Stop' : 'Run'}</span></button>` : ''}
      ${pr && pr.state === 'OPEN' ? `<button class="pill-btn" data-act="checks" title="Checks and PR (Ctrl+Shift+C)">${ic('checkCircle', 'i-sm')}<span>PR #${pr.number}</span></button>` : `<button class="pill-btn primary" data-act="create-pr" title="Create pull request (Ctrl+Shift+P)">${ic('gitPullRequest', 'i-sm')}<span>Create PR</span></button>`}
      <button class="icon-btn" data-act="ws-menu" title="More">${ic('ellipsis')}</button>
    </div>${win}`;
}

// ---------------------------------------------------------------- tabs row
function renderTabs() {
  const el = $('tabs');
  const ws = S.activeWorkspace();
  if (!ws || state.view !== 'workspace') { el.innerHTML = ''; el.hidden = true; return; }
  el.hidden = false;
  const tab = wsTab[ws.id] || 'chat';
  const sessions = S.workspaceSessions(ws.id);
  const active = S.activeSession();
  const scripts = scriptsFor(ws);
  el.innerHTML = `<div class="tabs">${sessions.map((s) => `<button class="tab ${tab === 'chat' && active && s.id === active.id ? 'is-active' : ''}" data-chat="${s.id}" title="${esc(agentOf(s.agent).name)} · ${STATUS_LABEL[statusOf(s.id)]}">${statusOf(s.id) === 'working' ? WORK(s.agent) : ag(s.agent)}<span class="t">${esc(s.name)}</span>${attentionOf(s.id) || chat.needsInput(s) ? '<span class="dot-need"></span>' : ''}<span class="close" data-close-chat="${s.id}" title="Close chat">${ic('x', 'i-sm')}</span></button>`).join('')}
      <button class="tab-add" data-act="new-chat" title="New chat">${ic('plus', 'i-sm')}<span>New chat</span></button></div>
    <span class="grow"></span>
    <div class="view-tabs">
      <button class="vtab ${tab === 'notes' ? 'is-active' : ''}" data-tab="notes">${ic('notebook', 'i-sm')}<span>Notes</span></button>
      <button class="vtab ${tab === 'setup' ? 'is-active' : ''}" data-tab="setup">${ic('wrench', 'i-sm')}<span>Setup</span>${tmMain.isLive('setup:' + ws.id) ? RUN() : ''}</button>
      ${scripts.run || Object.keys(scripts.runs || {}).length ? `<button class="vtab ${tab === 'run' ? 'is-active' : ''}" data-tab="run">${ic('play', 'i-sm')}<span>Run</span>${tmMain.isLive('run:' + ws.id) ? RUN() : ''}</button>` : ''}
      <button class="vtab ${state.ui.drawerOpen ? 'is-active' : ''}" data-act="toggle-drawer" title="Terminal (Ctrl+\`)">${ic('terminal', 'i-sm')}<span>Terminal</span></button>
    </div>`;
}

// ---------------------------------------------------------------- main content
function showOnly(which) {
  for (const id of ['chat', 'term-main', 'page', 'empty']) $(id).hidden = id !== which;
  if (which !== 'term-main') tmMain.hideAll();
}
function renderContent() {
  const ws = S.activeWorkspace();
  const wrap = $('composer-wrap');
  if (state.view === 'history') { showOnly('page'); wrap.hidden = true; renderHistory(); return; }
  if (state.view === 'settings') { showOnly('page'); wrap.hidden = true; renderSettings(); return; }
  if (!ws) { showOnly('empty'); wrap.hidden = true; renderEmpty(); return; }
  const tab = wsTab[ws.id] || 'chat';
  if (tab === 'notes') { showOnly('page'); wrap.hidden = true; renderNotes(ws); return; }
  if (tab === 'setup' || tab === 'run') {
    const id = `${tab}:${ws.id}`;
    wrap.hidden = true;
    if (tmMain.has(id)) { showOnly('term-main'); tmMain.show(id); }
    else { showOnly('page'); renderScriptPage(ws, tab); }
    return;
  }
  const s = S.activeSession();
  if (!s) { showOnly('empty'); wrap.hidden = true; renderEmptyWorkspace(ws); return; }
  if (chat.isChat(s)) {
    showOnly('chat');
    const st = chat.chatS(s.id);
    if (!st.started && s.agentSessionId) chat.launchChat(s, { resume: true });
    chat.scheduleChat();
    wrap.hidden = false;
    renderComposer(s, ws);
  } else {
    showOnly('term-main');
    if (!tmMain.has(s.id)) { tmMain.create(s.id, agentOf(s.agent).color); tmMain.show(s.id); launch(s, { resume: !!s.agentSessionId }); }
    else tmMain.show(s.id);
    wrap.hidden = true;
  }
}
function renderEmpty() {
  const el = $('empty');
  if (!state.repos.length) {
    el.innerHTML = `<div class="hero">
      <div class="mark">${ic('train')}</div>
      <h1>Run parallel coding agents.</h1>
      <p>Add a repository. Every workspace gets its own branch, files, terminal and review path, so several agents can work at once without stepping on each other.</p>
      <div class="hero-acts"><button class="btn primary lg" data-act="add-repo">${ic('folderPlus')}<span>Open a local repository</span></button><button class="btn lg" data-act="clone-repo">${ic('download')}<span>Clone from URL</span></button></div>
      <div class="hero-sub">Claude Code, Codex and other CLIs run untouched. <a data-act="resume">Resume a conversation from any folder</a> or <a data-act="settings">check installed agents</a>.</div></div>`;
    return;
  }
  el.innerHTML = `<div class="hero"><div class="mark">${ic('train')}</div><h1>No workspace selected.</h1><p>Create a workspace to start an agent on a fresh branch.</p><div class="hero-acts"><button class="btn primary lg" data-act="new-workspace">${ic('plus')}<span>New workspace</span><kbd>Ctrl+N</kbd></button></div></div>`;
}
function renderEmptyWorkspace(ws) {
  const agents = REGISTRY.filter((r) => isInstalled(r.id) && r.id !== 'shell');
  $('empty').innerHTML = `<div class="hero small"><h1>${esc(ws.name)}</h1><p>${ws.branch ? `Branch <code>${esc(ws.branch)}</code> in its own worktree.` : 'Working directly in the repository folder.'} Start a chat to put an agent to work.</p>
    <div class="agent-row">${agents.map((r) => `<button class="btn" data-new-chat="${r.id}">${ag(r.id)}<span>${esc(r.name)}</span></button>`).join('')}<button class="btn ghost" data-new-chat="shell">${ic('terminal')}<span>Shell</span></button></div></div>`;
}
function renderNotes(ws) {
  const page = $('page');
  if (page.dataset.kind === 'notes' && page.dataset.ws === ws.id) return;
  page.dataset.kind = 'notes'; page.dataset.ws = ws.id;
  page.innerHTML = `<div class="notes has-handoff"><div class="notes-head">${ic('notebook')}<span>Notes for ${esc(ws.name)}</span><span class="grow"></span><span class="hint">Never committed. Given to the next agent you start here, together with the handoff below.</span></div><textarea id="notes-ta" placeholder="Plans, links, things to remember. Drag a note into the composer to send it to the agent.">${esc(ws.notes || '')}</textarea></div>`;
  const ta = page.querySelector('#notes-ta');
  let t = null;
  ta.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { ws.notes = ta.value; S.save(); }, 300); });
  page.querySelector('.notes').insertAdjacentHTML('beforeend', `<div class="handoff" id="handoff-box"></div>`);
  renderHandoffBox(ws);
  if (!ws.handoff) updateHandoff(ws);
}
// the read-only handoff section under the notes
function renderHandoffBox(ws) {
  const box = $('handoff-box'); const page = $('page');
  if (!box || page.dataset.kind !== 'notes' || page.dataset.ws !== ws.id) return;
  const open = box.querySelector('details') ? box.querySelector('details').open : true;
  box.innerHTML = `<details ${open ? 'open' : ''}><summary>${ic('arrowRight', 'i-sm')}<span>Handoff for the next agent</span><span class="hint">${ws.handoff ? `from ${esc(ws.handoffFrom || 'the last agent')} · updated ${esc(when(ws.handoffAt))} · saved as .astral/handoff.md` : 'Written after the first turn in this workspace.'}</span><span class="grow"></span><button class="btn ghost sm" data-act="handoff-refresh">${ic('refresh', 'i-sm')}<span>Refresh</span></button></summary><div class="handoff-body">${ws.handoff ? `<div class="md">${md(ws.handoff)}</div>` : '<div class="hint">No agent conversation here yet.</div>'}</div></details>`;
}
function renderScriptPage(ws, kind) {
  const page = $('page');
  page.dataset.kind = kind; page.dataset.ws = ws.id;
  const sc = scriptsFor(ws);
  const repo = S.repoOf(ws);
  const runs = Object.entries(sc.runs || {});
  const cmd = kind === 'setup' ? sc.setup : (sc.run || (runs[0] && runs[0][1].command) || '');
  page.innerHTML = `<div class="script-page">
    <div class="sp-head">${ic(kind === 'setup' ? 'wrench' : 'play')}<h2>${kind === 'setup' ? 'Setup script' : 'Run script'}</h2></div>
    <p class="sub">${kind === 'setup' ? 'Runs once after a workspace is created: install dependencies, generate files, link secrets. Astral copies files matching <code>.env*</code> from the repository into every new worktree first.' : 'Starts your app, server or test loop inside this workspace. <code>$CONDUCTOR_PORT</code> is a port reserved for this workspace, so several workspaces can run side by side.'}</p>
    ${cmd ? `<div class="cmd-box"><span class="mark">$</span><code>${esc(cmd)}</code></div>
      <div class="acts"><button class="btn primary" data-act="${kind === 'setup' ? 'run-setup' : 'run'}">${ic('play')}<span>${kind === 'setup' ? 'Run setup' : 'Run'}</span></button>${runs.length > 1 ? runs.map(([id, r]) => `<button class="btn" data-run-script="${esc(id)}">${ic(r.icon === 'server' ? 'server' : r.icon === 'test-tube' ? 'testTube' : 'play')}<span>${esc(id)}</span></button>`).join('') : ''}<button class="btn ghost" data-act="repo-settings">${ic('cog')}<span>Edit scripts</span></button></div>`
      : `<div class="panel-empty">No ${kind} script for ${esc(repo ? repo.name : 'this repository')} yet.<br><br><button class="btn primary" data-act="repo-settings">${ic('cog')}<span>Configure scripts</span></button></div>`}
    <div class="env-list"><div class="lbl">Environment</div>${Object.entries(envFor(ws)).filter(([k]) => k.startsWith('CONDUCTOR')).map(([k, v]) => `<div><code>${esc(k)}</code><span>${esc(v)}</span></div>`).join('')}</div>
  </div>`;
}

// ---------------------------------------------------------------- composer
function attachmentsFor(ws) { return [...(ws.comments || []).map((c) => ({ kind: 'comment', ...c })), ...((attach[ws.id]) || [])]; }
function takeAttachments(ws) { const a = attachmentsFor(ws); if (ws.comments.length) diff.clearComments(ws); attach[ws.id] = []; return a; }
function renderComposer(s, ws) {
  const wrap = $('composer-wrap');
  const st = chat.chatS(s.id);
  const atts = attachmentsFor(ws);
  const live = chat.isLive(s);
  const working = st.working;
  const modeTxt = state.ui.followUp === 'queue' ? 'Enter queues while working · Ctrl+Enter sends now' : 'Enter interrupts and sends · Ctrl+Enter queues';
  const prev = wrap.querySelector('#composer-input');
  const draft = prev ? prev.value : (composerDraft[s.id] || '');
  // the textarea is rebuilt below: keep focus and the caret where they were
  const hadFocus = !!prev && document.activeElement === prev; const caret = prev ? [prev.selectionStart, prev.selectionEnd] : null;
  wrap.innerHTML = `<div class="composer ${working ? 'is-working' : ''}">
    ${atts.length ? `<div class="atts">${atts.map((a) => a.kind === 'image'
      ? `<span class="att img" title="${esc(`${a.name} · ${a.w}×${a.h}`)}"><img src="${a.dataUrl}" alt=""><span>${esc(a.name)}</span><button class="x" data-att-remove="${esc(a.id)}" data-att-kind="image">${I.x}</button></span>`
      : `<span class="att" title="${esc(a.kind === 'comment' ? `${a.file}:${a.line}\n${a.text}` : a.path || '')}">${ic(a.kind === 'comment' ? 'message' : 'paperclip', 'i-sm')}<span>${esc(a.kind === 'comment' ? `${basename(a.file)}:${a.line} — ${a.text.slice(0, 40)}` : basename(a.path))}</span><button class="x" data-att-remove="${esc(a.id || a.path)}" data-att-kind="${a.kind}">${I.x}</button></span>`).join('')}<button class="att-clear" data-act="att-clear">clear</button></div>` : ''}
    ${st.queue.length ? `<div class="queue">${st.queue.map((q, i) => `<div class="q" data-q="${q.id}"><span class="n">${i + 1}</span><span class="qt" contenteditable="true" spellcheck="false" data-q-edit="${q.id}">${esc(q.text)}</span><button class="icon-btn sm" data-q-now="${q.id}" title="Send now">${ic('arrowUp', 'i-sm')}</button><button class="icon-btn sm" data-q-del="${q.id}" title="Remove">${ic('x', 'i-sm')}</button></div>`).join('')}<div class="qh">${st.queue.length} queued · sent when the agent is idle</div></div>` : ''}
    <textarea id="composer-input" rows="1" placeholder="${working ? 'Message Claude… (queues until the turn ends)' : live ? 'Message Claude…' : 'Send a message to start Claude in this workspace'}">${esc(draft)}</textarea>
    <div class="row">
      <button class="chip-btn" data-act="model" title="Model">${ic('cpu', 'i-sm')}<span>${esc(modelLabel('claude', modelOf(s)).replace('Default model', st.model ? st.model.replace(/^claude-/, '') : 'default'))}</span>${ic('chevronDown', 'i-sm')}</button>
      <button class="chip-btn ${(s.perm || 'auto') === 'plan' ? 'is-plan' : ''}" data-act="perm" title="Permission mode · Shift+Tab toggles plan">${ic((s.perm || 'auto') === 'plan' ? 'book' : 'check2', 'i-sm')}<span>${esc(permLabel(s.perm || 'auto'))}</span>${ic('chevronDown', 'i-sm')}</button>
      <button class="chip-btn ${s.effort ? 'is-set' : ''}" data-act="effort" title="Effort level · default follows your Claude settings">${ic('gauge', 'i-sm')}<span>${esc(effortLabel(s.effort))}</span>${ic('chevronDown', 'i-sm')}</button>
      <button class="chip-btn" data-act="attach-file" title="Attach files or images · paste or drop images too">${ic('paperclip', 'i-sm')}</button>
      <span class="grow"></span>
      <span class="hint">${live ? modeTxt : 'Enter to start'}</span>
      ${working ? `<button class="send stop" data-act="interrupt" title="Stop (Esc)">${ic('square')}</button>` : ''}<button class="send ${draft.trim() ? 'ready' : ''}" id="composer-send" title="Send (Enter)">${ic('arrowUp')}</button>
    </div></div>`;
  const ta = wrap.querySelector('#composer-input');
  autosize(ta);
  if (hadFocus && ta) { ta.focus(); try { ta.setSelectionRange(caret[0], caret[1]); } catch { /* ignore */ } }
}
function permLabel(p) { return { auto: 'Auto', acceptEdits: 'Accept edits', manual: 'Ask', plan: 'Plan', bypassPermissions: 'Bypass' }[p] || p; }
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
function effortLabel(e) { return e ? ({ xhigh: 'Extra high' }[e] || e[0].toUpperCase() + e.slice(1)) : 'Effort'; }
// Where Claude starts. Normally the workspace folder. With the home-folder option it
// starts in the home directory (so it sees the auto-memory built up there) and the
// workspace is added as a working directory with --add-dir.
function claudeLaunch(s) { return state.ui.claudeHome && PATHS.home ? { cwd: PATHS.home, addDir: s.cwd } : { cwd: s.cwd, addDir: null }; }
function autosize(ta) { if (!ta) return; ta.style.height = 'auto'; ta.style.height = Math.min(220, Math.max(24, ta.scrollHeight)) + 'px'; }
function focusInput() { const ta = $('composer-input'); if (ta && !ta.closest('[hidden]')) { ta.focus(); return; } const s = S.activeSession(); if (s && !chat.isChat(s) && state.view === 'workspace') tmMain.focus(s.id); }
function composerSend(opposite = false) {
  const ta = $('composer-input'); if (!ta) return;
  const s = S.activeSession(), ws = S.activeWorkspace();
  if (!s || !ws || !chat.isChat(s)) return;
  const text = expandPastes(s.id, ta.value.trim());
  const st = chat.chatS(s.id);
  if (!text) {
    // empty Enter approves the oldest pending permission, like Conductor's ↩
    const pend = st.msgs.find((m) => m.kind === 'perm' && !m.resolved);
    if (pend) chat.chatRespond(s, pend.request_id, true, pend.input, false);
    return;
  }
  const atts = takeAttachments(ws);
  ta.value = ''; composerDraft[s.id] = ''; autosize(ta);
  if (!chat.isLive(s)) chat.launchChat(s, { resume: !!s.agentSessionId, firstPrompt: text, attachments: atts });
  else if (chat.isBusy(s)) { const queueIt = !st.working || (state.ui.followUp === 'queue') !== opposite; if (queueIt) chat.queueAdd(s, text, atts); else chat.chatSteer(s, text, { attachments: atts }); }
  else chat.chatSend(s, text, { attachments: atts });
  S.touchWorkspace(ws.id);
  renderComposer(s, ws); focusInput();
}

// ---------------------------------------------------------------- drawer (terminal)
function drawerList(ws) { const base = [{ id: 'sh:' + ws.id, label: 'Terminal' }]; return base.concat((drawerTabs[ws.id] || []).filter((t) => t.id !== base[0].id)); }
function renderDrawer() {
  const d = $('drawer'), ws = S.activeWorkspace();
  const open = state.ui.drawerOpen && ws && state.view === 'workspace';
  d.hidden = !open;
  app.classList.toggle('drawer-big', !!(open && state.ui.drawerBig));
  d.style.setProperty('--drawer-h', (state.ui.drawerH || 240) + 'px');
  if (!open) { tmDrawer.hideAll(); return; }
  const tabs = drawerList(ws);
  const cur = drawerActive[ws.id] && tabs.some((t) => t.id === drawerActive[ws.id]) ? drawerActive[ws.id] : tabs[0].id;
  drawerActive[ws.id] = cur;
  $('drawer-bar').innerHTML = `<div class="dtabs">${tabs.map((t) => `<button class="dtab ${t.id === cur ? 'is-active' : ''}" data-dtab="${esc(t.id)}">${ic(t.id.startsWith('sh:') ? 'terminal' : t.id.startsWith('install:') ? 'download' : 'gitBranch', 'i-sm')}<span>${esc(t.label)}</span>${tmDrawer.isLive(t.id) ? '' : '<span class="dead">·</span>'}${t.id.startsWith('sh:') ? '' : `<span class="close" data-dtab-close="${esc(t.id)}">${I.x}</span>`}</button>`).join('')}<button class="dtab add" data-act="drawer-new" title="New terminal">${ic('plus', 'i-sm')}</button></div><span class="grow"></span>
    <button class="icon-btn sm" data-act="drawer-clear" title="Clear">${ic('refresh', 'i-sm')}</button><button class="icon-btn sm" data-act="drawer-big" title="Big terminal mode (Ctrl+Shift+T)">${ic(state.ui.drawerBig ? 'minimize' : 'maximize', 'i-sm')}</button><button class="icon-btn sm" data-act="toggle-drawer" title="Close (Ctrl+\`)">${ic('x', 'i-sm')}</button>`;
  if (!tmDrawer.has(cur)) { tmDrawer.create(cur, '#7ee787'); tmDrawer.show(cur); if (cur.startsWith('sh:')) tmDrawer.spawn(cur, { agent: 'shell', cwd: ws.path, env: envFor(ws) }); }
  else tmDrawer.show(cur);
}
function openDrawerTab(ws, id, label, launch) {
  drawerTabs[ws.id] = (drawerTabs[ws.id] || []).filter((t) => t.id !== id).concat({ id, label });
  drawerActive[ws.id] = id;
  // spawn before the drawer re-renders: renderDrawer creates a bare terminal for the
  // active tab, and a bare terminal would make this look already started
  if (!tmDrawer.has(id)) { tmDrawer.create(id, '#7ee787'); tmDrawer.spawn(id, launch); }
  S.setUi({ drawerOpen: true });
  renderDrawer();
}
function runInDrawer(ws, id, label, command) { openDrawerTab(ws, id, label, { agent: 'cmd', cwd: ws.path, command, env: envFor(ws) }); }

// setup / run scripts live in the main area under their tabs
async function runScript(ws, kind, scriptId = null) {
  const sc = scriptsFor(ws);
  const id = `${kind}:${ws.id}`;
  if (tmMain.isLive(id)) { await tmMain.kill(id); toast(`${kind === 'setup' ? 'Setup' : 'Run'} script stopped.`); S.emit('layout'); return; }
  let cmd = kind === 'setup' ? sc.setup : (scriptId && sc.runs[scriptId] ? sc.runs[scriptId].command : sc.run || (Object.values(sc.runs)[0] || {}).command);
  if (!cmd) { toast(`No ${kind} script configured. Set one in the repository settings.`, true); openRepoSettings(S.repoOf(ws)); return; }
  const cwd = scriptId && sc.runs[scriptId] && sc.runs[scriptId].cwd ? ws.path.replace(/[\\/]$/, '') + '\\' + sc.runs[scriptId].cwd : ws.path;
  wsTab[ws.id] = kind;
  if (tmMain.has(id)) await tmMain.destroy(id);
  tmMain.create(id, kind === 'setup' ? '#f59e0b' : '#22c55e');
  showOnly('term-main');
  await tmMain.spawn(id, { agent: 'cmd', cwd, command: cmd, env: envFor(ws) });
  if (kind === 'setup') { ws.lastSetup = Date.now(); S.save(); }
  S.emit('layout');
}

// ---------------------------------------------------------------- right panel
function renderPanelTabs() {
  const ws = S.activeWorkspace();
  const ch = ws ? state.changes[ws.id] : null;
  const n = ch && ch.ok ? ch.files.length : 0;
  const pr = ws && state.pr[ws.id] && state.pr[ws.id].pr;
  const failing = pr && pr.statusCheckRollup && pr.statusCheckRollup.some((c) => /FAIL|ERROR/i.test(c.conclusion || c.state || ''));
  const tabs = [['diff', 'gitCompare', 'Diff', n ? `<span class="n">${n}</span>` : ''], ['checks', 'checkCircle', 'Checks', failing ? '<span class="n bad">!</span>' : pr && pr.state === 'OPEN' ? `<span class="n">#${pr.number}</span>` : ''], ['files', 'files', 'Files', '']];
  $('panel-tabs').innerHTML = tabs.map(([k, icon, label, extra]) => `<button class="panel-tab ${state.ui.panelTab === k ? 'is-active' : ''}" data-panel-tab="${k}">${ic(icon, 'i-sm')}<span>${label}</span>${extra}</button>`).join('');
}
function renderPanel(kind) {
  renderPanelTabs();
  const ws = S.activeWorkspace();
  const body = $('panel-body');
  if (!state.ui.panelOpen) return;
  if (state.ui.panelTab === 'diff') { if (!['events', 'live', 'pr', 'versions', 'scripts'].includes(kind)) { body.dataset.kind = 'diff'; diff.renderPanel(body, ws); } }
  else if (state.ui.panelTab === 'checks') { if (!['events', 'changes', 'diffsel', 'versions', 'scripts'].includes(kind)) { body.dataset.kind = 'checks'; renderChecks(body, ws); } }
  else if (!['events', 'live', 'pr', 'changes', 'diffsel', 'versions', 'scripts'].includes(kind)) { body.dataset.kind = 'files'; renderFiles(body, ws ? ws.path : null); }
}
function checkIcon(c) {
  const s = (c.conclusion || c.state || c.bucket || '').toUpperCase();
  if (/SUCCESS|PASS/.test(s)) return `<span class="ck ok">${ic('checkCircle', 'i-sm')}</span>`;
  if (/FAIL|ERROR|CANCEL|TIMED/.test(s)) return `<span class="ck bad">${ic('xCircle', 'i-sm')}</span>`;
  if (/SKIP|NEUTRAL/.test(s)) return `<span class="ck skip">${ic('minus', 'i-sm')}</span>`;
  return `<span class="ck pending">${RUN()}</span>`;
}
function renderChecks(body, ws) {
  if (!ws) { body.innerHTML = `<div class="panel-empty">Open a workspace to see its git status, checks and pull request.</div>`; return; }
  const g = state.git[ws.path] || {};
  const p = state.pr[ws.id] || {};
  const pr = p.pr;
  const s = S.activeSession();
  const todos = s && chat.isChat(s) ? chat.chatS(s.id).todos : [];
  const scroll = body.scrollTop;
  const gitSec = `<div class="sec"><div class="sec-h">${ic('gitBranch', 'i-sm')}<span>Git</span><span class="grow"></span><button class="icon-btn sm" data-act="git-refresh" title="Refresh">${ic('refresh', 'i-sm')}</button></div>
    ${g.isRepo ? `<div class="kv"><span>Branch</span><b>${esc(g.branch)}</b></div><div class="kv"><span>Base</span><b>${esc(g.base || '—')}</b></div><div class="kv"><span>Upstream</span><b>${g.upstream ? esc(g.upstream) + (g.ahead || g.behind ? ` (↑${g.ahead} ↓${g.behind})` : '') : 'not pushed'}</b></div><div class="kv"><span>Working tree</span><b>${g.dirty ? `${g.dirty} changed` : 'clean'}</b></div>${g.head ? `<div class="kv"><span>Last commit</span><b title="${esc(g.head.subject)}">${esc(g.head.sha)} · ${esc(g.head.subject.slice(0, 44))}</b></div>` : ''}
      <div class="acts"><button class="btn" data-act="commit-push">${ic('gitCommit', 'i-sm')}<span>Commit &amp; push</span><kbd>Ctrl+Shift+Y</kbd></button><button class="btn ghost" data-act="pull-latest">${ic('arrowDown', 'i-sm')}<span>Pull latest from ${esc(g.base || 'main')}</span></button></div>`
      : `<div class="panel-empty small">${g.home ? 'Not a repository (the home folder is ignored).' : 'Not a git repository.'}</div>`}</div>`;
  let prSec;
  if (state.ghAvailable === false) prSec = `<div class="sec"><div class="sec-h">${ic('gitPullRequest', 'i-sm')}<span>Pull request</span></div><div class="panel-empty small">GitHub CLI (<code>gh</code>) is not installed, so Astral cannot create or track pull requests.<div class="acts"><button class="btn primary" data-act="install-gh">${ic('download', 'i-sm')}<span>Install GitHub CLI</span></button><button class="btn ghost" data-act="gh-recheck">Check again</button></div></div></div>`;
  else if (!g.isRepo) prSec = '';
  else if (!pr) prSec = `<div class="sec"><div class="sec-h">${ic('gitPullRequest', 'i-sm')}<span>Pull request</span></div><div class="panel-empty small">${p.error ? esc(p.error.split('\n')[0]) : 'No pull request for this branch yet.'}<div class="acts"><button class="btn primary" data-act="create-pr">${ic('gitPullRequest', 'i-sm')}<span>Create PR</span><kbd>Ctrl+Shift+P</kbd></button>${p.error && /auth|login/i.test(p.error) ? `<button class="btn" data-act="gh-login">${ic('user', 'i-sm')}<span>gh auth login</span></button>` : ''}</div></div></div>`;
  else {
    const checks = p.checks || [];
    const rollup = pr.statusCheckRollup || [];
    const items = checks.length ? checks : rollup.map((c) => ({ name: c.name || c.context || c.workflowName || 'check', state: c.conclusion || c.state, link: c.detailsUrl || c.targetUrl }));
    const failing = items.filter((c) => /FAIL|ERROR|CANCEL/i.test(c.state || c.conclusion || c.bucket || ''));
    const pending = items.filter((c) => /PENDING|IN_PROGRESS|QUEUED|WAITING|EXPECTED/i.test(c.state || c.bucket || '') && !/SUCCESS/i.test(c.conclusion || ''));
    const canMerge = pr.state === 'OPEN' && !pr.isDraft && !failing.length && !pending.length && pr.mergeable !== 'CONFLICTING';
    prSec = `<div class="sec"><div class="sec-h">${ic('gitPullRequest', 'i-sm')}<span>Pull request</span><span class="grow"></span><button class="icon-btn sm" data-act="pr-refresh" title="Refresh">${ic('refresh', 'i-sm')}</button></div>
      <div class="pr-card"><a class="pr-title" data-ext="${esc(pr.url)}" href="${esc(pr.url)}">#${pr.number} ${esc(pr.title)}</a>
        <div class="pr-meta"><span class="badge ${pr.state.toLowerCase()} ${pr.isDraft ? 'draft' : ''}">${pr.isDraft ? 'Draft' : pr.state === 'OPEN' ? 'Open' : pr.state === 'MERGED' ? 'Merged' : 'Closed'}</span><span>${esc(pr.headRefName)} → ${esc(pr.baseRefName)}</span><span class="stats"><span class="a">+${pr.additions || 0}</span><span class="d">−${pr.deletions || 0}</span></span>${pr.reviewDecision ? `<span class="badge ${pr.reviewDecision === 'APPROVED' ? 'ok' : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'bad' : ''}">${esc(pr.reviewDecision.toLowerCase().replace('_', ' '))}</span>` : ''}${pr.mergeable === 'CONFLICTING' ? '<span class="badge bad">conflicts</span>' : ''}</div>
        ${items.length ? `<div class="checks">${items.map((c) => `<div class="check">${checkIcon(c)}<span class="cn" title="${esc(c.description || '')}">${esc(c.name || c.workflow || 'check')}</span>${c.link ? `<a data-ext="${esc(c.link)}" href="${esc(c.link)}" class="cl">${ic('externalLink', 'i-sm')}</a>` : ''}</div>`).join('')}</div>` : '<div class="hint">No checks reported.</div>'}
        <div class="acts">
          ${pr.state === 'OPEN' ? (canMerge ? `<button class="btn primary" data-act="merge-pr">${ic('gitMerge', 'i-sm')}<span>Merge</span>${ic('chevronDown', 'i-sm')}</button>` : `<button class="btn" data-act="merge-pr" title="${failing.length ? 'Checks are failing' : pending.length ? 'Checks still running' : pr.isDraft ? 'Draft PR' : 'Not mergeable'}">${ic('gitMerge', 'i-sm')}<span>Merge…</span></button>`) : ''}
          ${pr.isDraft && pr.state === 'OPEN' ? `<button class="btn" data-act="pr-ready">${ic('check2', 'i-sm')}<span>Mark ready</span></button>` : ''}
          ${failing.length ? `<button class="btn warn" data-act="fix-checks">${ic('wrench', 'i-sm')}<span>Fix failing checks with Claude</span></button>` : ''}
          ${pr.mergeable === 'CONFLICTING' ? `<button class="btn warn" data-act="resolve-conflicts">${ic('gitMerge', 'i-sm')}<span>Ask Claude to resolve conflicts</span></button>` : ''}
          ${pr.state === 'MERGED' && !ws.archived ? `<button class="btn" data-act="archive">${ic('archive', 'i-sm')}<span>Archive workspace</span></button>` : ''}
          <a class="btn ghost" data-ext="${esc(pr.url)}" href="${esc(pr.url)}">${ic('externalLink', 'i-sm')}<span>Open on GitHub</span></a>
        </div></div></div>`;
  }
  const todoSec = todos.length ? `<div class="sec"><div class="sec-h">${ic('listTodo', 'i-sm')}<span>Todos</span><span class="n">${todos.filter((t) => t.status === 'completed').length}/${todos.length}</span></div><div class="todos">${todos.map((t) => `<div class="todo ${t.status}">${t.status === 'completed' ? ic('checkCircle', 'i-sm') : t.status === 'in_progress' ? RUN() : ic('circle', 'i-sm')}<span>${esc(t.status === 'in_progress' ? (t.activeForm || t.content) : t.content)}</span></div>`).join('')}</div></div>` : '';
  const comSec = ws.comments.length ? `<div class="sec"><div class="sec-h">${ic('message', 'i-sm')}<span>Review comments</span><span class="n">${ws.comments.length}</span></div><div class="hint">Attached to your next message. ${ws.comments.map((c) => `<div class="cline"><b>${esc(basename(c.file))}:${c.line}</b> ${esc(c.text)}</div>`).join('')}</div><div class="acts"><button class="btn primary" data-act="send-comments">${ic('send', 'i-sm')}<span>Send to the agent</span></button><button class="btn ghost" data-act="att-clear">Discard</button></div></div>` : '';
  const reviewSec = `<div class="sec"><div class="sec-h">${ic('eye', 'i-sm')}<span>Review</span></div><div class="hint">Ask an agent to read the diff and comment on bugs, risks and improvements without changing files.</div><div class="acts"><button class="btn" data-act="review">${ic('sparkles', 'i-sm')}<span>Review changes</span></button></div></div>`;
  body.innerHTML = gitSec + prSec + todoSec + comSec + reviewSec;
  body.scrollTop = scroll;
}

const treeOpen = new Set();
async function renderFiles(body, root) {
  if (!root) { body.innerHTML = `<div class="panel-empty">Open a workspace to browse its files.</div>`; return; }
  if (body.dataset.root === root && body.querySelector('#tree')) return;
  body.dataset.root = root;
  body.innerHTML = `<div class="tree"><div class="tree-root" title="${esc(root)}">${ic('folderOpen', 'i-sm')}<span>${esc(basename(root))}</span><span class="grow"></span><button class="icon-btn sm" data-act="folder-cwd" title="Open folder">${ic('externalLink', 'i-sm')}</button></div><div id="tree"></div></div>`;
  await fillTree($('tree'), root, 0);
}
async function fillTree(container, dir, depth) {
  const ents = await window.astral.fs.list(dir);
  container.innerHTML = ents.map((e) => {
    const full = dir.replace(/[\\/]$/, '') + '\\' + e.name;
    const open = treeOpen.has(full);
    return `<div class="tree-node ${open ? 'is-open' : ''}" data-path="${esc(full)}">
      <button class="tree-row ${e.dir ? (open ? 'is-open' : '') : 'file'}" data-tree="${e.dir ? 'dir' : 'file'}" style="padding-left:${8 + depth * 14}px">
        ${e.dir ? `<span class="chev">${I.chevronRight}</span>${ic(open ? 'folderOpen' : 'folder', 'i-sm')}` : `<span class="chev" style="visibility:hidden">${I.chevronRight}</span>${ic('file', 'i-sm')}`}
        <span class="f">${esc(e.name)}</span></button>
      ${e.dir ? '<div class="tree-children"></div>' : ''}</div>`;
  }).join('') || `<div class="panel-empty small">Empty folder.</div>`;
  for (const node of container.querySelectorAll(':scope > .tree-node.is-open')) await fillTree(node.querySelector('.tree-children'), node.dataset.path, depth + 1);
}
async function treeClick(row) {
  const node = row.closest('.tree-node');
  const p = node.dataset.path;
  if (row.dataset.tree === 'file') return openPreview(p);
  const open = !node.classList.contains('is-open');
  node.classList.toggle('is-open', open); row.classList.toggle('is-open', open);
  row.querySelector('.i-sm:not(.chev)').innerHTML = open ? I.folderOpen : I.folder;
  if (open) { treeOpen.add(p); const depth = Math.round((parseInt(row.style.paddingLeft) - 8) / 14); await fillTree(node.querySelector('.tree-children'), p, depth + 1); } else treeOpen.delete(p);
}

// ---- file preview ----
async function openPreview(file) {
  const pv = $('preview');
  pv.hidden = false;
  pv.innerHTML = `<div class="preview-head">${ic('file', 'i-sm')}<span class="path">${esc(file)}</span><span class="meta">loading…</span><button class="icon-btn sm" data-act="preview-open" title="Open in default editor">${ic('externalLink', 'i-sm')}</button><button class="icon-btn sm" data-act="preview-close" title="Close (Esc)">${ic('x', 'i-sm')}</button></div><div class="preview-body"></div>`;
  pv.dataset.file = file;
  const r = await window.astral.fs.read(file);
  if (pv.dataset.file !== file) return;
  const body = pv.querySelector('.preview-body'), meta = pv.querySelector('.meta');
  if (r.kind === 'image') { meta.textContent = kb(r.size); body.innerHTML = `<img src="${r.dataUrl}" alt="">`; return; }
  if (r.kind !== 'text') { meta.textContent = r.size ? kb(r.size) : ''; body.innerHTML = `<div class="plain">${r.kind === 'error' ? esc(r.error) : 'Binary file.'}</div>`; return; }
  const html = highlight(r.text, file);
  const lines = html.split('\n');
  meta.textContent = `${lines.length} lines · ${kb(r.size)}`;
  body.innerHTML = `<pre>${lines.map((l, i) => `<span class="ln">${i + 1}</span>${l}`).join('\n')}</pre>`;
}
function closePreview() { const pv = $('preview'); pv.hidden = true; pv.innerHTML = ''; delete pv.dataset.file; }

// ---------------------------------------------------------------- history & settings pages
// History: every Claude Code and Codex conversation on this machine, searchable
// and filterable by project; click one to continue it in a workspace. Archived
// workspaces sit underneath.
let convoCache = { at: 0, items: [] }, convoQuery = '', convoProject = 'all';
async function loadConvos(force = false) {
  if (!force && Date.now() - convoCache.at < 30000) return convoCache.items;
  try { convoCache = { at: Date.now(), items: await window.astral.agents.listAll() }; } catch { convoCache = { at: Date.now(), items: [] }; }
  return convoCache.items;
}
function renderHistory() {
  const page = $('page');
  page.dataset.kind = 'history'; delete page.dataset.ws;
  const archived = state.workspaces.filter((w) => w.archived).sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0));
  page.innerHTML = `<div class="page-inner history">
    <div class="page-head"><h2>Past conversations</h2><span class="sub">Every Claude Code and Codex conversation on this machine. Click one to continue it here.</span></div>
    <div class="convo-tools"><div class="search">${ic('search', 'i-sm')}<input id="convo-q" placeholder="Search titles, prompts, folders…" value="${esc(convoQuery)}"></div><select id="convo-project"><option value="all">All projects</option></select><button class="icon-btn sm" data-act="convo-refresh" title="Rescan">${ic('refresh', 'i-sm')}</button></div>
    <div class="convos" id="convo-list"><div class="hint">Scanning…</div></div>
    ${archived.length ? `<details class="archived"><summary>${ic('chevronRight', 'i-sm')}<span>Archived workspaces</span><span class="n">${archived.length}</span></summary><div class="hist">${archived.map((w) => { const r = S.repoOf(w); return `<div class="hrow"><span class="avatar">${esc((r ? r.name : '?').slice(0, 1).toUpperCase())}</span><div class="lines"><div class="t">${esc(w.branch || w.name)}</div><div class="s">${esc(w.name)} · ${esc(r ? r.name : 'unknown repo')} · archived ${esc(when(w.archivedAt))}</div></div><div class="acts"><button class="btn sm" data-restore="${w.id}">${ic('history', 'i-sm')}<span>Restore</span></button><button class="btn ghost sm" data-delete-ws="${w.id}">${ic('trash', 'i-sm')}<span>Delete</span></button></div></div>`; }).join('')}</div></details>` : ''}
  </div>`;
  const q = page.querySelector('#convo-q'), sel = page.querySelector('#convo-project');
  q.addEventListener('input', () => { convoQuery = q.value; renderConvoList(); });
  sel.addEventListener('change', () => { convoProject = sel.value; renderConvoList(); });
  loadConvos().then(() => { if (page.dataset.kind !== 'history') return; fillConvoProjects(); renderConvoList(); });
}
function fillConvoProjects() {
  const sel = $('convo-project'); if (!sel) return;
  const folders = [...new Set(convoCache.items.map((x) => x.cwd))].sort((a, b) => basename(a).localeCompare(basename(b)));
  sel.innerHTML = `<option value="all">All projects</option>` + folders.map((f) => `<option value="${esc(f)}" ${convoProject === f ? 'selected' : ''}>${esc(basename(f))}</option>`).join('');
  if (convoProject !== 'all' && !folders.includes(convoProject)) { convoProject = 'all'; sel.value = 'all'; }
}
function renderConvoList() {
  const el = $('convo-list'); if (!el) return;
  const needle = convoQuery.trim().toLowerCase();
  const items = convoCache.items.filter((x) => (convoProject === 'all' || x.cwd === convoProject) && (!needle || `${x.title || ''} ${x.firstPrompt || ''} ${x.lastPrompt || ''} ${x.cwd}`.toLowerCase().includes(needle)));
  if (!items.length) { el.innerHTML = `<div class="hint">${convoCache.items.length ? 'Nothing matches.' : 'No conversations found. Claude Code writes them to ~/.claude/projects, Codex to ~/.codex/sessions.'}</div>`; return; }
  el.innerHTML = items.slice(0, 400).map((x, i) => { const open = state.sessions.find((s) => s.agentSessionId === x.id); return `<button class="convo" data-convo="${i}"><span class="who">${ag(x.agent)}</span><span class="lines"><span class="t">${esc(x.title || x.firstPrompt || '(untitled)')}${open ? ' <span class="tag">open</span>' : ''}</span><span class="p">${esc(x.lastPrompt || x.firstPrompt || '')}</span><span class="s">${esc(basename(x.cwd))} · ${esc(when(x.updatedAt))}</span></span></button>`; }).join('');
  el.querySelectorAll('[data-convo]').forEach((b) => b.addEventListener('click', () => resumeConversation(items[+b.dataset.convo])));
}
// Continue a past conversation: in the workspace for its folder (added if unknown), as a new session
async function resumeConversation(x) {
  const open = state.sessions.find((s) => s.agentSessionId === x.id);
  if (open) { const w = S.workspaceOfSession(open.id); if (w) { S.setActiveWorkspace(w.id); S.setActiveChat(w.id, open.id); S.setView('workspace'); } return; }
  let ws = state.workspaces.find((w) => !w.archived && samePath(w.path, x.cwd));
  if (!ws) {
    let repo = state.repos.find((r) => samePath(r.path, x.cwd));
    if (!repo) { repo = S.addRepo(basename(x.cwd), x.cwd); await refreshGitFor(x.cwd); loadScripts(repo); toast(`Added ${basename(x.cwd)} as a repository.`); }
    const g = state.git[x.cwd] || {};
    ws = S.addWorkspace({ repoId: repo.id, name: 'local', path: x.cwd, branch: g.branch || null, local: true, port: allocPort() });
  }
  S.setActiveWorkspace(ws.id); S.setView('workspace');
  const agentId = x.agentId || x.agent;
  const s = S.addSession({ workspaceId: ws.id, name: (x.title || x.firstPrompt || agentOf(agentId).name).slice(0, 60), agent: agentId, cwd: ws.path, agentSessionId: x.id, transcript: x.file });
  if (agentId === 'claude' && !x.title) s.autoName = true;
  wsTab[ws.id] = 'chat';
  S.setActiveChat(ws.id, s.id);
  launch(s, { resume: true });
}

let pluginFilter = 'all';
function renderSettings() {
  const page = $('page');
  page.dataset.kind = 'settings'; delete page.dataset.ws;
  const tab = state.settingsTab || 'general';
  const nav = [['general', 'sliders', 'General'], ['repos', 'folder', 'Repositories'], ['agents', 'puzzle', 'Agents'], ['shortcuts', 'keyboard', 'Shortcuts']];
  let body = '';
  if (tab === 'general') {
    const seg = (key, opts) => `<div class="seg">${opts.map(([v, l, icon]) => `<button class="${state.ui[key] === v ? 'is-on' : ''}" data-ui="${key}" data-value="${v}">${icon ? ic(icon, 'i-sm') : ''}<span>${l}</span></button>`).join('')}</div>`;
    const tog = (key, label, sub) => `<div class="srow"><div><div class="sl">${label}</div><div class="ss">${sub}</div></div><button class="toggle ${state.ui[key] ? 'is-on' : ''}" data-ui-toggle="${key}"><span></span></button></div>`;
    body = `<div class="sgroup"><h3>Appearance</h3>
        <div class="srow"><div><div class="sl">Theme</div><div class="ss">Follow the system, or pick one.</div></div>${seg('theme', [['system', 'System', 'monitor'], ['light', 'Light', 'sun'], ['dark', 'Dark', 'moon']])}</div>
        <div class="srow"><div><div class="sl">Font</div><div class="ss">Interface text. Code always uses the monospace font.</div></div>${seg('font', [['system', 'System'], ['inter', 'Inter'], ['mono', 'Mono']])}</div>
        <div class="srow"><div><div class="sl">Skin</div><div class="ss">Terminal draws the whole app as if it were inside a terminal window running Claude Code: black, monospace, nothing filled, thin rules, ⏺ and ⎿ transcript markers, a ╭ prompt box. Nothing moves; only the styling changes.</div></div>${seg('skin', [['default', 'Default'], ['terminal', 'Terminal', 'terminal']])}</div></div>
      <div class="sgroup"><h3>Agents</h3>
        <div class="srow"><div><div class="sl">Follow-up behavior</div><div class="ss">What Enter does while the agent is working. Ctrl+Enter does the opposite.</div></div>${seg('followUp', [['queue', 'Queue'], ['steer', 'Interrupt']])}</div>
        ${tog('claudeHome', 'Start Claude Code in your home folder', `Claude keeps its auto-memory per start folder. On, Claude starts in <code>${esc(PATHS.home)}</code> and the workspace is added with --add-dir, so it sees the memory you built up there. Off, it starts in the workspace like a normal <code>claude</code> in that folder. Applies to newly started sessions.`)}
        ${tog('notifications', 'Notifications', 'Desktop notification when a turn finishes or an agent needs input while you are elsewhere.')}
        <div class="srow"><div><div class="sl">Sounds</div><div class="ss">A twinkle when an agent finishes while you are in another workspace.</div></div><div class="row-acts"><button class="btn ghost" data-act="sound-test">${ic('volume', 'i-sm')}<span>Test</span></button><button class="toggle ${state.ui.sounds ? 'is-on' : ''}" data-ui-toggle="sounds"><span></span></button></div></div></div>
      <div class="sgroup"><h3>Phone</h3>
        <div class="srow"><div><div class="sl">Control chats from your phone</div><div class="ss">Astral hosts a small website on this PC. Open it on your phone, enter the code, and you can pick a chat, send prompts, read replies, stop a turn and see previews of localhost pages. Your phone needs to reach this PC: the same Wi-Fi, or a private network like Tailscale. Windows may ask once to allow Astral through the firewall. While hosting, closing the Astral window keeps it running in the system tray; stop hosting from the tray icon or here.</div></div><button class="btn ${state.remote.enabled ? '' : 'primary'}" data-act="remote-toggle">${ic(state.remote.enabled ? 'square' : 'play', 'i-sm')}<span>${state.remote.enabled ? 'Stop hosting' : 'Start hosting'}</span></button></div>
        ${state.remote.enabled ? (state.remoteStatus && state.remoteStatus.running ? `<div class="srow"><div><div class="sl">Open on your phone</div><div class="ss">${(state.remoteStatus.addresses || []).length ? (state.remoteStatus.addresses || []).slice(0, 3).map((a) => `<div><code class="hosturl">${esc(a.url)}</code> <span class="hint">${esc(a.name)}</span></div>`).join('') : 'No network address found. Connect this PC to a network.'}</div></div><div class="row-acts"><button class="btn ghost" data-act="remote-copy">${ic('copy', 'i-sm')}<span>Copy link</span></button></div></div>
        <div class="srow"><div><div class="sl">Code</div><div class="ss">The page asks for this once per phone. Stop and start hosting for a new one.</div></div><div class="paircode">${esc(state.remoteStatus.code || '')}</div></div>` : `<div class="srow"><div><div class="sl">Not running</div><div class="ss">${esc((state.remoteStatus && state.remoteStatus.error) || 'Starting…')}</div></div></div>`) : ''}
        <div class="srow"><div><div class="sl">Internet access (port forwarding)</div><div class="ss">Reach the page away from home by forwarding a port on your router to this PC. No outside service is involved. With this on, the code becomes 8 characters, since the page is open to the internet.</div></div><button class="toggle ${state.remote.public ? 'is-on' : ''}" data-act="remote-public"><span></span></button></div>
        ${state.remote.public ? `<div class="srow"><div><div class="sl">From outside your home</div><div class="ss">${state.remotePublic && state.remotePublic.ok ? `<div><code class="hosturl">http://${esc(state.remotePublic.ip)}:${state.remote.port || 5175}</code> <span class="hint">your public address right now</span></div>` : `<div class="hint">${esc((state.remotePublic && state.remotePublic.error) || 'Looking up your public address…')}</div>`}<div class="hint" style="margin-top:6px">Your public address can change over time. A free dynamic DNS name (No-IP, DuckDNS) gives you one that stays put.</div></div></div><div class="row-acts"><button class="btn ghost" data-act="remote-copy-public">${ic('copy', 'i-sm')}<span>Copy link</span></button><button class="btn ghost" data-act="remote-recheck">${ic('refresh', 'i-sm')}<span>Recheck</span></button></div></div>
        <div class="srow"><div><div class="sl">Router setup</div><div class="ss"><ol class="steps-list"><li>Open your router's admin page (often <code>192.168.0.1</code> or <code>192.168.1.1</code>) and find <b>Port Forwarding</b>, sometimes under NAT, Virtual Server or Applications.</li><li>Add a rule: external port <b>${state.remote.port || 5175}</b>, protocol <b>TCP</b>, forwarded to this PC at <b>${esc((state.remoteStatus && state.remoteStatus.addresses && state.remoteStatus.addresses[0] && state.remoteStatus.addresses[0].address) || 'its local address')}</b>, internal port <b>${state.remote.port || 5175}</b>.</li><li>Give this PC a fixed local address in the router (DHCP reservation or static lease) so the rule keeps pointing at it.</li><li>If Windows asks, allow Astral through the firewall for private and public networks.</li><li>On your phone, turn Wi-Fi off and open the public address above with the 8-character code.</li></ol><div class="hint">If it never connects from outside, your ISP may use shared addressing (CGNAT) that blocks inbound connections. That cannot be fixed on your side; a private network such as Tailscale is the alternative.</div></div></div></div>` : ''}
        <div class="srow"><div><div class="sl">Site previews</div><div class="ss">Show a screenshot under any reply that mentions a localhost address. The Preview button on the phone works regardless.</div></div><button class="toggle ${state.remote.previews ? 'is-on' : ''}" data-act="remote-previews"><span></span></button></div></div>

        <div class="srow"><div><div class="sl">Sort workspaces</div><div class="ss">By last activity or by creation time.</div></div>${seg('sidebarSort', [['updated', 'Updated'], ['created', 'Created']])}</div></div>
      <div class="sgroup"><h3>Storage</h3><div class="srow"><div><div class="sl">Workspaces live in</div><div class="ss"><code>${esc(PATHS.workspacesRoot)}</code> — the same layout Conductor uses.</div></div><button class="btn ghost" data-open-path="${esc(PATHS.workspacesRoot)}">${ic('folder', 'i-sm')}<span>Open</span></button></div></div>`;
  } else if (tab === 'repos') {
    body = `<div class="sgroup"><div class="sg-head"><h3>Repositories</h3><span class="grow"></span><button class="btn" data-act="add-repo">${ic('folderPlus', 'i-sm')}<span>Add</span></button><button class="btn ghost" data-act="clone-repo">${ic('download', 'i-sm')}<span>Clone</span></button></div>
      ${state.repos.length ? state.repos.map((r) => renderRepoSettings(r)).join('') : '<div class="panel-empty">No repositories.</div>'}</div>`;
  } else if (tab === 'agents') body = renderAgents();
  else body = `<div class="sgroup"><h3>Keyboard shortcuts</h3><table class="kbd-table">${[
    ['New workspace', 'Ctrl+N'], ['Create from branch, PR or issue', 'Ctrl+Shift+N'], ['Search / command palette', 'Ctrl+K'], ['Diff viewer', 'Ctrl+Shift+D'], ['Checks & PR', 'Ctrl+Shift+C'], ['Files', 'Ctrl+Shift+E'],
    ['Create pull request', 'Ctrl+Shift+P'], ['Commit & push', 'Ctrl+Shift+Y'], ['Pull latest from base', 'Ctrl+Shift+L'], ['Run script', 'Ctrl+R'], ['Terminal drawer', 'Ctrl+`'], ['Big terminal mode', 'Ctrl+Shift+T'],
    ['Stop the agent', 'Ctrl+Shift+Backspace'], ['Interrupt the current turn', 'Esc (in composer)'], ['Submit with the opposite follow-up behavior', 'Ctrl+Enter'], ['Toggle plan mode', 'Shift+Tab (in composer)'], ['Approve pending permission', 'Enter on an empty composer'],
    ['Next workspace needing attention', 'Ctrl+Alt+L'], ['Previous / next workspace', 'Ctrl+Alt+↑ / ↓'], ['Workspace 1–9', 'Ctrl+1…9'], ['Next / previous chat tab', 'Ctrl+Tab / Ctrl+Shift+Tab'], ['Back / forward', 'Alt+← / →'],
    ['Resume a past conversation', 'Ctrl+Shift+R'], ['Toggle sidebar', 'Ctrl+B'], ['Toggle right panel', 'Ctrl+\\'], ['Settings', 'Ctrl+,'], ['Next / previous file in diff', 'J / K'], ['Mark file viewed', 'Ctrl+V (in diff)'],
  ].map(([a, k]) => `<tr><td>${esc(a)}</td><td><kbd>${esc(k)}</kbd></td></tr>`).join('')}</table></div>`;
  page.innerHTML = `<div class="settings"><nav class="snav">${nav.map(([k, icon, l]) => `<button class="${tab === k ? 'is-active' : ''}" data-settings-tab="${k}">${ic(icon, 'i-sm')}<span>${l}</span>${k === 'agents' && updateCount() ? `<span class="upd">${updateCount()}</span>` : ''}</button>`).join('')}</nav><div class="sbody">${body}</div></div>`;
}
function renderRepoSettings(r) {
  const sc = state.scripts[r.id];
  if (!sc) loadScripts(r);
  const g = state.git[r.path] || {};
  const runs = sc ? Object.entries(sc.runs || {}) : [];
  return `<div class="repo-card" data-repo-card="${r.id}">
    <div class="rc-head"><span class="avatar">${esc(r.name.slice(0, 1).toUpperCase())}</span><div><div class="t"><input class="inline" data-repo-name="${r.id}" value="${esc(r.name)}"></div><div class="s">${esc(r.path)}${g.remote ? ` · ${esc(g.remote)}` : ''}</div></div><span class="grow"></span><button class="btn ghost" data-open-path="${esc(r.path)}">${ic('folder', 'i-sm')}</button><button class="btn ghost danger" data-remove-repo="${r.id}">${ic('trash', 'i-sm')}<span>Remove</span></button></div>
    <div class="field"><label>Base branch <span class="hint">new workspaces branch from origin/&lt;base&gt;</span></label><input data-repo-base="${r.id}" value="${esc(r.base || g.base || '')}" placeholder="${esc(g.base || 'main')}"></div>
    ${sc ? `<div class="field"><label>Setup script <span class="hint">after a workspace is created</span></label><input data-script="setup" data-repo="${r.id}" value="${esc(sc.setup)}" placeholder="npm install"></div>
    <div class="field"><label>Run script <span class="hint">the Run button · $CONDUCTOR_PORT is reserved per workspace</span></label><input data-script="run" data-repo="${r.id}" value="${esc(sc.run)}" placeholder="npm run dev -- --port $env:CONDUCTOR_PORT"></div>
    <div class="field"><label>Archive script <span class="hint">before a workspace is archived</span></label><input data-script="archive" data-repo="${r.id}" value="${esc(sc.archive)}" placeholder="optional"></div>
    <div class="two"><div class="field"><label>Run mode</label><select data-script="run_mode" data-repo="${r.id}"><option value="concurrent" ${sc.run_mode === 'concurrent' ? 'selected' : ''}>Concurrent</option><option value="nonconcurrent" ${sc.run_mode !== 'concurrent' ? 'selected' : ''}>One at a time</option></select></div>
    <div class="field"><label>Copy into new worktrees <span class="hint">git-ignored files, comma separated</span></label><input data-script="file_include_globs" data-repo="${r.id}" value="${esc((sc.file_include_globs || []).join(', '))}"></div></div>
    <div class="field"><label>Extra run scripts <span class="hint">appear in the Run menu</span></label><div class="runs" data-runs="${r.id}">${runs.map(([id, x]) => `<div class="runrow"><input data-run-id value="${esc(id)}" placeholder="worker"><input data-run-cmd value="${esc(x.command)}" placeholder="npm run worker"><select data-run-icon><option value="play" ${x.icon === 'play' ? 'selected' : ''}>play</option><option value="server" ${x.icon === 'server' ? 'selected' : ''}>server</option><option value="test-tube" ${x.icon === 'test-tube' ? 'selected' : ''}>test-tube</option></select><button class="icon-btn sm" data-run-del title="Remove">${ic('x', 'i-sm')}</button></div>`).join('')}</div><button class="btn ghost sm" data-run-add="${r.id}">${ic('plus', 'i-sm')}<span>Add run script</span></button></div>
    <div class="acts"><button class="btn primary" data-save-scripts="${r.id}">${ic('check2', 'i-sm')}<span>Save to .conductor/settings.toml</span></button><span class="hint">${sc.hasFile ? 'Shared with your team when committed.' : 'Creates .conductor/settings.toml in the repository.'}</span></div>` : '<div class="hint">Reading scripts…</div>'}
  </div>`;
}
function renderAgents() {
  const u = updateCount();
  const list = REGISTRY.filter((r) => pluginFilter === 'all' || (pluginFilter === 'installed' && isInstalled(r.id)) || (pluginFilter === 'local' && r.local) || (pluginFilter === 'updates' && hasUpdate(r.id)));
  return `<div class="sgroup"><div class="sg-head"><h3>Agents</h3><span class="grow"></span><button class="btn ghost" data-act="check-versions">${ic('refresh', 'i-sm')}<span>Check for updates</span></button>${u ? `<button class="btn warn" data-act="update-all">${ic('arrowUpCircle', 'i-sm')}<span>Update all (${u})</span></button>` : ''}</div>
    <div class="ss">Every CLI is installed with its vendor's own command in a terminal and launched untouched. Astral never patches a harness.</div>
    <div class="filters">${[['all', 'All', REGISTRY.length], ['installed', 'Installed', REGISTRY.filter((r) => isInstalled(r.id)).length], ['updates', 'Updates', u], ['local', 'Local models', REGISTRY.filter((r) => r.local).length]].map(([k, l, n]) => `<button class="chip-btn ${pluginFilter === k ? 'is-active' : ''}" data-filter="${k}">${l}<span class="n">${n}</span></button>`).join('')}</div>
    <div class="plugin-grid">${list.map((r) => {
      const v = state.versions[r.id] || {};
      const inst = isInstalled(r.id), upd = hasUpdate(r.id);
      const inLauncher = state.launcherAgents.includes(r.id);
      const st = r.builtin ? 'built in' : !state.versionsAt ? 'checking…' : upd ? 'update available' : inst ? 'installed' : 'not installed';
      return `<div class="plugin" style="--ag-color:${r.color}">
        <div class="top"><span class="logo">${ag(r.id)}</span><div><div class="title">${esc(r.name)}</div><div class="vendor">${esc(r.vendor)}</div></div><span class="state ${upd ? 'upd' : inst ? 'ok' : ''}">${st}</span></div>
        <div><div class="desc">${esc(r.desc)}</div>
          <div class="ver">${v.installed ? `<span>installed <b>${esc(v.installed)}</b></span>` : ''}${v.latest ? `<span>latest <b>${esc(v.latest)}</b></span>` : ''}${hasModel(r) ? `<span>model <b>${esc(modelLabel(r.id, state.models[r.id]))}</b></span>` : ''}</div>
          ${r.launch ? `<div class="cmd"><span class="mark">$</span><input type="text" data-launch-cmd="${r.id}" value="${esc(launchCmd(r.id))}" spellcheck="false" title="Launch command. Edit to pass flags."></div>` : ''}</div>
        <div class="actions">
          ${r.builtin ? '' : !inst ? `<button class="btn primary" data-install="${r.id}">${ic('download', 'i-sm')}<span>Install</span></button>` : upd ? `<button class="btn warn" data-update="${r.id}">${ic('arrowUpCircle', 'i-sm')}<span>Update to ${esc(v.latest)}</span></button>` : (r.npm || r.pip || r.winget || r.install) ? `<button class="btn ghost" data-update="${r.id}">${ic('refresh', 'i-sm')}<span>Reinstall</span></button>` : ''}
          ${inst && hasModel(r) ? `<button class="btn ghost" data-model-for="${r.id}">${ic('cpu', 'i-sm')}<span>Model</span></button>` : ''}
          ${inst || r.builtin ? `<button class="btn ${inLauncher ? 'on' : 'ghost'}" data-toggle-launcher="${r.id}">${ic(inLauncher ? 'check2' : 'plus', 'i-sm')}<span>${inLauncher ? 'In new chat menu' : 'Add to new chat menu'}</span></button>` : ''}
        </div></div>`;
    }).join('')}
    <div class="plugin" style="--ag-color:#000"><div class="top"><span class="logo"><span class="ag">${I.circle}</span></span><div><div class="title">GitHub CLI</div><div class="vendor">GitHub</div></div><span class="state ${state.ghAvailable ? 'ok' : ''}">${state.ghAvailable === null ? 'checking…' : state.ghAvailable ? 'installed' : 'not installed'}</span></div><div><div class="desc">Needed for pull requests, checks and merging from the Checks tab. Log in once with gh auth login.</div></div><div class="actions">${state.ghAvailable ? `<button class="btn ghost" data-act="gh-login">${ic('user', 'i-sm')}<span>gh auth login</span></button>` : `<button class="btn primary" data-act="install-gh">${ic('download', 'i-sm')}<span>Install with winget</span></button>`}<button class="btn ghost" data-act="gh-recheck">${ic('refresh', 'i-sm')}<span>Check</span></button></div></div>
    </div></div>`;
}

// ---------------------------------------------------------------- layout & subscriptions
function renderLayout() {
  app.classList.toggle('side-closed', !state.ui.sidebarOpen);
  app.classList.toggle('panel-closed', !state.ui.panelOpen);
  applyTheme();
  renderDrawer();
  tmMain.scheduleFit(); tmDrawer.scheduleFit();
}
S.subscribe((kind) => {
  if (['all', 'repos', 'sessions', 'live', 'git', 'pr', 'changes', 'layout', 'versions', 'scripts'].includes(kind)) { renderSidebar(); renderTopbar(); renderTabs(); }
  if (['all', 'sessions', 'layout', 'versions', 'scripts'].includes(kind)) renderContent();
  if (kind === 'queue' || kind === 'comments') { const s = S.activeSession(), ws = S.activeWorkspace(); if (s && ws && chat.isChat(s) && !$('composer-wrap').hidden) renderComposer(s, ws); }
  if (['all', 'live', 'sessions', 'git', 'pr', 'changes', 'diffsel', 'comments', 'todos', 'panel', 'layout', 'versions'].includes(kind)) renderPanel(kind);
  if (kind === 'all' || kind === 'layout') renderLayout();
  if (kind === 'all') { refreshGit(true); refreshChanges(); }
  if (kind === 'versions' && state.view === 'settings' && state.settingsTab === 'agents') renderSettings();
});
bus.on('queue', () => S.emit('queue'));
bus.on('todos', () => S.emit('todos'));

// ---------------------------------------------------------------- launching agents
function buildCommand(s) {
  const r = agentOf(s.agent);
  if (s.command) return s.command;
  if (s.agent === 'shell') return null;
  if (s.agent === 'claude' || s.agent === 'codex') return null;
  return launchWith(r, launchCmd(s.agent), modelOf(s));
}
function modelArgsFor(s) { const r = agentOf(s.agent), m = modelOf(s); const parts = []; if ((s.agent === 'claude' || s.agent === 'codex') && m && r.modelFlag) parts.push(`${r.modelFlag} ${m}`); if (s.agent === 'claude' && s.effort) parts.push(`--effort ${s.effort}`); return parts.length ? parts.join(' ') : null; }
async function launch(s, { resume = false, firstPrompt = null, attachments = [] } = {}) {
  const ws = S.workspaceOfSession(s.id);
  if (chat.isChat(s)) return chat.launchChat(s, { resume, firstPrompt, attachments });
  if (tmMain.isLive(s.id)) { tmMain.show(s.id); if (firstPrompt) sendWhenReady(s, firstPrompt); return; }
  const a = agentOf(s.agent);
  if (s.agent === 'claude' && !s.agentSessionId) S.bindAgentSession(s.id, S.uid());
  if (s.agent === 'codex' && !resume) S.bindAgentSession(s.id, null);
  tmMain.create(s.id, a.color);
  const where = s.agent === 'claude' ? claudeLaunch(s) : { cwd: s.cwd, addDir: null };
  const r = await tmMain.spawn(s.id, { agent: s.agent, cwd: where.cwd, addDir: where.addDir, agentSessionId: s.agentSessionId, resume: resume && !!s.agentSessionId, command: buildCommand(s), modelArgs: modelArgsFor(s), env: ws ? envFor(ws) : {} }, a.color);
  if (!r.ok) { toast(`Could not start: ${r.error}`, true); S.setLive(s.id, 'dead'); return; }
  S.setLive(s.id, 'idle');
  if (a.telemetry) { state.events[s.id] = []; window.astral.agents.watch({ sessionId: s.id, agent: a.telemetry, cwd: where.cwd, agentSessionId: s.agentSessionId, file: s.transcript, launchedAt: Date.now() }); }
  if (firstPrompt) sendWhenReady(s, firstPrompt);
}
// Type a prompt into a terminal agent once it is ready: after the CLI has produced
// output and then been quiet for a moment (a TUI has finished drawing its input
// box). A fixed delay either typed into a half-started CLI or waited needlessly.
function sendWhenReady(s, text) {
  const started = Date.now(); const minWait = s.agent === 'shell' ? 600 : 1500; const quiet = 700; const maxWait = 20000;
  const tick = () => {
    if (!tmMain.isLive(s.id)) return;
    const l = state.live[s.id] || {}; const now = Date.now();
    const ready = l.lastOutput && now - l.lastOutput >= quiet && now - started >= minWait;
    if (ready || now - started > maxWait) { tmMain.write(s.id, text); setTimeout(() => tmMain.write(s.id, '\r'), 250); return; }
    setTimeout(tick, 150);
  };
  setTimeout(tick, 300);
}
// When a workspace already has an agent conversation, a new agent gets a brief of
// it (written by the main process from the transcript into .astral/handoff.md) and
// is told to read it first, so it continues the work instead of starting cold.
// The workspace's handoff: a brief of the latest agent conversation here plus the
// user's Notes, written to .astral/handoff.md and kept on the workspace for the
// Notes tab. Refreshed after every turn, so it is always ready for the next agent.
function latestAgentSession(ws) { return S.workspaceSessions(ws.id).filter((x) => x.agentSessionId && (x.agent === 'claude' || x.agent === 'codex')).sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0))[0] || null; }
async function updateHandoff(ws) {
  const prev = latestAgentSession(ws);
  if (!prev) return null;
  let r = null;
  try { r = await window.astral.agents.handoff({ agent: prev.agent, cwd: prev.cwd, agentSessionId: prev.agentSessionId, file: prev.transcript || null, agentName: agentOf(prev.agent).name, notes: ws.notes || '' }); } catch { /* none */ }
  if (!r || !r.ok) return null;
  ws.handoff = r.md; ws.handoffFrom = agentOf(prev.agent).name; ws.handoffAt = Date.now(); S.save();
  renderHandoffBox(ws);
  return { ...r, prev };
}
async function handoffPrompt(ws, prompt) {
  const r = await updateHandoff(ws);
  if (!r) return prompt;
  const lead = `Before anything else, read ${r.rel} in this folder. It summarizes what ${agentOf(r.prev.agent).name} did in this workspace so far (what was asked, files changed, where things stand) and carries the user's notes, so you can continue the work rather than start over.`;
  return prompt ? `${lead}\n\n${prompt}` : `${lead} Then tell me briefly what state the project is in and wait for my instructions.`;
}
function newChat(ws, agent, { prompt = null, perm = null, name = null, mode = null, attachments = [], handoff = true } = {}) {
  const a = agentOf(agent);
  const n = S.workspaceSessions(ws.id).filter((x) => x.agent === agent).length;
  const s = S.addSession({ workspaceId: ws.id, name: name || (n ? `${a.name} ${n + 1}` : a.name), agent, cwd: ws.path, perm, mode });
  if (agent === 'claude' && !name) s.autoName = true;
  wsTab[ws.id] = 'chat';
  S.setActiveChat(ws.id, s.id);
  (handoff && agent !== 'shell' ? handoffPrompt(ws, prompt) : Promise.resolve(prompt)).then((p) => launch(s, { firstPrompt: p, attachments }));
  return s;
}
function newChatMenu(el) {
  const ws = S.activeWorkspace(); if (!ws) return;
  const items = REGISTRY.filter((r) => isInstalled(r.id) && (state.launcherAgents.includes(r.id) || r.id === 'claude')).map((r) => ({ label: r.name, agent: r.id, sub: r.id === 'claude' ? 'chat UI' : '', run: () => newChat(ws, r.id) }));
  items.push('-', { label: 'Claude Code (terminal UI)', agent: 'claude', run: () => newChat(ws, 'claude', { mode: 'terminal' }) }, { label: 'Shell', icon: 'terminal', run: () => newChat(ws, 'shell') }, '-', { label: 'Resume a past conversation…', icon: 'history', run: openResume }, { label: 'More agents…', icon: 'puzzle', run: () => S.setView('settings', { settingsTab: 'agents' }) });
  menuAt(el, items);
}
async function closeChat(s) {
  if (chat.isLive(s) && !(await confirmModal(`Close “${s.name}”?`, 'The agent process stops. The conversation can be resumed later.', { ok: 'Close' }))) return;
  if (chat.isChat(s)) await chat.stopChat(s); else await tmMain.kill(s.id);
  await tmMain.destroy(s.id);
  window.astral.agents.unwatch(s.id);
  S.removeSession(s.id);
}
async function stopAny(s) { if (chat.isChat(s)) await chat.stopChat(s); else await tmMain.kill(s.id); S.setLive(s.id, 'dead'); }
async function switchMode(s) {
  await stopAny(s); await tmMain.destroy(s.id); delete state.chat[s.id];
  s.mode = chat.isChat(s) ? 'terminal' : 'chat'; S.save();
  toast(s.mode === 'chat' ? 'Chat UI: Astral draws the conversation.' : "Terminal UI: Claude Code's own interface."); S.emit('sessions');
}

// ---------------------------------------------------------------- workspaces
async function createWorkspace({ repo, agent = 'claude', prompt = null, isolate = true, base = null, fromBranch = null, branchName = null, model = null, attachments = [] }) {
  if (!repo) return null;
  const g = state.git[repo.path] || (await refreshGitFor(repo.path));
  let ws;
  if (isolate && g && g.isRepo) {
    const taken = state.workspaces.filter((w) => w.repoId === repo.id).map((w) => w.name);
    const name = pickCity(taken);
    const dest = `${PATHS.workspacesRoot}\\${slug(repo.name, 60) || 'repo'}\\${name}`;
    let branch = fromBranch || slug(branchName || prompt || '', 48) || name;
    if (!fromBranch) { const existing = new Set((await window.astral.git.branches(repo.path)).map((b) => b.name.replace(/^origin\//, ''))); let b = branch, n = 2; while (existing.has(b)) b = `${branch}-${n++}`; branch = b; }
    toast(`Creating workspace ${name} on ${branch}…`);
    const sc = await loadScripts(repo);
    const r = await window.astral.git.worktreeAdd({ root: repo.path, dest, branch, base: base || repo.base || g.base, existing: !!fromBranch, includes: sc ? sc.file_include_globs : null });
    if (!r.ok) { toast(`Could not create the worktree: ${r.error}`, true); return null; }
    ws = S.addWorkspace({ repoId: repo.id, name, path: r.path, branch, local: false, port: allocPort() });
    if (r.copied && r.copied.length) toast(`Copied ${r.copied.join(', ')} into the workspace.`);
    S.setActiveWorkspace(ws.id);
    refreshGitFor(ws.path);
    if (sc && sc.setup) { runScript(ws, 'setup'); if (sc.auto_run_after_setup && sc.run) setTimeout(() => runScript(ws, 'run'), 1500); }
  } else {
    ws = state.workspaces.find((w) => w.repoId === repo.id && w.local && !w.archived) || S.addWorkspace({ repoId: repo.id, name: 'local', path: repo.path, branch: g && g.branch, local: true, port: allocPort() });
    S.setActiveWorkspace(ws.id);
  }
  if (agent) { const s = newChat(ws, agent, { prompt, attachments }); if (model) { s.model = model; S.save(); } }
  return ws;
}
async function newWorkspaceDialog({ from = false, repo = null } = {}) {
  if (!state.repos.length) return addRepoDialog();
  const cur = repo || S.activeRepo() || state.repos[0];
  let agent = isInstalled('claude') ? 'claude' : (REGISTRY.find((r) => isInstalled(r.id) && r.id !== 'shell') || { id: 'shell' }).id;
  const agents = REGISTRY.filter((r) => isInstalled(r.id) && r.id !== 'shell');
  const m = modal(`<h3>New workspace</h3><p class="sub">A fresh branch in its own worktree. Agents work there without touching your checkout or other workspaces.</p>
    <div class="two"><div class="field"><label>Repository</label><select id="nw-repo">${state.repos.map((r) => `<option value="${r.id}" ${r.id === cur.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></div>
    <div class="field"><label>Start from</label><select id="nw-from"><option value="">Loading branches…</option></select></div></div>
    <div class="field"><label>Prompt <span class="hint">optional · also names the branch</span></label><textarea id="nw-prompt" placeholder="What should the agent do in this workspace?"></textarea></div>
    <div class="two"><div class="field"><label>Agent</label><select id="nw-agent">${agents.map((r) => `<option value="${r.id}" ${r.id === agent ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}<option value="">No agent yet</option></select></div>
    <div class="field"><label>Branch name <span class="hint">optional</span></label><input id="nw-branch" placeholder="derived from the prompt"></div></div>
    <div class="field"><label class="check"><input type="checkbox" id="nw-iso" checked> Isolated worktree (uncheck to work in the repository folder itself)</label></div>
    <div class="modal-actions"><span class="hint" id="nw-hint" style="margin-right:auto;align-self:center"></span><button class="btn ghost" id="nw-cancel">Cancel</button><button class="btn primary" id="nw-ok">Create workspace</button></div>`);
  const repoSel = m.el.querySelector('#nw-repo'), fromSel = m.el.querySelector('#nw-from'), promptTa = m.el.querySelector('#nw-prompt'), agentSel = m.el.querySelector('#nw-agent'), branchInp = m.el.querySelector('#nw-branch'), iso = m.el.querySelector('#nw-iso'), hint = m.el.querySelector('#nw-hint');
  const fillFrom = async () => {
    const repo = state.repos.find((r) => r.id === repoSel.value);
    const g = state.git[repo.path] || (await refreshGitFor(repo.path));
    const base = repo.base || (g && g.base) || 'main';
    const branches = g && g.isRepo ? await window.astral.git.branches(repo.path) : [];
    let prs = [];
    if (state.ghAvailable && g && g.remote) { const r = await window.astral.gh.prList(repo.path); if (r.ok) prs = r.prs; }
    fromSel.innerHTML = `<option value="">${esc(base)} (latest, new branch)</option>` + (branches.length ? `<optgroup label="Existing branches">${branches.filter((b) => !b.remote && !b.worktree).map((b) => `<option value="branch:${esc(b.name)}">${esc(b.name)} · ${esc(b.when)}</option>`).join('')}</optgroup>` : '') + (prs.length ? `<optgroup label="Pull requests">${prs.map((p) => `<option value="branch:${esc(p.headRefName)}" data-title="${esc(p.title)}">#${p.number} ${esc(p.title)}</option>`).join('')}</optgroup>` : '');
    if (!g || !g.isRepo) { iso.checked = false; iso.disabled = true; hint.textContent = 'Not a git repository: the workspace uses the folder directly.'; } else { if (iso.disabled) iso.checked = true; iso.disabled = false; hint.textContent = ''; }
    if (from) fromSel.focus();
  };
  repoSel.addEventListener('change', fillFrom); fillFrom();
  m.el.querySelector('#nw-cancel').onclick = m.close;
  const ok = async () => {
    const repo = state.repos.find((r) => r.id === repoSel.value);
    const v = fromSel.value;
    m.el.querySelector('#nw-ok').disabled = true;
    const ws = await createWorkspace({ repo, agent: agentSel.value || null, prompt: promptTa.value.trim() || null, isolate: iso.checked, fromBranch: v.startsWith('branch:') ? v.slice(7) : null, branchName: branchInp.value.trim() || null });
    if (ws) m.close(); else m.el.querySelector('#nw-ok').disabled = false;
  };
  m.el.querySelector('#nw-ok').onclick = ok;
  m.el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.target.tagName === 'INPUT')) { e.preventDefault(); ok(); } });
  if (!from) promptTa.focus();
}
async function archiveWorkspace(ws, { silent = false } = {}) {
  const repo = S.repoOf(ws);
  if (!silent && !(await confirmModal(`Archive ${ws.name}?`, ws.local ? 'Chats close. Nothing on disk changes.' : `Chats close and the worktree at ${ws.path} is removed. Branch ${ws.branch} is kept and the workspace can be restored from History.`, { ok: 'Archive' }))) return false;
  const sc = scriptsFor(ws);
  if (sc.archive && !ws.local) runInDrawer(ws, 'git:archive:' + ws.id, 'Archive script', sc.archive);
  for (const s of S.workspaceSessions(ws.id)) { await stopAny(s); await tmMain.destroy(s.id); window.astral.agents.unwatch(s.id); }
  for (const id of [...(drawerTabs[ws.id] || []).map((t) => t.id), 'sh:' + ws.id, 'run:' + ws.id, 'setup:' + ws.id]) { if (tmDrawer.has(id)) await tmDrawer.destroy(id); if (tmMain.has(id)) await tmMain.destroy(id); }
  if (!ws.local && repo) {
    // processes that had the worktree as their cwd are still winding down
    let r = null;
    for (let i = 0; i < 4; i++) { await new Promise((res) => setTimeout(res, 900)); r = await window.astral.git.worktreeRemove(repo.path, ws.path); if (r.ok) break; }
    if (r && !r.ok && !silent) toast(`Worktree kept: ${r.error.split('\n').pop()}`, true);
  }
  S.archiveWorkspace(ws.id, true);
  toast(`${ws.name} archived.`);
  return true;
}
async function restoreWorkspace(ws) {
  const repo = S.repoOf(ws);
  if (!repo) { toast('The repository for this workspace is gone.', true); return; }
  if (ws.local) { S.archiveWorkspace(ws.id, false); S.setActiveWorkspace(ws.id); return; }
  toast(`Restoring ${ws.name}…`);
  const sc = await loadScripts(repo);
  const present = (await window.astral.git.worktreeList(repo.path)).some((w) => samePath(w.path, ws.path));
  if (!present) {
    const r = await window.astral.git.worktreeAdd({ root: repo.path, dest: ws.path, branch: ws.branch, existing: true, includes: sc ? sc.file_include_globs : null });
    if (!r.ok) { toast(`Could not restore: ${r.error.split('\n').pop()}`, true); return; }
  }
  S.archiveWorkspace(ws.id, false); S.setActiveWorkspace(ws.id);
  if (sc && sc.setup) runScript(ws, 'setup');
}
async function deleteWorkspace(ws) {
  const repo = S.repoOf(ws);
  if (!(await confirmModal(`Delete ${ws.name} for good?`, ws.branch && !ws.local ? `Branch ${ws.branch} is deleted too, unless it is checked out elsewhere.` : 'The workspace is removed from Astral.', { ok: 'Delete' }))) return;
  if (!ws.archived) await archiveWorkspace(ws, { silent: true });
  if (ws.branch && !ws.local && repo) await window.astral.git.deleteBranch(repo.path, ws.branch);
  S.removeWorkspace(ws.id);
}
async function forkWorkspace(ws) {
  const repo = S.repoOf(ws); if (!repo) return;
  const g = state.git[ws.path] || {};
  await createWorkspace({ repo, agent: null, isolate: true, base: g.branch || ws.branch, branchName: `${ws.branch || ws.name}-fork` });
  toast('Forked. The new workspace starts from this branch.');
}
async function renameBranch(ws) {
  const g = state.git[ws.path] || {};
  const v = await promptModal('Rename branch', g.branch || '', { ok: 'Rename' });
  if (!v || v === g.branch) return;
  const r = await window.astral.git.renameBranch(ws.path, v);
  if (!r.ok) { toast(`Could not rename: ${r.error}`, true); return; }
  ws.branch = v; S.save(); refreshGitFor(ws.path); toast(`Branch renamed to ${v}.`);
}
async function pullLatest(ws) {
  const g = state.git[ws.path] || {};
  const repo = S.repoOf(ws);
  const base = (repo && repo.base) || g.base || 'main';
  toast(`Fetching and rebasing on origin/${base}…`);
  const r = await window.astral.git.pullLatest(ws.path, base);
  if (r.ok) { toast(`Up to date with origin/${base}.`); refreshGitFor(ws.path); refreshChanges(true); return; }
  if (r.conflict) {
    if (await confirmModal('Rebase hit conflicts', 'The rebase was aborted. Ask Claude to resolve the conflicts in a new chat?', { ok: 'Ask Claude', danger: false })) newChat(ws, 'claude', { prompt: `Rebase this branch onto origin/${base} (run: git fetch origin && git rebase origin/${base}). Resolve every merge conflict carefully, keeping the intent of both sides, then continue the rebase until it completes. Explain what you changed.`, name: 'Resolve conflicts' });
    return;
  }
  toast(`Pull failed: ${r.error}`, true);
}
async function commitPushDialog(ws) {
  let g = state.git[ws.path] || (await refreshGitFor(ws.path));
  if (!g || !g.isRepo) {
    const ok = await confirmModal('Not a git repository', `<p>${esc(basename(ws.path))} is not a git repository yet. Initialise one here so the changes can be committed?</p>`, { ok: 'Initialise repository', danger: false });
    if (!ok) return;
    const r = await window.astral.git.init(ws.path);
    if (!r.ok) { toast(`git init failed: ${r.error}`, true); return; }
    g = await refreshGitFor(ws.path); refreshChanges(true);
  }
  const s = S.activeSession();
  const last = s && chat.isChat(s) ? [...chat.chatS(s.id).msgs].reverse().find((m) => m.kind === 'user') : null;
  const m = modal(`<h3>Commit &amp; push</h3><p class="sub">Commits everything in the working tree directly, without going through the agent, and pushes the branch.</p>
    <div class="field"><label>Message</label><textarea id="cp-msg" placeholder="Describe the change">${esc(last ? last.text.slice(0, 72) : '')}</textarea></div>
    <div class="modal-actions"><button class="btn ghost" id="cp-cancel">Cancel</button><button class="btn" id="cp-commit">Commit only</button><button class="btn primary" id="cp-push">Commit &amp; push</button></div>`);
  const msg = m.el.querySelector('#cp-msg'); msg.focus(); msg.select();
  const go = async (push) => {
    const text = msg.value.trim(); if (!text) { msg.focus(); return; }
    m.close(); toast(push ? 'Committing and pushing…' : 'Committing…');
    let r = await window.astral.git.commitPush(ws.path, text, push);
    if (!r.ok && push && /no configured push destination|'origin' does not appear|does not appear to be a git repository|No such remote|fatal: No remote/i.test(r.error)) {
      const url = await promptModal('This repository has no origin remote. Paste the GitHub repository URL to push to', `https://github.com/`, { ok: 'Add remote and push' });
      if (url === null) { toast(r.committed ? 'Committed. Not pushed: no remote.' : 'Not pushed: no remote.', true); refreshGitFor(ws.path); refreshChanges(true); return; }
      const a = await window.astral.git.remoteAdd(ws.path, url.trim());
      if (!a.ok) { toast(`Could not add remote: ${a.error.split('\n').pop()}`, true); return; }
      r = await window.astral.git.commitPush(ws.path, text, true);
    }
    if (!r.ok) { toast(`Failed: ${r.error.split('\n').pop()}`, true); return; }
    toast(r.committed ? (push ? 'Committed and pushed.' : 'Committed.') : (push ? 'Nothing new to commit; pushed.' : 'Nothing to commit.'));
    refreshGitFor(ws.path); refreshChanges(true); refreshPR(ws, true);
  };
  m.el.querySelector('#cp-cancel').onclick = m.close;
  m.el.querySelector('#cp-commit').onclick = () => go(false);
  m.el.querySelector('#cp-push').onclick = () => go(true);
  msg.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.ctrlKey) go(true); });
}

// ---- pull requests ----
async function ensureGh() {
  if (state.ghAvailable === null) state.ghAvailable = await window.astral.gh.available();
  if (!state.ghAvailable) { toast('GitHub CLI (gh) is not installed. Install it from Settings → Agents.', true); S.setUi({ panelOpen: true, panelTab: 'checks' }); S.emit('panel'); return false; }
  return true;
}
async function createPRDialog(ws) {
  if (!(await ensureGh())) return;
  const g = state.git[ws.path] || (await refreshGitFor(ws.path));
  if (!g || !g.isRepo) { toast('Not a git repository.', true); return; }
  if (!g.remote) { toast('This repository has no origin remote to push to.', true); return; }
  const repo = S.repoOf(ws);
  const base = (repo && repo.base) || g.base || 'main';
  const m = modal(`<h3>Create pull request</h3><p class="sub">${esc(g.branch)} → ${esc(base)}. ${g.dirty ? `${g.dirty} uncommitted change${g.dirty === 1 ? '' : 's'} will be committed first.` : ''}</p>
    <div class="field"><label>Title</label><input id="pr-title" placeholder="Drafting a title…"></div>
    <div class="field"><label>Description</label><textarea id="pr-body" style="min-height:160px" placeholder="Drafting a description from the diff…"></textarea></div>
    <div class="field"><label class="check"><input type="checkbox" id="pr-draft"> Open as a draft</label></div>
    <div class="modal-actions"><span class="hint" id="pr-hint" style="margin-right:auto;align-self:center">${RUN()} Asking Claude to draft the PR…</span><button class="btn ghost" id="pr-cancel">Cancel</button><button class="btn primary" id="pr-ok">Create pull request</button></div>`);
  const title = m.el.querySelector('#pr-title'), body = m.el.querySelector('#pr-body'), hint = m.el.querySelector('#pr-hint');
  title.value = (g.branch || '').replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  m.el.querySelector('#pr-cancel').onclick = m.close;
  let closed = false; m.ov.addEventListener('mousedown', (e) => { if (e.target === m.ov) closed = true; });
  (async () => {
    const log = await window.astral.git.log(ws.path, 30, `${base}..HEAD`).catch(() => []);
    const ch = await window.astral.git.changes(ws.path, await mergeBaseOrHead(ws, base));
    const stat = ch && ch.ok ? ch.files.slice(0, 60).map((f) => `${f.kind} ${f.path} (+${f.add} -${f.del})`).join('\n') : '';
    const r = await window.astral.ai.oneshot({ cwd: ws.path, prompt: `Draft a GitHub pull request for the current branch. Base branch: ${base}. Branch: ${g.branch}.\n\nCommits on the branch:\n${log.map((c) => `- ${c.subject}`).join('\n') || '(none yet; uncommitted work)'}\n\nChanged files:\n${stat || '(unknown)'}\n\nRead the diff with git if you need detail (git diff ${base}...HEAD and git diff). Respond with exactly this format and nothing else:\nTITLE: <one line, under 70 characters, imperative mood>\nBODY:\n<markdown description: a short summary paragraph, then a "## Changes" bullet list, then "## Testing" notes>` });
    if (closed) return;
    if (r.ok && /TITLE:/.test(r.text)) {
      const t = /TITLE:\s*(.+)/.exec(r.text); const b = r.text.split(/BODY:\s*/)[1] || '';
      if (t) title.value = t[1].trim().replace(/^["']|["']$/g, '');
      body.value = b.trim();
      hint.textContent = 'Drafted by Claude. Edit freely.';
    } else hint.textContent = r.ok ? 'Draft came back in an unexpected shape; write your own.' : `Could not draft: ${r.error}`;
  })();
  const ok = async () => {
    const t = title.value.trim(); if (!t) { title.focus(); return; }
    m.el.querySelector('#pr-ok').disabled = true; hint.innerHTML = `${RUN()} Pushing and creating…`;
    const c = await window.astral.git.commitPush(ws.path, t, true);
    if (!c.ok) { hint.textContent = `Push failed: ${c.error.split('\n').pop()}`; m.el.querySelector('#pr-ok').disabled = false; return; }
    const r = await window.astral.gh.prCreate(ws.path, { title: t, body: body.value, draft: m.el.querySelector('#pr-draft').checked, base });
    if (!r.ok) { hint.textContent = r.error.split('\n').pop(); m.el.querySelector('#pr-ok').disabled = false; return; }
    m.close(); toast(`Pull request created${r.url ? ': ' + r.url : ''}.`);
    S.setUi({ panelOpen: true, panelTab: 'checks' });
    refreshGitFor(ws.path); refreshPR(ws, true);
  };
  m.el.querySelector('#pr-ok').onclick = ok;
}
async function mergeBaseOrHead(ws, base) { const r = await window.astral.git.mergeBase(ws.path, `origin/${base}`).catch(() => null); if (r && r.ok) return r.sha; const r2 = await window.astral.git.mergeBase(ws.path, base).catch(() => null); return r2 && r2.ok ? r2.sha : null; }
function mergeMenu(el, ws) {
  const p = state.pr[ws.id] && state.pr[ws.id].pr; if (!p) return;
  const go = async (method) => {
    if (!(await confirmModal(`Merge #${p.number}?`, `${method === 'squash' ? 'Squash and merge' : method === 'rebase' ? 'Rebase and merge' : 'Create a merge commit'} into ${p.baseRefName}, then delete the remote branch.`, { ok: 'Merge', danger: false }))) return;
    toast('Merging…');
    const r = await window.astral.gh.prMerge(ws.path, method, true);
    if (!r.ok) { toast(`Merge failed: ${r.error.split('\n').pop()}`, true); return; }
    toast('Merged. Archive the workspace when you are done.');
    sound.choo();
    await refreshPR(ws, true);
    if (await confirmModal('Merged!', `Archive ${ws.name} now?`, { ok: 'Archive', danger: false })) archiveWorkspace(ws, { silent: true });
  };
  menuAt(el, ['Merge method', { label: 'Squash and merge', icon: 'gitMerge', run: () => go('squash') }, { label: 'Rebase and merge', icon: 'gitBranch', run: () => go('rebase') }, { label: 'Create a merge commit', icon: 'gitCommit', run: () => go('merge') }]);
}
async function fixChecks(ws) {
  const p = state.pr[ws.id]; if (!p || !p.pr) return;
  const failing = (p.checks || []).filter((c) => /FAIL|ERROR/i.test(c.state || c.bucket || ''));
  let logs = '';
  for (const c of failing.slice(0, 3)) { const r = await window.astral.gh.runLog(ws.path, c.link); if (r.ok) logs += `\n\n### ${c.name}\n${r.text.slice(-6000)}`; }
  newChat(ws, 'claude', { name: 'Fix checks', prompt: `The pull request #${p.pr.number} has failing CI checks: ${failing.map((c) => c.name).join(', ') || 'see GitHub'}.\n${logs ? 'Failure logs:' + logs : 'Fetch the logs with gh pr checks / gh run view --log-failed.'}\n\nFind the cause, fix it in this workspace, run the relevant tests locally, then commit and push the fix.` });
}
async function refreshPR(ws, force = false) {
  if (!ws || ws.archived) return;
  if (state.ghAvailable === null) { state.ghAvailable = await window.astral.gh.available(); S.emit('pr'); }
  if (!state.ghAvailable) return;
  const g = state.git[ws.path]; if (!g || !g.isRepo || !g.remote) return;
  const cur = state.pr[ws.id];
  if (!force && cur && Date.now() - cur.at < 45000) return;
  const r = await window.astral.gh.pr(ws.path);
  let checks = null;
  if (r.ok) { const c = await window.astral.gh.prChecks(ws.path); checks = c.ok ? c.checks : null; }
  const prev = cur && cur.pr;
  state.pr[ws.id] = { at: Date.now(), pr: r.ok ? r.pr : null, none: !r.ok && r.none, error: r.ok || r.none ? null : r.error, checks };
  if (prev && r.ok && prev.state !== 'MERGED' && r.pr.state === 'MERGED') { notify(ws, `PR #${r.pr.number} merged`); }
  S.emit('pr');
}
function reviewChanges(ws) {
  const g = state.git[ws.path] || {};
  newChat(ws, 'claude', { name: 'Review', perm: 'plan', prompt: `Review the changes in this workspace as a careful senior engineer. Run git status and git diff (and git diff ${g.base || 'main'}...HEAD for committed work) to see everything that changed. For each file, point out bugs, risky edge cases, missing tests and clarity problems, quoting the relevant lines. Do not modify any files. End with a short verdict: ready to merge, or what must change first.` });
}

// ---------------------------------------------------------------- repositories
function addRepoDialog() {
  const m = modal(`<h3>Add repository</h3><p class="sub">A git repository on this machine. Workspaces are created as worktrees of it under ${esc(PATHS.workspacesRoot)}.</p>
    <div class="field"><label>Folder</label><div class="row"><input type="text" id="np-path" placeholder="C:\\path\\to\\repo"><button class="btn" id="np-browse">Browse</button></div></div>
    <div class="field"><label>Name</label><input type="text" id="np-name" placeholder="Defaults to the folder name"></div>
    <div class="modal-actions"><button class="btn ghost" id="np-clone">Clone from URL instead</button><span class="grow"></span><button class="btn ghost" id="np-cancel">Cancel</button><button class="btn primary" id="np-ok">Add</button></div>`);
  const path = m.el.querySelector('#np-path'), name = m.el.querySelector('#np-name');
  m.el.querySelector('#np-browse').onclick = async () => { const d = await window.astral.dialog.pickFolder(); if (d) { path.value = d; if (!name.value) name.value = basename(d); path.focus(); } };
  m.el.querySelector('#np-cancel').onclick = m.close;
  m.el.querySelector('#np-clone').onclick = () => { m.close(); cloneDialog(); };
  const ok = async () => {
    const p = path.value.trim().replace(/[\\/]+$/, ''); if (!p) { path.focus(); return; }
    if (state.repos.some((r) => samePath(r.path, p))) { toast('That repository is already added.'); m.close(); return; }
    const r = S.addRepo(name.value.trim() || basename(p), p);
    m.close();
    await refreshGitFor(p); loadScripts(r);
    S.setView('workspace');
    newWorkspaceDialog({ repo: r });
  };
  m.el.querySelector('#np-ok').onclick = ok;
  m.el.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
  path.focus();
}
function cloneDialog() {
  const m = modal(`<h3>Clone a repository</h3><div class="field"><label>Git URL</label><input id="cl-url" placeholder="https://github.com/org/repo.git"></div>
    <div class="field"><label>Into folder</label><div class="row"><input id="cl-dir" placeholder="C:\\Users\\you\\code"><button class="btn" id="cl-browse">Browse</button></div></div>
    <div class="modal-actions"><span class="hint" id="cl-hint" style="margin-right:auto;align-self:center"></span><button class="btn ghost" id="cl-cancel">Cancel</button><button class="btn primary" id="cl-ok">Clone</button></div>`);
  const url = m.el.querySelector('#cl-url'), dir = m.el.querySelector('#cl-dir'), hint = m.el.querySelector('#cl-hint');
  m.el.querySelector('#cl-browse').onclick = async () => { const d = await window.astral.dialog.pickFolder(); if (d) dir.value = d; };
  m.el.querySelector('#cl-cancel').onclick = m.close;
  m.el.querySelector('#cl-ok').onclick = async () => {
    const u = url.value.trim(), d = dir.value.trim().replace(/[\\/]+$/, ''); if (!u || !d) return;
    const name = basename(u.replace(/\.git$/, '').replace(/\/+$/, ''));
    hint.innerHTML = `${RUN()} Cloning ${esc(name)}…`; m.el.querySelector('#cl-ok').disabled = true;
    const r = await window.astral.git.clone(u, `${d}\\${name}`);
    if (!r.ok) { hint.textContent = r.error.split('\n').pop(); m.el.querySelector('#cl-ok').disabled = false; return; }
    m.close(); const repo = S.addRepo(name, r.path); await refreshGitFor(r.path); loadScripts(repo); newWorkspaceDialog({ repo });
  };
  url.focus();
}
function openRepoSettings(repo) { S.setView('settings', { settingsTab: 'repos' }); if (repo) setTimeout(() => { const c = document.querySelector(`[data-repo-card="${repo.id}"]`); if (c) c.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, 50); }
async function saveScripts(repoId) {
  const repo = state.repos.find((r) => r.id === repoId); const card = document.querySelector(`[data-repo-card="${repoId}"]`); if (!repo || !card) return;
  const val = (k) => { const el = card.querySelector(`[data-script="${k}"]`); return el ? el.value.trim() : ''; };
  const runs = {};
  for (const row of card.querySelectorAll('.runrow')) { const id = slug(row.querySelector('[data-run-id]').value, 30); const cmd = row.querySelector('[data-run-cmd]').value.trim(); if (id && cmd) runs[id] = { command: cmd, icon: row.querySelector('[data-run-icon]').value, default: false }; }
  const scripts = { setup: val('setup'), run: val('run'), archive: val('archive'), run_mode: val('run_mode') || 'concurrent', file_include_globs: val('file_include_globs').split(',').map((x) => x.trim()).filter(Boolean), runs };
  const r = await window.astral.conductor.saveSettings(repo.path, scripts);
  if (!r.ok) { toast(`Could not save: ${r.error}`, true); return; }
  const base = card.querySelector(`[data-repo-base="${repoId}"]`).value.trim(); repo.base = base || null;
  const nm = card.querySelector(`[data-repo-name="${repoId}"]`).value.trim(); if (nm) repo.name = nm;
  S.save();
  await loadScripts(repo, true);
  toast('Saved to .conductor/settings.toml'); S.emit('repos');
}

// ---------------------------------------------------------------- agents install
function installAgent(r, command, label) {
  const ws = S.activeWorkspace() || state.workspaces.find((w) => !w.archived);
  if (!ws) { toast('Add a repository first so the install has a terminal to run in.', true); return; }
  runInDrawer(ws, 'install:' + r.id, `${label} ${r.name}`, command);
  toast(`${label}ing ${r.name} in the terminal. Nothing else is touched.`);
}
function installGh() {
  const ws = S.activeWorkspace() || state.workspaces.find((w) => !w.archived);
  if (!ws) { toast('Add a repository first.', true); return; }
  runInDrawer(ws, 'install:gh', 'Install GitHub CLI', 'winget install --id GitHub.cli -e --accept-source-agreements --accept-package-agreements; Write-Host "`nRestart Astral after the install so gh is on PATH, then run: gh auth login"');
}
let versionsBusy = false;
async function checkVersions(force = false) {
  if (versionsBusy) return;
  if (!force && Date.now() - state.versionsAt < 10 * 60 * 1000) return;
  versionsBusy = true;
  try {
    const items = REGISTRY.filter((r) => r.cmd).map((r) => ({ id: r.id, cmd: r.cmd, npm: r.npm || null }));
    state.versions = await window.astral.plugins.versions(items);
    state.versionsAt = Date.now();
    state.ghAvailable = await window.astral.gh.recheck();
    S.emit('versions');
  } catch { /* ignore */ } finally { versionsBusy = false; }
}
setInterval(() => checkVersions(), 60 * 60 * 1000);

// ---------------------------------------------------------------- notifications & attention
function notify(ws, body) {
  if (!state.ui.notifications) return;
  window.astral.notify({ title: ws.name === 'local' ? (S.repoOf(ws) || ws).name : ws.name, body: String(body || '').slice(0, 160), tag: ws.id });
}
function onTurnDone(s, ev) {
  const ws = S.workspaceOfSession(s.id); if (!ws) return;
  S.touchWorkspace(ws.id);
  const elsewhere = ws.id !== state.activeWorkspaceId || !state.winFocused || state.view !== 'workspace';
  if (elsewhere) {
    ws.unread = true; S.save();
    const l = state.live[s.id] || (state.live[s.id] = {}); l.attention = true;
    notify(ws, ev.is_error ? 'Claude hit an error' : (chat.lastAssistantText(s) || 'Turn finished'));
    sound.choo();
  }
  refreshChanges(true); refreshGitFor(ws.path);
  updateHandoff(ws);
  S.emit('live');
}

// ---------------------------------------------------------------- phone control
// The hosted page asks the main process, which asks us: we own the chats.
async function remoteApply() {
  try {
    if (state.remote.enabled) {
      state.remoteStatus = await window.astral.remote.start({ port: state.remote.port || 5175, strong: !!state.remote.public });
      if (state.remoteStatus.error) toast(`Could not start hosting: ${state.remoteStatus.error}`, true);
      if (state.remote.public) window.astral.remote.publicIp().then((r) => { state.remotePublic = r; if (state.view === 'settings') renderSettings(); });
    }
    else state.remoteStatus = await window.astral.remote.stop();
  } catch (err) { state.remoteStatus = { running: false, error: err.message }; }
  if (state.view === 'settings') renderSettings();
}
function remoteTarget(id) {
  const chats = state.sessions.filter((s) => chat.isChat(s));
  return chats.find((s) => s.id === id) || chats.find((s) => s.id === state.remote.targetSessionId) || (S.activeSession() && chat.isChat(S.activeSession()) ? S.activeSession() : null) || chats.sort((x, y) => (y.lastActive || 0) - (x.lastActive || 0))[0] || null;
}
function remoteSessions() {
  return state.sessions.filter((s) => chat.isChat(s)).sort((x, y) => (y.lastActive || 0) - (x.lastActive || 0)).map((s) => { const w = S.workspaceOfSession(s.id); return { id: s.id, name: s.name, agent: s.agent, color: agentOf(s.agent).color, ws: w ? (w.name === 'local' ? basename(w.path) : w.name) : '', working: chat.isWorking(s), live: chat.isLive(s) }; });
}
window.astral.remote.onRequest(async (req) => {
  const p = req.payload || {};
  let out;
  try {
    switch (req.kind) {
      case 'state': { const t = remoteTarget(); const u = state.ui; out = { ok: true, sessions: remoteSessions(), target: t ? t.id : null, previews: state.remote.previews !== false, ui: { theme: u.theme, themeResolved: document.documentElement.dataset.theme || 'dark', font: u.font, skin: u.skin || 'default', followUp: u.followUp, sounds: !!u.sounds, notifications: !!u.notifications } }; break; }
      case 'meta': {
        const icons = {}; for (const k of ['cog', 'chevronDown', 'cpu', 'check2', 'gauge', 'book', 'plus', 'arrowUp', 'square', 'x', 'paperclip', 'search']) icons[k] = I[k] || '';
        out = { ok: true, icons, agents: REGISTRY.filter((r) => r.id !== 'shell').map((r) => ({ id: r.id, name: r.name, color: r.color, svg: brandSvg(r.icon) })) };
        break;
      }
      case 'render': {
        const s = remoteTarget(p.sessionId); if (!s) { out = { ok: true, parts: [], working: false, alive: false, queue: [], controls: {} }; break; }
        await chat.ensureHistory(s);
        const st = chat.chatS(s.id); const r = agentOf('claude');
        const perms = [['auto', 'Auto'], ['acceptEdits', 'Accept edits'], ['manual', 'Ask'], ['plan', 'Plan'], ['bypassPermissions', 'Bypass']];
        out = { ok: true, parts: chat.buildParts(s, st), working: chat.isWorking(s), alive: chat.isLive(s), queue: st.queue.map((q) => q.text),
          controls: { model: modelOf(s), modelLabel: modelLabel('claude', modelOf(s)).replace('Default model', st.model ? st.model.replace(/^claude-/, '') : 'default'), models: r.models || [], perm: s.perm || 'auto', permLabel: permLabel(s.perm || 'auto'), perms, effort: s.effort || null, effortLabel: effortLabel(s.effort), efforts: EFFORTS.map((v) => [v, effortLabel(v)]) } };
        break;
      }
      case 'session': {
        const s = remoteTarget(p.sessionId); if (!s) { out = { ok: false, error: 'No chat' }; break; }
        if ('perm' in p) setPerm(s, p.perm || 'auto');
        if ('model' in p) { s.model = p.model || null; S.save(); S.emit('sessions'); if (chat.isLive(s)) { toast(`Restarting Claude with ${modelLabel('claude', s.model)}…`); chat.restartChat(s); } }
        if ('effort' in p) { s.effort = p.effort || null; S.save(); S.emit('sessions'); if (chat.isLive(s)) chat.restartChat(s); }
        out = { ok: true }; break;
      }
      case 'ui': {
        if (p.key === 'previews') { state.remote.previews = !!p.value; S.save(); }
        else if (['theme', 'font', 'skin', 'followUp', 'sounds', 'notifications'].includes(p.key)) { S.setUi({ [p.key]: p.value }); applyTheme(); if (state.view === 'settings') renderSettings(); }
        out = { ok: true }; break;
      }
      case 'messages': {
        const s = remoteTarget(p.sessionId); if (!s) { out = { ok: true, msgs: [], working: false, queue: [] }; break; }
        const st = chat.chatS(s.id);
        const msgs = st.msgs.slice(-80).map((m) => {
          if (m.kind === 'user') return { kind: 'user', text: m.text, at: m.at };
          if (m.kind === 'assistant') { const blocks = (m.blocks || []).filter(Boolean); return { kind: 'assistant', text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim(), tools: blocks.filter((b) => b.type === 'tool_use').map((b) => { const [verb, target] = chat.toolVerb(b.name, b.input || {}); return { verb, target: String(target || b.name).slice(0, 120), done: !!b.done, error: !!b.error }; }), at: m.at || 0 }; }
          if (m.kind === 'turn') return { kind: 'turn', ms: m.ms, error: !!m.error, text: m.text };
          if (m.kind === 'sys') return { kind: 'sys', text: m.text };
          if (m.kind === 'perm') return { kind: 'sys', text: m.resolved ? `Permission ${m.resolved}: ${m.tool}` : `Waiting for permission in Astral: ${m.tool}` };
          if (m.kind === 'ask') return { kind: 'sys', text: m.resolved ? 'Question answered in Astral' : 'Claude asked a question: answer it in Astral' };
          return null;
        }).filter(Boolean);
        out = { ok: true, msgs, working: chat.isWorking(s), alive: chat.isLive(s), queue: st.queue.map((q) => q.text) };
        break;
      }
      case 'prompt': {
        const s = remoteTarget(p.sessionId); if (!s) { out = { ok: false, error: 'No Claude chat is open in Astral' }; break; }
        const text = String(p.text || '').trim(); const images = [];
        for (const im of (p.images || []).slice(0, 4)) { try { images.push(await imageFromDataUrl(im.dataUrl, im.name || 'photo.jpg')); } catch { /* skip */ } }
        if (!text && !images.length) { out = { ok: false, error: 'Empty message' }; break; }
        const msg = text || 'See the attached image.';
        let queued = false;
        if (!chat.isLive(s)) chat.launchChat(s, { resume: !!s.agentSessionId, firstPrompt: msg, attachments: images });
        else if (chat.isBusy(s)) { chat.queueAdd(s, msg, images); queued = true; }
        else chat.chatSend(s, msg, { attachments: images });
        const ws = S.workspaceOfSession(s.id); if (ws) S.touchWorkspace(ws.id);
        out = { ok: true, queued, session: s.name };
        break;
      }
      case 'stop': { const s = remoteTarget(p.sessionId); if (s && chat.isLive(s)) chat.chatInterrupt(s); out = { ok: true }; break; }
      case 'use': { const s = remoteTarget(p.sessionId); if (s) { state.remote.targetSessionId = s.id; S.save(); } out = { ok: !!s }; break; }
      default: out = { ok: false, error: 'unknown request' };
    }
  } catch (err) { out = { ok: false, error: err.message }; }
  window.astral.remote.respond(req.id, out);
});
window.astral.onNotifyClick((tag) => { const ws = state.workspaces.find((w) => w.id === tag); if (ws) S.setActiveWorkspace(ws.id); });
window.astral.win.onFocus((f) => { state.winFocused = f; if (f) { const ws = S.activeWorkspace(); if (ws && ws.unread) { ws.unread = false; S.save(); S.emit('live'); } } });
function nextAttention() {
  const list = attentionList(); if (!list.length) { toast('Nothing needs attention.'); return; }
  const i = list.findIndex((w) => w.id === state.activeWorkspaceId);
  S.setActiveWorkspace(list[(i + 1) % list.length].id);
}
function stepWorkspace(delta) {
  const list = state.repos.flatMap((r) => S.repoWorkspaces(r.id).sort((a, b) => b.updatedAt - a.updatedAt));
  if (!list.length) return;
  const i = list.findIndex((w) => w.id === state.activeWorkspaceId);
  S.setActiveWorkspace(list[(i + delta + list.length) % list.length].id);
}

// ---------------------------------------------------------------- polling
window.astral.agents.onEvent((p) => {
  if (p.kind === 'bound') S.bindAgentSession(p.sessionId, p.agentSessionId, p.file);
  else if (p.kind === 'events') {
    const s = state.sessions.find((x) => x.id === p.sessionId);
    // the transcript replay fills a resumed chat that has no saved history, whether or not the CLI's init has already arrived
    if (s && chat.isChat(s)) { const st = chat.chatS(s.id); if (st.resumed && !st.hydrated && !st.fileHistory) { chat.hydrateFromEvents(s, p.events); st.hydrated = true; st.hydrating = false; chat.scheduleChat(true); chat.persist(s, true); } }
    S.pushEvents(p.sessionId, p.events);
  }
});
setInterval(async () => {
  let claude = {};
  if (state.sessions.some((s) => s.agent === 'claude' && tmMain.isLive(s.id))) { try { claude = await window.astral.agents.liveClaudeStatus(); } catch { /* ignore */ } }
  const now = Date.now();
  let changed = false;
  for (const s of state.sessions) {
    const cur = state.live[s.id] || {};
    let next;
    if (chat.isChat(s)) { const c = state.chat[s.id]; next = !c || !c.started ? 'dormant' : !c.alive ? 'dead' : c.working ? 'working' : 'idle'; if (next === 'idle') chat.drainIfIdle(s); }
    else if (!tmMain.has(s.id)) next = 'dormant';
    else if (!tmMain.isLive(s.id)) next = 'dead';
    else {
      const recent = cur.lastOutput && now - cur.lastOutput < 1300;
      const c = s.agent === 'claude' && s.agentSessionId ? claude[s.agentSessionId] : null;
      next = c && c.status === 'busy' ? 'working' : c && c.status === 'idle' && !recent ? 'idle' : recent ? 'working' : 'idle';
    }
    if (cur.status !== next) {
      const settled = cur.status === 'working' && next === 'idle';
      const ws = S.workspaceOfSession(s.id);
      const elsewhere = ws && (ws.id !== state.activeWorkspaceId || !state.winFocused);
      const attention = settled && elsewhere && s.agent !== 'shell' && !chat.isChat(s);
      state.live[s.id] = { ...cur, status: next, attention: attention || (cur.attention && next !== 'working'), workingSince: next === 'working' ? now : cur.workingSince };
      if (attention && ws) { ws.unread = true; notify(ws, `${agentOf(s.agent).name} is waiting`); sound.done(); }
      if (ws && next === 'working') S.touchWorkspace(ws.id);
      changed = true;
    }
  }
  if (changed) S.emit('live');
}, 800);
async function refreshGitFor(p) {
  if (!p) return null;
  try {
    const g = await window.astral.git.info(p);
    const prev = state.git[p];
    const sig = JSON.stringify([g.branch, g.dirty, g.ahead, g.behind, g.head && g.head.sha, g.base, g.upstream]);
    state.git[p] = { ...g, sig };
    if (!prev || prev.sig !== sig) S.emit('git');
    return state.git[p];
  } catch { return null; }
}
let gitTick = 0;
async function refreshGit(all = false) {
  const ws = S.activeWorkspace();
  const paths = new Set();
  if (ws) paths.add(ws.path);
  if (all || gitTick % 5 === 0) for (const w of state.workspaces) if (!w.archived) paths.add(w.path);
  if (all || gitTick % 5 === 0) for (const r of state.repos) paths.add(r.path);
  gitTick++;
  for (const p of paths) await refreshGitFor(p);
}
async function refreshChanges(force = false) {
  const ws = S.activeWorkspace(); if (!ws || state.view !== 'workspace') return;
  if (!force && !(state.ui.panelOpen)) return;
  await diff.loadChanges(ws);
}
setInterval(() => refreshGit(false), 4000);
setInterval(() => refreshChanges(false), 5000);
setInterval(() => { const ws = S.activeWorkspace(); if (ws) refreshPR(ws); for (const w of state.workspaces) if (!w.archived && w.id !== (ws && ws.id) && state.pr[w.id] && state.pr[w.id].pr && state.pr[w.id].pr.state === 'OPEN') refreshPR(w); }, 60000);

// ---------------------------------------------------------------- pickers
function openInMenu(el, dir) {
  if (!dir) return;
  menuAt(el, [{ label: 'VS Code', icon: 'code', run: () => window.astral.shell.openIn('code', dir) }, { label: 'Cursor', icon: 'code', run: () => window.astral.shell.openIn('cursor', dir) }, { label: 'Windows Terminal', icon: 'terminal', run: () => window.astral.shell.openIn('wt', dir) }, { label: 'PowerShell', icon: 'terminal', run: () => window.astral.shell.openIn('powershell', dir) }, { label: 'File Explorer', icon: 'folder', run: () => window.astral.shell.openIn('explorer', dir) }, '-', { label: 'Copy path', icon: 'copy', run: () => { navigator.clipboard.writeText(dir); toast('Path copied.'); } }]);
}
function wsMenu(el, ws, x, y) {
  const g = state.git[ws.path] || {};
  const s = S.activeSession();
  const items = [
    { label: 'Commit & push', icon: 'gitCommit', kbd: 'Ctrl+Shift+Y', run: () => commitPushDialog(ws) },
    { label: `Pull latest from ${g.base || 'main'}`, icon: 'arrowDown', kbd: 'Ctrl+Shift+L', run: () => pullLatest(ws) },
    { label: 'Create pull request', icon: 'gitPullRequest', kbd: 'Ctrl+Shift+P', run: () => createPRDialog(ws) },
    { label: 'Review changes', icon: 'eye', run: () => reviewChanges(ws) },
    '-',
    { label: 'Rename branch', icon: 'pencil', disabled: !g.isRepo, run: () => renameBranch(ws) },
    { label: 'Fork workspace', icon: 'gitFork', disabled: !g.isRepo, run: () => forkWorkspace(ws) },
    { label: ws.pinned ? 'Unpin' : 'Pin to top', icon: 'pin', run: () => { ws.pinned = !ws.pinned; S.save(); S.emit('repos'); } },
    { label: ws.unread ? 'Mark as read' : 'Mark as unread', icon: 'circleDot', run: () => { ws.unread = !ws.unread; S.save(); S.emit('live'); } },
    { label: 'Open folder', icon: 'folder', run: () => window.astral.shell.openPath(ws.path) },
    { label: 'Repository settings', icon: 'cog', run: () => openRepoSettings(S.repoOf(ws)) },
    '-',
  ];
  if (s && s.agent === 'claude') items.push({ label: chat.isChat(s) ? 'Switch this chat to Terminal UI' : 'Switch this chat to Chat UI', icon: chat.isChat(s) ? 'terminal' : 'message', run: () => switchMode(s) });
  items.push({ label: 'Archive workspace', icon: 'archive', run: () => archiveWorkspace(ws) }, { label: 'Delete workspace', icon: 'trash', danger: true, run: () => deleteWorkspace(ws) });
  return el ? menuAt(el, items, { alignRight: true, width: 250 }) : menu(x, y, items, { width: 250 });
}
function repoMenu(el, repo) {
  menuAt(el, [{ label: 'New workspace', icon: 'plus', run: () => { S.setActiveWorkspace((S.repoWorkspaces(repo.id)[0] || {}).id); newWorkspaceDialog(); } }, { label: 'Work in the repository folder', icon: 'laptop', sub: 'local workspace', run: () => createWorkspace({ repo, agent: null, isolate: false }) }, '-', { label: 'Repository settings', icon: 'cog', run: () => openRepoSettings(repo) }, { label: 'Open folder', icon: 'folder', run: () => window.astral.shell.openPath(repo.path) }, '-', { label: 'Remove repository', icon: 'trash', danger: true, run: async () => { if (await confirmModal(`Remove ${repo.name}?`, 'Workspaces under it are closed. Worktrees and branches stay on disk.', { ok: 'Remove' })) { for (const w of S.repoWorkspaces(repo.id)) for (const s of S.workspaceSessions(w.id)) { await stopAny(s); await tmMain.destroy(s.id); } S.removeRepo(repo.id); } } }]);
}
function modelMenu(el, agentId, s) {
  const r = agentOf(agentId);
  const cur = s ? modelOf(s) : (state.models[agentId] || null);
  const apply = (m) => {
    if (s) s.model = m; else { if (m) state.models[agentId] = m; else delete state.models[agentId]; }
    S.save();
    if (s && chat.isChat(s) && chat.isLive(s)) { toast(`Restarting Claude with ${modelLabel(agentId, m)}…`); chat.restartChat(s); }
    else if (s && tmMain.isLive(s.id) && r.liveModel && m) { tmMain.write(s.id, r.liveModel(m)); setTimeout(() => tmMain.write(s.id, '\r'), 60); toast(`Switched to ${modelLabel(agentId, m)}.`); }
    else toast(`${r.name} will use ${modelLabel(agentId, m)}.`);
    S.emit('sessions');
  };
  const items = [`${r.name} model`, { label: `Default (${r.name}'s own settings)`, check: true, checked: !cur, run: () => apply(null) }];
  for (const [id, label] of r.models || []) items.push({ label, sub: id === label ? '' : id, check: true, checked: cur === id, run: () => apply(id) });
  items.push('-', { label: r.modelPrompt ? `${r.modelPrompt}…` : 'Custom model id…', icon: 'pencil', run: () => promptModal(r.modelPrompt || `${r.name} model id`, cur || '').then((v) => { if (v !== null) apply(v || null); }) });
  if (s) items.push({ label: `Set as default for ${r.name}`, icon: 'check2', run: () => { if (cur) state.models[agentId] = cur; else delete state.models[agentId]; S.save(); toast('Default saved.'); } });
  menuAt(el, items);
}
function permMenu(el, s) {
  const modes = [['auto', 'Auto', 'Claude decides, asks when unsure'], ['acceptEdits', 'Accept edits', 'file edits allowed, commands ask'], ['manual', 'Ask', 'ask for everything'], ['plan', 'Plan', 'read-only planning'], ['bypassPermissions', 'Bypass', 'never ask (careful)']];
  menuAt(el, ['Permissions', ...modes.map(([id, label, sub]) => ({ label, sub, check: true, checked: (s.perm || 'auto') === id, run: () => setPerm(s, id) }))]);
}
function effortMenu(el, s) {
  const apply = (v) => { s.effort = v; S.save(); S.emit('sessions'); if (chat.isChat(s) && chat.isLive(s)) { toast(`Restarting Claude with ${v ? v + ' effort' : 'your default effort'}…`); chat.restartChat(s); } else if (tmMain.isLive(s.id)) toast('Applies when this session is restarted.'); };
  menuAt(el, ['Effort', { label: 'Default (your Claude settings)', check: true, checked: !s.effort, run: () => apply(null) }, ...EFFORTS.map((v) => ({ label: effortLabel(v), sub: v === 'xhigh' ? 'between high and max' : '', check: true, checked: s.effort === v, run: () => apply(v) }))]);
}
function setPerm(s, id) { s.perm = id; S.save(); S.emit('sessions'); if (chat.isLive(s)) { toast(`Restarting Claude in ${permLabel(id)} mode…`); chat.restartChat(s); } }
function diffModeMenu(el, ws) {
  const cps = (ws.checkpoints || []).slice(-8).reverse();
  menuAt(el, ['Compare against', { label: 'All changes', sub: 'vs HEAD, incl. untracked', check: true, checked: state.ui.diffMode === 'all', run: () => setDiffMode(ws, 'all') }, { label: 'Since last turn', sub: 'what the agent just did', check: true, checked: state.ui.diffMode === 'turn', disabled: !cps.length, run: () => setDiffMode(ws, 'turn') }, ...(cps.length > 1 ? ['-', ...cps.map((c) => ({ label: `Since “${c.prompt}”`, sub: fmtTime(c.at), check: true, checked: state.ui.diffMode === 'checkpoint' && ws.diffFrom === c.tree, run: () => { ws.diffFrom = c.tree; setDiffMode(ws, 'checkpoint'); } }))] : [])]);
}
function setDiffMode(ws, mode) { state.ui.diffMode = mode; S.save(); delete state.changes[ws.id]; S.setUi({ panelOpen: true, panelTab: 'diff' }); diff.loadChanges(ws).then(() => S.emit('changes')); }

async function openResume() {
  const cur = S.activeWorkspace();
  let scope = cur ? 'here' : 'all';
  const m = modal(`<input id="rs-q" placeholder="Resume a past conversation…"><div class="scope"><button data-scope="here" ${cur ? '' : 'disabled'}>${cur ? 'This workspace · ' + esc(cur.name) : 'This workspace'}</button><button data-scope="all">All folders</button></div><div class="list" id="rs-list"></div>`, 'palette');
  const q = m.el.querySelector('#rs-q'), list = m.el.querySelector('#rs-list'); q.focus();
  const cache = {}; let all = [], hi = 0, items = [];
  const build = () => {
    const needle = q.value.trim().toLowerCase();
    items = all.filter((x) => !needle || `${x.title || ''} ${x.firstPrompt || ''} ${x.lastPrompt || ''} ${scope === 'all' ? x.cwd : ''}`.toLowerCase().includes(needle));
    hi = Math.min(hi, Math.max(0, items.length - 1));
    list.innerHTML = items.length ? items.map((x, i) => { const open = state.sessions.find((s) => s.agentSessionId === x.id); return `<button class="item is-two ${i === hi ? 'is-hi' : ''}" data-i="${i}">${ag(x.agentId)}<span class="lines"><span class="t">${esc(x.title || x.firstPrompt || '(untitled)')}${open ? ` <span class="hint">· open</span>` : ''}</span><span class="p">${esc(x.lastPrompt || x.firstPrompt || '')}</span></span><span class="sub">${scope === 'all' ? esc(basename(x.cwd)) + ' · ' : ''}${esc(when(x.updatedAt))}</span></button>`; }).join('') : `<div class="none">${all.length ? 'No conversations match.' : 'No past conversations found.'}</div>`;
    const h = list.querySelector('.is-hi'); if (h) h.scrollIntoView({ block: 'nearest' });
  };
  const load = async () => {
    m.el.querySelectorAll('[data-scope]').forEach((b) => b.classList.toggle('is-on', b.dataset.scope === scope));
    if (!cache[scope]) {
      list.innerHTML = '<div class="none">Looking for past conversations…</div>';
      if (scope === 'here') { const lists = await Promise.all(REGISTRY.filter((r) => r.telemetry && isInstalled(r.id)).map((r) => (r.telemetry === 'claude' ? window.astral.agents.listClaude(cur.path) : window.astral.agents.listCodex(cur.path)).then((xs) => (xs || []).map((x) => ({ ...x, agentId: r.id }))))); cache.here = lists.flat().sort((a, b) => b.updatedAt - a.updatedAt); }
      else { const xs = await window.astral.agents.listAll(); cache.all = (xs || []).filter((x) => isInstalled(x.agent)).map((x) => ({ ...x, agentId: x.agent })); }
    }
    all = cache[scope]; build();
  };
  const go = async (i) => { const x = items[i]; if (!x) return; m.close(); resumeConversation(x); };
  m.el.querySelector('.scope').addEventListener('click', (e) => { const b = e.target.closest('[data-scope]'); if (!b || b.disabled) return; scope = b.dataset.scope; hi = 0; load(); q.focus(); });
  q.addEventListener('input', () => { hi = 0; build(); });
  q.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { hi = Math.min(items.length - 1, hi + 1); build(); e.preventDefault(); } else if (e.key === 'ArrowUp') { hi = Math.max(0, hi - 1); build(); e.preventDefault(); } else if (e.key === 'Enter') go(hi); else if (e.key === 'Tab') { e.preventDefault(); if (cur) { scope = scope === 'here' ? 'all' : 'here'; hi = 0; load(); } } });
  list.addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (b) go(+b.dataset.i); });
  load();
}
function openPalette() {
  const m = modal(`<input id="pal-q" placeholder="Search workspaces and commands…"><div class="list" id="pal-list"></div>`, 'palette');
  const q = m.el.querySelector('#pal-q'), list = m.el.querySelector('#pal-list');
  let hi = 0, items = [];
  const ws = S.activeWorkspace();
  const cmds = [
    ['New workspace', 'Ctrl+N', 'plus', () => newWorkspaceDialog()], ['Create workspace from branch or PR', 'Ctrl+Shift+N', 'gitBranch', () => newWorkspaceDialog({ from: true })], ['Add repository', '', 'folderPlus', addRepoDialog],
    ['Diff viewer', 'Ctrl+Shift+D', 'gitCompare', () => { S.setUi({ panelOpen: true, panelTab: 'diff' }); S.emit('panel'); }], ['Checks & pull request', 'Ctrl+Shift+C', 'checkCircle', () => { S.setUi({ panelOpen: true, panelTab: 'checks' }); S.emit('panel'); }],
    ['Create pull request', 'Ctrl+Shift+P', 'gitPullRequest', () => ws && createPRDialog(ws)], ['Commit & push', 'Ctrl+Shift+Y', 'gitCommit', () => ws && commitPushDialog(ws)], ['Pull latest', 'Ctrl+Shift+L', 'arrowDown', () => ws && pullLatest(ws)],
    ['Review changes', '', 'eye', () => ws && reviewChanges(ws)], ['Run script', 'Ctrl+R', 'play', () => ws && runScript(ws, 'run')], ['Terminal', 'Ctrl+`', 'terminal', () => S.setUi({ drawerOpen: !state.ui.drawerOpen })],
    ['Archive workspace', '', 'archive', () => ws && archiveWorkspace(ws)], ['Resume a past conversation', 'Ctrl+Shift+R', 'history', openResume], ['History', '', 'archive', () => S.setView('history')], ['Settings', 'Ctrl+,', 'cog', () => S.setView('settings')], ['Agents', '', 'puzzle', () => S.setView('settings', { settingsTab: 'agents' })],
  ];
  const build = () => {
    const needle = q.value.trim().toLowerCase();
    items = [];
    for (const w of [...state.workspaces].filter((w) => !w.archived).sort((a, b) => b.updatedAt - a.updatedAt)) {
      const r = S.repoOf(w); const hay = `${w.name} ${w.branch || ''} ${r ? r.name : ''}`.toLowerCase();
      if (!needle || hay.includes(needle)) items.push({ kind: 'ws', id: w.id, label: w.branch || w.name, sub: `${r ? r.name : ''} · ${w.name} · ${wsStatus(w).text}`, icon: 'gitBranch' });
    }
    for (const [label, kbd, icon, run] of cmds) if (!needle || label.toLowerCase().includes(needle)) items.push({ kind: 'cmd', label, sub: kbd, icon, run });
    hi = Math.min(hi, Math.max(0, items.length - 1));
    list.innerHTML = items.map((it, i) => `<button class="item ${i === hi ? 'is-hi' : ''}" data-i="${i}">${ic(it.icon, 'ag')}<span>${esc(it.label)}</span><span class="sub">${esc(it.sub)}</span></button>`).join('') || '<div class="none">Nothing matches.</div>';
    const h = list.querySelector('.is-hi'); if (h) h.scrollIntoView({ block: 'nearest' });
  };
  const go = (i) => { const it = items[i]; if (!it) return; m.close(); if (it.kind === 'ws') S.setActiveWorkspace(it.id); else it.run(); };
  q.addEventListener('input', () => { hi = 0; build(); });
  q.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { hi = Math.min(items.length - 1, hi + 1); build(); e.preventDefault(); } else if (e.key === 'ArrowUp') { hi = Math.max(0, hi - 1); build(); e.preventDefault(); } else if (e.key === 'Enter') go(hi); });
  list.addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (b) go(+b.dataset.i); });
  build(); q.focus();
}

// ---------------------------------------------------------------- interactions
document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-win],[data-act],[data-ws],[data-repo-menu],[data-chat],[data-close-chat],[data-tab],[data-new-chat],[data-panel-tab],[data-tree],[data-preview],[data-diff-file],[data-diff-viewed],[data-add-comment],[data-comment-del],[data-open-file],[data-turn-diff],[data-tool-toggle],[data-perm-allow],[data-perm-always],[data-perm-deny],[data-ask-opt],[data-ask-other],[data-q-now],[data-q-del],[data-att-remove],[data-dtab],[data-dtab-close],[data-restore],[data-delete-ws],[data-settings-tab],[data-ui],[data-ui-toggle],[data-open-path],[data-remove-repo],[data-save-scripts],[data-run-add],[data-run-del],[data-run-script],[data-install],[data-update],[data-toggle-launcher],[data-model-for],[data-filter],#composer-send');
  if (!t) return;
  const ws = S.activeWorkspace(), s = S.activeSession();
  if (t.dataset.win) { const w = window.astral.win; if (t.dataset.win === 'minimize') w.minimize(); else if (t.dataset.win === 'maximize') w.maximize(); else w.close(); return; }
  if (t.dataset.ws) { closePreview(); return S.setActiveWorkspace(t.dataset.ws); }
  if (t.dataset.repoMenu) { e.stopPropagation(); return repoMenu(t, state.repos.find((r) => r.id === t.dataset.repoMenu)); }
  if (t.dataset.closeChat) { e.stopPropagation(); const x = state.sessions.find((y) => y.id === t.dataset.closeChat); if (x) closeChat(x); return; }
  if (t.dataset.chat) { if (ws) { wsTab[ws.id] = 'chat'; S.setActiveChat(ws.id, t.dataset.chat); } return; }
  if (t.dataset.tab) { if (ws) { wsTab[ws.id] = wsTab[ws.id] === t.dataset.tab ? 'chat' : t.dataset.tab; S.emit('sessions'); } return; }
  if (t.dataset.newChat) { if (ws) newChat(ws, t.dataset.newChat); return; }
  if (t.dataset.panelTab) { S.setUi({ panelTab: t.dataset.panelTab, panelOpen: true }); if (t.dataset.panelTab === 'checks' && ws) refreshPR(ws, true); if (t.dataset.panelTab === 'diff') refreshChanges(true); return S.emit('panel'); }
  if (t.dataset.tree) return treeClick(t);
  if (t.dataset.preview) return openPreview(t.dataset.preview);
  if (t.dataset.openFile) return window.astral.shell.openPath(t.dataset.openFile);
  if (t.dataset.openPath) return window.astral.shell.openPath(t.dataset.openPath);
  if (t.dataset.diffViewed !== undefined) { e.stopPropagation(); if (ws) diff.markViewed(ws, t.dataset.diffViewed, !(ws.viewed[t.dataset.diffViewed])); return; }
  if (t.dataset.diffFile) { if (ws) diff.loadFile(ws, t.dataset.diffFile); return; }
  if (t.dataset.addComment) { const row = t.closest('.dl'); if (ws && row) diff.openCommentEditor(ws, row, +t.dataset.addComment, t.dataset.side); return; }
  if (t.dataset.commentDel) { if (ws) diff.removeComment(ws, t.dataset.commentDel); return; }
  if (t.dataset.turnDiff) { if (ws) { ws.diffFrom = t.dataset.turnDiff; setDiffMode(ws, 'checkpoint'); } return; }
  if (t.dataset.toolToggle) { t.closest('.tool').classList.toggle('is-open'); return; }
  if (t.dataset.permAllow || t.dataset.permAlways || t.dataset.permDeny) {
    if (!s) return;
    const reqId = t.dataset.permAllow || t.dataset.permAlways || t.dataset.permDeny;
    const m = chat.chatS(s.id).msgs.find((x) => x.kind === 'perm' && x.request_id === reqId);
    return chat.chatRespond(s, reqId, !t.dataset.permDeny, m ? m.input : {}, !!t.dataset.permAlways);
  }
  if (t.dataset.askOpt) { if (!s) return; const m = chat.chatS(s.id).msgs.find((x) => x.kind === 'ask' && x.request_id === t.dataset.askOpt); if (!m) return; const q = (m.input.questions || [])[+t.dataset.q]; m.pending = m.pending || {}; m.pending[q.question] = t.dataset.label; if (Object.keys(m.pending).length >= (m.input.questions || []).length) chat.chatAnswer(s, m.request_id, m.pending); else { t.closest('.qq').classList.add('answered'); } return; }
  if (t.dataset.askOther) { if (!s) return; const m = chat.chatS(s.id).msgs.find((x) => x.kind === 'ask' && x.request_id === t.dataset.askOther); if (!m) return; const q = (m.input.questions || [])[+t.dataset.q]; const v = await promptModal(q.question || 'Your answer', '', { ok: 'Answer' }); if (v === null) return; m.pending = m.pending || {}; m.pending[q.question] = v; if (Object.keys(m.pending).length >= (m.input.questions || []).length) chat.chatAnswer(s, m.request_id, m.pending); return; }
  if (t.dataset.qNow) { if (s) chat.queueSendNow(s, t.dataset.qNow); return; }
  if (t.dataset.qDel) { if (s) chat.queueRemove(s, t.dataset.qDel); return; }
  if (t.dataset.attRemove !== undefined) { if (!ws) return; if (t.dataset.attKind === 'comment') diff.removeComment(ws, t.dataset.attRemove); else { attach[ws.id] = (attach[ws.id] || []).filter((a) => (a.id || a.path) !== t.dataset.attRemove); S.emit('comments'); } return; }
  if (t.dataset.dtab) { if (ws) { drawerActive[ws.id] = t.dataset.dtab; renderDrawer(); } return; }
  if (t.dataset.dtabClose) { e.stopPropagation(); if (ws) { const id = t.dataset.dtabClose; await tmDrawer.destroy(id); drawerTabs[ws.id] = (drawerTabs[ws.id] || []).filter((x) => x.id !== id); renderDrawer(); } return; }
  if (t.dataset.restore) { const w = state.workspaces.find((x) => x.id === t.dataset.restore); if (w) restoreWorkspace(w); return; }
  if (t.dataset.deleteWs) { const w = state.workspaces.find((x) => x.id === t.dataset.deleteWs); if (w) deleteWorkspace(w); return; }
  if (t.dataset.settingsTab) { state.settingsTab = t.dataset.settingsTab; S.save(); renderSettings(); if (t.dataset.settingsTab === 'agents') checkVersions(); return; }
  if (t.dataset.ui) { S.setUi({ [t.dataset.ui]: t.dataset.value }); renderSettings(); return; }
  if (t.dataset.uiToggle) { S.setUi({ [t.dataset.uiToggle]: !state.ui[t.dataset.uiToggle] }); renderSettings(); return; }
  if (t.dataset.removeRepo) { const r = state.repos.find((x) => x.id === t.dataset.removeRepo); if (r && await confirmModal(`Remove ${r.name}?`, 'Workspaces under it are closed. Worktrees and branches stay on disk.', { ok: 'Remove' })) S.removeRepo(r.id); return; }
  if (t.dataset.saveScripts) return saveScripts(t.dataset.saveScripts);
  if (t.dataset.runAdd) { const box = document.querySelector(`[data-runs="${t.dataset.runAdd}"]`); box.insertAdjacentHTML('beforeend', `<div class="runrow"><input data-run-id placeholder="worker"><input data-run-cmd placeholder="npm run worker"><select data-run-icon><option value="play">play</option><option value="server">server</option><option value="test-tube">test-tube</option></select><button class="icon-btn sm" data-run-del title="Remove">${ic('x', 'i-sm')}</button></div>`); return; }
  if (t.dataset.runDel !== undefined) { t.closest('.runrow').remove(); return; }
  if (t.dataset.runScript) { if (ws) runScript(ws, 'run', t.dataset.runScript); return; }
  if (t.dataset.install) { const r = agentOf(t.dataset.install); return installAgent(r, installCommand(r), 'Install'); }
  if (t.dataset.update) { const r = agentOf(t.dataset.update); return installAgent(r, updateCommand(r), 'Update'); }
  if (t.dataset.toggleLauncher) { const i = state.launcherAgents.indexOf(t.dataset.toggleLauncher); if (i >= 0) state.launcherAgents.splice(i, 1); else state.launcherAgents.push(t.dataset.toggleLauncher); S.save(); renderSettings(); return; }
  if (t.dataset.modelFor) return modelMenu(t, t.dataset.modelFor, null);
  if (t.dataset.filter) { pluginFilter = t.dataset.filter; return renderSettings(); }
  if (t.id === 'composer-send') return composerSend(false);
  if (t.dataset.act) return action(t.dataset.act, t, e);
});
async function action(act, el, e) {
  const ws = S.activeWorkspace(), s = S.activeSession();
  switch (act) {
    case 'toggle-side': return S.setUi({ sidebarOpen: !state.ui.sidebarOpen });
    case 'toggle-panel': return S.setUi({ panelOpen: !state.ui.panelOpen });
    case 'toggle-drawer': return S.setUi({ drawerOpen: !state.ui.drawerOpen });
    case 'drawer-big': return S.setUi({ drawerBig: !state.ui.drawerBig, drawerOpen: true });
    case 'drawer-new': if (ws) { const id = `sh:${ws.id}:${Date.now().toString(36)}`; openDrawerTab(ws, id, `Terminal ${(drawerTabs[ws.id] || []).filter((x) => x.id.startsWith('sh:')).length + 2}`, { agent: 'shell', cwd: ws.path, env: envFor(ws) }); } return;
    case 'drawer-clear': if (ws && drawerActive[ws.id]) tmDrawer.clear(drawerActive[ws.id]); return;
    case 'search': return openPalette();
    case 'history': return S.setView('history');
    case 'settings': return S.setView('settings');
    case 'add-repo': return addRepoDialog();
    case 'clone-repo': return cloneDialog();
    case 'new-workspace': return newWorkspaceDialog();
    case 'new-chat': return newChatMenu(el);
    case 'resume': return openResume();
    case 'open-in': return openInMenu(el, ws ? ws.path : null);
    case 'ws-menu': return ws && wsMenu(el, ws);
    case 'run': if (!ws) return; { const sc = scriptsFor(ws); const runs = Object.entries(sc.runs || {}); if (runs.length && !tmMain.isLive('run:' + ws.id) && (runs.length > 1 || !sc.run)) return menuAt(el, ['Run', ...(sc.run ? [{ label: 'default', icon: 'play', run: () => runScript(ws, 'run') }] : []), ...runs.map(([id, r]) => ({ label: id, sub: r.command, icon: r.icon === 'server' ? 'server' : r.icon === 'test-tube' ? 'testTube' : 'play', run: () => runScript(ws, 'run', id) }))]); return runScript(ws, 'run'); }
    case 'run-setup': return ws && runScript(ws, 'setup');
    case 'create-pr': return ws && createPRDialog(ws);
    case 'open-pr': case 'checks': S.setUi({ panelOpen: true, panelTab: 'checks' }); if (ws) refreshPR(ws, true); return S.emit('panel');
    case 'pr-refresh': return ws && refreshPR(ws, true);
    case 'merge-pr': return ws && mergeMenu(el, ws);
    case 'pr-ready': if (ws) { const r = await window.astral.gh.prReady(ws.path); toast(r.ok ? 'Marked ready for review.' : r.error, !r.ok); refreshPR(ws, true); } return;
    case 'fix-checks': return ws && fixChecks(ws);
    case 'resolve-conflicts': if (ws) { const g = state.git[ws.path] || {}; newChat(ws, 'claude', { name: 'Resolve conflicts', prompt: `This branch conflicts with ${g.base || 'main'}. Merge origin/${g.base || 'main'} into it (git fetch origin && git merge origin/${g.base || 'main'}), resolve every conflict keeping the intent of both sides, run the tests, then commit and push.` }); } return;
    case 'commit-push': return ws && commitPushDialog(ws);
    case 'pull-latest': return ws && pullLatest(ws);
    case 'rename-branch': return ws && renameBranch(ws);
    case 'archive': return ws && archiveWorkspace(ws);
    case 'review': return ws && reviewChanges(ws);
    case 'send-comments': if (ws && s && chat.isChat(s)) { const atts = takeAttachments(ws); const text = 'Please address these review comments.'; if (!chat.isLive(s)) chat.launchChat(s, { resume: !!s.agentSessionId, firstPrompt: text, attachments: atts }); else if (chat.isWorking(s)) chat.queueAdd(s, text, atts); else chat.chatSend(s, text, { attachments: atts }); } return;
    case 'att-clear': if (ws) { diff.clearComments(ws); attach[ws.id] = []; S.emit('comments'); } return;
    case 'attach-file': if (ws) { const files = await window.astral.dialog.pickFiles(); for (const p of files) { if (isImageFile(p)) { const r = await window.astral.fs.read(p); if (r && r.kind === 'image') { await addImage(ws, () => imageFromDataUrl(r.dataUrl, basename(p))); continue; } } attach[ws.id] = (attach[ws.id] || []).concat([{ kind: 'file', path: p }]); } S.emit('comments'); } return;
    case 'interrupt': return s && chat.isChat(s) && chat.chatInterrupt(s);
    case 'model': return s && modelMenu(el, s.agent, s);
    case 'perm': return s && permMenu(el, s);
    case 'effort': return s && effortMenu(el, s);
    case 'diff-mode': return ws && diffModeMenu(el, ws);
    case 'diff-group': S.setUi({ groupByFolder: !state.ui.groupByFolder }); return S.emit('changes');
    case 'diff-refresh': return refreshChanges(true);
    case 'git-refresh': if (ws) { await refreshGitFor(ws.path); refreshChanges(true); refreshPR(ws, true); } return;
    case 'folder-cwd': return ws && window.astral.shell.openPath(ws.path);
    case 'preview-close': return closePreview();
    case 'preview-open': return window.astral.shell.openPath($('preview').dataset.file);
    case 'repo-settings': return openRepoSettings(ws ? S.repoOf(ws) : null);
    case 'check-versions': toast('Checking versions…'); return checkVersions(true);
    case 'update-all': for (const r of REGISTRY) if (hasUpdate(r.id)) installAgent(r, updateCommand(r), 'Update'); return;
    case 'install-gh': return installGh();
    case 'gh-recheck': state.ghAvailable = await window.astral.gh.recheck(); toast(state.ghAvailable ? 'GitHub CLI found.' : 'gh is still not on PATH.', !state.ghAvailable); S.emit('pr'); if (state.view === 'settings') renderSettings(); return;
    case 'gh-login': if (ws) runInDrawer(ws, 'install:ghlogin', 'gh auth login', 'gh auth login'); return;
    case 'sound-test': return sound.done();
    case 'remote-toggle': state.remote.enabled = !state.remote.enabled; S.save(); remoteApply().then(() => toast(state.remote.enabled ? 'Hosting. Open the link on your phone.' : 'Stopped hosting.')); return;
    case 'remote-copy': { const a = state.remoteStatus && state.remoteStatus.addresses && state.remoteStatus.addresses[0]; if (a) { navigator.clipboard.writeText(a.url); toast('Link copied.'); } return; }
    case 'remote-previews': state.remote.previews = !state.remote.previews; S.save(); renderSettings(); return;
    case 'remote-public': state.remote.public = !state.remote.public; S.save(); if (state.remote.enabled) remoteApply().then(() => toast(state.remote.public ? 'Internet access on. New 8-character code shown.' : 'Back to a home-network code.')); else renderSettings(); return;
    case 'remote-recheck': state.remotePublic = null; renderSettings(); window.astral.remote.publicIp().then((r) => { state.remotePublic = r; if (state.view === 'settings') renderSettings(); }); return;
    case 'remote-copy-public': if (state.remotePublic && state.remotePublic.ok) { navigator.clipboard.writeText(`http://${state.remotePublic.ip}:${state.remote.port || 5175}`); toast('Public link copied.'); } return;
    case 'convo-refresh': return loadConvos(true).then(() => { fillConvoProjects(); renderConvoList(); });
    case 'handoff-refresh': if (ws) { toast('Updating the handoff…'); updateHandoff(ws).then((r) => toast(r ? 'Handoff updated.' : 'No agent conversation to summarize yet.', !r)); } return;
  }
}
document.addEventListener('contextmenu', (e) => {
  const w = e.target.closest('[data-ws]');
  if (w) { e.preventDefault(); const ws = state.workspaces.find((x) => x.id === w.dataset.ws); if (ws) wsMenu(null, ws, e.clientX, e.clientY); }
  const c = e.target.closest('[data-chat]');
  if (c) { e.preventDefault(); const s = state.sessions.find((x) => x.id === c.dataset.chat); if (!s) return; const items = [{ label: 'Rename', icon: 'pencil', run: () => promptModal('Rename chat', s.name, { ok: 'Rename' }).then((v) => { if (v) { S.renameSession(s.id, v); s.autoName = false; } }) }, chat.isLive(s) ? { label: 'Stop', icon: 'square', run: () => stopAny(s) } : { label: s.agentSessionId ? 'Resume' : 'Start', icon: 'play', run: () => { if (chat.isChat(s)) chat.chatS(s.id).started = false; launch(s, { resume: !!s.agentSessionId }); } }]; if (s.agent === 'claude') items.push({ label: chat.isChat(s) ? 'Switch to Terminal UI' : 'Switch to Chat UI', icon: chat.isChat(s) ? 'terminal' : 'message', run: () => switchMode(s) }); items.push('-', { label: 'Close chat', icon: 'x', danger: true, run: () => closeChat(s) }); menu(e.clientX, e.clientY, items); }
});
document.addEventListener('change', (e) => {
  if (e.target.dataset && e.target.dataset.launchCmd) { const id = e.target.dataset.launchCmd, v = e.target.value.trim(); if (!v || v === agentOf(id).launch) delete state.launchOverride[id]; else state.launchOverride[id] = v; S.save(); toast(`Launch command for ${agentOf(id).name} saved.`); }
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'composer-input') { const s = S.activeSession(); if (s) composerDraft[s.id] = e.target.value; const b = $('composer-send'); if (b) b.classList.toggle('ready', !!e.target.value.trim()); autosize(e.target); }
  if (e.target.dataset && e.target.dataset.qEdit) { const s = S.activeSession(); if (s) chat.queueUpdate(s, e.target.dataset.qEdit, e.target.textContent); }
});
// An image attachment for the workspace's next message; `make` builds it (async).
async function addImage(ws, make) {
  try { const img = await make(); attach[ws.id] = (attach[ws.id] || []).concat([img]); S.emit('comments'); }
  catch (err) { toast(`Could not read image: ${err.message || err}`, true); }
}
function isChatDrop(e) { const ws = S.activeWorkspace(), s = S.activeSession(); return !!(ws && s && chat.isChat(s) && state.view === 'workspace' && (wsTab[ws.id] || 'chat') === 'chat'); }
document.addEventListener('dragover', (e) => { if (!isChatDrop(e) || !(e.dataTransfer && [...e.dataTransfer.types].includes('Files'))) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; const c = document.querySelector('.composer'); if (c) c.classList.add('is-drop'); });
document.addEventListener('dragleave', (e) => { if (e.relatedTarget) return; const c = document.querySelector('.composer'); if (c) c.classList.remove('is-drop'); });
document.addEventListener('drop', async (e) => {
  const c = document.querySelector('.composer'); if (c) c.classList.remove('is-drop');
  if (!isChatDrop(e)) return;
  const files = imageFilesOf(e.dataTransfer); if (!files.length) return;
  e.preventDefault();
  const ws = S.activeWorkspace();
  for (const f of files) await addImage(ws, () => imageFromBlob(f, f.name || 'image'));
  focusInput();
});
// click a picture in the conversation to see it full size
document.addEventListener('click', (e) => {
  if (e.target.dataset && e.target.dataset.imgZoom) { const z = document.createElement('div'); z.className = 'img-zoom'; z.innerHTML = `<img src="${e.target.src}" alt="">`; z.addEventListener('click', () => z.remove()); document.body.appendChild(z); return; }
});
document.addEventListener('paste', async (e) => {
  if (e.target.id !== 'composer-input') return;
  const s = S.activeSession(); if (!s) return;
  const images = imageFilesOf(e.clipboardData);
  if (images.length) {
    e.preventDefault();
    const ws = S.activeWorkspace(); if (!ws) return;
    for (const f of images) await addImage(ws, () => imageFromBlob(f, f.name && f.name !== 'image.png' ? f.name : `screenshot-${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}.png`));
    return;
  }
  const text = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
  if (!isLongPaste(text)) return;
  e.preventDefault();
  const ta = e.target; const token = storePaste(s.id, text.replace(/\r\n?/g, '\n'));
  ta.setRangeText(token, ta.selectionStart, ta.selectionEnd, 'end');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
});
document.addEventListener('keydown', (e) => {
  if (e.target.id === 'composer-input') {
    const s = S.activeSession();
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); composerSend(e.ctrlKey); }
    // Backspace right after a paste token removes the whole token, as one unit
    else if (e.key === 'Backspace' && e.target.selectionStart === e.target.selectionEnd) {
      const ta = e.target; const before = ta.value.slice(0, ta.selectionStart); const m = before.match(/\[Pasted text #\d+ \+\d+ (?:lines|chars)\]$/);
      if (m) { e.preventDefault(); ta.setRangeText('', ta.selectionStart - m[0].length, ta.selectionStart, 'end'); ta.dispatchEvent(new Event('input', { bubbles: true })); }
    }
    else if (e.key === 'Escape') { e.preventDefault(); if (s && chat.isChat(s) && chat.isLive(s)) chat.chatInterrupt(s); }
    else if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); if (s && chat.isChat(s)) setPerm(s, (s.perm || 'auto') === 'plan' ? 'auto' : 'plan'); }
  }
});
// drawer resize handle
(() => {
  const bar = $('drawer-bar'); let drag = null;
  bar.addEventListener('mousedown', (e) => { if (e.target.closest('button')) return; drag = { y: e.clientY, h: state.ui.drawerH || 240 }; document.body.style.cursor = 'ns-resize'; e.preventDefault(); });
  window.addEventListener('mousemove', (e) => { if (!drag) return; const h = Math.max(120, Math.min(window.innerHeight - 260, drag.h + (drag.y - e.clientY))); state.ui.drawerH = h; $('drawer').style.setProperty('--drawer-h', h + 'px'); tmDrawer.scheduleFit(); tmMain.scheduleFit(); });
  window.addEventListener('mouseup', () => { if (drag) { drag = null; document.body.style.cursor = ''; S.save(); } });
})();
const inTerm = (e) => e.target.classList && e.target.classList.contains('xterm-helper-textarea');
const inInput = (e) => ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || e.target.isContentEditable;
document.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  const ws = S.activeWorkspace(), s = S.activeSession();
  const ctrl = e.ctrlKey && !e.altKey;
  // Inside a terminal the CLI owns plain Ctrl+letter, Ctrl+punctuation and Alt+arrow
  // keys (Claude Code: Ctrl+B background, Ctrl+K kill line, Ctrl+R history, Alt+arrows
  // word moves; Gemini and Codex likewise). Only Ctrl+Shift chords, Ctrl+digits,
  // Ctrl+Tab and Ctrl+Alt chords stay app shortcuts there.
  const term = inTerm(e);
  if (term && ((ctrl && !e.shiftKey && !/^[1-9]$/.test(e.key) && e.key !== 'Tab' && e.key !== '`') || (e.altKey && !e.ctrlKey))) return;
  if (ctrl && !e.shiftKey && k === 'n') { e.preventDefault(); newWorkspaceDialog(); }
  else if (ctrl && e.shiftKey && k === 'n') { e.preventDefault(); newWorkspaceDialog({ from: true }); }
  else if (ctrl && k === 'k') { e.preventDefault(); openPalette(); }
  else if (ctrl && e.shiftKey && k === 'd') { e.preventDefault(); S.setUi({ panelOpen: !(state.ui.panelOpen && state.ui.panelTab === 'diff'), panelTab: 'diff' }); refreshChanges(true); S.emit('panel'); }
  else if (ctrl && e.shiftKey && k === 'c' && !inTerm(e)) { e.preventDefault(); S.setUi({ panelOpen: true, panelTab: 'checks' }); if (ws) refreshPR(ws, true); S.emit('panel'); }
  else if (ctrl && e.shiftKey && k === 'e') { e.preventDefault(); S.setUi({ panelOpen: true, panelTab: 'files' }); S.emit('panel'); }
  else if (ctrl && e.shiftKey && k === 'p') { e.preventDefault(); if (ws) createPRDialog(ws); }
  else if (ctrl && e.shiftKey && k === 'y') { e.preventDefault(); if (ws) commitPushDialog(ws); }
  else if (ctrl && e.shiftKey && k === 'l') { e.preventDefault(); if (ws) pullLatest(ws); }
  else if (ctrl && e.shiftKey && k === 't') { e.preventDefault(); S.setUi({ drawerOpen: !(state.ui.drawerOpen && state.ui.drawerBig), drawerBig: true }); }
  else if (ctrl && e.key === '`') { e.preventDefault(); S.setUi({ drawerOpen: !state.ui.drawerOpen }); if (!state.ui.drawerOpen) focusInput(); }
  else if (ctrl && e.shiftKey && k === 'r') { e.preventDefault(); openResume(); }
  else if (ctrl && !e.shiftKey && k === 'r' && !inTerm(e)) { e.preventDefault(); if (ws) runScript(ws, 'run'); }
  else if (ctrl && e.shiftKey && e.key === 'Backspace') { e.preventDefault(); if (s) stopAny(s); }
  else if (e.ctrlKey && e.altKey && k === 'l') { e.preventDefault(); nextAttention(); }
  else if (e.ctrlKey && e.altKey && e.key === 'ArrowUp') { e.preventDefault(); stepWorkspace(-1); }
  else if (e.ctrlKey && e.altKey && e.key === 'ArrowDown') { e.preventDefault(); stepWorkspace(1); }
  else if (ctrl && /^[1-9]$/.test(e.key)) { const list = state.repos.flatMap((r) => S.repoWorkspaces(r.id).sort((a, b) => b.updatedAt - a.updatedAt)); const w = list[+e.key - 1]; if (w) { e.preventDefault(); S.setActiveWorkspace(w.id); } }
  else if (ctrl && e.key === 'Tab') { e.preventDefault(); if (!ws) return; const list = S.workspaceSessions(ws.id); if (!list.length) return; const i = list.findIndex((x) => s && x.id === s.id); wsTab[ws.id] = 'chat'; S.setActiveChat(ws.id, list[(i + (e.shiftKey ? -1 : 1) + list.length) % list.length].id); }
  else if (ctrl && k === 'b') { e.preventDefault(); S.setUi({ sidebarOpen: !state.ui.sidebarOpen }); }
  else if (ctrl && e.key === '\\') { e.preventDefault(); S.setUi({ panelOpen: !state.ui.panelOpen }); }
  else if (ctrl && e.key === ',') { e.preventDefault(); S.setView('settings'); }
  else if (e.altKey && e.key === 'ArrowLeft') S.historyGo(-1);
  else if (e.altKey && e.key === 'ArrowRight') S.historyGo(1);
  else if (!inInput(e) && !inTerm(e) && ws && state.ui.panelOpen && state.ui.panelTab === 'diff' && (k === 'j' || k === 'k') && !e.ctrlKey) { e.preventDefault(); diff.nav(ws, k === 'j' ? 1 : -1); }
  else if (!inInput(e) && !inTerm(e) && ws && state.ui.panelOpen && state.ui.panelTab === 'diff' && ctrl && k === 'v') { const sel = diff.selected(ws); if (sel) { e.preventDefault(); diff.markViewed(ws, sel.file, !ws.viewed[sel.file]); } }
  else if (e.key === 'Escape' && document.querySelector('.img-zoom')) document.querySelector('.img-zoom').remove();
  else if (e.key === 'Escape' && !$('preview').hidden && e.target.id !== 'composer-input') closePreview();
  else if (e.key === 'Escape' && state.view !== 'workspace' && !document.querySelector('.overlay')) S.setView('workspace');
}, true);
window.astral.win.onMaximized((max) => { const g = $('maxglyph'); if (g) g.innerHTML = max ? I.winRestore : I.winMax; });

// ---------------------------------------------------------------- boot
window.__astral = { state, S, tmMain, tmDrawer, REGISTRY, chat, diff };
(async () => {
  PATHS = await window.astral.app.paths();
  state.winFocused = await window.astral.win.isFocused();
  await S.load();
  applyTheme(); applyWidths();
  remoteApply();
  if (state.activeWorkspaceId) { state.history = [state.activeWorkspaceId]; state.historyIdx = 0; }
  for (const r of state.repos) loadScripts(r);
  state.ghAvailable = await window.astral.gh.available();
  S.emit('all');
  if (!state.repos.length) setTimeout(addRepoDialog, 400);
  checkVersions(true);
  const ws = S.activeWorkspace(); if (ws) refreshPR(ws, true);
  // chats cut off mid-turn by the last close pick their work back up
  for (const s of state.sessions.filter((x) => x.working && chat.isChat(x) && x.agentSessionId)) {
    s.working = false;
    chat.launchChat(s, { resume: true, firstPrompt: 'Astral was closed while you were working on my last request. Continue from where you left off and finish it.' });
  }
  S.save();
})();
