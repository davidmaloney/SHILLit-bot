import db from "./db.js";
import { awardConviction } from "./reputation.js";

const RATING_THRESHOLD = parseInt(process.env.RAID_RATING_THRESHOLD || "5", 10);

function progressBar(current, target) {
  const filled = Math.min(10, Math.round((current / target) * 10));
  const empty = 10 - filled;
  return "🟩".repeat(filled) + "⬜️".repeat(empty);
}

function ratingCaption(card) {
  const title = card.title || "Untitled link";
  const desc = card.description ? `\n${card.description.slice(0, 200)}` : "";
  const avg = card.rating_count > 0 ? (card.rating_total / card.rating_count).toFixed(1) : "—";
  return `${title}${desc}\n\n⭐ Community Score: ${avg}/10 (${card.rating_count} ratings)\n\n${card.url}`;
}

function raidCaption(card) {
  const title = card.title || "Untitled link";
  const desc = card.description ? `\n${card.description.slice(0, 200)}` : "";
  const avg = card.rating_count > 0 ? (card.rating_total / card.rating_count).toFixed(1) : "—";
  const bar = progressBar(card.raid_count, card.raid_target);
  return `${title}${desc}\n\n⭐ Community Score: ${avg}/10 (${card.rating_count} ratings)\n\n⚔ RAID ACTIVE\n${bar}  ${card.raid_count}/${card.raid_target} raiders\n\n${card.url}`;
}

function ratingKeyboard(cardId) {
  const row1 = [1, 2, 3, 4, 5].map((n) => ({
    text: String(n),
    callback_data: `rate:${cardId}:${n}`,
  }));
  const row2 = [6, 7, 8, 9, 10].map((n) => ({
    text: String(n),
    callback_data: `rate:${cardId}:${n}`,
  }));
  return { inline_keyboard: [row1, row2] };
}

function raidKeyboard(cardId, url) {
  // Telegram inline buttons cannot combine a url and callback_data on the
  // same button and fire both — only one action per button. So this is
  // split into two buttons: one opens the link, one logs the join tap.
  return {
    inline_keyboard: [
      [
        { text: "🔗 Open Link", url },
        { text: "⚔ Join Raid", callback_data: `raid:${cardId}` },
      ],
    ],
  };
}

async function refreshCardMessage(bot, card, keyboard, caption) {
  try {
    if (card.image_url) {
      await bot.telegram.editMessageCaption(card.chat_id, card.message_id, undefined, caption, {
        reply_markup: keyboard,
      });
    } else {
      await bot.telegram.editMessageText(card.chat_id, card.message_id, undefined, caption, {
        reply_markup: keyboard,
      });
    }
  } catch (err) {
    console.warn("[raidHandler] failed to refresh card message:", err.message);
  }
}

export function registerRaidHandler({ bot }) {
  bot.on("callback_query", async (ctx, next) => {
    const data = ctx.callbackQuery.data || "";

    if (data.startsWith("rate:")) {
      const [, cardIdStr, scoreStr] = data.split(":");
      const cardId = parseInt(cardIdStr, 10);
      const score = parseInt(scoreStr, 10);
      const userId = ctx.from.id;
      const username = ctx.from.username;

      const card = db.prepare("SELECT * FROM link_cards WHERE card_id = ?").get(cardId);
      if (!card || card.stage !== "rating") {
        await ctx.answerCbQuery("This card is no longer accepting ratings.");
        return;
      }

      let inserted = false;
      try {
        db.prepare(
          "INSERT INTO link_ratings (card_id, user_id, score, timestamp) VALUES (?, ?, ?, ?)"
        ).run(cardId, userId, score, Date.now());
        inserted = true;
      } catch {
        inserted = false;
      }

      if (!inserted) {
        await ctx.answerCbQuery("You already rated this.");
        return;
      }

      awardConviction(userId, username, 2);

      db.prepare(
        "UPDATE link_cards SET rating_total = rating_total + ?, rating_count = rating_count + 1 WHERE card_id = ?"
      ).run(score, cardId);

      const updatedCard = db.prepare("SELECT * FROM link_cards WHERE card_id = ?").get(cardId);

      await ctx.answerCbQuery("Rated.");

      if (updatedCard.rating_count >= RATING_THRESHOLD) {
        db.prepare("UPDATE link_cards SET stage = 'raid' WHERE card_id = ?").run(cardId);
        const raidCard = db.prepare("SELECT * FROM link_cards WHERE card_id = ?").get(cardId);
        await refreshCardMessage(
          bot,
          raidCard,
          raidKeyboard(cardId, raidCard.url),
          raidCaption(raidCard)
        );
      } else {
        await refreshCardMessage(
          bot,
          updatedCard,
          ratingKeyboard(cardId),
          ratingCaption(updatedCard)
        );
      }
      return;
    }

    if (data.startsWith("raid:")) {
      const [, cardIdStr] = data.split(":");
      const cardId = parseInt(cardIdStr, 10);
      const userId = ctx.from.id;
      const username = ctx.from.username;

      const card = db.prepare("SELECT * FROM link_cards WHERE card_id = ?").get(cardId);
      if (!card || card.stage !== "raid") {
        await ctx.answerCbQuery("This raid is no longer active.");
        return;
      }

      let inserted = false;
      try {
        db.prepare(
          "INSERT INTO raid_joins (card_id, user_id, timestamp) VALUES (?, ?, ?)"
        ).run(cardId, userId, Date.now());
        inserted = true;
      } catch {
        inserted = false;
      }

      if (!inserted) {
        await ctx.answerCbQuery("You already joined this raid.");
        return;
      }

      awardConviction(userId, username, 4);

      db.prepare("UPDATE link_cards SET raid_count = raid_count + 1 WHERE card_id = ?").run(
        cardId
      );

      const updatedCard = db.prepare("SELECT * FROM link_cards WHERE card_id = ?").get(cardId);

      await ctx.answerCbQuery("Joined the raid.");

      await refreshCardMessage(
        bot,
        updatedCard,
        raidKeyboard(cardId, updatedCard.url),
        raidCaption(updatedCard)
      );
      return;
    }

    return next();
  });
}
