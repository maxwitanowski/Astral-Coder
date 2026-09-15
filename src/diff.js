// Diff Viewer: the changes in a workspace, all of them or since a checkpoint,
// as a grouped file list plus a unified diff with line comments. Comments are
// composer attachments the agent gets on the next message.
import { state } from './store.js';
import * as S from './store.js';
import { esc, ic, basename, dirname, highlight, bus, toast, LANG_BY_EXT } from './core.js';
import { I } from './icons.js';

const sel = {};        // wsId -> { file, text, hunks }
const inflight = new Map();

export function currentFrom(ws) {
  if (state.ui.diffMode === 'turn') { const cp = ws.checkpoints[ws.checkpoints.length - 1]; return cp ? cp.tree : null; }
  if (state.ui.diffMode === 'checkpoint') return ws.diffFrom || null;
  return null;
}
export async function loadChanges(ws) {
  if (!ws) return;
  const from = currentFrom(ws);
  const key = ws.id;
  if (inflight.has(key)) return inflight.get(key);
  const p = window.astral.git.changes(ws.path, from).then((r) => {
    const prev = state.changes[ws.id];
    const sig = r && r.ok ? `${r.from}|${r.to}|${r.files.map((f) => `${f.path}:${f.add}:${f.del}`).join(',')}` : 'none';
    state.changes[ws.id] = r && r.ok ? { ...r, sig, mode: state.ui.diffMode } : { ok: false, error: r && r.error, sig, mode: state.ui.diffMode };
    if (!prev || prev.sig !== sig) { S.emit('changes'); if (sel[ws.id] && sel[ws.id].file) loadFile(ws, sel[ws.id].file, true); }
    return state.changes[ws.id];
  }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

function parseDiff(text) {
  const hunks = [];
  let cur = null, oldNo = 0, newNo = 0, binary = /^Binary files/m.test(text);
  const lines = text.replace(/\r/g, '').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) {
    if (line.startsWith('@@')) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/.exec(line);
      oldNo = m ? +m[1] : 0; newNo = m ? +m[2] : 0;
      cur = { header: line, ctx: m ? m[3].trim() : '', lines: [] }; hunks.push(cur); continue;
    }
    if (!cur) continue;
    if (line.startsWith('\\')) continue;
    if (line.startsWith('+')) cur.lines.push({ t: 'add', text: line.slice(1), n: newNo++ });
    else if (line.startsWith('-')) cur.lines.push({ t: 'del', text: line.slice(1), o: oldNo++ });
    else cur.lines.push({ t: 'eq', text: line.slice(1), o: oldNo++, n: newNo++ });
  }
  return { hunks, binary };
}
export async function loadFile(ws, file, silent = false) {
  const ch = state.changes[ws.id];
  if (!ch || !ch.ok) return;
  sel[ws.id] = { file, loading: true, hunks: null };
  if (!silent) S.emit('diffsel');
  const r = await window.astral.git.diffFile(ws.path, ch.from, ch.to, file);
  if (!sel[ws.id] || sel[ws.id].file !== file) return;
  if (!r.ok) { sel[ws.id] = { file, error: r.error }; S.emit('diffsel'); return; }
  const parsed = parseDiff(r.text);
  sel[ws.id] = { file, ...parsed, from: ch.from, to: ch.to };
  S.emit('diffsel');
}
export const selected = (ws) => (ws ? sel[ws.id] || null : null);
export function nav(ws, dir) {
  const ch = state.changes[ws.id]; if (!ch || !ch.ok || !ch.files.length) return;
  const cur = sel[ws.id] ? ch.files.findIndex((f) => f.path === sel[ws.id].file) : -1;
  const next = ch.files[(cur + dir + ch.files.length) % ch.files.length];
  loadFile(ws, next.path);
}
export function markViewed(ws, file, on) {
  const ch = state.changes[ws.id]; const f = ch && ch.files.find((x) => x.path === file);
  if (on) ws.viewed[file] = f ? `${f.add}:${f.del}` : '1'; else delete ws.viewed[file];
  S.save(); S.emit('changes');
}
const isViewed = (ws, f) => ws.viewed[f.path] === `${f.add}:${f.del}`;

