// Phone control over Telegram. Astral runs a bot with long polling (no inbound
// ports, works from anywhere): the paired phone's messages become prompts for a
// chat session, replies come back as messages, and localhost pages the agent
// mentions are screenshotted and sent as photos. Only one chat id, paired by
// typing a code shown in Settings, is ever accepted.
const { BrowserWindow, net } = require('electron');
const dns = require('dns');
// Node's fetch tries the IPv6 address first and gives up on networks where v6 is
// dead; Chromium's stack falls back properly and honours the system proxy.
try { dns.setDefaultResultOrder('ipv4first'); } catch { /* older node */ }
const xfetch = async (url, opts) => { if (net && net.fetch) { try { return await net.fetch(url, opts); } catch { /* fall through */ } } return fetch(url, opts); };

const API = (token, method) => `https://api.telegram.org/bot${token}/${method}`;

class Remote {
  constructor({ onPrompt, onCommand, onStatus }) {
    this.onPrompt = onPrompt; this.onCommand = onCommand; this.onStatus = onStatus;
    this.token = null; this.chatId = null; this.code = null; this.offset = 0;
    this.running = false; this.error = null; this.me = null; this.abort = null;
  }
  status() { return { running: this.running, paired: !!this.chatId, chatId: this.chatId, code: this.code, bot: this.me ? this.me.username : null, error: this.error }; }
  configure({ token, chatId }) {
    const changed = token !== this.token;
    this.token = token || null; this.chatId = chatId || null;
    if (!this.chatId && this.token) this.code = this.code || String(Math.floor(100000 + Math.random() * 900000));
    if (this.chatId) this.code = null;
    if (changed) { this.stop(); if (this.token) this.start(); }
    else if (this.token && !this.running) this.start();
    this.onStatus(this.status());
  }
  async api(method, body) {
    const r = await xfetch(API(this.token, method), body instanceof FormData ? { method: 'POST', body } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(j.description || `telegram ${method} failed (${r.status})`);
    return j.result;
  }
  async start() {
    if (this.running || !this.token) return;
    this.running = true; this.error = null;
    try { this.me = await this.api('getMe'); } catch (err) { this.error = err.message; this.running = false; this.onStatus(this.status()); return; }
    this.onStatus(this.status());
    this.loop();
  }
  stop() { this.running = false; if (this.abort) { try { this.abort.abort(); } catch { /* ignore */ } } this.abort = null; }
  async loop() {
    while (this.running) {
      try {
        this.abort = new AbortController();
        const r = await xfetch(API(this.token, 'getUpdates'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ offset: this.offset, timeout: 25, allowed_updates: ['message'] }), signal: this.abort.signal });
        const j = await r.json();
        if (!j.ok) { this.error = j.description || 'poll failed'; this.onStatus(this.status()); await sleep(5000); continue; }
        this.error = null;
        for (const u of j.result) { this.offset = u.update_id + 1; await this.handle(u.message).catch((err) => { this.error = err.message; }); }
      } catch (err) { if (!this.running) break; this.error = err.message; this.onStatus(this.status()); await sleep(4000); }
    }
  }
  async handle(m) {
    if (!m || !m.chat) return;
    const from = m.chat.id;
    const text = (m.text || m.caption || '').trim();
    if (!this.chatId) {
      // pairing: the phone must send the code shown in Settings
      if (text && this.code && text.replace(/\s+/g, '') === this.code) { this.chatId = from; this.code = null; this.onStatus(this.status()); this.onCommand({ chatId: from, cmd: 'paired' }); await this.send(`Paired with Astral. Send a message to prompt the active chat, /sessions to pick one, /preview <url> for a screenshot, /stop to interrupt, /help for the rest.`); }
      else await this.sendTo(from, `This Astral bot is not paired with you. Open Astral → Settings → Phone and send me the 6-digit code shown there.`);
      return;
    }
    if (from !== this.chatId) return; // someone else found the bot: ignore
    if (text.startsWith('/')) {
      const [cmd, ...rest] = text.slice(1).split(/\s+/);
      this.onCommand({ chatId: from, cmd: cmd.toLowerCase().replace(/@.*$/, ''), args: rest.join(' ') });
      return;
    }
    // a photo becomes an image attachment for the prompt
    const images = [];
    if (m.photo && m.photo.length) {
      try {
        const best = m.photo[m.photo.length - 1];
        const f = await this.api('getFile', { file_id: best.file_id });
        const buf = Buffer.from(await (await xfetch(`https://api.telegram.org/file/bot${this.token}/${f.file_path}`)).arrayBuffer());
        images.push({ kind: 'image', id: `tg-${best.file_unique_id}`, name: 'phone-photo.jpg', media_type: 'image/jpeg', data: buf.toString('base64'), dataUrl: `data:image/jpeg;base64,${buf.toString('base64')}`, w: best.width, h: best.height });
      } catch (err) { await this.send(`Could not fetch that photo: ${err.message}`); }
    }
    if (!text && !images.length) return;
    this.onPrompt({ chatId: from, text: text || 'See the attached image.', images });
  }
  sendTo(chatId, text) { return this.api('sendMessage', { chat_id: chatId, text: String(text).slice(0, 4000), disable_web_page_preview: true }); }
  async send(text) {
    if (!this.chatId || !this.token) return;
    const s = String(text || '').trim(); if (!s) return;
    for (let i = 0; i < s.length; i += 3900) await this.sendTo(this.chatId, s.slice(i, i + 3900));
  }
  async sendPhoto(png, caption) {
    if (!this.chatId || !this.token) return;
    const fd = new FormData();
    fd.append('chat_id', String(this.chatId));
    if (caption) fd.append('caption', String(caption).slice(0, 1000));
    fd.append('photo', new Blob([png], { type: 'image/png' }), 'preview.png');
    await this.api('sendPhoto', fd);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Screenshot a page in a hidden window. Used for localhost previews.
async function capture(url, { width = 1280, height = 800, wait = 1500 } = {}) {
  const w = new BrowserWindow({ show: false, width, height, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    await Promise.race([w.loadURL(url), sleep(15000).then(() => { throw new Error('page load timed out'); })]);
    await sleep(wait);
    const img = await w.webContents.capturePage();
    return img.toPNG();
  } finally { try { w.destroy(); } catch { /* gone */ } }
}

module.exports = { Remote, capture };
