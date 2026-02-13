const { logger } = require("../utils/logger");
const { queries } = require("../data/db");

/**
 * Base class for all Rift Architect agents.
 *
 * Subclasses must implement:
 *   - name (getter)        — Agent identifier (e.g. "drafting-oracle")
 *   - systemPrompt()       — Returns the system prompt string
 *   - tools()              — Returns the Anthropic tool definitions array
 *   - handleToolCall(name, input) — Executes a tool and returns the result
 *   - onActivate()         — Called when the agent's phase begins
 *   - onDeactivate()       — Called when the agent's phase ends
 */
class BaseAgent {
  /** @type {import('../integrations/claude/client').ClaudeClient} */
  #claudeClient;

  /** @type {import('../orchestrator/event-bus').EventBus} */
  #eventBus;

  /** @type {import('../lcu-connector').LCUConnector} */
  #lcu;

  /** @type {import('../windows/overlay-manager').OverlayManager} */
  #overlayManager;

  /** @type {boolean} */
  #active = false;

  /**
   * @param {Object} deps
   * @param {import('../integrations/claude/client').ClaudeClient} deps.claudeClient
   * @param {import('../orchestrator/event-bus').EventBus} deps.eventBus
   * @param {import('../lcu-connector').LCUConnector} deps.lcu
   * @param {import('../windows/overlay-manager').OverlayManager} deps.overlayManager
   */
  constructor({ claudeClient, eventBus, lcu, overlayManager }) {
    this.#claudeClient = claudeClient;
    this.#eventBus = eventBus;
    this.#lcu = lcu;
    this.#overlayManager = overlayManager;
  }

  // ---------------------------------------------------------------------------
  // Abstract — subclasses must override
  // ---------------------------------------------------------------------------

  /** @returns {string} */
  get name() {
    throw new Error("Subclass must implement get name()");
  }

  /** @returns {string} */
  systemPrompt() {
    throw new Error("Subclass must implement systemPrompt()");
  }

  /** @returns {Array} Anthropic tool definitions */
  tools() {
    throw new Error("Subclass must implement tools()");
  }

  /**
   * Handle a tool call from Claude.
   * @param {string} toolName
   * @param {any} toolInput
   * @returns {Promise<any>} The result to send back to Claude
   */
  async handleToolCall(toolName, toolInput) {
    throw new Error(`Subclass must implement handleToolCall() — got ${toolName}`);
  }

  /**
   * Called when this agent's phase begins. Set up data pipelines, subscriptions, etc.
   */
  async onActivate() {
    // Override in subclass
  }

  /**
   * Called when this agent's phase ends. Tear down polling, clean up state.
   */
  async onDeactivate() {
    // Override in subclass
  }

  // ---------------------------------------------------------------------------
  // Public lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Activate the agent. Called by the orchestrator on phase transition.
   */
  async start() {
    if (this.#active) return;
    this.#active = true;
    logger.info(`Agent [${this.name}] activating...`);

    try {
      await this.onActivate();
      logger.info(`Agent [${this.name}] active.`);
    } catch (err) {
      logger.error(`Agent [${this.name}] activation failed`, { error: err.message });
      this.#active = false;
    }
  }

  /**
   * Deactivate the agent. Called by the orchestrator on phase transition.
   */
  async stop() {
    if (!this.#active) return;
    this.#active = false;
    logger.info(`Agent [${this.name}] deactivating...`);

    try {
      await this.onDeactivate();
      logger.info(`Agent [${this.name}] stopped.`);
    } catch (err) {
      logger.error(`Agent [${this.name}] deactivation error`, { error: err.message });
    }
  }

  /** @returns {boolean} */
  get isActive() {
    return this.#active;
  }

  // ---------------------------------------------------------------------------
  // Protected — available to subclasses
  // ---------------------------------------------------------------------------

  /** @returns {import('../integrations/claude/client').ClaudeClient} */
  get claude() {
    return this.#claudeClient;
  }

  /** @returns {import('../orchestrator/event-bus').EventBus} */
  get eventBus() {
    return this.#eventBus;
  }

  /** @returns {import('../lcu-connector').LCUConnector} */
  get lcu() {
    return this.#lcu;
  }

  /** @returns {import('../windows/overlay-manager').OverlayManager} */
  get overlayManager() {
    return this.#overlayManager;
  }

  /**
   * Run a full tool-use conversation with Claude.
   * Wraps the Claude client's runToolLoop and logs the invocation.
   *
   * @param {string} userMessage — The context/data to send to Claude
   * @param {string} [gamePhase] — Current phase for logging
   * @returns {Promise<{ text: string, toolResults: Array }>}
   */
  async invoke(userMessage, gamePhase = "unknown") {
    if (!this.#active) {
      logger.warn(`Agent [${this.name}] invoke called while inactive — skipping.`);
      return { text: "", toolResults: [] };
    }

    logger.info(`Agent [${this.name}] invoking Claude...`, {
      inputLength: userMessage.length,
    });

    const result = await this.claude.runToolLoop({
      systemPrompt: this.systemPrompt(),
      tools: this.tools(),
      messages: [{ role: "user", content: userMessage }],
      toolHandler: (toolName, toolInput) => this.handleToolCall(toolName, toolInput),
    });

    // Log the invocation to the database
    try {
      queries.logAgent({
        agent_name: this.name,
        game_phase: gamePhase,
        input_summary: userMessage.substring(0, 500),
        output_summary: result.text.substring(0, 500),
        claude_model: process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514",
        tokens_used: result.usage.input + result.usage.output,
        latency_ms: result.latencyMs,
      });
    } catch (err) {
      logger.warn("Failed to log agent invocation to DB", { error: err.message });
    }

    logger.info(`Agent [${this.name}] invocation complete`, {
      toolCalls: result.toolResults.length,
      latencyMs: result.latencyMs,
    });

    return result;
  }

  /**
   * Send data to this agent's overlay window.
   * @param {string} channel — IPC channel name
   * @param {any} data
   */
  sendToOverlay(channel, data) {
    // Derive overlay name from agent name
    const overlayName = {
      "drafting-oracle": "draft",
      "macro-strategist": "macro",
      "tilt-guard": "tilt",
    }[this.name];

    if (overlayName) {
      this.overlayManager.sendToOverlay(overlayName, channel, data);
    }
  }
}

module.exports = { BaseAgent };
