const { EventEmitter } = require("events");
const { exec } = require("child_process");
const fs = require("fs/promises");
const path = require("path");
const https = require("https");
const WebSocket = require("ws");
const { logger } = require("./utils/logger");

/**
 * @typedef {Object} LCUCredentials
 * @property {number} processId
 * @property {number} port
 * @property {string} password
 * @property {"https"} protocol
 */

/**
 * @typedef {Object} LCUSession
 * @property {number} processId
 * @property {number} port
 * @property {string} password
 * @property {"https"} protocol
 * @property {string} authHeader    - Precomputed "Basic ..." header value
 * @property {string} baseUrl       - "https://127.0.0.1:{port}"
 * @property {boolean} ready        - True once lockfile is parsed and REST is reachable
 */

/**
 * LCU Connector — Detects the League client process, parses the lockfile
 * for credentials, connects via WebSocket for real-time events, and
 * provides an authenticated REST client for LCU API calls.
 *
 * VANGUARD SAFETY:
 * This connector uses ONLY the official LCU lockfile-based authentication
 * pattern used by all Riot-approved companion apps (Blitz.gg, Porofessor,
 * Mobalytics, U.GG Desktop). It does NOT:
 *   - Inject code into the League client process
 *   - Read game memory or modify game files
 *   - Automate any in-game actions
 *   - Interfere with Vanguard's kernel-level anti-cheat
 *
 * ALL operations are fully asynchronous to avoid blocking the main
 * Electron thread (which could cause frame drops and look suspicious
 * to anti-cheat heuristics).
 *
 * Events:
 *   "connected"              — (session: LCUSession)
 *   "disconnected"           — ()
 *   "websocket-connected"    — ()
 *   "websocket-disconnected" — ()
 *   "lcu-event"              — (event: { uri, data, eventType })
 *   "phase-changed"          — (phase: string)  e.g. "ChampSelect", "InProgress"
 */
class LCUConnector extends EventEmitter {
  /** @type {LCUCredentials | null} */
  #credentials = null;

  /** @type {NodeJS.Timeout | null} */
  #pollInterval = null;

  /** @type {WebSocket | null} */
  #ws = null;

  /** @type {boolean} */
  #wsConnecting = false;

  /** Whether a poll is already in flight (prevents overlap) */
  #polling = false;

  /** HTTPS agent that accepts the LCU self-signed certificate */
  #httpsAgent = new https.Agent({ rejectUnauthorized: false });

  /** Polling interval in ms */
  #POLL_MS = 3000;

  /**
   * Start watching for the League client process.
   * All detection runs asynchronously — never blocks the main thread.
   */
  start() {
    logger.info("LCU Connector starting — polling for League client...");
    this.#poll();
    this.#pollInterval = setInterval(() => this.#poll(), this.#POLL_MS);
  }

