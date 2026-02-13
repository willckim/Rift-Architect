const https = require("https");
const fs = require("fs");
const path = require("path");
const { logger } = require("./utils/logger");

/**
 * Champion ID → Name mapping, loaded once from Data Dragon on startup.
 * @type {Map<number, string>}
 */
let championMap = new Map();

/** Cached Data Dragon patch version */
let patchVersion = "";

/**
 * Fetch the latest champion data from Riot's Data Dragon CDN.
 * Populates the championMap so we can resolve mastery champion IDs to names.
 */
async function loadChampionData() {
  try {
    // 1. Get latest patch version
    const versions = await httpsGet("https://ddragon.leagueoflegends.com/api/versions.json");
    const latestPatch = versions[0];
    logger.info("Data Dragon patch", { patch: latestPatch });

    // 2. Fetch champion data for that patch
    const champData = await httpsGet(
      `https://ddragon.leagueoflegends.com/cdn/${latestPatch}/data/en_US/champion.json`
    );

    // 3. Build ID → Name map
    for (const champ of Object.values(champData.data)) {
      championMap.set(parseInt(champ.key, 10), champ.name);
    }

    patchVersion = latestPatch;

    logger.info("Champion data loaded", { count: championMap.size });

    // 4. Cache champion square icons in AppData (async, non-blocking)
    cacheChampionIcons(latestPatch, champData.data).catch((err) => {
      logger.warn("Champion icon caching failed (non-fatal)", { error: err.message });
    });
  } catch (err) {
    logger.error("Failed to load champion data from Data Dragon", { error: err.message });
  }
}

/**
 * Resolve a champion ID to a champion name.
 * @param {number} championId
 * @returns {string}
 */
function getChampionName(championId) {
  return championMap.get(championId) || `Champion #${championId}`;
}

/**
 * Summoner Detector — On LCU connection, fetches the logged-in summoner's
 * identity from the local client, then enriches it with Cloud API data
 * (rank, masteries) to produce a Hybrid Profile.
 *
 * @param {import('./lcu-connector').LCUConnector} lcu
 * @param {import('./riot-api-client').RiotApiClient} riotApi
 * @returns {Promise<Object>} The hybrid profile
 */
async function detectSummoner(lcu, riotApi) {
  // --- Step 1: Fetch summoner identity from the LOCAL client ---
  logger.info("Summoner Detector: Fetching identity from LCU...");

  const localSummoner = await lcu.getCurrentSummoner();

  const displayName = localSummoner.gameName && localSummoner.tagLine
    ? `${localSummoner.gameName}#${localSummoner.tagLine}`
    : localSummoner.displayName || localSummoner.internalName || "Unknown";

  const puuid = localSummoner.puuid;
  const summonerId = localSummoner.summonerId;
  const accountId = localSummoner.accountId;
  const summonerLevel = localSummoner.summonerLevel;

  logger.info("Summoner Detector: Local identity resolved", {
    displayName,
    puuid: puuid.substring(0, 16) + "...",
    summonerLevel,
  });

  // --- Step 2: Fetch ranked data from the CLOUD API ---
  let rankedEntries = [];
  let soloRank = null;
  let flexRank = null;

  try {
    rankedEntries = await riotApi.getRankedEntries(summonerId);
    for (const entry of rankedEntries) {
      if (entry.queueType === "RANKED_SOLO_5x5") {
        soloRank = {
          tier: entry.tier,
          rank: entry.rank,
          lp: entry.leaguePoints,
          wins: entry.wins,
          losses: entry.losses,
          winRate: Math.round((entry.wins / (entry.wins + entry.losses)) * 100),
          hotStreak: entry.hotStreak,
        };
      } else if (entry.queueType === "RANKED_FLEX_SR") {
        flexRank = {
          tier: entry.tier,
          rank: entry.rank,
          lp: entry.leaguePoints,
          wins: entry.wins,
          losses: entry.losses,
        };
      }
    }
  } catch (err) {
    logger.warn("Summoner Detector: Failed to fetch ranked data", { error: err.message });
  }

  // --- Step 3: Fetch top 3 champion masteries from the CLOUD API ---
  let topMasteries = [];
  try {
    const rawMasteries = await riotApi.getTopMasteries(puuid, 3);
    topMasteries = rawMasteries.map((m) => ({
      champion: getChampionName(m.championId),
      championId: m.championId,
      level: m.championLevel,
      points: m.championPoints,
      pointsFormatted: formatPoints(m.championPoints),
    }));
  } catch (err) {
    logger.warn("Summoner Detector: Failed to fetch champion masteries", { error: err.message });
  }

  // --- Step 4: Assemble the Hybrid Profile ---
  const profile = {
    displayName,
    puuid,
    summonerId,
    accountId,
    summonerLevel,
    soloRank,
    flexRank,
    topMasteries,
  };

  // --- Step 5: Print to terminal ---
  printHybridProfile(profile);

  return profile;
}

