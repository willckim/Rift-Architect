const https = require("https");
const { logger } = require("../utils/logger");
const { queries } = require("./db");

let cheerio;
try {
  cheerio = require("cheerio");
} catch {
  cheerio = null;
}

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

/**
 * Fetch raw HTML from a URL, following up to 3 redirects.
 * @param {string} url
 * @param {number} [maxRedirects=3]
 * @returns {Promise<string>}
 */
function fetchHtml(url, maxRedirects = 3) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": USER_AGENT } }, (res) => {
      // Follow redirects
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        if (maxRedirects <= 0) return reject(new Error("Too many redirects"));
        const next = res.headers.location.startsWith("http")
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        res.resume();
        return fetchHtml(next, maxRedirects - 1).then(resolve, reject);
      }

      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }

      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error(`Timeout fetching ${url}`)); });
  });
}

// ---------------------------------------------------------------------------
// Tier classification
// ---------------------------------------------------------------------------

/**
 * Classify a champion into a tier based on win rate and pick rate.
 * @param {number} winRate — e.g. 53.2
 * @param {number} pickRate — e.g. 8.5
 * @returns {string} S, A, B, C, or D
 */
function classifyTier(winRate, pickRate) {
  // S: high WR + decent play rate (not just niche)
  if (winRate >= 53 && pickRate >= 3) return "S";
  if (winRate >= 52 && pickRate >= 5) return "S";
  // A: solidly above average
  if (winRate >= 51.5 && pickRate >= 2) return "A";
  if (winRate >= 51 && pickRate >= 5) return "A";
  // B: average to slightly above
  if (winRate >= 50 && pickRate >= 1) return "B";
  // C: below average
  if (winRate >= 48) return "C";
  // D: everything else
  return "D";
}

// ---------------------------------------------------------------------------
// LoLalytics scraper (Priority 1)
// ---------------------------------------------------------------------------

const LOLALYTICS_ROLES = ["top", "jungle", "middle", "bottom", "support"];
const ROLE_MAP = { middle: "mid", bottom: "adc", top: "top", jungle: "jungle", support: "support" };

/**
 * Scrape champion stats from LoLalytics tier list pages.
 * LoLalytics renders stats via Qwik SSR — champion data is embedded in script tags.
 * @param {string} patchShort — e.g. "14.10" (major.minor only)
 * @returns {Promise<Object[]>} Array of champion stat objects
 */
