import db, { getSetting } from "./db.js";
import { getLeadingVotingCard, repostVotingCard } from "./xCardWatcher.js";
import { raidCaption, raidKeyboard } from "./raidHandler.js";

// Rather than a timer, we count real messages flowing through the chat.
// Every REPOST_EVERY_N_MESSAGES messages, the single leading voting card
// and the single leading raid box (if any exist) get reposted as fresh
// messages so they don't get buried in a busy chat. A quiet chat simply
// never hits the threshold, so this never spams an inactive group.
const REPOST_EVERY_N = parseInt(process.env.REPOST_EVERY_N_MESSAGES || "15", 10);

// Tracked per chat, since a bot could in principle run in more than one
// group — keeps the counters independent.
const messageCounters = new Map();

function getLeadingRaidBox(chatId) {
  return db
    .prepare(
      "SELECT * FROM raid_cards WHERE stage = 'raid' AND chat_id = ? ORDER BY raid_count DESC, created_at DESC LIMIT 1"
    )
    .get(chatId);
}

async function repostRaidBox(bot, card) {
  const caption = raidCaption(card);
  const cardImageFileId = getSetting("card_image_file_id");

  try {
    // Disable buttons on the old message so there's never two live,
    // actionable copies of the same raid box at once.
    await bot.telegram.editMessageReplyMarkup(card.chat_id, card.message_id, undefined, {
      inline_keyboard: [],
    });
  } catch {
    // old message may already be gone — non-fatal
  }

  try {
    let sent;
    if (cardImageFileId) {
      sent = await bot.telegram.sendPhoto(card.chat_id, cardImageFileId, {
        caption: `🔄 ${caption}`,
        parse_mode: "Markdown",
        reply_markup: raidKeyboard(card.card_id, card.url),
      });
    } else {
      sent = await bot.telegram.sendMessage(card.chat_id, `🔄 ${caption}`, {
        parse_mode: "Markdown",
        reply_markup: raidKeyboard(card.card_id, card.url),
        disable_web_page_preview: true,
      });
    }
    db.prepare("UPDATE raid_cards SET message_id = ? WHERE card_id = ?").run(
      sent.message_id,
      card.card_id
    );
  } catch (err) {
    console.warn("[repostHandler] failed to repost raid box:", err.message);
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
