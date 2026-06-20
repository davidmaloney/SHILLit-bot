import db, { getSetting } from "./db.js";
import { userMeetsTitleRank } from "./reputation.js";

const X_URL_REGEX = /(https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[^\s]+)/i;
const REQUIRED_TITLE = process.env.RAID_REQUIRED_TITLE || "Diamond Hand";
const CARD_EXPIRY_MIN = parseInt(process.env.CARD_EXPIRY_MINUTES || "180", 10);

function voteKeyboard(cardId) {
  return {
    inline_keyboard: [
      [
        { text: "🗳️ Vote to Raid", callback_data: `vote:${cardId}` },
        { text: "🗑️ Remove", callback_data: `cardremove:${cardId}` },
      ],
    ],
  };
}

function escapeHtml(text) {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Kept as an alias so any external import of the old name still works.
const escapeMd = escapeHtml;

function stripHtml(text) {
  return text.replace(/<[^>]+>/g, "");
}

// X's scraped og:title/og:description were unreliable — X frequently
// serves a generic logged-out page instead of real tweet content, which
// showed up as garbage (random trending topics, boilerplate text) on
// cards. Removed entirely. The card now relies only on what the poster
// actually typed, which is always accurate.
export function voteCardCaption(card, isHot) {
  const heat = isHot ? " 🔥" : "";

  return (
    `<b>Comment Raid</b>${heat}\n\n` +
    `💬 <b>Their comment:</b>\n${escapeHtml(card.comment_text.slice(0, 300))}\n\n` +
    `🗳️ Votes: ${card.vote_count}\n\n` +
    `<a href="${escapeHtml(card.url)}">Open on X</a>`
  );
}

async function refreshVoteCard(bot, card) {
  const isHot = isMostVoted(card.card_id);
  const caption = voteCardCaption(card, isHot);
  const hasImage = !!card.has_image;
  const keyboard = voteKeyboard(card.card_id);
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
    console.warn("[xCardWatcher] failed to refresh vote card, retrying as plain text:", err.message);
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
      console.error("[xCardWatcher] plain-text fallback also failed:", err2.message);
    }
  }
}

function isMostVoted(cardId) {
  const card = db.prepare("SELECT * FROM raid_cards WHERE card_id = ?").get(cardId);
  if (!card) return false;
  const top = db
    .prepare(
      "SELECT MAX(vote_count) AS maxVotes FROM raid_cards WHERE stage = 'voting' AND chat_id = ?"
    )
    .get(card.chat_id);
  return top.maxVotes > 0 && card.vote_count === top.maxVotes;
}

function getLeadingVotingCard(chatId) {
  return db
    .prepare(
      "SELECT * FROM raid_cards WHERE stage = 'voting' AND chat_id = ? ORDER BY vote_count DESC, created_at DESC LIMIT 1"
    )
    .get(chatId);
}