async function scrapeLoLalytics(patchShort) {
  if (!cheerio) throw new Error("cheerio not installed");

  const results = [];

  for (const role of LOLALYTICS_ROLES) {
    try {
      const url = `https://lolalytics.com/lol/tierlist/?lane=${role}&patch=${patchShort}`;
      const html = await fetchHtml(url);
      const $ = cheerio.load(html);

      // LoLalytics embeds data in a script tag as JSON arrays
      // Look for script content containing champion stats
      const scripts = $("script").toArray();
      for (const script of scripts) {
        const content = $(script).html() || "";

        // Try to extract champion tier data from the Qwik SSR payload
        // LoLalytics often has a JSON structure with champion names and stats
        const jsonMatches = content.match(/\{[^}]*"cid"[^}]*"name"[^}]*\}/g);
        if (jsonMatches) {
          for (const match of jsonMatches) {
            try {
              const parsed = JSON.parse(match);
              if (parsed.name && parsed.wr !== undefined) {
                results.push({
                  name: parsed.name,
                  role: ROLE_MAP[role] || role,
                  win_rate: parseFloat(parsed.wr),
                  pick_rate: parseFloat(parsed.pr || 0),
                  ban_rate: parseFloat(parsed.br || 0),
                  counter_count: parseInt(parsed.counters || 0, 10),
                });
              }
            } catch {
              // skip malformed entry
            }
          }
        }
      }

      // Alternative: Look for structured data in table rows
      if (results.filter((r) => r.role === (ROLE_MAP[role] || role)).length === 0) {
        $("tr, .tier-list-item, [class*='champion']").each((_i, el) => {
          const text = $(el).text();
          // Look for patterns like "Champion Name 52.3% 8.1% 12.3%"
          const match = text.match(/([A-Z][a-zA-Z'\s]+?)\s+(\d{2}\.\d+)%\s+(\d+\.?\d*)%\s+(\d+\.?\d*)%/);
          if (match) {
            results.push({
              name: match[1].trim(),
              role: ROLE_MAP[role] || role,
              win_rate: parseFloat(match[2]),
              pick_rate: parseFloat(match[3]),
              ban_rate: parseFloat(match[4]),
              counter_count: 0,
            });
          }
        });
      }

      logger.debug("[Meta Scraper] LoLalytics scraped role", { role, count: results.filter((r) => r.role === (ROLE_MAP[role] || role)).length });
    } catch (err) {
      logger.warn("[Meta Scraper] LoLalytics failed for role", { role, error: err.message });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// LeagueOfGraphs scraper (Priority 2)
// ---------------------------------------------------------------------------

/**
 * Scrape champion stats from LeagueOfGraphs as a fallback.
 * @param {string} patchShort
 * @returns {Promise<Object[]>}
 */
async function scrapeLeagueOfGraphs(patchShort) {
  if (!cheerio) throw new Error("cheerio not installed");

  const results = [];
  const roles = ["top", "jungle", "mid", "adc", "support"];

  for (const role of roles) {
    try {
      const url = `https://www.leagueofgraphs.com/champions/builds/${role}/sr-ranked`;
      const html = await fetchHtml(url);
      const $ = cheerio.load(html);

      // LeagueOfGraphs embeds data in a Vue init script or table rows
      $("tr").each((_i, el) => {
        const cells = $(el).find("td");
        if (cells.length >= 4) {
          const champName = $(cells[0]).text().trim().replace(/\n.*/s, "").trim();
          const winRateText = $(cells[2]).text().trim();
          const pickRateText = $(cells[3]).text().trim();

          const wr = parseFloat(winRateText);
          const pr = parseFloat(pickRateText);

          if (champName && !isNaN(wr) && wr > 30 && wr < 70) {
            results.push({
              name: champName,
              role,
              win_rate: wr,
              pick_rate: isNaN(pr) ? 0 : pr,
              ban_rate: 0,
              counter_count: 0,
            });
          }
        }
      });

      logger.debug("[Meta Scraper] LeagueOfGraphs scraped role", { role, count: results.filter((r) => r.role === role).length });
    } catch (err) {
      logger.warn("[Meta Scraper] LeagueOfGraphs failed for role", { role, error: err.message });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Database storage
// ---------------------------------------------------------------------------

/**
 * Bulk insert champion meta data, classifying tiers from raw stats.
 * @param {Object[]} champions — Array of { name, role, win_rate, pick_rate, ban_rate, counter_count }
 * @param {string} patchVersion — Full patch version e.g. "14.10.1"
 * @param {string} source — "lolalytics" or "leagueofgraphs"
 */
function storeMetaData(champions, patchVersion, source) {
  const db = require("./db").getDb();

  const insert = db.prepare(`
    INSERT OR REPLACE INTO meta_champions (name, role, tier, win_rate, pick_rate, ban_rate, counter_count, patch_version, source, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const tx = db.transaction((champs) => {
    for (const c of champs) {
      const tier = classifyTier(c.win_rate, c.pick_rate);
      insert.run(c.name, c.role, tier, c.win_rate, c.pick_rate, c.ban_rate, c.counter_count || 0, patchVersion, source);
    }
  });

  tx(champions);
  logger.info("[Meta Scraper] Stored champion entries", { count: champions.length, patch: patchVersion, source });
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Run the scraper fallback chain: LoLalytics → LeagueOfGraphs → graceful degradation.
 * @param {string} patchVersion — Full patch version e.g. "14.10.1"
 * @returns {Promise<{ success: boolean, source: string, count: number }>}
 */
async function scrapeAndStore(patchVersion) {
  const patchShort = patchVersion.split(".").slice(0, 2).join(".");

  // Priority 1: LoLalytics
  try {
    const data = await scrapeLoLalytics(patchShort);
    if (data.length >= 20) {
      storeMetaData(data, patchVersion, "lolalytics");
      return { success: true, source: "lolalytics", count: data.length };
    }
    logger.warn("[Meta Scraper] LoLalytics returned too few results", { count: data.length });
  } catch (err) {
    logger.warn("[Meta Scraper] LoLalytics scraper failed", { error: err.message });
  }

  // Priority 2: LeagueOfGraphs
  try {
    const data = await scrapeLeagueOfGraphs(patchShort);
    if (data.length >= 20) {
      storeMetaData(data, patchVersion, "leagueofgraphs");
      return { success: true, source: "leagueofgraphs", count: data.length };
    }
    logger.warn("[Meta Scraper] LeagueOfGraphs returned too few results", { count: data.length });
  } catch (err) {
    logger.warn("[Meta Scraper] LeagueOfGraphs scraper failed", { error: err.message });
  }

  // Priority 3: Graceful degradation — Claude uses built-in knowledge
  logger.info("[Meta Scraper] All scrapers failed — Claude will use built-in meta knowledge.");
  return { success: false, source: "none", count: 0 };
}

/**
 * Check if meta data needs refreshing and scrape if so.
 * Compares the last scraped patch against the current one.
 * @param {string} currentPatch — Full patch version e.g. "14.10.1"
 * @returns {Promise<void>}
 */
async function refreshMetaIfNeeded(currentPatch) {
  if (!currentPatch) {
    logger.warn("[Meta Scraper] No patch version available — skipping meta refresh.");
    return;
  }

  const lastPatch = queries.getSetting("last_meta_patch");
  if (lastPatch === currentPatch && queries.hasMetaData(currentPatch)) {
    logger.info("[Meta Scraper] Meta data up-to-date for patch", { patch: currentPatch });
    return;
  }

  logger.info("[Meta Scraper] Refreshing meta data", { currentPatch, lastPatch });
  const result = await scrapeAndStore(currentPatch);

  if (result.success) {
    queries.setSetting("last_meta_patch", currentPatch);
  }
}

module.exports = { refreshMetaIfNeeded, scrapeAndStore };
