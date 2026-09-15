// Plain reactive store: state + subscribe, persisted through the main process.
//
// Model (Conductor's): a repository has workspaces; a workspace is one stream
// of work on its own branch in its own git worktree, holding one or more chats
// (sessions) plus a terminal, run scripts and notes.
const listeners = new Set();

export const state = {
  repos: [],        // {id, name, path, createdAt, base?, includes?}
  workspaces: [],   // {id, repoId, name, path, branch, local, createdAt, updatedAt, archived, archivedAt, activeChatId, unread, pinned, port, notes, viewed:{}, comments:[], checkpoints:[], lastSetup}
  sessions: [],     // chats: {id, workspaceId, name, agent, cwd, agentSessionId, transcript, command, kind, model, mode, perm, createdAt, lastActive, autoName}
  activeWorkspaceId: null,
  view: 'workspace',     // workspace | history | settings
  settingsTab: 'general',
  ui: {
    theme: 'system',      // system | light | dark
    font: 'system',       // system | inter | mono
    sounds: true,
    notifications: true,
    followUp: 'queue',    // queue | steer
    sidebarOpen: true,
    panelOpen: true,
    panelTab: 'diff',     // diff | checks | files
    drawerOpen: false,
    drawerBig: false,
    drawerH: 240,
    diffMode: 'all',      // all | turn
    groupByFolder: true,
    hideWs: false,
    sidebarSort: 'updated', // updated | created
  },
  models: {},            // agentId -> default model id
  launchOverride: {},    // agentId -> custom launch command
  launcherAgents: ['claude', 'codex', 'shell'],
  // runtime only
  versions: {}, versionsAt: 0,
  live: {},              // sessionId -> {status, lastOutput, attention, sawWork}
  events: {},            // sessionId -> telemetry events
  focusFile: {},
  git: {},               // path -> git:info
  changes: {},           // wsId -> git:changes result for the current diff mode
  pr: {},                // wsId -> {pr, checks, at}
  chat: {},
  scripts: {},           // repoId -> conductor settings
  ghAvailable: null,
  history: [], historyIdx: -1,
  loaded: false,
  winFocused: true,
};

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function emit(kind = 'all') { for (const fn of listeners) fn(kind); }

const PERSIST = ['repos', 'workspaces', 'sessions', 'activeWorkspaceId', 'view', 'settingsTab', 'ui', 'models', 'launchOverride', 'launcherAgents'];
let saveTimer = null;
export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const data = {};
    for (const k of PERSIST) data[k] = state[k];
    window.astral.store.save(data);
  }, 120);
}

export function uid() { return crypto.randomUUID(); }