/**
 * Pretty-print the Hybrid Profile to the terminal.
 */
function printHybridProfile(profile) {
  const divider = "═".repeat(52);
  const thinDiv = "─".repeat(52);

  console.log("");
  console.log(`╔${divider}╗`);
  console.log(`║  HYBRID PROFILE                                    ║`);
  console.log(`╠${divider}╣`);
  console.log(`║  Summoner : ${pad(profile.displayName, 38)}║`);
  console.log(`║  Level    : ${pad(String(profile.summonerLevel), 38)}║`);
  console.log(`║  PUUID    : ${pad(profile.puuid.substring(0, 36) + "...", 38)}║`);
  console.log(`╠${divider}╣`);

  if (profile.soloRank) {
    const r = profile.soloRank;
    const rankStr = `${r.tier} ${r.rank} (${r.lp} LP)`;
    const record = `${r.wins}W / ${r.losses}L (${r.winRate}%)`;
    console.log(`║  Solo/Duo : ${pad(rankStr, 38)}║`);
    console.log(`║  Record   : ${pad(record, 38)}║`);
    if (r.hotStreak) {
      console.log(`║  Streak   : ${pad("ON FIRE", 38)}║`);
    }
  } else {
    console.log(`║  Solo/Duo : ${pad("Unranked", 38)}║`);
  }

  if (profile.flexRank) {
    const f = profile.flexRank;
    console.log(`║  Flex     : ${pad(`${f.tier} ${f.rank} (${f.lp} LP)`, 38)}║`);
  }

  console.log(`╠${divider}╣`);
  console.log(`║  TOP CHAMPION MASTERIES                            ║`);
  console.log(`║  ${thinDiv}║`);

  if (profile.topMasteries.length === 0) {
    console.log(`║  No mastery data available.                        ║`);
  } else {
    for (let i = 0; i < profile.topMasteries.length; i++) {
      const m = profile.topMasteries[i];
      const line = `#${i + 1}  ${m.champion} — M${m.level} (${m.pointsFormatted})`;
      console.log(`║  ${pad(line, 50)}║`);
    }
  }

  console.log(`╚${divider}╝`);
  console.log("");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pad(str, len) {
  if (str.length >= len) return str.substring(0, len);
  return str + " ".repeat(len - str.length);
}

function formatPoints(pts) {
  if (pts >= 1_000_000) return `${(pts / 1_000_000).toFixed(1)}M`;
  if (pts >= 1_000) return `${(pts / 1_000).toFixed(1)}k`;
  return String(pts);
}

/**
 * Get the local cache directory for champion icons.
 * @returns {string}
 */
function getIconCacheDir() {
  try {
    const { app } = require("electron");
    return path.join(app.getPath("userData"), "champion-icons");
  } catch {
    return path.join(__dirname, "../../cache/champion-icons");
  }
}

/**
 * Get the local file path for a champion's square icon.
 * @param {string} championImageId - e.g. "Aatrox" (from champion data's image.full minus .png)
 * @returns {string}
 */
function getChampionIconPath(championImageId) {
  const dir = getIconCacheDir();
  return path.join(dir, `${championImageId}.png`);
}

/**
 * Download and cache all champion square icons in AppData.
 * Only downloads icons that don't already exist locally.
 * @param {string} patch - e.g. "14.10.1"
 * @param {Object} champDataMap - Data Dragon champion data
 */
async function cacheChampionIcons(patch, champDataMap) {
  const dir = getIconCacheDir();

  // Ensure directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const champions = Object.values(champDataMap);
  let cached = 0;
  let downloaded = 0;

  for (const champ of champions) {
    const imgFile = champ.image.full; // e.g. "Aatrox.png"
    const localPath = path.join(dir, imgFile);

    if (fs.existsSync(localPath)) {
      cached++;
      continue;
    }

    // Download the icon
    const url = `https://ddragon.leagueoflegends.com/cdn/${patch}/img/champion/${imgFile}`;
    try {
      await downloadFile(url, localPath);
      downloaded++;
    } catch (err) {
      logger.debug("Failed to download champion icon", { champion: champ.name, error: err.message });
    }
  }

  logger.info("Champion icon cache updated", { cached, downloaded, total: champions.length });
}

/**
 * Download a file from URL to a local path.
 */
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on("finish", () => { file.close(resolve); });
    }).on("error", (err) => {
      file.close();
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
      reject(err);
    });
  });
}

/**
 * Simple HTTPS GET that returns parsed JSON.
 */
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(data)); }
          catch { resolve(data); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${url}`));
        }
      });
    }).on("error", reject);
  });
}

/**
 * Get the current Data Dragon patch version.
 * @returns {string} e.g. "14.10.1"
 */
function getPatchVersion() {
  return patchVersion;
}

module.exports = { detectSummoner, loadChampionData, getChampionName, getChampionIconPath, getPatchVersion };
