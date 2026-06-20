import db, { getSetting } from "./db.js";
import { getLeadingVotingCard, repostVotingCard, stripHtml } from "./xCardWatcher.js";
import { raidCaption, raidKeyboard } from "./raidHandler.js";

// Rather than a timer, we count real messages flowing through the chat.
// Every REPOST_EVERY_N_MESSAGES messages, the single leading voting card
// and the single leading raid box (if any exist) get reposted as fresh
// messages so they don't get buried in a busy chat. A quiet chat simply
// never hits the threshold, so this never spams an inactive group.
const REPOST_EVERY_N = parseInt(process.env.REPOST_EVERY_N_MESSAGES || "15", 10);
const RAID_REPOST_LIMIT = parseInt(process.env.RAID_REPOST_LIMIT || "3", 10);

// Tracked per chat, since a bot could in principle run in more than one
// group — keeps the counters independent.
const messageCounters = new Map();

function getLeadingRaidBox(chatId) {
  // Excludes any raid box that has already been reposted RAID_REPOST_LIMIT
  // times — once a raid has had its fair share of airtime, it stops
  // competing for repost slots instead of looping forever.
  return db
    .prepare(
      "SELECT * FROM raid_cards WHERE stage = 'raid' AND chat_id = ? AND raid_repost_count < ? ORDER BY created_at DESC LIMIT 1"
    )
    .get(chatId, RAID_REPOST_LIMIT);
}

async function repostRaidBox(bot, card) {
  const caption = raidCaption(card);
  const cardImageFileId = getSetting("card_image_file_id");
  const keyboard = raidKeyboard();

  try {
    // Disable buttons on the old message so there's never two live,
    // actionable copies of the same raid box at once.
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
    console.warn("[repostHandler] failed to repost raid box, retrying as plain text:", err.message);
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
      console.error("[repostHandler] plain-text repost fallback also failed:", err2.message);
    }
  }

  if (sent) {
    db.prepare(
      "UPDATE raid_cards SET message_id = ?, has_image = ?, raid_repost_count = raid_repost_count + 1 WHERE card_id = ?"
    ).run(sent.message_id, cardImageFileId ? 1 : 0, card.card_id);
  }
}

export function registerRepostHandler({ bot }) {
  bot.on("message", async (ctx, next) => {
    const chatId = ctx.chat.id;
    const count = (messageCounters.get(chatId) || 0) + 1;

    if (count >= REPOST_EVERY_N) {
      messageCounters.set(chatId, 0);
      try {
        const leadingVote = getLeadingVotingCard(chatId);
        if (leadingVote) {
          await repostVotingCard(bot, leadingVote);
        }
        const leadingRaid = getLeadingRaidBox(chatId);
        if (leadingRaid) {
          await repostRaidBox(bot, leadingRaid);
        }
      } catch (err) {
        console.error("[repostHandler] repost cycle failed:", err.message);
      }
    } else {
      messageCounters.set(chatId, count);
    }

    return next();
  });
}
