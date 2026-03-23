import { contextBridge, ipcRenderer } from "electron";

type R<T = unknown> = Promise<{ ok: boolean; data?: T; error?: string }>;

export interface ClawAPI {
  // Agent
  runAgent:  (input: string, sessionId: string) => R;
  abortRun:  () => R;
  onProgress:(cb: (p: { step: string; message: string }) => void) => () => void;
  onToken:   (cb: (token: string) => void) => () => void;

  // Sessions
  newSession:     () => R;
  listSessions:   () => R;
  deleteSession:  (id: string) => R;
  listMessages:   (sessionId: string) => R;

  // Cron
  listCronJobs:  () => R;
  toggleCronJob: (id: string, enabled: boolean) => R;
  deleteCronJob: (id: string) => R;

  // Memory KV
  listMemories:  () => R;
  getMemory:     (key: string) => R;
  setMemory:     (key: string, value: string) => R;
  deleteMemory:  (key: string) => R;

  // Analytics
  getStats: () => R;

  // Skills
  listSkills: () => R;

  // Logs
  getLogHistory: () => R;
  onLog: (cb: (entry: { ts: string; level: string; namespace: string; message: string }) => void) => () => void;

  // Config
  openConfig: () => R;
  getConfig:  () => R;

  // Terminal (direct shell execution)
  execShell: (command: string, cwd?: string, execId?: string) => R;
  getShellInfo: () => R;
  onShellChunk: (cb: (d: { id: string; chunk: string }) => void) => () => void;

  // System
  openExternal: (url: string) => R;
  registerPanelWebview: (id: number) => R;

  // Browser panel events (from main → renderer)
  onPanelShow: (cb: (url: string) => void) => () => void;
}

const api: ClawAPI = {
  runAgent:  (input, sessionId) => ipcRenderer.invoke("agent:run", { input, sessionId }),
  abortRun:  () => ipcRenderer.invoke("agent:abort"),

  onProgress: (cb) => {
    const h = (_e: Electron.IpcRendererEvent, p: { step: string; message: string }) => cb(p);
    ipcRenderer.on("agent:progress", h);
    return () => ipcRenderer.removeListener("agent:progress", h);
  },
  onToken: (cb) => {
    const h = (_e: Electron.IpcRendererEvent, t: string) => cb(t);
    ipcRenderer.on("agent:token", h);
    return () => ipcRenderer.removeListener("agent:token", h);
  },

  newSession:    () => ipcRenderer.invoke("session:new"),
  listSessions:  () => ipcRenderer.invoke("session:list"),
  deleteSession: (id) => ipcRenderer.invoke("session:delete", id),
  listMessages:  (sid) => ipcRenderer.invoke("session:messages", sid),

  listCronJobs:  () => ipcRenderer.invoke("cron:list"),
  toggleCronJob: (id, enabled) => ipcRenderer.invoke("cron:toggle", { id, enabled }),
  deleteCronJob: (id) => ipcRenderer.invoke("cron:delete", id),

  listMemories:  () => ipcRenderer.invoke("memory:list"),
  getMemory:     (key) => ipcRenderer.invoke("memory:get", key),
  setMemory:     (key, value) => ipcRenderer.invoke("memory:set", { key, value }),
  deleteMemory:  (key) => ipcRenderer.invoke("memory:delete", key),

  getStats:   () => ipcRenderer.invoke("analytics:stats"),
  listSkills: () => ipcRenderer.invoke("skills:list"),

  getLogHistory: () => ipcRenderer.invoke("logs:history"),
  onLog: (cb) => {
    const h = (_e: Electron.IpcRendererEvent, entry: { ts: string; level: string; namespace: string; message: string }) => cb(entry);
    ipcRenderer.on("log:entry", h);
    return () => ipcRenderer.removeListener("log:entry", h);
  },

  openConfig: () => ipcRenderer.invoke("config:open"),
  getConfig:  () => ipcRenderer.invoke("config:get"),

  execShell:    (command, cwd, execId) => ipcRenderer.invoke("shell:exec", { command, cwd, execId }),
  getShellInfo: ()                     => ipcRenderer.invoke("shell:info"),
  onShellChunk: (cb) => {
    const h = (_e: Electron.IpcRendererEvent, d: { id: string; chunk: string }) => cb(d);
    ipcRenderer.on("shell:chunk", h);
    return () => ipcRenderer.removeListener("shell:chunk", h);
  },

  openExternal:         (url) => ipcRenderer.invoke("shell:openExternal", url),
  registerPanelWebview: (id)  => ipcRenderer.invoke("browser:register-panel", id),

  onPanelShow: (cb) => {
    const h = (_e: Electron.IpcRendererEvent, url: string) => cb(url);
    ipcRenderer.on("browser:panel-show", h);
    return () => ipcRenderer.removeListener("browser:panel-show", h);
  },
};

contextBridge.exposeInMainWorld("clawAPI", api);
