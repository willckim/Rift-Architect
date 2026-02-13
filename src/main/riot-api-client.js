const https = require("https");
const { EventEmitter } = require("events");
const { logger } = require("./utils/logger");
const { getKey } = require("./key-store");

// ---------------------------------------------------------------------------
// Token-Bucket Rate Limiter
// ---------------------------------------------------------------------------

/**
 * A single rate-limit bucket (e.g. "20 requests per 1 second").
 */
class Bucket {
  /** @type {number} Max tokens (requests) allowed in the window */
  #max;
  /** @type {number} Window duration in ms */
  #windowMs;
  /** @type {number[]} Timestamps of recent requests within the window */
  #timestamps = [];

  /**
   * @param {number} max - Max requests
   * @param {number} windowSeconds - Window in seconds
   */
  constructor(max, windowSeconds) {
    this.#max = max;
    this.#windowMs = windowSeconds * 1000;
  }

  /** Prune timestamps outside the current window */
  #prune() {
    const cutoff = Date.now() - this.#windowMs;
    this.#timestamps = this.#timestamps.filter((t) => t > cutoff);
  }

  /** @returns {boolean} Whether a request can be made right now */
  canRequest() {
    this.#prune();
    return this.#timestamps.length < this.#max;
  }

  /** Record a request */
  consume() {
    this.#timestamps.push(Date.now());
  }

  /** @returns {number} Ms until a token becomes available (0 if available now) */
  waitTime() {
    this.#prune();
    if (this.#timestamps.length < this.#max) return 0;
    // Oldest timestamp + window = when that slot frees up
    return this.#timestamps[0] + this.#windowMs - Date.now();
  }

  toString() {
    this.#prune();
    return `${this.#timestamps.length}/${this.#max} per ${this.#windowMs / 1000}s`;
  }
}

/**
 * Rate limiter managing multiple buckets parsed from Riot's header format.
 * Header format: "20:1,100:120" → 20 per 1s AND 100 per 120s.
 */
class RateLimiter {
  /** @type {Bucket[]} */
  #buckets;

  /**
   * @param {string} headerValue - e.g. "20:1,100:120"
   */
  constructor(headerValue) {
    this.#buckets = RateLimiter.parseBuckets(headerValue);
  }

  /** @returns {boolean} */
  canRequest() {
    return this.#buckets.every((b) => b.canRequest());
  }

  consume() {
    this.#buckets.forEach((b) => b.consume());
  }

  /** @returns {number} Ms to wait before next request is safe */
  waitTime() {
    return Math.max(0, ...this.#buckets.map((b) => b.waitTime()));
  }

  /**
   * Update bucket maximums from a new header (in case Riot changes limits mid-session).
   * @param {string} headerValue
   */
  update(headerValue) {
    this.#buckets = RateLimiter.parseBuckets(headerValue);
  }

  /**
   * Parse "20:1,100:120" into Bucket instances.
   * @param {string} headerValue
   * @returns {Bucket[]}
   */
  static parseBuckets(headerValue) {
    if (!headerValue) return [new Bucket(20, 1), new Bucket(100, 120)]; // safe defaults
    return headerValue.split(",").map((pair) => {
      const [max, seconds] = pair.split(":").map(Number);
      return new Bucket(max, seconds);
    });
  }
}

// ---------------------------------------------------------------------------
// Bottleneck Queue — Serial FIFO with automatic 80% pause
// ---------------------------------------------------------------------------

/**
 * Serial FIFO queue with built-in usage tracking against the 2-minute
 * rate-limit window. When usage hits 80% of the 2-min limit (80 out of 100
 * requests), the queue auto-pauses for 30 seconds to let the window reset.
 *
 * This prevents the agent from ever "tilting" the API.
 */
class BottleneckQueue {
  /** @type {Array<{ run: Function, resolve: Function, reject: Function }>} */
  #queue = [];
  #running = false;

  /** Whether the queue is paused (80% throttle or key expired) */
  #paused = false;

  /** Timestamp when pause will end (0 = not paused by throttle) */
  #pauseUntil = 0;

  /** Requests made within the current 2-minute window */
  #windowTimestamps = [];

  /** 2-minute window in ms */
  #WINDOW_MS = 120000;

