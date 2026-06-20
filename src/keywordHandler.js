// Simple keyword-trigger system, separate from the raid/card logic.
// Someone types one of the configured trigger words anywhere in their
// message, the bot replies with the configured value. Case-insensitive.
// All values configurable in .env so they can be updated any time
// without a code change (e.g. once a real CA exists).

const KEYWORD_MAP = {
  x: process.env.KEYWORD_X_REPLY || "https://x.com/shillitfun?s=11",
  web: process.env.KEYWORD_WEB_REPLY || "SHILLit.fun",
  site: process.env.KEYWORD_SITE_REPLY || "Not up yet",
  ca: process.env.KEYWORD_CA_REPLY || "Not added yet",
};

// Matches the keyword as a standalone word (case-insensitive) so it
// doesn't accidentally trigger on it appearing inside another word.
function buildKeywordRegex(keyword) {
  return new RegExp(`\\b${keyword}\\b`, "i");
}

const KEYWORD_PATTERNS = Object.entries(KEYWORD_MAP).map(([keyword, reply]) => ({
  keyword,
  reply,
  regex: buildKeywordRegex(keyword),
}));

const URL_REGEX = /https?:\/\//i;

export function registerKeywordHandler({ bot }) {
  bot.on("message", async (ctx, next) => {
    const text = ctx.message?.text;
    if (!text) return next();

    // Don't trigger on commands like /start, /help etc.
    if (text.startsWith("/")) return next();

    // Don't trigger on messages containing a link — those are likely
    // raid-card submissions, not someone casually typing a keyword.
    if (URL_REGEX.test(text)) return next();

    for (const { regex, reply } of KEYWORD_PATTERNS) {
      if (regex.test(text)) {
        try {
          await ctx.reply(reply);
        } catch (err) {
          console.warn("[keywordHandler] failed to reply:", err.message);
        }
        // Only respond to the first matching keyword per message to
        // avoid a single message triggering multiple replies.
        break;
      }
    }

    return next();
  });
}
