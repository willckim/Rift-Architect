require("dotenv").config();
const { app, BrowserWindow, ipcMain } = require("electron");
const { LCUConnector } = require("./lcu-connector");
const { RiotApiClient } = require("./riot-api-client");
const { ClaudeClient } = require("./integrations/claude/client");
const { LiveClientAPI } = require("./integrations/riot/live-client");
const { Orchestrator } = require("./orchestrator/orchestrator");
const { OverlayManager } = require("./windows/overlay-manager");
const { TrayManager } = require("./tray");
const { detectSummoner, loadChampionData, getPatchVersion } = require("./summoner-detector");
const { refreshMetaIfNeeded } = require("./data/meta-scraper");
const { SpellTracker } = require("./spell-tracker");
const { initDatabase, closeDatabase, queries } = require("./data/db");
const { initKeyStore, getAllKeys, setKey } = require("./key-store");
const { logger } = require("./utils/logger");

let tray;
let orchestrator;
let overlayManager;
let tabHookStarted = false;

app.whenReady().then(async () => {
  logger.info("Rift Architect starting...");

  // 0a. Initialize persistent key store (must happen before clients)
  initKeyStore();

  // 0b. Load champion data from Data Dragon (for mastery name resolution)
  await loadChampionData();

  // 1. Initialize SQLite database
  initDatabase();

  // 1b. Fire-and-forget meta data refresh (non-blocking)
  refreshMetaIfNeeded(getPatchVersion()).catch((err) => {
    logger.warn("Meta scraper startup refresh failed (non-fatal)", { error: err.message });
  });

  // 2. Create overlay manager (creates windows but keeps them hidden)
  overlayManager = new OverlayManager();
  overlayManager.createMainWindow();
  overlayManager.createSettingsWindow();
  overlayManager.createAll();

  // 3. Create system tray
  tray = new TrayManager({
    onShowDashboard: () => overlayManager.showMainWindow(),
    onShowSettings: () => overlayManager.showSettingsWindow(),
    onQuit: () => {
      orchestrator.shutdown();
      closeDatabase();
      app.exit(0);
    },
  });
  tray.create();

  // 4. Create LCU connector, Riot API client, Claude client, and Live Client API
  const lcuConnector = new LCUConnector();
  const riotApi = new RiotApiClient();
  const claudeClient = new ClaudeClient();
  const liveClient = new LiveClientAPI();

  // 5. Wire up Summoner Detector — runs on every LCU connect
  lcuConnector.on("connected", async (session) => {
    logger.info("LCU session established. Running Summoner Detector...");
    try {
      await detectSummoner(lcuConnector, riotApi);
    } catch (err) {
      logger.error("Summoner Detector failed", { error: err.message });
    }
  });

  // 5b. Global 403 handler — red tray, notification, open Settings window
  riotApi.on("key-expired", () => {
    logger.error("Global 403: Riot API key expired — pausing all agents.");
    tray.showKeyExpired();
    if (orchestrator) orchestrator.pauseAgents();
    overlayManager.sendToMain("status:update", "API KEY EXPIRED — open Settings to update");
    overlayManager.showSettingsWindow();
  });

  // 5c. Global 429 handler — pause agents for 2 minutes, show "Rate Limited" in tray
  riotApi.on("rate-limited", ({ retryAfterMs }) => {
    const pauseMs = Math.max(retryAfterMs || 120000, 120000); // At least 2 minutes
    logger.warn("Global 429: Rate limited — pausing agents.", { pauseMs });
    tray.updateStatus("Rate Limited — pausing 2 min...");
    if (orchestrator) orchestrator.pauseAgents();

    setTimeout(() => {
      logger.info("Rate limit pause ended — resuming agents.");
      tray.updateStatus("Resuming after rate limit...");
      if (orchestrator) orchestrator.resumeAgents();
    }, pauseMs);
  });

  // 6. Register IPC handlers for API key management
  ipcMain.handle("keys:get", () => {
    return getAllKeys();
  });

  ipcMain.handle("keys:save", (_event, keys) => {
    if (keys.RIOT_API_KEY !== undefined) setKey("RIOT_API_KEY", keys.RIOT_API_KEY);
    if (keys.ANTHROPIC_API_KEY !== undefined) setKey("ANTHROPIC_API_KEY", keys.ANTHROPIC_API_KEY);
    if (keys.RIOT_REGION !== undefined) setKey("RIOT_REGION", keys.RIOT_REGION);
    if (keys.RIOT_ROUTING !== undefined) setKey("RIOT_ROUTING", keys.RIOT_ROUTING);

    // Hot-reload the Riot API key and clear cached 401/403 error states
    riotApi.reloadKey();
    tray.restoreIcon();
    tray.updateStatus("Keys updated — waiting 5s for propagation...");

    // 5-second delay allows Riot's servers to propagate the new Production key
    // before the first API call, avoiding immediate re-expiry
    setTimeout(() => {
      if (orchestrator) {
        // Pause then resume: forces Drafting Oracle to re-verify its connection
        orchestrator.pauseAgents();
        orchestrator.resumeAgents();
      }
      tray.updateStatus("Keys propagated — agents resumed.");
      logger.info("Key propagation delay complete — agents resumed.");
    }, 5000);

    // Force meta scraper re-validation with the (potentially new) production key
    queries.setSetting("last_meta_patch", "");
    refreshMetaIfNeeded(getPatchVersion()).catch((err) => {
      logger.warn("Meta scraper re-validation after key save failed (non-fatal)", { error: err.message });
    });

    logger.info("API keys saved via Settings UI.");
  });

  // 7. Register IPC handlers for settings
  ipcMain.handle("settings:get", (_event, key) => {
    return queries.getSetting(key);
  });

  ipcMain.on("settings:set", (_event, key, value) => {
    queries.setSetting(key, value);
    logger.info("Setting updated", { key, value });

    // Handle auto-launch toggle
    if (key === "auto_launch") {
      app.setLoginItemSettings({
        openAtLogin: value === "true",
        name: "Rift Architect",
      });
    }
  });

  ipcMain.on("overlay:toggle", (_event, overlayName) => {
    const key = `overlay_${overlayName}_enabled`;
    const current = queries.getSetting(key);
    const newValue = current === "false" ? "true" : "false";
    queries.setSetting(key, newValue);
    logger.info("Overlay toggled", { overlay: overlayName, enabled: newValue });
  });

  ipcMain.handle("session:history", () => {
    return queries.getRecentMatches(20);
  });

  // 8. Apply auto-launch setting (defaults to enabled on first run)
  const autoLaunch = queries.getSetting("auto_launch");
  const shouldAutoLaunch = autoLaunch === null ? true : autoLaunch === "true";
  app.setLoginItemSettings({
    openAtLogin: shouldAutoLaunch,
    name: "Rift Architect",
  });
  if (autoLaunch === null) {
    queries.setSetting("auto_launch", "true");
  }

  // 9. Create and start orchestrator (with all agent dependencies)
  orchestrator = new Orchestrator({
    lcuConnector,
    overlayManager,
    claudeClient,
    riotApi,
    liveClient,
  });
  orchestrator.setTrayStatusUpdater((status) => tray.updateStatus(status));
  orchestrator.start();

  // 10. Create spell tracker and wire to orchestrator lifecycle
  const spellTracker = new SpellTracker(liveClient, overlayManager);
  orchestrator.eventBus.subscribe("phase:changed", ({ from, to }) => {
    if (to === "IN_GAME") {
      spellTracker.start();
    } else if (from === "IN_GAME") {
      spellTracker.stop();
    }
  });

  // 11. Tab Scoreboard Toggle (Blitz Logic)
  //     Uses uiohook-napi for passive Tab key detection — does NOT consume
  //     the key, so League's scoreboard still opens normally.
  let inGamePhase = false;
  let tabHeld = false;

  try {
    const { uIOhook, UiohookKey } = require("uiohook-napi");

    uIOhook.on("keydown", (e) => {
      if (e.keycode === UiohookKey.Tab && inGamePhase && !tabHeld) {
        tabHeld = true;
        overlayManager.setAlwaysOnTopLevel("spellTracker", "screen-saver");
        overlayManager.show("spellTracker");
        overlayManager.setClickThrough("spellTracker", false);
        logger.debug("Tab held — spell tracker shown (screen-saver level).");
      }
    });

    uIOhook.on("keyup", (e) => {
      if (e.keycode === UiohookKey.Tab && inGamePhase && tabHeld) {
        tabHeld = false;
        overlayManager.saveOverlayPosition("spellTracker");
        overlayManager.setClickThrough("spellTracker", true);
        overlayManager.hide("spellTracker");
        overlayManager.setAlwaysOnTopLevel("spellTracker", "floating");
        logger.debug("Tab released — spell tracker hidden.");
      }
    });

    uIOhook.start();
    tabHookStarted = true;
    logger.info("Tab keyboard hook started (uiohook-napi).");
  } catch (err) {
    logger.warn("uiohook-napi unavailable — Tab toggle disabled.", { error: err.message });
  }

  orchestrator.eventBus.subscribe("phase:changed", ({ from, to }) => {
    if (to === "IN_GAME") {
      inGamePhase = true;
      // Spell tracker starts hidden; Tab reveals it
      overlayManager.setClickThrough("spellTracker", true);
    } else if (from === "IN_GAME") {
      inGamePhase = false;
      tabHeld = false;
      overlayManager.hide("spellTracker");
    }
  });

  // 12. IPC handler: manual in-game overlay activation from main window
  ipcMain.handle("overlay:activate-ingame", async () => {
    try {
      const snapshot = await liveClient.getAllGameData();
      const alive = !!snapshot;
      if (alive) {
        overlayManager.show("spellTracker");
        overlayManager.show("macro");
        spellTracker.start();
        logger.info("In-game overlay manually activated from dashboard.");
      }
      return { success: alive, message: alive ? "Overlay activated" : "Live Client API not available (game not running?)" };
    } catch (err) {
      logger.warn("Manual overlay activation failed", { error: err.message });
      return { success: false, message: `Live Client API unreachable: ${err.message}` };
    }
  });

  logger.info("Rift Architect ready. Watching for League client...");
});

// Keep app running when all windows are closed (tray app behavior)
app.on("window-all-closed", (e) => {
  e.preventDefault();
});

app.on("before-quit", () => {
  if (tabHookStarted) {
    try { require("uiohook-napi").uIOhook.stop(); } catch { /* already stopped */ }
  }
  if (orchestrator) orchestrator.shutdown();
  closeDatabase();
  if (tray) tray.destroy();
});
