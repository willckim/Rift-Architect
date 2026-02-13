const { BaseAgent } = require("../base-agent");
const { SYSTEM_PROMPT, TOOLS, COOLDOWN_ROUTINES } = require("./prompt");
const { buildTiltMetrics, calculateTiltScore, getTiltLevel } = require("./tilt-metrics");
const { IPC_CHANNELS } = require("../../../shared/ipc-channels");
const { queries } = require("../../data/db");
const { getChampionName } = require("../../summoner-detector");
const { logger } = require("../../utils/logger");

/**
 * Tilt Guard — Agent 3.
 *
 * Active during POST_GAME. Fetches end-of-game stats from LCU,
 * records the match in the database, calculates a deterministic
 * tilt score, and invokes Claude to produce wellness recommendations.
 */
class TiltGuard extends BaseAgent {
  /** @type {import('../../riot-api-client').RiotApiClient} */
  #riotApi;

  /** @type {number | null} Current session ID */
  #sessionId = null;

  /** @type {Object | null} Latest tilt metrics */
  #latestMetrics = null;

  /** @type {number} Latest tilt score */
  #latestTiltScore = 0;

  /** @type {Object[]} Session matches cached */
  #sessionMatches = [];

  /** Whether we've already processed this post-game */
  #processed = false;

  /**
   * @param {Object} deps — BaseAgent deps + riotApi
   * @param {import('../../riot-api-client').RiotApiClient} deps.riotApi
   */
  constructor(deps) {
    super(deps);
    this.#riotApi = deps.riotApi;
  }

  get name() {
    return "tilt-guard";
  }

  systemPrompt() {
    return SYSTEM_PROMPT;
  }

