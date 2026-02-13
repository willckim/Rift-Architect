/**
 * IPC channel name constants shared between main and renderer processes.
 */
const IPC_CHANNELS = {
  // Orchestrator -> Overlays
  GAME_PHASE_CHANGED: "orchestrator:phase-changed",

  // Agent 1 -> Draft Overlay
  DRAFT_RECOMMENDATION: "draft:recommendation",
  DRAFT_PICK_LOCKED: "draft:pick-locked",
  DRAFT_PHASE_UPDATE: "draft:phase-update",
  DRAFT_FINALIZED: "draft:finalized",

  // Agent 2 -> Macro Overlay
  MACRO_CALL: "macro:call",
  MACRO_DISMISS: "macro:dismiss",
  MACRO_GAME_STATE: "macro:game-state",

  // Spell Tracker -> Spell Tracker Overlay
  SPELL_INIT: "spell:init",
  SPELL_ENEMY_UPDATE: "spell:enemy-update",

  // Agent 3 -> Tilt Overlay
  TILT_SCORE_UPDATE: "tilt:score-update",
  TILT_RECOMMENDATION: "tilt:recommendation",
  TILT_SESSION_SUMMARY: "tilt:session-summary",

  // Main Window
  STATUS_UPDATE: "status:update",
  SETTINGS_GET: "settings:get",
  SETTINGS_SET: "settings:set",
  SESSION_HISTORY: "session:history",

  // Overlay control
  OVERLAY_SHOW: "overlay:show",
  OVERLAY_HIDE: "overlay:hide",
  OVERLAY_TOGGLE: "overlay:toggle",
  OVERLAY_ACTIVATE_INGAME: "overlay:activate-ingame",
};

module.exports = { IPC_CHANNELS };
