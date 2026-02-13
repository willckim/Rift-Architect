const { logger } = require("../utils/logger");

/**
 * Game phases as seen by Rift Architect.
 * Mapped from raw LCU gameflow phase strings.
 */
const GamePhase = Object.freeze({
  IDLE: "IDLE",
  LOBBY: "LOBBY",
  CHAMP_SELECT: "CHAMP_SELECT",
  LOADING: "LOADING",
  IN_GAME: "IN_GAME",
  POST_GAME: "POST_GAME",
});

/**
 * Maps raw LCU gameflow phase strings to our internal GamePhase values.
 */
const LCU_PHASE_MAP = Object.freeze({
  None: GamePhase.IDLE,
  Lobby: GamePhase.LOBBY,
  Matchmaking: GamePhase.LOBBY,
  ReadyCheck: GamePhase.LOBBY,
  ChampSelect: GamePhase.CHAMP_SELECT,
  GameStart: GamePhase.LOADING,
  InProgress: GamePhase.IN_GAME,
  WaitingForStats: GamePhase.POST_GAME,
  PreEndOfGame: GamePhase.POST_GAME,
  EndOfGame: GamePhase.POST_GAME,
});

/**
 * Valid state transitions. Each key lists the phases it can transition to.
 */
const VALID_TRANSITIONS = Object.freeze({
  [GamePhase.IDLE]: [GamePhase.LOBBY],
  [GamePhase.LOBBY]: [GamePhase.CHAMP_SELECT, GamePhase.IDLE],
  [GamePhase.CHAMP_SELECT]: [GamePhase.LOADING, GamePhase.LOBBY], // LOBBY = dodge
  [GamePhase.LOADING]: [GamePhase.IN_GAME],
  [GamePhase.IN_GAME]: [GamePhase.POST_GAME],
  [GamePhase.POST_GAME]: [GamePhase.IDLE, GamePhase.LOBBY],
});

/**
 * Maps each phase to the agent that should be active during it.
 * null = no agent active.
 */
const PHASE_AGENT_MAP = Object.freeze({
  [GamePhase.IDLE]: null,
  [GamePhase.LOBBY]: null,
  [GamePhase.CHAMP_SELECT]: "drafting-oracle",
  [GamePhase.LOADING]: null,
  [GamePhase.IN_GAME]: "macro-strategist",
  [GamePhase.POST_GAME]: "tilt-guard",
});

/**
 * Maps each phase to the overlay(s) that should be visible.
 * Empty array = no overlays.
 */
const PHASE_OVERLAY_MAP = Object.freeze({
  [GamePhase.IDLE]: [],
  [GamePhase.LOBBY]: [],
  [GamePhase.CHAMP_SELECT]: ["draft"],
  [GamePhase.LOADING]: [],
  [GamePhase.IN_GAME]: ["macro"],
  [GamePhase.POST_GAME]: ["tilt"],
});

class GamePhaseStateMachine {
  /** @type {string} */
  #currentPhase = GamePhase.IDLE;

  /** @type {((from: string, to: string) => void) | null} */
  #onTransition = null;

  /**
   * @param {(from: string, to: string) => void} onTransition
   */
  constructor(onTransition) {
    this.#onTransition = onTransition;
  }

  /** @returns {string} */
  get current() {
    return this.#currentPhase;
  }

  /**
   * Attempt a phase transition.
   * @param {string} newPhase - A GamePhase value.
   * @returns {boolean} true if the transition occurred.
   */
  transition(newPhase) {
    if (newPhase === this.#currentPhase) return false;

    const valid = VALID_TRANSITIONS[this.#currentPhase];
    if (!valid.includes(newPhase)) {
      logger.warn("Invalid phase transition (forcing anyway — LCU is source of truth)", {
        from: this.#currentPhase,
        to: newPhase,
      });
    }

    const from = this.#currentPhase;
    this.#currentPhase = newPhase;
    logger.info("Phase transition", { from, to: newPhase });

    if (this.#onTransition) {
      this.#onTransition(from, newPhase);
    }

    return true;
  }

  /**
   * Translate a raw LCU phase string and transition.
   * @param {string} lcuPhase - e.g. "ChampSelect", "InProgress"
   * @returns {boolean}
   */
  transitionFromLCU(lcuPhase) {
    const mapped = LCU_PHASE_MAP[lcuPhase];
    if (!mapped) {
      logger.warn("Unknown LCU phase, defaulting to IDLE", { lcuPhase });
      return this.transition(GamePhase.IDLE);
    }
    return this.transition(mapped);
  }

  /**
   * Force reset to IDLE (e.g. on disconnect).
   */
  reset() {
    const from = this.#currentPhase;
    this.#currentPhase = GamePhase.IDLE;
    if (from !== GamePhase.IDLE && this.#onTransition) {
      this.#onTransition(from, GamePhase.IDLE);
    }
  }
}

module.exports = {
  GamePhase,
  LCU_PHASE_MAP,
  VALID_TRANSITIONS,
  PHASE_AGENT_MAP,
  PHASE_OVERLAY_MAP,
  GamePhaseStateMachine,
};
