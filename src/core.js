// Shared helpers: escaping, icons, formatting, markdown, syntax highlighting,
// menus, modals, toasts, sounds and a tiny event bus. No view logic here.
import { I, brandSvg } from './icons.js';
import { REGISTRY, agentOf } from './registry.js';
import { state } from './store.js';
import hljs from 'highlight.js/lib/core';
import hlJs from 'highlight.js/lib/languages/javascript';
import hlTs from 'highlight.js/lib/languages/typescript';
import hlCss from 'highlight.js/lib/languages/css';
import hlScss from 'highlight.js/lib/languages/scss';
import hlXml from 'highlight.js/lib/languages/xml';
import hlJson from 'highlight.js/lib/languages/json';
import hlPy from 'highlight.js/lib/languages/python';
import hlPs from 'highlight.js/lib/languages/powershell';
import hlBash from 'highlight.js/lib/languages/bash';
import hlMd from 'highlight.js/lib/languages/markdown';
import hlYaml from 'highlight.js/lib/languages/yaml';
import hlRust from 'highlight.js/lib/languages/rust';
import hlGo from 'highlight.js/lib/languages/go';
import hlJava from 'highlight.js/lib/languages/java';
import hlCs from 'highlight.js/lib/languages/csharp';
import hlCpp from 'highlight.js/lib/languages/cpp';
import hlC from 'highlight.js/lib/languages/c';
import hlSql from 'highlight.js/lib/languages/sql';
import hlIni from 'highlight.js/lib/languages/ini';
import hlDiff from 'highlight.js/lib/languages/diff';
import hlDocker from 'highlight.js/lib/languages/dockerfile';

for (const [n, l] of Object.entries({ javascript: hlJs, typescript: hlTs, css: hlCss, scss: hlScss, xml: hlXml, json: hlJson, python: hlPy, powershell: hlPs, bash: hlBash, markdown: hlMd, yaml: hlYaml, rust: hlRust, go: hlGo, java: hlJava, csharp: hlCs, cpp: hlCpp, c: hlC, sql: hlSql, ini: hlIni, diff: hlDiff, dockerfile: hlDocker })) hljs.registerLanguage(n, l);
export const LANG_BY_EXT = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', css: 'css', scss: 'scss', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', json: 'json', py: 'python', ps1: 'powershell', psm1: 'powershell', sh: 'bash', bash: 'bash', zsh: 'bash', md: 'markdown', markdown: 'markdown', yml: 'yaml', yaml: 'yaml', rs: 'rust', go: 'go', java: 'java', cs: 'csharp', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', h: 'c', c: 'c', sql: 'sql', ini: 'ini', toml: 'ini', cfg: 'ini', diff: 'diff', patch: 'diff', dockerfile: 'dockerfile' };

