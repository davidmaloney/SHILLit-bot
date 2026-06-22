import db from "./db.js";
import { spendConviction } from "./reputation.js";

// === Configuration ===
// Cost in Conviction to create a poll. Spending is real — it can lower
// the creator's title/rank if it drops them below a threshold (handled
// in spendConviction), so points can't be burned with no consequence.
const POLL_COST = parseInt(process.env.POLL_COST || "10", 10);
// Soft anti-spam: max polls one person can create per rolling hour.
const POLL_HOURLY_CAP = parseInt(process.env.POLL_HOURLY_CAP || "3", 10);
// Max length of the optional note the creator can add after /pollify.
const NOTE_MAX = 200;
// Max length of the quoted source message shown on the card.
const SOURCE_MAX = 300;

// === Text safety ===
function escapeHtml(text) {
  if (!text) return "";
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function stripHtml(text) {
  return text.replace(/<[^>]+>/g, "");
}

// === Visual bar ===
// Builds a proportional colored bar from the yes/no tallies. Open-ended —
// it shows the LEAN, not progress toward any target. With no votes yet it
// shows a neutral empty bar.
function buildBar(yes, no) {
  const total = yes + no;
  const slots = 10;
  if (total === 0) {
    return `${"⬜".repeat(slots)}\nNo votes yet`;
  }
  const yesSlots = Math.round((yes / total) * slots);
  const noSlots = slots - yesSlots;
  const bar = `${"🟩".repeat(yesSlots)}${"🟥".repeat(noSlots)}`;
  const yesPct = Math.round((yes / total) * 100);
  const noPct = 100 - yesPct;
  return `${bar}\n🟩 Yes ${yesPct}% (${yes})   🟥 No ${noPct}% (${no})`;
}

// === Data helpers ===
function getPoll(pollId) {
  return db.prepare("SELECT * FROM polls WHERE poll_id = ?").get(pollId);
}

function pollsCreatedSince(userId, sinceTs) {
  return db
    .prepare("SELECT COUNT(*) AS c FROM polls WHERE creator_id = ? AND created_at >= ?")
    .get(userId, sinceTs).c;
}

// === Caption + keyboard ===
function buildPollCaption(poll) {
  const source = escapeHtml(poll.source_text.slice(0, SOURCE_MAX));
  const note = poll.creator_note ? escapeHtml(poll.creator_note.slice(0, NOTE_MAX)) : "";
  const closed = poll.status === "closed";
  // source_author_username is stored already including a leading "@" when
  // the person has a username, or as a plain display name when they don't,
  // so it is rendered as-is here (never prefixed with another @).
  const author = poll.source_author_username
    ? escapeHtml(poll.source_author_username)
    : "Someone";
  const creator = escapeHtml(poll.creator_username ? `@${poll.creator_username}` : "someone");

  let out = `<b>📊 SHILLit Poll</b>${closed ? " — <b>CLOSED</b>" : ""}\n`;
  out += `┏━━━━━━━━━━━━━┓\n`;
  out += `⚡ <b>Costs ${POLL_COST} Conviction to create</b>\n`;
  out += `┗━━━━━━━━━━━━━┛\n\n`;

  // The original message being polled — author always shown above it.
  out += `🗨️ <b>${author}</b> said:\n`;
  out += `<i>“${source}”</i>\n\n`;

  // The poll creator's own framing question, if they added one.
  if (note) {
    out += `💬 <b>${creator} asks:</b>\n${note}\n\n`;
  }

  out += `${buildBar(poll.yes_count, poll.no_count)}\n\n`;

  if (!closed) {
    out += `🗣️ <i>Let's debate this in chat — vote anytime.</i>`;
  } else {
    out += `🔒 <i>This poll has closed.</i>`;
  }
  return out;
}

function buildPollKeyboard(poll) {
  if (poll.status === "closed") return { inline_keyboard: [] };
  return {
    inline_keyboard: [
      [
        { text: "🟩 Yes", callback_data: `poll:${poll.poll_id}:yes` },
        { text: "🟥 No", callback_data: `poll:${poll.poll_id}:no` },
      ],
    ],
  };
}

async function editPollMessage(bot, poll) {
  const caption = buildPollCaption(poll);
  const keyboard = buildPollKeyboard(poll);
  try {
    await bot.telegram.editMessageText(poll.chat_id, poll.message_id, undefined, caption, {
      parse_mode: "HTML",
      reply_markup: keyboard,
      disable_web_page_preview: true,
    });
  } catch (err) {
    // Telegram throws if the text is unchanged; that's harmless. Only log
    // genuinely unexpected failures.
    if (!String(err.message).includes("message is not modified")) {
      console.warn("[pollSystem] edit failed:", err.message);
    }
  }
}

// === Registration ===
export function registerPollSystem({ bot, founderUserId }) {
  bot.command("pollify", async (ctx) => {
    const replied = ctx.message.reply_to_message;
    if (!replied) {
      await ctx.reply("Reply to a message with /pollify to turn it into a poll.");
      return;
    }

    const sourceText = replied.text || replied.caption;
    if (!sourceText) {
      await ctx.reply("That message has no text to turn into a poll.");
      return;
    }

    const userId = ctx.from.id;
    const username = ctx.from.username;

    // Soft hourly cap (founder exempt).
    const isFounderUser = String(userId) === String(founderUserId);
    if (!isFounderUser) {
      const hourAgo = Date.now() - 60 * 60 * 1000;
      if (pollsCreatedSince(userId, hourAgo) >= POLL_HOURLY_CAP) {
        await ctx.reply(`Easy — you can create up to ${POLL_HOURLY_CAP} polls per hour.`);
        return;
      }
    }

    // The optional note is whatever the user typed after "/pollify".
    const rawNote = ctx.message.text.replace(/^\/pollify(@\w+)?/i, "").trim();
    const note = rawNote ? rawNote.slice(0, NOTE_MAX) : null;

    // Charge Conviction first. If they can't afford it, stop — nothing
    // else happens, no poll created.
    const spend = spendConviction(userId, username, POLL_COST);
    if (!spend.ok) {
      await ctx.reply(
        `Creating a poll costs ${POLL_COST} Conviction — you're ${spend.shortfall} short.`
      );
      return;
    }

    const now = Date.now();
    const sourceAuthor =
      replied.from?.username
        ? `@${replied.from.username}`
        : replied.from?.first_name || "Someone";

    const result = db
      .prepare(
        `INSERT INTO polls (chat_id, creator_id, creator_username, source_author_username, source_text, creator_note, yes_count, no_count, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, 0, 'open', ?)`
      )
      .run(
        ctx.chat.id,
        userId,
        username || null,
        sourceAuthor,
        sourceText.slice(0, SOURCE_MAX),
        note,
        now
      );

    const poll = getPoll(result.lastInsertRowid);
    const caption = buildPollCaption(poll);
    const keyboard = buildPollKeyboard(poll);

    let sent = null;
    try {
      sent = await ctx.reply(caption, {
        parse_mode: "HTML",
        reply_markup: keyboard,
        disable_web_page_preview: true,
      });
    } catch (err) {
      console.warn("[pollSystem] failed to post poll, retrying plain:", err.message);
      try {
        sent = await ctx.reply(stripHtml(caption), {
          reply_markup: keyboard,
          disable_web_page_preview: true,
        });
      } catch (err2) {
        console.error("[pollSystem] plain-text poll post also failed:", err2.message);
      }
    }

    if (sent) {
      db.prepare("UPDATE polls SET message_id = ? WHERE poll_id = ?").run(
        sent.message_id,
        poll.poll_id
      );
    }

    // If spending dropped the creator's rank, let them know quietly.
    if (spend.roleChanged || spend.leveledDown) {
      try {
        await ctx.reply(
          `Heads up @${username || userId} — spending dropped you to ${spend.user.title}.`
        );
      } catch {
        // non-fatal
      }
    }
  });

  bot.on("callback_query", async (ctx, next) => {
    const data = ctx.callbackQuery.data || "";
    if (!data.startsWith("poll:")) return next();

    const [, pollIdStr, choice] = data.split(":");
    const pollId = parseInt(pollIdStr, 10);
    const poll = getPoll(pollId);

    if (!poll || poll.status !== "open") {
      await ctx.answerCbQuery("This poll is closed.");
      return;
    }

    const userId = ctx.from.id;
    const now = Date.now();

    // Has this user already voted? If so, allow changing their vote
    // rather than blocking — adjust both tallies accordingly.
    const existing = db
      .prepare("SELECT choice FROM poll_votes WHERE poll_id = ? AND user_id = ?")
      .get(pollId, userId);

    if (existing && existing.choice === choice) {
      await ctx.answerCbQuery("You already voted that way.");
      return;
    }

    if (existing) {
      // Switch vote: remove old tally, add new.
      db.prepare("UPDATE poll_votes SET choice = ?, timestamp = ? WHERE poll_id = ? AND user_id = ?").run(
        choice,
        now,
        pollId,
        userId
      );
      if (existing.choice === "yes") {
        db.prepare("UPDATE polls SET yes_count = yes_count - 1, no_count = no_count + 1 WHERE poll_id = ?").run(pollId);
      } else {
        db.prepare("UPDATE polls SET no_count = no_count - 1, yes_count = yes_count + 1 WHERE poll_id = ?").run(pollId);
      }
      await ctx.answerCbQuery("Vote changed.");
    } else {
      db.prepare("INSERT INTO poll_votes (poll_id, user_id, choice, timestamp) VALUES (?, ?, ?, ?)").run(
        pollId,
        userId,
        choice,
        now
      );
      if (choice === "yes") {
        db.prepare("UPDATE polls SET yes_count = yes_count + 1 WHERE poll_id = ?").run(pollId);
      } else {
        db.prepare("UPDATE polls SET no_count = no_count + 1 WHERE poll_id = ?").run(pollId);
      }
      await ctx.answerCbQuery("Vote counted.");
    }

    // Live in-place update of the card so the bar moves as people vote,
    // no repost needed.
    const updated = getPoll(pollId);
    await editPollMessage(bot, updated);
  });
}
