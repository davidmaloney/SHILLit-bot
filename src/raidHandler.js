import db from "./db.js";
import { awardConviction, userMeetsTitleRank } from "./reputation.js";
import { voteCardCaption, voteKeyboard, escapeHtml, stripHtml } from "./xCardWatcher.js";

const VOTE_THRESHOLD = parseInt(process.env.RAID_VOTE_THRESHOLD || "5", 10);
const DELETE_REQUIRED_TITLE = "Diamond Hand";

const RECOGNITION_TITLES = new Set([
  "Diamond Hand",
  "Signal Reader",
  "Conviction Holder",
  "Council of Shillers",
]);

async function announceIfLeveledUp(bot, groupChatId, founderUserId, username, userId, result) {
  if (result.leveledUp && RECOGNITION_TITLES.has(result.newTitle)) {
    try {
      await bot.telegram.sendMessage(
        groupChatId,
        `⚠ SYSTEM NOTICE\n@${username || userId} has been classified as: ${result.newTitle}`
      );
    } catch (err) {
      console.error("[raidHandler] recognition message failed:", err.message);
    }
  }

  if (result.roleChanged && founderUserId) {
    try {
      await bot.telegram.sendMessage(
        founderUserId,
        `⚠ ROLE UNLOCK\n@${username || userId} has reached ${result.newRole} (${result.newTitle}).`
      );
    } catch {
      console.warn("[raidHandler] could not DM founder about role change");
    }
  }
}

function progressBar(current, target) {
  const filled = Math.min(10, Math.round((current / target) * 10));
  const empty = 10 - filled;
  return "🟩".repeat(filled) + "⬜️".repeat(empty);
}

function raidCaption(card) {
  const postTitle = card.post_title ? escapeHtml(card.post_title) : "Original post";
  const postDesc = card.post_description
    ? `\n${escapeHtml(card.post_description.slice(0, 180))}`
    : "";
  const bar = progressBar(card.raid_count, card.raid_target);

  return (
    `<b>⚔ RAID ACTIVE</b>\n\n` +
    `📌 <b>Original post:</b>\n${postTitle}${postDesc}\n\n` +
    `💬 <b>Their comment:</b>\n${escapeHtml(card.comment_text.slice(0, 300))}\n\n` +
    `${bar}  ${card.raid_count}/${card.raid_target} raiders\n\n` +
    `<a href="${escapeHtml(card.url)}">Open on X</a>`
  );
}

function raidKeyboard(cardId) {
  return {
    inline_keyboard: [[{ text: "⚔ Join Raid", callback_data: `raidjoin:${cardId}` }]],
  };
}

export { raidCaption, raidKeyboard };

function isMostVoted(card) {
  const top = db
    .prepare(
      "SELECT MAX(vote_count) AS maxVotes FROM raid_cards WHERE stage = 'voting' AND chat_id = ?"
    )
    .get(card.chat_id);
  return top.maxVotes > 0 && card.vote_count === top.maxVotes;
}

