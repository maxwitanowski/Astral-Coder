const { app, BrowserWindow, ipcMain, dialog, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync, execFile, spawn } = require('child_process');
const pty = require('node-pty');
const agents = require('./agents.cjs');
const remoteMod = require('./remote.cjs');

const DEV = !!process.env.ASTRAL_DEV;
const STORE = () => path.join(app.getPath('userData'), 'astral.json');
const HOME = os.homedir();
// Same layout Conductor uses, so the two can share workspaces on one machine.
const WORKSPACES_ROOT = path.join(HOME, 'conductor', 'workspaces');

// Keep the window live while another window covers it. Chromium otherwise
// treats a fully occluded window as hidden and pauses rendering and timers;
// terminals then stall and every queued layout pass lands at once when the
// window is revealed. A console hosting live agents should not do that.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

let win = null;
const ptys = new Map();

function createWindow() {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 960,
    minHeight: 600,
    frame: false,
    icon: path.join(__dirname, '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    backgroundColor: '#ffffff',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.once('ready-to-show', () => win.show());
  win.on('maximize', () => win.webContents.send('win:maximized', true));
  win.on('unmaximize', () => win.webContents.send('win:maximized', false));
  win.on('focus', () => win.webContents.send('win:focus', true));
  win.on('blur', () => win.webContents.send('win:focus', false));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });

  if (DEV) win.loadURL('http://localhost:5174');
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}
const send = (ch, ...args) => { if (win && !win.isDestroyed()) win.webContents.send(ch, ...args); };

// ---- window chrome ----
ipcMain.handle('win:minimize', () => win.minimize());
ipcMain.handle('win:maximize', () => (win.isMaximized() ? win.unmaximize() : win.maximize()));
ipcMain.handle('win:close', () => win.close());
ipcMain.handle('win:isMaximized', () => win.isMaximized());
ipcMain.handle('win:isFocused', () => win.isFocused());
ipcMain.handle('app:paths', () => ({ home: HOME, workspacesRoot: WORKSPACES_ROOT, userData: app.getPath('userData'), platform: process.platform }));

// ---- store ----
// A store that fails to parse must never be replaced by an empty one: the
// loader tolerates a BOM, and every save keeps the previous file as .bak.
ipcMain.handle('store:load', () => {
  const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
  try { return read(STORE()); } catch (err) {
    try { const d = read(STORE() + '.bak'); console.warn('store: restored from backup:', err.message); return d; } catch { return null; }
  }
});
ipcMain.handle('store:save', (_e, data) => {
  const tmp = STORE() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  try { if (fs.existsSync(STORE())) fs.copyFileSync(STORE(), STORE() + '.bak'); } catch { /* best effort */ }
  fs.renameSync(tmp, STORE());
  return true;
});
// ---- chat history: Astral's own message list per chat session, so a relaunch
// shows the full conversation (tool output included) without replaying the CLI
const CHATS_DIR = () => path.join(app.getPath('userData'), 'chats');
ipcMain.handle('chat:history:save', (_e, id, msgs) => {
  try { fs.mkdirSync(CHATS_DIR(), { recursive: true }); const f = path.join(CHATS_DIR(), `${id}.json`); fs.writeFileSync(f + '.tmp', JSON.stringify(msgs)); fs.renameSync(f + '.tmp', f); return true; } catch { return false; }
});
ipcMain.handle('chat:history:load', (_e, id) => {
  try { return JSON.parse(fs.readFileSync(path.join(CHATS_DIR(), `${id}.json`), 'utf8')); } catch { return null; }
});
ipcMain.handle('chat:history:delete', (_e, id) => { try { fs.unlinkSync(path.join(CHATS_DIR(), `${id}.json`)); } catch { /* none */ } return true; });
// ---- handoff brief for the next agent, written into the workspace
ipcMain.handle('agents:handoff', (_e, { agent, cwd, agentSessionId, file, agentName, notes }) => {
  try {
    if (!file && agent === 'claude' && agentSessionId) file = agents.claudeTranscriptPath(cwd, agentSessionId);
    if (!file || !fs.existsSync(file)) return { ok: false, error: 'no transcript' };
    let md = agents.handoffBrief({ agent, file, agentName: agentName || agent });
    if (notes && String(notes).trim()) md += `\n## Notes from the user (the workspace Notes tab)\n\n${String(notes).trim()}\n`;
    const dir = path.join(cwd, '.astral'); fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, 'handoff.md'); fs.writeFileSync(out, md);
    // keep it out of git without touching .gitignore
    try { const gi = path.join(cwd, '.git', 'info'); if (fs.existsSync(path.join(cwd, '.git')) && fs.statSync(path.join(cwd, '.git')).isDirectory()) { fs.mkdirSync(gi, { recursive: true }); const ex = path.join(gi, 'exclude'); const cur = fs.existsSync(ex) ? fs.readFileSync(ex, 'utf8') : ''; if (!/^\.astral\/?$/m.test(cur)) fs.appendFileSync(ex, (cur && !cur.endsWith('\n') ? '\n' : '') + '.astral/\n'); } } catch { /* not a repo */ }
    return { ok: true, path: out, rel: '.astral/handoff.md', bytes: md.length, md };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('dialog:folder', async (_e, defaultPath) => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    defaultPath: defaultPath && fs.existsSync(defaultPath) ? defaultPath : HOME,
  });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dialog:files', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));
ipcMain.handle('shell:openExternal', (_e, url) => shell.openExternal(url));
ipcMain.handle('shell:openIn', (_e, kind, dir) => {
  const opts = { cwd: dir, detached: true, stdio: 'ignore', shell: true, windowsHide: false };
  try {
    if (kind === 'code') spawn('code', ['.'], opts).unref();
    else if (kind === 'cursor') spawn('cursor', ['.'], opts).unref();
    else if (kind === 'wt') spawn('wt', ['-d', `"${dir}"`], opts).unref();
    else if (kind === 'powershell') spawn('start', ['powershell', '-NoExit', '-Command', `"Set-Location '${dir.replace(/'/g, "''")}'"`], opts).unref();
    else return shell.openPath(dir);
    return '';
  } catch (err) { return err.message; }
});
ipcMain.handle('shell:which', (_e, cmd) => whichSync(cmd));
function whichSync(cmd) {
  try {
    const out = execSync(`where ${cmd}`, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split(/\r?\n/).filter(Boolean)[0] || null;
  } catch { return null; }
}

// ---- notifications ----
ipcMain.handle('notify', (_e, { title, body, tag }) => {
  if (!Notification.isSupported()) return false;
  const n = new Notification({ title: title || 'Astral', body: body || '', silent: true });
  n.on('click', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } send('notify:click', tag); });
  n.show();
  return true;
});

