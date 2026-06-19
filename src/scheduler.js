import db from "./db.js";
import { pickPulseTemplate, pickDurationMinutes } from "./pulses.js";
import { getUsersForDecayCheck, decayRole } from "./reputation.js";

const MIN_INTERVAL_MIN = parseInt(process.env.PULSE_MIN_INTERVAL_MINUTES || "240", 10);
const MAX_INTERVAL_MIN = parseInt(process.env.PULSE_MAX_INTERVAL_MINUTES || "1440", 10);
const FIRE_CHANCE = parseFloat(process.env.PULSE_FIRE_CHANCE || "0.4");

const CHECK_INTERVAL_MS = 15 * 60 * 1000;
const EXPIRY_SWEEP_MS = 60 * 1000;
const DECAY_CHECK_MS = 6 * 60 * 60 * 1000;

let lastPulseAt = 0;

function minutesSinceLastPulse() {
  if (!lastPulseAt) return Infinity;
  return (Date.now() - lastPulseAt) / 60000;
}

export function startScheduler({ bot, groupChatId, founderUserId }) {
  setInterval(async () => {
    try {
      const elapsed = minutesSinceLastPulse();
      if (elapsed < MIN_INTERVAL_MIN) return;

      const mustFire = elapsed >= MAX_INTERVAL_MIN;
      const roll = Math.random();

      if (mustFire || roll < FIRE_CHANCE) {
        await firePulse({ bot, groupChatId });
        lastPulseAt = Date.now();
      }
    } catch (err) {
      console.error("[scheduler] pulse check failed:", err.message);
    }
  }, CHECK_INTERVAL_MS);

  setInterval(() => {
    try {
      const now = Date.now();
      db.prepare("UPDATE pulses SET active = 0 WHERE active = 1 AND expires_at <= ?").run(now);
    } catch (err) {
      console.error("[scheduler] expiry sweep failed:", err.message);
    }
  }, EXPIRY_SWEEP_MS);

  setInterval(async () => {
    try {
      const decaying = getUsersForDecayCheck();
      for (const u of decaying) {
        decayRole(u.user_id);
        if (founderUserId) {
          try {
            await bot.telegram.sendMessage(
              founderUserId,
              `⚠ ROLE DECAY\n@${u.username || u.user_id} has lost ${u.current_role} status due to inactivity.`
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
