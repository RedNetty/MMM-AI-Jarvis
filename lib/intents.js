"use strict";

const { parseDuration, normalize } = require("./text");
const Clock = require("./Clock");

const DEFAULT_CLOCK = new Clock();

/**
 * Fast intent detection for the assistant's core skills.
 *
 * Small local models (2-4B parameters) are noticeably less reliable at tool
 * calling than cloud models – in testing a 0.8B model claimed to have saved a
 * preference without calling the tool. Recognising the most common mirror
 * requests up front means they always work, and skips an LLM round-trip,
 * which is a big latency win on a Raspberry Pi. Anything not matched here
 * falls through to the LLM with tools.
 */

const CLOTHING =
  "(?:shirt|t-?shirt|tee|top|blouse|sweater|jumper|hoodie|cardigan|jacket|coat|blazer|suit|vest|pants|trousers|jeans|shorts|skirt|dress|shoes|sneakers|trainers|boots|sandals|heels|scarf|hat|cap|beanie|belt|tie|bag|watch|clothes|clothing|outfit|item|piece|these|this|it)";

// Clothing, colour and fabric words: a "I like/hate …" statement containing one is a style preference.
const STYLE_WORDS = new RegExp(
  `\\b(?:wear|wearing|clothes|clothing|style|outfits?|fit|colou?rs?|fabric|wool|linen|cotton|silk|denim|leather|polyester|` +
    `black|white|grey|gray|navy|blue|red|green|yellow|orange|pink|purple|brown|beige|tan|olive|maroon|teal|pastels?|neon|` +
    `patterns?|stripes?|striped|floral|plaid|checked|baggy|slim|tight|loose|${CLOTHING.slice(3, -1)})\\b`,
  "i",
);

const NOT_TEAMS = new Set(["you", "we", "they", "things", "i", "it", "this", "that", "he", "she", "everyone", "everybody"]);
const DEICTIC = new Set(["that", "it", "this", "them", "those", "these"]);
const WIDGET_WORDS = /\b(score|scores|game|match|scoreboard|timer|timers|countdown|outfit|card|cards|panel|photo|picture|snapshot|wardrobe|list|info)\b/;

