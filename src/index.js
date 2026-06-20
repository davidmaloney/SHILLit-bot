import "dotenv/config";
import { Telegraf } from "telegraf";
import "./db.js";
import { registerCommands } from "./commands.js";
import { registerPulseHandler } from "./pulseHandler.js";
import { registerRaidHandler } from "./raidHandler.js";
import { registerXCardWatcher } from "./xCardWatcher.js";
import { registerRepostHandler } from "./repostHandler.js";
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
// callbacks and raid/vote/remove callbacks each get a chance to handle
// their own prefix without colliding.
registerCommands({ bot, groupChatId: GROUP_CHAT_ID, founderUserId: FOUNDER_USER_ID });
registerWelcome({ bot });
registerXCardWatcher({ bot, founderUserId: FOUNDER_USER_ID });
registerRepostHandler({ bot });
registerKeywordHandler({ bot });
registerPulseHandler({ bot, groupChatId: GROUP_CHAT_ID, founderUserId: FOUNDER_USER_ID });
registerRaidHandler({ bot, groupChatId: GROUP_CHAT_ID, founderUserId: FOUNDER_USER_ID });

bot.catch((err, ctx) => {
  console.error(`[bot error] for update ${ctx.updateType}:`, err.message);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

bot
  .launch()
  .then(() => {
    console.log("Shillit Bot is live (polling mode).");
    startScheduler({ bot, groupChatId: GROUP_CHAT_ID, founderUserId: FOUNDER_USER_ID });
  })
  .catch((err) => {
    console.error("Failed to launch bot:", err.message);
    process.exit(1);
  });
