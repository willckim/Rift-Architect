const Database = require("better-sqlite3");
const path = require("path");
const { app } = require("electron");
const { logger } = require("../utils/logger");

/** @type {Database.Database | null} */
let db = null;

/**
 * Get the database file path.
 * In production, uses Electron's userData directory.
 * In dev/standalone, uses the project root.
 */
function getDbPath() {
  try {
    // Electron context — store in app data
    return path.join(app.getPath("userData"), "rift-architect.db");
  } catch {
    // Standalone / testing — store in project root
    return path.join(__dirname, "../../../rift-architect.db");
  }
}

/**
 * Initialize the SQLite database. Creates tables if they don't exist.
 * @returns {Database.Database}
 */
function initDatabase() {
  const dbPath = getDbPath();
  logger.info("Initializing database", { path: dbPath });

  db = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma("journal_mode = WAL");

  // Run migrations
  migrate(db);

  logger.info("Database initialized.", {
    tables: db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name).join(", "),
  });

  return db;
}

/**
 * Get the database instance. Throws if not initialized.
 * @returns {Database.Database}
 */
function getDb() {
  if (!db) throw new Error("Database not initialized. Call initDatabase() first.");
  return db;
}

/**
 * Close the database.
 */
function closeDatabase() {
  if (db) {
    db.close();
    db = null;
    logger.info("Database closed.");
  }
}

// ---------------------------------------------------------------------------
// Schema migrations
// ---------------------------------------------------------------------------

/**
 * @param {Database.Database} db
 */
