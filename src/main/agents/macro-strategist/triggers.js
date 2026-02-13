/**
 * Macro Strategist — Tactical Trigger Engine.
 *
 * Analyzes Live Client Data snapshots and events to detect significant
 * state changes. Each trigger is classified as either:
 *   - LOCAL  — deterministic, emitted instantly without Claude
 *   - CLAUDE — strategic, forwarded to Claude for nuanced analysis
 *
 * DATA SOURCE: /allgamedata from Live Client API (Port 2999).
 * LIMITATIONS: No minimap positions, no ally health bars (only activePlayer).
 * Ally death tracking uses ChampionKill events as a proxy for "low HP / overextended."
 *
 * RIOT POLICY COMPLIANCE — GAME INTEGRITY:
 * All triggers use ONLY publicly visible data (death state, scoreboard stats,
 * objective kill events). NO fog-of-war predictions, NO enemy cooldown tracking,
 * NO jungler pathing estimation. Death timers and kill events are visible to all
 * players via the in-game scoreboard and kill feed.
 */

const { logger } = require("../../utils/logger");

/**
 * Trigger type constants.
 */
const MacroTrigger = Object.freeze({
  // ── Tactical & Tempo (Mid-Game) ──
  THROW_GUARD: "throw_guard",
  BARON_WINDOW: "baron_window",
  CONTEST_SOUL: "contest_soul",
  RUSH_BARON: "rush_baron",
  CATCH_WAVE: "catch_wave",

  // ── Closing-Call Logic (Late-Game) ──
  WIN_CONDITION: "win_condition",
  BARON_BAIT: "baron_bait",

  // ── Standard Triggers ──
  GOLD_SWING: "gold_swing",
  OBJECTIVE_TAKEN: "major_objective_killed",
  ACE: "team_ace",
  POWER_SPIKE: "power_spike",
  DEATH_TIMER_LONG: "enemy_death_timer_gt_30s",
  TOWER_DESTROYED: "tower_destroyed",
  INHIB_KILLED: "inhib_killed",
});

/**
 * Detects tactical state changes from game snapshots and events.
 *
 * Maintains rolling state: gold history, drake counts, turret/inhib
 * state, and recent ally death events for throw detection.
 *
 * @typedef {Object} TriggerResult
 * @property {string}  trigger       — MacroTrigger key
 * @property {string}  detail        — What happened (for logging / Claude context)
 * @property {"info"|"suggestion"|"urgent"} urgency
 * @property {string|null}  localCall     — If set, emit this message directly (no Claude)
 * @property {string|null}  localCallType — emit_macro_call type for local calls
 * @property {boolean} claudeWorthy  — Whether this should invoke Claude
 */
class TriggerDetector {
  // ── Team identity ──
  /** @type {string|null} "ORDER" or "CHAOS" */
  #localTeam = null;
  /** @type {string|null} */
  #localPlayerName = null;
  /** @type {Map<string, string>} playerName → team */
  #playerTeamMap = new Map();

  // ── Gold tracking ──
  /** @type {{ gameTime: number, allyGold: number, enemyGold: number }[]} */
  #goldHistory = [];
  /** Last gold lead sent as a trigger (for >1000 swing detection) */
  #lastReportedGoldLead = 0;

  // ── Drake tracking ──
  #allyDrakeCount = 0;
  #enemyDrakeCount = 0;
  #lastDrakeKillTime = 0;

  // ── Baron tracking ──
  #lastBaronKillTime = 0;
  static #BARON_SPAWN_TIME = 1200; // 20:00 game time
  static #BARON_RESPAWN_TIME = 360; // 6 minutes

  // ── Death event tracking (for Throw-Guard) ──
  /** @type {number[]} gameTime values when allies died (pruned to last 30s) */
  #recentAllyDeathTimes = [];

  // ── Turret tracking — per-team per-lane destroyed count ──
  /** @type {Map<string, number>} "ORDER:top" → count */
  #turretsDestroyed = new Map();

  // ── Inhibitor tracking ──
  /** @type {Set<string>} lane names with OUR inhibs down */
  #allyInhibsDown = new Set();
  /** @type {Set<string>} lane names with ENEMY inhibs down */
  #enemyInhibsDown = new Set();