export const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const basename = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || p;
export const dirname = (p) => { const s = String(p || ''); const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')); return i > 0 ? s.slice(0, i) : ''; };
export const ic = (k, cls = 'i') => `<span class="${cls}">${I[k] || I.circle}</span>`;
export const ag = (id, cls = 'ag') => { const a = agentOf(id); return `<span class="${cls}" style="--ag-color:${a.color}">${brandSvg(a.icon)}</span>`; };
export const fmtTime = (ts) => (ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
export function when(ts) {
  if (!ts) return '';
  const d = new Date(ts); const diff = Date.now() - d;
  if (diff < 60e3) return 'now';
  if (diff < 3600e3) return Math.round(diff / 60e3) + 'm';
  if (diff < 864e5) return Math.round(diff / 3600e3) + 'h';
  if (diff < 7 * 864e5) return Math.round(diff / 864e5) + 'd';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
export const kb = (n) => (n > 1024 * 1024 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1024).toFixed(1) + ' KB');
export const slug = (s, max = 40) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, max).replace(/-$/, '');
export const samePath = (a, b) => String(a || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase() === String(b || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

export const isInstalled = (id) => id === 'shell' || !!(state.versions[id] && state.versions[id].path);
export const hasUpdate = (id) => { const v = state.versions[id]; return !!(v && v.path && v.installed && v.latest && v.installed !== v.latest && !v.installed.startsWith(v.latest)); };
export const updateCount = () => REGISTRY.filter((r) => hasUpdate(r.id)).length;
export const launchCmd = (id) => state.launchOverride[id] || agentOf(id).launch;
export const modelOf = (s) => s.model || state.models[s.agent] || null;
export const modelLabel = (agent, m) => { const r = agentOf(agent); const f = (r.models || []).find((x) => x[0] === m); return m ? (f ? f[1] : m) : 'Default model'; };

// Workspace names are cities, like Conductor. Repeats get a -v2 suffix.
export const CITIES = ['tokyo', 'lisbon', 'oslo', 'kyoto', 'berlin', 'nairobi', 'havana', 'quito', 'porto', 'seoul', 'vienna', 'delhi', 'cairo', 'lima', 'perth', 'zurich', 'dublin', 'prague', 'osaka', 'tunis', 'malmo', 'bergen', 'riga', 'tallinn', 'vilnius', 'sofia', 'ankara', 'tbilisi', 'baku', 'muscat', 'doha', 'denver', 'austin', 'boise', 'tulsa', 'reno', 'fresno', 'bogota', 'cusco', 'rosario', 'mendoza', 'recife', 'manaus', 'accra', 'lagos', 'dakar', 'kigali', 'lusaka', 'harare', 'maputo', 'hanoi', 'hue', 'taipei', 'manila', 'cebu', 'bali', 'jakarta', 'penang', 'hobart', 'darwin', 'cairns', 'auckland', 'nelson', 'warsaw', 'krakow', 'gdansk', 'lyon', 'nantes', 'bordeaux', 'porto', 'seville', 'valencia', 'bilbao', 'genoa', 'turin', 'naples', 'palermo', 'bari', 'graz', 'basel', 'geneva', 'ghent', 'bruges', 'leiden', 'utrecht', 'aarhus', 'odense', 'tampere', 'turku', 'lulea', 'reykjavik', 'akureyri'];
export function pickCity(taken) {
  const used = new Set((taken || []).map((n) => String(n).toLowerCase()));
  const pool = CITIES.filter((c) => !used.has(c));
  if (pool.length) return pool[Math.floor(Math.random() * pool.length)];
  const base = CITIES[Math.floor(Math.random() * CITIES.length)];
  let n = 2; while (used.has(`${base}-v${n}`)) n++;
  return `${base}-v${n}`;
}

let runSeq = 0;
// working indicator: three dots that breathe in sequence
export const RUN = () => `<span class="run" data-run="${++runSeq}"><i></i><i></i><i></i></span>`;

export function highlight(text, file, lang) {
  if (!lang) { const ext = (String(file || '').split('.').pop() || '').toLowerCase(); lang = LANG_BY_EXT[ext] || (basename(file || '').toLowerCase() === 'dockerfile' ? 'dockerfile' : null); }
  try { return lang && hljs.getLanguage(lang) ? hljs.highlight(text, { language: lang, ignoreIllegals: true }).value : esc(text); } catch { return esc(text); }
}

// ---- markdown (enough for agent replies: headings, lists, quotes, code, links, tables) ----
function inline(t) {
  let s = esc(t);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" data-ext="$2">$1</a>');
  s = s.replace(/(^|[^"'>])(https?:\/\/[^\s<]+[^\s<.,;:)])/g, '$1<a href="$2" data-ext="$2">$2</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  return s;
}
export function md(text) {
  const parts = String(text || '').replace(/\r\n/g, '\n').split(/```/);
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const m = /^([\w+#.-]*)\n/.exec(parts[i]);
      const lang = m ? m[1].toLowerCase() : '';
      const body = parts[i].replace(/^[\w+#.-]*\n/, '').replace(/\n$/, '');
      const l = LANG_BY_EXT[lang] || (hljs.getLanguage(lang) ? lang : null);
      out += `<pre class="code" data-lang="${esc(lang)}"><code>${l ? highlight(body, null, l) : esc(body)}</code></pre>`;
      continue;
    }
    const blocks = parts[i].split(/\n{2,}/);
    for (const para of blocks) {
      const p = para.replace(/^\n+|\n+$/g, '');
      if (!p.trim()) continue;
      const lines = p.split('\n');
      if (lines.every((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l) || /^\s{2,}\S/.test(l))) {
        const ordered = /^\s*\d+[.)]/.test(lines[0]);
        const items = [];
        for (const l of lines) { if (/^\s*([-*•]|\d+[.)])\s+/.test(l)) items.push(l.replace(/^\s*([-*•]|\d+[.)])\s+/, '')); else if (items.length) items[items.length - 1] += ' ' + l.trim(); }
        out += `<${ordered ? 'ol' : 'ul'}>${items.map((x) => { const task = /^\[([ xX])\]\s+/.exec(x); return `<li${task ? ` class="task ${task[1] !== ' ' ? 'done' : ''}"` : ''}>${inline(task ? x.slice(task[0].length) : x)}</li>`; }).join('')}</${ordered ? 'ol' : 'ul'}>`;
        continue;
      }
      if (lines.every((l) => /^\s*>/.test(l))) { out += `<blockquote>${md(lines.map((l) => l.replace(/^\s*>\s?/, '')).join('\n'))}</blockquote>`; continue; }
      if (lines.length >= 2 && /^\s*\|.*\|\s*$/.test(lines[0]) && /^\s*\|?\s*:?-{2,}/.test(lines[1])) {
        const rows = lines.filter((l) => !/^\s*\|?\s*:?-{2,}/.test(l)).map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
        out += `<table><thead><tr>${rows[0].map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.slice(1).map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
        continue;
      }
      const h = /^(#{1,4})\s+(.+)$/.exec(lines[0]);
      if (h && lines.length === 1) { out += `<h${Math.min(4, h[1].length + 1)}>${inline(h[2])}</h${Math.min(4, h[1].length + 1)}>`; continue; }
      if (/^(-{3,}|\*{3,})$/.test(p.trim())) { out += '<hr>'; continue; }
      out += `<p>${lines.map((l) => { const hh = /^(#{1,4})\s+(.+)$/.exec(l); return hh ? `<strong>${inline(hh[2])}</strong>` : inline(l); }).join('<br>')}</p>`;
    }
  }
  return out;
}

// ---- toast ----
let toastEl = null, toastTimer = null;
export function toast(msg, error = false) {
  if (toastEl) toastEl.remove();
  toastEl = document.createElement('div');
  toastEl.className = 'toast' + (error ? ' error' : '');
  toastEl.textContent = msg;
  document.body.appendChild(toastEl);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { if (toastEl) { toastEl.remove(); toastEl = null; } }, error ? 5200 : 3200);
}

// ---- context menus ----
let ctxEl = null;
export function closeCtx() { if (ctxEl) { ctxEl.remove(); ctxEl = null; } }
document.addEventListener('mousedown', (e) => { if (ctxEl && !ctxEl.contains(e.target)) closeCtx(); });
window.addEventListener('blur', closeCtx);
export function menu(x, y, items, { keepOpen = false, width = null } = {}) {
  closeCtx();
  ctxEl = document.createElement('div');
  ctxEl.className = 'ctx';
  if (width) ctxEl.style.width = width + 'px';
  const render = () => {
    ctxEl.innerHTML = items.map((i) => i === '-' ? '<hr>' : typeof i === 'string' ? `<div class="ctx-title">${esc(i)}</div>` :
      `<button class="${i.danger ? 'danger' : ''} ${i.checked ? 'checked' : ''}" ${i.disabled ? 'disabled' : ''}>${i.check !== undefined ? `<span class="tick">${i.checked ? ic('check2') : ''}</span>` : ''}${i.agent ? ag(i.agent) : i.icon ? ic(i.icon) : ''}<span class="lbl">${esc(i.label)}</span>${i.sub ? `<span class="sub">${esc(i.sub)}</span>` : ''}${i.kbd ? `<span class="kbd">${esc(i.kbd)}</span>` : ''}</button>`).join('');
    let idx = 0;
    ctxEl.querySelectorAll('button').forEach((b) => {
      while (items[idx] === '-' || typeof items[idx] === 'string') idx++;
      const item = items[idx++];
      b.addEventListener('click', () => { if (item.disabled) return; if (!keepOpen) closeCtx(); item.run(); if (keepOpen && ctxEl) { if (item.check !== undefined) item.checked = !item.checked; render(); } });
    });
  };
  render();
  document.body.appendChild(ctxEl);
  const r = ctxEl.getBoundingClientRect();
  ctxEl.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
  ctxEl.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
  return ctxEl;
}
export function menuAt(el, items, opts = {}) { const r = el.getBoundingClientRect(); return menu(opts.alignRight ? Math.max(4, r.right - (opts.width || 220)) : r.left, r.bottom + 4, items, opts); }

// ---- modals ----
export const hooks = { onModalClose: null };
export function modal(html, cls = 'modal') {
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `<div class="${cls}">${html}</div>`;
  document.body.appendChild(ov);
  const close = () => { ov.remove(); if (hooks.onModalClose) hooks.onModalClose(); };
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  ov.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.stopPropagation(); close(); } });
  return { ov, el: ov.firstElementChild, close };
}
export function promptModal(title, value = '', { placeholder = '', ok = 'Save', multiline = false, sub = '' } = {}) {
  return new Promise((resolve) => {
    const m = modal(`<h3>${esc(title)}</h3>${sub ? `<p class="sub">${esc(sub)}</p>` : ''}<div class="field">${multiline ? `<textarea id="pm" placeholder="${esc(placeholder)}">${esc(value)}</textarea>` : `<input type="text" id="pm" value="${esc(value)}" placeholder="${esc(placeholder)}">`}</div>
      <div class="modal-actions"><button class="btn ghost" id="pm-cancel">Cancel</button><button class="btn primary" id="pm-ok">${esc(ok)}</button></div>`);
    const inp = m.el.querySelector('#pm'); inp.focus(); if (!multiline) inp.select();
    const done = (v) => { m.close(); resolve(v); };
    m.el.querySelector('#pm-ok').onclick = () => done(inp.value.trim());
    m.el.querySelector('#pm-cancel').onclick = () => done(null);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (!multiline || e.ctrlKey)) { e.preventDefault(); done(inp.value.trim()); } if (e.key === 'Escape') { e.preventDefault(); done(null); } });
  });
}
export function confirmModal(title, body, { ok = 'Confirm', danger = true } = {}) {
  return new Promise((resolve) => {
    const m = modal(`<h3>${esc(title)}</h3><p class="sub">${esc(body)}</p>
      <div class="modal-actions"><button class="btn ghost" id="cm-cancel">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" id="cm-ok">${esc(ok)}</button></div>`);
    m.el.querySelector('#cm-ok').onclick = () => { m.close(); resolve(true); };
    m.el.querySelector('#cm-cancel').onclick = () => { m.close(); resolve(false); };
    m.el.querySelector('#cm-ok').focus();
    m.ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') { m.close(); resolve(false); } });
  });
}

