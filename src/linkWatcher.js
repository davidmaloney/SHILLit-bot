import fetch from "node-fetch";
import db from "./db.js";

const URL_REGEX = /(https?:\/\/[^\s]+)/i;
const IMAGE_ATTACH_WINDOW_MS = 2 * 60 * 1000; // 2 minutes to attach a custom photo

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

  const image = get(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);

  return { title, description, image };
}

async function fetchLinkPreview(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ShillitBot/1.0)" },
      redirect: "follow",
      timeout: 8000,
    });
    const html = await res.text();
    return extractMeta(html);
  } catch (err) {
    console.warn("[linkWatcher] preview fetch failed:", err.message);
    return { title: null, description: null, image: null };
  }
}

function buildRatingKeyboard(cardId) {
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

function cardCaption(card) {
  const title = card.title || "Untitled link";
  const desc = card.description ? `\n${card.description.slice(0, 200)}` : "";
  return `${title}${desc}\n\n⭐ Community Score: — (0 ratings)\n\n${card.url}`;
}

export function registerLinkWatcher({ bot }) {
  const DEFAULT_TARGET = parseInt(process.env.RAID_DEFAULT_TARGET || "10", 10);

  bot.on("message", async (ctx, next) => {
    const text = ctx.message?.text || ctx.message?.caption;
    if (!text) return next();

    const match = text.match(URL_REGEX);
    if (!match) return next();

    const url = match[1];
    const userId = ctx.from.id;
    const chatId = ctx.chat.id;
    const now = Date.now();

    const preview = await fetchLinkPreview(url);

    const insert = db.prepare(
      `INSERT INTO link_cards (chat_id, posted_by, url, title, description, image_url, stage, rating_total, rating_count, raid_count, raid_target, created_at, awaiting_image_until)
       VALUES (?, ?, ?, ?, ?, ?, 'rating', 0, 0, 0, ?, ?, ?)`
    );
    const result = insert.run(
      chatId,
      userId,
      url,
      preview.title,
      preview.description,
      preview.image,
      DEFAULT_TARGET,
      now,
      now + IMAGE_ATTACH_WINDOW_MS
    );
    const cardId = result.lastInsertRowid;
    const card = db.prepare("SELECT * FROM link_cards WHERE card_id = ?").get(cardId);

    const caption = cardCaption(card);
    const keyboard = buildRatingKeyboard(cardId);

    try {
      let sent;
      if (card.image_url) {
        sent = await ctx.replyWithPhoto(card.image_url, {
          caption,
          reply_markup: keyboard,
        });
      } else {
        sent = await ctx.reply(caption, { reply_markup: keyboard });
      }
      db.prepare("UPDATE link_cards SET message_id = ? WHERE card_id = ?").run(
        sent.message_id,
        cardId
      );
    } catch (err) {
      console.error("[linkWatcher] failed to post card:", err.message);
    }

    return next();
  });

  // Allows a user to reply to their own link message with a photo within
  // the attach window to manually set the card image.
  bot.on("photo", async (ctx, next) => {
    const replyTo = ctx.message.reply_to_message;
    if (!replyTo) return next();

    const card = db
      .prepare("SELECT * FROM link_cards WHERE message_id = ? AND posted_by = ?")
      .get(replyTo.message_id, ctx.from.id);

    if (!card) return next();
    if (card.awaiting_image_until && Date.now() > card.awaiting_image_until) return next();

    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const fileId = photo.file_id;

    db.prepare("UPDATE link_cards SET image_url = ? WHERE card_id = ?").run(fileId, card.card_id);

    try {
      await ctx.reply("Image attached to your card.");
    } catch {
      // non-fatal
    }

    return next();
  });
}

export { cardCaption, buildRatingKeyboard };
