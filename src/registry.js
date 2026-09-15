// Every CLI Astral knows how to install, update and launch. Astral never
// modifies these tools: it runs the vendor's own install command in a visible
// terminal and launches the binary exactly as you would from a shell.
// Each CLI keeps its own input line: Terminal UI sessions never get a second bar.
// `modelFlag` + `models` drive the per-agent model menu; `liveModel` is a slash
// command the CLI accepts while running, so a switch can apply immediately.
export const REGISTRY = [
  { id: 'claude', name: 'Claude Code', vendor: 'Anthropic', cmd: 'claude', launch: 'claude', npm: '@anthropic-ai/claude-code', telemetry: 'claude', icon: 'claude', color: '#DA7756',
    modelFlag: '--model', liveModel: (m) => `/model ${m}`,
    // bare aliases and [1m] variants map to whatever the CLI resolves them to; a full id pins the 200K window
    models: [['fable[1m]', 'Fable 5.1 · 1M context'], ['opus[1m]', 'Opus 5 · 1M context'], ['claude-fable-5-1', 'Fable 5.1'], ['claude-opus-5', 'Opus 5'], ['claude-sonnet-5', 'Sonnet 5'], ['claude-haiku-4-5-20251001', 'Haiku 4.5'], ['opus', 'opus (alias)'], ['sonnet', 'sonnet (alias)'], ['haiku', 'haiku (alias)']],
    desc: 'Anthropic\'s agentic coding CLI. Resumable conversations, tool use, hooks and MCP.' },
  { id: 'codex', name: 'Codex', vendor: 'OpenAI', cmd: 'codex', launch: 'codex', npm: '@openai/codex', telemetry: 'codex', icon: 'openai', color: '#10A37F',
    modelFlag: '-m', models: [['gpt-5-codex', 'GPT-5 Codex'], ['gpt-5', 'GPT-5'], ['o3', 'o3'], ['o4-mini', 'o4-mini']],
    desc: 'OpenAI\'s terminal coding agent with sandboxed execution and session resume.' },
  { id: 'gemini', name: 'Gemini CLI', vendor: 'Google', cmd: 'gemini', launch: 'gemini', npm: '@google/gemini-cli', icon: 'gemini', color: '#8E75B2',
    modelFlag: '-m', models: [['gemini-2.5-pro', 'Gemini 2.5 Pro'], ['gemini-2.5-flash', 'Gemini 2.5 Flash']],
    desc: 'Google\'s open-source Gemini agent for the terminal with a 1M-token context.' },
  { id: 'grok', name: 'Grok CLI', vendor: 'xAI', cmd: 'grok', launch: 'grok', npm: '@vibe-kit/grok-cli', icon: 'x', color: '#E7E9EA',
    modelFlag: '--model', models: [['grok-4-latest', 'Grok 4'], ['grok-3-latest', 'Grok 3'], ['grok-code-fast-1', 'Grok Code Fast']],
    desc: 'Conversational coding agent backed by xAI\'s Grok models.' },
  { id: 'copilot', name: 'Copilot CLI', vendor: 'GitHub', cmd: 'copilot', launch: 'copilot', npm: '@github/copilot', icon: 'copilot', color: '#E7E9EA',
    modelFlag: '--model', models: [['claude-sonnet-4.5', 'Claude Sonnet 4.5'], ['gpt-5', 'GPT-5'], ['gemini-2.5-pro', 'Gemini 2.5 Pro']],
    desc: 'GitHub Copilot\'s agentic CLI. Uses your GitHub Copilot subscription.' },
  { id: 'opencode', name: 'OpenCode', vendor: 'SST', cmd: 'opencode', launch: 'opencode', npm: 'opencode-ai', icon: 'opencode', color: '#F1F1F1',
    modelFlag: '--model', models: [['anthropic/claude-sonnet-4-5', 'Claude Sonnet 4.5'], ['openai/gpt-5', 'GPT-5'], ['google/gemini-2.5-pro', 'Gemini 2.5 Pro']],
    desc: 'Open-source, provider-agnostic coding agent with a polished TUI.' },
  { id: 'qwen', name: 'Qwen Code', vendor: 'Alibaba', cmd: 'qwen', launch: 'qwen', npm: '@qwen-code/qwen-code', icon: 'qwen', color: '#6950EF',
    modelFlag: '-m', models: [['qwen3-coder-plus', 'Qwen3 Coder Plus'], ['qwen3-coder-flash', 'Qwen3 Coder Flash']],
    desc: 'Coding agent tuned for the Qwen3-Coder models, with a free tier.' },
  { id: 'kimi', name: 'Kimi CLI', vendor: 'Moonshot AI', cmd: 'kimi', launch: 'kimi', install: 'uv tool install --python 3.13 kimi-cli', icon: 'kimi', color: '#E7E9EA',
    modelFlag: '--model', models: [['kimi-for-coding', 'Kimi for Coding'], ['kimi-k2.5', 'Kimi K2.5']],
    desc: 'Moonshot\'s Kimi K2 agent for the shell. Needs the uv Python tool installer.' },
  { id: 'aider', name: 'Aider', vendor: 'Aider', cmd: 'aider', launch: 'aider', pip: 'aider-chat', icon: 'terminal', color: '#14B8A6',
    modelFlag: '--model', models: [['claude-sonnet-4-5', 'Claude Sonnet 4.5'], ['gpt-5', 'GPT-5'], ['ollama/llama3.2', 'Ollama llama3.2'], ['ollama/qwen2.5-coder', 'Ollama qwen2.5-coder']],
    desc: 'Pair programming in the terminal with any model. Works with local models too.' },
  { id: 'ollama', name: 'Ollama', vendor: 'Local models', cmd: 'ollama', launch: 'ollama run llama3.2', winget: 'Ollama.Ollama', icon: 'ollama', color: '#E7E9EA', local: true,
    modelInLaunch: true, models: [['llama3.2', 'Llama 3.2'], ['llama3.1', 'Llama 3.1'], ['qwen2.5-coder', 'Qwen 2.5 Coder'], ['deepseek-r1', 'DeepSeek R1'], ['gemma3', 'Gemma 3'], ['mistral', 'Mistral']],
    desc: 'Run Llama, Qwen, Gemma, DeepSeek and more on your own GPU. Edit the launch command to pick a model.' },
  { id: 'llamacpp', name: 'llama.cpp', vendor: 'ggml', cmd: 'llama-cli', launch: 'llama-cli -m model.gguf -cnv', winget: 'ggml.llamacpp', icon: 'cpu', color: '#E7E9EA', local: true,
    // the "model" is a GGUF path passed with -m; an existing -m in the launch command is replaced
    modelInLaunch: (base, m) => { const q = /\s/.test(m) ? `"${m}"` : m; const re = /(^|\s)-m\s+("[^"]+"|\S+)/; return re.test(base) ? base.replace(re, `$1-m ${q}`) : `${base} -m ${q}`; },
    modelPrompt: 'Path to a .gguf model file', models: [],
    desc: 'The open-source llama.cpp harness. Point the launch command at any GGUF model file.' },
  { id: 'lms', name: 'LM Studio', vendor: 'Element Labs', cmd: 'lms', launch: 'lms chat', install: 'npx lmstudio install-cli', icon: 'lmstudio', color: '#E7E9EA', local: true,
    // `lms chat [model]`: the model key is a positional argument right after "chat"
    modelInLaunch: (base, m) => base.replace(/^(\S+\s+chat)(\s+\S+)?/, `$1 ${m}`),
    modelPrompt: 'LM Studio model key (as shown by lms ls)', models: [],
    desc: 'Chat with models loaded in LM Studio from the terminal via the lms CLI.' },
  { id: 'shell', name: 'PowerShell', vendor: 'Microsoft', cmd: null, launch: null, icon: 'terminal', color: '#5391FE', builtin: true,
    desc: 'A plain PowerShell session in the project folder.' },
];

// Full launch command for an agent given the chosen model (null = agent default).
export function launchWith(r, baseLaunch, model) {
  if (!model) return baseLaunch;
  if (typeof r.modelInLaunch === 'function') return r.modelInLaunch(baseLaunch, model);
  if (r.modelInLaunch) return baseLaunch.replace(/^(\S+\s+run)\s+\S+/, `$1 ${model}`);
  if (r.modelFlag) return `${baseLaunch} ${r.modelFlag} ${model}`;
  return baseLaunch;
}
// Does this agent accept a model choice at all? (shells do not)
export const hasModel = (r) => !!(r && (r.modelFlag || r.modelInLaunch));

export const byId = Object.fromEntries(REGISTRY.map((r) => [r.id, r]));

export function agentOf(id) {
  return byId[id] || { id, name: id, vendor: '', cmd: id, launch: id, icon: 'terminal', color: '#E7E9EA', desc: '' };
}

export function installCommand(r) {
  if (r.npm) return `npm install -g ${r.npm}@latest`;
  if (r.pip) return `python -m pip install -U ${r.pip}`;
  if (r.winget) return `winget install -e --id ${r.winget} --accept-source-agreements --accept-package-agreements`;
  if (r.install) return r.install;
  return null;
}
export function updateCommand(r) {
  if (r.npm) return `npm install -g ${r.npm}@latest`;
  if (r.pip) return `python -m pip install -U ${r.pip}`;
  if (r.winget) return `winget upgrade -e --id ${r.winget} --accept-source-agreements --accept-package-agreements`;
  if (r.install) return r.install;
  return null;
}
