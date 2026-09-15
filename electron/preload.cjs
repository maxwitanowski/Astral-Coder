const { contextBridge, ipcRenderer } = require('electron');

function on(channel, fn) {
  const wrapped = (_e, ...args) => fn(...args);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}
const inv = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('astral', {
  win: {
    minimize: inv('win:minimize'), maximize: inv('win:maximize'), close: inv('win:close'), isMaximized: inv('win:isMaximized'), isFocused: inv('win:isFocused'),
    onMaximized: (fn) => on('win:maximized', fn), onFocus: (fn) => on('win:focus', fn),
  },
  app: { paths: inv('app:paths') },
  store: { load: inv('store:load'), save: inv('store:save') },
  dialog: { pickFolder: inv('dialog:folder'), pickFiles: inv('dialog:files') },
  shell: { openPath: inv('shell:openPath'), openExternal: inv('shell:openExternal'), openIn: inv('shell:openIn'), which: inv('shell:which') },
  notify: inv('notify'),
  onNotifyClick: (fn) => on('notify:click', fn),
  fs: { list: inv('fs:list'), read: inv('fs:read'), exists: inv('fs:exists'), writeText: inv('fs:writeText') },
  git: {
    info: inv('git:info'), snapshot: inv('git:snapshot'), changes: inv('git:changes'), diffFile: inv('git:diffFile'), show: inv('git:show'), log: inv('git:log'),
    branches: inv('git:branches'), renameBranch: inv('git:renameBranch'), commitPush: inv('git:commitPush'), fetch: inv('git:fetch'), pullLatest: inv('git:pullLatest'), mergeBase: inv('git:mergeBase'),
    worktreeAdd: inv('git:worktreeAdd'), worktreeRemove: inv('git:worktreeRemove'), worktreeList: inv('git:worktreeList'), deleteBranch: inv('git:deleteBranch'), clone: inv('git:clone'),
  },
  gh: {
    available: inv('gh:available'), recheck: inv('gh:recheck'), pr: inv('gh:pr'), prChecks: inv('gh:prChecks'), prCreate: inv('gh:prCreate'), prMerge: inv('gh:prMerge'), prReady: inv('gh:prReady'),
    prList: inv('gh:prList'), issues: inv('gh:issues'), runLog: inv('gh:runLog'), auth: inv('gh:auth'),
  },
  conductor: { settings: inv('conductor:settings'), saveSettings: inv('conductor:saveSettings') },
  ai: { oneshot: inv('ai:oneshot') },
  plugins: { versions: inv('plugins:versions') },
  chat: {
    start: inv('chat:start'), send: (id, obj) => ipcRenderer.send('chat:send', id, obj), stop: inv('chat:stop'), alive: inv('chat:alive'),
    historySave: inv('chat:history:save'), historyLoad: inv('chat:history:load'), historyDelete: inv('chat:history:delete'),
    onEvent: (fn) => on('chat:event', fn),
  },
  pty: {
    create: inv('pty:create'), write: (id, data) => ipcRenderer.send('pty:write', id, data), resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
    kill: inv('pty:kill'), alive: inv('pty:alive'), onData: (fn) => on('pty:data', fn), onExit: (fn) => on('pty:exit', fn),
  },
  agents: {
    listClaude: inv('agents:listClaude'), listCodex: inv('agents:listCodex'), listAll: inv('agents:listAll'), liveClaudeStatus: inv('agents:liveClaudeStatus'), handoff: inv('agents:handoff'),
    watch: inv('telemetry:watch'), unwatch: inv('telemetry:unwatch'), onEvent: (fn) => on('telemetry:event', fn),
  },
});
