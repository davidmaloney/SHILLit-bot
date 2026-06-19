# Shillit Bot

A combined Telegram bot for the shillit.fun community. Three systems in one:

1. **Signal Network** — rare, unpredictable "Pulses" appear in the group.
   Interacting builds a hidden "Conviction Score" that quietly unlocks a
   title hierarchy and, eventually, real moderator/admin status in the bot.
2. **Welcome** — a short, slightly different greeting for new members.
3. **Raid System** — post any link in the chat and the bot turns it into a
   rated preview card. Once it gets enough community ratings, it unlocks
   into a live raid box with a progress bar people can join.

No grind, no visible XP bars, no spam. Designed to feel alive, not noisy.

---

## Title hierarchy

Lurker → Shill Initiate → Bag Holder → Diamond Hand → Signal Reader →
Conviction Holder → Council of Shillers

Diamond Hand and Signal Reader unlock moderator status in the bot.
Conviction Holder and Council of Shillers unlock admin status in the bot.
Inactive moderators/admins automatically lose that status after a
configurable period.

**Note:** these are bot-level permissions only (access to certain bot
commands) — not real Telegram group admin permissions.

---

## Requirements

- Docker and Docker Compose installed on your server
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- The bot added to your shillit Telegram group as an **admin** (it needs
  permission to send messages, edit messages, and use inline buttons)

---

## Setup

### 1. Create your bot

Message [@BotFather](https://t.me/BotFather) on Telegram:

