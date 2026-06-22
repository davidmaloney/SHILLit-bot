import db from "./db.js";
import { ALPHA_PULSE_TYPE, ALPHA_PULSE_BONUS } from "./pulses.js";

const ROLE_DECAY_DAYS = parseInt(process.env.ROLE_DECAY_DAYS || "30", 10);
const ROLE_RANK = { member: 0, moderator: 1, admin: 2, founder: 3 };

export function getOrCreateUser(userId, username) {
  const now = Date.now();
  const existing = db.prepare("SELECT * FROM users WHERE user_id = ?").get(userId);
  if (existing) {
    db.prepare("UPDATE users SET username = ?, last_seen = ? WHERE user_id = ?").run(
      username || existing.username,
      now,
      userId
    );
    return db.prepare("SELECT * FROM users WHERE user_id = ?").get(userId);
  }
  db.prepare(
    "INSERT INTO users (user_id, username, title, conviction_score, first_seen, last_seen) VALUES (?, ?, 'Lurker', 0, ?, ?)"
  ).run(userId, username || null, now, now);
  return db.prepare("SELECT * FROM users WHERE user_id = ?").get(userId);
}

export function getAllTitles() {
  return db.prepare("SELECT * FROM titles ORDER BY threshold ASC").all();
}

function titleForScore(score) {
  const titles = getAllTitles();
  let current = titles[0];
  for (const t of titles) {
    if (score >= t.threshold) current = t;
  }
  return current;
}

export function userMeetsTitleRank(userId, requiredTitleName) {
  const user = db.prepare("SELECT * FROM users WHERE user_id = ?").get(userId);
  if (!user) return false;
  const titles = getAllTitles();
  const userThreshold = titles.find((t) => t.title_name === user.title)?.threshold ?? 0;
  const requiredThreshold =
    titles.find((t) => t.title_name === requiredTitleName)?.threshold ?? Infinity;
  return userThreshold >= requiredThreshold;
}

export function awardConviction(userId, username, amount) {
  const user = getOrCreateUser(userId, username);
  const now = Date.now();

  const newScore = user.conviction_score + amount;
  const oldTitleRow = titleForScore(user.conviction_score);
  const newTitleRow = titleForScore(newScore);

  db.prepare(
    "UPDATE users SET conviction_score = ?, title = ?, last_seen = ? WHERE user_id = ?"
  ).run(newScore, newTitleRow.title_name, now, userId);

  let roleChanged = false;
  let newRole = user.current_role;

  if (
    newTitleRow.role_unlock &&
    (ROLE_RANK[newTitleRow.role_unlock] || 0) > (ROLE_RANK[user.current_role] || 0)
  ) {
    newRole = newTitleRow.role_unlock;
    roleChanged = true;
    db.prepare("UPDATE users SET current_role = ?, role_since = ? WHERE user_id = ?").run(
      newRole,
      now,
      userId
    );
  }

  const leveledUp = newTitleRow.title_name !== oldTitleRow.title_name;

  return {
    user: db.prepare("SELECT * FROM users WHERE user_id = ?").get(userId),
    leveledUp,
    newTitle: leveledUp ? newTitleRow.title_name : null,
    roleChanged,
    newRole: roleChanged ? newRole : null,
  };
}

// Pulse-specific interaction recording (kept separate table: believers)
export function recordInteraction(userId, username, pulseId, interactionType) {
  const now = Date.now();
  let inserted = false;
  try {
    db.prepare(
      "INSERT INTO believers (user_id, pulse_id, interaction_type, timestamp) VALUES (?, ?, ?, ?)"
    ).run(userId, pulseId, interactionType, now);
    inserted = true;
  } catch {
    inserted = false;
  }

  if (!inserted) {
    return { alreadyInteracted: true, user: getOrCreateUser(userId, username) };
  }

  const believerCountRow = db
    .prepare("SELECT COUNT(*) AS c FROM believers WHERE user_id = ?")
    .get(userId);
  db.prepare("UPDATE users SET believer_count = ? WHERE user_id = ?").run(
    believerCountRow.c,
    userId
  );

  const baseGain = 3 + Math.floor(Math.random() * 4); // 3-6 points

  // Alpha Pulses award bonus Conviction on top of the normal gain. The
  // pulse's type is read straight from the pulses table so this stays
  // self-contained — no extra data needs threading through the handler.
  const pulseRow = db.prepare("SELECT pulse_type FROM pulses WHERE pulse_id = ?").get(pulseId);
  const isAlpha = pulseRow && pulseRow.pulse_type === ALPHA_PULSE_TYPE;
  const gain = isAlpha ? baseGain + ALPHA_PULSE_BONUS : baseGain;

  const result = awardConviction(userId, username, gain);
  return { alreadyInteracted: false, gain, isAlpha, ...result };
}

export function getProfile(userId) {
  return db.prepare("SELECT * FROM users WHERE user_id = ?").get(userId);
}

export function getUsersForDecayCheck() {
  const cutoff = Date.now() - ROLE_DECAY_DAYS * 24 * 60 * 60 * 1000;
  return db
    .prepare(
      "SELECT * FROM users WHERE current_role != 'member' AND current_role != 'founder' AND last_seen < ? AND role_since IS NOT NULL AND role_since < ?"
    )
    .all(cutoff, cutoff);
}

export function decayRole(userId) {
  const user = db.prepare("SELECT * FROM users WHERE user_id = ?").get(userId);
  if (!user) return;
  db.prepare(
    "UPDATE users SET current_role = 'member', title = 'Bag Holder', conviction_score = 14, role_since = NULL WHERE user_id = ?"
  ).run(userId);
}

export function setFounder(userId, username) {
  const user = getOrCreateUser(userId, username);
  if (user.current_role !== "founder") {
    db.prepare("UPDATE users SET current_role = 'founder' WHERE user_id = ?").run(userId);
  }
}

export function manuallySetRole(userId, role) {
  const user = db.prepare("SELECT * FROM users WHERE user_id = ?").get(userId);
  if (!user) return false;
  db.prepare("UPDATE users SET current_role = ?, role_since = ? WHERE user_id = ?").run(
    role,
    Date.now(),
    userId
  );
  return true;
}

export function getTopUsers(limit = 10) {
  return db
    .prepare("SELECT * FROM users ORDER BY conviction_score DESC LIMIT ?")
    .all(limit);
}

export function getRandomActiveUser() {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const users = db
    .prepare("SELECT * FROM users WHERE last_seen > ? AND conviction_score > 0")
    .all(cutoff);
  if (users.length === 0) return null;
  return users[Math.floor(Math.random() * users.length)];
}

export function getAdminCandidates() {
  const titles = getAllTitles();
  const candidates = [];
  const users = db
    .prepare("SELECT * FROM users WHERE current_role = 'member' AND conviction_score > 0")
    .all();
  for (const user of users) {
    const titleRow = titles.find((t) => t.title_name === user.title);
    if (titleRow && titleRow.role_unlock) {
      candidates.push({ user, title: user.title, eligibleRole: titleRow.role_unlock });
    }
  }
  return candidates;
}
