/**
 * Tilt Guard — System prompt and tool definitions.
 */

const SYSTEM_PROMPT = `You are the Tilt Guard, a performance psychologist and physical wellness coach for competitive gamers. You specialize in HYROX-style functional fitness and calisthenics recovery routines.

You will receive a post-game tilt analysis including:
- The player's current tilt score (0-100)
- Their session stats (win/loss record, performance trends)
- Match-specific data from their most recent game
- Historical tilt patterns from past sessions

Your job is to use your tools to gather context and then emit ONE wellness recommendation.

RULES:
- Never be condescending. Frame breaks as PERFORMANCE OPTIMIZATION, not weakness.
- Use sports psychology language: "mental reset", "recovery window", "peak state"
- Scale activity intensity to tilt level:
  - Warming (26-50): 5-min desk stretches, box breathing
  - Tilted (51-75): 10-min calisthenics circuit (push-ups, squats, hanging)
  - Danger Zone (76-100): 15-20 min full routine (burpees, pull-ups, core work, cool-down)
- Reference specific HYROX movements when suggesting exercises:
  - Wall balls, sled push simulation, burpee broad jumps, farmers carry
- Always include a breathing component (box breathing or 4-7-8 technique)
- Provide a brief, non-judgmental session analysis focusing on PATTERNS, not blame
- If the player is on a win streak and performing well, celebrate it briefly
- If cool (0-25), give a positive "nice session" summary — no exercise needed
- Be specific about exercise form cues when listing exercises

RIOT POLICY — SHAMING & TOXICITY PREVENTION (MANDATORY):
- Your advice MUST focus EXCLUSIVELY on the USER's own wellness and performance.
- You are STRICTLY FORBIDDEN from generating negative preconceptions about teammates.
- NEVER label teammates as "bad," "inting," "trolling," "feeding," "autofilled," or any negative characterization.
- NEVER suggest the player lost because of a specific teammate's performance.
- Instead of "your top laner fed" → say "Focus on your own win conditions — play for the lanes that are strong."
- Instead of "bad teammate" → "Win Condition Optimization: identify which lane has the most carry potential and play around it."
- Frame all session analysis around the USER's decisions, positioning, and mental state — not teammates.
- If the player lost, focus on what THEY can control: their CS, map awareness, objective timing, mental reset.`;

const TOOLS = [
  {
    name: "get_session_summary",
    description: "Retrieve the current gaming session summary including all tilt metrics, match history, win/loss record, and performance trends.",
    input_schema: {
      type: "object",
      properties: {
        include_match_details: {
          type: "boolean",
          description: "Include per-match breakdowns (default true)",
        },
      },
    },
  },
  {
    name: "get_historical_tilt_patterns",
    description: "Retrieve past tilt episodes and what helped recovery. Shows patterns from previous sessions.",
    input_schema: {
      type: "object",
      properties: {
        lookback_days: {
          type: "number",
          description: "Number of days to look back (default 30)",
        },
      },
    },
  },
  {
    name: "emit_wellness_recommendation",
    description: "Send a wellness/cooldown recommendation to the player overlay. This is displayed as an interactive card with exercise instructions.",
    input_schema: {
      type: "object",
      properties: {
        tilt_level: {
          type: "string",
          enum: ["cool", "warming", "tilted", "danger_zone"],
          description: "Current tilt state",
        },
        headline: {
          type: "string",
          description: "Short headline shown prominently (max 80 chars)",
        },
        message: {
          type: "string",
          description: "Supportive message to the player (max 500 chars)",
        },
        activity: {
          type: "object",
          description: "Optional cooldown activity with exercises",
          properties: {
            type: {
              type: "string",
              enum: ["stretch", "calisthenics", "breathing", "walk", "full_routine"],
              description: "Type of activity",
            },
            duration_minutes: {
              type: "number",
              description: "Approximate duration in minutes",
            },
            exercises: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string", description: "Exercise name" },
                  reps_or_duration: { type: "string", description: "Reps or duration" },
                  description: { type: "string", description: "Form cues or instructions" },
                },
                required: ["name", "reps_or_duration"],
              },
              description: "List of exercises in the routine",
            },
          },
        },
        session_analysis: {
          type: "string",
          description: "Brief analysis of session patterns (non-judgmental)",
        },
      },
      required: ["tilt_level", "headline", "message"],
    },
  },
];

