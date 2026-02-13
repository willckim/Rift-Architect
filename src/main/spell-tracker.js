const { logger } = require("./utils/logger");
const { IPC_CHANNELS } = require("../shared/ipc-channels");

/**
 * Base cooldowns for summoner spells (in seconds).
 */
const SPELL_COOLDOWNS = {
  Flash: 300,
  Teleport: 360,
  Ignite: 180,
  Exhaust: 210,
  Heal: 240,
  Barrier: 180,
  Cleanse: 210,
  Ghost: 210,
  Smite: 15,
  Mark: 40,
  Clarity: 240,
};

/**
 * Ionian Boots of Lucidity — item ID in League.
 */
const IONIAN_BOOTS_ID = 3158;

/**
 * Summoner Spell Haste values.
 * Effective CD = BaseCD × 100 / (100 + Haste)
 */
const IONIAN_HASTE = 12;
const COSMIC_INSIGHT_HASTE = 18;

/**
 * SpellTracker — Monitors enemy summoner spell cooldowns in-game.
 *
 * Listens to the Live Client API for enemy champion data, detects
 * Ionian Boots and Cosmic Insight (Inspiration secondary), and sends
 * cooldown data to the spell-tracker overlay for manual timer tracking.
 */
class SpellTracker {
  /** @type {import('./integrations/riot/live-client').LiveClientAPI} */
  #liveClient;

  /** @type {import('./windows/overlay-manager').OverlayManager} */
  #overlayManager;

  /** @type {boolean} */
  #active = false;

  /** @type {boolean} */
  #initialized = false;

  /** Last snapshot of enemy data to detect item changes */
  #lastEnemyHash = "";

  /** Bound handlers for cleanup */
  #onSnapshot = null;
  #onAvailable = null;
  #onUnavailable = null;

  /**
   * @param {import('./integrations/riot/live-client').LiveClientAPI} liveClient
   * @param {import('./windows/overlay-manager').OverlayManager} overlayManager
   */
  constructor(liveClient, overlayManager) {
    this.#liveClient = liveClient;
    this.#overlayManager = overlayManager;
  }

  /**
   * Start tracking. Call when entering IN_GAME phase.
   */
  start() {
    if (this.#active) return;
    this.#active = true;
    this.#initialized = false;
    this.#lastEnemyHash = "";

    this.#onSnapshot = (data) => this.#handleSnapshot(data);
    this.#onAvailable = () => logger.info("[Spell Tracker] Live Client available.");
    this.#onUnavailable = () => {
      logger.info("[Spell Tracker] Live Client unavailable — resetting.");
      this.#initialized = false;
      this.#lastEnemyHash = "";
    };

    this.#liveClient.on("snapshot", this.#onSnapshot);
    this.#liveClient.on("available", this.#onAvailable);
    this.#liveClient.on("unavailable", this.#onUnavailable);

    logger.info("[Spell Tracker] Started.");
  }

  /**
   * Stop tracking. Call when leaving IN_GAME phase.
   */
  stop() {
    if (!this.#active) return;
    this.#active = false;
    this.#initialized = false;
    this.#lastEnemyHash = "";

    if (this.#onSnapshot) this.#liveClient.off("snapshot", this.#onSnapshot);
    if (this.#onAvailable) this.#liveClient.off("available", this.#onAvailable);
    if (this.#onUnavailable) this.#liveClient.off("unavailable", this.#onUnavailable);

    this.#onSnapshot = null;
    this.#onAvailable = null;
    this.#onUnavailable = null;

    logger.info("[Spell Tracker] Stopped.");
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /**
   * Process a game snapshot from the Live Client API.
   * @param {Object} data — allgamedata response
   */
  #handleSnapshot(data) {
    if (!data || !data.allPlayers || !data.activePlayer) return;

    const activePlayerName = data.activePlayer.summonerName;
    const allPlayers = data.allPlayers;

    // Find the active player to determine their team
    const activePlayer = allPlayers.find((p) => p.summonerName === activePlayerName);
    if (!activePlayer) return;

    const enemyTeam = activePlayer.team === "ORDER" ? "CHAOS" : "ORDER";
    const enemies = allPlayers.filter((p) => p.team === enemyTeam);

    if (enemies.length === 0) return;

    const enemyData = enemies.map((e) => this.#buildEnemyData(e));

    // Check if data has changed (item purchases, etc.)
    const hash = JSON.stringify(enemyData.map((e) => ({
      n: e.champion,
      h: e.hasIonian,
      c: e.hasCosmicInsight,
    })));

    if (!this.#initialized) {
      // First data — send full init
      this.#initialized = true;
      this.#lastEnemyHash = hash;
      this.#send(IPC_CHANNELS.SPELL_INIT, { enemies: enemyData });
      logger.info("[Spell Tracker] Initialized with enemy data", { count: enemyData.length });
    } else if (hash !== this.#lastEnemyHash) {
      // Items/runes changed — send update
      this.#lastEnemyHash = hash;
      this.#send(IPC_CHANNELS.SPELL_ENEMY_UPDATE, { enemies: enemyData });
      logger.debug("[Spell Tracker] Enemy item/rune update sent.");
    }
  }

  /**
   * Build structured data for one enemy player.
   * @param {Object} player — A player object from the Live Client API
   * @returns {Object}
   */
  #buildEnemyData(player) {
    const spell1Name = player.summonerSpells?.summonerSpellOne?.displayName || "Unknown";
    const spell2Name = player.summonerSpells?.summonerSpellTwo?.displayName || "Unknown";

    // Detect Ionian Boots
    const hasIonian = (player.items || []).some((item) => item.itemID === IONIAN_BOOTS_ID);

    // Detect Cosmic Insight — check if secondary rune tree is Inspiration
    const secondaryTree = player.runes?.secondaryRuneTree?.displayName || "";
    const hasCosmicInsight = secondaryTree.toLowerCase().includes("inspiration");

    // Calculate summoner spell haste
    let haste = 0;
    if (hasIonian) haste += IONIAN_HASTE;
    if (hasCosmicInsight) haste += COSMIC_INSIGHT_HASTE;

    const spell1Base = SPELL_COOLDOWNS[spell1Name] || 300;
    const spell2Base = SPELL_COOLDOWNS[spell2Name] || 300;

    const spell1Cd = Math.round(spell1Base * 100 / (100 + haste));
    const spell2Cd = Math.round(spell2Base * 100 / (100 + haste));

    return {
      champion: player.championName,
      spell1: { name: spell1Name, baseCd: spell1Base, adjustedCd: spell1Cd },
      spell2: { name: spell2Name, baseCd: spell2Base, adjustedCd: spell2Cd },
      hasIonian,
      hasCosmicInsight,
      haste,
    };
  }

  /**
   * Send data to the spell tracker overlay.
   * @param {string} channel
   * @param {any} data
   */
  #send(channel, data) {
    this.#overlayManager.sendToOverlay("spellTracker", channel, data);
  }
}

module.exports = { SpellTracker };
