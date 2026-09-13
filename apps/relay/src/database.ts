import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type DB = Database.Database;

export function createDatabase(filename: string): DB {
  if (filename !== ":memory:") fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS admins (
      id TEXT PRIMARY KEY, username TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS passkeys (
      id TEXT PRIMARY KEY, admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
      public_key BLOB NOT NULL, counter INTEGER NOT NULL DEFAULT 0, transports TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS challenges (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, challenge TEXT NOT NULL, admin_id TEXT,
      action_digest TEXT, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recovery_codes (
      id TEXT PRIMARY KEY, admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL, used_at INTEGER, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS elevations (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE, action_digest TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, public_key TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS pairings (
      id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS favorites (
      admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE, device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      bundle_id TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY(admin_id, device_id, bundle_id)
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY, admin_id TEXT, device_id TEXT, command_id TEXT,
      action TEXT NOT NULL, target TEXT, result TEXT NOT NULL, error_code TEXT,
      client_label TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS executed_commands (
      command_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_events(created_at DESC);
  `);
  return db;
}

export function cleanupExpired(db: DB, auditRetentionDays: number, now = Date.now()) {
  db.prepare("DELETE FROM challenges WHERE expires_at < ?").run(now);
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now);
  db.prepare("DELETE FROM elevations WHERE expires_at < ? OR used_at IS NOT NULL").run(now);
  db.prepare("DELETE FROM pairings WHERE expires_at < ? OR used_at IS NOT NULL").run(now);
  db.prepare("DELETE FROM executed_commands WHERE expires_at < ?").run(now);
  db.prepare("DELETE FROM audit_events WHERE created_at < ?").run(now - auditRetentionDays * 86_400_000);
}