// ---- files ----
const IMAGE_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.bmp': 'image/bmp' };
ipcMain.handle('fs:read', (_e, file) => {
  try {
    const st = fs.statSync(file);
    if (st.isDirectory()) return { kind: 'dir' };
    const ext = path.extname(file).toLowerCase();
    if (IMAGE_EXT[ext]) {
      if (st.size > 15 * 1024 * 1024) return { kind: 'binary', size: st.size };
      return { kind: 'image', dataUrl: `data:${IMAGE_EXT[ext]};base64,${fs.readFileSync(file).toString('base64')}`, size: st.size };
    }
    if (st.size > 2 * 1024 * 1024) return { kind: 'binary', size: st.size, reason: 'too large' };
    const buf = fs.readFileSync(file);
    const head = buf.subarray(0, 8000);
    let nul = 0; for (const b of head) if (b === 0) nul++;
    if (nul > 0) return { kind: 'binary', size: st.size };
    return { kind: 'text', text: buf.toString('utf8'), size: st.size, lines: buf.toString('utf8').split('\n').length };
  } catch (err) { return { kind: 'error', error: err.message }; }
});
ipcMain.handle('fs:list', (_e, dir) => {
  try {
    const ents = fs.readdirSync(dir, { withFileTypes: true });
    return ents
      .filter((e) => !['node_modules', '.git'].includes(e.name))
      .map((e) => ({ name: e.name, dir: e.isDirectory() }))
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  } catch { return []; }
});
ipcMain.handle('fs:exists', (_e, p) => fs.existsSync(p));
ipcMain.handle('fs:writeText', (_e, file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return true; });

// ---- git (async, scoped, never blocks the main process) ----
function git(dir, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: opts.timeout || 15000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(opts.env || {}) } }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve(stdout)));
  });
}
const errText = (err) => String((err && (err.stderr || err.message)) || err).trim();
async function toplevel(dir) { return (await git(dir, ['rev-parse', '--show-toplevel'])).trim(); }
function isHomeRoot(root) { return root.replace(/\\/g, '/').toLowerCase() === HOME.replace(/\\/g, '/').toLowerCase(); }

