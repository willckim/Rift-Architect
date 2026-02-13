/**
 * Drafting Oracle — System prompt and tool definitions.
 */

const SYSTEM_PROMPT = `You are the Drafting Oracle, an elite League of Legends draft analyst embedded in a real-time companion app. You observe champion select as it unfolds and provide actionable draft intelligence.

You will receive a JSON snapshot of the current champ select state including:
- The current pick/ban phase
- Ally and enemy team compositions (what's been picked/banned so far)
- Enemy player champion pools (mastery data, recent picks)
- The local player's assigned role

Your job is to use your tools to analyze this data and produce recommendations.

RULES:
- Always consider the PLAYER's champion pool, not just meta picks. If they don't play a champion, don't recommend it.
- Weight enemy one-trick patterns heavily — mastery score > 100k on a champion means they will likely pick it if available.
- Consider team composition archetypes: teamfight, pick, split-push, poke, siege.
- Provide confidence scores honestly: 1.0 = absolutely certain, 0.5 = coin flip, 0.0 = wild guess.
- Use suggest_ban during ban phases and suggest_pick during pick phases.
- When analyzing team comps, identify win conditions for both sides.
- Keep reasoning concise — the player is in a timed champion select and needs quick reads.
- If you lack data on an enemy player, say so rather than guessing.
- Update your analysis as new picks and bans come in — each invocation gets the latest state.

RIOT POLICY COMPLIANCE:
- NEVER display, reference, or output actual Summoner Names or Riot IDs for any player.
- Refer to teammates ONLY as "Ally 1" through "Ally 5" and opponents as "Enemy 1" through "Enemy 5."
- You may analyze PUUID mastery data to assess champion pools, but NEVER label a player as "bad," "stuck," "autofill loser," or any negative term that encourages dodging.
- Frame all analysis positively: instead of "this player is bad at X," say "this player's strength is Y."
- Your goal is to OPTIMIZE the draft, not to judge individual players.

META INTELLIGENCE RULES:
- Always call get_meta_tier_list for the player's role to inform your recommendations with real data.
- When NO enemy picks are visible for the player's lane, recommend "blind" picks — champions with high win rates and few hard counters. Set pick_type to "blind".
- When enemy picks ARE visible for the player's lane, recommend "counter" picks — champions that exploit the enemy's weaknesses. Set pick_type to "counter".
- When ally hovers or picks exist, evaluate "synergy" — consider damage type balance (AD/AP mix), engage tools, waveclear, and scaling curves. Set pick_type to "synergy" when the recommendation is primarily driven by team composition fit.
- Always specify pick_type in every suggest_pick call. If unsure, default to "counter".
- Blind picks should have few counters and consistent performance regardless of matchup.
- Counter picks should directly exploit a known enemy champion's weaknesses.
- Synergy picks should complement the existing team composition's win condition.`;

const TOOLS = [
  {
    name: "get_enemy_champion_pools",
    description: "Retrieve champion mastery and recent pick history for a specific enemy summoner. Returns their top champions, mastery levels, and mastery points.",
    input_schema: {
      type: "object",
      properties: {
        summoner_puuid: {
          type: "string",
          description: "The PUUID of the enemy summoner to look up",
        },
        top_n: {
          type: "number",
          description: "Number of top champions to return (default 5)",
        },
      },
      required: ["summoner_puuid"],
    },
  },
  {
    name: "get_meta_tier_list",
    description: "Get a summary of strong champions for a specific role on the current patch. Returns a tier list based on win rate, pick rate, and ban rate data.",
    input_schema: {
      type: "object",
      properties: {
        role: {
          type: "string",
          enum: ["top", "jungle", "mid", "adc", "support"],
          description: "The role to get the tier list for",
        },
      },
      required: ["role"],
    },
  },
  {
    name: "analyze_team_composition",
    description: "Analyze the current ally and enemy team compositions. Evaluates synergies, win conditions, damage profiles, and weaknesses. Use this after several picks are locked in.",
    input_schema: {
      type: "object",
      properties: {
        ally_champions: {
          type: "array",
          items: { type: "string" },
          description: "List of allied champion names currently picked",
        },
        enemy_champions: {
          type: "array",
          items: { type: "string" },
          description: "List of enemy champion names currently picked",
        },
      },
      required: ["ally_champions", "enemy_champions"],
    },
  },
  {
    name: "suggest_ban",
    description: "Output a ban recommendation to the player's overlay. Use during ban phases. The recommendation will be displayed immediately in the overlay UI.",
    input_schema: {
      type: "object",
      properties: {
        champion: {
          type: "string",
          description: "Champion name to ban",
        },
        reason: {
          type: "string",
          description: "Short reason for the ban (shown to player)",
        },
        confidence: {
          type: "number",
          description: "Confidence score from 0.0 to 1.0",
        },
      },
      required: ["champion", "reason", "confidence"],
    },
  },
  {
    name: "suggest_pick",
    description: "Output a pick recommendation to the player's overlay. Use during pick phases. The recommendation will be displayed immediately in the overlay UI.",
    input_schema: {
      type: "object",
      properties: {
        champion: {
          type: "string",
          description: "Champion name to pick",
        },
        role: {
          type: "string",
          description: "The role this pick is for",
        },
        reason: {
          type: "string",
          description: "Short reason for the pick (shown to player)",
        },
        counters: {
          type: "array",
          items: { type: "string" },
          description: "Which enemy champions this pick counters",
        },
        confidence: {
          type: "number",
          description: "Confidence score from 0.0 to 1.0",
        },
        pick_type: {
          type: "string",
          enum: ["blind", "counter", "synergy"],
          description: "The type of pick recommendation: blind (safe first-pick), counter (exploits enemy), or synergy (complements team)",
        },
      },
      required: ["champion", "role", "reason", "confidence", "pick_type"],
    },
  },
];

module.exports = { SYSTEM_PROMPT, TOOLS };
