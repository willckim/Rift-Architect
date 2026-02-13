/**
 * Structured logger for Rift Architect.
 * Wraps console with timestamps and component tags.
 * Will be replaced with electron-log in later phases.
 */

function formatTimestamp() {
  return new Date().toISOString();
}

function formatMeta(meta) {
  if (!meta || Object.keys(meta).length === 0) return "";
  return " " + JSON.stringify(meta);
}

const logger = {
  info(message, meta) {
    console.log(`[${formatTimestamp()}] [INFO]  ${message}${formatMeta(meta)}`);
  },

  warn(message, meta) {
    console.warn(`[${formatTimestamp()}] [WARN]  ${message}${formatMeta(meta)}`);
  },

  error(message, meta) {
    console.error(`[${formatTimestamp()}] [ERROR] ${message}${formatMeta(meta)}`);
  },

  debug(message, meta) {
    if (process.argv.includes("--dev") || process.env.NODE_ENV === "development") {
      console.log(`[${formatTimestamp()}] [DEBUG] ${message}${formatMeta(meta)}`);
    }
  },
};

module.exports = { logger };
