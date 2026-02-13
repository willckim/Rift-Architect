const { BrowserWindow, screen } = require("electron");
const path = require("path");
const Store = require("electron-store");
const { logger } = require("../utils/logger");
const { IPC_CHANNELS } = require("../../shared/ipc-channels");

const positionStore = new Store({ name: "overlay-positions" });

/**
 * Per-overlay configuration.
 * @typedef {Object} OverlayConfig
 * @property {string} id
 * @property {string} htmlFile       - Relative path from project root to the HTML file
 * @property {number} width
 * @property {number} height
 * @property {"top-left"|"top-right"|"bottom-left"|"bottom-right"|"center-right"} anchor
 * @property {number} offsetX
 * @property {number} offsetY
 * @property {boolean} clickThrough  - If true, mouse events pass through to the app below
 */

/** @type {Record<string, OverlayConfig>} */
const OVERLAY_CONFIGS = {
  draft: {
    id: "draft-overlay",
    htmlFile: "src/renderer/draft-overlay/index.html",
    width: 340,
    height: 580,
    anchor: "center-right",
    offsetX: -20,
    offsetY: 0,
    clickThrough: false, // User interacts with draft recommendations
  },
  macro: {
    id: "macro-overlay",
    htmlFile: "src/renderer/macro-overlay/index.html",
    width: 380,
    height: 120,
    anchor: "top-right",
    offsetX: -20,
    offsetY: 100,
    clickThrough: true, // Toasts must not block gameplay clicks
  },
  spellTracker: {
    id: "spell-tracker-overlay",
    htmlFile: "src/renderer/spell-tracker/index.html",
    width: 250,
    height: 400,
    anchor: "top-right",
    offsetX: -50,    // screenW - 250 + (-50) = screenW - 300
    offsetY: 20,
    clickThrough: false, // Interactive when Tab is held
  },
  tilt: {
    id: "tilt-overlay",
    htmlFile: "src/renderer/tilt-overlay/index.html",
    width: 400,
    height: 500,
    anchor: "center-right",
    offsetX: -20,
    offsetY: 0,
    clickThrough: false, // User interacts with cooldown routine
  },
};

/**
 * Manages overlay BrowserWindows for each agent.
 * Creates all windows at startup (hidden), then shows/hides as needed.
 */
class OverlayManager {
  /** @type {Map<string, BrowserWindow>} */
  #windows = new Map();

  /** @type {BrowserWindow | null} */
  #mainWindow = null;

  /** @type {BrowserWindow | null} */
  #settingsWindow = null;

  /**
   * Create all overlay windows (hidden by default).
   */
  createAll() {
    for (const [name, config] of Object.entries(OVERLAY_CONFIGS)) {
      const win = this.#createOverlayWindow(config);
      this.#windows.set(name, win);
      logger.info("Overlay window created", { overlay: name, id: config.id });
    }
  }

  /**
   * Create the main dashboard window (hidden by default).
   */
  createMainWindow() {
    this.#mainWindow = new BrowserWindow({
      width: 800,
      height: 600,
      show: false,
      title: "Rift Architect",
      webPreferences: {
        preload: path.join(__dirname, "../preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    this.#mainWindow.loadFile(
      path.join(__dirname, "../../../src/renderer/main-window/index.html")
    );

    this.#mainWindow.on("close", (e) => {
      // Hide instead of close — tray app behavior
      e.preventDefault();
      this.#mainWindow.hide();
    });

