const { BaseAgent } = require("../base-agent");
const { SYSTEM_PROMPT, TOOLS } = require("./prompt");
const { IPC_CHANNELS } = require("../../../shared/ipc-channels");
const { queries } = require("../../data/db");
const { getChampionName, getPatchVersion } = require("../../summoner-detector");
const { logger } = require("../../utils/logger");

/**
 * Drafting Oracle — Agent 1.
 *
 * Active during CHAMP_SELECT. Polls the LCU champ select session,
 * fetches enemy player data from the Riot Cloud API, and uses Claude
 * to produce ban/pick recommendations sent to the draft overlay.
 */
class DraftingOracle extends BaseAgent {
  /** @type {import('../../riot-api-client').RiotApiClient} */
  #riotApi;

  /** @type {NodeJS.Timeout | null} */
  #pollTimer = null;

  /** Tracks the last action state so we only invoke Claude on changes */
  #lastActionHash = "";

  /** Cached enemy data so we don't re-fetch every poll */
  #enemyDataCache = new Map();

  /** Local player cell ID */
  #localCellId = -1;

  /** Whether an invocation is currently in flight (prevents overlap) */
  #invoking = false;

  /** Whether the local player has locked in (audit closed) */
  #finalized = false;

  /**
   * @param {Object} deps — Same deps as BaseAgent, plus riotApi
   * @param {import('../../riot-api-client').RiotApiClient} deps.riotApi
   */
  constructor(deps) {
    super(deps);
    this.#riotApi = deps.riotApi;
  }

  get name() {
    return "drafting-oracle";
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
    logger.info("[Drafting Oracle] Champ select detected — activating pipeline.");
    this.#enemyDataCache.clear();
    this.#lastActionHash = "";
    this.#invoking = false;
    this.#finalized = false;

    // Poll the champ select session every 3 seconds
    this.#pollTimer = setInterval(() => this.#pollChampSelect(), 3000);

    // Also do an immediate poll
    await this.#pollChampSelect();
  }

  async onDeactivate() {
    if (this.#pollTimer) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = null;
    }
    this.#enemyDataCache.clear();
    this.#invoking = false;
    this.#finalized = false;
    logger.info("[Drafting Oracle] Deactivated.");
  }

  // ---------------------------------------------------------------------------
  // Tool handlers — called by Claude via BaseAgent.invoke()
  // ---------------------------------------------------------------------------

  async handleToolCall(toolName, toolInput) {
    switch (toolName) {
      case "get_enemy_champion_pools":
        return this.#handleGetEnemyPools(toolInput);

      case "get_meta_tier_list":
        return this.#handleGetMetaTierList(toolInput);

      case "analyze_team_composition":
        return this.#handleAnalyzeComp(toolInput);

      case "suggest_ban":
        return this.#handleSuggestBan(toolInput);

      case "suggest_pick":
        return this.#handleSuggestPick(toolInput);

      default:
        return { error: `Unknown tool: ${toolName}` };
    }
  }

  // ---------------------------------------------------------------------------
  // Tool implementations
  // ---------------------------------------------------------------------------

  async #handleGetEnemyPools({ summoner_puuid, top_n = 5 }) {
    // 1. Check in-memory cache (current champ select session)
    if (this.#enemyDataCache.has(summoner_puuid)) {
      return this.#enemyDataCache.get(summoner_puuid);
    }

    // 2. Check SQLite cache (same Yasuo main twice in one night? use cached data)
    const cached = queries.getCachedEnemyAnalysis(summoner_puuid);
    if (cached) {
      logger.info("[Drafting Oracle] Enemy analysis cache HIT", { puuid: summoner_puuid });
      this.#enemyDataCache.set(summoner_puuid, cached);
      return cached;
    }

