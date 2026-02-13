const https = require("https");
const { EventEmitter } = require("events");
const { logger } = require("../../utils/logger");

const BASE_URL = "https://127.0.0.1:2999/liveclientdata";

/**
 * HTTPS agent that accepts the Live Client Data API's self-signed cert.
 */
const agent = new https.Agent({ rejectUnauthorized: false });

/**
 * Live Client Data API client.
 *
 * During an active League game, the client exposes a local HTTPS API
 * at port 2999 with no authentication required. This is Agent 2's
 * primary data source.
 *
 * VANGUARD SAFETY:
 * The Live Client Data API is Riot's official read-only spectator API
 * (https://developer.riotgames.com/docs/lol#game-client-api). It is
 * designed for companion apps and does NOT require authentication.
 * Used by Blitz.gg, Porofessor, Overwolf apps, etc.
 * This client ONLY reads data — no writes, no injection, no game modification.
 *
 * ASYNC GUARANTEES:
 * All requests are fully async (Promise-based HTTPS). Polling uses
 * setInterval + async callbacks that never block the event loop.
 *
 * Events:
 *   "snapshot"   — (data: AllGameData) full game state
 *   "new-events" — (events: GameEvent[]) only events newer than last poll
 *   "available"  — () API became reachable
 *   "unavailable" — () API is no longer reachable
 */
class LiveClientAPI extends EventEmitter {
  /** @type {NodeJS.Timeout | null} */
  #snapshotTimer = null;

  /** @type {NodeJS.Timeout | null} */
  #eventTimer = null;

  /** Track highest EventID seen so we only emit new events */
  #lastEventId = -1;

  /** Whether the API was reachable on last poll */
  #wasAvailable = false;

  /**
   * Get complete game snapshot.
   * Includes: activePlayer, allPlayers, events, gameData.
   */
  async getAllGameData() {
    return this.#fetch("/allgamedata");
  }

  /**
   * Get the active player's stats (the logged-in user's champion).
   */
  async getActivePlayer() {
    return this.#fetch("/activeplayer");
  }

  /**
   * Get all 10 players in the game.
   */
  async getPlayerList() {
    return this.#fetch("/playerlist");
  }

  /**
   * Get game events (kills, objectives, turrets, etc.).
   */
  async getEventData() {
    return this.#fetch("/eventdata");
  }

  /**
   * Get basic game stats (gameMode, gameTime, mapName, mapTerrain).
   */
  async getGameStats() {
    return this.#fetch("/gamestats");
  }

  /**
   * Start polling. Emits "snapshot" and "new-events" on intervals.
   * @param {number} [snapshotMs=15000] - Full snapshot poll interval
   * @param {number} [eventMs=5000] - Event poll interval
   */
  startPolling(snapshotMs = 15000, eventMs = 5000) {
    logger.info("Live Client API: polling started", { snapshotMs, eventMs });
    this.#lastEventId = -1;

    // Snapshot polling (less frequent)
    this.#snapshotTimer = setInterval(async () => {
      try {
        const data = await this.getAllGameData();
        if (!this.#wasAvailable) {
          this.#wasAvailable = true;
          this.emit("available");
          logger.info("Live Client API is now reachable.");
        }
        this.emit("snapshot", data);
      } catch {
        if (this.#wasAvailable) {
          this.#wasAvailable = false;
          this.emit("unavailable");
          logger.info("Live Client API is no longer reachable (game may have ended).");
        }
      }
    }, snapshotMs);

    // Event polling (more frequent for timely triggers)
    this.#eventTimer = setInterval(async () => {
      try {
        const eventData = await this.getEventData();
        const allEvents = eventData.Events || [];
        const newEvents = allEvents.filter((e) => e.EventID > this.#lastEventId);

        if (newEvents.length > 0) {
          this.#lastEventId = Math.max(...newEvents.map((e) => e.EventID));
          this.emit("new-events", newEvents);
        }
      } catch {
        // Game might have ended — that's fine
      }
    }, eventMs);

    // Do an immediate first poll
    this.getAllGameData()
      .then((data) => {
        this.#wasAvailable = true;
        this.emit("available");
        this.emit("snapshot", data);
      })
      .catch(() => {
        // Not in game yet — polling will pick it up
      });
  }

  /**
   * Stop polling.
   */
  stopPolling() {
    if (this.#snapshotTimer) {
      clearInterval(this.#snapshotTimer);
      this.#snapshotTimer = null;
    }
    if (this.#eventTimer) {
      clearInterval(this.#eventTimer);
      this.#eventTimer = null;
    }
    this.#lastEventId = -1;
    this.#wasAvailable = false;
    logger.info("Live Client API: polling stopped.");
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /**
   * @param {string} endpoint
   * @returns {Promise<any>}
   */
  #fetch(endpoint) {
    return new Promise((resolve, reject) => {
      const url = new URL(`${BASE_URL}${endpoint}`);

      const req = https.get(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          agent,
          headers: {
            "User-Agent": "RiftArchitect/1.0 (companion-app)",
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            if (res.statusCode === 200) {
              try {
                resolve(JSON.parse(data));
              } catch {
                resolve(data);
              }
            } else {
              reject(new Error(`Live Client ${res.statusCode}: ${data}`));
            }
          });
        }
      );

      req.on("error", reject);
      req.setTimeout(3000, () => {
        req.destroy(new Error("Live Client API timeout"));
      });
    });
  }
}

module.exports = { LiveClientAPI };