async function repostVotingCard(bot, card) {
  const caption = voteCardCaption(card, isMostVoted(card.card_id));
  const cardImageFileId = getSetting("card_image_file_id");
  const keyboard = voteKeyboard(card.card_id);

  try {
    // Disable buttons on the old message so there's never two live,
    // actionable copies of the same card at once.
    await bot.telegram.editMessageReplyMarkup(card.chat_id, card.message_id, undefined, {
      inline_keyboard: [],
    });
  } catch {
    // old message may already be gone — non-fatal
  }

  let sent = null;
  try {
    if (cardImageFileId) {
      sent = await bot.telegram.sendPhoto(card.chat_id, cardImageFileId, {
        caption: `🔄 ${caption}`,
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
    } else {
      sent = await bot.telegram.sendMessage(card.chat_id, `🔄 ${caption}`, {
        parse_mode: "HTML",
        reply_markup: keyboard,
        disable_web_page_preview: true,
      });
    }
  } catch (err) {
    console.warn("[xCardWatcher] failed to repost voting card, retrying as plain text:", err.message);
    try {
      const plainCaption = `🔄 ${stripHtml(caption)}`;
      if (cardImageFileId) {
        sent = await bot.telegram.sendPhoto(card.chat_id, cardImageFileId, {
          caption: plainCaption,
          reply_markup: keyboard,
        });
      } else {
        sent = await bot.telegram.sendMessage(card.chat_id, plainCaption, {
          reply_markup: keyboard,
          disable_web_page_preview: true,
        });
      }
    } catch (err2) {
      console.error("[xCardWatcher] plain-text repost fallback also failed:", err2.message);
    }
  }

  if (sent) {
    db.prepare("UPDATE raid_cards SET message_id = ?, has_image = ? WHERE card_id = ?").run(
      sent.message_id,
      cardImageFileId ? 1 : 0,
      card.card_id
    );
  }
}

export function registerXCardWatcher({ bot, founderUserId }) {
  const DEFAULT_TARGET = parseInt(process.env.RAID_DEFAULT_TARGET || "10", 10);

  bot.on("message", async (ctx, next) => {
    const text = ctx.message?.text || ctx.message?.caption;
    if (!text) return next();

    const match = text.match(X_URL_REGEX);
    if (!match) return next();

    const userId = ctx.from.id;
    const username = ctx.from.username;
    const isFounderUser = String(userId) === String(founderUserId);

    if (!isFounderUser && !userMeetsTitleRank(userId, REQUIRED_TITLE)) {
      try {
        await ctx.reply(
          `Comment raids require ${REQUIRED_TITLE} status or higher. Keep showing up — it doesn't take long.`
        );
      } catch {
        // non-fatal
      }
      return next();
    }

    const url = match[0];

    const commentText = text.replace(url, "").trim();
    const looksLikeOnlyACommand = /^\/\S+$/.test(commentText);
    if (!commentText || looksLikeOnlyACommand) {
      try {
        await ctx.reply(
          "Include your own comment text in the same message as the link, e.g.:\nhttps://x.com/... Great project, just bought in."
        );
      } catch {
        // non-fatal
      }
      return next();
    }

    const chatId = ctx.chat.id;
    const now = Date.now();
    const expiresAt = now + CARD_EXPIRY_MIN * 60 * 1000;

    const cardImageFileId = getSetting("card_image_file_id");
    const hasImageFlag = cardImageFileId ? 1 : 0;

    const insert = db.prepare(
      `INSERT INTO raid_cards (chat_id, posted_by, posted_by_username, url, comment_text, stage, vote_count, raid_count, raid_target, created_at, expires_at, has_image)
       VALUES (?, ?, ?, ?, ?, 'voting', 0, 0, ?, ?, ?, ?)`
    );
    const result = insert.run(
      chatId,
      userId,
      username || null,
      url,
      commentText,
      DEFAULT_TARGET,
      now,
      expiresAt,
      hasImageFlag
    );
    const cardId = result.lastInsertRowid;
    const card = db.prepare("SELECT * FROM raid_cards WHERE card_id = ?").get(cardId);

    const caption = voteCardCaption(card, false);
    const keyboard = voteKeyboard(cardId);

    let sent = null;
    try {
      if (cardImageFileId) {
        sent = await ctx.replyWithPhoto(cardImageFileId, {
          caption,
          parse_mode: "HTML",
          reply_markup: keyboard,
        });
      } else {
        sent = await ctx.reply(caption, {
          parse_mode: "HTML",
          reply_markup: keyboard,
          disable_web_page_preview: true,
        });
      }
    } catch (err) {
      console.warn("[xCardWatcher] failed to post card, retrying as plain text:", err.message);
      try {
        const plainCaption = stripHtml(caption);
        if (cardImageFileId) {
          sent = await ctx.replyWithPhoto(cardImageFileId, {
            caption: plainCaption,
            reply_markup: keyboard,
          });
        } else {
          sent = await ctx.reply(plainCaption, {
            reply_markup: keyboard,
            disable_web_page_preview: true,
          });
        }
      } catch (err2) {
        console.error("[xCardWatcher] plain-text fallback also failed to post card:", err2.message);
      }
    }

    if (sent) {
      db.prepare("UPDATE raid_cards SET message_id = ? WHERE card_id = ?").run(
        sent.message_id,
        cardId
      );
    }

    return next();
  });
}

export { refreshVoteCard, isMostVoted, voteKeyboard, escapeMd, escapeHtml, stripHtml, getLeadingVotingCard, repostVotingCard };
