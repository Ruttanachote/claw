import fs from "fs";
import path from "path";
import os from "os";

export type LogLevel = "debug" | "info" | "warn" | "error";

// ── Log ring-buffer (last 500 entries, forwarded to UI) ───────
export interface LogEntry {
  ts: string;
  level: LogLevel;
  namespace: string;
  message: string;
  meta?: unknown;
}

const MAX_RING = 500;
const _ring: LogEntry[] = [];
let _sink: ((entry: LogEntry) => void) | null = null;

/** Register a callback that receives every log entry in real-time (e.g. IPC push). */
export function setLogSink(fn: ((entry: LogEntry) => void) | null): void {
  _sink = fn;
}

/** Return buffered log entries, optionally filtered by level. */
export function getLogEntries(minLevel?: LogLevel): LogEntry[] {
  if (!minLevel) return [..._ring];
  const minN = LEVELS[minLevel];
  return _ring.filter((e) => LEVELS[e.level] >= minN);
}

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

interface LoggerState {
  dir: string;
  minLevel: LogLevel;
  currentDate: string;
  stream: fs.WriteStream | null;
}

const state: LoggerState = {
  dir: path.join(os.homedir(), ".claw", "logs"),
  minLevel: "info",
  currentDate: "",
  stream: null,
};

function resolveDir(dir: string): string {
  if (dir.startsWith("~")) {
    return path.join(os.homedir(), dir.slice(1));
  }
  return dir;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function getStream(): fs.WriteStream {
  const today = todayStr();
  if (state.stream && state.currentDate === today) {
    return state.stream;
  }

  // Close old stream
  if (state.stream) {
    state.stream.end();
    state.stream = null;
  }

  const resolvedDir = resolveDir(state.dir);
  fs.mkdirSync(resolvedDir, { recursive: true });

  const filePath = path.join(resolvedDir, `${today}.log`);
  state.currentDate = today;
  state.stream = fs.createWriteStream(filePath, { flags: "a" });
  return state.stream;
}

function write(level: LogLevel, namespace: string, message: string, meta?: unknown): void {
  if (LEVELS[level] < LEVELS[state.minLevel]) return;

  const ts = new Date().toISOString();
  const metaStr = meta !== undefined ? " " + JSON.stringify(meta) : "";
  const line = `${ts} [${level.toUpperCase().padEnd(5)}] [${namespace}] ${message}${metaStr}\n`;

  // Always write to stderr for debug visibility
  process.stderr.write(line);

  try {
    getStream().write(line);
  } catch {
    // If log write fails, don't crash the app — just stderr above
  }

  // Push to ring buffer
  const entry: LogEntry = { ts, level, namespace, message, meta };
  _ring.push(entry);
  if (_ring.length > MAX_RING) _ring.shift();
  if (_sink) {
    try { _sink(entry); } catch { /* ignore sink errors */ }
  }
}

export function initLogger(dir: string, level: LogLevel): void {
  state.dir = dir;
  state.minLevel = level;
  // Close any existing stream so next write reopens with new dir
  if (state.stream) {
    state.stream.end();
    state.stream = null;
  }
}

export function createLogger(namespace: string) {
  return {
    debug: (msg: string, meta?: unknown) => write("debug", namespace, msg, meta),
    info:  (msg: string, meta?: unknown) => write("info",  namespace, msg, meta),
    warn:  (msg: string, meta?: unknown) => write("warn",  namespace, msg, meta),
    error: (msg: string, meta?: unknown) => write("error", namespace, msg, meta),
  };
}

export type Logger = ReturnType<typeof createLogger>;
