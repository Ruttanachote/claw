import type {
  Result,
  NavigateResult,
  SnapshotResult,
  ClickResult,
  TypeResult,
  ScreenshotResult,
  PageSnapshot,
  SnapshotElement,
} from "./types.js";
import { ok, err } from "./types.js";
import { ensureBrowser, getPage } from "./instance.js";

const NAV_TIMEOUT_MS = 30_000;
const MAX_TEXT_CHARS  = 4_000;

// ── Navigate ──────────────────────────────────────────────────
export async function navigate(
  url: string,
  config?: { browserURL?: string; headless?: boolean; executablePath?: string }
): Promise<NavigateResult> {
  const pageResult = await ensureBrowser(config);
  if (!pageResult.ok) return pageResult;
  const page = pageResult.data;

  try {
    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: NAV_TIMEOUT_MS,
    });
    const title = await page.title();
    const finalUrl = page.url();
    return ok({ url: finalUrl, title });
  } catch (e) {
    return err(`navigate("${url}") failed: ${String(e)}`);
  }
}

// ── Snapshot ──────────────────────────────────────────────────
/**
 * Returns a condensed view of the page:
 *  - Interactive elements (links, buttons, inputs, selects)
 *  - Visible text (truncated)
 *
 * Designed to fit in an LLM context window without including full HTML.
 */
export async function snapshot(): Promise<SnapshotResult> {
  const pageResult = getPage();
  if (!pageResult.ok) return pageResult;
  const page = pageResult.data;

  try {
    const data = await page.evaluate(
      ({ maxChars }: { maxChars: number }) => {
        const elements: Array<{
          tag: string;
          text: string;
          selector: string;
          href?: string;
          role?: string;
          placeholder?: string;
        }> = [];

        // Helper: build a unique-ish CSS selector
        function selectorFor(el: Element): string {
          if (el.id) return `#${CSS.escape(el.id)}`;
          const tag = el.tagName.toLowerCase();
          const cls = Array.from(el.classList)
            .slice(0, 2)
            .map((c) => `.${CSS.escape(c)}`)
            .join("");
          return `${tag}${cls}`;
        }

        function truncate(s: string, n: number): string {
          const t = s.replace(/\s+/g, " ").trim();
          return t.length > n ? t.slice(0, n) + "…" : t;
        }

        // Links
        document.querySelectorAll("a[href]").forEach((el) => {
          const a = el as HTMLAnchorElement;
          const text = truncate(a.innerText, 80);
          if (!text) return;
          elements.push({
            tag: "a",
            text,
            selector: selectorFor(a),
            href: a.href,
          });
        });

        // Buttons
        document.querySelectorAll("button, [role='button']").forEach((el) => {
          const btn = el as HTMLElement;
          const text = truncate(btn.innerText, 60);
          if (!text) return;
          const roleAttr = btn.getAttribute("role");
          const entry: (typeof elements)[number] = { tag: "button", text, selector: selectorFor(btn) };
          if (roleAttr) entry.role = roleAttr;
          elements.push(entry);
        });

        // Inputs
        document.querySelectorAll("input, textarea, select").forEach((el) => {
          const inp = el as HTMLInputElement;
          const type = inp.type ?? inp.tagName.toLowerCase();
          const ph = inp.placeholder || inp.name || type;
          const entry: (typeof elements)[number] = {
            tag: inp.tagName.toLowerCase(),
            text: ph,
            selector: selectorFor(inp),
          };
          if (inp.placeholder) entry.placeholder = inp.placeholder;
          elements.push(entry);
        });

        // Visible text (body)
        const bodyText = truncate(
          (document.body as HTMLElement).innerText,
          maxChars
        );

        return { elements, bodyText };
      },
      { maxChars: MAX_TEXT_CHARS }
    );

    const snapshot: PageSnapshot = {
      url: page.url(),
      title: await page.title(),
      elements: data.elements as SnapshotElement[],
      textContent: data.bodyText,
    };

    return ok(snapshot);
  } catch (e) {
    return err(`snapshot failed: ${String(e)}`);
  }
}

// ── Click ─────────────────────────────────────────────────────
export async function click(selector: string): Promise<ClickResult> {
  const pageResult = getPage();
  if (!pageResult.ok) return pageResult;
  const page = pageResult.data;

  try {
    await page.waitForSelector(selector, { timeout: 5_000 });
    await page.click(selector);
    return ok(undefined);
  } catch (e) {
    return err(`click("${selector}") failed: ${String(e)}`);
  }
}

// ── Type ──────────────────────────────────────────────────────
export async function typeText(
  selector: string,
  text: string,
  options: { clear?: boolean; delay?: number } = {}
): Promise<TypeResult> {
  const pageResult = getPage();
  if (!pageResult.ok) return pageResult;
  const page = pageResult.data;

  try {
    await page.waitForSelector(selector, { timeout: 5_000 });

    if (options.clear !== false) {
      // Triple-click to select all, then type replaces
      await page.click(selector, { clickCount: 3 });
    }

    await page.type(selector, text, { delay: options.delay ?? 0 });
    return ok(undefined);
  } catch (e) {
    return err(`typeText("${selector}") failed: ${String(e)}`);
  }
}

// ── Screenshot ────────────────────────────────────────────────
export async function screenshot(
  options: { fullPage?: boolean } = {}
): Promise<ScreenshotResult> {
  const pageResult = getPage();
  if (!pageResult.ok) return pageResult;
  const page = pageResult.data;

  try {
    // When encoding: "base64", Puppeteer returns a string — cast is safe here
    const raw = await page.screenshot({
      fullPage: options.fullPage !== false,
      type: "png",
    });

    const base64 = Buffer.isBuffer(raw)
      ? raw.toString("base64")
      : String(raw);

    return ok({
      base64,
      mimeType: "image/png",
      title: await page.title(),
      url: page.url(),
    });
  } catch (e) {
    return err(`screenshot failed: ${String(e)}`);
  }
}

// ── Evaluate arbitrary JS on the page (power-user / sub-agent use) ──────────
export async function evaluate<T>(
  fn: () => T
): Promise<Result<T>> {
  const pageResult = getPage();
  if (!pageResult.ok) return pageResult;
  const page = pageResult.data;

  try {
    const result = await page.evaluate(fn);
    return ok(result);
  } catch (e) {
    return err(`evaluate failed: ${String(e)}`);
  }
}

// ── Wait helpers ──────────────────────────────────────────────
export async function waitForSelector(
  selector: string,
  timeoutMs = 10_000
): Promise<Result<void>> {
  const pageResult = getPage();
  if (!pageResult.ok) return pageResult;
  const page = pageResult.data;

  try {
    await page.waitForSelector(selector, { timeout: timeoutMs });
    return ok(undefined);
  } catch (e) {
    return err(`waitForSelector("${selector}") timed out: ${String(e)}`);
  }
}

export async function waitForNavigation(
  timeoutMs = 15_000
): Promise<Result<void>> {
  const pageResult = getPage();
  if (!pageResult.ok) return pageResult;
  const page = pageResult.data;

  try {
    await page.waitForNavigation({
      waitUntil: "networkidle2",
      timeout: timeoutMs,
    });
    return ok(undefined);
  } catch (e) {
    return err(`waitForNavigation timed out: ${String(e)}`);
  }
}
