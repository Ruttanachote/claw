// @claw/memory — public API
// All exports from this package. Other packages import from here only.

export type {
  Ok,
  Err,
  Result,
  Session,
  MessageRole,
  Message,
  Memory,
  CronJob,
  ClawConfig,
} from "./types.js";

export { ok, err } from "./types.js";

// Logger
export { initLogger, createLogger, setLogSink, getLogEntries } from "./logger.js";
export type { Logger, LogLevel, LogEntry } from "./logger.js";

// Config
export { loadConfig, getConfig, getConfigPath } from "./config.js";

// Database lifecycle
export { initDb, getDb, closeDb } from "./db.js";
export type { Db } from "./db.js";

// Sessions
export {
  createSession,
  getSession,
  touchSession,
  listSessions,
  deleteSession,
  ensureSession,
} from "./sessions.js";

// Messages
export {
  writeMessage,
  readContext,
  listMessages,
  deleteMessages,
  writeExchange,
} from "./messages.js";
export type { WriteMessageInput } from "./messages.js";

// Cron jobs
export {
  listCronJobs,
  getCronJob,
  upsertCronJob,
  deleteCronJob,
  setCronJobEnabled,
  stampCronJobRun,
} from "./cron.js";
export type { UpsertCronJobInput } from "./cron.js";

// Long-term memory KV + analytics
export {
  getMemory,
  setMemory,
  deleteMemory,
  listMemories,
  recordToolCall,
  getAgentStats,
} from "./memories.js";
export type { AgentStats } from "./memories.js";
