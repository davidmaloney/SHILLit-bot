import db, { getSetting } from "./db.js";
import { awardConviction, userMeetsTitleRank } from "./reputation.js";

// === Configuration ===
const X_URL_REGEX = /(https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[^\s]+)/i;
const REQUIRED_TITLE = process.env.RAID_REQUIRED_TITLE || "Diamond Hand";
const DELETE_REQUIRED_TITLE = "Diamond Hand";
const VOTE_THRESHOLD = parseInt(process.env.RAID_VOTE_THRESHOLD || "5", 10);
const CARD_EXPIRY_MIN = parseInt(process.env.CARD_EXPIRY_MINUTES || "180", 10);
const REPOST_EVERY_N = parseInt(process.env.REPOST_EVERY_N_MESSAGES || "15", 10);
// One shared cap for the whole life of a card, voting or raid — replaces
// the old two-counter design where only raid boxes had a limit.
const REPOST_LIMIT = parseInt(process.env.RAID_REPOST_LIMIT || "5", 10);

const RECOGNITION_TITLES = new Set([
  "Diamond Hand",
  "Signal Reader",
  "Conviction Holder",
  "Council of Shillers",
]);

// Per-chat message counter driving the repost cycle. Kept in memory since
// it's just a "how many messages since the last repost" tally, not data
// that needs to survive a restart.
const messageCounters = new Map();

// === Text safety helpers ===
// Comment text is never validated or rejected — people can type anything,
// including things that look like commands. The only requirement is that
// whatever they type is always rendered SAFELY in the HTML caption, so a
// stray <, >, or & character can never break the card or get blocked by
// Telegram's HTML parser.
function escapeHtml(text) {
  if (!text) return "";
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function stripHtml(text) {
  return text.replace(/<[^>]+>/g, "");
}

// === Caption + keyboard builders ===
// One function per concern, shared by every card regardless of stage,
// instead of separate near-duplicate builders for voting vs raid.

function minutesRemaining(card) {
  const msLeft = card.expires_at - Date.now();
  return Math.max(0, Math.round(msLeft / 60000));
}

function buildCaption(card, isHot) {
  const comment = escapeHtml(card.comment_text.slice(0, 400));

  if (card.stage === "raid") {
    const minsLeft = minutesRemaining(card);
    const timeLine =
      minsLeft > 0 ? `⏳ Expires in ${minsLeft} minute${minsLeft === 1 ? "" : "s"}\n\n` : "";
    const believeLine =
      card.vote_count > 0
        ? `🙌 ${card.vote_count} ${card.vote_count === 1 ? "person" : "people"} already believe in this\n\n`
        : "";
    return (
      `<b>⚔ RAID ACTIVE</b>\n\n` +
      `💬 <b>Their comment:</b>\n${comment}\n\n` +
      believeLine +
      timeLine +
      `👉 <a href="${escapeHtml(card.url)}">Tap here to raid</a>`
    );
  }

  // voting stage
  const heat = isHot ? " 🔥" : "";
  return (
    `<b>Comment Raid</b>${heat}\n\n` +
    `💬 <b>Their comment:</b>\n${comment}\n\n` +
    `🗳️ Votes: ${card.vote_count}\n\n` +
    `<a href="${escapeHtml(card.url)}">Open on X</a>`
  );
}

function buildKeyboard(card) {
  if (card.stage === "raid") {
    // The raid link lives directly in the caption text as a tappable
    // HTML link. The only button is Remove, so moderation stays possible
    // after a card becomes a live raid.
    return {
      inline_keyboard: [[{ text: "🗑️ Remove", callback_data: `cardremove:${card.card_id}` }]],
    };
  }
  return {
    inline_keyboard: [
      [
        { text: "🗳️ Vote to Raid", callback_data: `vote:${card.card_id}` },
        { text: "🗑️ Remove", callback_data: `cardremove:${card.card_id}` },
      ],
    ],
  };
}

// === Data helpers ===

function getCard(cardId) {
  return db.prepare("SELECT * FROM raid_cards WHERE card_id = ?").get(cardId);
}

function isMostVotedActiveCard(card) {
  const top = db
    .prepare(
      "SELECT MAX(vote_count) AS maxVotes FROM raid_cards WHERE stage = 'voting' AND chat_id = ?"
    )
    .get(card.chat_id);
  return top.maxVotes > 0 && card.vote_count === top.maxVotes;
}

// The single "what's the hottest card right now" query, used by the
// repost cycle. A live raid always outranks any voting card; among
// voting cards, most votes wins. Cards that have hit REPOST_LIMIT are
// excluded so they naturally stop competing once they've had their fair
// share of airtime.
function getLeadingCard(chatId) {
  const leadingRaid = db
    .prepare(
      "SELECT * FROM raid_cards WHERE stage = 'raid' AND chat_id = ? AND repost_count < ? ORDER BY created_at DESC LIMIT 1"
    )
    .get(chatId, REPOST_LIMIT);
  if (leadingRaid) return leadingRaid;

  return db
    .prepare(
      "SELECT * FROM raid_cards WHERE stage = 'voting' AND chat_id = ? AND repost_count < ? ORDER BY vote_count DESC, created_at DESC LIMIT 1"
    )
    .get(chatId, REPOST_LIMIT);
}

// === Rendering ===
// One function edits an existing card message in place, one function
// posts a brand new one. Both handle the image/no-image and
// HTML/plain-text-fallback branching identically, since both stages
// share the same caption/keyboard builders above.

async function editCardMessage(bot, card) {
  const caption = buildCaption(card, isMostVotedActiveCard(card));
  const keyboard = buildKeyboard(card);
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
    console.warn("[cardSystem] edit failed, retrying as plain text:", err.message);
    try {
      const plain = stripHtml(caption);
      if (hasImage) {
        await bot.telegram.editMessageCaption(card.chat_id, card.message_id, undefined, plain, {
          reply_markup: keyboard,
        });
      } else {
        await bot.telegram.editMessageText(card.chat_id, card.message_id, undefined, plain, {
          reply_markup: keyboard,
          disable_web_page_preview: true,
        });
      }
    } catch (err2) {
      console.error("[cardSystem] plain-text edit fallback also failed:", err2.message);
    }
  }
}

