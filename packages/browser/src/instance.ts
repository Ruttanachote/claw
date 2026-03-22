// Dynamic import — defers puppeteer load until launchBrowser() is called.
// This prevents the module hanging on require() in environments where
// Chrome is not present (sandbox, CI, unit test runs).
import type { Browser, Page } from "puppeteer";
import type { BrowserConfig, Result } from "./types.js";
import { ok, err } from "./types.js";

// ── Singleton state ───────────────────────────────────────────
interface BrowserState {
  browser: Browser | null;
  page: Page | null;
  config: BrowserConfig | null;
}

const state: BrowserState = {
  browser: null,
  page: null,
  config: null,
};

const DEFAULT_CONFIG: BrowserConfig = {
  headless: true,
  executablePath: "",
};

const DEFAULT_VIEWPORT = { width: 1280, height: 900 };

// ── Launch ────────────────────────────────────────────────────
export async function launchBrowser(
  config: Partial<BrowserConfig> = {}
): Promise<Result<void>> {
  if (state.browser) return ok(undefined); // already running

  const cfg: BrowserConfig = { ...DEFAULT_CONFIG, ...config };
  state.config = cfg;

  try {
    // Lazy-load puppeteer to avoid blocking require() when Chrome is absent
    const { default: puppeteer } = await import("puppeteer");

    // Docker / remote Chrome via CDP URL
    if (cfg.browserURL) {
      state.browser = await puppeteer.connect({ browserURL: cfg.browserURL });
    } else {
      const launchOpts: Parameters<typeof puppeteer.launch>[0] = {
        headless: cfg.headless,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--disable-extensions",
          "--window-size=1280,900",
        ],
      };
      if (cfg.executablePath) {
        launchOpts.executablePath = cfg.executablePath;
      }
      state.browser = await puppeteer.launch(launchOpts);
    }

    // Open initial page
    const pages = await state.browser.pages();
    state.page = pages[0] ?? (await state.browser.newPage());
    await state.page.setViewport(DEFAULT_VIEWPORT);

    return ok(undefined);
  } catch (e) {
    state.browser = null;
    state.page = null;
    return err(`launchBrowser failed: ${String(e)}`);
  }
}

// ── Ensure running ────────────────────────────────────────────
export async function ensureBrowser(
  config?: Partial<BrowserConfig>
): Promise<Result<Page>> {
  if (!state.browser || !state.page) {
    const launch = await launchBrowser(config);
    if (!launch.ok) return launch;
  }
  if (!state.page) return err("Browser launched but no page available");
  return ok(state.page);
}

// ── Close ─────────────────────────────────────────────────────
export async function closeBrowser(): Promise<Result<void>> {
  try {
    if (state.page) {
      await state.page.close().catch(() => undefined);
      state.page = null;
    }
    if (state.browser) {
      await state.browser.close().catch(() => undefined);
      state.browser = null;
    }
    state.config = null;
    return ok(undefined);
  } catch (e) {
    return err(`closeBrowser failed: ${String(e)}`);
  }
}

// ── Expose current page (for internal use by other modules) ──
export function getPage(): Result<Page> {
  if (!state.page) return err("No active browser page — call launchBrowser first");
  return ok(state.page);
}

export function isRunning(): boolean {
  return state.browser !== null && state.page !== null;
}
