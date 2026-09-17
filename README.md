# Astral Coder

One desktop console for every coding agent. Claude Code, Codex, Gemini CLI, Grok,
Copilot CLI, OpenCode, Qwen Code, Kimi, Aider and local models (Ollama, llama.cpp,
LM Studio) each run untouched inside a real terminal, organised into projects,
workspaces and sessions. Claude Code additionally gets a native chat interface.

Astral never modifies a CLI. It launches the vendor's binary exactly as you would
from a shell, reads the transcripts the CLIs already write, and draws the rest.

Windows only for now (ConPTY + PowerShell).

## Installation

### Prerequisites

- Windows 10 or 11
- [Node.js](https://nodejs.org) 22 or newer (comes with npm)
- [Git](https://git-scm.com) on the PATH
- At least one coding CLI you want to use, for example Claude Code:

  ```
  npm install -g @anthropic-ai/claude-code
  claude          # run once to log in
  ```

  Every other supported CLI can be installed from inside Astral (Settings → Agents),
  which runs the vendor's own install command in a visible terminal.

- Optional: [GitHub CLI](https://cli.github.com) for pull requests and checks.
  Astral can install it for you from the Checks tab; then run `gh auth login`.

### Get the app

```
git clone https://github.com/maxwitanowski/Astral-Coder.git
cd Astral-Coder
npm install
npm start
```

`npm start` builds the interface and opens the app. After the first build you can
launch it without a console window by double-clicking `Astral.vbs` (make a
shortcut to it for the desktop or taskbar; `assets/icon.ico` is the icon).

For UI development, `npm run dev` runs Vite with hot reload and opens Electron
against it.

### Where things are stored

| What | Where |
| --- | --- |
| Projects, workspaces, sessions, settings | `%APPDATA%\Astral\astral.json` (a `.bak` of the last good copy is kept beside it) |
| Chat history per Claude session | `%APPDATA%\Astral\chats\<session id>.json` |
| Handoff brief for the next agent | `<workspace>\.astral\handoff.md` (excluded from git automatically) |
| Isolated workspaces (Conductor mode) | `%USERPROFILE%\conductor\workspaces` |

## Using Astral

### Add a repository, open a workspace

Click **Add repository** in the sidebar (or `Ctrl+Shift+N`) and pick a folder.
Every repository gets a `local` workspace that is the folder itself. **New
workspace** (`Ctrl+N`) creates an isolated git worktree on its own branch when you
want an agent working without touching your checkout.

### Start an agent

In a workspace, use the launcher row to open Claude Code, a shell, or any agent
you have enabled. Claude Code opens in **Chat UI** by default; everything else
opens in **Terminal UI**, the CLI's own interface inside a terminal.

- **Chat UI (Claude Code)**: type in the composer at the bottom. Enter sends,
  Shift+Enter adds a line, Esc interrupts the current turn. Streamed replies,
  thinking, tool calls (expandable), permission prompts and questions are drawn
  by Astral. Paste or drop images to send them to Claude; paste a long block of
  text and it collapses to `[Pasted text #1 +42 lines]` like the CLI does.
- **Terminal UI**: you type into the CLI's own input line. Shift+Enter inserts a
  newline in Claude Code, Gemini CLI and Qwen Code. Ctrl and Alt shortcuts go to
  the CLI while the terminal is focused; only Ctrl+Shift chords, Ctrl+digits and
  Ctrl+Tab remain app shortcuts there.

The chips under the composer set, per session, the **model** ("Default" means
the CLI's own settings, so a `fable[1m]` in your Claude settings is honoured),
the **permission mode** (auto, accept edits, ask, plan, bypass; Shift+Tab toggles
plan) and the **effort** level.

### While an agent works

Each CLI's own working indicator is mirrored in the tab and the sidebar row:
Claude Code's sparkle and random verb ("Combobulating…"), Codex's and Gemini's
braille spinner with elapsed time, Aider's scanner bar. Others show their logo
with three dots.

Messages you send while Claude is busy (or still starting) go into a **queue**
above the input and are delivered one at a time as each turn ends. Ctrl+Enter
interrupts and sends immediately instead. Settings → Agents → Follow-up
behaviour swaps those two.

Work done through Claude's Agent tool streams back under its step: a live line of
what the subagent is doing, a step count, and the full log when expanded.

### Closing and reopening

Chat history is saved on disk, so a relaunch shows the whole conversation. A chat
that was mid-turn when Astral closed is resumed on the next launch and told to
continue where it left off. Any Claude Code or Codex conversation started outside
Astral can be picked up from the resume picker (`Ctrl+Shift+R`, or the history
icon in the launcher row); **All folders** (Tab) lists every conversation on the
machine.

### Switching agents mid-project

When you open a new agent in a workspace that already has a Claude or Codex
conversation, Astral writes a brief of that conversation (what was asked, files
changed, recent commands, the last replies) to `.astral/handoff.md` and the new
agent's first message tells it to read that before anything else. Switch from
Claude to Codex or Gemini and ask it to continue; it knows where things stand.

### Control chats from your phone

Settings → General → Phone → **Start hosting**. Astral serves a small website on
this PC; Astral shows the address (for example `http://192.168.1.20:5175`) and a
4-digit code. Open the address on your phone, enter the code, and you can pick a
chat, send prompts (with photos), read the replies as they finish, stop a turn,
and see a screenshot under any reply that mentions a localhost page. The Preview
button captures any address on demand.

On your home network the address works as is. To use it away from home, turn on
**Internet access (port forwarding)** in the same settings: Astral shows your
public address, switches to an 8-character code, and lists the router steps
(forward TCP port 5175 to this PC). No outside service is involved. Windows may
ask once to allow Astral through the firewall; Astral must be running. If your
ISP uses shared addressing (CGNAT), inbound connections are blocked and a private
network such as Tailscale is the alternative.

### Git, pull requests, checks### Git, pull requests, checks

The right panel has **Diff** (git status with per-file line counts, review
comments you can send to the agent), **Checks** (the open PR, its checks, merge,
and the GitHub CLI install/login buttons) and **Files** (the workspace tree with
read-only previews). The `…` menu in the top bar covers commit and push
(`Ctrl+Shift+Y`), pull latest (`Ctrl+Shift+L`), create PR (`Ctrl+Shift+P`) and
branch rename. Every git step runs in a visible shell in the terminal drawer
(`` Ctrl+` ``).

### Settings

`Ctrl+,` or the gear in the sidebar.

- **General**: theme, font, follow-up behaviour (queue or interrupt), sounds,
  and **Start Claude Code in your home folder**. Claude Code keeps its
  auto-memory per start folder; with this on, Claude starts in your home folder
  and the workspace is added with `--add-dir`, so it sees the memory you have
  built up there. Off by default.
- **Repositories**: setup and run scripts per repository (they get their own
  tabs in the workspace).
- **Agents**: every supported CLI with installed and latest versions, install
  and update buttons, an editable launch command, a default model, and whether
  it appears in the launcher row.
- **Shortcuts**: the full key list.

## Keys

| Key | Action |
| --- | --- |
| `Ctrl+N` / `Ctrl+Shift+N` | New workspace / add repository |
| `Ctrl+K` | Search and quick open |
| `Ctrl+Shift+R` | Resume a past conversation |
| `Ctrl+Tab` / `Ctrl+1..9` | Switch sessions / workspaces |
| `Ctrl+B` / `Ctrl+\` / `` Ctrl+` `` | Toggle sidebar / right panel / terminal drawer (from outside a terminal) |
| `Ctrl+Shift+D` / `E` / `C` | Diff / Files / Checks panel |
| `Ctrl+Shift+Y` / `L` / `P` | Commit and push / pull latest / create PR |
| `Ctrl+Shift+T` | Big terminal mode |
| `Ctrl+Shift+Backspace` | Stop the active agent |
| `Alt+←` / `Alt+→` | Back / forward through visited workspaces |
| `Ctrl+Shift+C` / `Ctrl+V` | Copy selection / paste in a terminal (Ctrl+V falls through to the CLI when the clipboard holds an image) |

## How it works

- **Terminals**: `node-pty` (ConPTY) in the Electron main process, xterm.js in
  the window. CLIs are started through PowerShell with a UTF-8 console.
- **Claude Code chat**: `claude -p --input-format stream-json --output-format
  stream-json --permission-prompts host`, with `--session-id` so the transcript
  path is known, `--resume` to continue, `--forward-subagent-text` for subagent
  output, and `--model` / `--effort` / `--add-dir` only when you set them.
- **Live status**: `~/.claude/sessions/*.json` for Claude Code; output activity
  for the others.
- **Transcripts**: `~/.claude/projects/<encoded cwd>/<id>.jsonl` and
  `~/.codex/sessions/**/rollout-*.jsonl` are read for history, the activity
  panel, the resume picker and the handoff brief. Nothing is written to them.
- **Environment**: `CLAUDE_*` variables are stripped from child processes so a
  copy of Astral launched from inside a Claude Code session does not confuse
  the CLI it starts.

## Development

```
npm run dev      # Vite + Electron with hot reload
npm run build    # build the renderer into dist/
npm run rebuild  # rebuild node-pty against the installed Electron, if ever needed
```

Vanilla JavaScript, no framework. `src/` is the renderer (`main.js` app shell,
`chat.js` Claude chat, `terminals.js` xterm manager, `spinners.js` per-agent
indicators, `registry.js` the agent catalogue), `electron/` is the main process
(`main.cjs` window, ptys, git, IPC; `agents.cjs` transcript readers).