async function sendNewCardMessage(bot, chatId, card, prefix = "") {
  const caption = `${prefix}${buildCaption(card, isMostVotedActiveCard(card))}`;
  const keyboard = buildKeyboard(card);
  const cardImageFileId = card.has_image ? getSetting("card_image_file_id") : null;

  let sent = null;
  try {
    if (cardImageFileId) {
      sent = await bot.telegram.sendPhoto(chatId, cardImageFileId, {
        caption,
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
    } else {
      sent = await bot.telegram.sendMessage(chatId, caption, {
        parse_mode: "HTML",
        reply_markup: keyboard,
        disable_web_page_preview: true,
      });
    }
  } catch (err) {
    console.warn("[cardSystem] send failed, retrying as plain text:", err.message);
    try {
      const plain = `${prefix}${stripHtml(buildCaption(card, isMostVotedActiveCard(card)))}`;
      if (cardImageFileId) {
        sent = await bot.telegram.sendPhoto(chatId, cardImageFileId, {
          caption: plain,
          reply_markup: keyboard,
        });
      } else {
        sent = await bot.telegram.sendMessage(chatId, plain, {
          reply_markup: keyboard,
          disable_web_page_preview: true,
        });
      }
    } catch (err2) {
      console.error("[cardSystem] plain-text send fallback also failed:", err2.message);
    }
  }
  return sent;
}

// === Repost cycle ===
// One repost function for any card, any stage. Disables the old
// message's buttons first (best-effort), posts a fresh copy, increments
// the single shared repost_count.

async function repostCard(bot, card) {
  try {
    await bot.telegram.editMessageReplyMarkup(card.chat_id, card.message_id, undefined, {
      inline_keyboard: [],
    });
  } catch {
    // old message may already be gone — non-fatal
  }

  const sent = await sendNewCardMessage(bot, card.chat_id, card, "🔄 ");

  if (sent) {
    db.prepare(
      "UPDATE raid_cards SET message_id = ?, repost_count = repost_count + 1 WHERE card_id = ?"
    ).run(sent.message_id, card.card_id);
  }
}

// === Public: message watcher (creates new cards) ===

export function registerCardSystem({ bot, groupChatId, founderUserId }) {
  bot.on("message", async (ctx, next) => {
    const text = ctx.message?.text || ctx.message?.caption;
    if (!text) return next();

    const match = text.match(X_URL_REGEX);
    if (match) {
      await handleNewCardSubmission(ctx, match[0], text, founderUserId);
      return next();
    }

    // Not a link — still counts toward the repost cycle.
    await tickRepostCounter(bot, ctx.chat.id);
    return next();
  });

  bot.on("callback_query", async (ctx, next) => {
    const data = ctx.callbackQuery.data || "";

    if (data.startsWith("vote:")) {
      await handleVote(bot, ctx, groupChatId, founderUserId);
      return;
    }

    if (data.startsWith("cardremove:")) {
      await handleRemove(bot, ctx, founderUserId);
      return;
    }

    return next();
  });
}

async function tickRepostCounter(bot, chatId) {
  const count = (messageCounters.get(chatId) || 0) + 1;
  if (count >= REPOST_EVERY_N) {
    messageCounters.set(chatId, 0);
    try {
      const leading = getLeadingCard(chatId);
      if (leading) {
        await repostCard(bot, leading);
      }
    } catch (err) {
      console.error("[cardSystem] repost cycle failed:", err.message);
    }
  } else {
    messageCounters.set(chatId, count);
  }
}

async function handleNewCardSubmission(ctx, url, fullText, founderUserId) {
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
    return;
  }

  // Comment text is whatever follows the link, with no restriction on
  // content at all — any text, including things starting with "/", is
  // accepted exactly as typed. It's only ever rendered through
  // escapeHtml, never executed or interpreted as a command.
  const commentText = fullText.replace(url, "").trim();
  if (!commentText) {
    try {
      await ctx.reply(
        "Include your own comment text in the same message as the link, e.g.:\nhttps://x.com/... Great project, just bought in."
      );
    } catch {
      // non-fatal
    }
    return;
  }

  const chatId = ctx.chat.id;
  const now = Date.now();
  const expiresAt = now + CARD_EXPIRY_MIN * 60 * 1000;
  const cardImageFileId = getSetting("card_image_file_id");
  const hasImageFlag = cardImageFileId ? 1 : 0;

  const insert = db.prepare(
    `INSERT INTO raid_cards (chat_id, posted_by, posted_by_username, url, comment_text, stage, vote_count, created_at, expires_at, has_image, repost_count)
     VALUES (?, ?, ?, ?, ?, 'voting', 0, ?, ?, ?, 0)`
  );
  const result = insert.run(
    chatId,
    userId,
    username || null,
    url,
    commentText,
    now,
    expiresAt,
    hasImageFlag
  );
  const card = getCard(result.lastInsertRowid);

  const caption = buildCaption(card, false);
  const keyboard = buildKeyboard(card);

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
    console.warn("[cardSystem] failed to post new card, retrying as plain text:", err.message);
    try {
      const plain = stripHtml(caption);
      if (cardImageFileId) {
        sent = await ctx.replyWithPhoto(cardImageFileId, { caption: plain, reply_markup: keyboard });
      } else {
        sent = await ctx.reply(plain, { reply_markup: keyboard, disable_web_page_preview: true });
      }
    } catch (err2) {
      console.error("[cardSystem] plain-text fallback also failed to post card:", err2.message);
    }
  }

  if (sent) {
    db.prepare("UPDATE raid_cards SET message_id = ? WHERE card_id = ?").run(
      sent.message_id,
      card.card_id
    );
  }
}