async function renderCardMessage(bot, card, caption, keyboard) {
  const hasImage = !!card.has_image;
  try {
    if (hasImage) {
      await bot.telegram.editMessageCaption(card.chat_id, card.message_id, undefined, caption, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
    } else {
      await bot.telegram.editMessageText(card.chat_id, card.message_id, undefined, caption, {
        parse_mode: "HTML",
        reply_markup: keyboard,
        disable_web_page_preview: true,
      });
    }
  } catch (err) {
    console.warn("[raidHandler] failed to render card, retrying as plain text:", err.message);
    try {
      if (hasImage) {
        await bot.telegram.editMessageCaption(
          card.chat_id,
          card.message_id,
          undefined,
          stripHtml(caption),
          { reply_markup: keyboard }
        );
      } else {
        await bot.telegram.editMessageText(
          card.chat_id,
          card.message_id,
          undefined,
          stripHtml(caption),
          { reply_markup: keyboard, disable_web_page_preview: true }
        );
      }
    } catch (err2) {
      console.error("[raidHandler] plain-text fallback also failed:", err2.message);
    }
  }
}

export function registerRaidHandler({ bot, groupChatId, founderUserId }) {
  bot.on("callback_query", async (ctx, next) => {
    const data = ctx.callbackQuery.data || "";

    // --- Vote ---
    if (data.startsWith("vote:")) {
      const cardId = parseInt(data.split(":")[1], 10);
      const userId = ctx.from.id;
      const username = ctx.from.username;

      const card = db.prepare("SELECT * FROM raid_cards WHERE card_id = ?").get(cardId);
      if (!card || card.stage !== "voting") {
        await ctx.answerCbQuery("This card is no longer accepting votes.");
        return;
      }

      let inserted = false;
      try {
        db.prepare(
          "INSERT INTO card_votes (card_id, user_id, timestamp) VALUES (?, ?, ?)"
        ).run(cardId, userId, Date.now());
        inserted = true;
      } catch {
        inserted = false;
      }

      if (!inserted) {
        await ctx.answerCbQuery("You already voted on this one.");
        return;
      }

      const voteResult = awardConviction(userId, username, 2);
      await announceIfLeveledUp(bot, groupChatId, founderUserId, username, userId, voteResult);

      db.prepare("UPDATE raid_cards SET vote_count = vote_count + 1 WHERE card_id = ?").run(
        cardId
      );

      const updatedCard = db.prepare("SELECT * FROM raid_cards WHERE card_id = ?").get(cardId);

      await ctx.answerCbQuery("Vote counted.");

      if (updatedCard.vote_count >= VOTE_THRESHOLD) {
        db.prepare("UPDATE raid_cards SET stage = 'raid' WHERE card_id = ?").run(cardId);
        const raidCard = db.prepare("SELECT * FROM raid_cards WHERE card_id = ?").get(cardId);
        await renderCardMessage(
          bot,
          raidCard,
          raidCaption(raidCard),
          raidKeyboard(cardId)
        );
        if (founderUserId) {
          try {
            await bot.telegram.sendMessage(
              founderUserId,
              `⚠ RAID TRIGGERED\nA comment-raid card by @${updatedCard.posted_by_username || updatedCard.posted_by} just hit threshold.\n${updatedCard.url}`
            );
          } catch {
            // non-fatal
          }
        }
      } else {
        await renderCardMessage(
          bot,
          updatedCard,
          voteCardCaption(updatedCard, isMostVoted(updatedCard)),
          voteKeyboard(cardId)
        );
      }
      return;
    }

    // --- Raid join ---
    if (data.startsWith("raidjoin:")) {
      const cardId = parseInt(data.split(":")[1], 10);
      const userId = ctx.from.id;
      const username = ctx.from.username;

      const card = db.prepare("SELECT * FROM raid_cards WHERE card_id = ?").get(cardId);
      if (!card || card.stage !== "raid") {
        await ctx.answerCbQuery("This raid is no longer active.");
        return;
      }

      let inserted = false;
      try {
        db.prepare(
          "INSERT INTO raid_joins (card_id, user_id, username, timestamp) VALUES (?, ?, ?, ?)"
        ).run(cardId, userId, username || null, Date.now());
        inserted = true;
      } catch {
        inserted = false;
      }

      if (!inserted) {
        await ctx.answerCbQuery("You already joined this raid.");
        return;
      }

      const raidResult = awardConviction(userId, username, 4);
      await announceIfLeveledUp(bot, groupChatId, founderUserId, username, userId, raidResult);

      db.prepare("UPDATE raid_cards SET raid_count = raid_count + 1 WHERE card_id = ?").run(
        cardId
      );

      const updatedCard = db.prepare("SELECT * FROM raid_cards WHERE card_id = ?").get(cardId);

      await ctx.answerCbQuery("Joined the raid.");
      try {
        await ctx.reply(`⚔ @${username || userId} joined → ${updatedCard.url}`);
      } catch {
        // non-fatal
      }

      await renderCardMessage(
        bot,
        updatedCard,
        raidCaption(updatedCard),
        raidKeyboard(cardId)
      );

      const justFilled = card.raid_count < card.raid_target && updatedCard.raid_count >= updatedCard.raid_target;
      if (justFilled) {
        const firstJoin = db
          .prepare("SELECT * FROM raid_joins WHERE card_id = ? ORDER BY timestamp ASC LIMIT 1")
          .get(cardId);
        if (firstJoin) {
          try {
            await bot.telegram.sendMessage(
              updatedCard.chat_id,
              `Raid filled. First responder: @${firstJoin.username || firstJoin.user_id}`
            );
          } catch {
            // non-fatal
          }
        }
      }
      return;
    }

    // --- Delete card (Diamond Hand+ only) ---
    if (data.startsWith("cardremove:")) {
      const cardId = parseInt(data.split(":")[1], 10);
      const userId = ctx.from.id;

      if (!userMeetsTitleRank(userId, DELETE_REQUIRED_TITLE) && String(userId) !== String(founderUserId)) {
        await ctx.answerCbQuery("Diamond Hand status or higher required to remove cards.", {
          show_alert: true,
        });
        return;
      }

      const card = db.prepare("SELECT * FROM raid_cards WHERE card_id = ?").get(cardId);
      if (!card) {
        await ctx.answerCbQuery("Card already gone.");
        return;
      }

      db.prepare("UPDATE raid_cards SET stage = 'removed' WHERE card_id = ?").run(cardId);

      try {
        await bot.telegram.deleteMessage(card.chat_id, card.message_id);
      } catch (err) {
        console.warn("[raidHandler] failed to delete card message:", err.message);
      }

      await ctx.answerCbQuery("Removed.");
      return;
    }

    return next();
  });
}
