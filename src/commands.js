import db, { setSetting } from "./db.js";
import {
  getOrCreateUser,
  getProfile,
  getTopUsers,
  getAdminCandidates,
  manuallySetRole,
  userMeetsTitleRank,
} from "./reputation.js";
import { firePulse } from "./scheduler.js";

const TOP_TITLE = "Council of Shillers";

function isFounder(ctx, founderUserId) {
  return String(ctx.from.id) === String(founderUserId);
}

function isAdminOrFounder(userId, founderUserId) {
  if (String(userId) === String(founderUserId)) return true;
  const user = getProfile(userId);
  return user && (user.current_role === "admin" || user.current_role === "founder");
}

export function registerCommands({ bot, groupChatId, founderUserId }) {
  bot.command("start", (ctx) => {
    getOrCreateUser(ctx.from.id, ctx.from.username);
    ctx.reply(
      "You're now visible to the network.\n\nUse /profile to check your standing. Use /help for everything else."
    );
  });

  bot.command("help", (ctx) => {
    ctx.reply(
      [
        "/profile — see your current title and standing",
        "/conviction — a vague hint about your progress",
        "/history — your recent Pulse interactions",
        "/status — network status",
        "",
        "Post an X link with your comment in the same message to start a",
        "comment-raid vote card. Requires Diamond Hand status or higher.",
      ].join("\n")
    );
  });

  bot.command("profile", (ctx) => {
    const user = getOrCreateUser(ctx.from.id, ctx.from.username);
    const displayRole = isFounder(ctx, founderUserId) ? "founder" : user.current_role;
    ctx.reply(
      `Title: ${user.title}\nRole: ${displayRole}\nFirst seen: ${new Date(
        user.first_seen
      ).toLocaleDateString()}`
    );
  });

  bot.command("conviction", (ctx) => {
    const user = getOrCreateUser(ctx.from.id, ctx.from.username);
    const score = user.conviction_score;
    let hint;
    if (score === 0) hint = "Nothing has registered yet.";
    else if (score < 15) hint = "Your conviction is barely a flicker.";
    else if (score < 35) hint = "Your conviction is forming.";
    else if (score < 60) hint = "Your conviction is steady.";
    else if (score < 100) hint = "Your conviction is undeniable.";
    else hint = "Your conviction precedes you.";
    ctx.reply(hint);
  });

  bot.command("history", (ctx) => {
    const rows = db
      .prepare(
        "SELECT interaction_type, timestamp FROM believers WHERE user_id = ? ORDER BY timestamp DESC LIMIT 10"
      )
      .all(ctx.from.id);
    if (rows.length === 0) {
      ctx.reply("No recorded interactions yet.");
      return;
    }
    const lines = rows.map(
      (r) => `${r.interaction_type} — ${new Date(r.timestamp).toLocaleString()}`
    );
    ctx.reply(lines.join("\n"));
  });

  bot.command("status", (ctx) => {
    const activePulses = db.prepare("SELECT COUNT(*) AS c FROM pulses WHERE active = 1").get().c;
    const totalUsers = db.prepare("SELECT COUNT(*) AS c FROM users").get().c;
    const activeRaids = db
      .prepare("SELECT COUNT(*) AS c FROM raid_cards WHERE stage = 'raid'")
      .get().c;
    const votingCards = db
      .prepare("SELECT COUNT(*) AS c FROM raid_cards WHERE stage = 'voting'")
      .get().c;
    ctx.reply(
      `Active Pulses: ${activePulses}\nCards being voted on: ${votingCards}\nActive Raids: ${activeRaids}\nKnown presences in the network: ${totalUsers}`
    );
  });

  // --- Hidden: image change, available to Founder and Council of Shillers only ---
  // Deliberately not listed in /help — discovered, not announced.
  bot.command("set_card_image", async (ctx) => {
    const userId = ctx.from.id;
    const isFounderUser = isFounder(ctx, founderUserId);
    const qualifies = userMeetsTitleRank(userId, TOP_TITLE);

    if (!isFounderUser && !qualifies) {
      // Stay silent rather than revealing the command exists to those who
      // don't qualify — no error message, no hint.
      return;
    }

    const replyPhoto = ctx.message.reply_to_message?.photo;
    if (!replyPhoto) {
      await ctx.reply("Reply to a photo with /set_card_image to set it as the card image.");
      return;
    }

    const fileId = replyPhoto[replyPhoto.length - 1].file_id;
    setSetting("card_image_file_id", fileId);
    await ctx.reply("Card image updated. New cards will use this image.");
  });

  // --- Admin commands ---

  bot.command("force_pulse", async (ctx) => {
    if (!isAdminOrFounder(ctx.from.id, founderUserId)) {
      ctx.reply("Not authorized.");
      return;
    }
    await firePulse({ bot, groupChatId });
    ctx.reply("Pulse forced.");
  });

  bot.command("promote", (ctx) => {
    if (!isAdminOrFounder(ctx.from.id, founderUserId)) {
      ctx.reply("Not authorized.");
      return;
    }
    const parts = ctx.message.text.split(" ");
    const targetId = parts[1];
    if (!targetId) {
      ctx.reply("Usage: /promote <user_id>");
      return;
    }
    manuallySetRole(targetId, "moderator");
    ctx.reply(`User ${targetId} promoted to moderator.`);
  });

  bot.command("demote", (ctx) => {
    if (!isAdminOrFounder(ctx.from.id, founderUserId)) {
      ctx.reply("Not authorized.");
      return;
    }
    const parts = ctx.message.text.split(" ");
    const targetId = parts[1];
    if (!targetId) {
      ctx.reply("Usage: /demote <user_id>");
      return;
    }
    manuallySetRole(targetId, "member");
    ctx.reply(`User ${targetId} demoted to member.`);
  });

  bot.command("admin_candidates", (ctx) => {
    if (!isAdminOrFounder(ctx.from.id, founderUserId)) {
      ctx.reply("Not authorized.");
      return;
    }
    const candidates = getAdminCandidates();
    if (candidates.length === 0) {
      ctx.reply("No pending candidates.");
      return;
    }
    const lines = candidates.map(
      (c) => `@${c.user.username || c.user.user_id} → ${c.title} (${c.eligibleRole})`
    );
    ctx.reply(lines.join("\n"));
  });

  bot.command("system_stats", (ctx) => {
    if (!isAdminOrFounder(ctx.from.id, founderUserId)) {
      ctx.reply("Not authorized.");
      return;
    }
    const totalUsers = db.prepare("SELECT COUNT(*) AS c FROM users").get().c;
    const totalPulses = db.prepare("SELECT COUNT(*) AS c FROM pulses").get().c;
    const totalInteractions = db.prepare("SELECT COUNT(*) AS c FROM believers").get().c;
    const totalCards = db.prepare("SELECT COUNT(*) AS c FROM raid_cards").get().c;
    const totalRaidJoins = db.prepare("SELECT COUNT(*) AS c FROM raid_joins").get().c;
    const top = getTopUsers(5);
    const topLines = top.map(
      (u, i) => `${i + 1}. @${u.username || u.user_id} — ${u.title}`
    );
    ctx.reply(
      `Users: ${totalUsers}\nPulses: ${totalPulses}\nPulse interactions: ${totalInteractions}\nRaid cards: ${totalCards}\nRaid joins: ${totalRaidJoins}\n\nTop standing:\n${topLines.join(
        "\n"
      )}`
    );
  });

  bot.command("set_raid_target", (ctx) => {
    if (!isAdminOrFounder(ctx.from.id, founderUserId)) {
      ctx.reply("Not authorized.");
      return;
    }
    const parts = ctx.message.text.split(" ");
    const newTarget = parseInt(parts[1], 10);
    if (isNaN(newTarget) || newTarget <= 0) {
      ctx.reply("Usage: /set_raid_target <number>");
      return;
    }
    const result = db
      .prepare("UPDATE raid_cards SET raid_target = ? WHERE stage = 'raid'")
      .run(newTarget);
    ctx.reply(
      `Updated raid target to ${newTarget} for ${result.changes} active raid(s). Set RAID_DEFAULT_TARGET in .env and restart to make this permanent for new raids.`
    );
  });

  // --- Founder-only commands ---

  bot.command("set_threshold", (ctx) => {
    if (!isFounder(ctx, founderUserId)) {
      ctx.reply("Not authorized.");
      return;
    }
    const parts = ctx.message.text.split(" ");
    const titleName = parts.slice(1, -1).join(" ");
    const newThreshold = parseInt(parts[parts.length - 1], 10);
    if (!titleName || isNaN(newThreshold)) {
      ctx.reply("Usage: /set_threshold <title name> <number>");
      return;
    }
    const result = db
      .prepare("UPDATE titles SET threshold = ? WHERE title_name = ?")
      .run(newThreshold, titleName);
    if (result.changes === 0) {
      ctx.reply(`No title found matching "${titleName}".`);
    } else {
      ctx.reply(`Threshold for "${titleName}" set to ${newThreshold}.`);
    }
  });

  bot.command("broadcast", async (ctx) => {
    if (!isFounder(ctx, founderUserId)) {
      ctx.reply("Not authorized.");
      return;
    }
    const text = ctx.message.text.replace("/broadcast", "").trim();
    if (!text) {
      ctx.reply("Usage: /broadcast <message>");
      return;
    }
    await bot.telegram.sendMessage(groupChatId, text);
    ctx.reply("Broadcast sent.");
  });

  bot.command("reload", (ctx) => {
    if (!isFounder(ctx, founderUserId)) {
      ctx.reply("Not authorized.");
      return;
    }
    ctx.reply("Reload acknowledged. (Restart the container to fully reload.)");
  });

  bot.command("shutdown", (ctx) => {
    if (!isFounder(ctx, founderUserId)) {
      ctx.reply("Not authorized.");
      return;
    }
    ctx.reply("Shutting down.");
    process.exit(0);
  });
}