async function announceIfLeveledUp(bot, groupChatId, founderUserId, username, userId, result) {
  if (result.leveledUp && RECOGNITION_TITLES.has(result.newTitle)) {
    try {
      await bot.telegram.sendMessage(
        groupChatId,
        `⚠ SYSTEM NOTICE\n@${username || userId} has been classified as: ${result.newTitle}`
      );
    } catch (err) {
      console.error("[cardSystem] recognition message failed:", err.message);
    }
  }
  if (result.roleChanged && founderUserId) {
    try {
      await bot.telegram.sendMessage(
        founderUserId,
        `⚠ ROLE UNLOCK\n@${username || userId} has reached ${result.newRole} (${result.newTitle}).`
      );
    } catch {
      console.warn("[cardSystem] could not DM founder about role change");
    }
  }
}

async function handleVote(bot, ctx, groupChatId, founderUserId) {
  const data = ctx.callbackQuery.data;
  const cardId = parseInt(data.split(":")[1], 10);
  const userId = ctx.from.id;
  const username = ctx.from.username;

  const card = getCard(cardId);
  if (!card || card.stage !== "voting") {
    await ctx.answerCbQuery("This card is no longer accepting votes.");
    return;
  }

  let inserted = false;
  try {
    db.prepare("INSERT INTO card_votes (card_id, user_id, timestamp) VALUES (?, ?, ?)").run(
      cardId,
      userId,
      Date.now()
    );
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

  db.prepare("UPDATE raid_cards SET vote_count = vote_count + 1 WHERE card_id = ?").run(cardId);
  const updatedCard = getCard(cardId);

  await ctx.answerCbQuery("Vote counted.");

  if (updatedCard.vote_count >= VOTE_THRESHOLD) {
    db.prepare("UPDATE raid_cards SET stage = 'raid' WHERE card_id = ?").run(cardId);
    const raidCard = getCard(cardId);
    await editCardMessage(bot, raidCard);
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
    await editCardMessage(bot, updatedCard);
  }
}

async function handleRemove(bot, ctx, founderUserId) {
  const data = ctx.callbackQuery.data;
  const cardId = parseInt(data.split(":")[1], 10);
  const userId = ctx.from.id;

  if (!userMeetsTitleRank(userId, DELETE_REQUIRED_TITLE) && String(userId) !== String(founderUserId)) {
    await ctx.answerCbQuery("Diamond Hand status or higher required to remove cards.", {
      show_alert: true,
    });
    return;
  }

  const card = getCard(cardId);
  if (!card) {
    await ctx.answerCbQuery("Card already gone.");
    return;
  }

  db.prepare("UPDATE raid_cards SET stage = 'removed' WHERE card_id = ?").run(cardId);

  try {
    await bot.telegram.deleteMessage(card.chat_id, card.message_id);
  } catch (err) {
    console.warn("[cardSystem] failed to delete card message:", err.message);
  }

  await ctx.answerCbQuery("Removed.");
}

// === Expiry sweep (called from scheduler.js) ===
// Cards that never reached vote threshold in time quietly expire and
// drop out of the repost rotation, same as before.

export async function sweepExpiredCards(bot) {
  const now = Date.now();
  const expiring = db
    .prepare("SELECT * FROM raid_cards WHERE stage = 'voting' AND expires_at <= ?")
    .all(now);

  for (const card of expiring) {
    db.prepare("UPDATE raid_cards SET stage = 'expired' WHERE card_id = ?").run(card.card_id);
    try {
      await bot.telegram.editMessageReplyMarkup(card.chat_id, card.message_id, undefined, {
        inline_keyboard: [],
      });
    } catch {
      // message may already be gone — non-fatal
    }
  }
}