// Older Astral data had projects + flat sessions. Each project becomes a
// repository with one "local" workspace (the checkout itself) holding its chats.
function migrate(data) {
  if (!data || data.repos || !data.projects) return data;
  const out = { ...data };
  out.repos = data.projects.map((p) => ({ id: p.id, name: p.name, path: p.path, createdAt: p.createdAt || Date.now() }));
  out.workspaces = [];
  out.sessions = [];
  for (const p of data.projects) {
    const ws = { id: uid(), repoId: p.id, name: 'local', path: p.path, branch: null, local: true, createdAt: p.createdAt || Date.now(), updatedAt: Date.now(), archived: false, activeChatId: null, unread: false, notes: '', viewed: {}, comments: [], checkpoints: [] };
    out.workspaces.push(ws);
    for (const s of (data.sessions || []).filter((x) => x.projectId === p.id)) {
      if (s.branch && s.cwd && s.cwd !== p.path) {
        const w2 = { id: uid(), repoId: p.id, name: s.branch.replace(/^astral\//, ''), path: s.cwd, branch: s.branch, local: false, createdAt: s.createdAt, updatedAt: s.lastActive || s.createdAt, archived: false, activeChatId: s.id, unread: false, notes: '', viewed: {}, comments: [], checkpoints: [] };
        out.workspaces.push(w2);
        out.sessions.push({ ...s, workspaceId: w2.id });
      } else {
        out.sessions.push({ ...s, workspaceId: ws.id });
        if (!ws.activeChatId || s.id === data.activeSessionId) ws.activeChatId = s.id;
      }
      if (s.id === data.activeSessionId) out.activeWorkspaceId = out.sessions[out.sessions.length - 1].workspaceId;
    }
  }
  if (!out.activeWorkspaceId && out.workspaces[0]) out.activeWorkspaceId = out.workspaces[0].id;
  out.ui = { ...state.ui, sidebarOpen: data.sidebarOpen !== false, panelOpen: data.telemetryOpen !== false };
  out.view = 'workspace';
  delete out.projects; delete out.activeProjectId; delete out.activeSessionId; delete out.tasks; delete out.conductor;
  return out;
}

export async function load() {
  let data = await window.astral.store.load();
  data = migrate(data);
  if (data) for (const k of PERSIST) if (k in data) state[k] = k === 'ui' ? { ...state.ui, ...data.ui } : data[k];
  for (const w of state.workspaces) { w.viewed = w.viewed || {}; w.comments = w.comments || []; w.checkpoints = w.checkpoints || []; w.notes = w.notes || ''; }
  if (!['workspace', 'history', 'settings'].includes(state.view)) state.view = 'workspace';
  state.loaded = true;
  emit('all');
}

// ---- repositories ----
export function addRepo(name, dir) {
  const r = { id: uid(), name, path: dir, createdAt: Date.now() };
  state.repos.push(r);
  save(); emit('all');
  return r;
}
export function renameRepo(id, name) { const r = state.repos.find((x) => x.id === id); if (r) { r.name = name; save(); emit('repos'); } }
export function removeRepo(id) {
  state.repos = state.repos.filter((r) => r.id !== id);
  const wsIds = new Set(state.workspaces.filter((w) => w.repoId === id).map((w) => w.id));
  state.workspaces = state.workspaces.filter((w) => w.repoId !== id);
  state.sessions = state.sessions.filter((s) => !wsIds.has(s.workspaceId));
  if (wsIds.has(state.activeWorkspaceId)) state.activeWorkspaceId = (state.workspaces.find((w) => !w.archived) || {}).id || null;
  save(); emit('all');
}

// ---- workspaces ----
export function addWorkspace(ws) {
  const w = { id: uid(), createdAt: Date.now(), updatedAt: Date.now(), archived: false, activeChatId: null, unread: false, notes: '', viewed: {}, comments: [], checkpoints: [], ...ws };
  state.workspaces.push(w);
  save(); emit('all');
  return w;
}
export function touchWorkspace(id) { const w = state.workspaces.find((x) => x.id === id); if (w) { w.updatedAt = Date.now(); save(); } }
export function setActiveWorkspace(id, { fromHistory = false } = {}) {
  const w = state.workspaces.find((x) => x.id === id);
  if (!w) return;
  state.activeWorkspaceId = id;
  state.view = 'workspace';
  w.unread = false;
  for (const s of state.sessions.filter((x) => x.workspaceId === id)) if (state.live[s.id]) state.live[s.id].attention = false;
  if (!fromHistory && state.history[state.historyIdx] !== id) {
    state.history = state.history.slice(0, state.historyIdx + 1).concat(id).slice(-50);
    state.historyIdx = state.history.length - 1;
  }
  save(); emit('all');
}
export function historyGo(delta) {
  const i = state.historyIdx + delta;
  while (i >= 0 && i < state.history.length) {
    const id = state.history[i];
    if (state.workspaces.find((w) => w.id === id && !w.archived)) { state.historyIdx = i; setActiveWorkspace(id, { fromHistory: true }); return; }
    state.history.splice(i, 1);
  }
}
export function archiveWorkspace(id, archived = true) {
  const w = state.workspaces.find((x) => x.id === id);
  if (!w) return;
  w.archived = archived; w.archivedAt = archived ? Date.now() : null;
  if (archived && state.activeWorkspaceId === id) {
    const next = state.workspaces.filter((x) => x.repoId === w.repoId && !x.archived && x.id !== id).sort((a, b) => b.updatedAt - a.updatedAt)[0] || state.workspaces.find((x) => !x.archived && x.id !== id);
    state.activeWorkspaceId = next ? next.id : null;
  }
  save(); emit('all');
}
export function removeWorkspace(id) {
  state.workspaces = state.workspaces.filter((w) => w.id !== id);
  state.sessions = state.sessions.filter((s) => s.workspaceId !== id);
  if (state.activeWorkspaceId === id) state.activeWorkspaceId = (state.workspaces.find((w) => !w.archived) || {}).id || null;
  save(); emit('all');
}

// ---- sessions (chats) ----
export function addSession({ workspaceId, name, agent, cwd, agentSessionId = null, transcript = null, command = null, kind = 'agent', model = null, mode = null, perm = null }) {
  const s = { id: uid(), workspaceId, name, agent, cwd, agentSessionId, transcript, command, kind, model, mode, perm, createdAt: Date.now(), lastActive: Date.now() };
  state.sessions.push(s);
  const w = state.workspaces.find((x) => x.id === workspaceId);
  if (w) { w.activeChatId = s.id; w.updatedAt = Date.now(); }
  save(); emit('all');
  return s;
}
export function renameSession(id, name) { const s = state.sessions.find((x) => x.id === id); if (s) { s.name = name; save(); emit('sessions'); } }
export function removeSession(id) {
  const s = state.sessions.find((x) => x.id === id);
  state.sessions = state.sessions.filter((x) => x.id !== id);
  delete state.live[id]; delete state.events[id]; delete state.focusFile[id]; delete state.chat[id];
  try { window.astral.chat.historyDelete(id); } catch { /* ignore */ }
  if (s) { const w = state.workspaces.find((x) => x.id === s.workspaceId); if (w && w.activeChatId === id) { const next = state.sessions.filter((x) => x.workspaceId === w.id).pop(); w.activeChatId = next ? next.id : null; } }
  save(); emit('all');
}
export function setActiveChat(wsId, sessionId) {
  const w = state.workspaces.find((x) => x.id === wsId);
  if (!w) return;
  w.activeChatId = sessionId;
  const s = state.sessions.find((x) => x.id === sessionId);
  if (s) { s.lastActive = Date.now(); if (state.live[s.id]) state.live[s.id].attention = false; }
  save(); emit('all');
}
export function bindAgentSession(id, agentSessionId, transcript) {
  const s = state.sessions.find((x) => x.id === id);
  if (s) { s.agentSessionId = agentSessionId; if (transcript) s.transcript = transcript; save(); emit('sessions'); }
}
export function setLive(id, status) {
  const cur = state.live[id] || {};
  state.live[id] = { ...cur, status, lastOutput: status === 'working' ? Date.now() : cur.lastOutput };
  emit('live');
}
export function pushEvents(id, evs) {
  const arr = state.events[id] || (state.events[id] = []);
  for (const e of evs) {
    if (e.kind === 'tool_result') {
      const t = arr.findLast ? arr.findLast((x) => x.kind === 'tool' && x.id === e.id) : [...arr].reverse().find((x) => x.kind === 'tool' && x.id === e.id);
      if (t) { t.done = true; t.error = e.error; }
      continue;
    }
    if (e.kind === 'title') {
      const s = state.sessions.find((x) => x.id === id);
      if (s && s.autoName) { s.name = e.text; save(); emit('sessions'); }
      continue;
    }
    if (e.kind === 'tool' && e.file) state.focusFile[id] = e.file;
    arr.push(e);
  }
  if (arr.length > 600) arr.splice(0, arr.length - 600);
  emit('events');
}
export function setUi(patch) { Object.assign(state.ui, patch); save(); emit('layout'); }
export function setView(view, extra = {}) { state.view = view; Object.assign(state, extra); save(); emit('all'); }

// ---- selectors ----
export const activeWorkspace = () => state.workspaces.find((w) => w.id === state.activeWorkspaceId) || null;
export const activeRepo = () => { const w = activeWorkspace(); return w ? state.repos.find((r) => r.id === w.repoId) || null : null; };
export const workspaceSessions = (wsId) => state.sessions.filter((s) => s.workspaceId === wsId).sort((a, b) => a.createdAt - b.createdAt);
export const activeSession = () => { const w = activeWorkspace(); if (!w) return null; return state.sessions.find((s) => s.id === w.activeChatId) || workspaceSessions(w.id)[0] || null; };
export const repoWorkspaces = (repoId, archived = false) => state.workspaces.filter((w) => w.repoId === repoId && !!w.archived === archived);
export const repoOf = (ws) => state.repos.find((r) => r.id === ws.repoId) || null;
export const workspaceOfSession = (sid) => { const s = state.sessions.find((x) => x.id === sid); return s ? state.workspaces.find((w) => w.id === s.workspaceId) || null : null; };
