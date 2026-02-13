const { BaseAgent } = require("../base-agent");
const { SYSTEM_PROMPT, TOOLS } = require("./prompt");
const { TriggerDetector } = require("./triggers");
const { IPC_CHANNELS } = require("../../../shared/ipc-channels");
const { logger } = require("../../utils/logger");

/**
 * Macro Strategist — Agent 2.
 *
 * Active during IN_GAME. Polls Live Client Data every 10 seconds,
 * evaluates tactical triggers (Throw-Guard, Baron/Soul, Side-Lane,
 * Win Condition, Inhib Pressure), and dispatches either:
 *   - LOCAL calls (instant, deterministic) — emitted directly to overlay
 *   - CLAUDE calls (strategic, nuanced) — forwarded to Claude for analysis
 *
 * 60-second global cooldown between any advice to prevent screen clutter.
 * Red/Gold high-contrast urgent toasts for win-condition calls.
 */
class MacroStrategist extends BaseAgent {
  /** @type {import('../../integrations/riot/live-client').LiveClientAPI} */
  #liveClient;

  /** @type {TriggerDetector} */
  #triggerDetector;

  /** @type {Object | null} Cached latest snapshot */
  #latestSnapshot = null;

  /** @type {Object[]} Recent events for context */
  #recentEvents = [];

  /** @type {number} Timestamp of last advice sent (local OR Claude) */
  #lastAdviceTime = 0;

  /** Minimum ms between any tactical advice (60 seconds) */
  #MIN_ADVICE_INTERVAL = 60000;

  /** Whether a Claude invocation is currently in flight */
  #invoking = false;

  /** @type {Function | null} Snapshot listener ref for cleanup */
  #onSnapshot = null;

  /** @type {Function | null} Event listener ref for cleanup */
  #onNewEvents = null;

  /** Macro call counter for unique IDs */
  #callCounter = 0;

  /**
   * @param {Object} deps — BaseAgent deps + liveClient
   * @param {import('../../integrations/riot/live-client').LiveClientAPI} deps.liveClient
   */
  constructor(deps) {
    super(deps);
    this.#liveClient = deps.liveClient;
    this.#triggerDetector = new TriggerDetector();
  }

  get name() {
    return "macro-strategist";
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
    logger.info("[Macro Strategist] Game detected — activating pipeline.");
    this.#triggerDetector.reset();
    this.#latestSnapshot = null;
    this.#recentEvents = [];
    this.#lastAdviceTime = 0;
    this.#invoking = false;
    this.#callCounter = 0;

    // Wire up snapshot listener
    this.#onSnapshot = (snapshot) => this.#handleSnapshot(snapshot);
    this.#liveClient.on("snapshot", this.#onSnapshot);

    // Wire up event listener
    this.#onNewEvents = (events) => this.#handleNewEvents(events);
    this.#liveClient.on("new-events", this.#onNewEvents);

    // Start polling: 10s snapshots, 5s events
    this.#liveClient.startPolling(10000, 5000);
  }

  async onDeactivate() {
    this.#liveClient.stopPolling();

    if (this.#onSnapshot) {
      this.#liveClient.removeListener("snapshot", this.#onSnapshot);
      this.#onSnapshot = null;
    }
    if (this.#onNewEvents) {
      this.#liveClient.removeListener("new-events", this.#onNewEvents);
      this.#onNewEvents = null;
    }

    this.#triggerDetector.reset();
    this.#invoking = false;
    logger.info("[Macro Strategist] Deactivated.");
  }

  // ---------------------------------------------------------------------------
  // Tool handlers — called by Claude via BaseAgent.invoke()
  // ---------------------------------------------------------------------------

  async handleToolCall(toolName, toolInput) {
    switch (toolName) {
      case "get_game_snapshot":
        return this.#handleGetSnapshot(toolInput);

      case "emit_macro_call":
        return this.#handleEmitMacroCall(toolInput);

      default:
        return { error: `Unknown tool: ${toolName}` };
    }
  }

  // ---------------------------------------------------------------------------
  // Tool implementations
  // ---------------------------------------------------------------------------

  /**
   * get_game_snapshot — returns enriched game state with macro context.
   */
  #handleGetSnapshot({ include_items = true, include_events = true } = {}) {
    if (!this.#latestSnapshot) {
      return { error: "No snapshot available yet" };
    }

    const snap = this.#latestSnapshot;
    const gameTime = snap.gameData?.gameTime || 0;
    const gamePhase =
      gameTime < 840 ? "early" : gameTime < 1500 ? "mid" : "late";

