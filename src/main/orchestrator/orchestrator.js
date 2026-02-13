const { GamePhase, PHASE_AGENT_MAP, PHASE_OVERLAY_MAP, GamePhaseStateMachine } = require("./state-machine");
const { EventBus } = require("./event-bus");
const { DraftingOracle } = require("../agents/drafting-oracle/agent");
const { MacroStrategist } = require("../agents/macro-strategist/agent");
const { TiltGuard } = require("../agents/tilt-guard/agent");
const { queries } = require("../data/db");
const { logger } = require("../utils/logger");

/**
 * Orchestrator — The central coordinator for Rift Architect.
 *
 * Responsibilities:
 * - Listens to LCU Connector for client connect/disconnect and phase changes
 * - Manages game phase state machine
 * - Activates/deactivates agents per phase
 * - Shows/hides overlay windows per phase
 * - Broadcasts state changes to all renderers via IPC
 */
class Orchestrator {
  /** @type {import('../lcu-connector').LCUConnector} */
  #lcu;

  /** @type {import('../windows/overlay-manager').OverlayManager} */
  #overlayManager;

  /** @type {import('../integrations/claude/client').ClaudeClient} */
  #claudeClient;

  /** @type {import('../riot-api-client').RiotApiClient} */
  #riotApi;

  /** @type {import('../integrations/riot/live-client').LiveClientAPI} */
  #liveClient;

  /** @type {EventBus} */
  #eventBus;

  /** @type {GamePhaseStateMachine} */
  #stateMachine;

  /** @type {Function | null} */
  #trayStatusUpdater = null;

  /** @type {Map<string, import('../agents/base-agent').BaseAgent>} */
  #activeAgents = new Map();

