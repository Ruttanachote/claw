import { BrowserWindow, screen } from "electron";
import path from "path";

export function createPopupWindow(): BrowserWindow {
  const preloadPath = path.join(__dirname, "preload.js");

  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    show: false,
    frame: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: false,
    hasShadow: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,    // mandatory for security
      nodeIntegration: false,    // never expose Node to renderer
      sandbox: false,            // preload needs access to ipcRenderer
    },
  });

  // Hide when user clicks outside (blur)
  win.on("blur", () => {
    // Small delay so clicks on tray icon don't immediately re-hide
    setTimeout(() => {
      if (!win.isDestroyed() && !win.isFocused()) {
        win.hide();
      }
    }, 150);
  });

  // Load renderer
  if (process.env["CLAW_DEV"] === "1") {
    // Vite dev server
    void win.loadURL("http://localhost:5173");
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    void win.loadFile(
      path.join(__dirname, "../../renderer/dist/index.html")
    );
  }

  return win;
}

/** Send a progress event to the renderer (non-blocking). */
export function sendProgress(
  win: BrowserWindow,
  step: string,
  message: string
): void {
  if (!win.isDestroyed()) {
    win.webContents.send("agent:progress", { step, message });
  }
}
