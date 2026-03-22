// @claw/browser — public API
// Puppeteer CDP wrapper. Zero Electron dependency. Pure Node.js.
// All functions return Result<T> — never throws.

export type {
  Ok,
  Err,
  Result,
  BrowserConfig,
  SnapshotElement,
  PageSnapshot,
  ScreenshotData,
  NavigateResult,
  SnapshotResult,
  ClickResult,
  TypeResult,
  ScreenshotResult,
  CloseResult,
} from "./types.js";

export { ok, err } from "./types.js";

// Instance lifecycle
export {
  launchBrowser,
  closeBrowser,
  ensureBrowser,
  isRunning,
} from "./instance.js";

// Page actions
export {
  navigate,
  snapshot,
  click,
  typeText,
  screenshot,
  evaluate,
  waitForSelector,
  waitForNavigation,
} from "./actions.js";