  /**
   * Stop watching and tear down connections.
   */
  shutdown() {
    if (this.#pollInterval) {
      clearInterval(this.#pollInterval);
      this.#pollInterval = null;
    }
    if (this.#ws) {
      this.#ws.close();
      this.#ws = null;
    }
    this.#credentials = null;
    logger.info("LCU Connector shut down.");
  }

  /**
   * Get current credentials (null if not connected).
   * @returns {LCUCredentials | null}
   */
  getCredentials() {
    return this.#credentials;
  }

  /**
   * Get a structured session object (null if not connected).
   * @returns {LCUSession | null}
   */
  getSession() {
    if (!this.#credentials) return null;
    return this.#buildSession(this.#credentials);
  }

  /**
   * Whether we currently have a connection to the League client.
   * @returns {boolean}
   */
  isConnected() {
    return this.#credentials !== null;
  }

  // ---------------------------------------------------------------------------
  // REST client — authenticated requests to the LCU API
  // ---------------------------------------------------------------------------

  /**
   * Make an authenticated HTTPS request to the LCU REST API.
   * Fully asynchronous — returns a Promise, never blocks.
   *
   * @param {string} method - HTTP method (GET, POST, PUT, PATCH, DELETE)
   * @param {string} endpoint - API path, e.g. "/lol-gameflow/v1/gameflow-phase"
   * @param {any} [body] - Optional JSON body for POST/PUT/PATCH
   * @returns {Promise<any>}
   */
  request(method, endpoint, body) {
    if (!this.#credentials) {
      return Promise.reject(new Error("Not connected to League client"));
    }

    const { port, password } = this.#credentials;
    const auth = Buffer.from(`riot:${password}`).toString("base64");

    return new Promise((resolve, reject) => {
      const options = {
        hostname: "127.0.0.1",
        port,
        path: endpoint,
        method,
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        agent: this.#httpsAgent,
      };

      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(data ? JSON.parse(data) : null);
            } catch {
              resolve(data);
            }
          } else {
            reject(new Error(`LCU ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on("error", reject);
      req.setTimeout(5000, () => {
        req.destroy(new Error("LCU request timeout"));
      });

      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  /**
   * Get current game phase directly via REST.
   * @returns {Promise<string>}
   */
  async getCurrentPhase() {
    return this.request("GET", "/lol-gameflow/v1/gameflow-phase");
  }

  /**
   * Get champ select session data.
   * @returns {Promise<any>}
   */
  async getChampSelectSession() {
    return this.request("GET", "/lol-champ-select/v1/session");
  }

  /**
   * Get end-of-game stats.
   * @returns {Promise<any>}
   */
  async getEndOfGameStats() {
    return this.request("GET", "/lol-end-of-game/v1/eog-stats-block");
  }

  /**
   * Get current summoner info.
   * @returns {Promise<any>}
   */
  async getCurrentSummoner() {
    return this.request("GET", "/lol-summoner/v1/current-summoner");
  }

  // ---------------------------------------------------------------------------
  // Private — FULLY ASYNC polling & process detection
  // ---------------------------------------------------------------------------

  async #poll() {
    // Prevent overlapping polls
    if (this.#polling) return;
    this.#polling = true;

    try {
      const lockfilePath = await this.#findLockfile();

      if (lockfilePath && !this.#credentials) {
        const creds = await this.#parseLockfile(lockfilePath);
        if (creds) {
          this.#credentials = creds;
          const session = this.#buildSession(creds);

          logger.info("League client detected!", {
            pid: session.processId,
            port: session.port,
            baseUrl: session.baseUrl,
          });

          this.emit("connected", session);
          this.#connectWebSocket();
        }
      } else if (!lockfilePath && this.#credentials) {
        logger.info("League client disconnected.");
        this.#credentials = null;
        if (this.#ws) {
          this.#ws.close();
          this.#ws = null;
        }
        this.emit("disconnected");
      }
    } catch (err) {
      logger.debug("LCU poll error (non-fatal)", { error: err.message });
    } finally {
      this.#polling = false;
    }
  }

  /**
   * Build a LCUSession from raw credentials.
   * @param {LCUCredentials} creds
   * @returns {LCUSession}
   */
  #buildSession(creds) {
    return {
      processId: creds.processId,
      port: creds.port,
      password: creds.password,
      protocol: creds.protocol,
      authHeader: `Basic ${Buffer.from(`riot:${creds.password}`).toString("base64")}`,
      baseUrl: `https://127.0.0.1:${creds.port}`,
      ready: true,
    };
  }

  /**
   * Find the League client lockfile — FULLY ASYNC.
   *
   * Strategy 1: Parse the running process command line for --install-directory.
   *   Windows: wmic (async exec)
   *   macOS:   ps aux (async exec)
   *
   * Strategy 2: Check well-known default install paths.
   *
   * @returns {Promise<string | null>}
   */
  async #findLockfile() {
    // --- Strategy 1: Async process detection ---
    try {
      const installDir = await this.#detectProcessInstallDir();
      if (installDir) {
        const lockfile = path.join(installDir, "lockfile");
        if (await fileExists(lockfile)) return lockfile;
      }
    } catch {
      // Process not running — expected when the client isn't open.
    }

    // --- Strategy 2: Default install paths (async stat checks) ---
    const defaultPaths =
      process.platform === "win32"
        ? [
            "C:\\Riot Games\\League of Legends\\lockfile",
            "D:\\Riot Games\\League of Legends\\lockfile",
            "C:\\Program Files\\Riot Games\\League of Legends\\lockfile",
            "C:\\Program Files (x86)\\Riot Games\\League of Legends\\lockfile",
          ]
        : ["/Applications/League of Legends.app/Contents/LoL/lockfile"];

    for (const p of defaultPaths) {
      if (await fileExists(p)) return p;
    }

    return null;
  }

  /**
   * Detect League client install directory from running process.
   * Uses async child_process.exec — never blocks the main thread.
   *
   * @returns {Promise<string | null>}
   */
  #detectProcessInstallDir() {
    return new Promise((resolve) => {
      if (process.platform === "win32") {
        exec(
          'wmic PROCESS WHERE name="LeagueClientUx.exe" GET commandline 2>nul',
          { timeout: 5000, windowsHide: true },
          (err, stdout) => {
            if (err || !stdout) return resolve(null);
            const match = stdout.match(
              /--install-directory=(?:"([^"]+)"|([^\s]+))/
            );
            resolve(match ? (match[1] || match[2]) : null);
          }
        );
      } else if (process.platform === "darwin") {
        exec(
          "ps aux | grep LeagueClientUx | grep -v grep",
          { timeout: 5000 },
          (err, stdout) => {
            if (err || !stdout) return resolve(null);
            const match = stdout.match(/--install-directory=([^\s]+)/);
            resolve(match ? match[1] : null);
          }
        );
      } else {
        resolve(null);
      }
    });
  }

  /**
   * Parse the LCU lockfile — ASYNC.
   * Format: LeagueClient:{pid}:{port}:{password}:{protocol}
   *
   * @param {string} filepath
   * @returns {Promise<LCUCredentials | null>}
   */
  async #parseLockfile(filepath) {
    try {
      const content = await fs.readFile(filepath, "utf-8");
      const parts = content.split(":");

      if (parts.length < 5) {
        logger.error(`Lockfile unexpected format (${parts.length} parts)`, {
          content,
        });
        return null;
      }

      return {
        processId: parseInt(parts[1], 10),
        port: parseInt(parts[2], 10),
        password: parts[3],
        protocol: "https",
      };
    } catch (err) {
      logger.error("Failed to read lockfile", { error: err.message });
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private — WebSocket (WAMP protocol for real-time LCU events)
  // ---------------------------------------------------------------------------

  #connectWebSocket() {
    if (!this.#credentials || this.#wsConnecting) return;

    const { port, password } = this.#credentials;
    const auth = Buffer.from(`riot:${password}`).toString("base64");
    const url = `wss://127.0.0.1:${port}/`;

    this.#wsConnecting = true;

    const ws = new WebSocket(url, {
      headers: { Authorization: `Basic ${auth}` },
      rejectUnauthorized: false, // Self-signed cert
    });

    ws.on("open", () => {
      this.#wsConnecting = false;
      logger.info("LCU WebSocket connected.");

      // Subscribe to all events (WAMP subscribe message: [5, "topic"])
      ws.send(JSON.stringify([5, "OnJsonApiEvent"]));
      this.emit("websocket-connected");
    });

    ws.on("message", (raw) => {
      try {
        const message = JSON.parse(raw.toString());

        // WAMP event format: [8, "OnJsonApiEvent", { uri, data, eventType }]
        if (message[0] === 8 && message[2]) {
          const event = message[2];
          this.emit("lcu-event", event);

          // Specifically emit game phase changes for the orchestrator
          if (event.uri === "/lol-gameflow/v1/gameflow-phase") {
            logger.info("Game phase changed (WebSocket)", {
              phase: event.data,
            });
            this.emit("phase-changed", event.data);
          }
        }
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on("error", (err) => {
      this.#wsConnecting = false;
      logger.error("LCU WebSocket error", { error: err.message });
    });

    ws.on("close", () => {
      this.#wsConnecting = false;
      this.#ws = null;
      logger.info("LCU WebSocket disconnected.");
      this.emit("websocket-disconnected");

      // Auto-reconnect if we still have credentials (client is still running)
      if (this.#credentials) {
        logger.info("Attempting WebSocket reconnect in 3s...");
        setTimeout(() => this.#connectWebSocket(), 3000);
      }
    });

    this.#ws = ws;
  }
}

// ---------------------------------------------------------------------------
// Async helpers
// ---------------------------------------------------------------------------

/**
 * Async file existence check. Never blocks the event loop.
 * @param {string} filepath
 * @returns {Promise<boolean>}
 */
async function fileExists(filepath) {
  try {
    await fs.access(filepath);
    return true;
  } catch {
    return false;
  }
}

module.exports = { LCUConnector };

// ---------------------------------------------------------------------------
// Run standalone:  node src/main/lcu-connector.js
// ---------------------------------------------------------------------------
if (require.main === module) {
  const connector = new LCUConnector();

  connector.on("connected", (session) => {
    console.log("\n>>> EVENT: connected (session)");
    console.log(`  PID      : ${session.processId}`);
    console.log(`  Port     : ${session.port}`);
    console.log(`  Base URL : ${session.baseUrl}`);
    console.log(`  Auth     : ${session.authHeader}`);
    console.log(`  Ready    : ${session.ready}`);
    console.log("\n>>> Fetching current summoner...");
    connector
      .getCurrentSummoner()
      .then((s) => console.log(">>> Summoner:", JSON.stringify(s, null, 2)))
      .catch((err) => console.log(">>> Summoner fetch failed:", err.message));
  });

  connector.on("disconnected", () => {
    console.log("\n>>> EVENT: disconnected");
  });

  connector.on("phase-changed", (phase) => {
    console.log(`\n>>> EVENT: phase-changed → ${phase}`);
  });

  connector.on("websocket-connected", () => {
    console.log(">>> EVENT: websocket-connected");
  });

  connector.on("lcu-event", (event) => {
    console.log(">>> LCU Event:", event.uri);
  });

  connector.start();

  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    connector.shutdown();
    process.exit(0);
  });

  console.log("Press Ctrl+C to stop.\n");
}
