const { contextBridge, ipcRenderer } = require("electron");

/**
 * Preload script — exposes a safe IPC bridge to renderer processes.
 * contextIsolation: true ensures renderers cannot access Node.js directly.
 */
contextBridge.exposeInMainWorld("riftApi", {
  /** Receive messages from the main process */
  on(channel, callback) {
    // Whitelist allowed channels
    const allowed = [
      "orchestrator:phase-changed",
      "draft:recommendation",
      "draft:pick-locked",
      "draft:phase-update",
      "draft:finalized",
      "macro:call",
      "macro:dismiss",
      "macro:game-state",
      "spell:init",
      "spell:enemy-update",
      "tilt:score-update",
      "tilt:recommendation",
      "tilt:session-summary",
      "status:update",
      "overlay:show",
      "overlay:hide",
    ];

    if (allowed.includes(channel)) {
      ipcRenderer.on(channel, (_event, ...args) => callback(...args));
    }
  },

  /** Remove a listener */
  off(channel, callback) {
    ipcRenderer.removeListener(channel, callback);
  },

  /** Send a message to the main process */
  send(channel, ...args) {
    const allowed = [
      "settings:get",
      "settings:set",
      "session:history",
      "overlay:toggle",
    ];

    if (allowed.includes(channel)) {
      ipcRenderer.send(channel, ...args);
    }
  },

  /** Send a message and wait for a response */
  invoke(channel, ...args) {
    const allowed = [
      "settings:get",
      "session:history",
      "keys:get",
      "keys:save",
      "overlay:activate-ingame",
    ];

    if (allowed.includes(channel)) {
      return ipcRenderer.invoke(channel, ...args);
    }
    return Promise.reject(new Error(`Channel not allowed: ${channel}`));
  },
});