const SCORE_PATTERNS = [
  /\b(?:score|scores|result|results)\s+(?:of|for|in|from)\s+(?:the\s+)?(.+?)(?:\s+(?:game|match))?[\s?.!]*$/i,
  /\bwhat(?:'s|s| is| was) the (.+?) (?:score|result)\b/i,
  /\bhow (?:are|is|did) (?:the\s+)?(.+?)\s+(?:doing|playing|do|get on|getting on)\b/i,
  /\bdid (?:the\s+)?(.+?)\s+win\b/i,
  /\bwho(?:'s| is) winning (?:the\s+)?(.+?)(?:\s+(?:game|match))?[\s?.!]*$/i,
  /\bwhen (?:do|does|are|is) (?:the\s+)?(.+?)\s+play(?:ing)?\b/i,
  /\bwhat time (?:is|are|do|does) (?:the\s+)?(.+?)\s+(?:game|match|playing|play|on)\b/i,
  /\bwhen(?:'s| is) (?:the\s+)?(?:next\s+)?(.+?)\s+(?:game|match)\b/i,
  /\b(?:show|follow|track|put up|pull up|bring up)\s+(?:me\s+)?(?:the\s+)?(.+?)\s+(?:game|match|score|scores)\b/i,
];

// "what games are on", "any soccer on right now", "NBA scores", "who's playing tonight"
const OVERVIEW_PATTERNS = [
  /\b(?:what|which|any|are there(?: any)?)\s+(?:[\w.]+\s+){0,2}?(?:games?|matches)\s+(?:are\s+|is\s+)?(?:on|going on|happening|playing|being played|live|tonight|today|right now)\b/i,
  /\b(?:what are|show me|give me|check|get|read me|tell me)\s+(?:the\s+)?(?:latest\s+|live\s+)?(?:[\w.]+\s+){0,2}?scores\b/i,
  /\b(?:live|latest|current)\s+(?:[\w.]+\s+)?scores\b/i,
  /\bscores?\s+(?:right now|tonight|today|so far)\b/i,
  /\bwho(?:'s| is) playing (?:right now|tonight|today|now)\b/i,
  /\b(?:anything|what(?:'s| is))\s+(?:on|live)\s+in\s+(?:the\s+)?(?:nba|nfl|nhl|mlb|mls|wnba|premier league|champions league|europa league|la ?liga|bundesliga|serie a|ligue 1|hockey|basketball|baseball|football|soccer)\b/i,
];

const PATTERNS = [
  {
    name: "scan_clothing",
    match: (q) =>
      new RegExp(
        `\\b(?:add|save|scan|store|catalog(?:ue)?|put|remember)\\b.*\\b(?:wardrobe|closet)\\b|` +
          `\\b(?:add|save|scan|store|catalog(?:ue)?)\\s+(?:this|these|that|my|the)\\s+(?:new\\s+)?${CLOTHING}\\b|` +
          `\\bremember\\s+(?:this|these)\\s+${CLOTHING}\\b`,
        "i",
      ).test(q) && { hint: q },
  },
  {
    name: "look_at_user",
    match: (q) =>
      /\b(?:how do i look|how am i looking|do i look|what am i wearing|look at me|can you see me|what do you see|rate my (?:outfit|look)|(?:does|do) (?:this|these|my \w+) (?:look|go|match|work)|is this (?:outfit|look) (?:ok|okay|good|alright))\b/i.test(q) && {
        question: q,
      },
  },
  {
    name: "suggest_outfit",
    match: (q) =>
      /\b(?:what (?:should|do|can|could) i wear|what to wear|wear (?:today|tomorrow|tonight)|(?:pick|choose|suggest|recommend|plan|put together)\b.*\b(?:outfit|clothes|something to wear)|outfit (?:for|idea|ideas|suggestion|suggestions)|dress(?:ed)? for)\b/i.test(q) && {
        request: q,
      },
  },
  {
    name: "log_outfit_worn",
    match: (q) =>
      /\b(?:i(?:'m| am) wearing (?:that|this|it)|i(?:'ll| will) wear (?:that|this|it)|(?:log|save|record) (?:this|that|today'?s|my) outfit|wearing that today)\b/i.test(q) && {},
  },
  {
    name: "sports_overview",
    match: (q) => OVERVIEW_PATTERNS.some((re) => re.test(q)) && { query: q },
  },
  {
    name: "show_score",
    match: (q) => {
      for (const re of SCORE_PATTERNS) {
        const m = re.exec(q);
        const team = m?.[1]?.replace(/[?.!,]+$/, "").trim();
        if (team && !NOT_TEAMS.has(normalize(team))) return { team };
      }
      return null;
    },
  },
  {
    // Time, date and countdown questions – exact answers from the clock.
    name: "time_answer",
    match: (q, ctx) => ((ctx.clock ?? DEFAULT_CLOCK).answer(q) ? { question: q } : null),
  },
  {
    name: "weather_answer",
    match: (q) =>
      /\b(?:weather|forecast|temperature|how (?:cold|hot|warm|chilly) is it|will it (?:rain|snow|be (?:cold|hot|warm|sunny))|is it (?:going to )?(?:rain|snow|be cold|be hot|cold|hot|sunny|raining|snowing)|(?:need|bring|take|grab) (?:an? |my )?(?:umbrella|jacket|coat)|degrees outside)\b/i.test(q) && {
        question: q,
      },
  },
  {
    name: "cancel_timer",
    match: (q) => {
      const m = /\b(?:cancel|stop|delete|clear|remove|turn off)\s+(?:the\s+|my\s+|all\s+)?(.*?)\s*timers?\b/i.exec(q);
      return m ? { label: m[1] } : null;
    },
  },
  {
    name: "timer_status",
    match: (q) =>
      /\b(?:how (?:much|long)(?: time)?(?: is)? (?:left|remaining)|time left|how long (?:until|till|is left on|left on) (?:the |my )?(?:\w+ )?timer)\b/i.test(q) && {},
  },
  {
    name: "set_timer",
    match: (q) => {
      if (!/\b(?:timer|countdown|remind me in)\b/i.test(q)) return null;
      const seconds = parseDuration(q);
      return seconds ? { seconds, label: timerLabel(q) } : null;
    },
  },
  {
    name: "focus_mode",
    match: (q) => /\b(?:focus mode|clear the (?:screen|mirror)|hide (?:everything|all(?: the)? modules|all)|only show you)\b/i.test(q) && {},
  },
  {
    name: "show_module",
    match: (q) =>
      /\b(?:(?:show|bring back|restore|unhide)\s+(?:me\s+)?(?:everything|all(?: the)? modules|it all)|exit focus mode|(?:turn off|stop|end|leave) focus mode|unfocus)\b/i.test(q) && {
        target: "everything",
      },
  },
  {
    name: "hide_on_mirror",
    match: (q, ctx) => {
      const m = /^(?:please\s+)?(?:hide|close|dismiss|remove|turn off|get rid of|clear)\s+(?:the\s+|that\s+|my\s+|your\s+)?(.+?)[\s.!?]*$/i.exec(q);
      if (!m) return null;
      const target = m[1].trim();
      const n = normalize(target);
      if (DEICTIC.has(n) || /\b(everything|cards?)\b/.test(n)) return { target: "everything" };
      if (WIDGET_WORDS.test(n) || ctx.screen?.find(n).length) return { target };
      return null;
    },
  },
  {
    name: "show_module",
    match: (q, ctx) => {
      const m = /^(?:please\s+)?(?:show|bring back|unhide|turn on)\s+(?:me\s+)?(?:the\s+|my\s+)?(.+?)[\s.!?]*$/i.exec(q);
      if (!m) return null;
      return ctx.screen?.find(m[1]).length ? { target: m[1] } : null;
    },
  },
  {
    // "put a packing list on the mirror", "show me a recipe for pancakes", "make a checklist for…"
    name: "compose_panel",
    match: (q) =>
      (/\b(?:put|show|display|write|pin|bring up)\b.+\bon (?:the |my )?(?:mirror|screen|display)\b/i.test(q) ||
        /^(?:please\s+)?(?:show|give|make|write|display)\s+(?:me\s+)?(?:a|an|the|some)\s+(?:\w+\s+){0,3}?(?:list|checklist|recipe|steps|instructions|summary|plan|schedule|agenda|itinerary|routine)\b/i.test(q)) && {
        request: q,
      },
  },
  {
    name: "forget",
    match: (q) => {
      const m = /^(?:please\s+)?forget\s+(?:that\s+|about\s+)?(.{3,}?)[\s.!?]*$/i.exec(q);
      return m && !/^(?:it|that|this)$/i.test(m[1]) ? { fact: m[1] } : null;
    },
  },
  {
    // Style preferences said in passing: "I really don't like wearing orange", "I prefer slim-fit jeans".
    name: "remember",
    match: (q) => {
      const m = /^(?:honestly,?\s+|also,?\s+)?((?:i\s+(?:really\s+|just\s+)?(?:don'?t like|do not like|hate|dislike|love|like|prefer|can'?t stand|never wear|always wear)|i(?:'m| am) allergic to)\b.{3,}?)[\s.!?]*$/i.exec(q);
      return m && STYLE_WORDS.test(m[1]) ? { fact: toThirdPerson(m[1]) } : null;
    },
  },
  {
    name: "remember",
    match: (q) => {
      const m = /^(?:please\s+)?(?:remember|note|keep in mind|don't forget)\s+(?:that\s+)?(.{4,}?)[\s.!?]*$/i.exec(q);
      return m ? { fact: toThirdPerson(m[1]) } : null;
    },
  },
];

/**
 * @param {string} query
 * @param {{ isAvailable?: (name: string) => boolean, screen?: import("./Screen"), clock?: import("./Clock") }} [ctx]
 * @returns {{ name: string, args: object } | null}
 */
function detectIntent(query, ctx = {}) {
  const text = String(query ?? "").trim();
  const isAvailable = ctx.isAvailable ?? (() => true);
  for (const p of PATTERNS) {
    const args = p.match(text, ctx);
    if (args && isAvailable(p.name)) return { name: p.name, args };
  }
  return null;
}

/**
 * Match a user-defined voice command from config.customCommands.
 * @param {string} query
 * @param {{ phrases: string[], notification: string, payload?: any, reply?: string }[]} commands
 */
function matchCustomCommand(query, commands = []) {
  const q = ` ${normalize(query)} `;
  return commands.find((c) => (c.phrases ?? []).some((p) => normalize(p) && q.includes(` ${normalize(p)} `))) ?? null;
}

const THIRD_PERSON_VERBS = {
  "don't": "doesn't", "do not": "does not", hate: "hates", love: "loves", like: "likes", prefer: "prefers",
  dislike: "dislikes", wear: "wears", need: "needs", want: "wants", have: "has", own: "owns", work: "works",
  "can't": "can't",
};

/**
 * "my office is business casual" → "the user's office is business casual"
 * "I really don't like orange"   → "the user really doesn't like orange"
 */
function toThirdPerson(text) {
  return String(text)
    .replace(/\bI am\b|\bI'm\b/gi, "the user is")
    .replace(/\bI've\b/gi, "the user has")
    .replace(/\bI'd\b/gi, "the user would")
    .replace(/\bI\b/g, "the user")
    .replace(/\bmy\b/gi, "the user's")
    .replace(/\bmine\b/gi, "the user's")
    .replace(/\bme\b/gi, "the user")
    .replace(/\bmyself\b/gi, "themselves")
    .replace(
      /\bthe user((?:\s+(?:really|just|never|always|also|usually|honestly))*)\s+(don't|do not|hate|love|like|prefer|dislike|wear|need|want|have|own|work)\b/gi,
      (_, adverbs, verb) => `the user${adverbs} ${THIRD_PERSON_VERBS[verb.toLowerCase()]}`,
    )
    .trim();
}

function timerLabel(q) {
  return normalize(q)
    .replace(/\b\d+(?:\.\d+)?\s*(?:hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/g, " ")
    .replace(/\b(?:half an? hour|and a half|an? (?:hour|minute|second)|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|forty five|fifty|sixty|ninety)\b/g, " ")
    .replace(/\b(?:hours?|minutes?|seconds?|set|start|make|put|create|please|iris|jarvis|can you|could you|me|a|an|the|for|on|of|timer|countdown|remind|in|and|up|about|around|roughly|approximately|exactly|just|like|go|ok|okay)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

module.exports = { detectIntent, matchCustomCommand, toThirdPerson, timerLabel };
