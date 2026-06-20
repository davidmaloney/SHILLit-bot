import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "data", "shillit-bot.db");

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY,
    username TEXT,
    title TEXT NOT NULL DEFAULT 'Lurker',
    conviction_score INTEGER NOT NULL DEFAULT 0,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    believer_count INTEGER NOT NULL DEFAULT 0,
    current_role TEXT NOT NULL DEFAULT 'member',
    role_since INTEGER,
    streak_count INTEGER NOT NULL DEFAULT 0,
    last_streak_day TEXT
  );

  CREATE TABLE IF NOT EXISTS pulses (
    pulse_id INTEGER PRIMARY KEY AUTOINCREMENT,
    pulse_type TEXT NOT NULL,
    pulse_text TEXT NOT NULL,
    rarity TEXT NOT NULL DEFAULT 'common',
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    message_id INTEGER,
    chat_id INTEGER
  );

  CREATE TABLE IF NOT EXISTS believers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    pulse_id INTEGER NOT NULL,
    interaction_type TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    UNIQUE(user_id, pulse_id)
  );

  CREATE TABLE IF NOT EXISTS titles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title_name TEXT NOT NULL UNIQUE,
    threshold INTEGER NOT NULL,
    role_unlock TEXT
  );

  CREATE TABLE IF NOT EXISTS raid_cards (
    card_id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    message_id INTEGER,
    posted_by INTEGER,
    posted_by_username TEXT,
    url TEXT NOT NULL,
    post_title TEXT, -- no longer populated; X-scrape preview was removed (unreliable)
    post_description TEXT, -- no longer populated; X-scrape preview was removed (unreliable)
    comment_text TEXT NOT NULL,
    stage TEXT NOT NULL DEFAULT 'voting',
    vote_count INTEGER NOT NULL DEFAULT 0,
    raid_count INTEGER NOT NULL DEFAULT 0,
    raid_target INTEGER NOT NULL DEFAULT 10,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    has_image INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS card_votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    timestamp INTEGER NOT NULL,
    UNIQUE(card_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS raid_joins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    username TEXT,
    timestamp INTEGER NOT NULL,
    UNIQUE(card_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_believers_user ON believers(user_id);
  CREATE INDEX IF NOT EXISTS idx_believers_pulse ON believers(pulse_id);
  CREATE INDEX IF NOT EXISTS idx_pulses_active ON pulses(active);
  CREATE INDEX IF NOT EXISTS idx_votes_card ON card_votes(card_id);
  CREATE INDEX IF NOT EXISTS idx_raidjoins_card ON raid_joins(card_id);
  CREATE INDEX IF NOT EXISTS idx_raidcards_stage ON raid_cards(stage);
`);

// Seed title thresholds if empty
const titleCount = db.prepare("SELECT COUNT(*) AS c FROM titles").get().c;
if (titleCount === 0) {
  const insert = db.prepare(
    "INSERT INTO titles (title_name, threshold, role_unlock) VALUES (?, ?, ?)"
  );
  const seed = db.transaction((rows) => {
    for (const row of rows) insert.run(row.title, row.threshold, row.role);
  });
  seed([
    { title: "Lurker", threshold: 0, role: null },
    { title: "Shill Initiate", threshold: 5, role: null },
    { title: "Bag Holder", threshold: 15, role: null },
    { title: "Diamond Hand", threshold: 35, role: "moderator" },
    { title: "Signal Reader", threshold: 60, role: "moderator" },
    { title: "Conviction Holder", threshold: 100, role: "admin" },
    { title: "Council of Shillers", threshold: 160, role: "admin" },
  ]);
}

// Migration for databases created before has_image existed.
// CREATE TABLE IF NOT EXISTS does not add new columns to an existing
// table, so this runs every startup but is a no-op once the column
// is present.
try {
  const columns = db.prepare("PRAGMA table_info(raid_cards)").all();
  const hasImageColumn = columns.some((c) => c.name === "has_image");
  if (!hasImageColumn) {
    db.exec("ALTER TABLE raid_cards ADD COLUMN has_image INTEGER NOT NULL DEFAULT 0");
  }
} catch (err) {
  console.error("[db] migration check failed:", err.message);
}

export function getSetting(key) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : null;
}

export function setSetting(key, value) {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

export default db;