// ---- comments ----
export function addComment(ws, { file, line, side, text, snippet }) {
  ws.comments.push({ id: S.uid(), file, line, side, text, snippet, at: Date.now() });
  S.save(); S.emit('comments'); S.emit('diffsel');
}
export function removeComment(ws, id) { ws.comments = ws.comments.filter((c) => c.id !== id); S.save(); S.emit('comments'); S.emit('diffsel'); }
export function clearComments(ws) { ws.comments = []; S.save(); S.emit('comments'); S.emit('diffsel'); }

// ---- rendering ----
const KIND = { A: 'added', D: 'deleted', M: 'modified', R: 'renamed', T: 'changed', U: 'unmerged' };
export function renderPanel(body, ws) {
  if (!ws) { body.innerHTML = `<div class="panel-empty">Open a workspace to review its changes.</div>`; return; }
  const ch = state.changes[ws.id];
  const cps = ws.checkpoints || [];
  const modeLabel = state.ui.diffMode === 'turn' ? 'Since last turn' : state.ui.diffMode === 'checkpoint' ? 'Since a turn' : 'All changes';
  const head = `<div class="diff-head">
      <button class="pill-btn" data-act="diff-mode" title="What to compare against">${ic('gitCompare', 'i-sm')}<span>${esc(modeLabel)}</span>${ic('chevronDown', 'i-sm')}</button>
      ${ch && ch.ok ? `<span class="stats"><span class="a">+${ch.add}</span><span class="d">−${ch.del}</span><span class="n">${ch.files.length} file${ch.files.length === 1 ? '' : 's'}</span></span>` : ''}
      <span class="grow"></span>
      <button class="icon-btn sm ${state.ui.groupByFolder ? 'is-on' : ''}" data-act="diff-group" title="Group by folder">${ic('folder', 'i-sm')}</button>
      <button class="icon-btn sm" data-act="diff-refresh" title="Refresh">${ic('refresh', 'i-sm')}</button>
    </div>`;
  if (!ch) { body.innerHTML = head + `<div class="panel-empty">Reading changes…</div>`; return; }
  if (!ch.ok) { body.innerHTML = head + `<div class="panel-empty">${ch.error === 'home' ? 'This folder is not a git repository.' : esc(ch.error || 'Could not read the repository.')}</div>`; return; }
  if (!ch.files.length) { body.innerHTML = head + `<div class="panel-empty"><div class="big">${ic('checkCircle')}</div>No changes${state.ui.diffMode !== 'all' ? ' since that turn' : ' in this workspace'}.${cps.length && state.ui.diffMode === 'all' ? '' : ''}</div>`; return; }
  const s = sel[ws.id];
  const viewedCount = ch.files.filter((f) => isViewed(ws, f)).length;
  const row = (f) => `<div class="dfile ${s && s.file === f.path ? 'is-sel' : ''} ${isViewed(ws, f) ? 'viewed' : ''}" data-diff-file="${esc(f.path)}" title="${esc(f.path)}">
      <span class="chk" data-diff-viewed="${esc(f.path)}" title="Mark viewed (Ctrl+V while browsing)">${isViewed(ws, f) ? ic('check2', 'i-sm') : ''}</span>
      <span class="kind ${f.kind}">${f.kind}</span><span class="f">${esc(basename(f.path))}</span>${!state.ui.groupByFolder && dirname(f.path) ? `<span class="dir">${esc(dirname(f.path))}</span>` : ''}
      <span class="stats">${f.binary ? '<span class="bin">bin</span>' : ''}${f.add ? `<span class="a">+${f.add}</span>` : ''}${f.del ? `<span class="d">−${f.del}</span>` : ''}</span>
      ${ws.comments.some((c) => c.file === f.path) ? `<span class="cm" title="has comments">${ic('message', 'i-sm')}</span>` : ''}</div>`;
  let list = '';
  if (state.ui.groupByFolder) {
    const groups = new Map();
    for (const f of ch.files) { const d = dirname(f.path) || '/'; if (!groups.has(d)) groups.set(d, []); groups.get(d).push(f); }
    list = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([d, fs]) => `<div class="ddir">${ic('folder', 'i-sm')}<span>${esc(d)}</span><span class="n">${fs.length}</span></div>${fs.map(row).join('')}`).join('');
  } else list = ch.files.map(row).join('');
  const files = `<div class="diff-files"><div class="dsum"><span>${viewedCount}/${ch.files.length} viewed</span><span class="grow"></span><span class="hint">J / K next · prev file</span></div>${list}</div>`;
  body.innerHTML = head + files + `<div class="diff-view" id="diff-view">${renderFile(ws)}</div>`;
  const cur = body.querySelector('.dfile.is-sel'); if (cur) cur.scrollIntoView({ block: 'nearest' });
}

