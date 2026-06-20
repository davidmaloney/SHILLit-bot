import db, { getSetting, setSetting } from "./db.js";
import { pickPulseTemplate, pickDurationMinutes } from "./pulses.js";
import { getUsersForDecayCheck, decayRole, getRandomActiveUser } from "./reputation.js";

const MIN_INTERVAL_MIN = parseInt(process.env.PULSE_MIN_INTERVAL_MINUTES || "240", 10);
const MAX_INTERVAL_MIN = parseInt(process.env.PULSE_MAX_INTERVAL_MINUTES || "1440", 10);
const FIRE_CHANCE = parseFloat(process.env.PULSE_FIRE_CHANCE || "0.4");

const SPOTLIGHT_MIN_MIN = parseInt(process.env.SPOTLIGHT_MIN_INTERVAL_MINUTES || "360", 10);
const SPOTLIGHT_MAX_MIN = parseInt(process.env.SPOTLIGHT_MAX_INTERVAL_MINUTES || "1440", 10);
const SPOTLIGHT_FIRE_CHANCE = parseFloat(process.env.SPOTLIGHT_FIRE_CHANCE || "0.3");

const CARD_EXPIRY_MIN = parseInt(process.env.CARD_EXPIRY_MINUTES || "180", 10);

const CHECK_INTERVAL_MS = 15 * 60 * 1000;
const EXPIRY_SWEEP_MS = 60 * 1000;
const DECAY_CHECK_MS = 6 * 60 * 60 * 1000;
const SPOTLIGHT_CHECK_MS = 30 * 60 * 1000;

// Persisted to the settings table instead of kept only in memory — every
// code deploy restarts the container, which used to silently reset these
// timers back to "never fired", causing real Pulses to fire right after
// each restart rather than on their natural day-by-day rhythm. Loading
// from the database means restarts no longer disrupt the schedule.
let lastPulseAt = parseInt(getSetting("last_pulse_at") || "0", 10);
let lastSpotlightAt = parseInt(getSetting("last_spotlight_at") || "0", 10);

function minutesSince(timestamp) {
  if (!timestamp) return Infinity;
  return (Date.now() - timestamp) / 60000;
}

export function startScheduler({ bot, groupChatId, founderUserId }) {
  // Pulse generation
  setInterval(async () => {
    try {
      const elapsed = minutesSince(lastPulseAt);
      if (elapsed < MIN_INTERVAL_MIN) return;

      const mustFire = elapsed >= MAX_INTERVAL_MIN;
      const roll = Math.random();

      if (mustFire || roll < FIRE_CHANCE) {
        await firePulse({ bot, groupChatId });
        lastPulseAt = Date.now();
        setSetting("last_pulse_at", String(lastPulseAt));
      }
    } catch (err) {
      console.error("[scheduler] pulse check failed:", err.message);
    }
  }, CHECK_INTERVAL_MS);

  // Pulse expiry sweep
  setInterval(async () => {
    try {
      const now = Date.now();
      const expiring = db
        .prepare("SELECT * FROM pulses WHERE active = 1 AND expires_at <= ?")
        .all(now);

      for (const pulse of expiring) {
        db.prepare("UPDATE pulses SET active = 0 WHERE pulse_id = ?").run(pulse.pulse_id);
        if (pulse.message_id && pulse.chat_id) {
          try {
            await bot.telegram.editMessageReplyMarkup(
              pulse.chat_id,
              pulse.message_id,
              undefined,
              { inline_keyboard: [] }
            );
          } catch {
            // message may already be gone — non-fatal
          }
        }
      }
    } catch (err) {
      console.error("[scheduler] pulse expiry sweep failed:", err.message);
    }
  }, EXPIRY_SWEEP_MS);

  // Raid card expiry sweep — cards that never reached vote threshold expire quietly
  setInterval(async () => {
    try {
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
    } catch (err) {
      console.error("[scheduler] card expiry sweep failed:", err.message);
    }
  }, EXPIRY_SWEEP_MS);

  // Role decay check
  setInterval(async () => {
    try {
      const decaying = getUsersForDecayCheck();
      for (const u of decaying) {
        decayRole(u.user_id);
        if (founderUserId) {
          try {
            await bot.telegram.sendMessage(
              founderUserId,
              `⚠ ROLE DECAY\n@${u.username || u.user_id} has lost ${u.current_role} status and title (was ${u.title}) due to inactivity.`
            );
          } catch {
            console.warn("[scheduler] could not DM founder about decay");
          }
        }
      }
    } catch (err) {
      console.error("[scheduler] decay check failed:", err.message);
    }
  }, DECAY_CHECK_MS);

  // Random status spotlight
  setInterval(async () => {
    try {
      const elapsed = minutesSince(lastSpotlightAt);
      if (elapsed < SPOTLIGHT_MIN_MIN) return;

      const mustFire = elapsed >= SPOTLIGHT_MAX_MIN;
      const roll = Math.random();

      if (mustFire || roll < SPOTLIGHT_FIRE_CHANCE) {
        const user = getRandomActiveUser();
        if (user) {
          await bot.telegram.sendMessage(
            groupChatId,
            `⚠ SYSTEM SCAN\n@${user.username || user.user_id} — ${user.title}. Status unchanged. Activity noted.`
          );
        }
        lastSpotlightAt = Date.now();
        setSetting("last_spotlight_at", String(lastSpotlightAt));
      }
    } catch (err) {
      console.error("[scheduler] spotlight check failed:", err.message);
    }
  }, SPOTLIGHT_CHECK_MS);
}

export async function firePulse({ bot, groupChatId }) {
  const template = pickPulseTemplate();
  const durationMinutes = pickDurationMinutes();
  const now = Date.now();
  const expiresAt = now + durationMinutes * 60 * 1000;

  const insert = db.prepare(
    `INSERT INTO pulses (pulse_type, pulse_text, rarity, created_at, expires_at, active, chat_id)
     VALUES (?, ?, ?, ?, ?, 1, ?)`
  );
  const result = insert.run(template.type, template.text, template.rarity, now, expiresAt, groupChatId);
  const pulseId = result.lastInsertRowid;

  const keyboard = {
    inline_keyboard: [
      template.buttons.map((b) => ({
        text: b.label,
        callback_data: `pulse:${pulseId}:${b.action}`,
      })),
    ],
  };

  const rarityPrefix = template.rarity === "rare" ? "⚠ RARE PULSE DETECTED" : "⚠ PULSE DETECTED";

  try {
    const sent = await bot.telegram.sendMessage(groupChatId, `${rarityPrefix}\n"${template.text}"`, {
      reply_markup: keyboard,
    });
    db.prepare("UPDATE pulses SET message_id = ? WHERE pulse_id = ?").run(sent.message_id, pulseId);
  } catch (err) {
    console.error("[firePulse] failed to send message:", err.message);
  }

  return pulseId;
}
