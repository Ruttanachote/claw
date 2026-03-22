import { app, BrowserWindow } from "electron";
import path from "path";
import { initGateway, shutdownGateway } from "@claw/gateway";
import { createCronManager } from "@claw/cron";
import { createLogger } from "@claw/memory";
import { createTray } from "./tray.js";
import { createPopupWindow } from "./window.js";
import { registerIpcHandlers, unregisterIpcHandlers } from "./ipc.js";

const log = createLogger("main");

// ── Singleton refs ────────────────────────────────────────────
let popupWindow: BrowserWindow | null = null;
const cronManager = createCronManager();

// ── Single-instance lock ──────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.on("second-instance", () => {
  // If a second instance tries to open, focus the existing window
  popupWindow?.show();
  popupWindow?.focus();
});

// ── macOS: don't quit when all windows are closed ─────────────
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// ── App ready ─────────────────────────────────────────────────
app.whenReady().then(async () => {
  log.info("App ready", { platform: process.platform, version: app.getVersion() });

  // 1. Init gateway (config → db → llm)
  const configPath = process.env["CLAW_CONFIG"]
    ?? path.join(app.getPath("userData"), "claw.config.toml");

  const initResult = await initGateway(configPath);
  if (!initResult.ok) {
    log.error("Gateway init failed — check claw.config.toml", {
      error: initResult.error,
    });
    // Continue anyway — the UI will show an error state
  }

  // 2. Create popup window
  popupWindow = createPopupWindow();

  // 3. Register IPC handlers
  registerIpcHandlers(popupWindow);

  // 4. Create tray icon
  createTray(popupWindow);

  // 5. Start cron scheduler
  const cronResult = await cronManager.start();
  if (!cronResult.ok) {
    log.warn("Cron scheduler start failed", { error: cronResult.error });
  }

  log.info("Claw started");
});

// ── Before quit ───────────────────────────────────────────────
app.on("before-quit", async () => {
  log.info("App quitting…");

  unregisterIpcHandlers();

  await cronManager.stop();
  await shutdownGateway();

  log.info("Shutdown complete");
});

// ── Unhandled errors ──────────────────────────────────────────
process.on("uncaughtException", (error) => {
  log.error("Uncaught exception", { error: String(error), stack: error.stack });
});

process.on("unhandledRejection", (reason) => {
  log.error("Unhandled rejection", { reason: String(reason) });
});
