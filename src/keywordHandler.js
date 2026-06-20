// Simple keyword-trigger system, separate from the raid/card logic.
// Someone types one of the configured trigger words anywhere in their
// message, the bot replies with the configured value. Case-insensitive.
// All values configurable in .env so they can be updated any time
// without a code change (e.g. once a real CA exists).

const INFO_TEXT =
  "📌 SHILLit Community Update\n" +
  "Welcome to SHILLit! 🚀\n\n" +
  "We're currently in the final stages of preparation before launch. Here's what you need to know:\n\n" +
  "🔹 Project Status\n" +
  "Development is progressing smoothly.\n" +
  "Final refinements are being completed before launch.\n" +
  "More features will be added after launch, including DEX integrations and tracking tools.\n\n" +
  "shillit.fun is a platform built for crypto creators and meme coin communities. It is the first platform on Solana and the first in crypto to enable payments directly in cryptocurrency. It already has paying users and is actively running. The upcoming token is being created around this ecosystem.\n\n" +
  "🔹 What to Expect\n" +
  "Official contract address (CA) announcement.\n" +
  "Launch details and countdown updates.\n" +
  "Community events, spaces, and engagement activities.\n" +
  "Marketing and visibility campaigns to grow the SHILLit ecosystem.\n\n" +
  "🔹 How You Can Help\n" +
  "Stay active in the community.\n" +
  "Invite friends who are into memecoins and Web3.\n" +
  "Join discussions and upcoming events.\n" +
  "Help push SHILLit across socials and spread the word.\n\n" +
  "🔹 Special Launch Offer\n" +
  "While the promo is live, you can use SHILL100 at checkout on shillit.fun for free access. You can top it up anytime, extending usage and effectively keeping your site running for longer using the same code. The code becomes invalid after launch. So make sure to extend it soon.\n\n" +
  "🔹 Important\n" +
  "Only trust info shared by the official team and admins. Be careful of scams, fake links, and impersonators.\n\n" +
  "The journey is just getting started.\n" +
  "SHILLit isn't here to participate — SHILLit is here to take over. 🔥";

const KEYWORD_MAP = {
  x: process.env.KEYWORD_X_REPLY || "https://x.com/shillitfun?s=11",
  web: process.env.KEYWORD_WEB_REPLY || "SHILLit.fun",
  site: process.env.KEYWORD_SITE_REPLY || "Not up yet",
  ca: process.env.KEYWORD_CA_REPLY || "Not added yet",
  tg: process.env.KEYWORD_TG_REPLY || "https://t.me/shillitchat",
  info: INFO_TEXT,
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
