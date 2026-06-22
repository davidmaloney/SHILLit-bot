import db from "./db.js";
import { recordInteraction } from "./reputation.js";

const RECOGNITION_TITLES = new Set([
  "Diamond Hand",
  "Signal Reader",
  "Conviction Holder",
  "Council of Shillers",
]);

export function registerPulseHandler({ bot, groupChatId, founderUserId }) {
  bot.on("callback_query", async (ctx, next) => {
    const data = ctx.callbackQuery.data || "";
    if (!data.startsWith("pulse:")) return next();

    const [, pulseIdStr, action] = data.split(":");
    const pulseId = parseInt(pulseIdStr, 10);

    const pulse = db.prepare("SELECT * FROM pulses WHERE pulse_id = ?").get(pulseId);

    if (!pulse || !pulse.active || pulse.expires_at <= Date.now()) {
      await ctx.answerCbQuery("This Pulse has already faded.", { show_alert: false });
      return;
    }

    const userId = ctx.from.id;
    const username = ctx.from.username;

    const result = recordInteraction(userId, username, pulseId, action);

    if (result.alreadyInteracted) {
      await ctx.answerCbQuery("You already responded to this Pulse.");
      return;
    }

    await ctx.answerCbQuery("Recorded.");

    // Visible confirmation posted in the group, since the small native
    // popup proved unreliable for some users. Short single line, shows
    // the actual points just gained and their running total. Alpha Pulses
    // get a distinct, louder line so catching one feels like a score.
    try {
      const line = result.isAlpha
        ? `⚡ @${username || userId} caught the ALPHA PULSE. +${result.gain} Conviction → ${result.user.conviction_score} total.`
        : `@${username || userId} is in. +${result.gain} Conviction → ${result.user.conviction_score} total.`;
      await bot.telegram.sendMessage(groupChatId, line);
    } catch (err) {
      console.error("[pulseHandler] confirmation message failed:", err.message);
    }

    if (result.leveledUp && RECOGNITION_TITLES.has(result.newTitle)) {
      try {
        await bot.telegram.sendMessage(
          groupChatId,
          `⚠ SYSTEM NOTICE\n@${username || userId} has been classified as: ${result.newTitle}`
        );
      } catch (err) {
        console.error("[pulseHandler] recognition message failed:", err.message);
      }
    }

    if (result.roleChanged && founderUserId) {
      try {
        await bot.telegram.sendMessage(
          founderUserId,
          `⚠ ROLE UNLOCK\n@${username || userId} has reached ${result.newRole} (${result.newTitle}).`
        );
      } catch {
        console.warn("[pulseHandler] could not DM founder about role change");
      }
    }
  });
}