/**
 * Seed cooldown routine library.
 * Claude can reference these or create custom routines.
 */
const COOLDOWN_ROUTINES = {
  desk_stretch: {
    type: "stretch",
    duration_minutes: 5,
    exercises: [
      { name: "Neck Rolls", reps_or_duration: "30s each direction", description: "Slow, controlled circles. Drop chin to chest and roll ear to shoulder." },
      { name: "Wrist Circles & Extensions", reps_or_duration: "20s each", description: "Circle wrists both ways, then extend fingers and press palm forward." },
      { name: "Seated Spinal Twist", reps_or_duration: "20s each side", description: "Sit tall, cross one leg over. Twist toward the crossed leg, hand on knee." },
      { name: "Standing Forward Fold", reps_or_duration: "30s", description: "Feet hip-width, fold at hips. Let head and arms hang heavy." },
      { name: "Box Breathing", reps_or_duration: "4 cycles (4-4-4-4)", description: "Inhale 4s, hold 4s, exhale 4s, hold 4s. Eyes closed." },
    ],
  },
  calisthenics_circuit: {
    type: "calisthenics",
    duration_minutes: 10,
    exercises: [
      { name: "Push-ups", reps_or_duration: "15 reps", description: "Hands shoulder-width, full range of motion. Scale to knees if needed." },
      { name: "Air Squats", reps_or_duration: "20 reps", description: "Feet shoulder-width, break parallel. Drive through heels." },
      { name: "Dead Hang", reps_or_duration: "30s", description: "Full grip on bar/door frame. Relax shoulders, decompress spine." },
      { name: "Plank Hold", reps_or_duration: "45s", description: "Forearms down, body straight. Squeeze glutes and brace core." },
      { name: "Burpees", reps_or_duration: "8 reps", description: "Chest to floor, explosive jump. Controlled pace." },
      { name: "4-7-8 Breathing", reps_or_duration: "4 cycles", description: "Inhale 4s, hold 7s, exhale 8s. Slower exhale activates parasympathetic." },
    ],
  },
  hyrox_reset: {
    type: "full_routine",
    duration_minutes: 18,
    exercises: [
      { name: "Wall Ball Simulation", reps_or_duration: "15 reps", description: "Deep squat + overhead press with any weight. Full hip extension at top." },
      { name: "Burpee Broad Jumps", reps_or_duration: "10 reps", description: "Burpee into forward jump. Land soft, reset." },
      { name: "Farmers Carry", reps_or_duration: "60s walk", description: "Grab anything heavy (jugs, bags). Walk tall, shoulders packed." },
      { name: "Push-up to Down Dog", reps_or_duration: "10 reps", description: "Push-up, then pike hips up into downward dog. Hold 2s, repeat." },
      { name: "Hollow Body Hold", reps_or_duration: "30s", description: "Lie flat, lift legs and shoulders. Press lower back into floor." },
      { name: "Lunges", reps_or_duration: "12 each leg", description: "Alternating forward lunges. Knee tracks over toes, upright torso." },
      { name: "Cool-down: Standing Forward Fold", reps_or_duration: "60s", description: "Let gravity pull you down. Shake head gently yes/no." },
      { name: "Cool-down: Box Breathing", reps_or_duration: "6 cycles", description: "4-4-4-4 pattern. Full mental reset before next queue." },
    ],
  },
};

module.exports = { SYSTEM_PROMPT, TOOLS, COOLDOWN_ROUTINES };
