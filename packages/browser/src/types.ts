// ── Result monad ─────────────────────────────────────────────
export type Ok<T> = { ok: true; data: T };
export type Err = { ok: false; error: string };
export type Result<T> = Ok<T> | Err;

export function ok<T>(data: T): Ok<T> {
  return { ok: true, data };
}
export function err(error: string): Err {
  return { ok: false, error };
}

// ── Browser config (subset of ClawConfig.browser) ────────────
export interface BrowserConfig {
  headless: boolean;
  /** Absolute path to Chrome/Chromium. Empty = auto-detect. */
  executablePath: string;
  /** Remote debugging URL, e.g. "http://chrome:9222" for Docker mode */
  browserURL?: string;
}

// ── Snapshot types ────────────────────────────────────────────

/** Simplified representation of one interactive / visible element */
export interface SnapshotElement {
  tag: string;
  text: string;
  selector: string;
  href?: string;
  role?: string;
  placeholder?: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  /** Condensed element list for LLM context (links, buttons, inputs) */
  elements: SnapshotElement[];
  /** Raw visible text (body innerText), truncated to ~4 KB */
  textContent: string;
}

// ── Screenshot result ─────────────────────────────────────────
export interface ScreenshotData {
  base64: string;
  mimeType: "image/png";
  title: string;
  url: string;
}

// ── Typed result aliases ──────────────────────────────────────
export type NavigateResult   = Result<{ url: string; title: string }>;
export type SnapshotResult   = Result<PageSnapshot>;
export type ClickResult      = Result<void>;
export type TypeResult       = Result<void>;
export type ScreenshotResult = Result<ScreenshotData>;
export type CloseResult      = Result<void>;