    // 3. Cache MISS — fetch from Riot API
    logger.info("[Drafting Oracle] Enemy analysis cache MISS — fetching from Riot API", { puuid: summoner_puuid });
    try {
      const masteries = await this.#riotApi.getTopMasteries(summoner_puuid, top_n);
      const result = {
        puuid: summoner_puuid,
        top_champions: masteries.map((m) => ({
          champion: getChampionName(m.championId),
          championId: m.championId,
          mastery_level: m.championLevel,
          mastery_points: m.championPoints,
          is_one_trick: m.championPoints > 100000,
        })),
      };

      // Store in both caches
      this.#enemyDataCache.set(summoner_puuid, result);
      try {
        queries.setCachedEnemyAnalysis(summoner_puuid, result);
      } catch (dbErr) {
        logger.warn("[Drafting Oracle] Failed to cache enemy analysis", { error: dbErr.message });
      }

      return result;
    } catch (err) {
      logger.warn("[Drafting Oracle] Failed to fetch enemy pools", { puuid: summoner_puuid, error: err.message });
      return { puuid: summoner_puuid, error: err.message, top_champions: [] };
    }
  }

  async #handleGetMetaTierList({ role }) {
    const patch = getPatchVersion();

    if (!patch || !queries.hasMetaData(patch)) {
      return {
        role,
        patch: patch || "unknown",
        note: "No scraped meta data available for this patch. Use your built-in knowledge of the current meta to advise on strong picks.",
        tier_list: [],
        blind_safe_picks: [],
      };
    }

    const tierList = queries.getMetaTierList(role, patch, 20);
    const blindPicks = queries.getBlindSafePicks(role, patch, 3, 5);

    return {
      role,
      patch,
      tier_list: tierList,
      blind_safe_picks: blindPicks,
      note: tierList.length > 0
        ? `Live meta data for ${role} on patch ${patch}. Use tier_list for general strength and blind_safe_picks for first-pick scenarios.`
        : "No data for this role. Use your built-in knowledge.",
    };
  }

  async #handleAnalyzeComp({ ally_champions, enemy_champions }) {
    // This is a "think out loud" tool — Claude does the analysis itself.
    // We just echo back the data so Claude has it in context.
    return {
      ally_champions,
      enemy_champions,
      ally_count: ally_champions.length,
      enemy_count: enemy_champions.length,
      note: "Analyze these compositions and provide your assessment.",
    };
  }

  async #handleSuggestBan({ champion, reason, confidence }) {
    const recommendation = {
      action: "ban",
      champion,
      reason,
      confidence,
      timestamp: Date.now(),
    };

    logger.info("[Drafting Oracle] Ban recommendation", recommendation);

    // Send to overlay
    this.sendToOverlay(IPC_CHANNELS.DRAFT_RECOMMENDATION, {
      type: "ban",
      recommendations: [recommendation],
    });

    return { status: "displayed", champion, action: "ban" };
  }

  async #handleSuggestPick({ champion, role, reason, counters, confidence, pick_type }) {
    const recommendation = {
      action: "pick",
      champion,
      role,
      reason,
      counters: counters || [],
      confidence,
      pick_type: pick_type || "counter",
      timestamp: Date.now(),
    };

    logger.info("[Drafting Oracle] Pick recommendation", recommendation);

    // Send to overlay
    this.sendToOverlay(IPC_CHANNELS.DRAFT_RECOMMENDATION, {
      type: "pick",
      recommendations: [recommendation],
    });

    return { status: "displayed", champion, action: "pick" };
  }

  // ---------------------------------------------------------------------------
  // Champ select polling pipeline
  // ---------------------------------------------------------------------------

  async #pollChampSelect() {
    if (this.#invoking || this.#finalized) return; // Don't overlap or poll after finalized

    let session;
    try {
      session = await this.lcu.getChampSelectSession();
    } catch (err) {
      // Champ select might have ended
      logger.debug("[Drafting Oracle] Could not fetch champ select session", { error: err.message });
      return;
    }

    this.#localCellId = session.localPlayerCellId;

    // Check if the local player has locked in their pick
    if (this.#isLocalPlayerFinalized(session)) {
      this.#finalized = true;
      logger.info("[Drafting Oracle] Local player locked in — audit closed.");
      this.sendToOverlay(IPC_CHANNELS.DRAFT_FINALIZED, { finalized: true });
      return;
    }

    // Build a hash of the current action state to detect changes
    const actionHash = this.#hashActions(session);
    if (actionHash === this.#lastActionHash) return; // No change
    this.#lastActionHash = actionHash;

    // Build the context message for Claude
    const context = this.#buildContext(session);

    // Send phase update to overlay — RIOT POLICY: anonymous labels only
    this.sendToOverlay(IPC_CHANNELS.DRAFT_PHASE_UPDATE, {
      phase: this.#detectDraftPhase(session),
      myTeam: this.#extractTeamPicks(session.myTeam, "Ally"),
      theirTeam: this.#extractTeamPicks(session.theirTeam, "Enemy"),
    });

    // Check matchup cache before invoking Claude (saves tokens)
    const allyChamps = session.myTeam
      .filter((p) => p.championId)
      .map((p) => getChampionName(p.championId));
    const enemyChamps = (session.theirTeam || [])
      .filter((p) => p.championId)
      .map((p) => getChampionName(p.championId));
    const localPlayer = session.myTeam.find((p) => p.cellId === this.#localCellId);
    const myRole = localPlayer ? localPlayer.assignedPosition || "unknown" : "unknown";

    if (allyChamps.length >= 3 && enemyChamps.length >= 3) {
      const matchupKey = queries.buildMatchupKey(allyChamps, enemyChamps, myRole);
      const cached = queries.getCachedDraftAdvice(matchupKey);
      if (cached) {
        logger.info("[Drafting Oracle] Matchup cache HIT — skipping Claude", { matchupKey });
        this.sendToOverlay(IPC_CHANNELS.DRAFT_RECOMMENDATION, cached);
        return;
      }
    }

    // Invoke Claude
    this.#invoking = true;
    try {
      const result = await this.invoke(context, "CHAMP_SELECT");

      // Cache the advice if we have enough picks to form a meaningful key
      if (allyChamps.length >= 3 && enemyChamps.length >= 3) {
        const matchupKey = queries.buildMatchupKey(allyChamps, enemyChamps, myRole);
        try {
          queries.setCachedDraftAdvice(matchupKey, result);
        } catch (cacheErr) {
          logger.warn("[Drafting Oracle] Failed to cache draft advice", { error: cacheErr.message });
        }
      }
    } catch (err) {
      logger.error("[Drafting Oracle] Claude invocation failed", { error: err.message });
    } finally {
      this.#invoking = false;
    }
  }

  /**
   * Check if the local player has completed their pick action (locked in).
   */
  #isLocalPlayerFinalized(session) {
    if (!session.actions) return false;
    const flatActions = session.actions.flat();
    return flatActions.some(
      (a) => a.type === "pick" && a.actorCellId === this.#localCellId && a.completed
    );
  }

  /**
   * Build a hash string from the current actions to detect state changes.
   */
  #hashActions(session) {
    if (!session.actions) return "";
    return JSON.stringify(
      session.actions.flat().map((a) => `${a.actorCellId}:${a.championId}:${a.completed}`)
    );
  }

  /**
   * Detect which draft phase we're in based on actions.
   */
  #detectDraftPhase(session) {
    if (!session.actions) return "unknown";

    const flatActions = session.actions.flat();
    const incompleteBans = flatActions.filter((a) => a.type === "ban" && !a.completed);
    const incompletePicks = flatActions.filter((a) => a.type === "pick" && !a.completed);
    const completedBans = flatActions.filter((a) => a.type === "ban" && a.completed);

    if (incompleteBans.length > 0) {
      return completedBans.length >= 6 ? "ban_phase_2" : "ban_phase_1";
    }
    if (incompletePicks.length > 0) {
      return "pick_phase";
    }
    return "complete";
  }

  /**
   * Extract team picks into a simple format.
   * RIOT POLICY: No summoner names — only anonymous labels + champion data.
   * @param {Array} team
   * @param {string} prefix - "Ally" or "Enemy" for anonymous labels
   */
  #extractTeamPicks(team, prefix = "Player") {
    if (!team) return [];
    return team.map((p, i) => ({
      cellId: p.cellId,
      label: `${prefix} ${i + 1}`,
      position: p.assignedPosition || "unknown",
      championId: p.championId,
      champion: p.championId ? getChampionName(p.championId) : null,
      championIntent: p.championPickIntent ? getChampionName(p.championPickIntent) : null,
      puuid: p.puuid || null, // Used internally for mastery lookup only — never displayed
    }));
  }

  /**
   * Build the full context message sent to Claude.
   */
  #buildContext(session) {
    const phase = this.#detectDraftPhase(session);
    const myTeam = this.#extractTeamPicks(session.myTeam, "Ally");
    const theirTeam = this.#extractTeamPicks(session.theirTeam, "Enemy");

    // Find the local player's role
    const localPlayer = myTeam.find((p) => p.cellId === this.#localCellId);
    const myRole = localPlayer ? localPlayer.position : "unknown";

    // Gather all banned champions
    const allActions = (session.actions || []).flat();
    const bans = allActions
      .filter((a) => a.type === "ban" && a.completed && a.championId)
      .map((a) => getChampionName(a.championId));

    // Ally picks (completed) — anonymous labels only
    const allyPicks = myTeam
      .filter((p) => p.championId)
      .map((p) => `${p.label}: ${p.champion} (${p.position})`);

    // Enemy picks (completed) — anonymous labels only
    const enemyPicks = theirTeam
      .filter((p) => p.championId)
      .map((p) => `${p.label}: ${p.champion} (${p.position})`);

    // Enemy PUUIDs for mastery lookup only — no names exposed
    const enemyPuuids = theirTeam
      .filter((p) => p.puuid)
      .map((p) => ({ puuid: p.puuid, label: p.label, position: p.position }));

    const context = {
      draft_phase: phase,
      my_role: myRole,
      banned_champions: bans,
      ally_picks: allyPicks,
      enemy_picks: enemyPicks,
      ally_intents: myTeam
        .filter((p) => p.championIntent && !p.champion)
        .map((p) => `${p.label}: [${p.championIntent}] (${p.position})`),
      enemy_players: enemyPuuids,
      instructions: this.#getPhaseInstructions(phase, myRole),
    };

    return `CHAMP SELECT STATE UPDATE:\n${JSON.stringify(context, null, 2)}`;
  }

  /**
   * Get phase-specific instructions for Claude.
   */
  #getPhaseInstructions(phase, myRole = "unknown") {
    const roleLabel = myRole !== "unknown" ? myRole.toUpperCase() : "your role";

    switch (phase) {
      case "ban_phase_1":
        return `We are in BAN PHASE 1. The player's assigned role is ${roleLabel}. Use get_enemy_champion_pools to scout enemy one-tricks. Also call get_meta_tier_list for role "${myRole}" to identify high win-rate/ban-rate threats SPECIFIC to ${roleLabel}. If no ally hovers exist, recommend 3 bans: prioritize enemy one-tricks first, then the highest ban-rate/win-rate champions for ${roleLabel} from the meta data. Use suggest_ban for each.`;
      case "ban_phase_2":
        return `We are in BAN PHASE 2. The player's role is ${roleLabel}. Some picks are locked. Use analyze_team_composition if enough picks are in. Call get_meta_tier_list for role "${myRole}" to check remaining high-threat champions for ${roleLabel}. Then suggest_ban for remaining bans.`;
      case "pick_phase":
        return `We are in PICK PHASE. The player's role is ${roleLabel}. Call get_meta_tier_list for role "${myRole}" FIRST. Then classify your recommendation: if no enemy laner is visible, recommend a BLIND pick (pick_type='blind'). If the enemy laner is picked, recommend a COUNTER pick (pick_type='counter'). If the main driver is team composition fit, recommend a SYNERGY pick (pick_type='synergy'). Use suggest_pick with the appropriate pick_type.`;
      case "complete":
        return "Draft is complete. Use analyze_team_composition to give a final draft summary.";
      default:
        return "Analyze the current draft state and provide any relevant recommendations.";
    }
  }
}

module.exports = { DraftingOracle };
