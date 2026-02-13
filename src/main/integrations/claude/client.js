const Anthropic = require("@anthropic-ai/sdk");
const { logger } = require("../../utils/logger");
const { getKey } = require("../../key-store");

/**
 * Claude API Client — wraps the Anthropic SDK for tool-use conversations.
 *
 * Each agent provides its own system prompt and tool definitions.
 * This client handles the message loop: send → receive → execute tools → send results → repeat.
 *
 * Usage:
 *   const claude = new ClaudeClient();
 *   const result = await claude.runToolLoop({
 *     systemPrompt: "You are ...",
 *     tools: [...],
 *     messages: [{ role: "user", content: "..." }],
 *     toolHandler: async (toolName, toolInput) => { ... return result; },
 *   });
 */
class ClaudeClient {
  /** @type {Anthropic} */
  #client;

  /** @type {string} */
  #model;

  /** Max tool-use round-trips before forcing a stop */
  #MAX_TOOL_ROUNDS = 10;

  /** Per-request timeout in ms (30 seconds) */
  #REQUEST_TIMEOUT_MS = 30000;

  constructor() {
    const apiKey = getKey("ANTHROPIC_API_KEY");
    this.#model = process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514";

    if (!apiKey) {
      logger.error("ANTHROPIC_API_KEY is not set in .env — Claude calls will fail.");
      this.#client = null;
    } else {
      this.#client = new Anthropic({
        apiKey,
        timeout: this.#REQUEST_TIMEOUT_MS,
        maxRetries: 2,
      });
      logger.info("Claude API client initialized.", {
        model: this.#model,
        keyPrefix: apiKey.substring(0, 12) + "...",
      });
    }
  }

  /**
   * Single-turn message (no tools). Returns the text response.
   *
   * @param {string} systemPrompt
   * @param {string} userMessage
   * @returns {Promise<string>}
   */
  async ask(systemPrompt, userMessage) {
    if (!this.#client) throw new Error("Claude client not initialized");

    const startMs = Date.now();
    const response = await this.#client.messages.create({
      model: this.#model,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    });

    const latencyMs = Date.now() - startMs;
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    logger.info("Claude response", {
      latencyMs,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    });

    return text;
  }

  /**
   * Run a full tool-use conversation loop.
   *
   * Flow:
   *   1. Send system prompt + messages + tool definitions to Claude.
   *   2. If Claude responds with tool_use blocks, call toolHandler for each.
   *   3. Append tool results and send back to Claude.
   *   4. Repeat until Claude responds with only text (end_turn), or MAX_TOOL_ROUNDS.
   *
   * @param {Object} opts
   * @param {string} opts.systemPrompt
   * @param {Array} opts.tools - Anthropic tool definitions
   * @param {Array} opts.messages - Conversation messages
   * @param {(toolName: string, toolInput: any) => Promise<any>} opts.toolHandler
   * @param {number} [opts.maxTokens=2048]
   * @returns {Promise<{ text: string, toolResults: Array, usage: { input: number, output: number }, latencyMs: number }>}
   */
  async runToolLoop({ systemPrompt, tools, messages, toolHandler, maxTokens = 2048 }) {
    if (!this.#client) throw new Error("Claude client not initialized");

    const startMs = Date.now();
    let totalInput = 0;
    let totalOutput = 0;
    const allToolResults = [];
    let conversationMessages = [...messages];

    for (let round = 0; round < this.#MAX_TOOL_ROUNDS; round++) {
      let response;
      try {
        response = await this.#client.messages.create({
          model: this.#model,
          max_tokens: maxTokens,
          system: systemPrompt,
          tools,
          messages: conversationMessages,
        });
      } catch (apiErr) {
        const latencyMs = Date.now() - startMs;
        const isTimeout = apiErr.message?.includes("timeout") || apiErr.code === "ETIMEDOUT";
        const isRateLimit = apiErr.status === 429;

        logger.error("Claude API error", {
          round: round + 1,
          error: apiErr.message,
          isTimeout,
          isRateLimit,
          latencyMs,
        });

        // Return partial results so the agent doesn't crash
        return {
          text: "",
          toolResults: allToolResults,
          usage: { input: totalInput, output: totalOutput },
          latencyMs,
          error: isTimeout ? "Claude request timed out" : apiErr.message,
        };
      }

      totalInput += response.usage.input_tokens;
      totalOutput += response.usage.output_tokens;

      // Extract text blocks and tool_use blocks
      const textBlocks = response.content.filter((b) => b.type === "text");
      const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");

      // If no tool calls, we're done
      if (toolUseBlocks.length === 0 || response.stop_reason === "end_turn") {
        const finalText = textBlocks.map((b) => b.text).join("");
        const latencyMs = Date.now() - startMs;

        logger.info("Claude tool loop complete", {
          rounds: round + 1,
          toolCalls: allToolResults.length,
          latencyMs,
          inputTokens: totalInput,
          outputTokens: totalOutput,
        });

        return {
          text: finalText,
          toolResults: allToolResults,
          usage: { input: totalInput, output: totalOutput },
          latencyMs,
        };
      }

      // Process each tool call
      const toolResults = [];
      for (const toolUse of toolUseBlocks) {
        logger.debug("Claude tool call", {
          tool: toolUse.name,
          input: JSON.stringify(toolUse.input).substring(0, 200),
        });

        let result;
        try {
          result = await toolHandler(toolUse.name, toolUse.input);
        } catch (err) {
          logger.error("Tool handler error", { tool: toolUse.name, error: err.message });
          result = { error: err.message };
        }

        allToolResults.push({
          tool: toolUse.name,
          input: toolUse.input,
          output: result,
        });

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: typeof result === "string" ? result : JSON.stringify(result),
        });
      }

      // Append assistant response + tool results to conversation
      conversationMessages = [
        ...conversationMessages,
        { role: "assistant", content: response.content },
        { role: "user", content: toolResults },
      ];
    }

    // If we exhausted MAX_TOOL_ROUNDS, return whatever we have
    logger.warn("Claude tool loop hit max rounds", { maxRounds: this.#MAX_TOOL_ROUNDS });
    return {
      text: "[Tool loop exceeded maximum rounds]",
      toolResults: allToolResults,
      usage: { input: totalInput, output: totalOutput },
      latencyMs: Date.now() - startMs,
    };
  }
}

module.exports = { ClaudeClient };
