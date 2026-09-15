// Per-agent "working" indicators that mimic what each CLI draws in its own
// terminal while a turn runs: Claude Code's sparkle and random gerund, Codex's
// braille spinner with elapsed time, Gemini CLI's witty loading phrases, Aider's
// scanner bar. Agents without a signature spinner get their logo plus the
// three breathing dots. A single ticker animates every indicator on the page
// in place, so re-renders never restart the animation or change the phrase.
import { ag, esc, RUN } from './core.js';
import { agentOf } from './registry.js';

const BRAILLE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const CLAUDE_FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
// Aider's WaitingSpinner: a block sweeping back and forth over a dotted track.
const scanner = (w, b) => { const out = []; for (let p = 0; p <= w - b; p++) out.push('░'.repeat(p) + '█'.repeat(b) + '░'.repeat(w - b - p)); for (let p = w - b - 1; p > 0; p--) out.push('░'.repeat(p) + '█'.repeat(b) + '░'.repeat(w - b - p)); return out; };
const AIDER_FRAMES = scanner(10, 3), AIDER_SMALL = scanner(4, 2);

const CLAUDE_VERBS = ['Accomplishing', 'Actioning', 'Actualizing', 'Baking', 'Brewing', 'Calculating', 'Cerebrating', 'Churning', 'Clauding', 'Coalescing', 'Cogitating', 'Combobulating', 'Computing', 'Conjuring', 'Considering', 'Cooking', 'Crafting', 'Creating', 'Crunching', 'Deliberating', 'Determining', 'Discombobulating', 'Doing', 'Effecting', 'Envisioning', 'Finagling', 'Flibbertigibbeting', 'Forging', 'Forming', 'Frolicking', 'Gallivanting', 'Generating', 'Hatching', 'Herding', 'Honking', 'Hustling', 'Ideating', 'Inferring', 'Manifesting', 'Marinating', 'Meandering', 'Moseying', 'Mulling', 'Mustering', 'Musing', 'Noodling', 'Percolating', 'Perusing', 'Philosophising', 'Pondering', 'Processing', 'Puttering', 'Recombobulating', 'Reticulating', 'Ruminating', 'Scheming', 'Schlepping', 'Shucking', 'Simmering', 'Smooshing', 'Spinning', 'Stewing', 'Sussing', 'Synthesizing', 'Thinking', 'Tinkering', 'Transmuting', 'Unfurling', 'Vibing', 'Whirring', 'Wibbling', 'Working', 'Wrangling'];
const GEMINI_PHRASES = ['Shuffling the bits...', 'Reticulating splines...', 'Warming up the AI hamsters...', 'Asking the magic conch shell...', 'Consulting the digital spirits...', 'Polishing the algorithms...', "Don't rush perfection (or my code)...", 'Brewing fresh bytes...', 'Counting electrons...', 'Engaging cognitive processors...', 'Checking for syntax errors in the universe...', 'One moment, optimizing humor...', 'Untangling neural nets...', 'Compiling brilliance...', 'Loading witty retort...', 'Summoning the cloud of wisdom...', 'Preparing a witty response...', "Just a sec, I'm debugging reality...", 'Confusing the neural network...', 'Herding digital cats...', 'Petting the code monkeys...', 'Teaching the AI to dance...', 'Aligning the stars...', 'Rebooting the Matrix...', 'Grepping for the answer...', 'Optimizing the flux capacitor...', 'Dividing by zero... just kidding!', 'Generating witty comeback...', 'Almost there... probably...'];