// ---- sounds: Conductor's train whistle when a turn finishes ----
let actx = null;
export const sound = {
  // a twinkle: a rising four-note sparkle of pure tones with a soft shimmer, then a
  // final high glint. Short, quiet, and over in under a second.
  done() {
    if (!state.ui.sounds) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const t0 = actx.currentTime + 0.02;
      const ping = (f, at, dur, g) => {
        for (const [mult, gain, detune] of [[1, g, 0], [2, g * 0.22, 6], [3, g * 0.06, -5]]) {
          const o = actx.createOscillator(); const gn = actx.createGain();
          o.type = 'sine'; o.frequency.setValueAtTime(f * mult, at); o.detune.setValueAtTime(detune, at);
          gn.gain.setValueAtTime(0, at); gn.gain.linearRampToValueAtTime(gain, at + 0.012); gn.gain.exponentialRampToValueAtTime(0.0005, at + dur);
          o.connect(gn).connect(actx.destination); o.start(at); o.stop(at + dur + 0.02);
        }
      };
      const notes = [1318.5, 1568, 2093, 2637]; // E6 G6 C7 E7
      notes.forEach((f, i) => ping(f, t0 + i * 0.085, 0.45, 0.09));
      ping(3136, t0 + 0.42, 0.7, 0.05);  // G7 glint
      ping(2093, t0 + 0.5, 0.6, 0.03);
    } catch { /* no audio */ }
  },
  choo() { this.done(); },
};

// ---- bus ----
const handlers = new Map();
export const bus = {
  on(ev, fn) { if (!handlers.has(ev)) handlers.set(ev, new Set()); handlers.get(ev).add(fn); return () => handlers.get(ev).delete(fn); },
  emit(ev, ...args) { for (const fn of handlers.get(ev) || []) fn(...args); },
};

// external links in rendered markdown open in the browser
document.addEventListener('click', (e) => { const a = e.target.closest('a[data-ext]'); if (a) { e.preventDefault(); window.astral.shell.openExternal(a.dataset.ext); } });
