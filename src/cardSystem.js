import db, { getSetting } from "./db.js";
import { awardConviction, userMeetsTitleRank } from "./reputation.js";

// === Configuration ===
const X_URL_REGEX = /(https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[^\s]+)/i;
const REQUIRED_TITLE = process.env.RAID_REQUIRED_TITLE || "Diamond Hand";
const DELETE_REQUIRED_TITLE = "Diamond Hand";
const VOTE_THRESHOLD = parseInt(process.env.RAID_VOTE_THRESHOLD || "5", 10);
const CARD_EXPIRY_MIN = parseInt(process.env.CARD_EXPIRY_MINUTES || "180", 10);
// Separate from CARD_EXPIRY_MIN — that one governs how long a card has to
// collect votes, this one governs how long a raid stays active once it
// actually starts. Kept independent so changing one never silently
// affects the other.
const RAID_DURATION_MIN = parseInt(process.env.RAID_DURATION_MINUTES || "15", 10);
const REPOST_EVERY_N = parseInt(process.env.REPOST_EVERY_N_MESSAGES || "15", 10);
// One shared cap for the whole life of a card, voting or raid — replaces
// the old two-counter design where only raid boxes had a limit.
const REPOST_LIMIT = parseInt(process.env.RAID_REPOST_LIMIT || "5", 10);
// Bonus Conviction awarded to the person who POSTED a card, but only when
// that card actually crosses the vote threshold and becomes a live raid —
// rewarding starting something the community genuinely backed, not just
// posting links. Awarded once per card, at the moment of transition.
const RAID_STARTER_BONUS = parseInt(process.env.RAID_STARTER_BONUS || "3", 10);

// A subtle standing nudge shown on active voting and raid cards (not on
// closed ones), reminding people that starting raids is within reach.
const DIAMOND_NUDGE = "💎 Anyone Diamond Hand+ can start raids — it doesn't take long to get there";

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

function raidMinutesRemaining(card) {
  if (!card.raid_started_at) return RAID_DURATION_MIN;
  const raidExpiresAt = card.raid_started_at + RAID_DURATION_MIN * 60 * 1000;
  const msLeft = raidExpiresAt - Date.now();
  return Math.max(0, Math.round(msLeft / 60000));
}

function isRaidClosed(card) {
  return card.stage === "raid" && raidMinutesRemaining(card) <= 0;
}

function buildCaption(card, isHot) {
  const comment = escapeHtml(card.comment_text.slice(0, 400));

  if (card.stage === "raid") {
    const believeLine =
      card.vote_count > 0
        ? `🙌 ${card.vote_count} ${card.vote_count === 1 ? "person" : "people"} already believe in this\n\n`
        : "";

    if (isRaidClosed(card)) {
      // Honest, visible ending instead of the countdown silently
      // disappearing with no acknowledgment that anything changed.
      return (
        `<b>🔒 Raid Closed</b>\n\n` +
        `💬 <b>Their comment:</b>\n${comment}\n\n` +
        believeLine +
        `This raid has ended.\n\n` +
        `<a href="${escapeHtml(card.url)}">View on X</a>`
      );
    }

    const minsLeft = raidMinutesRemaining(card);
    const timeLine = `⏳ Closes in ${minsLeft} minute${minsLeft === 1 ? "" : "s"}\n\n`;
    return (
      `<b>⚔ RAID ACTIVE</b>\n\n` +
      `💬 <b>Their comment:</b>\n${comment}\n\n` +
      believeLine +
      timeLine +
      `👉 <a href="${escapeHtml(card.url)}">Tap here to raid</a>\n\n` +
      DIAMOND_NUDGE
    );
  }

  // voting stage — target shown alongside the count so people know how
  // many votes are actually needed, not just how many exist so far.
  const heat = isHot ? " 🔥" : "";
  return (
    `<b>Comment Raid</b>${heat}\n\n` +
    `💬 <b>Their comment:</b>\n${comment}\n\n` +
    `🗳️ Votes: ${card.vote_count}/${VOTE_THRESHOLD}\n\n` +
    DIAMOND_NUDGE
  );
}

