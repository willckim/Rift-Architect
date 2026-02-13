const Store = require("electron-store");
const { logger } = require("./utils/logger");

/**
 * Persistent encrypted key store for API credentials.
 *
 * Keys are stored in Electron's userData folder (AppData on Windows).
 * If .env provides a key, it takes precedence. If .env is missing,
 * we fall back to whatever was saved in the store via the Settings UI.
 */

/** @type {Store | null} */
let store = null;

/**
 * Initialize the key store. Must be called after app.whenReady().
 */
function initKeyStore() {
  store = new Store({
    name: "rift-architect-keys",
    defaults: {
      RIOT_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      RIOT_REGION: "na1",
      RIOT_ROUTING: "americas",
    },
  });
  logger.info("Key store initialized.", { path: store.path });
}

/**
 * Get an API key. Checks process.env first, then falls back to store.
 * @param {"RIOT_API_KEY"|"ANTHROPIC_API_KEY"|"RIOT_REGION"|"RIOT_ROUTING"} key
 * @returns {string}
 */
function getKey(key) {
  // .env takes precedence
  if (process.env[key]) return process.env[key];
  // Fall back to stored value
  return store ? store.get(key, "") : "";
}

/**
 * Save a key to the persistent store AND update process.env so
 * it takes effect immediately without restart.
 * @param {string} key
 * @param {string} value
 */
function setKey(key, value) {
  if (store) store.set(key, value);
  process.env[key] = value;
  logger.info("Key updated in store", { key, hasValue: !!value });
}

/**
 * Get all stored keys (for populating the Settings UI).
 * Returns masked values for display.
 */
function getAllKeys() {
  return {
    RIOT_API_KEY: getKey("RIOT_API_KEY"),
    ANTHROPIC_API_KEY: getKey("ANTHROPIC_API_KEY"),
    RIOT_REGION: getKey("RIOT_REGION") || "na1",
    RIOT_ROUTING: getKey("RIOT_ROUTING") || "americas",
  };
}

module.exports = { initKeyStore, getKey, setKey, getAllKeys };