function lang(file) { const ext = (file.split('.').pop() || '').toLowerCase(); return LANG_BY_EXT[ext] || null; }
export function renderFile(ws) {
  const s = sel[ws.id];
  if (!s) return `<div class="panel-empty small">Select a file to see its diff.</div>`;
  if (s.loading) return `<div class="dv-head">${ic('file', 'i-sm')}<span class="p">${esc(s.file)}</span></div><div class="panel-empty small">Loading…</div>`;
  if (s.error) return `<div class="dv-head">${ic('file', 'i-sm')}<span class="p">${esc(s.file)}</span></div><div class="panel-empty small">${esc(s.error)}</div>`;
  const l = lang(s.file);
  const comments = ws.comments.filter((c) => c.file === s.file);
  const commentRows = (line, side) => comments.filter((c) => c.line === line && c.side === side).map((c) => `<div class="dcomment" data-comment="${c.id}"><div class="ct">${ic('message', 'i-sm')}<span>Your comment</span><span class="grow"></span><button class="icon-btn sm" data-comment-del="${c.id}" title="Delete">${ic('trash', 'i-sm')}</button></div><div class="cb">${esc(c.text)}</div></div>`).join('');
  const head = `<div class="dv-head">${ic('file', 'i-sm')}<span class="p" title="${esc(s.file)}">${esc(s.file)}</span><span class="grow"></span><button class="icon-btn sm" data-open-file="${esc(ws.path.replace(/[\\/]$/, '') + '\\' + s.file.replace(/\//g, '\\'))}" title="Open file">${ic('externalLink', 'i-sm')}</button></div>`;
  if (s.binary || !s.hunks.length) return head + `<div class="panel-empty small">${s.binary ? 'Binary file.' : 'No textual changes.'}</div>`;
  const body = s.hunks.map((h) => `<div class="hunk"><div class="hh">${esc(h.header.replace(/@@.*@@/, (m) => m))}</div>${h.lines.map((ln) => {
    const line = ln.t === 'del' ? ln.o : ln.n; const side = ln.t === 'del' ? 'old' : 'new';
    const code = l ? highlight(ln.text, null, l) : esc(ln.text);
    return `<div class="dl ${ln.t}" data-line="${line}" data-side="${side}"><span class="g o">${ln.o || ''}</span><span class="g n">${ln.n || ''}</span><button class="add-c" data-add-comment="${line}" data-side="${side}" title="Comment on this line">${I.plus}</button><span class="s">${ln.t === 'add' ? '+' : ln.t === 'del' ? '−' : ' '}</span><span class="c">${code || ' '}</span></div>${commentRows(line, side)}`;
  }).join('')}</div>`).join('');
  return head + `<div class="dv-body" data-file="${esc(s.file)}">${body}</div>`;
}

// inline comment editor
export function openCommentEditor(ws, rowEl, line, side) {
  const s = sel[ws.id]; if (!s) return;
  document.querySelectorAll('.dcomment-edit').forEach((x) => x.remove());
  const ed = document.createElement('div');
  ed.className = 'dcomment-edit';
  ed.innerHTML = `<textarea placeholder="Leave a comment for the agent… (Ctrl+Enter to add)"></textarea><div class="acts"><button class="btn ghost" data-c-cancel>Cancel</button><button class="btn primary" data-c-save>Add to composer</button></div>`;
  rowEl.after(ed);
  const ta = ed.querySelector('textarea'); ta.focus();
  const save = () => {
    const text = ta.value.trim(); if (!text) { ta.focus(); return; }
    const snippet = rowEl.querySelector('.c') ? rowEl.querySelector('.c').textContent : '';
    addComment(ws, { file: s.file, line, side, text, snippet });
    toast('Comment attached to the composer.');
  };
  ed.querySelector('[data-c-save]').onclick = save;
  ed.querySelector('[data-c-cancel]').onclick = () => ed.remove();
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); save(); } if (e.key === 'Escape') { e.preventDefault(); ed.remove(); } e.stopPropagation(); });
}
