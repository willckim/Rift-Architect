const { EventEmitter } = require("events");
const { logger } = require("../utils/logger");

/**
 * Internal event bus for agent coordination and cross-component communication.
 * Thin wrapper over EventEmitter with logging.
 *
 * Event categories:
 *   phase:*    — Game phase transitions
 *   agent:*    — Agent lifecycle events
 *   overlay:*  — Overlay visibility events
 *   data:*     — Data pipeline events (LCU snapshots, live client data, etc.)
 */
class EventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(30); // Multiple agents + overlays + orchestrator
  }

  /**
   * Emit with logging in debug mode.
   * @param {string} event
   * @param  {...any} args
   * @returns {boolean}
   */
  publish(event, ...args) {
    logger.debug(`EventBus: ${event}`);
    return this.emit(event, ...args);
  }

  /**
   * Subscribe to an event.
   * @param {string} event
   * @param {Function} handler
   */
  subscribe(event, handler) {
    this.on(event, handler);
  }

  /**
   * Unsubscribe from an event.
   * @param {string} event
   * @param {Function} handler
   */
  unsubscribe(event, handler) {
    this.off(event, handler);
  }
}

module.exports = { EventBus };
