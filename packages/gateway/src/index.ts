// @claw/gateway — public API
// Single boundary between Electron (app/main) and pure-Node packages.
// Called via direct function calls from app/main — no HTTP, no WebSocket.

export type {
  Ok,
  Err,
  Result,
  GatewayCommand,
  GatewayResult,
  GatewayStatus,
  GatewayState,
  AgentOutput,
} from "./types.js";

export { ok, err } from "./types.js";

export {
  initGateway,
  shutdownGateway,
  handleCommand,
  getGatewayStatus,
  abortCurrentRun,
  listRecentSessions,
  newSession,
  removeSession,
} from "./gateway.js";
