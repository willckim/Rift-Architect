const { Tray, Menu, nativeImage, Notification, app } = require("electron");
const path = require("path");
const { logger } = require("./utils/logger");

/**
 * Creates and manages the system tray icon and context menu.
 * The app runs primarily from the tray (like Blitz.gg).
 */
class TrayManager {
  /** @type {Tray | null} */
  #tray = null;

  /** @type {Function | null} */
  #onShowDashboard = null;

  /** @type {Function | null} */
  #onShowSettings = null;

  /** @type {Function | null} */
  #onQuit = null;

  /**
   * @param {{ onShowDashboard?: Function, onShowSettings?: Function, onQuit?: Function }} callbacks
   */
  constructor(callbacks = {}) {
    this.#onShowDashboard = callbacks.onShowDashboard || null;
    this.#onShowSettings = callbacks.onShowSettings || null;
    this.#onQuit = callbacks.onQuit || null;
  }

  /**
   * Create the tray icon and initial context menu.
   */
  create() {
    // Use a simple 16x16 icon. In production this would be a real .ico/.png.
    const iconPath = path.join(__dirname, "../../resources/icon.png");
    let icon;

    try {
      icon = nativeImage.createFromPath(iconPath);
      if (icon.isEmpty()) throw new Error("empty");
    } catch {
      // Fallback: create a tiny colored square as a placeholder icon
      icon = nativeImage.createEmpty();
    }

    this.#tray = new Tray(icon);
    this.#tray.setToolTip("Rift Architect — Waiting for League Client");
    this.#rebuildMenu("Waiting for League Client...");

    logger.info("System tray created.");
  }

  /**
   * Update the status line shown in the tray menu.
   * @param {string} status
   */
  updateStatus(status) {
    if (!this.#tray) return;
    this.#tray.setToolTip(`Rift Architect — ${status}`);
    this.#rebuildMenu(status);
  }

  /**
   * Show a "key expired" alert: red tray icon + desktop notification.
   * Clicking the notification opens the .env file in the default editor.
   */
  showKeyExpired() {
    if (!this.#tray) return;

    // Turn tray icon red by creating a 16x16 red square
    const redIcon = nativeImage.createFromBuffer(
      Buffer.from(
        // 16x16 RGBA red square as raw PNG (tiny inline)
        "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKklEQVQ4y2P8z8Dwn4EIwMTAwMBArAFkA0YNGDVg1IBRA4gBTMQaAAAKpAGDtfJLpAAAAABJRU5ErkJggg==",
        "base64"
      )
    );
    this.#tray.setImage(redIcon);

    this.updateStatus("API KEY EXPIRED");

    // Desktop notification — click opens Settings window
    const notification = new Notification({
      title: "Rift Architect — Riot Key Expired",
      body: "Riot API key expired or invalid. Click to open Settings and update your key.",
      icon: redIcon,
      urgency: "critical",
    });

    notification.on("click", () => {
      if (this.#onShowSettings) this.#onShowSettings();
    });

    notification.show();
    logger.error("Riot API key expired — tray icon set to red, notification sent.");
  }

  /**
   * Restore the normal tray icon (after key is updated).
   */
  restoreIcon() {
    if (!this.#tray) return;
    const iconPath = path.join(__dirname, "../../resources/icon.png");
    try {
      const icon = nativeImage.createFromPath(iconPath);
      if (!icon.isEmpty()) this.#tray.setImage(icon);
    } catch {
      // Fallback — just leave it
    }
  }

  /**
   * Destroy the tray.
   */
  destroy() {
    if (this.#tray) {
      this.#tray.destroy();
      this.#tray = null;
    }
  }

  /**
   * Rebuild the context menu with the given status string.
   * Electron tray menus are immutable — you have to rebuild to change them.
   * @param {string} status
   */
  #rebuildMenu(status) {
    if (!this.#tray) return;

    const contextMenu = Menu.buildFromTemplate([
      { label: "Rift Architect", enabled: false },
      { type: "separator" },
      { label: `Status: ${status}`, id: "status", enabled: false },
      { type: "separator" },
      {
        label: "Open Dashboard",
        click: () => {
          if (this.#onShowDashboard) this.#onShowDashboard();
        },
      },
      {
        label: "Settings",
        click: () => {
          if (this.#onShowSettings) this.#onShowSettings();
        },
      },
      { type: "separator" },
      {
        label: "Overlays",
        submenu: [
          { label: "Draft Oracle", type: "checkbox", checked: true, id: "overlay-draft" },
          { label: "Macro Strategist", type: "checkbox", checked: true, id: "overlay-macro" },
          { label: "Tilt Guard", type: "checkbox", checked: true, id: "overlay-tilt" },
        ],
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          if (this.#onQuit) this.#onQuit();
          else app.quit();
        },
      },
    ]);

    this.#tray.setContextMenu(contextMenu);
  }
}

module.exports = { TrayManager };