    return {
      game_time: Math.round(gameTime),
      game_phase: gamePhase,
      game_time_formatted: `${Math.floor(gameTime / 60)}:${String(Math.floor(gameTime % 60)).padStart(2, "0")}`,
      active_player: {
        champion: snap.activePlayer.championName,
        level: snap.activePlayer.level,
        current_gold: snap.activePlayer.currentGold,
        stats: snap.activePlayer.championStats,
      },
      players: snap.allPlayers.map((p) => ({
        champion: p.championName,
        team: p.team,
        level: p.level,
        position: p.position,
        isDead: p.isDead,
        respawnTimer: p.respawnTimer ? Math.round(p.respawnTimer) : 0,
        scores: p.scores,
        items: include_items
          ? (p.items || []).map((i) => i.displayName)
          : undefined,
      })),
      // Macro state
      drake_count: {
        ally: this.#triggerDetector.allyDrakeCount,
        enemy: this.#triggerDetector.enemyDrakeCount,
      },
      baron_up: this.#triggerDetector.isBaronUp(gameTime),
      enemy_inhibs_down: this.#triggerDetector.enemyInhibsDown,
      ally_inhibs_down: this.#triggerDetector.allyInhibsDown,
      recent_events: include_events
        ? this.#recentEvents.slice(-15)
        : undefined,
    };
  }

  /**
   * emit_macro_call — Claude's primary output tool.
   * Sends a toast notification to the macro overlay.
   */
  #handleEmitMacroCall({ type, urgency, message, window_seconds = 15 }) {
    this.#callCounter++;

    const macroCall = {
      id: `macro-${Date.now()}-${this.#callCounter}`,
      timestamp: Date.now(),
      game_time: this.#latestSnapshot?.gameData?.gameTime || 0,
      call_type: type,
      urgency,
      message: this.#formatCallMessage(type, message),
      reasoning: message,
      window_seconds,
    };

    logger.info("[Macro Strategist] Macro call (Claude)", macroCall);
    this.sendToOverlay(IPC_CHANNELS.MACRO_CALL, macroCall);

    return { status: "displayed", type, urgency };
  }

  // ---------------------------------------------------------------------------
  // Data pipeline
  // ---------------------------------------------------------------------------

  /**
   * Handle a new full game snapshot from Live Client API (every 10s).
   *
   * Evaluates all tactical triggers, then dispatches the highest-priority
   * trigger as either a local instant call or a Claude invocation.
   * Respects the 60-second global advice cooldown.
   */
  #handleSnapshot(snapshot) {
    this.#latestSnapshot = snapshot;
    if (!snapshot?.allPlayers?.length || !snapshot.activePlayer) return;

    // Evaluate all triggers against current game state
    const triggers = this.#triggerDetector.evaluateSnapshot(snapshot);
    if (triggers.length === 0) return;

    // Check global 60s advice cooldown
    const now = Date.now();
    if (now - this.#lastAdviceTime < this.#MIN_ADVICE_INTERVAL) {
      logger.debug("[Macro Strategist] Triggers active but rate-limited", {
        triggers: triggers.map((t) => t.trigger),
        cooldownRemainingMs:
          this.#MIN_ADVICE_INTERVAL - (now - this.#lastAdviceTime),
      });
      return;
    }

    // Sort by urgency priority: urgent > suggestion > info
    const priorityOrder = { urgent: 0, suggestion: 1, info: 2 };
    triggers.sort(
      (a, b) => (priorityOrder[a.urgency] ?? 3) - (priorityOrder[b.urgency] ?? 3)
    );

    // Process the highest-priority trigger
    const top = triggers[0];

    if (top.localCall) {
      // ── LOCAL DISPATCH: Deterministic call, emit instantly ──
      this.#emitLocalCall(top);
    } else if (top.claudeWorthy) {
      // ── CLAUDE DISPATCH: Strategic call, needs analysis ──
      this.#maybeInvokeClaude(triggers.filter((t) => t.claudeWorthy));
    }
  }

  /**
   * Handle new game events from Live Client API (every 5s).
   *
   * Events update internal state (drake count, turret/inhib tracking,
   * ally deaths) and may trigger Claude-worthy invocations for major
   * objectives (Dragon, Baron, Herald, Inhibitor).
   */
  #handleNewEvents(events) {
    // Store all events for context
    for (const e of events) {
      this.#recentEvents.push({
        EventName: e.EventName,
        EventTime: e.EventTime,
        KillerName: e.KillerName,
        VictimName: e.VictimName,
        DragonType: e.DragonType,
        TurretKilled: e.TurretKilled,
        InhibKilled: e.InhibKilled,
      });
    }

    // Keep only last 30 events
    if (this.#recentEvents.length > 30) {
      this.#recentEvents = this.#recentEvents.slice(-30);
    }

    // Evaluate event triggers (updates drake count, turret state, etc.)
    const triggers = this.#triggerDetector.evaluateEvents(events);
    if (triggers.length === 0) return;

    // Check 60s cooldown
    const now = Date.now();
    if (now - this.#lastAdviceTime < this.#MIN_ADVICE_INTERVAL) {
      logger.debug("[Macro Strategist] Event triggers rate-limited", {
        triggers: triggers.map((t) => t.trigger),
      });
      return;
    }

    // Only forward Claude-worthy event triggers
    const claudeWorthy = triggers.filter((t) => t.claudeWorthy);
    if (claudeWorthy.length > 0) {
      this.#maybeInvokeClaude(claudeWorthy);
    }
  }

  // ---------------------------------------------------------------------------
  // Dispatch — Local calls (instant) and Claude calls (strategic)
  // ---------------------------------------------------------------------------

  /**
   * Emit a local macro call directly to the overlay.
   * No Claude invocation — deterministic, instant.
   * @param {import('./triggers').TriggerResult} trigger
   */
  #emitLocalCall(trigger) {
    this.#lastAdviceTime = Date.now();
    this.#callCounter++;

    const macroCall = {
      id: `macro-${Date.now()}-${this.#callCounter}`,
      timestamp: Date.now(),
      game_time: this.#latestSnapshot?.gameData?.gameTime || 0,
      call_type: trigger.localCallType,
      urgency: trigger.urgency,
      message: trigger.localCall,
      reasoning: trigger.detail,
      window_seconds: trigger.urgency === "urgent" ? 20 : 15,
    };

    logger.info("[Macro Strategist] Local macro call", macroCall);
    this.sendToOverlay(IPC_CHANNELS.MACRO_CALL, macroCall);
  }

  /**
   * Rate-limited Claude invocation for strategic triggers.
   * @param {import('./triggers').TriggerResult[]} triggers
   */
  async #maybeInvokeClaude(triggers) {
    if (this.#invoking) return;
    if (!this.#latestSnapshot) return;

    this.#invoking = true;
    this.#lastAdviceTime = Date.now();

    const context = this.#buildContext(triggers);

    try {
      await this.invoke(context, "IN_GAME");
    } catch (err) {
      logger.error("[Macro Strategist] Claude invocation failed", {
        error: err.message,
      });
    } finally {
      this.#invoking = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Context building — enriched game state for Claude
  // ---------------------------------------------------------------------------

  /**
   * Build context message for Claude with triggers, macro state, and
   * game overview. Gives Claude enough info to make a strategic call
   * without needing to call get_game_snapshot in most cases.
   */
  #buildContext(triggers) {
    const snap = this.#latestSnapshot;
    const gameTime = snap?.gameData?.gameTime || 0;
    const gamePhase =
      gameTime < 840 ? "early" : gameTime < 1500 ? "mid" : "late";

    const context = {
      game_time: Math.round(gameTime),
      game_time_formatted: `${Math.floor(gameTime / 60)}:${String(Math.floor(gameTime % 60)).padStart(2, "0")}`,
      game_phase: gamePhase,
      triggers: triggers.map((t) => ({
        type: t.trigger,
        detail: t.detail,
        urgency: t.urgency,
      })),
      // Macro state
      drake_count: {
        ally: this.#triggerDetector.allyDrakeCount,
        enemy: this.#triggerDetector.enemyDrakeCount,
      },
      baron_up: this.#triggerDetector.isBaronUp(gameTime),
      enemy_inhibs_down: this.#triggerDetector.enemyInhibsDown,
      ally_inhibs_down: this.#triggerDetector.allyInhibsDown,
      active_player: {
        champion: snap.activePlayer?.championName,
        level: snap.activePlayer?.level,
      },
      instructions:
        "Analyze the triggers and macro state. Use get_game_snapshot for full data if needed. Emit ONE clear call via emit_macro_call. Max 80 chars for message.",
    };

    return `MACRO STATE UPDATE:\n${JSON.stringify(context, null, 2)}`;
  }

  // ---------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------

  /**
   * Format a short display message from call type and reasoning.
   */
  #formatCallMessage(callType, message) {
    const labels = {
      CONTEST_OBJECTIVE: "Contest Objective",
      SPLIT_PUSH: "Split Push",
      GROUP_MID: "Group Mid",
      RESET_NOW: "Reset Now",
      PLAY_SAFE: "Play Safe",
      FORCE_FIGHT: "Force Fight",
      SET_UP_VISION: "Set Up Vision",
      TAKE_TOWER: "Take Tower",
      INVADE_JUNGLE: "Invade Jungle",
      BARON_CALL: "Baron Call",
      CATCH_WAVE: "Catch Wave",
      WIN_CONDITION: "Win Condition",
      BARON_BAIT: "Baron Bait",
    };

    const label = labels[callType] || callType;
    const short =
      message.length > 60 ? message.substring(0, 57) + "..." : message;
    return `${label} — ${short}`;
  }
}

module.exports = { MacroStrategist };