    logger.info("Main dashboard window created.");
  }

  /**
   * Show the main dashboard window.
   */
  showMainWindow() {
    if (this.#mainWindow) {
      this.#mainWindow.show();
      this.#mainWindow.focus();
    }
  }

  /**
   * Create the Settings window (hidden by default).
   * Called once at startup; shown/hidden via tray or 403 handler.
   */
  createSettingsWindow() {
    this.#settingsWindow = new BrowserWindow({
      width: 480,
      height: 460,
      show: false,
      title: "Rift Architect — Settings",
      resizable: false,
      minimizable: false,
      maximizable: false,
      webPreferences: {
        preload: path.join(__dirname, "../preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    this.#settingsWindow.loadFile(
      path.join(__dirname, "../../../src/renderer/settings-window/index.html")
    );

    this.#settingsWindow.setMenuBarVisibility(false);

    this.#settingsWindow.on("close", (e) => {
      e.preventDefault();
      this.#settingsWindow.hide();
    });

    logger.info("Settings window created.");
  }

  /**
   * Show the Settings window (creates it if not yet created).
   */
  showSettingsWindow() {
    if (!this.#settingsWindow || this.#settingsWindow.isDestroyed()) {
      this.createSettingsWindow();
    }
    this.#settingsWindow.show();
    this.#settingsWindow.focus();
  }

  /**
   * Show an overlay by name.
   * @param {string} name - "draft" | "macro" | "tilt"
   */
  show(name) {
    const win = this.#windows.get(name);
    if (win && !win.isDestroyed()) {
      win.showInactive(); // Show without stealing focus from the game
      logger.info("Overlay shown", { overlay: name });
    }
  }

  /**
   * Hide an overlay by name.
   * @param {string} name
   */
  hide(name) {
    const win = this.#windows.get(name);
    if (win && !win.isDestroyed()) {
      win.hide();
      logger.info("Overlay hidden", { overlay: name });
    }
  }

  /**
   * Hide all overlays.
   */
  hideAll() {
    for (const [name, win] of this.#windows) {
      if (!win.isDestroyed()) {
        win.hide();
      }
    }
    logger.info("All overlays hidden.");
  }

  /**
   * Send a game phase change to all overlay renderers and the main window.
   * @param {string} phase
   */
  broadcastPhaseChange(phase) {
    for (const [, win] of this.#windows) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.GAME_PHASE_CHANGED, phase);
      }
    }
    if (this.#mainWindow && !this.#mainWindow.isDestroyed()) {
      this.#mainWindow.webContents.send(IPC_CHANNELS.GAME_PHASE_CHANGED, phase);
    }
  }

  /**
   * Send a message to a specific overlay.
   * @param {string} name
   * @param {string} channel
   * @param {any} data
   */
  sendToOverlay(name, channel, data) {
    const win = this.#windows.get(name);
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, data);
    }
  }

  /**
   * Send a message to the main dashboard window.
   * @param {string} channel
   * @param {any} data
   */
  sendToMain(channel, data) {
    if (this.#mainWindow && !this.#mainWindow.isDestroyed()) {
      this.#mainWindow.webContents.send(channel, data);
    }
  }

  /**
   * Toggle click-through on an overlay window.
   * @param {string} name
   * @param {boolean} clickThrough — true = mouse events pass through
   */
  setClickThrough(name, clickThrough) {
    const win = this.#windows.get(name);
    if (win && !win.isDestroyed()) {
      win.setIgnoreMouseEvents(clickThrough, { forward: true });
    }
  }

  /**
   * Set the always-on-top level for an overlay window.
   * "screen-saver" sits above even fullscreen apps on some configs.
   * @param {string} name
   * @param {"normal"|"floating"|"screen-saver"} level
   */
  setAlwaysOnTopLevel(name, level) {
    const win = this.#windows.get(name);
    if (win && !win.isDestroyed()) {
      win.setAlwaysOnTop(true, level);
    }
  }

  /**
   * Force-save the current position of an overlay window.
   * @param {string} name
   */
  saveOverlayPosition(name) {
    const config = OVERLAY_CONFIGS[name];
    const win = this.#windows.get(name);
    if (win && !win.isDestroyed() && config) {
      const [x, y] = win.getPosition();
      this.#savePosition(config.id, x, y);
    }
  }

  /**
   * Destroy all windows on shutdown.
   */
  destroyAll() {
    for (const [, win] of this.#windows) {
      if (!win.isDestroyed()) win.destroy();
    }
    this.#windows.clear();
    if (this.#mainWindow && !this.#mainWindow.isDestroyed()) {
      this.#mainWindow.destroy();
    }
    if (this.#settingsWindow && !this.#settingsWindow.isDestroyed()) {
      this.#settingsWindow.destroy();
    }
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /**
   * Check if a point [x, y] is visible on any connected display.
   * Returns true if at least part of the window would be on-screen.
   * @param {number} x
   * @param {number} y
   * @param {number} width
   * @param {number} height
   * @returns {boolean}
   */
  #isPositionOnScreen(x, y, width, height) {
    const displays = screen.getAllDisplays();
    for (const display of displays) {
      const { x: dx, y: dy, width: dw, height: dh } = display.bounds;
      // Check if at least 50px of the window overlaps this display
      if (
        x + width > dx + 50 &&
        x < dx + dw - 50 &&
        y + height > dy + 50 &&
        y < dy + dh - 50
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get saved position for an overlay, or null if none saved / off-screen.
   * @param {OverlayConfig} config
   * @returns {{ x: number, y: number } | null}
   */
  #getSavedPosition(config) {
    const saved = positionStore.get(`overlay.${config.id}`);
    if (!saved || typeof saved.x !== "number" || typeof saved.y !== "number") {
      return null;
    }

    // Safety reconciliation: ensure the saved position is on a connected monitor
    if (!this.#isPositionOnScreen(saved.x, saved.y, config.width, config.height)) {
      logger.warn("Saved overlay position is off-screen — resetting to default", {
        overlay: config.id,
        saved,
      });
      positionStore.delete(`overlay.${config.id}`);
      return null;
    }

    return { x: saved.x, y: saved.y };
  }

  /**
   * Save the overlay window position.
   * @param {string} overlayId
   * @param {number} x
   * @param {number} y
   */
  #savePosition(overlayId, x, y) {
    positionStore.set(`overlay.${overlayId}`, { x, y });
  }

  /**
   * Calculate screen position from anchor + offset.
   * @param {OverlayConfig} config
   * @returns {{ x: number, y: number }}
   */
  #calculatePosition(config) {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width: screenW, height: screenH } = primaryDisplay.workAreaSize;

    let x = 0;
    let y = 0;

    switch (config.anchor) {
      case "top-left":
        x = config.offsetX;
        y = config.offsetY;
        break;
      case "top-right":
        x = screenW - config.width + config.offsetX;
        y = config.offsetY;
        break;
      case "bottom-left":
        x = config.offsetX;
        y = screenH - config.height + config.offsetY;
        break;
      case "bottom-right":
        x = screenW - config.width + config.offsetX;
        y = screenH - config.height + config.offsetY;
        break;
      case "center-right":
        x = screenW - config.width + config.offsetX;
        y = Math.floor((screenH - config.height) / 2) + config.offsetY;
        break;
    }

    return { x, y };
  }

  /**
   * Create a single overlay BrowserWindow.
   * @param {OverlayConfig} config
   * @returns {BrowserWindow}
   */
  #createOverlayWindow(config) {
    // Try restored position first, fall back to default anchor position
    const saved = this.#getSavedPosition(config);
    const { x, y } = saved || this.#calculatePosition(config);

    const overlay = new BrowserWindow({
      x,
      y,
      width: config.width,
      height: config.height,
      show: false,            // Hidden until the orchestrator tells us to show
      frame: false,           // No window chrome
      transparent: true,      // Transparent background
      alwaysOnTop: true,      // Sits above League client
      skipTaskbar: true,      // Not in taskbar
      resizable: false,
      movable: true,          // Allow dragging via -webkit-app-region: drag
      focusable: !config.clickThrough,
      webPreferences: {
        preload: path.join(__dirname, "../preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    // Click-through: mouse events pass to the window underneath
    if (config.clickThrough) {
      overlay.setIgnoreMouseEvents(true, { forward: true });
    }

    // Persist position when the user finishes dragging
    let moveDebounce = null;
    overlay.on("move", () => {
      if (moveDebounce) clearTimeout(moveDebounce);
      moveDebounce = setTimeout(() => {
        if (!overlay.isDestroyed()) {
          const [nx, ny] = overlay.getPosition();
          this.#savePosition(config.id, nx, ny);
        }
      }, 300);
    });

    overlay.loadFile(
      path.join(__dirname, "../../../", config.htmlFile)
    );

    if (saved) {
      logger.info("Overlay restored to saved position", { overlay: config.id, x: saved.x, y: saved.y });
    }

    return overlay;
  }
}

module.exports = { OverlayManager, OVERLAY_CONFIGS };