  // ── Power spike tracking ──
  /** @type {Map<string, number>} playerName → last known level */
  #playerLevels = new Map();

  // ── Event dedup ──
  /** @type {Set<string>} */
  #seenEventIds = new Set();

  // ---------------------------------------------------------------------------
  // Public — State getters (for agent context building)
  // ---------------------------------------------------------------------------

  get allyDrakeCount() { return this.#allyDrakeCount; }
  get enemyDrakeCount() { return this.#enemyDrakeCount; }
  get allyInhibsDown() { return [...this.#allyInhibsDown]; }
  get enemyInhibsDown() { return [...this.#enemyInhibsDown]; }
  get localTeam() { return this.#localTeam; }

  /**
   * @param {number} gameTime
   * @returns {boolean}
   */
  isBaronUp(gameTime) {
    if (gameTime < TriggerDetector.#BARON_SPAWN_TIME) return false;
    if (this.#lastBaronKillTime === 0) return true; // Never killed → first spawn
    return gameTime >= this.#lastBaronKillTime + TriggerDetector.#BARON_RESPAWN_TIME;
  }

  /**
   * Reset all state for a new game.
   */
  reset() {
    this.#localTeam = null;
    this.#localPlayerName = null;
    this.#playerTeamMap.clear();
    this.#goldHistory = [];
    this.#lastReportedGoldLead = 0;
    this.#allyDrakeCount = 0;
    this.#enemyDrakeCount = 0;
    this.#lastDrakeKillTime = 0;
    this.#lastBaronKillTime = 0;
    this.#recentAllyDeathTimes = [];
    this.#turretsDestroyed.clear();
    this.#allyInhibsDown.clear();
    this.#enemyInhibsDown.clear();
    this.#playerLevels.clear();
    this.#seenEventIds.clear();
  }

  // ---------------------------------------------------------------------------
  // Snapshot evaluation — runs every 10 seconds
  // ---------------------------------------------------------------------------

  /**
   * Evaluate a full game snapshot for triggers.
   * @param {Object} snapshot — AllGameData from Live Client API
   * @returns {TriggerResult[]}
   */
  evaluateSnapshot(snapshot) {
    const triggers = [];
    if (!snapshot?.allPlayers?.length || !snapshot.activePlayer) return triggers;

    const gameTime = snapshot.gameData?.gameTime || 0;

    // ── Identify local team on first snapshot ──
    if (!this.#localTeam) {
      this.#localPlayerName =
        snapshot.activePlayer.riotId || snapshot.activePlayer.summonerName;
      const local = snapshot.allPlayers.find(
        (p) => (p.riotId || p.summonerName) === this.#localPlayerName
      );
      if (local) this.#localTeam = local.team;
    }
    if (!this.#localTeam) return triggers;

    // Build player→team map (for event attribution)
    for (const p of snapshot.allPlayers) {
      const name = p.riotId || p.summonerName || p.championName;
      this.#playerTeamMap.set(name, p.team);
    }

    const allies = snapshot.allPlayers.filter((p) => p.team === this.#localTeam);
    const enemies = snapshot.allPlayers.filter((p) => p.team !== this.#localTeam);
    const enemyJungler = enemies.find((p) => p.position === "JUNGLE");

    // Gold estimation
    const allyGold = this.#estimateTeamGold(allies);
    const enemyGold = this.#estimateTeamGold(enemies);
    const goldLead = allyGold - enemyGold;

    this.#goldHistory.push({ gameTime, allyGold, enemyGold });
    if (this.#goldHistory.length > 20) this.#goldHistory = this.#goldHistory.slice(-15);

    const baronUp = this.isBaronUp(gameTime);

    // Prune old ally death events (keep last 30 seconds)
    this.#recentAllyDeathTimes = this.#recentAllyDeathTimes.filter(
      (t) => gameTime - t < 30
    );

    // ── 1. THROW GUARD ──────────────────────────────────────────────────────
    // Gold lead > 3000 but 2+ allies died in last 30s → bounty risk
    if (goldLead > 3000 && this.#recentAllyDeathTimes.length >= 2) {
      triggers.push({
        trigger: MacroTrigger.THROW_GUARD,
        detail: `Up ${Math.round(goldLead)} gold but ${this.#recentAllyDeathTimes.length} allies died in last 30s — bounty risk`,
        urgency: "urgent",
        localCall: "RESET NOW — DON'T THROW BOUNTY",
        localCallType: "RESET_NOW",
        claudeWorthy: false,
      });
    }

    // ── 2. BARON / SOUL CALLS ───────────────────────────────────────────────
    // RIOT POLICY: Only use publicly visible data. Death state + respawn timers
    // are visible to all players in the scoreboard — this is NOT fog-of-war data.
    if (baronUp && gameTime >= TriggerDetector.#BARON_SPAWN_TIME) {
      // 2a. Enemy Jungler confirmed dead > 15s — Baron window
      if (enemyJungler && enemyJungler.isDead && enemyJungler.respawnTimer > 15) {
        triggers.push({
          trigger: MacroTrigger.BARON_WINDOW,
          detail: `Enemy JG (${enemyJungler.championName}) dead for ${Math.round(enemyJungler.respawnTimer)}s — Baron window open`,
          urgency: "urgent",
          localCall: null,
          localCallType: null,
          claudeWorthy: true,
        });
      }

      // 2b. Enemy on Soul Point (3 drakes) + Baron up → CONTEST SOUL
      if (this.#enemyDrakeCount >= 3) {
        triggers.push({
          trigger: MacroTrigger.CONTEST_SOUL,
          detail: `Enemy has ${this.#enemyDrakeCount} drakes (Soul Point) — must contest next drake`,
          urgency: "urgent",
          localCall: "CONTEST SOUL — Enemy on Soul Point",
          localCallType: "CONTEST_OBJECTIVE",
          claudeWorthy: false,
        });
      }

      // 2c. WE are on Soul Point (3 drakes) + Baron up → RUSH BARON
      if (this.#allyDrakeCount >= 3) {
        triggers.push({
          trigger: MacroTrigger.RUSH_BARON,
          detail: `We have ${this.#allyDrakeCount} drakes (Soul Point) — rush Baron to force enemy into lose-lose`,
          urgency: "urgent",
          localCall: "RUSH BARON — Force lose-lose trade",
          localCallType: "BARON_CALL",
          claudeWorthy: false,
        });
      }
    }

    // ── 3. SIDE-LANE AUDITOR ────────────────────────────────────────────────
    if (gameTime > 840) {
      const waveTrigger = this.#checkSideLanePressure(allies, gameTime);
      if (waveTrigger) triggers.push(waveTrigger);
    }

    // ── 4. WIN CONDITION — Nexus Check (Late-Game) ──────────────────────────
    if (gameTime > 1500) {
      const winCondition = this.#checkWinCondition(enemies, enemyJungler);
      if (winCondition) triggers.push(winCondition);
    }

    // ── 5. INHIB PRESSURE — Baron Bait vs Baron Rush ────────────────────────
    if (
      this.#enemyInhibsDown.size > 0 &&
      baronUp &&
      gameTime >= TriggerDetector.#BARON_SPAWN_TIME
    ) {
      // Don't overlap with RUSH_BARON trigger
      if (this.#allyDrakeCount < 3) {
        triggers.push({
          trigger: MacroTrigger.BARON_BAIT,
          detail: `Enemy inhib down (${[...this.#enemyInhibsDown].join(", ")}) — bait Baron to punish face-checks`,
          urgency: "suggestion",
          localCall: "BARON BAIT — Inhib down, punish face-checks",
          localCallType: "BARON_BAIT",
          claudeWorthy: false,
        });
      }
    }

    // ── 6. ACE ──────────────────────────────────────────────────────────────
    if (enemies.length > 0 && enemies.every((p) => p.isDead)) {
      triggers.push({
        trigger: MacroTrigger.ACE,
        detail: "Enemy team ACED — push for objectives",
        urgency: "urgent",
        localCall: null,
        localCallType: null,
        claudeWorthy: true,
      });
    }

    // ── 7. GOLD SWING > 1000 ────────────────────────────────────────────────
    const goldSwing = Math.abs(goldLead - this.#lastReportedGoldLead);
    if (goldSwing >= 1000) {
      const direction = goldLead > this.#lastReportedGoldLead ? "in our favor" : "against us";
      this.#lastReportedGoldLead = goldLead;
      triggers.push({
        trigger: MacroTrigger.GOLD_SWING,
        detail: `Gold lead changed by ${Math.round(goldSwing)} ${direction} (now ${goldLead > 0 ? "+" : ""}${Math.round(goldLead)})`,
        urgency: "suggestion",
        localCall: null,
        localCallType: null,
        claudeWorthy: true,
      });
    }

    // ── 8. LONG DEATH TIMERS (2+ enemies dead > 30s) ────────────────────────
    const longDead = enemies.filter((p) => p.isDead && p.respawnTimer > 30);
    if (longDead.length >= 2) {
      triggers.push({
        trigger: MacroTrigger.DEATH_TIMER_LONG,
        detail: `${longDead.length} enemies dead >30s: ${longDead.map((p) => p.championName).join(", ")}`,
        urgency: "suggestion",
        localCall: null,
        localCallType: null,
        claudeWorthy: true,
      });
    }

    // ── 9. POWER SPIKE (level 6/11/16) ──────────────────────────────────────
    const level = snapshot.activePlayer.level;
    const name = this.#localPlayerName || "local";
    const prevLevel = this.#playerLevels.get(name) || 0;
    if (level !== prevLevel) {
      this.#playerLevels.set(name, level);
      if ([6, 11, 16].includes(level) && prevLevel < level) {
        triggers.push({
          trigger: MacroTrigger.POWER_SPIKE,
          detail: `${snapshot.activePlayer.championName || "You"} hit level ${level} — ultimate power spike`,
          urgency: "info",
          localCall: null,
          localCallType: null,
          claudeWorthy: false,
        });
      }
    }

    return triggers;
  }

  // ---------------------------------------------------------------------------
  // Event evaluation — runs every 5 seconds (via Live Client event poll)
  // ---------------------------------------------------------------------------

  /**
   * Evaluate new game events. Updates internal state (drake count, turret/inhib
   * tracking, ally death times) and returns triggers for significant events.
   * @param {Object[]} events — New GameEvent objects
   * @returns {TriggerResult[]}
   */
  evaluateEvents(events) {
    const triggers = [];

    for (const event of events) {
      const eventKey = `${event.EventName}:${event.EventID}`;
      if (this.#seenEventIds.has(eventKey)) continue;
      this.#seenEventIds.add(eventKey);

      switch (event.EventName) {
        // ── Champion Kill — track ally deaths for Throw-Guard ──
        case "ChampionKill": {
          const victimTeam = this.#getPlayerTeam(event.VictimName);
          if (victimTeam === this.#localTeam) {
            this.#recentAllyDeathTimes.push(event.EventTime);
          }
          break;
        }

        // ── Dragon Kill — track per-team drake count ──
        case "DragonKill": {
          this.#lastDrakeKillTime = event.EventTime;
          const drakeKillerTeam = this.#getPlayerTeam(event.KillerName);
          if (drakeKillerTeam === this.#localTeam) {
            this.#allyDrakeCount++;
          } else if (drakeKillerTeam) {
            this.#enemyDrakeCount++;
          }

          triggers.push({
            trigger: MacroTrigger.OBJECTIVE_TAKEN,
            detail: `${event.DragonType || "Dragon"} taken by ${event.KillerName} (Ally: ${this.#allyDrakeCount}, Enemy: ${this.#enemyDrakeCount})`,
            urgency: "suggestion",
            localCall: null,
            localCallType: null,
            claudeWorthy: true,
          });
          break;
        }

        // ── Baron Kill ──
        case "BaronKill": {
          this.#lastBaronKillTime = event.EventTime;
          const stolen = event.Stolen === "True";

          triggers.push({
            trigger: MacroTrigger.OBJECTIVE_TAKEN,
            detail: `Baron ${stolen ? "STOLEN by" : "taken by"} ${event.KillerName}`,
            urgency: "urgent",
            localCall: null,
            localCallType: null,
            claudeWorthy: true,
          });
          break;
        }

        // ── Herald Kill ──
        case "HeraldKill": {
          triggers.push({
            trigger: MacroTrigger.OBJECTIVE_TAKEN,
            detail: `Rift Herald taken by ${event.KillerName}`,
            urgency: "info",
            localCall: null,
            localCallType: null,
            claudeWorthy: true,
          });
          break;
        }

        // ── Turret Kill — track per-lane turret state ──
        case "TurretKilled": {
          const turretName = event.TurretKilled || "";
          const turretTeam = this.#parseTurretTeam(turretName);
          const turretLane = this.#parseTurretLane(turretName);

          if (turretTeam && turretLane) {
            const key = `${turretTeam}:${turretLane}`;
            this.#turretsDestroyed.set(key, (this.#turretsDestroyed.get(key) || 0) + 1);
          }

          triggers.push({
            trigger: MacroTrigger.TOWER_DESTROYED,
            detail: `Tower destroyed: ${turretName} by ${event.KillerName}`,
            urgency: "info",
            localCall: null,
            localCallType: null,
            claudeWorthy: false,
          });
          break;
        }

        // ── Inhibitor Kill — track inhib state ──
        case "InhibKilled": {
          const inhibName = event.InhibKilled || "";
          const inhibTeam = this.#parseInhibTeam(inhibName);
          const inhibLane = this.#parseInhibLane(inhibName);

          if (inhibTeam && inhibLane) {
            if (inhibTeam === this.#localTeam) {
              this.#allyInhibsDown.add(inhibLane);
            } else {
              this.#enemyInhibsDown.add(inhibLane);
            }
          }

          triggers.push({
            trigger: MacroTrigger.INHIB_KILLED,
            detail: `Inhibitor destroyed: ${inhibName} by ${event.KillerName}`,
            urgency: "suggestion",
            localCall: null,
            localCallType: null,
            claudeWorthy: true,
          });
          break;
        }

        // ── Inhibitor Respawn — clear inhib state ──
        case "InhibRespawned": {
          const rInhibName = event.InhibRespawned || event.InhibKilled || "";
          const rInhibTeam = this.#parseInhibTeam(rInhibName);
          const rInhibLane = this.#parseInhibLane(rInhibName);

          if (rInhibTeam && rInhibLane) {
            if (rInhibTeam === this.#localTeam) {
              this.#allyInhibsDown.delete(rInhibLane);
            } else {
              this.#enemyInhibsDown.delete(rInhibLane);
            }
          }
          break;
        }
      }
    }

    return triggers;
  }

  // ---------------------------------------------------------------------------
  // Private — Tactical trigger logic
  // ---------------------------------------------------------------------------

  /**
   * Side-Lane Auditor: detect unattended side lane pressure.
   *
   * Approximation: if we've lost 2+ turrets in a side lane (inner turret or
   * beyond is down) and the assigned lane ally is dead, waves are crashing
   * with nobody to catch them.
   *
   * NOTE: The Live Client API does NOT expose minion positions. We use
   * turret state + lane ally death as a proxy for "wave crashing on T2."
   */
  #checkSideLanePressure(allies, gameTime) {
    const sideLanes = ["top", "bot"];

    for (const lane of sideLanes) {
      const key = `${this.#localTeam}:${lane}`;
      const turretsLost = this.#turretsDestroyed.get(key) || 0;

      // Inner turret or deeper is down → waves push into our base
      if (turretsLost < 2) continue;

      const role = lane === "top" ? "TOP" : "BOTTOM";
      const laneAlly = allies.find((p) => p.position === role);

      if (laneAlly && laneAlly.isDead) {
        return {
          trigger: MacroTrigger.CATCH_WAVE,
          detail: `${lane.toUpperCase()} lane: ${turretsLost} turrets down, ${laneAlly.championName} dead — wave crashing`,
          urgency: "suggestion",
          localCall: `CATCH ${lane.toUpperCase()} WAVE — Turrets exposed`,
          localCallType: "CATCH_WAVE",
          claudeWorthy: false,
        };
      }
    }

    return null;
  }

  /**
   * Nexus Check: if the enemy Jungler + 2 others are dead with long respawns,
   * and we have turret advantage to push, calculate whether we can end.
   *
   * Travel time estimate = (remaining structures × 18s) + 10s for nexus.
   * If the estimated push time < minimum enemy respawn timer → WIN CONDITION.
   */
  #checkWinCondition(enemies, enemyJungler) {
    const deadEnemies = enemies.filter((p) => p.isDead);
    if (deadEnemies.length < 3) return null;

    // Need the enemy jungler among the dead
    if (!enemyJungler || !enemyJungler.isDead) return null;

    // Minimum respawn timer of all dead enemies
    const minRespawn = Math.min(...deadEnemies.map((p) => p.respawnTimer || 0));
    if (minRespawn < 15) return null; // Respawning too soon

    // Estimate push time: find lane with most enemy turrets already down
    const enemyTeam = enemies[0]?.team;
    if (!enemyTeam) return null;

    let bestLaneTurretsDown = 0;
    for (const lane of ["top", "mid", "bot"]) {
      const key = `${enemyTeam}:${lane}`;
      const down = this.#turretsDestroyed.get(key) || 0;
      if (down > bestLaneTurretsDown) bestLaneTurretsDown = down;
    }

    // 5 structures total per lane: outer + inner + inhib + 2 nexus turrets
    const structuresRemaining = Math.max(0, 5 - bestLaneTurretsDown);
    let estimatedPushTime = structuresRemaining * 18 + 10; // +10s for nexus

    // Inhib already down → super minions help, push faster
    if (this.#enemyInhibsDown.size > 0) {
      estimatedPushTime = Math.round(estimatedPushTime * 0.7);
    }

    if (estimatedPushTime < minRespawn) {
      return {
        trigger: MacroTrigger.WIN_CONDITION,
        detail: `${deadEnemies.length} enemies dead (${Math.round(minRespawn)}s min respawn) — est. push ${Math.round(estimatedPushTime)}s — END THE GAME`,
        urgency: "urgent",
        localCall: "WIN CONDITION ACTIVE — PUSH TO END",
        localCallType: "WIN_CONDITION",
        claudeWorthy: false,
      };
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Private — Helpers
  // ---------------------------------------------------------------------------

  /**
   * Estimate team gold from CS, kills, and assists.
   * This is approximate since the API doesn't expose actual gold totals
   * for all players — only the active player's currentGold is available.
   */
  #estimateTeamGold(players) {
    return players.reduce((sum, p) => {
      const s = p.scores || {};
      return (
        sum +
        (s.creepScore || 0) * 20 +
        (s.kills || 0) * 300 +
        (s.assists || 0) * 150
      );
    }, 0);
  }

  /**
   * Look up which team a player belongs to.
   * Falls back to checking champion names if summoner name isn't mapped.
   */
  #getPlayerTeam(name) {
    return this.#playerTeamMap.get(name) || null;
  }

  /**
   * Parse turret team from name like "Turret_T1_R_03_A".
   * T1 = ORDER (blue side), T2 = CHAOS (red side).
   */
  #parseTurretTeam(name) {
    if (name.includes("T1")) return "ORDER";
    if (name.includes("T2")) return "CHAOS";
    return null;
  }

  /**
   * Parse turret lane: R = bot, L = top, C = mid.
   */
  #parseTurretLane(name) {
    if (name.includes("_R_") || name.includes("_R1") || name.includes("_R2")) return "bot";
    if (name.includes("_L_") || name.includes("_L1") || name.includes("_L2")) return "top";
    if (name.includes("_C_") || name.includes("_C1") || name.includes("_C2")) return "mid";
    return null;
  }

  /**
   * Parse inhib team from name like "Barracks_T1_L1".
   */
  #parseInhibTeam(name) {
    if (name.includes("T1")) return "ORDER";
    if (name.includes("T2")) return "CHAOS";
    return null;
  }

  /**
   * Parse inhib lane from name like "Barracks_T1_L1".
   * L = top, C = mid, R = bot.
   */
  #parseInhibLane(name) {
    if (name.includes("_L")) return "top";
    if (name.includes("_C")) return "mid";
    if (name.includes("_R")) return "bot";
    return null;
  }
}

module.exports = { TriggerDetector, MacroTrigger };