  /**
   * @param {Object} deps
   * @param {import('../lcu-connector').LCUConnector} deps.lcuConnector
   * @param {import('../windows/overlay-manager').OverlayManager} deps.overlayManager
   * @param {import('../integrations/claude/client').ClaudeClient} deps.claudeClient
   * @param {import('../riot-api-client').RiotApiClient} deps.riotApi
   * @param {import('../integrations/riot/live-client').LiveClientAPI} deps.liveClient
   */
  constructor({ lcuConnector, overlayManager, claudeClient, riotApi, liveClient }) {
    this.#lcu = lcuConnector;
    this.#overlayManager = overlayManager;
    this.#claudeClient = claudeClient;
    this.#riotApi = riotApi;
    this.#liveClient = liveClient;
    this.#eventBus = new EventBus();
    this.#stateMachine = new GamePhaseStateMachine(
      (from, to) => this.#onPhaseTransition(from, to)
    );
  }

  /** @returns {EventBus} */
  get eventBus() {
    return this.#eventBus;
  }

  /** @returns {string} Current game phase */
  get currentPhase() {
    return this.#stateMachine.current;
  }

  /**
   * Set a callback for updating the tray status text.
   * @param {(status: string) => void} updater
   */
  setTrayStatusUpdater(updater) {
    this.#trayStatusUpdater = updater;
  }

  /**
   * Start the orchestrator. Wires up LCU events and starts polling.
   */
  start() {
    logger.info("Orchestrator starting...");

    // --- LCU connection events ---
    this.#lcu.on("connected", async (creds) => {
      logger.info("Orchestrator: League client connected", { port: creds.port });
      this.#updateTrayStatus(`Connected (port ${creds.port})`);
      this.#overlayManager.sendToMain("status:update", "Connected to League Client");

      // Fetch current phase in case we connected mid-session
      try {
        const phase = await this.#lcu.getCurrentPhase();
        logger.info("Orchestrator: Current LCU phase on connect", { phase });
        this.#stateMachine.transitionFromLCU(phase);
      } catch (err) {
        logger.warn("Could not fetch initial phase", { error: err.message });
      }
    });

    this.#lcu.on("disconnected", () => {
      logger.info("Orchestrator: League client disconnected");
      this.#updateTrayStatus("Disconnected — waiting for League Client...");
      this.#deactivateAllAgents();
      this.#overlayManager.hideAll();
      this.#stateMachine.reset();

      // Broadcast status to main window
      this.#overlayManager.sendToMain("status:update", "Disconnected — reconnecting...");
    });

    // --- Real-time phase changes via LCU WebSocket ---
    this.#lcu.on("phase-changed", (lcuPhase) => {
      this.#stateMachine.transitionFromLCU(lcuPhase);
    });

    // Start LCU polling
    this.#lcu.start();

    logger.info("Orchestrator ready. Watching for League client...");
  }

  /**
   * Pause all active agents (e.g. on Riot API key expiration).
   * Does NOT shut down the orchestrator — agents can resume if key is updated.
   */
  async pauseAgents() {
    logger.warn("Orchestrator: pausing all agents (API key expired).");
    await this.#deactivateAllAgents();
    this.#overlayManager.hideAll();
  }

  /**
   * Resume agents after an API key update.
   * Re-triggers the current phase to reactivate relevant agents.
   */
  resumeAgents() {
    const phase = this.currentPhase;
    logger.info("Orchestrator: resuming agents after key update.", { phase });

    const agentId = PHASE_AGENT_MAP[phase];
    if (agentId) this.#activateAgent(agentId);

    const overlays = PHASE_OVERLAY_MAP[phase] || [];
    for (const ov of overlays) this.#overlayManager.show(ov);
  }

  /**
   * Shut everything down.
   */
  shutdown() {
    logger.info("Orchestrator shutting down...");
    this.#deactivateAllAgents();
    this.#lcu.shutdown();
    this.#overlayManager.hideAll();
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /**
   * Called by the state machine whenever a phase transition occurs.
   * @param {string} from
   * @param {string} to
   */
  #onPhaseTransition(from, to) {
    logger.info("Orchestrator: phase transition", { from, to });

    // Update tray
    this.#updateTrayStatus(`Phase: ${to}`);

    // Deactivate agent from previous phase
    const prevAgent = PHASE_AGENT_MAP[from];
    if (prevAgent) this.#deactivateAgent(prevAgent);

    // Hide previous overlays
    const prevOverlays = PHASE_OVERLAY_MAP[from] || [];
    for (const ov of prevOverlays) this.#overlayManager.hide(ov);

    // Activate agent for new phase
    const newAgent = PHASE_AGENT_MAP[to];
    if (newAgent) this.#activateAgent(newAgent);

    // Show new overlays
    const newOverlays = PHASE_OVERLAY_MAP[to] || [];
    for (const ov of newOverlays) this.#overlayManager.show(ov);

    // Broadcast to all renderers
    this.#overlayManager.broadcastPhaseChange(to);
    this.#eventBus.publish("phase:changed", { from, to });
  }

  /**
   * Create an agent instance by name.
   * @param {string} agentId
   * @returns {import('../agents/base-agent').BaseAgent | null}
   */
  #createAgent(agentId) {
    const baseDeps = {
      claudeClient: this.#claudeClient,
      eventBus: this.#eventBus,
      lcu: this.#lcu,
      overlayManager: this.#overlayManager,
    };

    switch (agentId) {
      case "drafting-oracle":
        return new DraftingOracle({ ...baseDeps, riotApi: this.#riotApi });

      case "macro-strategist":
        return new MacroStrategist({ ...baseDeps, liveClient: this.#liveClient });

      case "tilt-guard":
        return new TiltGuard({ ...baseDeps, riotApi: this.#riotApi });

      default:
        logger.warn("No agent implementation for", { agentId });
        return null;
    }
  }

  /**
   * Activate an agent by name — creates a real instance and calls start().
   * Respects the per-agent enabled setting from the Settings UI.
   * @param {string} agentId
   */
  async #activateAgent(agentId) {
    if (this.#activeAgents.has(agentId)) return;

    // Check if this agent is disabled in settings
    const settingKey = `agent_${agentId.replace(/-/g, "_")}_enabled`;
    const enabled = queries.getSetting(settingKey);
    if (enabled === "false") {
      logger.info("Agent disabled in settings — skipping activation", { agentId });
      return;
    }

    const agent = this.#createAgent(agentId);
    if (!agent) return;

    this.#activeAgents.set(agentId, agent);
    this.#eventBus.publish("agent:activated", { agent: agentId });

    try {
      await agent.start();
    } catch (err) {
      logger.error("Agent start() failed", { agent: agentId, error: err.message });
      this.#activeAgents.delete(agentId);
    }
  }

  /**
   * Deactivate an agent by name — calls stop() and removes it.
   * @param {string} agentId
   */
  async #deactivateAgent(agentId) {
    const agent = this.#activeAgents.get(agentId);
    if (!agent) return;

    try {
      await agent.stop();
    } catch (err) {
      logger.error("Agent stop() failed", { agent: agentId, error: err.message });
    }

    this.#activeAgents.delete(agentId);
    this.#eventBus.publish("agent:deactivated", { agent: agentId });
  }

  async #deactivateAllAgents() {
    const ids = [...this.#activeAgents.keys()];
    await Promise.all(ids.map((id) => this.#deactivateAgent(id)));
  }

  /**
   * @param {string} status
   */
  #updateTrayStatus(status) {
    if (this.#trayStatusUpdater) {
      this.#trayStatusUpdater(status);
    }
  }
}

module.exports = { Orchestrator };