async function baseBranch(dir) {
  try { const r = (await git(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim(); if (r) return r.replace(/^origin\//, ''); } catch { /* no origin/HEAD */ }
  for (const b of ['main', 'master', 'develop']) { try { await git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]); return b; } catch { /* next */ } }
  try { return (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(); } catch { return 'main'; }
}

ipcMain.handle('git:info', async (_e, dir) => {
  try {
    if (!fs.existsSync(dir)) return { isRepo: false };
    const root = await toplevel(dir);
    if (isHomeRoot(root)) return { isRepo: false, home: true };
    let branch = 'HEAD';
    try { branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(); } catch { /* unborn */ }
    let upstream = null, ahead = 0, behind = 0;
    try {
      upstream = (await git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim();
      const ab = (await git(dir, ['rev-list', '--left-right', '--count', 'HEAD...@{u}'])).trim().split(/\s+/);
      ahead = +ab[0] || 0; behind = +ab[1] || 0;
    } catch { /* no upstream */ }
    let head = null;
    try { const l = (await git(dir, ['log', '-1', '--format=%h%x1f%s%x1f%cr'])).trim().split('\x1f'); head = { sha: l[0], subject: l[1], when: l[2] }; } catch { /* no commits */ }
    const status = await git(dir, ['status', '--porcelain=v1', '-uall', '--', '.']);
    const dirty = status.split(/\r?\n/).filter((l) => l.length > 3).length;
    let remote = null;
    try { remote = (await git(dir, ['remote', 'get-url', 'origin'])).trim(); } catch { /* none */ }
    return { isRepo: true, root, branch, upstream, ahead, behind, head, dirty, base: await baseBranch(dir), remote };
  } catch (err) { return { isRepo: false, error: errText(err) }; }
});

// Working-tree snapshot as a private tree object: the real index is untouched,
// so the agent's staging never changes. Used for checkpoints and for diffs
// that include untracked files.
async function snapshot(dir) {
  const idx = path.join(os.tmpdir(), `astral-idx-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    try { const real = (await git(dir, ['rev-parse', '--git-path', 'index'])).trim(); const realAbs = path.isAbsolute(real) ? real : path.join(dir, real); if (fs.existsSync(realAbs)) fs.copyFileSync(realAbs, idx); } catch { /* start empty */ }
    const env = { GIT_INDEX_FILE: idx };
    await git(dir, ['add', '-A', '--', '.'], { env, timeout: 60000 });
    return (await git(dir, ['write-tree'], { env })).trim();
  } finally { try { fs.unlinkSync(idx); } catch { /* gone */ } }
}
const snapCache = new Map();
async function snapshotCached(dir) {
  const c = snapCache.get(dir);
  if (c && Date.now() - c.at < 1500) return c.p;
  const p = snapshot(dir);
  snapCache.set(dir, { at: Date.now(), p });
  return p;
}
ipcMain.handle('git:snapshot', async (_e, dir) => { try { return { ok: true, tree: await snapshot(dir) }; } catch (err) { return { ok: false, error: errText(err) }; } });

function parseNumstat(txt) {
  const out = {};
  for (const line of txt.split(/\r?\n/)) { const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line); if (m) out[m[3].replace(/^"|"$/g, '')] = { add: m[1] === '-' ? 0 : +m[1], del: m[2] === '-' ? 0 : +m[2], binary: m[1] === '-' }; }
  return out;
}
// Changes between a base tree-ish (HEAD by default, or a checkpoint tree) and
// the working tree including untracked files.
const changesInflight = new Map();
ipcMain.handle('git:changes', (_e, dir, from) => {
  const key = dir + '|' + (from || '');
  if (changesInflight.has(key)) return changesInflight.get(key);
  const p = (async () => {
    try {
      if (!fs.existsSync(dir)) return { ok: false, error: 'missing' };
      const root = await toplevel(dir);
      if (isHomeRoot(root)) return { ok: false, error: 'home' };
      let base = from || 'HEAD';
      try { await git(dir, ['rev-parse', '--verify', '--quiet', base + '^{tree}']); } catch { base = (await git(dir, ['hash-object', '-t', 'tree', '/dev/null']).catch(() => '4b825dc642cb6eb9a060e54bf8d69288fbee4904')).trim(); }
      const to = await snapshotCached(dir);
      const numstat = parseNumstat(await git(dir, ['diff', '--numstat', '--no-renames', base, to, '--', '.']));
      const names = await git(dir, ['diff', '--name-status', '--no-renames', base, to, '--', '.']);
      const files = [];
      for (const line of names.split(/\r?\n/)) {
        const m = /^([A-Z])\t(.+)$/.exec(line); if (!m) continue;
        const p = m[2].replace(/^"|"$/g, '');
        const ns = numstat[p] || { add: 0, del: 0 };
        files.push({ path: p, kind: m[1], add: ns.add, del: ns.del, binary: !!ns.binary });
        if (files.length >= 800) break;
      }
      return { ok: true, root, from: base, to, files, add: files.reduce((s, f) => s + f.add, 0), del: files.reduce((s, f) => s + f.del, 0) };
    } catch (err) { return { ok: false, error: errText(err) }; }
  })().finally(() => changesInflight.delete(key));
  changesInflight.set(key, p);
  return p;
});
ipcMain.handle('git:diffFile', async (_e, dir, from, to, file) => {
  try {
    const text = await git(dir, ['diff', '--no-color', '--no-ext-diff', '-U3', from, to, '--', file], { timeout: 20000 });
    return { ok: true, text };
  } catch (err) { return { ok: false, error: errText(err) }; }
});
ipcMain.handle('git:show', async (_e, dir, tree, file) => {
  try { return { ok: true, text: await git(dir, ['show', `${tree}:${file}`]) }; } catch (err) { return { ok: false, error: errText(err) }; }
});
ipcMain.handle('git:log', async (_e, dir, n, range) => {
  try {
    const args = ['log', `-${n || 20}`, '--format=%h%x1f%s%x1f%an%x1f%cr%x1f%H'];
    if (range) args.push(range);
    const out = await git(dir, args);
    return out.split(/\r?\n/).filter(Boolean).map((l) => { const p = l.split('\x1f'); return { sha: p[0], subject: p[1], author: p[2], when: p[3], full: p[4] }; });
  } catch { return []; }
});
ipcMain.handle('git:branches', async (_e, dir) => {
  try {
    const out = await git(dir, ['branch', '-a', '--format=%(refname:short)	%(committerdate:relative)	%(worktreepath)']);
    return out.split(/\r?\n/).filter(Boolean).map((l) => { const p = l.split('\t'); return { name: p[0].trim(), when: (p[1] || '').trim(), worktree: (p[2] || '').trim() || null, remote: p[0].trim().startsWith('origin/') }; }).filter((b) => !/HEAD$/.test(b.name));
  } catch { return []; }
});
ipcMain.handle('git:renameBranch', async (_e, dir, name) => {
  try { await git(dir, ['branch', '-m', name]); return { ok: true }; } catch (err) { return { ok: false, error: errText(err) }; }
});
ipcMain.handle('git:commitPush', async (_e, dir, message, push) => {
  const log = [];
  try {
    await git(dir, ['add', '-A', '--', '.']);
    let committed = false;
    try { log.push(await git(dir, ['commit', '-m', message])); committed = true; } catch (err) { if (!/nothing to commit/.test(errText(err))) throw err; log.push('nothing to commit'); }
    if (push) {
      const branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
      log.push(await git(dir, ['push', '-u', 'origin', branch], { timeout: 60000 }).catch((err) => { throw err; }));
    }
    return { ok: true, committed, log: log.join('\n') };
  } catch (err) { return { ok: false, error: errText(err), log: log.join('\n') }; }
});
ipcMain.handle('git:init', async (_e, dir) => { try { await git(dir, ['init', '-b', 'main']); return { ok: true }; } catch (err) { return { ok: false, error: errText(err) }; } });
ipcMain.handle('git:remoteAdd', async (_e, dir, url) => { try { try { await git(dir, ['remote', 'remove', 'origin']); } catch { /* none */ } await git(dir, ['remote', 'add', 'origin', url]); return { ok: true }; } catch (err) { return { ok: false, error: errText(err) }; } });
ipcMain.handle('git:fetch', async (_e, dir) => { try { await git(dir, ['fetch', 'origin', '--prune'], { timeout: 60000 }); return { ok: true }; } catch (err) { return { ok: false, error: errText(err) }; } });
ipcMain.handle('git:pullLatest', async (_e, dir, base) => {
  try {
    await git(dir, ['fetch', 'origin'], { timeout: 60000 });
    const out = await git(dir, ['rebase', `origin/${base}`], { timeout: 60000 });
    return { ok: true, out };
  } catch (err) {
    const t = errText(err);
    if (/CONFLICT|could not apply/i.test(t)) { try { await git(dir, ['rebase', '--abort']); } catch { /* ignore */ } return { ok: false, conflict: true, error: t }; }
    return { ok: false, error: t };
  }
});
ipcMain.handle('git:mergeBase', async (_e, dir, base) => {
  try { return { ok: true, sha: (await git(dir, ['merge-base', 'HEAD', base])).trim() }; } catch (err) { return { ok: false, error: errText(err) }; }
});

// ---- worktrees (Conductor layout: ~/conductor/workspaces/<repo>/<name>) ----
function copyIncludes(root, dest, globs) {
  // Files git ignores but a workspace still needs (default: .env*). Top level
  // and one directory down, skipping dependency folders.
  const pats = (globs && globs.length ? globs : ['.env*']).map((g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'));
  const copied = [];
  const scan = (dir, rel, depth) => {
    let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory()) { if (depth < 1 && !['node_modules', '.git', 'dist', 'build', '.next', 'target', 'vendor'].includes(e.name)) scan(path.join(dir, e.name), path.join(rel, e.name), depth + 1); continue; }
      if (pats.some((p) => p.test(e.name))) {
        const to = path.join(dest, rel, e.name);
        if (fs.existsSync(to)) continue;
        try { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join(dir, e.name), to); copied.push(path.join(rel, e.name)); } catch { /* skip */ }
      }
    }
  };
  scan(root, '', 0);
  return copied;
}
ipcMain.handle('git:worktreeAdd', async (_e, { root, dest, branch, base, existing, includes }) => {
  try {
    const top = await toplevel(root);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest)) {
      // a leftover from an archive that could not delete the folder: git no
      // longer knows it, so set it aside rather than lose anything in it
      const norm = (p) => p.replace(/\\/g, '/').toLowerCase();
      const registered = (await git(top, ['worktree', 'list', '--porcelain']).catch(() => '')).split(/\r?\n/).some((l) => l.startsWith('worktree ') && norm(l.slice(9)) === norm(dest));
      const managed = norm(dest).startsWith(norm(WORKSPACES_ROOT) + '/');
      if (!registered && managed) {
        try { await git(top, ['worktree', 'prune']); } catch { /* ignore */ }
        if (fs.readdirSync(dest).length === 0) fs.rmdirSync(dest);
        else fs.renameSync(dest, `${dest}.stale-${Date.now().toString(36)}`);
      } else return { ok: false, error: `${dest} already exists` };
    }
    try { await git(top, ['fetch', 'origin', '--prune'], { timeout: 20000 }); } catch { /* offline or no remote */ }
    if (existing) await git(top, ['worktree', 'add', dest, branch], { timeout: 120000 });
    else {
      let start = base || 'HEAD';
      try { await git(top, ['rev-parse', '--verify', '--quiet', `origin/${start}`]); start = `origin/${start}`; } catch { /* local base */ }
      await git(top, ['worktree', 'add', '-b', branch, dest, start], { timeout: 120000 });
    }
    const copied = copyIncludes(top, dest, includes);
    return { ok: true, path: dest, branch, root: top, copied };
  } catch (err) { return { ok: false, error: errText(err) }; }
});
ipcMain.handle('git:worktreeRemove', async (_e, root, wt) => {
  let err = null;
  try { await git(root, ['worktree', 'remove', '--force', wt], { timeout: 60000 }); } catch (e) { err = e; }
  // git may drop the registration but fail to delete the folder while a shell
  // that lived there is still exiting: prune, then remove the folder ourselves.
  try { await git(root, ['worktree', 'prune']); } catch { /* ignore */ }
  if (fs.existsSync(wt)) { try { fs.rmSync(wt, { recursive: true, force: true, maxRetries: 6, retryDelay: 500 }); } catch (e) { err = err || e; } }
  return fs.existsSync(wt) ? { ok: false, error: errText(err || 'folder still in use') } : { ok: true };
});
ipcMain.handle('git:worktreeList', async (_e, root) => {
  try {
    const out = await git(root, ['worktree', 'list', '--porcelain']);
    const items = []; let cur = null;
    for (const l of out.split(/\r?\n/)) {
      if (l.startsWith('worktree ')) { cur = { path: l.slice(9), branch: null }; items.push(cur); }
      else if (cur && l.startsWith('branch ')) cur.branch = l.slice(7).replace(/^refs\/heads\//, '');
    }
    return items;
  } catch { return []; }
});
ipcMain.handle('git:deleteBranch', async (_e, root, branch) => { try { await git(root, ['branch', '-D', branch]); return { ok: true }; } catch (err) { return { ok: false, error: errText(err) }; } });
ipcMain.handle('git:clone', (_e, url, dest) => new Promise((resolve) => {
  execFile('git', ['clone', url, dest], { encoding: 'utf8', windowsHide: true, timeout: 10 * 60 * 1000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, _o, stderr) => resolve(err ? { ok: false, error: String(stderr || err.message) } : { ok: true, path: dest }));
}));

// ---- GitHub CLI ----
function gh(dir, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: opts.timeout || 30000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' } }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve(stdout)));
  });
}
let ghPath = undefined;
ipcMain.handle('gh:available', () => { if (ghPath === undefined) ghPath = whichSync('gh'); return !!ghPath; });
ipcMain.handle('gh:recheck', () => { ghPath = whichSync('gh'); return !!ghPath; });
ipcMain.handle('gh:pr', async (_e, dir) => {
  try {
    const out = await gh(dir, ['pr', 'view', '--json', 'number,title,url,state,isDraft,mergeable,mergeStateStatus,reviewDecision,headRefName,baseRefName,additions,deletions,changedFiles,statusCheckRollup,body,author,updatedAt']);
    return { ok: true, pr: JSON.parse(out) };
  } catch (err) { const t = errText(err); return { ok: false, none: /no pull requests found|not found/i.test(t), error: t }; }
});
ipcMain.handle('gh:prChecks', async (_e, dir) => {
  try { const out = await gh(dir, ['pr', 'checks', '--json', 'name,state,link,workflow,description,startedAt,completedAt,bucket']); return { ok: true, checks: JSON.parse(out) }; }
  catch (err) { return { ok: false, error: errText(err) }; }
});
ipcMain.handle('gh:prCreate', async (_e, dir, { title, body, draft, base }) => {
  const bodyFile = path.join(os.tmpdir(), `astral-pr-${Date.now()}.md`);
  try {
    fs.writeFileSync(bodyFile, body || '');
    const args = ['pr', 'create', '--title', title, '--body-file', bodyFile];
    if (draft) args.push('--draft');
    if (base) args.push('--base', base);
    const out = await gh(dir, args, { timeout: 90000 });
    const url = (out.match(/https?:\/\/\S+/) || [null])[0];
    return { ok: true, url, out };
  } catch (err) { return { ok: false, error: errText(err) }; }
  finally { try { fs.unlinkSync(bodyFile); } catch { /* gone */ } }
});
ipcMain.handle('gh:prMerge', async (_e, dir, method, deleteBranch) => {
  try { const args = ['pr', 'merge', `--${method || 'squash'}`]; if (deleteBranch) args.push('--delete-branch'); const out = await gh(dir, args, { timeout: 90000 }); return { ok: true, out }; }
  catch (err) { return { ok: false, error: errText(err) }; }
});
ipcMain.handle('gh:prReady', async (_e, dir) => { try { await gh(dir, ['pr', 'ready']); return { ok: true }; } catch (err) { return { ok: false, error: errText(err) }; } });
ipcMain.handle('gh:prList', async (_e, dir) => {
  try { const out = await gh(dir, ['pr', 'list', '--limit', '40', '--json', 'number,title,headRefName,author,updatedAt,isDraft,url']); return { ok: true, prs: JSON.parse(out) }; }
  catch (err) { return { ok: false, error: errText(err) }; }
});
ipcMain.handle('gh:issues', async (_e, dir) => {
  try { const out = await gh(dir, ['issue', 'list', '--limit', '40', '--json', 'number,title,author,updatedAt,url,labels']); return { ok: true, issues: JSON.parse(out) }; }
  catch (err) { return { ok: false, error: errText(err) }; }
});
ipcMain.handle('gh:runLog', async (_e, dir, link) => {
  try {
    const m = /\/runs\/(\d+)/.exec(link || ''); if (!m) return { ok: false, error: 'no run id' };
    const out = await gh(dir, ['run', 'view', m[1], '--log-failed'], { timeout: 60000 });
    return { ok: true, text: out.slice(-40000) };
  } catch (err) { return { ok: false, error: errText(err) }; }
});
ipcMain.handle('gh:auth', async (_e) => { try { const out = await gh(HOME, ['auth', 'status']); return { ok: true, out }; } catch (err) { return { ok: false, error: errText(err) }; } });

// ---- Conductor settings (.conductor/settings.toml, plus legacy conductor.json) ----
// Minimal TOML: comments, [tables], dotted tables, strings, numbers, booleans,
// arrays of strings. Enough for the scripts section Conductor documents.
function parseToml(text) {
  const root = {}; let cur = root;
  const setPath = (obj, keys) => { let o = obj; for (const k of keys) { if (typeof o[k] !== 'object' || o[k] === null) o[k] = {}; o = o[k]; } return o; };
  const splitKeys = (s) => s.split('.').map((k) => k.trim().replace(/^"|"$/g, ''));
  const value = (v) => {
    v = v.trim();
    if (/^"(.*)"$/.test(v)) return JSON.parse(v.replace(/\\(?!["\\nrt])/g, '\\\\'));
    if (/^'(.*)'$/.test(v)) return v.slice(1, -1);
    if (v === 'true') return true; if (v === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(v)) return +v;
    if (/^\[.*\]$/s.test(v)) return v.slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean).map(value);
    return v;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s+|\s+$/g, '');
    if (!line || line.startsWith('#')) continue;
    let m = /^\[\[(.+)\]\]$/.exec(line);
    if (m) { cur = setPath(root, splitKeys(m[1])); continue; }
    m = /^\[(.+)\]$/.exec(line);
    if (m) { cur = setPath(root, splitKeys(m[1])); continue; }
    m = /^([A-Za-z0-9_.\-"]+)\s*=\s*(.+)$/.exec(line);
    if (m) { const keys = splitKeys(m[1]); const last = keys.pop(); setPath(cur, keys)[last] = value(m[2].replace(/\s+#.*$/, '')); }
  }
  return root;
}
function tomlStr(v) { return JSON.stringify(String(v)); }
function serializeScripts(scripts) {
  const lines = ['[scripts]'];
  if (scripts.setup) lines.push(`setup = ${tomlStr(scripts.setup)}`);
  if (scripts.run) lines.push(`run = ${tomlStr(scripts.run)}`);
  if (scripts.archive) lines.push(`archive = ${tomlStr(scripts.archive)}`);
  if (scripts.run_mode) lines.push(`run_mode = ${tomlStr(scripts.run_mode)}`);
  if (scripts.auto_run_after_setup) lines.push('auto_run_after_setup = true');
  if (scripts.file_include_globs && scripts.file_include_globs.length) lines.push(`file_include_globs = [${scripts.file_include_globs.map(tomlStr).join(', ')}]`);
  for (const [id, r] of Object.entries(scripts.runs || {})) {
    if (!r || !r.command) continue;
    lines.push('', `[scripts.run.${id}]`, `command = ${tomlStr(r.command)}`);
    if (r.icon) lines.push(`icon = ${tomlStr(r.icon)}`);
    if (r.default) lines.push('default = true');
    if (r.cwd) lines.push(`cwd = ${tomlStr(r.cwd)}`);
  }
  return lines.join('\n') + '\n';
}
function readConductorSettings(root) {
  const tomlFile = path.join(root, '.conductor', 'settings.toml');
  const localFile = path.join(root, '.conductor', 'settings.local.toml');
  const jsonFile = path.join(root, 'conductor.json');
  let cfg = {};
  const merge = (a, b) => { for (const [k, v] of Object.entries(b || {})) { if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object') merge(a[k], v); else a[k] = v; } return a; };
  if (fs.existsSync(jsonFile)) { try { const j = JSON.parse(fs.readFileSync(jsonFile, 'utf8')); cfg = { scripts: { setup: j.scripts && j.scripts.setup, run: j.scripts && j.scripts.run, archive: j.scripts && j.scripts.archive, run_mode: j.scripts && j.scripts.run_mode } }; } catch { /* bad json */ } }
  if (fs.existsSync(tomlFile)) { try { merge(cfg, parseToml(fs.readFileSync(tomlFile, 'utf8'))); } catch { /* bad toml */ } }
  if (fs.existsSync(localFile)) { try { merge(cfg, parseToml(fs.readFileSync(localFile, 'utf8'))); } catch { /* bad toml */ } }
  const s = cfg.scripts || {};
  const runs = {};
  if (s.run && typeof s.run === 'object') { for (const [id, r] of Object.entries(s.run)) if (r && typeof r === 'object') runs[id] = { command: r.command || '', icon: r.icon || 'play', default: !!r.default, cwd: r.cwd || (r.options && r.options.cwd) || '' }; }
  return {
    setup: typeof s.setup === 'string' ? s.setup : '',
    run: typeof s.run === 'string' ? s.run : '',
    archive: typeof s.archive === 'string' ? s.archive : '',
    run_mode: s.run_mode || 'concurrent',
    auto_run_after_setup: !!s.auto_run_after_setup,
    file_include_globs: Array.isArray(s.file_include_globs) ? s.file_include_globs : ['.env*'],
    runs,
    hasFile: fs.existsSync(tomlFile) || fs.existsSync(jsonFile),
    prompts: cfg.prompts || {},
    environment_variables: cfg.environment_variables || {},
  };
}
ipcMain.handle('conductor:settings', (_e, root) => { try { return readConductorSettings(root); } catch (err) { return { error: err.message }; } });
ipcMain.handle('conductor:saveSettings', (_e, root, scripts) => {
  try {
    const dir = path.join(root, '.conductor'); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'settings.toml');
    let existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    // replace the [scripts] block(s), keep everything else verbatim
    const kept = [];
    let skipping = false;
    for (const line of existing.split(/\r?\n/)) {
      const t = line.trim();
      if (/^\[scripts(\.|\])/.test(t)) { skipping = true; continue; }
      if (/^\[/.test(t)) skipping = false;
      if (!skipping) kept.push(line);
    }
    const head = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    fs.writeFileSync(file, (head ? head + '\n\n' : '') + serializeScripts(scripts));
    return { ok: true, file };
  } catch (err) { return { ok: false, error: err.message }; }
});

// ---- one-shot agent calls (PR drafts, commit messages) ----
// Runs Claude Code headless in plan mode with the prompt on stdin. The prompt
// carries an internal marker so these do not show up as resumable chats.
function cleanEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const k of Object.keys(env)) if (/^(CLAUDE|ANTHROPIC_SESSION)/i.test(k)) delete env[k];
  return env;
}
ipcMain.handle('ai:oneshot', (_e, { cwd, prompt, model }) => new Promise((resolve) => {
  const args = ['-p', '--output-format', 'text', '--permission-mode', 'plan'];
  if (model) args.push('--model', model);
  let proc;
  try { proc = spawn('claude', args, { cwd: fs.existsSync(cwd) ? cwd : HOME, env: cleanEnv(), windowsHide: true, shell: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch (err) { return resolve({ ok: false, error: err.message }); }
  let out = '', errTxt = '';
  const timer = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } resolve({ ok: false, error: 'timed out' }); }, 120000);
  proc.stdout.setEncoding('utf8'); proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.setEncoding('utf8'); proc.stderr.on('data', (d) => { errTxt += d; });
  proc.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, error: err.message }); });
  proc.on('exit', (code) => { clearTimeout(timer); resolve(code === 0 ? { ok: true, text: out.trim() } : { ok: false, error: (errTxt || out).trim().slice(0, 600) || `exit ${code}` }); });
  proc.stdin.end('[astral-internal] ' + prompt);
}));

// ---- pty ----
function shellFor() { return process.env.ASTRAL_SHELL || 'powershell.exe'; }
function buildLaunch({ agent, agentSessionId, resume, command, modelArgs, addDir }) {
  const sh = shellFor(agent);
  const base = ['-NoLogo'];
  let cmd = null;
  if (agent === 'claude') { cmd = resume ? `claude --resume ${agentSessionId}` : `claude --session-id ${agentSessionId}`; if (addDir) cmd += ` --add-dir "${addDir}"`; }
  else if (agent === 'codex') cmd = resume && agentSessionId ? `codex resume ${agentSessionId}` : 'codex';
  else if (command) cmd = command;
  if (cmd && modelArgs) cmd += ' ' + modelArgs;
  // Windows PowerShell defaults to the legacy code page; Python-based CLIs then print
  // mojibake for box drawing and spinners. Node CLIs write UTF-16 to the console
  // directly and are unaffected either way.
  const utf8 = '[Console]::InputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; $OutputEncoding = [Console]::OutputEncoding; ';
  // -EncodedCommand: the command travels as base64 UTF-16, so quotes, backticks
  // and semicolons inside it survive the Windows argv round trip intact.
  const args = cmd ? [...base, '-NoExit', '-EncodedCommand', Buffer.from(utf8 + cmd, 'utf16le').toString('base64')] : base;
  return { file: sh, args };
}
// pty output is coalesced for a few milliseconds before crossing to the window
const outBuf = new Map();
function pushData(id, data) {
  let b = outBuf.get(id);
  if (!b) { b = { chunks: [], size: 0, timer: null }; outBuf.set(id, b); }
  b.chunks.push(data); b.size += data.length;
  const flush = () => { b.timer = null; const out = b.chunks.join(''); b.chunks = []; b.size = 0; if (out) send('pty:data', id, out); };
  if (b.size > 256 * 1024) { clearTimeout(b.timer); flush(); }
  else if (!b.timer) b.timer = setTimeout(flush, 8);
}
ipcMain.handle('pty:create', (_e, opts) => {
  const { id, cols, rows, cwd } = opts;
  if (ptys.has(id)) return { ok: true, existing: true };
  const { file, args } = buildLaunch(opts);
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Astral', ...(opts.env || {}) };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const k of Object.keys(env)) if (/^(CLAUDE|ANTHROPIC_SESSION)/i.test(k)) delete env[k];
  let p;
  try {
    p = pty.spawn(file, args, { name: 'xterm-256color', cols: cols || 120, rows: rows || 30, cwd: fs.existsSync(cwd) ? cwd : HOME, env, useConpty: true });
  } catch (err) { return { ok: false, error: err.message }; }
  ptys.set(id, p);
  p.onData((data) => pushData(id, data));
  p.onExit(({ exitCode }) => {
    ptys.delete(id);
    const b = outBuf.get(id); if (b && b.timer) { clearTimeout(b.timer); b.timer = null; const out = b.chunks.join(''); if (out) send('pty:data', id, out); }
    outBuf.delete(id);
    send('pty:exit', id, exitCode);
  });
  return { ok: true, pid: p.pid, command: [file, ...args].join(' ') };
});
ipcMain.on('pty:write', (_e, id, data) => { const p = ptys.get(id); if (p) p.write(data); });
ipcMain.on('pty:resize', (_e, id, cols, rows) => { const p = ptys.get(id); if (p && cols > 0 && rows > 0) { try { p.resize(cols, rows); } catch { /* closed */ } } });
ipcMain.handle('pty:kill', (_e, id) => new Promise((resolve) => {
  const p = ptys.get(id);
  if (!p) return resolve(true);
  ptys.delete(id);
  let done = false;
  const finish = () => { if (!done) { done = true; resolve(true); } };
  p.onExit(finish);
  killTree(p.pid);
  try { p.kill(); } catch { /* gone */ }
  setTimeout(finish, 1500);
}));
ipcMain.handle('pty:alive', (_e, id) => ptys.has(id));

// ---- plugin versions ----
function run(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: 'utf8', windowsHide: true, timeout: 20000, shell: true, ...opts }, (err, stdout, stderr) => resolve(err ? null : String(stdout || stderr || '')));
  });
}
const latestCache = new Map();
ipcMain.handle('plugins:versions', async (_e, items) => {
  const out = {};
  await Promise.all(items.map(async (it) => {
    const r = { installed: null, latest: null, path: null };
    if (it.cmd) {
      const w = await run('where', [it.cmd]);
      r.path = w ? w.split(/\r?\n/).filter(Boolean)[0] : null;
      if (r.path) {
        const v = await run(it.cmd, ['--version']);
        const m = v && /(\d+\.\d+\.\d+(?:[-.][\w.]+)?)/.exec(v);
        r.installed = m ? m[1] : (v ? v.trim().split(/\r?\n/)[0].slice(0, 40) : 'installed');
      }
    }
    if (it.npm) {
      const c = latestCache.get(it.npm);
      if (c && Date.now() - c.at < 30 * 60 * 1000) r.latest = c.v;
      else { const v = await run('npm', ['view', it.npm, 'version']); r.latest = v ? v.trim() : null; if (r.latest) latestCache.set(it.npm, { at: Date.now(), v: r.latest }); }
    }
    out[it.id] = r;
  }));
  return out;
});

// ---- chat mode: Claude Code headless over its own stream-json protocol ----
const chats = new Map();
ipcMain.handle('chat:start', (_e, { id, cwd, addDir, agentSessionId, resume, model, permissionMode, effort, env }) => {
  if (chats.has(id)) return { ok: true, existing: true };
  // --forward-subagent-text: work done through the Agent tool streams back with parent_tool_use_id, so it can be shown under its step
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--forward-subagent-text', '--permission-prompts', 'host'];
  if (permissionMode) args.push('--permission-mode', permissionMode);
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (addDir) args.push('--add-dir', addDir);
  args.push(resume ? '--resume' : '--session-id', agentSessionId);
  let proc;
  try {
    proc = spawn('claude', args, { cwd: fs.existsSync(cwd) ? cwd : HOME, env: { ...cleanEnv(), ...(env || {}) }, windowsHide: true, shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) { return { ok: false, error: err.message }; }
  const c = { proc, buf: '' };
  chats.set(id, c);
  const emit = (payload) => send('chat:event', id, payload);
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    c.buf += chunk;
    const lines = c.buf.split('\n');
    c.buf = lines.pop();
    for (const line of lines) { const t = line.trim(); if (!t) continue; try { emit(JSON.parse(t)); } catch { emit({ type: 'raw', text: t }); } }
  });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (d) => emit({ type: 'stderr', text: String(d) }));
  proc.on('error', (err) => emit({ type: 'stderr', text: err.message }));
  proc.on('exit', (code) => { chats.delete(id); emit({ type: 'exit', code }); });
  return { ok: true, pid: proc.pid, command: ['claude', ...args].join(' ') };
});
ipcMain.on('chat:send', (_e, id, obj) => { const c = chats.get(id); if (c && c.proc.stdin.writable) c.proc.stdin.write(JSON.stringify(obj) + '\n'); });
// spawn(..., { shell: true }) puts cmd.exe between us and the CLI, so a plain
// kill() would orphan the CLI with the workspace folder as its cwd. Kill the tree.
function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
  else { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }
}
ipcMain.handle('chat:stop', (_e, id) => new Promise((resolve) => {
  const c = chats.get(id);
  if (!c) return resolve(true);
  chats.delete(id);
  let done = false;
  const finish = () => { if (!done) { done = true; resolve(true); } };
  c.proc.once('exit', finish);
  try { c.proc.stdin.end(); } catch { /* ignore */ }
  setTimeout(() => { killTree(c.proc.pid); setTimeout(finish, 400); }, 600);
}));
ipcMain.handle('chat:alive', (_e, id) => chats.has(id));

// ---- agents ----
ipcMain.handle('agents:listClaude', (_e, cwd) => agents.listClaude(cwd));
ipcMain.handle('agents:listCodex', (_e, cwd) => agents.listCodex(cwd));
ipcMain.handle('agents:listAll', () => [...agents.listClaudeAll(), ...agents.listCodexAll()].sort((a, b) => b.updatedAt - a.updatedAt));
ipcMain.handle('agents:liveClaudeStatus', () => agents.liveClaudeStatus());
ipcMain.handle('telemetry:watch', (_e, opts) => {
  if (opts.agent === 'claude' && !opts.file && opts.agentSessionId) opts.file = agents.claudeTranscriptPath(opts.cwd, opts.agentSessionId);
  return agents.watch(opts, (payload) => send('telemetry:event', payload));
});
ipcMain.handle('telemetry:unwatch', (_e, sessionId) => { agents.unwatch(sessionId); return true; });

// ---- phone control (Telegram) ----
const remote = new remoteMod.Remote({
  onPrompt: (p) => send('remote:prompt', p),
  onCommand: (c) => send('remote:command', c),
  onStatus: (st) => send('remote:status', st),
});
ipcMain.handle('remote:configure', (_e, cfg) => { remote.configure(cfg || {}); return remote.status(); });
ipcMain.handle('remote:status', () => remote.status());
ipcMain.handle('remote:send', async (_e, text) => { try { await remote.send(text); return { ok: true }; } catch (err) { return { ok: false, error: err.message }; } });
ipcMain.handle('remote:preview', async (_e, url, caption) => {
  try { const png = await remoteMod.capture(url); await remote.sendPhoto(png, caption); return { ok: true, bytes: png.length }; }
  catch (err) { try { await remote.send(`Could not capture ${url}: ${err.message}`); } catch { /* ignore */ } return { ok: false, error: err.message }; }
});
ipcMain.handle('remote:capture', async (_e, url) => { try { const png = await remoteMod.capture(url); return { ok: true, dataUrl: `data:image/png;base64,${png.toString('base64')}` }; } catch (err) { return { ok: false, error: err.message }; } });

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  for (const p of ptys.values()) { try { p.kill(); } catch { /* ignore */ } }
  for (const c of chats.values()) { try { c.proc.kill(); } catch { /* ignore */ } }
  app.quit();
});
