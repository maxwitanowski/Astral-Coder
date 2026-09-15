// One xterm instance per session, all mounted at once and toggled with
// visibility so switching projects never tears down a running CLI.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

// Base palette matches the app background exactly so the terminal has no visible
// edge. Each CLI keeps its own colours and UI; only cursor/selection take the
// agent's brand colour.
const THEME = {
  background: '#050506',
  foreground: '#d6d6d0',
  cursor: '#7ee787',
  cursorAccent: '#050506',
  selectionBackground: 'rgba(126, 231, 135, 0.22)',
  selectionInactiveBackground: 'rgba(126, 231, 135, 0.12)',
  black: '#17171a',
  red: '#ff7b72',
  green: '#7ee787',
  yellow: '#f0b35b',
  blue: '#79c0ff',
  magenta: '#d2a8ff',
  cyan: '#56d4dd',
  white: '#d6d6d0',
  brightBlack: '#6e6e73',
  brightRed: '#ffa198',
  brightGreen: '#a5f0aa',
  brightYellow: '#f7cc85',
  brightBlue: '#a5d6ff',
  brightMagenta: '#e2c5ff',
  brightCyan: '#8be9f0',
  brightWhite: '#ffffff',
};
function hexToRgba(hex, a) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  return m ? `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${a})` : THEME.selectionBackground;
}

export class TerminalManager {
  constructor(host, { onActivity, onExit }) {
    this.host = host;
    this.terms = new Map();
    this.active = null;
    this.onActivity = onActivity;
    this.onExit = onExit;
    // Layout changes (window resize, the animated sidebar/panel toggles) arrive
    // as a burst of notifications; the pty is resized once, after the burst.
    this.fitTimer = null;
    this.ro = new ResizeObserver(() => this.scheduleFit());
    this.ro.observe(host);

    window.astral.pty.onData((id, data) => {
      const t = this.terms.get(id);
      if (t) { t.term.write(data); this.onActivity(id); }
    });
    window.astral.pty.onExit((id, code) => {
      const t = this.terms.get(id);
      if (t) {
        t.term.write(`\r\n\x1b[38;2;76;83;104m── process exited (${code}) ──\x1b[0m\r\n`);
        t.live = false;
      }
      this.onExit(id, code);
    });
  }

  has(id) { return this.terms.has(id); }
  newlineAgents = new Set(['claude', 'gemini', 'qwen']);
  agentOf(id) { const t = this.terms.get(id); return t ? t.agent : null; }
  isLive(id) { const t = this.terms.get(id); return !!(t && t.live); }

