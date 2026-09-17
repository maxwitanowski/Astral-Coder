// Phone control: Astral hosts a small website on this PC. A phone on the same
// network (or connected through something like Tailscale) opens it, enters the
// 4-digit code shown in Settings, and can pick a chat, send prompts, read the
// replies, stop a turn, and see previews of localhost pages the agent mentions.
// Everything the page needs comes from the renderer over a request/response
// bridge; the server itself holds no chat state.
const { BrowserWindow, net } = require('electron');
const crypto = require('crypto');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');

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

async function publicIp() {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 6000);
  try {
    for (const u of ['https://api.ipify.org?format=json', 'https://ifconfig.me/ip']) {
      try { const r = await net.fetch(u, { signal: ctl.signal }); const txt = (await r.text()).trim(); const ip = (txt.match(/\d{1,3}(?:\.\d{1,3}){3}/) || [])[0]; if (ip) return { ok: true, ip }; } catch { /* next */ }
    }
    return { ok: false, error: 'could not look up the public address' };
  } finally { clearTimeout(t); }
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

// The page itself lives in phone.html; the app's built stylesheet and logo are
// served to it so it looks exactly like Astral.
const DIST = path.join(__dirname, '..', 'dist', 'assets');
function assetFile(re, fallback) { try { const f = fs.readdirSync(DIST).find((n) => re.test(n)); if (f) return path.join(DIST, f); } catch { /* no build yet */ } return fallback; }
const pageHtml = () => fs.readFileSync(path.join(__dirname, 'phone.html'), 'utf8');

class Host {
  constructor({ bridge }) { this.bridge = bridge; this.server = null; this.port = null; this.code = null; this.fails = []; this.error = null; }
  status() { return { running: !!this.server, port: this.port, code: this.code, strong: !!this.strong, addresses: this.server ? lanAddresses().map((a) => ({ ...a, url: `http://${a.address}:${this.port}` })) : [], error: this.error }; }
  async start({ port = 5175, code, strong = false } = {}) {
    if (this.server) await this.stop();
    // 4 digits is fine on a home network; a page reachable from the internet gets 8 characters
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const gen = () => (strong ? Array.from(crypto.randomBytes(8), (b) => alphabet[b % alphabet.length]).join('') : String(Math.floor(1000 + Math.random() * 9000)));
    this.code = String(code || gen()); this.strong = !!strong; this.error = null;
    this.server = http.createServer((req, res) => this.route(req, res).catch((err) => { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: err.message })); }));
    await new Promise((resolve, reject) => { this.server.once('error', (err) => { this.error = err.code === 'EADDRINUSE' ? `Port ${port} is already in use` : err.message; this.server = null; reject(err); }); this.server.listen(port, '0.0.0.0', () => { this.port = port; resolve(); }); }).catch(() => {});
    return this.status();
  }
  stop() { return new Promise((resolve) => { if (!this.server) return resolve(); const s = this.server; this.server = null; this.port = null; s.close(() => resolve()); setTimeout(resolve, 500); }); }
  authed(req, url) {
    const given = req.headers['x-code'] || url.searchParams.get('code') || '';
    const now = Date.now(); this.fails = this.fails.filter((t) => now - t < 5 * 60 * 1000);
    if (this.fails.length >= 12) return 'locked';
    if (given.toUpperCase() === this.code) return 'ok';
    this.fails.push(now); return 'no';
  }
  async body(req) { return new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 20 * 1024 * 1024) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } }); }); }
  async route(req, res) {
    const url = new URL(req.url, 'http://x');
    const json = (obj, status = 200) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
    if (url.pathname === '/' || url.pathname === '/index.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(pageHtml()); }
    if (url.pathname === '/app.css') { const f = assetFile(/\.css$/, path.join(__dirname, '..', 'src', 'styles.css')); res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' }); return res.end(fs.readFileSync(f)); }
    if (url.pathname === '/logo.png') { const f = assetFile(/^logo-mark.*\.png$/, path.join(__dirname, '..', 'src', 'assets', 'logo-mark.png')); res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=3600' }); return res.end(fs.readFileSync(f)); }
    if (!url.pathname.startsWith('/api/')) return json({ ok: false, error: 'not found' }, 404);
    const a = this.authed(req, url);
    if (a === 'locked') return json({ ok: false, error: 'locked' }, 429);
    if (a !== 'ok') return json({ ok: false, error: 'unauthorized' }, 401);
    if (url.pathname === '/api/state' && req.method === 'GET') return json(await this.bridge('state', {}));
    if (url.pathname === '/api/meta' && req.method === 'GET') return json(await this.bridge('meta', {}));
    if (url.pathname === '/api/render' && req.method === 'GET') return json(await this.bridge('render', { sessionId: url.searchParams.get('session') }));
    if (url.pathname === '/api/session' && req.method === 'POST') return json(await this.bridge('session', await this.body(req)));
    if (url.pathname === '/api/ui' && req.method === 'POST') return json(await this.bridge('ui', await this.body(req)));
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

module.exports = { Host, capture, lanAddresses, publicIp };