// frames + speed, the phrase pool, how often a phrase rotates (0 = one per turn),
// and how the elapsed time is written. `mono` frames need a fixed-width font.
const STYLES = {
  claude: { frames: CLAUDE_FRAMES, ms: 120, phrases: CLAUDE_VERBS, suffix: '…', rotate: 0, elapsed: (t, hint) => `(${t}${hint ? ' · esc to interrupt' : ''})` },
  codex: { frames: BRAILLE, ms: 80, phrases: ['Working'], rotate: 0, elapsed: (t, hint) => `(${t}${hint ? ' • esc to interrupt' : ''})` },
  gemini: { frames: BRAILLE, ms: 80, phrases: GEMINI_PHRASES, rotate: 15000, elapsed: (t, hint) => `(${hint ? 'esc to cancel, ' : ''}${t})` },
  qwen: { frames: BRAILLE, ms: 80, phrases: GEMINI_PHRASES, rotate: 15000, elapsed: (t, hint) => `(${hint ? 'esc to cancel, ' : ''}${t})` },
  aider: { frames: AIDER_FRAMES, glyphFrames: AIDER_SMALL, ms: 90, mono: true, phrases: ['Waiting for LLM'], rotate: 0, elapsed: () => '' },
};
export const hasSpinner = (agent) => !!STYLES[agent];

// phrase per indicator key (a session id); a new `since` means a new turn
const phrases = new Map();
function phraseFor(style, key, since, now) {
  let p = phrases.get(key);
  if (!p || p.since !== since || (style.rotate && now - p.at >= style.rotate)) {
    const pool = style.phrases; let next = pool[Math.floor(Math.random() * pool.length)];
    if (p && pool.length > 1 && next === p.text) next = pool[(pool.indexOf(next) + 1) % pool.length];
    p = { text: next, since, at: now }; phrases.set(key, p);
  }
  return p.text + (style.suffix || '');
}
const frameFor = (style, now, small) => { const f = (small && style.glyphFrames) || style.frames; return f[Math.floor(now / style.ms) % f.length]; };
const fmtElapsed = (since, now) => { const s = Math.max(0, Math.round((now - since) / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };

// Build the indicator. mode 'glyph': just the animated mark (tabs, row badges).
// mode 'line': mark + phrase + elapsed (chat working line, sidebar subtitle).
// `key` identifies the turn so the phrase survives re-renders; `since` is the
// turn start; `hint` adds the CLI's own "esc to interrupt" wording.
export function WORK(agent, { mode = 'glyph', key = agent, since = 0, hint = false, glyph = true } = {}) {
  const style = STYLES[agent];
  if (!style) return mode === 'glyph' ? `${ag(agent)}${RUN()}` : `<span class="wk plain">${ag(agent)}${RUN()}<span class="ph">Working…</span></span>`;
  const now = Date.now();
  const color = agentOf(agent).color;
  const sp = `<span class="sp ${style.mono ? 'mono' : ''}">${esc(frameFor(style, now, mode === 'glyph'))}</span>`;
  if (mode === 'glyph') return `<span class="wk glyph" data-agent="${agent}" style="--ag-color:${color}">${sp}</span>`;
  const el = since ? style.elapsed(fmtElapsed(since, now), hint) : '';
  return `<span class="wk line" data-agent="${agent}" data-key="${esc(key)}" data-since="${since}" ${hint ? 'data-hint="1"' : ''} style="--ag-color:${color}">${glyph ? sp : ''}<span class="ph">${esc(phraseFor(style, key, since, now))}</span>${el ? `<span class="el">${esc(el)}</span>` : ''}</span>`;
}

// One ticker for every indicator on the page: swaps frames, rotates phrases,
// counts the seconds. Cheap when nothing is working.
setInterval(() => {
  const els = document.querySelectorAll('.wk[data-agent]');
  if (!els.length) return;
  const now = Date.now();
  for (const el of els) {
    const style = STYLES[el.dataset.agent]; if (!style) continue;
    const sp = el.querySelector('.sp'); if (sp) { const f = frameFor(style, now, el.classList.contains('glyph')); if (sp.textContent !== f) sp.textContent = f; }
    if (!el.classList.contains('line')) continue;
    const since = +el.dataset.since || 0;
    const ph = el.querySelector('.ph'); if (ph) { const t = phraseFor(style, el.dataset.key, since, now); if (ph.textContent !== t) ph.textContent = t; }
    const e = el.querySelector('.el'); if (e && since) { const t = style.elapsed(fmtElapsed(since, now), !!el.dataset.hint); if (e.textContent !== t) e.textContent = t; }
  }
}, 80);
