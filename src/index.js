import "dotenv/config";
import { Telegraf } from "telegraf";
import "./db.js";
import { registerCommands } from "./commands.js";
import { registerPulseHandler } from "./pulseHandler.js";
import { registerCardSystem } from "./cardSystem.js";
import { registerPollSystem } from "./pollSystem.js";
import { registerKeywordHandler } from "./keywordHandler.js";
import { registerWelcome } from "./welcome.js";
import { startScheduler } from "./scheduler.js";
import { setFounder } from "./reputation.js";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID;
const FOUNDER_USER_ID = process.env.FOUNDER_USER_ID;

if (!BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN in .env — exiting.");
  process.exit(1);
}
if (!GROUP_CHAT_ID) {
  console.error("Missing GROUP_CHAT_ID in .env — exiting.");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

if (FOUNDER_USER_ID) {
  setFounder(FOUNDER_USER_ID, null);
}

// Order matters: callback_query handlers chain via next() so pulse
// callbacks and card (vote/remove) callbacks each get a chance to handle
// their own prefix without colliding.
registerCommands({ bot, groupChatId: GROUP_CHAT_ID, founderUserId: FOUNDER_USER_ID });
registerWelcome({ bot });
registerKeywordHandler({ bot });
registerPulseHandler({ bot, groupChatId: GROUP_CHAT_ID, founderUserId: FOUNDER_USER_ID });
registerCardSystem({ bot, groupChatId: GROUP_CHAT_ID, founderUserId: FOUNDER_USER_ID });
registerPollSystem({ bot, founderUserId: FOUNDER_USER_ID });

bot.catch((err, ctx) => {
  console.error(`[bot error] for update ${ctx.updateType}:`, err.message);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

// Start the scheduler BEFORE launching. bot.launch() returns a promise
// that does not resolve until the bot STOPS, so anything placed in its
// .then() would never run while the bot is alive — which previously left
// every automatic timer (pulses, card expiry, raid auto-closing, role
// decay, spotlight) switched off, even though manual actions like
// /force_pulse still worked. The scheduler only uses bot.telegram, which
// is ready as soon as the Telegraf instance exists, so starting here is
// safe and guarantees the timers actually run.
startScheduler({ bot, groupChatId: GROUP_CHAT_ID, founderUserId: FOUNDER_USER_ID });

bot
  .launch()
  .then(() => {
    console.log("Shillit Bot is live (polling mode).");
  })
  .catch((err) => {
    console.error("Failed to launch bot:", err.message);
    process.exit(1);
  });
