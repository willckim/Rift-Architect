/**
 * Tilt Guard — Deterministic tilt metrics calculator.
 *
 * Computes a 0-100 tilt score from session match history
 * using weighted behavioral and performance signals.
 */

const { queries } = require("../../data/db");
const { logger } = require("../../utils/logger");

/**
 * Tilt level thresholds.
 */
const TiltLevel = Object.freeze({
  COOL: "cool",           // 0-25
  WARMING: "warming",     // 26-50
  TILTED: "tilted",       // 51-75
  DANGER_ZONE: "danger_zone", // 76-100
});

/**
 * Get the tilt level string from a numeric score.
 * @param {number} score
 * @returns {string}
 */
function getTiltLevel(score) {
  if (score <= 25) return TiltLevel.COOL;
  if (score <= 50) return TiltLevel.WARMING;
  if (score <= 75) return TiltLevel.TILTED;
  return TiltLevel.DANGER_ZONE;
}

/**
 * Compute a trend ("improving" | "stable" | "declining") by comparing
 * the average of recent values vs all values.
 *
 * @param {number[]} allValues — Full session values
 * @param {number} recentCount — Number of recent values to compare
 * @returns {"improving" | "stable" | "declining"}
 */
function computeTrend(allValues, recentCount = 3) {
  if (allValues.length < 2) return "stable";

  const avg = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
  const overallAvg = avg(allValues);
  const recentAvg = avg(allValues.slice(-recentCount));

  const diff = recentAvg - overallAvg;
  const threshold = overallAvg * 0.15; // 15% change threshold

  if (diff > threshold) return "improving";
  if (diff < -threshold) return "declining";
  return "stable";
}

/**
 * Build TiltMetrics from the current session's match records.
 *
 * @param {Object[]} sessionMatches — Array of match objects from DB, ordered by game_creation ASC
 * @param {Object} latestMatch — The most recent match
 * @returns {Object} TiltMetrics
 */
function buildTiltMetrics(sessionMatches, latestMatch) {
  const wins = sessionMatches.filter((m) => m.win);
  const losses = sessionMatches.filter((m) => !m.win);

  // Current streaks
  let lossStreak = 0;
  let winStreak = 0;
  for (let i = sessionMatches.length - 1; i >= 0; i--) {
    if (sessionMatches[i].win) {
      if (lossStreak > 0) break;
      winStreak++;
    } else {
      if (winStreak > 0) break;
      lossStreak++;
    }
  }

  // KDA values
  const kdaValues = sessionMatches.map((m) => {
    const d = Math.max(m.deaths, 1);
    return (m.kills + m.assists) / d;
  });

  // CS per minute values
  const cspmValues = sessionMatches.map((m) => {
    const mins = Math.max(m.game_duration / 60, 1);
    return (m.cs || 0) / mins;
  });

  // Vision score values
  const vsValues = sessionMatches.map((m) => m.vision_score || 0);

  // Death count values (inverted — higher is worse)
  const deathValues = sessionMatches.map((m) => -(m.deaths || 0));

  // Time between games (detect rage queueing)
  let avgTimeBetween = 300; // default 5 min
  if (sessionMatches.length >= 2) {
    const gaps = [];
    for (let i = 1; i < sessionMatches.length; i++) {
      const prev = sessionMatches[i - 1];
      const curr = sessionMatches[i];
      const prevEnd = prev.game_creation + prev.game_duration * 1000;
      const currStart = curr.game_creation;
      gaps.push(Math.max(0, (currStart - prevEnd) / 1000));
    }
    avgTimeBetween = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  }

  // Champion diversity
  const uniqueChamps = new Set(sessionMatches.map((m) => m.champion_id));

  // Latest game stats
  const lastKda = latestMatch
    ? (latestMatch.kills + latestMatch.assists) / Math.max(latestMatch.deaths, 1)
    : 0;

  return {
    session_games_played: sessionMatches.length,
    session_win_rate: sessionMatches.length > 0 ? wins.length / sessionMatches.length : 0,
    current_loss_streak: lossStreak,
    current_win_streak: winStreak,

    kda_trend: computeTrend(kdaValues),
    cs_per_min_trend: computeTrend(cspmValues),
    vision_score_trend: computeTrend(vsValues),
    death_timing_trend: computeTrend(deathValues),

    avg_time_between_games: Math.round(avgTimeBetween),
    surrender_votes: 0, // Not available from API — could track locally
    champion_diversity: uniqueChamps.size,

    last_game_result: latestMatch?.win ? "win" : "loss",
    last_game_kda: Math.round(lastKda * 100) / 100,
    last_game_death_count: latestMatch?.deaths || 0,
    last_game_duration_minutes: latestMatch
      ? Math.round(latestMatch.game_duration / 60)
      : 0,
    role_consistency:
      uniqueChamps.size <= sessionMatches.length * 0.6,
  };
}

/**
 * Deterministic tilt score calculator.
 *
 * @param {Object} metrics — TiltMetrics object
 * @returns {number} 0-100 tilt score
 */
function calculateTiltScore(metrics) {
  let score = 0;

  // Loss streak (heaviest weight) — up to 36 points
  score += Math.min(metrics.current_loss_streak * 12, 36);

  // Performance decline — up to 25 points
  if (metrics.kda_trend === "declining") score += 10;
  if (metrics.cs_per_min_trend === "declining") score += 5;
  if (metrics.death_timing_trend === "declining") score += 10;

  // Behavioral signals — up to 20 points
  if (metrics.avg_time_between_games < 60) score += 15; // Rage queueing
  score += Math.min(metrics.surrender_votes * 5, 10);

  // Recent game impact — up to 13 points
  if (metrics.last_game_death_count > 8) score += 8;
  if (metrics.last_game_kda < 1.0) score += 5;

  // Session fatigue — up to 15 points
  if (metrics.session_games_played > 5) score += 5;
  if (metrics.session_games_played > 8) score += 10;

  return Math.min(score, 100);
}

module.exports = {
  TiltLevel,
  getTiltLevel,
  buildTiltMetrics,
  calculateTiltScore,
  computeTrend,
};