  /** Max requests in the 2-min window (Riot dev key default) */
  #WINDOW_MAX = 100;

  /** Threshold percentage to trigger auto-pause */
  #THROTTLE_PCT = 0.80;

  /** How long to pause when threshold is hit (ms) */
  #PAUSE_DURATION_MS = 30000;

  /**
   * Enqueue an async task. Returns a Promise that resolves with the task's result.
   * Rejects immediately if the queue is paused due to key expiration.
   * @param {() => Promise<any>} fn
   * @returns {Promise<any>}
   */
  enqueue(fn) {
    return new Promise((resolve, reject) => {
      if (this.#paused && this.#pauseUntil === 0) {
        // Paused indefinitely (key expired) — reject immediately
        reject(new Error("Riot API paused — API key expired"));
        return;
      }
      this.#queue.push({ run: fn, resolve, reject });
      this.#drain();
    });
  }

  async #drain() {
    if (this.#running) return;
    this.#running = true;

    while (this.#queue.length > 0) {
      // Check throttle pause
      if (this.#paused && this.#pauseUntil > 0) {
        const remaining = this.#pauseUntil - Date.now();
        if (remaining > 0) {
          logger.info("Bottleneck: paused (80% threshold)", { resumeInMs: remaining });
          await sleep(remaining);
        }
        this.#paused = false;
        this.#pauseUntil = 0;
      }

      // Indefinite pause (key expired) — stop draining
      if (this.#paused && this.#pauseUntil === 0) {
        break;
      }

      // Prune old timestamps and check usage
      this.#pruneWindow();
      if (this.#windowTimestamps.length >= this.#WINDOW_MAX * this.#THROTTLE_PCT) {
        logger.warn("Bottleneck: 80% of 2-min limit reached — auto-pausing 30s", {
          used: this.#windowTimestamps.length,
          max: this.#WINDOW_MAX,
        });
        this.#paused = true;
        this.#pauseUntil = Date.now() + this.#PAUSE_DURATION_MS;
        continue; // Loop will sleep above
      }

      const { run, resolve, reject } = this.#queue.shift();
      this.#windowTimestamps.push(Date.now());
      try {
        const result = await run();
        resolve(result);
      } catch (err) {
        reject(err);
      }
    }

    this.#running = false;
  }

  #pruneWindow() {
    const cutoff = Date.now() - this.#WINDOW_MS;
    this.#windowTimestamps = this.#windowTimestamps.filter((t) => t > cutoff);
  }

  /** Pause the queue indefinitely (e.g. on 403 key expiry) */
  pause() {
    this.#paused = true;
    this.#pauseUntil = 0; // 0 = indefinite
    // Reject all pending tasks
    while (this.#queue.length > 0) {
      const { reject } = this.#queue.shift();
      reject(new Error("Riot API paused — API key expired"));
    }
  }

  /** Resume the queue (e.g. after key is updated) */
  resume() {
    this.#paused = false;
    this.#pauseUntil = 0;
  }

  /** @returns {boolean} */
  get isPaused() {
    return this.#paused;
  }

  /** @returns {number} */
  get pending() {
    return this.#queue.length;
  }

  /** @returns {number} Requests used in the current 2-min window */
  get windowUsage() {
    this.#pruneWindow();
    return this.#windowTimestamps.length;
  }
}

// ---------------------------------------------------------------------------
// Riot API Client
// ---------------------------------------------------------------------------

/**
 * Riot Games Cloud API Client with built-in rate limiting, retry,
 * and async serial request queue.
 *
 * VANGUARD SAFETY:
 * This client only uses the official Riot Games Cloud REST API
 * (developer.riotgames.com). It does NOT interact with the game process,
 * read game memory, or modify any game files. This is the same public API
 * used by Blitz.gg, Porofessor, U.GG, and Mobalytics.
 *
 * ASYNC GUARANTEES:
 * - All requests are fully async (Promises, never blocking)
 * - A serial FIFO queue prevents concurrent requests from overlapping
 * - Rate limiter waits are non-blocking sleeps (setTimeout-based)
 * - Only final "ready" data is sent to the renderer via IPC
 *
 * Rate-limit strategy:
 *   - Tracks app-level limits from X-App-Rate-Limit headers
 *   - Pre-checks bucket availability before each request
 *   - Serial queue ensures only one request is in flight at a time
 *   - On 429: respects Retry-After header, retries up to MAX_RETRIES times
 *   - Adds a small spacing delay between consecutive requests
 */
