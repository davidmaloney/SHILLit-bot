# Shillit Bot

A combined Telegram bot for the shillit.fun community. Three systems in one:

1. **Signal Network** — rare, unpredictable "Pulses" appear in the group.
   Interacting builds a hidden "Conviction Score" that quietly unlocks a
   title hierarchy and, eventually, real bot-level moderator/admin status.
2. **Welcome** — new members are silently added to the network the moment
   they join, plus a short greeting in chat.
3. **X Comment-Raid System** — Diamond Hand+ members can post an X link
   with their own comment in the same message. The bot shows the original
   post's preview alongside their comment, and the group votes on whether
   it's worth raiding. Multiple cards can race independently. Whichever
   hits the vote threshold first flips into a live raid box with a
   progress bar people can join.

No grind, no visible XP bars, no spam. Designed to feel alive, not noisy.

---

## Title hierarchy

Lurker → Shill Initiate → Bag Holder → Diamond Hand → Signal Reader →
Conviction Holder → Council of Shillers

- **Diamond Hand** and above can post comment-raid cards and remove any
  card (anti-spam moderation, earned through real activity)
- Diamond Hand and Signal Reader unlock bot-level moderator status
- Conviction Holder and Council of Shillers unlock bot-level admin status
- **Council of Shillers** (and the Founder) get a hidden command to change
  the fixed card image — never announced, only discovered
- Inactive moderators/admins automatically lose that status after a
  configurable period

**Note:** moderator/admin here means bot-command permissions only — not
real Telegram group admin permissions.

---

## Why there's no downvote button

Early in design we considered an up/down vote system, but it invites
people downvoting rivals' links out of competition rather than genuine
quality judgment — a common failure mode in any system with competing
posts. Instead:

- The card shows the *original post's preview* and the *poster's own
  comment text* directly, so people can judge quality without needing to
  click through to X first
- Comment-raid posting is gated behind Diamond Hand status, which
  filters out low-effort/spam posting by design
- Diamond Hand+ members can remove any card outright if it's bad faith
- Cards that never reach the vote threshold quietly expire on their own

No downvote needed, no gaming risk.

---

## Requirements

- Docker and Docker Compose installed on your server
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- The bot added to your shillit Telegram group as an **admin** (it needs
  permission to send messages, edit messages, delete messages, and use
  inline buttons)

---

## Setup

### 1. Create your bot

Message [@BotFather](https://t.me/BotFather) on Telegram:

