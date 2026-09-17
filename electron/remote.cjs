// Phone control: Astral hosts a small website on this PC. A phone on the same
// network (or connected through something like Tailscale) opens it, enters the
// 4-digit code shown in Settings, and can pick a chat, send prompts, read the
// replies, stop a turn, and see previews of localhost pages the agent mentions.
// Everything the page needs comes from the renderer over a request/response
// bridge; the server itself holds no chat state.
const { BrowserWindow } = require('electron');
const http = require('http');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Screenshot a page in a hidden window. Used for the previews.
async function capture(url, { width = 1180, height = 900, wait = 1500 } = {}) {
  const w = new BrowserWindow({ show: false, width, height, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    await Promise.race([w.loadURL(url), sleep(15000).then(() => { throw new Error('page load timed out'); })]);
    await sleep(wait);
    const img = await w.webContents.capturePage();
    return img.toPNG();
  } finally { try { w.destroy(); } catch { /* gone */ } }
}

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) for (const a of list || []) {
    if (a.family !== 'IPv4' || a.internal) continue;
    const priv = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(a.address);
    out.push({ name, address: a.address, priv });
  }
  // private ranges first, virtual adapters (WSL, Hyper-V, VPN tunnels) after real ones
  return out.sort((x, y) => (y.priv - x.priv) || (/vEthernet|WSL|Hyper|VMware|VirtualBox|Docker/i.test(x.name) - /vEthernet|WSL|Hyper|VMware|VirtualBox|Docker/i.test(y.name)));
}

const PAGE = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#0d0d0d">
<title>Astral</title>
<link rel="icon" href="data:,">
<style>
:root { color-scheme: dark; --bg:#0d0d0d; --bg2:#161616; --bg3:#1f1f1f; --fg:#ececec; --fg2:#b4b4bb; --fg3:#7e7e88; --line:#2a2a2e; --accent:#d97757; --ok:#4ade80; --bad:#f87171; }
* { box-sizing: border-box; } html, body { height: 100%; margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 -apple-system, "Segoe UI", Roboto, system-ui, sans-serif; }
#app { display: grid; grid-template-rows: auto minmax(0,1fr) auto; height: 100%; height: 100dvh; } #app[hidden], #gate[hidden] { display: none !important; }
header { display: flex; align-items: center; gap: 10px; padding: 10px 12px; padding-top: max(10px, env(safe-area-inset-top)); border-bottom: 1px solid var(--line); background: var(--bg2); }
header .logo { font-weight: 700; color: var(--accent); } header select { flex: 1; min-width: 0; background: var(--bg3); color: var(--fg); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; font-size: 14px; }
header .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--fg3); flex: none; } header .dot.working { background: var(--accent); animation: pulse 1s ease-in-out infinite; } header .dot.idle { background: var(--ok); }
@keyframes pulse { 50% { opacity: .35; } }
main { overflow-y: auto; padding: 12px 12px 24px; -webkit-overflow-scrolling: touch; }
.row { margin: 0 0 12px; max-width: 100%; }
.user { display: flex; justify-content: flex-end; } .user .b { background: var(--bg3); border-radius: 14px 14px 4px 14px; padding: 9px 13px; max-width: 88%; white-space: pre-wrap; word-break: break-word; }
.asst .t { white-space: pre-wrap; word-break: break-word; } .asst pre { background: var(--bg2); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; overflow-x: auto; font-size: 12.5px; }
.asst .tools { color: var(--fg3); font-size: 12.5px; margin: 4px 0; } .asst .tools div { display: flex; gap: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .asst .tools .v { color: var(--fg2); flex: none; }
.turn { color: var(--fg3); font-size: 12.5px; } .turn.err { color: var(--bad); } .sys { color: var(--fg3); font-size: 12.5px; }
.working { color: var(--fg3); font-size: 13px; display: flex; align-items: center; gap: 8px; } .working i { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); animation: pulse 1s ease-in-out infinite; }
.preview { margin-top: 8px; } .preview img { width: 100%; border: 1px solid var(--line); border-radius: 8px; background: #fff; } .preview .cap { font-size: 12px; color: var(--fg3); margin-top: 4px; word-break: break-all; }
.queue { color: var(--fg3); font-size: 12.5px; border-left: 2px solid var(--line); padding-left: 8px; margin: 8px 0; }
footer { border-top: 1px solid var(--line); background: var(--bg2); padding: 8px 10px; padding-bottom: max(8px, env(safe-area-inset-bottom)); display: grid; gap: 8px; }
.bar { display: flex; gap: 8px; align-items: flex-end; } textarea { flex: 1; resize: none; min-height: 42px; max-height: 140px; background: var(--bg3); color: var(--fg); border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; font: inherit; }
button { font: inherit; border: 0; border-radius: 10px; padding: 10px 14px; background: var(--bg3); color: var(--fg); } button.send { background: var(--accent); color: #111; font-weight: 700; } button:disabled { opacity: .5; }
.acts { display: flex; gap: 8px; } .acts button { flex: 1; font-size: 13px; color: var(--fg2); } .acts label { flex: 1; } .acts label button { width: 100%; }
#gate { position: fixed; inset: 0; background: var(--bg); display: grid; place-items: center; padding: 24px; } #gate .box { width: 100%; max-width: 320px; display: grid; gap: 12px; text-align: center; }
#gate input { font-size: 28px; letter-spacing: .3em; text-align: center; background: var(--bg3); color: var(--fg); border: 1px solid var(--line); border-radius: 12px; padding: 12px; width: 100%; }
#gate .err { color: var(--bad); font-size: 13px; min-height: 18px; }
.toast { position: fixed; left: 50%; bottom: 120px; transform: translateX(-50%); background: var(--fg); color: #111; padding: 8px 14px; border-radius: 999px; font-size: 13px; }
.att { display: flex; gap: 6px; flex-wrap: wrap; } .att img { height: 44px; border-radius: 6px; border: 1px solid var(--line); }
</style></head><body>
<div id="gate"><div class="box"><div class="logo" style="font-size:22px;font-weight:700;color:var(--accent)">Astral</div><div>Enter the 4-digit code shown in Astral → Settings → Phone</div><input id="code" inputmode="numeric" maxlength="4" autocomplete="one-time-code" placeholder="••••"><div class="err" id="gate-err"></div><button class="send" id="gate-go">Connect</button></div></div>
<div id="app" hidden>
  <header><span class="logo">Astral</span><select id="sess"></select><span class="dot" id="dot" title="status"></span></header>
  <main id="main"></main>
  <footer>
    <div class="att" id="att"></div>
    <div class="bar"><textarea id="in" rows="1" placeholder="Message the agent…"></textarea><button class="send" id="send">Send</button></div>
    <div class="acts"><button id="stop">Stop</button><button id="prev">Preview</button><label><input type="file" id="file" accept="image/*" hidden><button type="button" id="filebtn">Photo</button></label></div>
  </footer>
</div>
<script>
const $ = (id) => document.getElementById(id);
let code = localStorage.getItem('astral-code') || ''; let sessionId = localStorage.getItem('astral-session') || null; let images = []; let lastHtml = new Map(); let previews = true;
const api = async (path, opts = {}) => { const r = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', 'x-code': code, ...(opts.headers || {}) } }); if (r.status === 401) { gate('Wrong code.'); throw new Error('unauthorized'); } if (r.status === 429) { gate('Too many attempts. Wait a minute.'); throw new Error('locked'); } return r.json(); };
function gate(msg) { $('gate').hidden = false; $('app').hidden = true; $('gate-err').textContent = msg || ''; $('code').focus(); }
async function connect() { code = $('code').value.trim(); localStorage.setItem('astral-code', code); try { await api('/api/state'); $('gate').hidden = true; $('app').hidden = false; tick(); } catch (e) { /* gate shown */ } }
$('gate-go').onclick = connect; $('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });
function toast(t) { const d = document.createElement('div'); d.className = 'toast'; d.textContent = t; document.body.appendChild(d); setTimeout(() => d.remove(), 1800); }
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function fmtText(t) { const parts = String(t || '').split(/(\x60\x60\x60[\s\S]*?\x60\x60\x60)/); return parts.map((p) => p.startsWith('\x60\x60\x60') ? '<pre>' + esc(p.replace(/^\x60\x60\x60\w*\n?/, '').replace(/\x60\x60\x60$/, '')) + '</pre>' : esc(p).replace(/\x60([^\x60]+)\x60/g, '<code>$1</code>')).join(''); }
const localUrl = (t) => { const m = String(t || '').match(/https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?[^\s)>\]"'\x60]*/g); return m ? m[m.length - 1] : null; };
const dur = (ms) => { const s = ms / 1000; if (s < 60) return s.toFixed(1) + 's'; const m = Math.floor(s / 60); return m + 'm ' + Math.round(s % 60) + 's'; };
function renderState(st) {
  previews = st.previews !== false;
  const sel = $('sess'); const cur = sel.value;
  const opts = st.sessions.map((s) => '<option value="' + esc(s.id) + '">' + esc(s.name) + (s.ws ? ' · ' + esc(s.ws) : '') + (s.working ? ' · working' : '') + '</option>').join('');
  if (sel.innerHTML !== opts) sel.innerHTML = opts || '<option value="">No chats open in Astral</option>';
  if (!sessionId || !st.sessions.some((s) => s.id === sessionId)) sessionId = st.target || (st.sessions[0] && st.sessions[0].id) || null;
  if (sel.value !== sessionId && sessionId) sel.value = sessionId;
  const s = st.sessions.find((x) => x.id === sessionId);
  $('dot').className = 'dot ' + (s ? (s.working ? 'working' : s.live ? 'idle' : '') : '');
}
function renderMessages(m) {
  const main = $('main'); const nearBottom = main.scrollHeight - main.scrollTop - main.clientHeight < 120;
  const rows = [];
  for (const x of m.msgs) {
    if (x.kind === 'user') rows.push('<div class="row user"><div class="b">' + esc(x.text) + '</div></div>');
    else if (x.kind === 'assistant') { const u = previews && localUrl(x.text); rows.push('<div class="row asst">' + (x.tools && x.tools.length ? '<div class="tools">' + x.tools.map((t) => '<div><span class="v">' + esc(t.verb) + '</span><span>' + esc(t.target || '') + (t.done ? '' : ' …') + '</span></div>').join('') + '</div>' : '') + (x.text ? '<div class="t">' + fmtText(x.text) + '</div>' : '') + (u ? '<div class="preview"><img loading="lazy" src="/api/preview?url=' + encodeURIComponent(u) + '&code=' + encodeURIComponent(code) + '&t=' + (x.at || 0) + '" alt=""><div class="cap">' + esc(u) + '</div></div>' : '') + '</div>'); }
    else if (x.kind === 'turn') rows.push('<div class="row turn' + (x.error ? ' err' : '') + '">' + (x.error ? '✗ ' + esc(x.text || 'error') : '✓ ' + (x.ms ? dur(x.ms) : 'done')) + '</div>');
    else if (x.kind === 'sys') rows.push('<div class="row sys">' + esc(x.text) + '</div>');
  }
  if (m.queue && m.queue.length) rows.push('<div class="row queue">' + m.queue.map((q) => 'Queued: ' + esc(q)).join('<br>') + '</div>');
  if (m.working) rows.push('<div class="row working"><i></i>Working…</div>');
  // replace only rows that changed so preview images do not reload every poll
  const kids = main.children;
  for (let i = 0; i < rows.length; i++) { if (i < kids.length) { if (lastHtml.get(i) !== rows[i]) kids[i].outerHTML = rows[i]; } else main.insertAdjacentHTML('beforeend', rows[i]); lastHtml.set(i, rows[i]); }
  while (kids.length > rows.length) { main.lastElementChild.remove(); lastHtml.delete(kids.length); }
  if (nearBottom) main.scrollTop = main.scrollHeight;
  $('stop').disabled = !m.working;
}
let pollTimer = null, stateAt = 0;
async function tick() {
  clearTimeout(pollTimer);
  if (document.hidden) { pollTimer = setTimeout(tick, 2000); return; }
  try {
    if (Date.now() - stateAt > 5000) { renderState(await api('/api/state')); stateAt = Date.now(); }
    if (sessionId) renderMessages(await api('/api/messages?session=' + encodeURIComponent(sessionId)));
  } catch (e) { /* gate or network; retry */ }
  pollTimer = setTimeout(tick, 1500);
}
$('sess').addEventListener('change', async () => { sessionId = $('sess').value; localStorage.setItem('astral-session', sessionId); lastHtml.clear(); $('main').innerHTML = ''; await api('/api/use', { method: 'POST', body: JSON.stringify({ sessionId }) }); stateAt = 0; tick(); });
async function send() {
  const text = $('in').value.trim(); if (!text && !images.length) return;
  $('send').disabled = true;
  try { const r = await api('/api/prompt', { method: 'POST', body: JSON.stringify({ sessionId, text: text || 'See the attached image.', images }) }); if (!r.ok) toast(r.error || 'Could not send'); else { $('in').value = ''; images = []; $('att').innerHTML = ''; toast(r.queued ? 'Queued' : 'Sent'); } }
  catch (e) { toast('Not sent'); }
  $('send').disabled = false; $('in').style.height = 'auto'; tick();
}
$('send').onclick = send;
$('in').addEventListener('input', () => { const t = $('in'); t.style.height = 'auto'; t.style.height = Math.min(140, t.scrollHeight) + 'px'; });
$('stop').onclick = async () => { await api('/api/stop', { method: 'POST', body: JSON.stringify({ sessionId }) }); toast('Interrupted'); };
$('prev').onclick = () => { const lastAsst = [...$('main').querySelectorAll('.asst .t')].pop(); const u = prompt('Address to preview', (lastAsst && localUrl(lastAsst.textContent)) || 'http://localhost:3000'); if (!u) return; const d = document.createElement('div'); d.className = 'row asst'; d.innerHTML = '<div class="preview"><img src="/api/preview?url=' + encodeURIComponent(u) + '&code=' + encodeURIComponent(code) + '&t=' + Date.now() + '" alt=""><div class="cap">' + esc(u) + '</div></div>'; $('main').appendChild(d); lastHtml.set($('main').children.length - 1, d.outerHTML); $('main').scrollTop = $('main').scrollHeight; };
$('filebtn').onclick = () => $('file').click();
$('file').addEventListener('change', () => { const f = $('file').files[0]; if (!f) return; const r = new FileReader(); r.onload = () => { const img = new Image(); img.onload = () => { const k = Math.min(1, 1568 / Math.max(img.width, img.height)); const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); const dataUrl = c.toDataURL('image/jpeg', .85); images.push({ name: f.name || 'photo.jpg', dataUrl }); $('att').innerHTML = images.map((x) => '<img src="' + x.dataUrl + '">').join(''); }; img.src = r.result; }; r.readAsDataURL(f); $('file').value = ''; });
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
if (code) { $('code').value = code; connect(); } else gate('');
</script></body></html>`;

class Host {
  constructor({ bridge }) { this.bridge = bridge; this.server = null; this.port = null; this.code = null; this.fails = []; this.error = null; }
  status() { return { running: !!this.server, port: this.port, code: this.code, addresses: this.server ? lanAddresses().map((a) => ({ ...a, url: `http://${a.address}:${this.port}` })) : [], error: this.error }; }
  async start({ port = 5175, code } = {}) {
    if (this.server) await this.stop();
    this.code = String(code || Math.floor(1000 + Math.random() * 9000)); this.error = null;
    this.server = http.createServer((req, res) => this.route(req, res).catch((err) => { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: err.message })); }));
    await new Promise((resolve, reject) => { this.server.once('error', (err) => { this.error = err.code === 'EADDRINUSE' ? `Port ${port} is already in use` : err.message; this.server = null; reject(err); }); this.server.listen(port, '0.0.0.0', () => { this.port = port; resolve(); }); }).catch(() => {});
    return this.status();
  }
  stop() { return new Promise((resolve) => { if (!this.server) return resolve(); const s = this.server; this.server = null; this.port = null; s.close(() => resolve()); setTimeout(resolve, 500); }); }
  authed(req, url) {
    const given = req.headers['x-code'] || url.searchParams.get('code') || '';
    const now = Date.now(); this.fails = this.fails.filter((t) => now - t < 5 * 60 * 1000);
    if (this.fails.length >= 12) return 'locked';
    if (given === this.code) return 'ok';
    this.fails.push(now); return 'no';
  }
  async body(req) { return new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 20 * 1024 * 1024) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } }); }); }
  async route(req, res) {
    const url = new URL(req.url, 'http://x');
    const json = (obj, status = 200) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
    if (url.pathname === '/' || url.pathname === '/index.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(PAGE); }
    if (!url.pathname.startsWith('/api/')) return json({ ok: false, error: 'not found' }, 404);
    const a = this.authed(req, url);
    if (a === 'locked') return json({ ok: false, error: 'locked' }, 429);
    if (a !== 'ok') return json({ ok: false, error: 'unauthorized' }, 401);
    if (url.pathname === '/api/state' && req.method === 'GET') return json(await this.bridge('state', {}));
    if (url.pathname === '/api/messages' && req.method === 'GET') return json(await this.bridge('messages', { sessionId: url.searchParams.get('session') }));
    if (url.pathname === '/api/prompt' && req.method === 'POST') return json(await this.bridge('prompt', await this.body(req)));
    if (url.pathname === '/api/stop' && req.method === 'POST') return json(await this.bridge('stop', await this.body(req)));
    if (url.pathname === '/api/use' && req.method === 'POST') return json(await this.bridge('use', await this.body(req)));
    if (url.pathname === '/api/preview' && req.method === 'GET') {
      const target = url.searchParams.get('url') || '';
      if (!/^https?:\/\//i.test(target)) return json({ ok: false, error: 'http(s) url required' }, 400);
      try { const png = await capture(target); res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=30' }); return res.end(png); }
      catch (err) { return json({ ok: false, error: err.message }, 502); }
    }
    return json({ ok: false, error: 'not found' }, 404);
  }
}

module.exports = { Host, capture, lanAddresses };
