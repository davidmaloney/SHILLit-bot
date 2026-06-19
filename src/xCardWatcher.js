import fetch from "node-fetch";
import db, { getSetting } from "./db.js";
import { userMeetsTitleRank } from "./reputation.js";

const X_URL_REGEX = /(https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[^\s]+)/i;
const REQUIRED_TITLE = "Diamond Hand";
const CARD_EXPIRY_MIN = parseInt(process.env.CARD_EXPIRY_MINUTES || "180", 10);

function extractMeta(html) {
  const get = (re) => {
    const m = html.match(re);
    return m ? m[1].trim() : null;
  };

  const title =
    get(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
    get(/<title>([^<]+)<\/title>/i);

  const description =
    get(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) ||
    get(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);

  return { title, description };
}

async function fetchPostPreview(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ShillitBot/1.0)" },
      redirect: "follow",
      timeout: 8000,
    });
    const html = await res.text();
    return extractMeta(html);
  } catch (err) {
    console.warn("[xCardWatcher] preview fetch failed:", err.message);
    return { title: null, description: null };
  }
}

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

function escapeMd(text) {
  if (!text) return "";
  return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

export function voteCardCaption(card, isHot) {
  const postTitle = card.post_title ? escapeMd(card.post_title) : "Original post";
  const postDesc = card.post_description
    ? `\n${escapeMd(card.post_description.slice(0, 180))}`
    : "";
  const heat = isHot ? " 🔥" : "";

  return (
    `*Comment Raid*${heat}\n\n` +
    `📌 *Original post:*\n${postTitle}${postDesc}\n\n` +
    `💬 *Their comment:*\n${escapeMd(card.comment_text.slice(0, 300))}\n\n` +
    `🗳️ Votes: ${card.vote_count}\n\n` +
    `[Open on X](${card.url})`
  );
}

async function refreshVoteCard(bot, card) {
  const isHot = isMostVoted(card.card_id);
  const caption = voteCardCaption(card, isHot);
  const hasImage = !!getSetting("card_image_file_id");
  try {
    if (hasImage) {
      await bot.telegram.editMessageCaption(card.chat_id, card.message_id, undefined, caption, {
        parse_mode: "Markdown",
        reply_markup: voteKeyboard(card.card_id),
      });
    } else {
      await bot.telegram.editMessageText(card.chat_id, card.message_id, undefined, caption, {
        parse_mode: "Markdown",
        reply_markup: voteKeyboard(card.card_id),
        disable_web_page_preview: true,
      });
    }
  } catch (err) {
    console.warn("[xCardWatcher] failed to refresh vote card:", err.message);
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

export function registerXCardWatcher({ bot }) {
  const DEFAULT_TARGET = parseInt(process.env.RAID_DEFAULT_TARGET || "10", 10);

  bot.on("message", async (ctx, next) => {
    const text = ctx.message?.text || ctx.message?.caption;
    if (!text) return next();

    const match = text.match(X_URL_REGEX);
    if (!match) return next();

    const userId = ctx.from.id;
    const username = ctx.from.username;

    if (!userMeetsTitleRank(userId, REQUIRED_TITLE)) {
      try {
        await ctx.reply(
          "Comment raids require Diamond Hand status or higher. Keep showing up — it doesn't take long."
        );
      } catch {
        // non-fatal
      }
      return next();
    }

    const url = match[0];

    // Everything after the URL in the same message is treated as the
    // poster's own comment text. If nothing follows, ask them to resend
    // with their comment included, since the card requires it.
    const commentText = text.replace(url, "").trim();
    if (!commentText) {
      try {
        await ctx.reply(
          "Include your comment text in the same message as the link, e.g.:\nhttps://x.com/... Great project, just bought in."
        );
      } catch {
        // non-fatal
      }
      return next();
    }

    const chatId = ctx.chat.id;
    const now = Date.now();
    const expiresAt = now + CARD_EXPIRY_MIN * 60 * 1000;

    const preview = await fetchPostPreview(url);

    const insert = db.prepare(
      `INSERT INTO raid_cards (chat_id, posted_by, posted_by_username, url, post_title, post_description, comment_text, stage, vote_count, raid_count, raid_target, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'voting', 0, 0, ?, ?, ?)`
    );
    const result = insert.run(
      chatId,
      userId,
      username || null,
      url,
      preview.title,
      preview.description,
      commentText,
      DEFAULT_TARGET,
      now,
      expiresAt
    );
    const cardId = result.lastInsertRowid;
    const card = db.prepare("SELECT * FROM raid_cards WHERE card_id = ?").get(cardId);

    const caption = voteCardCaption(card, false);
    const cardImageFileId = getSetting("card_image_file_id");

    try {
      let sent;
      if (cardImageFileId) {
        sent = await ctx.replyWithPhoto(cardImageFileId, {
          caption,
          parse_mode: "Markdown",
          reply_markup: voteKeyboard(cardId),
        });
      } else {
        sent = await ctx.reply(caption, {
          parse_mode: "Markdown",
          reply_markup: voteKeyboard(cardId),
          disable_web_page_preview: true,
        });
      }
      db.prepare("UPDATE raid_cards SET message_id = ? WHERE card_id = ?").run(
        sent.message_id,
        cardId
      );
    } catch (err) {
      console.error("[xCardWatcher] failed to post card:", err.message);
    }

    return next();
  });
}

export { refreshVoteCard, isMostVoted, voteKeyboard, escapeMd };