function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS matches (
      id TEXT PRIMARY KEY,
      game_creation INTEGER NOT NULL,
      game_duration INTEGER NOT NULL,
      game_mode TEXT NOT NULL,
      champion_id INTEGER NOT NULL,
      champion_name TEXT NOT NULL,
      role TEXT,
      win BOOLEAN NOT NULL,
      kills INTEGER,
      deaths INTEGER,
      assists INTEGER,
      cs INTEGER,
      vision_score INTEGER,
      gold_earned INTEGER,
      data_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at DATETIME NOT NULL,
      ended_at DATETIME,
      games_played INTEGER DEFAULT 0,
      wins INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      avg_kda REAL,
      tilt_score_final INTEGER,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS tilt_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER REFERENCES sessions(id),
      match_id TEXT REFERENCES matches(id),
      tilt_score INTEGER NOT NULL,
      metrics_json TEXT NOT NULL,
      recommendation_given TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS agent_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_name TEXT NOT NULL,
      game_phase TEXT NOT NULL,
      input_summary TEXT,
      output_summary TEXT,
      claude_model TEXT,
      tokens_used INTEGER,
      latency_ms INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS enemy_analysis_cache (
      puuid TEXT PRIMARY KEY,
      analysis_json TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS draft_advice_cache (
      matchup_key TEXT PRIMARY KEY,
      advice_json TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS meta_champions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      tier TEXT NOT NULL,
      win_rate REAL NOT NULL,
      pick_rate REAL NOT NULL,
      ban_rate REAL NOT NULL DEFAULT 0,
      counter_count INTEGER DEFAULT 0,
      patch_version TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'lolalytics',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(name, role, patch_version)
    );
  `);
}

// ---------------------------------------------------------------------------
// Convenience helpers
// ---------------------------------------------------------------------------

const queries = {
  /**
   * Insert or replace a match record.
   */
  upsertMatch(match) {
    const stmt = getDb().prepare(`
      INSERT OR REPLACE INTO matches (id, game_creation, game_duration, game_mode, champion_id, champion_name, role, win, kills, deaths, assists, cs, vision_score, gold_earned, data_json)
      VALUES (@id, @game_creation, @game_duration, @game_mode, @champion_id, @champion_name, @role, @win, @kills, @deaths, @assists, @cs, @vision_score, @gold_earned, @data_json)
    `);
    return stmt.run(match);
  },

  /**
   * Start a new gaming session.
   * @returns {number} The new session ID
   */
  startSession() {
    const stmt = getDb().prepare(`
      INSERT INTO sessions (started_at) VALUES (datetime('now'))
    `);
    return stmt.run().lastInsertRowid;
  },

  /**
   * End a session and record final stats.
   */
  endSession(sessionId, stats) {
    const stmt = getDb().prepare(`
      UPDATE sessions SET ended_at = datetime('now'), games_played = @games_played, wins = @wins, losses = @losses, avg_kda = @avg_kda, tilt_score_final = @tilt_score_final
      WHERE id = @id
    `);
    return stmt.run({ id: sessionId, ...stats });
  },

  /**
   * Insert a tilt snapshot.
   */
  insertTiltSnapshot(snapshot) {
    const stmt = getDb().prepare(`
      INSERT INTO tilt_snapshots (session_id, match_id, tilt_score, metrics_json, recommendation_given)
      VALUES (@session_id, @match_id, @tilt_score, @metrics_json, @recommendation_given)
    `);
    return stmt.run(snapshot);
  },

  /**
   * Log an agent invocation.
   */
  logAgent(entry) {
    const stmt = getDb().prepare(`
      INSERT INTO agent_logs (agent_name, game_phase, input_summary, output_summary, claude_model, tokens_used, latency_ms)
      VALUES (@agent_name, @game_phase, @input_summary, @output_summary, @claude_model, @tokens_used, @latency_ms)
    `);
    return stmt.run(entry);
  },

  /**
   * Get or set a setting.
   */
  getSetting(key) {
    const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key);
    return row ? row.value : null;
  },

  setSetting(key, value) {
    getDb().prepare(`
      INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    `).run(key, value);
  },

  /**
   * Get recent matches for the session.
   */
  getRecentMatches(limit = 10) {
    return getDb().prepare(
      "SELECT * FROM matches ORDER BY game_creation DESC LIMIT ?"
    ).all(limit);
  },

  /**
   * Get latest session.
   */
  getLatestSession() {
    return getDb().prepare(
      "SELECT * FROM sessions ORDER BY id DESC LIMIT 1"
    ).get();
  },

  /**
   * Update session game count and win/loss.
   */
  updateSessionStats(sessionId, { games_played, wins, losses, avg_kda }) {
    getDb().prepare(`
      UPDATE sessions SET games_played = @games_played, wins = @wins, losses = @losses, avg_kda = @avg_kda
      WHERE id = @id
    `).run({ id: sessionId, games_played, wins, losses, avg_kda });
  },

  /**
   * Get matches for a specific session (by time range).
   * @param {string} sessionStartedAt — ISO datetime
   * @returns {Object[]}
   */
  getSessionMatches(sessionStartedAt) {
    return getDb().prepare(
      "SELECT * FROM matches WHERE created_at >= ? ORDER BY game_creation ASC"
    ).all(sessionStartedAt);
  },

  /**
   * Get recent tilt snapshots for historical pattern analysis.
   * @param {number} limit
   * @returns {Object[]}
   */
  getRecentTiltSnapshots(limit = 20) {
    return getDb().prepare(
      "SELECT * FROM tilt_snapshots ORDER BY created_at DESC LIMIT ?"
    ).all(limit);
  },

  /**
   * Get tilt snapshots for a specific session.
   * @param {number} sessionId
   * @returns {Object[]}
   */
  getSessionTiltSnapshots(sessionId) {
    return getDb().prepare(
      "SELECT * FROM tilt_snapshots WHERE session_id = ? ORDER BY created_at ASC"
    ).all(sessionId);
  },

  // ---------------------------------------------------------------------------
  // Enemy analysis cache — avoid re-analyzing the same player twice per session
  // ---------------------------------------------------------------------------

  /**
   * Get cached enemy analysis if it's less than `maxAgeHours` old.
   * @param {string} puuid
   * @param {number} [maxAgeHours=6] — Cache TTL in hours (default: 6 = same night)
   * @returns {Object | null} Parsed analysis or null if not cached / expired
   */
  getCachedEnemyAnalysis(puuid, maxAgeHours = 6) {
    const row = getDb().prepare(
      "SELECT analysis_json, created_at FROM enemy_analysis_cache WHERE puuid = ?"
    ).get(puuid);

    if (!row) return null;

    // Check TTL
    const ageMs = Date.now() - new Date(row.created_at).getTime();
    if (ageMs > maxAgeHours * 60 * 60 * 1000) return null;

    try {
      return JSON.parse(row.analysis_json);
    } catch {
      return null;
    }
  },

  /**
   * Store enemy analysis in the cache.
   * @param {string} puuid
   * @param {Object} analysis — The analysis data to cache
   */
  setCachedEnemyAnalysis(puuid, analysis) {
    getDb().prepare(`
      INSERT OR REPLACE INTO enemy_analysis_cache (puuid, analysis_json, created_at)
      VALUES (?, ?, datetime('now'))
    `).run(puuid, JSON.stringify(analysis));
  },

  // ---------------------------------------------------------------------------
  // Draft advice cache — avoid re-analyzing the same champion matchup
  // ---------------------------------------------------------------------------

  /**
   * Build a deterministic cache key from champion names in a matchup.
   * @param {string[]} allyPicks - Sorted ally champion names
   * @param {string[]} enemyPicks - Sorted enemy champion names
   * @param {string} role - Player's assigned role
   * @returns {string}
   */
  buildMatchupKey(allyPicks, enemyPicks, role) {
    const allies = [...allyPicks].sort().join(",");
    const enemies = [...enemyPicks].sort().join(",");
    return `${role}|A:${allies}|E:${enemies}`;
  },

  /**
   * Get cached draft advice if it's less than 24 hours old.
   * @param {string} matchupKey
   * @returns {Object | null}
   */
  getCachedDraftAdvice(matchupKey) {
    const row = getDb().prepare(
      "SELECT advice_json, created_at FROM draft_advice_cache WHERE matchup_key = ?"
    ).get(matchupKey);

    if (!row) return null;

    const ageMs = Date.now() - new Date(row.created_at).getTime();
    if (ageMs > 24 * 60 * 60 * 1000) return null; // 24hr TTL

    try {
      return JSON.parse(row.advice_json);
    } catch {
      return null;
    }
  },

  /**
   * Store draft advice in the cache.
   * @param {string} matchupKey
   * @param {Object} advice
   */
  setCachedDraftAdvice(matchupKey, advice) {
    getDb().prepare(`
      INSERT OR REPLACE INTO draft_advice_cache (matchup_key, advice_json, created_at)
      VALUES (?, ?, datetime('now'))
    `).run(matchupKey, JSON.stringify(advice));
  },

  // ---------------------------------------------------------------------------
  // Meta champions — tier list data from community stats sites
  // ---------------------------------------------------------------------------

  /**
   * Get the meta tier list for a role on a specific patch.
   * Ordered by tier (S first) then win_rate descending.
   * @param {string} role
   * @param {string} patchVersion
   * @param {number} [limit=20]
   * @returns {Object[]}
   */
  getMetaTierList(role, patchVersion, limit = 20) {
    return getDb().prepare(`
      SELECT name, role, tier, win_rate, pick_rate, ban_rate, counter_count
      FROM meta_champions
      WHERE role = ? AND patch_version = ?
      ORDER BY
        CASE tier WHEN 'S' THEN 1 WHEN 'A' THEN 2 WHEN 'B' THEN 3 WHEN 'C' THEN 4 WHEN 'D' THEN 5 ELSE 6 END,
        win_rate DESC
      LIMIT ?
    `).all(role, patchVersion, limit);
  },

  /**
   * Get blind-safe picks: high win rate + few counters.
   * @param {string} role
   * @param {string} patchVersion
   * @param {number} [maxCounters=3]
   * @param {number} [limit=5]
   * @returns {Object[]}
   */
  getBlindSafePicks(role, patchVersion, maxCounters = 3, limit = 5) {
    return getDb().prepare(`
      SELECT name, role, tier, win_rate, pick_rate, ban_rate, counter_count
      FROM meta_champions
      WHERE role = ? AND patch_version = ? AND counter_count <= ?
      ORDER BY win_rate DESC
      LIMIT ?
    `).all(role, patchVersion, maxCounters, limit);
  },

  /**
   * Check if we have meta data for a given patch version.
   * @param {string} patchVersion
   * @returns {boolean}
   */
  hasMetaData(patchVersion) {
    const row = getDb().prepare(
      "SELECT COUNT(*) AS cnt FROM meta_champions WHERE patch_version = ?"
    ).get(patchVersion);
    return row.cnt > 0;
  },
};

module.exports = { initDatabase, getDb, closeDatabase, queries };
