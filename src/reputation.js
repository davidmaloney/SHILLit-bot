import db from "./db.js";

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
    `INSERT INTO users (user_id, username, title, conviction_score, first_seen, last_seen, believer_count, current_role)
     VALUES (?, ?, 'Lurker', 0, ?, ?, 0, 'member')`
  ).run(userId, username || null, now, now);
  return db.prepare("SELECT * FROM users WHERE user_id = ?").get(userId);
}

export function getAllTitles() {
  return db.prepare("SELECT * FROM titles ORDER BY threshold ASC").all();
}

function titleForScore(score) {
  const titles = getAllTitles();
  let result = titles[0];
  for (const t of titles) {
    if (score >= t.threshold) result = t;
  }
  return result;
}

// Title-rank index (0 = Lurker, higher = further up the hierarchy).
// Used to gate features by title tier rather than just bot role, since
// Diamond Hand and Signal Reader share the "moderator" role but are
// different tiers.
function titleRankIndex(titleName) {
  const titles = getAllTitles();
  const idx = titles.findIndex((t) => t.title_name === titleName);
  return idx === -1 ? 0 : idx;
}

export function userMeetsTitleRank(userId, requiredTitleName) {
  const user = db.prepare("SELECT * FROM users WHERE user_id = ?").get(userId);
  if (!user) return false;
  return titleRankIndex(user.title) >= titleRankIndex(requiredTitleName);
}

// Generic conviction award used by both Pulses and Raid/vote interactions.
// Returns { user, leveledUp, newTitle, roleChanged, newRole }
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

  const gain = 3 + Math.floor(Math.random() * 4); // 3-6 points
  const result = awardConviction(userId, username, gain);
  return { alreadyInteracted: false, gain, ...result };
}

export function getProfile(userId) {
  return db.prepare("SELECT * FROM users WHERE user_id = ?").get(userId);
}

export function getUsersForDecayCheck() {
  const cutoff = Date.now() - ROLE_DECAY_DAYS * 24 * 60 * 60 * 1000;
  return db
    .prepare(
      `SELECT * FROM users
       WHERE last_seen < ?
       AND (current_role IN ('moderator', 'admin')
            OR title IN ('Diamond Hand', 'Signal Reader', 'Conviction Holder', 'Council of Shillers'))`
    )
    .all(cutoff);
}

// Decaying a user drops both their bot role AND their conviction score
// down to just below the Diamond Hand threshold. Reducing the score
// itself (not just the title label) is necessary — awardConviction
// recalculates title from score on every interaction, so a title-only
// reset would be instantly undone the moment they're active again.
// They keep enough score to remain "Bag Holder" and can re-climb
// normally from there.
const DECAY_TARGET_TITLE = "Bag Holder";
const DECAY_TARGET_SCORE = 20; // safely inside Bag Holder's range (15-34)

export function decayRole(userId) {
  const user = db.prepare("SELECT * FROM users WHERE user_id = ?").get(userId);
  if (!user) return;
  const newScore = Math.min(user.conviction_score, DECAY_TARGET_SCORE);
  db.prepare(
    "UPDATE users SET current_role = 'member', role_since = NULL, title = ?, conviction_score = ? WHERE user_id = ?"
  ).run(DECAY_TARGET_TITLE, newScore, userId);
}

export function setFounder(userId, username) {
  getOrCreateUser(userId, username);
  db.prepare("UPDATE users SET current_role = 'founder' WHERE user_id = ?").run(userId);
}

export function manuallySetRole(userId, role) {
  const result = db
    .prepare("UPDATE users SET current_role = ?, role_since = ? WHERE user_id = ?")
    .run(role, Date.now(), userId);
  return result.changes > 0;
}

export function getTopUsers(limit = 10) {
  return db
    .prepare("SELECT * FROM users ORDER BY conviction_score DESC LIMIT ?")
    .all(limit);
}

export function getRandomActiveUser() {
  // "Active" = seen in the last 14 days, has at least Shill Initiate title
  // so brand new lurkers aren't spotlighted with nothing to show.
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  return db
    .prepare(
      `SELECT * FROM users WHERE last_seen >= ? AND title != 'Lurker' ORDER BY RANDOM() LIMIT 1`
    )
    .get(cutoff);
}

export function getAdminCandidates() {
  const users = db.prepare("SELECT * FROM users").all();
  const candidates = [];
  for (const u of users) {
    const eligible = titleForScore(u.conviction_score);
    if (
      eligible.role_unlock &&
      (ROLE_RANK[eligible.role_unlock] || 0) > (ROLE_RANK[u.current_role] || 0)
    ) {
      candidates.push({ user: u, eligibleRole: eligible.role_unlock, title: eligible.title_name });
    }
  }
  return candidates;
}
