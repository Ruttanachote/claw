import { Tray, Menu, nativeImage, app } from "electron";
import path from "path";
import type { BrowserWindow } from "electron";

let _tray: Tray | null = null;

export function createTray(popupWindow: BrowserWindow): Tray {
  const iconPath = path.join(__dirname, "../assets/tray-icon.png");
  const icon = nativeImage.createFromPath(iconPath);

  // On macOS, template images auto-adapt to dark/light mode
  icon.setTemplateImage(process.platform === "darwin");

  _tray = new Tray(icon);
  _tray.setToolTip("Claw — Personal AI Agent");

  buildContextMenu(_tray, popupWindow);

  // Primary click → toggle popup
  _tray.on("click", () => {
    togglePopup(popupWindow);
  });

  return _tray;
}

function buildContextMenu(tray: Tray, popupWindow: BrowserWindow): void {
  const menu = Menu.buildFromTemplate([
    {
      label: "Open Claw",
      click: () => togglePopup(popupWindow),
    },
    { type: "separator" },
    {
      label: "Quit",
      accelerator: "CmdOrCtrl+Q",
      click: () => app.quit(),
    },
  ]);
  tray.setContextMenu(menu);
}

export function togglePopup(win: BrowserWindow): void {
  if (win.isVisible()) {
    win.hide();
  } else {
    positionNearTray(win);
    win.show();
    win.focus();
  }
}

function positionNearTray(win: BrowserWindow): void {
  if (!_tray) return;

  const trayBounds = _tray.getBounds();
  const winBounds  = win.getBounds();

  // Centre horizontally on tray icon
  const x = Math.round(trayBounds.x + trayBounds.width / 2 - winBounds.width / 2);

  // Position above tray on Windows/Linux, below on macOS
  const y =
    process.platform === "darwin"
      ? Math.round(trayBounds.y + trayBounds.height + 4)
      : Math.round(trayBounds.y - winBounds.height - 4);

  win.setPosition(x, y, false);
}
