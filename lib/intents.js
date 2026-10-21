"use strict";

const { parseDuration, normalize } = require("./text");
const Clock = require("./Clock");
const Calculator = require("./data/Calculator");
const Currency = require("./data/Currency");
const Dictionary = require("./data/Dictionary");

const DEFAULT_CLOCK = new Clock();
// "Put the weather on the left", "make the clock bigger": about the layout, not the weather or the time.
const LAYOUT_VERBS = /^(?:please\s+)?(?:can you\s+)?(?:move|put|place|shift|drag|relocate|stick|make|shrink|enlarge|grow|zoom|where(?:'s| is))\b/i;
const CURRENCY = new Currency();

// "Good morning", "brief me", "what's my day look like".
const BRIEFING = /^(?:good morning|morning|brief me|(?:give me |what's |whats )?(?:my|the|a) (?:daily |morning )?(?:briefing|rundown|summary)|what(?:'s| is| does) (?:my day|today) look(?:ing)? like|catch me up)\b/i;
const SUN = /\b(?:sunrise|sunset|sun ?(?:rise|set)s?|(?:the )?sun (?:come|comes|coming|go|goes|going) (?:up|down)|when does it get (?:dark|light)|how much daylight)\b/i;
const MARKET = /\b(?:stocks?|shares|share price|stock market|the markets?|wall street|dow(?: jones)?|nasdaq|s ?(?:&|and) ?p(?: 500)?|ftse|nikkei|bitcoin|ethereum|crypto(?:currency)?|dogecoin|solana|price of (?:gold|silver|oil)|gold price|oil price)\b/i;
// Companies people ask about by name, plus finance phrasing: "how much is Tesla", "what's Nvidia trading at".
const COMPANIES = "apple|microsoft|tesla|nvidia|amazon|google|alphabet|meta|facebook|netflix|amd|intel|disney|nike|coca[- ]?cola|pepsi|walmart|costco|target|boeing|berkshire(?: hathaway)?|jp ?morgan|visa|mastercard|paypal|uber|lyft|airbnb|spotify|palantir|gamestop|amc|coinbase|robinhood|shopify|salesforce|oracle|ibm|starbucks|mcdonald'?s|pfizer|moderna|ford|general motors|gm|toyota|sony|samsung|tsmc|arm|broadcom|qualcomm|adobe|snowflake|zoom|rivian|lucid|exxon|chevron|bank of america|wells fargo|goldman sachs|home depot|at ?(?:&|and) ?t|verizon|johnson (?:&|and) johnson|procter (?:&|and) gamble|eli lilly|unitedhealth|merck|abbvie|caterpillar|lockheed martin|general electric|t-mobile|comcast|dell|hp|cisco|micron|super micro|dogecoin|xrp|cardano|litecoin";
const COMPANY_MARKET = new RegExp(`\\b(?:${COMPANIES})\\b`, "i");
const FINANCE_WORDS = /\b(?:compare|versus|vs|trading|traded|price|priced|worth|cost|valued?|up today|down today|up or down|market cap|52.week|all.time high|earnings|dividend|how much is|how is|how's|hows|how are|doing today|today|at right now|going for|selling for|these days|lately|at the moment)\b/i;
const FINANCE_PHRASES = /\b(?:trading at|share price|stock price|market cap(?:italization)?|ticker|earnings|dividend|52.week (?:high|low)|all.time high)\b/i;
const NEWS = /\b(?:news|headlines|top stories|what's happening in the world|what is happening in the world|latest on|what's new with|whats new with)\b/i;
const NOT_NEWS = /^(?:please\s+)?(?:hide|close|remove|dismiss|turn off|clear|show|bring back|unhide)\s+(?:the\s+|my\s+)?(?:news|newsfeed|headlines)\b/i;
// "who is Taylor Swift", "tell me about the Eiffel Tower", "what is a black hole".
const KNOWLEDGE = /^(?:(?:can|could) you\s+)?(?:tell me (?:about|who|what)|what do you know about|who (?:is|was|were|are)|what (?:is|was|are) (?:a|an))\s+(.{2,60}?)[?.!]*$/i;
const NOT_KNOWLEDGE = /^(?:you|your\b|yourself|i\b|me\b|my\b|we\b|winning|playing|on\b|there|it\b|this|that|here|calling|the best|good|better|the weather|the time|the date)/i;

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
    name: "briefing",
    match: (q) => BRIEFING.test(q.trim()) && {},
  },
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
      if (MARKET.test(q) || COMPANY_MARKET.test(q)) return null; // "how's the stock market / Google doing" is not a team
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
    name: "sun_times",
    match: (q) => SUN.test(q) && { question: q },
  },
  {
    name: "weather_answer",
    match: (q) =>
      !LAYOUT_VERBS.test(q.trim()) &&
      /\b(?:weather|forecast|temperature|how (?:cold|hot|warm|chilly) is it|will it (?:rain|snow|be (?:cold|hot|warm|sunny))|is it (?:going to )?(?:rain|snow|be cold|be hot|cold|hot|sunny|raining|snowing)|(?:need|bring|take|grab) (?:an? |my )?(?:umbrella|jacket|coat)|degrees outside)\b/i.test(q) && {
        question: q,
      },
  },
  {
    // Maths, unit conversions and tips: exact, never the language model.
    name: "calculate",
    match: (q) => (Calculator.answer(q) ? { question: q } : null),
  },
  {
    name: "convert_currency",
    match: (q) => (CURRENCY.parse(q) ? { request: q } : null),
  },
  {
    name: "define_word",
    match: (q) => (Dictionary.word(q) ? { request: q } : null),
  },
  {
    name: "market_quote",
    match: (q) =>
      (MARKET.test(q) || FINANCE_PHRASES.test(q) || (COMPANY_MARKET.test(q) && FINANCE_WORDS.test(q))) &&
      !/\b(?:wear|outfit|wardrobe|grocery|groceries|shopping|recipe|pie|juice|watch|iphone|tv show|movie)\b/i.test(q) && { request: q },
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
  // ── Whole-mirror display control ──
  {
    // "move the clock to the top right", "put the weather on the left side", "move yourself to the bottom",
    // "shove the compliments up near the top", "can you stick the calendar over on the left", "move the clock left"
    name: "move_module",
    match: (q, ctx) => {
      const m =
        /^(?:please\s+)?(?:(?:can|could|would) you\s+)?(?:please\s+)?(?:move|put|place|shift|drag|relocate|stick|shove|slide|bump|send|throw|park|pop|push|take)\s+(?:the\s+|my\s+)?(.+?)\s+(?:(?:all the way|way|back|over|up|down)\s+)?(?:(?:to|on|in|into|at|onto|near|towards?|by|up to|down to|over to|over on|over in)\s+)?(?:the\s+)?((?:top|upper|bottom|lower|middle|center|centre|left|right|up|down)\b.*?)(?:\s+(?:please|for me))?[\s.!?]*$/i.exec(
          q.trim(),
        );
      if (!m) return null;
      const target = m[1].trim();
      if (ctx.screen && !ctx.screen.find(target).length && !/^(?:you|yourself)$/i.test(target)) return null;
      return { target, where: m[2] };
    },
  },
  {
    // "make the clock bigger", "shrink the news", "make everything bigger", "make the text smaller",
    // "the text is too small", "I can't read the calendar"
    name: "resize_module",
    match: (q, ctx) => {
      const t = q.trim().replace(/[.!?]+$/, "");
      let m = /^(?:please\s+)?(?:can you\s+)?(?:make|turn|set)\s+(?:the\s+|my\s+)?(.+?)\s+(?:a (?:bit|little|lot)\s+)?(bigger|larger|huge|smaller|tiny|normal size|regular size|default size|normal|the normal size)$/i.exec(t);
      if (m) return { target: m[1], change: /bigger|larger|huge/i.test(m[2]) ? "bigger" : /smaller|tiny/i.test(m[2]) ? "smaller" : "reset" };
      m = /^(?:please\s+)?(enlarge|grow|zoom in on|shrink|zoom out on)\s+(?:the\s+|my\s+)?(.+)$/i.exec(t);
      if (m) return { target: m[2], change: /enlarge|grow|zoom in/i.test(m[1]) ? "bigger" : "smaller" };
      m = /^(?:please\s+)?(bigger|smaller|larger) (?:text|font|writing)$/i.exec(t);
      if (m) return { target: "everything", change: /smaller/i.test(m[1]) ? "smaller" : "bigger" };
      // Complaints: only about the text itself or a module that is on this mirror ("my shirt is too small" isn't).
      m =
        /^(?:the\s+|my\s+)?(.+?)(?:'s|\s+is|\s+are)\s+(?:way\s+|much\s+|a (?:bit|little)\s+)?too\s+(small|tiny|little|big|large|huge)$/i.exec(t) ??
        /^i\s+can(?:'?t|not)\s+read\s+(?:the\s+|my\s+)?(.+?)()$/i.exec(t);
      if (!m) return null;
      const target = m[1].trim();
      const everything = /^(?:the\s+)?(?:text|font|writing|words|letters|everything|it all|mirror|screen)$/i.test(target);
      if (!everything && !ctx?.screen?.find(target).length) return null;
      return { target: everything ? "everything" : target, change: /big|large|huge/i.test(m[2]) ? "smaller" : "bigger" };
    },
  },
  {
    name: "screen_power",
    match: (q) => {
      const t = q.trim().toLowerCase().replace(/[.!?]+$/, "");
      if (/^(?:please\s+)?(?:turn|switch|shut)\s+(?:the\s+|your\s+)?(?:screen|display|mirror|monitor)\s+off$|^(?:please\s+)?(?:turn|switch|shut)\s+off\s+(?:the\s+|your\s+)?(?:screen|display|mirror|monitor)$|^(?:screen|display) off$|^(?:go to sleep|sleep mode|go dark|lights out|blank the screen)$/.test(t)) return { on: false };
      if (/^(?:please\s+)?(?:turn|switch)\s+(?:the\s+|your\s+)?(?:screen|display|mirror|monitor)\s+(?:back\s+)?on$|^(?:please\s+)?(?:turn|switch)\s+on\s+(?:the\s+)?(?:screen|display|mirror)$|^(?:screen|display) on$|^wake up$/.test(t)) return { on: true };
      return null;
    },
  },
  {
    name: "brightness",
    match: (q) => {
      const t = q.toLowerCase();
      const pct = /\bbrightness\s+(?:to\s+|at\s+)?(\d{1,3})\s*(?:%|percent)?/.exec(t) ?? /\b(?:set|make)\s+(?:the\s+)?(?:screen|mirror|display)\s+(?:to\s+)?(\d{1,3})\s*(?:%|percent)\b/.exec(t);
      if (pct) return { change: Math.min(100, Number(pct[1])) / 100 };
      if (/\b(?:full|max(?:imum)?) brightness\b/.test(t)) return { change: 1 };
      const screen = "(?:the\\s+)?(?:brightness|screen|mirror|display)";
      const down = new RegExp(
        `^(?:please\\s+)?(?:dim|darken)\\b|\\b(?:dimmer|too bright|less bright|blinding|hurts my eyes|turn it down|brightness (?:down|lower)|` +
          `(?:turn|bring|tone|knock|dial|bump|crank)\\s+(?:down\\s+${screen}|${screen}\\s+down)|(?:lower|reduce|decrease|drop|cut) (?:the )?brightness)\\b`,
      );
      const up = new RegExp(
        `^(?:please\\s+)?brighten\\b|\\b(?:brighter|too dark|more bright|hard to see|can'?t see (?:anything|a thing|the (?:screen|mirror))|turn it up|brightness (?:up|higher)|` +
          `(?:turn|bring|crank|bump|pump|ramp|kick|jack|dial)\\s+(?:up\\s+${screen}|${screen}\\s+up)|(?:raise|increase|boost|up) (?:the )?brightness)\\b`,
      );
      if (down.test(t)) return { change: "dimmer" };
      if (up.test(t)) return { change: "brighter" };
      return null;
    },
  },
  {
    name: "night_mode",
    match: (q) => {
      const t = q.toLowerCase();
      if (/\b(?:night|bedtime|evening|sleep) mode\b/.test(t) && !/\b(?:off|stop|end|exit|turn off|disable)\b/.test(t)) return { on: true };
      if (/\b(?:day|normal|daytime) mode\b|\b(?:turn off|stop|end|exit|disable) (?:the )?night mode\b|\bnight mode off\b/.test(t)) return { on: false };
      return null;
    },
  },
  {
    name: "save_scene",
    match: (q) => {
      const m = /\bsave (?:this|the current|the|my)? ?(?:layout|setup|scene|view|arrangement|screen)(?: as| called| named)? ?(.*?)[.!?]*$/i.exec(q);
      return m ? { name: m[1].replace(/^(?:my|the)\s+/i, "").trim() } : null;
    },
  },
  {
    name: "load_scene",
    match: (q) => {
      if (/\b(?:night|day|normal|focus) mode\b/i.test(q)) return null;
      const m = /^(?:please\s+)?(?:switch to|load|go to|use|activate|change to|restore|apply|bring up)\s+(?:my\s+|the\s+)?(.+?)\s+(?:layout|scene|view|setup|arrangement|mode)[.!?]*$/i.exec(q.trim());
      return m ? { name: m[1] } : null;
    },
  },
  {
    name: "reset_layout",
    match: (q) => /\b(?:reset|undo|restore) (?:the |my )?(?:layout|screen|mirror|arrangement|display)\b|\bdefault layout\b|\bput everything back where it (?:was|started|belongs)\b/i.test(q) && {},
  },
  {
    name: "reload_mirror",
    match: (q) => /^(?:please\s+)?(?:refresh|reload|restart) (?:the |your )?(?:mirror|screen|display|page)[.!?]*$/i.test(q.trim()) && {},
  },
  {
    name: "where_is",
    match: (q, ctx) => {
      const m = /^where(?:'s| is| are)\s+(?:the\s+|my\s+)?(.+?)[\s?.!]*$/i.exec(q.trim());
      if (!m) return null;
      const target = m[1];
      if (/^(?:you|iris)$/i.test(target)) return { target: "yourself" };
      return ctx.screen?.find(target).length ? { target } : null;
    },
  },
  {
    name: "describe_screen",
    match: (q) => /\bwhat(?:'s|s| is) (?:on|showing on) (?:the |my )?(?:mirror|screen|display)\b|\bwhat modules\b/i.test(q) && {},
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
    name: "news",
    match: (q) => NEWS.test(q) && !NOT_NEWS.test(q.trim()) && { request: q },
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
  {
    // Facts about people, places and things, from Wikipedia with a picture.
    name: "knowledge",
    match: (q) => {
      const m = KNOWLEDGE.exec(q.trim());
      const topic = m?.[1]?.trim();
      // "Who is the president of France" needs current facts and reasoning: the grounded language model handles it.
      if (!topic || NOT_KNOWLEDGE.test(topic) || /^the\b.*\bof\b/i.test(topic)) return null;
      return { query: q.trim() };
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