class RiotApiClient extends EventEmitter {
  #apiKey;
  #region;
  #routing;

  /** @type {RateLimiter} */
  #appLimiter;

  /** @type {BottleneckQueue} Bottleneck queue with auto-pause */
  #queue = new BottleneckQueue();

  /** Minimum ms between consecutive requests (prevents burst) */
  #REQUEST_SPACING_MS = 50;

  /** Maximum retries on 429 */
  #MAX_RETRIES = 3;

  /** Timestamp of the last request sent */
  #lastRequestTime = 0;

  /** Whether the API key is known to be expired (403 received) */
  #keyExpired = false;

  constructor() {
    super();
    this.#apiKey = getKey("RIOT_API_KEY");
    this.#region = getKey("RIOT_REGION") || "na1";
    this.#routing = getKey("RIOT_ROUTING") || "americas";

    // Initialize with Riot's default dev-key limits: 20/1s, 100/120s
    this.#appLimiter = new RateLimiter("20:1,100:120");

    if (!this.#apiKey) {
      logger.error("RIOT_API_KEY is not set in .env — Cloud API calls will fail.");
    } else {
      logger.info("Riot API client initialized.", {
        region: this.#region,
        routing: this.#routing,
        keyPrefix: this.#apiKey.substring(0, 12) + "...",
      });
    }
  }

  /** @returns {boolean} Whether the API key has expired (403 received) */
  get isKeyExpired() {
    return this.#keyExpired;
  }

  /** @returns {boolean} Whether the bottleneck queue is paused */
  get isPaused() {
    return this.#queue.isPaused;
  }

  /** @returns {number} Requests used in the current 2-min window */
  get windowUsage() {
    return this.#queue.windowUsage;
  }

  /**
   * Hot-reload the API key (called from Settings UI after key update).
   * Clears the expired flag and resumes the queue.
   */
  reloadKey() {
    this.#apiKey = getKey("RIOT_API_KEY");
    this.#region = getKey("RIOT_REGION") || "na1";
    this.#routing = getKey("RIOT_ROUTING") || "americas";
    if (this.#apiKey) {
      this.#keyExpired = false;
      this.#queue.resume();
      logger.info("Riot API key reloaded.", {
        keyPrefix: this.#apiKey.substring(0, 12) + "...",
        region: this.#region,
        routing: this.#routing,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Public API methods
  // ---------------------------------------------------------------------------

  async getRankedEntries(summonerId) {
    return this.#platformRequest(
      `/lol/league/v4/entries/by-summoner/${encodeURIComponent(summonerId)}`
    );
  }

  async getTopMasteries(puuid, count = 3) {
    return this.#platformRequest(
      `/lol/champion-mastery/v4/champion-masteries/by-puuid/${encodeURIComponent(puuid)}/top?count=${count}`
    );
  }

  async getMatchIds(puuid, count = 20) {
    return this.#regionalRequest(
      `/lol/match/v5/matches/by-puuid/${encodeURIComponent(puuid)}/ids?count=${count}`
    );
  }

  async getMatch(matchId) {
    return this.#regionalRequest(
      `/lol/match/v5/matches/${encodeURIComponent(matchId)}`
    );
  }

  async getMatchTimeline(matchId) {
    return this.#regionalRequest(
      `/lol/match/v5/matches/${encodeURIComponent(matchId)}/timeline`
    );
  }

  async getSummonerByPuuid(puuid) {
    return this.#platformRequest(
      `/lol/summoner/v4/summoners/by-puuid/${encodeURIComponent(puuid)}`
    );
  }

  // ---------------------------------------------------------------------------
  // Private — routing helpers (all requests go through the serial queue)
  // ---------------------------------------------------------------------------

  #platformRequest(path) {
    if (this.#keyExpired) {
      return Promise.reject(new Error("Riot API key expired — update .env"));
    }
    return this.#queue.enqueue(() =>
      this.#requestWithRetry(`${this.#region}.api.riotgames.com`, path)
    );
  }

  #regionalRequest(path) {
    if (this.#keyExpired) {
      return Promise.reject(new Error("Riot API key expired — update .env"));
    }
    return this.#queue.enqueue(() =>
      this.#requestWithRetry(`${this.#routing}.api.riotgames.com`, path)
    );
  }

  // ---------------------------------------------------------------------------
  // Private — rate-limited request with retry
  // ---------------------------------------------------------------------------

  /**
   * Wait for rate limiter + spacing, then make the request.
   * On 429, wait for Retry-After and retry up to MAX_RETRIES times.
   */
  async #requestWithRetry(hostname, path, attempt = 0) {
    // 1. Wait for rate limiter
    const waitMs = this.#appLimiter.waitTime();
    if (waitMs > 0) {
      logger.info("Rate limiter: waiting before request", { waitMs, path });
      await sleep(waitMs + 50); // small buffer
    }

    // 2. Enforce minimum spacing between requests
    const elapsed = Date.now() - this.#lastRequestTime;
    if (elapsed < this.#REQUEST_SPACING_MS) {
      await sleep(this.#REQUEST_SPACING_MS - elapsed);
    }

    // 3. Check bucket availability one more time
    if (!this.#appLimiter.canRequest()) {
      const extraWait = this.#appLimiter.waitTime();
      logger.info("Rate limiter: bucket full, waiting", { extraWait, path });
      await sleep(extraWait + 50);
    }

    // 4. Consume a token and fire the request
    this.#appLimiter.consume();
    this.#lastRequestTime = Date.now();

    try {
      return await this.#request(hostname, path);
    } catch (err) {
      // 5. Handle 429 with retry
      if (err.retryAfterMs && attempt < this.#MAX_RETRIES) {
        logger.warn(`Rate limited (429). Retry ${attempt + 1}/${this.#MAX_RETRIES} after ${err.retryAfterMs}ms`, { path });
        await sleep(err.retryAfterMs);
        return this.#requestWithRetry(hostname, path, attempt + 1);
      }

      // 6. All retries exhausted on 429 — emit rate-limited event
      if (err.statusCode === 429) {
        this.emit("rate-limited", { retryAfterMs: err.retryAfterMs });
      }

      throw err;
    }
  }

  /**
   * Core HTTPS GET. Returns parsed JSON on 200.
   * On 429, throws an error with retryAfterMs attached.
   */
  #request(hostname, path) {
    if (!this.#apiKey) {
      return Promise.reject(new Error("RIOT_API_KEY not configured"));
    }

    return new Promise((resolve, reject) => {
      const options = {
        hostname,
        port: 443,
        path,
        method: "GET",
        headers: {
          "X-Riot-Token": this.#apiKey,
          Accept: "application/json",
          "User-Agent": "RiftArchitect/1.0 (companion-app)",
        },
      };

      logger.debug(`Riot API → ${hostname}${path}`);

      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          // Update limiter from response headers
          const appLimit = res.headers["x-app-rate-limit"];
          if (appLimit) {
            this.#appLimiter.update(appLimit);
          }

          if (res.statusCode === 200) {
            try {
              resolve(JSON.parse(data));
            } catch {
              resolve(data);
            }
          } else if (res.statusCode === 429) {
            const retryAfter = parseInt(res.headers["retry-after"] || "1", 10);
            const err = new Error(`Rate limited — retry after ${retryAfter}s`);
            err.retryAfterMs = retryAfter * 1000;
            err.statusCode = 429;
            reject(err);
          } else if (res.statusCode === 403) {
            logger.error("Riot API 403 — API key expired or invalid.");
            if (!this.#keyExpired) {
              this.#keyExpired = true;
              this.#queue.pause();
              this.emit("key-expired");
            }
            reject(new Error("Riot API 403 Forbidden — check your API key"));
          } else if (res.statusCode === 404) {
            reject(new Error(`Riot API 404: ${path}`));
          } else {
            reject(new Error(`Riot API ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on("error", (err) => {
        logger.error("Riot API request failed", { error: err.message });
        reject(err);
      });

      req.setTimeout(10000, () => {
        req.destroy(new Error("Riot API request timeout"));
      });

      req.end();
    });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { RiotApiClient, RateLimiter, Bucket, BottleneckQueue };