function buildKeyboard(card) {
  if (card.stage === "raid") {
    if (isRaidClosed(card)) {
      return { inline_keyboard: [] };
    }
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

// Awards the raid-starter bonus to whoever posted the card, called once
// at the moment a card becomes a live raid. Guards against a missing
// poster id (older cards) so it can never throw.
function awardRaidStarterBonus(card) {
  if (!card || !card.posted_by || RAID_STARTER_BONUS <= 0) return;
  try {
    awardConviction(card.posted_by, card.posted_by_username || null, RAID_STARTER_BONUS);
  } catch (err) {
    console.warn("[cardSystem] failed to award raid-starter bonus:", err.message);
  }
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
// voting cards, most votes wins. Cards that have hit REPOST_LIMIT, or
// raids that have already visibly closed, are excluded so they stop
// competing for airtime once they've had their fair share or ended.
function getLeadingCard(chatId) {
  const raidCutoff = Date.now() - RAID_DURATION_MIN * 60 * 1000;
  const leadingRaid = db
    .prepare(
      `SELECT * FROM raid_cards
       WHERE stage = 'raid' AND chat_id = ? AND repost_count < ?
       AND (raid_started_at IS NULL OR raid_started_at > ?)
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(chatId, REPOST_LIMIT, raidCutoff);
  if (leadingRaid) return leadingRaid;

  return db
    .prepare(
      "SELECT * FROM raid_cards WHERE stage = 'voting' AND chat_id = ? AND repost_count < ? ORDER BY vote_count DESC, created_at DESC LIMIT 1"
    )
    .get(chatId, REPOST_LIMIT);
}

// === Card media helper ===
// The card's attached media can be either a photo or a video, set once
// via /set_card_image (which accepts both). Editing a card's caption
// works identically for photo and video messages — only the initial
// SEND differs (sendPhoto vs sendVideo) — so this helper centralizes
// "what media is set, and how should it be sent" in one place. A media
// set before this feature existed has no stored type and safely defaults
// to "photo", so existing setups keep working untouched.
function getCardMedia() {
  const fileId = getSetting("card_image_file_id");
  if (!fileId) return null;
  const type = getSetting("card_image_type") || "photo";
  return { fileId, type };
}

async function sendCardMedia(bot, chatId, media, caption, keyboard, plainOnly = false) {
  const opts = plainOnly
    ? { caption, reply_markup: keyboard }
    : { caption, parse_mode: "HTML", reply_markup: keyboard };
  if (media.type === "video") {
    return bot.telegram.sendVideo(chatId, media.fileId, opts);
  }
  return bot.telegram.sendPhoto(chatId, media.fileId, opts);
}

async function replyCardMedia(ctx, media, caption, keyboard, plainOnly = false) {
  const opts = plainOnly
    ? { caption, reply_markup: keyboard }
    : { caption, parse_mode: "HTML", reply_markup: keyboard };
  if (media.type === "video") {
    return ctx.replyWithVideo(media.fileId, opts);
  }
  return ctx.replyWithPhoto(media.fileId, opts);
}

// === Rendering ===
// One function edits an existing card message in place, one function
// posts a brand new one. Both handle the image/no-image and
// HTML/plain-text-fallback branching identically, since both stages
// share the same caption/keyboard builders above. Caption editing works
// the same for photo and video, so editCardMessage needs no media-type
// branching — only the initial send differs.

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
  const media = card.has_image ? getCardMedia() : null;

  let sent = null;
  try {
    if (media) {
      sent = await sendCardMedia(bot, chatId, media, caption, keyboard);
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
      if (media) {
        sent = await sendCardMedia(bot, chatId, media, plain, keyboard, true);
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
  const media = getCardMedia();
  const hasImageFlag = media ? 1 : 0;

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
    if (media) {
      sent = await replyCardMedia(ctx, media, caption, keyboard);
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
      if (media) {
        sent = await replyCardMedia(ctx, media, plain, keyboard, true);
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

  // Single atomic statement: increments vote_count AND decides the new
  // stage in one indivisible database operation, with the threshold
  // comparison done by SQLite itself against the freshly-incremented
  // value. This closes the race condition where multiple near-simultaneous
  // votes could each independently read "still voting" before any of
  // them had a chance to flip the stage, letting the count overshoot the
  // threshold (e.g. landing on 4 votes when the threshold was 1).
  // WHERE stage = 'voting' additionally guarantees this only ever runs
  // once per card transition — if another concurrent call already
  // flipped it to 'raid', this UPDATE simply matches zero rows.
  const now = Date.now();
  db.prepare(
    `UPDATE raid_cards
     SET vote_count = vote_count + 1,
         stage = CASE WHEN vote_count + 1 >= ? THEN 'raid' ELSE stage END,
         raid_started_at = CASE WHEN vote_count + 1 >= ? THEN ? ELSE raid_started_at END
     WHERE card_id = ? AND stage = 'voting'`
  ).run(VOTE_THRESHOLD, VOTE_THRESHOLD, now, cardId);

  const updatedCard = getCard(cardId);

  await ctx.answerCbQuery("Vote counted.");

  if (updatedCard.stage === "raid" && updatedCard.raid_started_at === now) {
    // This specific call is the one that triggered the transition.
    awardRaidStarterBonus(updatedCard);
    await editCardMessage(bot, updatedCard);
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

export async function sweepExpiredCards(bot, founderUserId) {
  const now = Date.now();

  // Re-check every still-voting card against the CURRENT vote threshold.
  // Without this, lowering RAID_VOTE_THRESHOLD mid-session would leave
  // any card that already has enough votes permanently stuck in voting
  // stage until someone happens to cast a fresh vote on it — the
  // threshold check otherwise only runs inside handleVote.
  const stuckCards = db
    .prepare("SELECT * FROM raid_cards WHERE stage = 'voting' AND vote_count >= ?")
    .all(VOTE_THRESHOLD);
  for (const card of stuckCards) {
    const flip = db
      .prepare(
        "UPDATE raid_cards SET stage = 'raid', raid_started_at = ? WHERE card_id = ? AND stage = 'voting'"
      )
      .run(now, card.card_id);
    // Only proceed if THIS statement actually performed the transition.
    // If another path (a live vote) flipped it a moment earlier, changes
    // is 0 and we skip — so the bonus and notification never double-fire.
    if (flip.changes === 0) continue;
    const raidCard = getCard(card.card_id);
    if (raidCard && raidCard.stage === "raid") {
      awardRaidStarterBonus(raidCard);
      await editCardMessage(bot, raidCard);
      if (founderUserId) {
        try {
          await bot.telegram.sendMessage(
            founderUserId,
            `⚠ RAID TRIGGERED\nA comment-raid card by @${raidCard.posted_by_username || raidCard.posted_by} just hit threshold.\n${raidCard.url}`
          );
        } catch {
          // non-fatal
        }
      }
    }
  }

  // Expiry is calculated live from created_at + the CURRENT
  // CARD_EXPIRY_MIN, rather than relying on the fixed expires_at value
  // stored when the card was created. This means changing
  // CARD_EXPIRY_MINUTES in .env correctly applies to every existing
  // card immediately, not just new ones created afterward.
  const expiryCutoff = now - CARD_EXPIRY_MIN * 60 * 1000;
  const expiring = db
    .prepare("SELECT * FROM raid_cards WHERE stage = 'voting' AND created_at <= ?")
    .all(expiryCutoff);

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