  create(id, accent = null) {
    if (this.terms.has(id)) return this.terms.get(id);
    const el = document.createElement('div');
    el.className = 'term-pane';
    el.dataset.session = id;
    this.host.appendChild(el);
    const theme = accent ? { ...THEME, cursor: accent, selectionBackground: hexToRgba(accent, 0.22), selectionInactiveBackground: hexToRgba(accent, 0.12) } : THEME;
    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      cursorStyle: 'block',
      fontFamily: '"Cascadia Mono", "Cascadia Code", "JetBrains Mono", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.15,
      letterSpacing: 0,
      scrollback: 8000,
      theme,
      allowTransparency: false,
      windowsPty: { backend: 'conpty', buildNumber: 26200 },
      macOptionIsMeta: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri)));
    term.open(el);

    term.onData((d) => window.astral.pty.write(id, d));
    term.onResize(({ cols, rows }) => window.astral.pty.resize(id, cols, rows));
    term.attachCustomKeyEventHandler((e) => this.keys(id, term, e));

    const entry = { term, fit, el, live: false, webgl: null, agent: null };
    this.terms.set(id, entry);
    return entry;
  }

  // Only the visible terminal gets the GPU renderer. A dozen hidden sessions
  // each holding a WebGL context was a large part of the slowdown.
  //
  // The renderer decides the cell size, and the DOM and WebGL renderers do not
  // agree on it. A terminal is therefore only ever fitted with the renderer
  // that is going to draw it: fitting first and swapping renderers afterwards
  // gave the pty one size now and another on the next unrelated layout pass,
  // which showed up as the CLI redrawing itself whenever you clicked elsewhere.
  setWebgl(id, on) {
    const t = this.terms.get(id);
    if (!t) return Promise.resolve();
    if (!on) { if (t.webgl) { try { t.webgl.dispose(); } catch { /* ignore */ } t.webgl = null; } return Promise.resolve(); }
    if (t.webgl) return Promise.resolve();
    if (t.webglLoading) return t.webglLoading;
    t.webglLoading = (async () => {
      try {
        const { WebglAddon } = await import('@xterm/addon-webgl');
        if (this.active !== id || t.webgl) return;
        const addon = new WebglAddon();
        addon.onContextLoss(() => {
          try { addon.dispose(); } catch { /* ignore */ }
          if (t.webgl === addon) t.webgl = null;
          if (this.active !== id) return;
          // GPU context gone (typically after the window was hidden for a while):
          // get it back if we are still on screen, and refit either way so the
          // pty matches whichever renderer ends up drawing.
          t.webglLost = (t.webglLost || 0) + 1;
          if (t.webglLost <= 3) this.setWebgl(id, true).then(() => this.fitActive());
          else this.fitActive();
        });
        t.term.loadAddon(addon);
        t.webgl = addon;
      } catch { /* DOM renderer fallback */ }
      finally { t.webglLoading = null; }
    })();
    return t.webglLoading;
  }

  keys(id, term, e) {
    if (e.type !== 'keydown') return true;
    const ctrl = e.ctrlKey && !e.altKey;
    // Shift+Enter = newline. xterm.js cannot speak the kitty keyboard protocol these
    // TUIs use to tell Shift+Enter from Enter, but Claude Code, Gemini CLI and Qwen
    // Code all take Ctrl+J (a bare line feed) as "insert newline" in any terminal.
    if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && this.newlineAgents.has(this.agentOf(id))) { window.astral.pty.write(id, '\n'); return false; }
    if (ctrl && e.shiftKey && e.key.toLowerCase() === 'c') {
      const sel = term.getSelection();
      if (sel) navigator.clipboard.writeText(sel);
      return false;
    }
    if (ctrl && (e.key.toLowerCase() === 'v')) {
      // Paste text if the clipboard has any; otherwise let the keystroke reach
      // the CLI (Claude Code uses a bare Ctrl+V to pull images from the clipboard).
      navigator.clipboard.readText().then((txt) => {
        if (txt) term.paste(txt);
        else window.astral.pty.write(id, '\x16');
      }).catch(() => window.astral.pty.write(id, '\x16'));
      return false;
    }
    return true;
  }

  async spawn(id, launch, accent = null) {
    const entry = this.create(id, accent);
    entry.agent = launch.agent || null;
    await this.show(id); // renderer loaded and fitted, so the pty starts at its final size
    const { cols, rows } = entry.term;
    const r = await window.astral.pty.create({ id, cols, rows, ...launch });
    if (r.ok) {
      entry.live = true;
      entry.term.focus();
      if (r.existing) {
        // reattached to a process that is still running (window reload): nudge
        // the pty size so full-screen CLIs repaint into the fresh terminal
        window.astral.pty.resize(id, Math.max(20, cols - 2), Math.max(5, rows - 1));
        setTimeout(() => window.astral.pty.resize(id, cols, rows), 400);
      }
    } else {
      entry.term.write(`\x1b[31mfailed to start: ${r.error}\x1b[0m\r\n`);
    }
    return r;
  }

  // Resolves once the terminal is on screen, drawn by its final renderer and
  // fitted with that renderer's metrics.
  show(id) {
    const t = this.terms.get(id);
    if (this.active === id && t && t.el.classList.contains('is-active')) return t.shown || Promise.resolve();
    const prev = this.active;
    for (const [sid, e] of this.terms) e.el.classList.toggle('is-active', sid === id);
    this.active = id;
    if (prev && prev !== id) this.setWebgl(prev, false);
    if (!t) return Promise.resolve();
    t.shown = (async () => {
      await new Promise((r) => requestAnimationFrame(r));
      await this.setWebgl(id, true);
      if (this.active !== id) return;
      this.fitActive();
      t.term.focus();
    })();
    return t.shown;
  }

  hideAll() {
    for (const t of this.terms.values()) t.el.classList.remove('is-active');
    if (this.active) this.setWebgl(this.active, false);
    this.active = null;
  }

  fitActive() {
    const t = this.terms.get(this.active);
    if (!t || !t.el.classList.contains('is-active') || t.webglLoading) return; // the load will fit
    try { t.fit.fit(); } catch { /* not measurable yet */ }
  }

  scheduleFit(delay = 60) {
    clearTimeout(this.fitTimer);
    this.fitTimer = setTimeout(() => { this.fitTimer = null; this.fitActive(); }, delay);
  }

  write(id, data) { window.astral.pty.write(id, data); }

  async kill(id) {
    const t = this.terms.get(id);
    if (!t) return;
    await window.astral.pty.kill(id);
    t.live = false;
  }

  async destroy(id) {
    const t = this.terms.get(id);
    if (!t) return;
    await window.astral.pty.kill(id);
    t.term.dispose();
    t.el.remove();
    this.terms.delete(id);
    if (this.active === id) this.active = null;
  }

  clear(id) { const t = this.terms.get(id); if (t) t.term.clear(); }
  focus(id) { const t = this.terms.get(id); if (t) t.term.focus(); }
}