  tools() {
    return TOOLS;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async onActivate() {
    logger.info("[Tilt Guard] Post-game detected — activating pipeline.");
    this.#processed = false;

    // Ensure we have an active session
    this.#ensureSession();

    // Process the post-game data
    await this.#processPostGame();
  }

  async onDeactivate() {
    this.#processed = false;
    logger.info("[Tilt Guard] Deactivated.");
  }

  // ---------------------------------------------------------------------------
  // Tool handlers
  // ---------------------------------------------------------------------------

  async handleToolCall(toolName, toolInput) {
    switch (toolName) {
      case "get_session_summary":
        return this.#handleGetSessionSummary(toolInput);

      case "get_historical_tilt_patterns":
        return this.#handleGetHistoricalPatterns(toolInput);

      case "emit_wellness_recommendation":
        return this.#handleEmitRecommendation(toolInput);

      default:
        return { error: `Unknown tool: ${toolName}` };
    }
  }

  // ---------------------------------------------------------------------------
  // Tool implementations
  // ---------------------------------------------------------------------------

  #handleGetSessionSummary({ include_match_details = true }) {
    const session = queries.getLatestSession();

    const summary = {
      session_id: this.#sessionId,
      games_played: this.#sessionMatches.length,
      wins: this.#sessionMatches.filter((m) => m.win).length,
      losses: this.#sessionMatches.filter((m) => !m.win).length,
      tilt_score: this.#latestTiltScore,
      tilt_level: getTiltLevel(this.#latestTiltScore),
      metrics: this.#latestMetrics,
      started_at: session?.started_at || null,
    };

    if (include_match_details) {
      summary.matches = this.#sessionMatches.map((m) => ({
        champion: m.champion_name,
        role: m.role,
        result: m.win ? "WIN" : "LOSS",
        kda: `${m.kills}/${m.deaths}/${m.assists}`,
        cs: m.cs,
        vision_score: m.vision_score,
        duration_min: Math.round(m.game_duration / 60),
        gold: m.gold_earned,
      }));
    }

    return summary;
  }

  #handleGetHistoricalPatterns({ lookback_days = 30 }) {
    const snapshots = queries.getRecentTiltSnapshots(50);

    // Filter to lookback window
    const cutoff = Date.now() - lookback_days * 24 * 60 * 60 * 1000;
    const relevant = snapshots.filter((s) => {
      const ts = new Date(s.created_at).getTime();
      return ts >= cutoff;
    });

    // Summarize patterns
    const tiltEpisodes = relevant.filter((s) => s.tilt_score >= 51);
    const recommendations = relevant
      .filter((s) => s.recommendation_given)
      .map((s) => ({
        tilt_score: s.tilt_score,
        recommendation: s.recommendation_given,
        date: s.created_at,
      }));

    return {
      total_snapshots: relevant.length,
      tilt_episodes: tiltEpisodes.length,
      avg_tilt_score: relevant.length > 0
        ? Math.round(relevant.reduce((s, r) => s + r.tilt_score, 0) / relevant.length)
        : 0,
      max_tilt_score: relevant.length > 0
        ? Math.max(...relevant.map((r) => r.tilt_score))
        : 0,
      recent_recommendations: recommendations.slice(0, 5),
      note: relevant.length === 0
        ? "No historical data available yet. This is an early session."
        : undefined,
    };
  }

  #handleEmitRecommendation({ tilt_level, headline, message, activity, session_analysis }) {
    const recommendation = {
      tilt_level,
      tilt_score: this.#latestTiltScore,
      headline,
      message,
      activity: activity || null,
      session_analysis: session_analysis || null,
      timestamp: Date.now(),
    };

    logger.info("[Tilt Guard] Wellness recommendation", {
      tiltLevel: tilt_level,
      headline,
      hasActivity: !!activity,
    });

    // Send tilt score update
    this.sendToOverlay(IPC_CHANNELS.TILT_SCORE_UPDATE, {
      score: this.#latestTiltScore,
      level: tilt_level,
    });

    // Send full recommendation
    this.sendToOverlay(IPC_CHANNELS.TILT_RECOMMENDATION, recommendation);

    // Send session summary
    this.sendToOverlay(IPC_CHANNELS.TILT_SESSION_SUMMARY, {
      games_played: this.#sessionMatches.length,
      wins: this.#sessionMatches.filter((m) => m.win).length,
      losses: this.#sessionMatches.filter((m) => !m.win).length,
      metrics: this.#latestMetrics,
    });

    // Store in DB
    try {
      queries.insertTiltSnapshot({
        session_id: this.#sessionId,
        match_id: this.#sessionMatches.length > 0
          ? this.#sessionMatches[this.#sessionMatches.length - 1].id
          : null,
        tilt_score: this.#latestTiltScore,
        metrics_json: JSON.stringify(this.#latestMetrics),
        recommendation_given: headline,
      });
    } catch (err) {
      logger.warn("[Tilt Guard] Failed to store tilt snapshot", { error: err.message });
    }

    return { status: "displayed", tilt_level, headline };
  }

  // ---------------------------------------------------------------------------
  // Post-game processing pipeline
  // ---------------------------------------------------------------------------

  async #processPostGame() {
    if (this.#processed) return;
    this.#processed = true;

    // 1. Fetch end-of-game stats from LCU
    let eogStats = null;
    try {
      eogStats = await this.lcu.getEndOfGameStats();
      logger.info("[Tilt Guard] End-of-game stats fetched.");
    } catch (err) {
      logger.warn("[Tilt Guard] Could not fetch end-of-game stats", { error: err.message });
    }

    // 2. Record the match in the database
    if (eogStats) {
      this.#recordMatch(eogStats);
    }

    // 3. Load all session matches
    const session = queries.getLatestSession();
    if (session) {
      this.#sessionMatches = queries.getSessionMatches(session.started_at);
    } else {
      this.#sessionMatches = queries.getRecentMatches(10);
    }

    if (this.#sessionMatches.length === 0) {
      logger.info("[Tilt Guard] No session matches to analyze.");
      return;
    }

    // 4. Calculate tilt metrics and score
    const latestMatch = this.#sessionMatches[this.#sessionMatches.length - 1];
    this.#latestMetrics = buildTiltMetrics(this.#sessionMatches, latestMatch);
    this.#latestTiltScore = calculateTiltScore(this.#latestMetrics);
    const tiltLevel = getTiltLevel(this.#latestTiltScore);

    logger.info("[Tilt Guard] Tilt analysis", {
      score: this.#latestTiltScore,
      level: tiltLevel,
      games: this.#sessionMatches.length,
      lossStreak: this.#latestMetrics.current_loss_streak,
    });

    // 5. Update session stats
    if (this.#sessionId) {
      try {
        const wins = this.#sessionMatches.filter((m) => m.win).length;
        const losses = this.#sessionMatches.filter((m) => !m.win).length;
        const avgKda = this.#sessionMatches.reduce((sum, m) => {
          return sum + (m.kills + m.assists) / Math.max(m.deaths, 1);
        }, 0) / this.#sessionMatches.length;

        queries.updateSessionStats(this.#sessionId, {
          games_played: this.#sessionMatches.length,
          wins,
          losses,
          avg_kda: Math.round(avgKda * 100) / 100,
        });
      } catch (err) {
        logger.warn("[Tilt Guard] Failed to update session stats", { error: err.message });
      }
    }

    // 6. Invoke Claude (always invoke — even "cool" gets a nice summary)
    const context = this.#buildContext(tiltLevel);
    try {
      await this.invoke(context, "POST_GAME");
    } catch (err) {
      logger.error("[Tilt Guard] Claude invocation failed", { error: err.message });
    }
  }

  /**
   * Record a match from end-of-game stats.
   */
  #recordMatch(eogStats) {
    try {
      // Extract relevant data from LCU end-of-game format
      const localPlayer = eogStats.localPlayer || eogStats;
      const gameId = eogStats.gameId || `local-${Date.now()}`;

      queries.upsertMatch({
        id: String(gameId),
        game_creation: Date.now(),
        game_duration: eogStats.gameLength || 0,
        game_mode: eogStats.gameMode || "unknown",
        champion_id: localPlayer.championId || 0,
        champion_name: localPlayer.championName || getChampionName(localPlayer.championId) || "Unknown",
        role: localPlayer.selectedPosition || localPlayer.detectedTeamPosition || null,
        win: localPlayer.isWinningTeam ?? localPlayer.stats?.WIN ?? false,
        kills: localPlayer.stats?.CHAMPIONS_KILLED ?? localPlayer.kills ?? 0,
        deaths: localPlayer.stats?.NUM_DEATHS ?? localPlayer.deaths ?? 0,
        assists: localPlayer.stats?.ASSISTS ?? localPlayer.assists ?? 0,
        cs: (localPlayer.stats?.MINIONS_KILLED ?? 0) + (localPlayer.stats?.NEUTRAL_MINIONS_KILLED ?? 0),
        vision_score: localPlayer.stats?.VISION_SCORE ?? 0,
        gold_earned: localPlayer.stats?.GOLD_EARNED ?? 0,
        data_json: JSON.stringify(eogStats),
      });

      logger.info("[Tilt Guard] Match recorded", { gameId });
    } catch (err) {
      logger.warn("[Tilt Guard] Failed to record match", { error: err.message });
    }
  }

  /**
   * Ensure we have an active gaming session.
   */
  #ensureSession() {
    const existing = queries.getLatestSession();

    // If there's a session from today that hasn't ended, reuse it
    if (existing && !existing.ended_at) {
      this.#sessionId = existing.id;
      return;
    }

    // Start a new session
    this.#sessionId = queries.startSession();
    logger.info("[Tilt Guard] New gaming session started", { sessionId: this.#sessionId });
  }

  /**
   * Build context message for Claude.
   */
  #buildContext(tiltLevel) {
    const latestMatch = this.#sessionMatches.length > 0
      ? this.#sessionMatches[this.#sessionMatches.length - 1]
      : null;

    const context = {
      tilt_score: this.#latestTiltScore,
      tilt_level: tiltLevel,
      session_games: this.#sessionMatches.length,
      session_record: `${this.#sessionMatches.filter((m) => m.win).length}W-${this.#sessionMatches.filter((m) => !m.win).length}L`,
      latest_game: latestMatch ? {
        champion: latestMatch.champion_name,
        result: latestMatch.win ? "WIN" : "LOSS",
        kda: `${latestMatch.kills}/${latestMatch.deaths}/${latestMatch.assists}`,
        duration_min: Math.round(latestMatch.game_duration / 60),
      } : null,
      key_metrics: {
        loss_streak: this.#latestMetrics?.current_loss_streak || 0,
        win_streak: this.#latestMetrics?.current_win_streak || 0,
        kda_trend: this.#latestMetrics?.kda_trend || "stable",
        avg_time_between_games: this.#latestMetrics?.avg_time_between_games || 0,
      },
      instructions: this.#getInstructions(tiltLevel),
    };

    return `POST-GAME TILT ANALYSIS:\n${JSON.stringify(context, null, 2)}`;
  }

  #getInstructions(tiltLevel) {
    switch (tiltLevel) {
      case "cool":
        return "Player is doing well. Give a brief positive summary. No exercise needed, but you can suggest a light stretch if they've been playing a while.";
      case "warming":
        return "Player is starting to tilt. Suggest a gentle 5-minute desk stretch or box breathing. Frame it as performance optimization.";
      case "tilted":
        return "Player is tilted. Recommend a 10-minute calisthenics circuit. Be supportive, not condescending. Include breathing exercises.";
      case "danger_zone":
        return "Player is in the danger zone. Strongly recommend a 15-20 minute full HYROX-style routine. Provide detailed session analysis and a full exercise plan.";
      default:
        return "Analyze the session and provide appropriate feedback.";
    }
  }
}

module.exports = { TiltGuard };
