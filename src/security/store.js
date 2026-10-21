import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const DEFAULT_SECURITY_CONFIG = Object.freeze({
  enabled: false,
  antiNuke: true,
  antiRaid: true,
  antiSpam: true,
  antiWebhook: true,
  antiMaliciousBot: true,
  roleProtection: true,
  channelProtection: true,
  permissionMonitoring: true,
  nukeLimit: 4,
  nukeWindowSeconds: 20,
  raidJoinLimit: 10,
  raidWindowSeconds: 20,
  spamMessageLimit: 7,
  spamWindowSeconds: 10,
  logChannelId: null,
  verificationRoleId: null,
  lockdownSnapshot: null,
  channelLockSnapshots: {},
});

export class SecurityStore {
  constructor(databasePath = process.env.ECONOMY_DATABASE_PATH || "data/economy.sqlite3") {
    const resolvedPath = resolve(databasePath);
    mkdirSync(dirname(resolvedPath), { recursive: true });
    this.db = new DatabaseSync(resolvedPath, { readBigInts: true });
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS security_guild_config (
        guild_id TEXT PRIMARY KEY,
        config_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS security_allowlist (
        guild_id TEXT NOT NULL,
        target_type TEXT NOT NULL CHECK (target_type IN ('user', 'role', 'bot')),
        target_id TEXT NOT NULL,
        added_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, target_type, target_id)
      );

      CREATE TABLE IF NOT EXISTS security_protected (
        guild_id TEXT NOT NULL,
        target_type TEXT NOT NULL CHECK (target_type IN ('role', 'channel')),
        target_id TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        added_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, target_type, target_id)
      );

      CREATE TABLE IF NOT EXISTS security_incidents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        category TEXT NOT NULL,
        severity TEXT NOT NULL,
        actor_id TEXT,
        target_id TEXT,
        details TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS security_incidents_by_guild_time
        ON security_incidents (guild_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS security_backups (
        backup_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL
      );
    `);
  }

  now() {
    return Math.floor(Date.now() / 1000);
  }

  getConfig(guildId) {
    const row = this.db
      .prepare("SELECT config_json FROM security_guild_config WHERE guild_id = ?")
      .get(String(guildId));
    if (!row) return { ...DEFAULT_SECURITY_CONFIG };
    try {
      return { ...DEFAULT_SECURITY_CONFIG, ...JSON.parse(row.config_json) };
    } catch {
      throw new Error("The saved security configuration is invalid JSON.");
    }
  }

  saveConfig(guildId, config) {
    const normalized = { ...DEFAULT_SECURITY_CONFIG, ...config };
    this.db
      .prepare(
        `INSERT INTO security_guild_config (guild_id, config_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT (guild_id) DO UPDATE SET
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`,
      )
      .run(String(guildId), JSON.stringify(normalized), this.now());
    return normalized;
  }

  addAllowlist(guildId, type, targetId, addedBy) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO security_allowlist
         (guild_id, target_type, target_id, added_by, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(String(guildId), type, String(targetId), String(addedBy), this.now());
  }

  removeAllowlist(guildId, type, targetId) {
    return Number(
      this.db
        .prepare(
          "DELETE FROM security_allowlist WHERE guild_id = ? AND target_type = ? AND target_id = ?",
        )
        .run(String(guildId), type, String(targetId)).changes,
    ) > 0;
  }

  listAllowlist(guildId) {
    return this.db
      .prepare(
        `SELECT target_type AS type, target_id AS targetId, added_by AS addedBy, created_at AS createdAt
         FROM security_allowlist WHERE guild_id = ? ORDER BY target_type, created_at`,
      )
      .all(String(guildId))
      .map((row) => ({ ...row, createdAt: Number(row.createdAt) }));
  }

  isTrusted(guildId, userId, member = null, userIsBot = false) {
    if (!userId) return false;
    if (member?.guild?.ownerId === String(userId)) return true;
    const rows = this.db
      .prepare(
        "SELECT target_type, target_id FROM security_allowlist WHERE guild_id = ?",
      )
      .all(String(guildId));
    for (const row of rows) {
      if (
        (row.target_type === "user" || (userIsBot && row.target_type === "bot")) &&
        row.target_id === String(userId)
      ) {
        return true;
      }
      if (row.target_type === "role" && member?.roles?.cache?.has(row.target_id)) {
        return true;
      }
    }
    return false;
  }

  protect(guildId, type, targetId, snapshot, addedBy) {
    this.db
      .prepare(
        `INSERT INTO security_protected
         (guild_id, target_type, target_id, snapshot_json, added_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (guild_id, target_type, target_id) DO UPDATE SET
           snapshot_json = excluded.snapshot_json,
           added_by = excluded.added_by,
           created_at = excluded.created_at`,
      )
      .run(
        String(guildId),
        type,
        String(targetId),
        JSON.stringify(snapshot),
        String(addedBy),
        this.now(),
      );
  }

  unprotect(guildId, type, targetId) {
    return Number(
      this.db
        .prepare(
          "DELETE FROM security_protected WHERE guild_id = ? AND target_type = ? AND target_id = ?",
        )
        .run(String(guildId), type, String(targetId)).changes,
    ) > 0;
  }

  getProtected(guildId, type, targetId) {
    const row = this.db
      .prepare(
        `SELECT target_id AS targetId, snapshot_json AS snapshotJson
         FROM security_protected WHERE guild_id = ? AND target_type = ? AND target_id = ?`,
      )
      .get(String(guildId), type, String(targetId));
    return row ? { targetId: row.targetId, snapshot: JSON.parse(row.snapshotJson) } : null;
  }

  listProtected(guildId, type = null) {
    const rows = type
      ? this.db
          .prepare(
            `SELECT target_type AS type, target_id AS targetId, snapshot_json AS snapshotJson
             FROM security_protected WHERE guild_id = ? AND target_type = ? ORDER BY created_at`,
          )
          .all(String(guildId), type)
      : this.db
          .prepare(
            `SELECT target_type AS type, target_id AS targetId, snapshot_json AS snapshotJson
             FROM security_protected WHERE guild_id = ? ORDER BY target_type, created_at`,
          )
          .all(String(guildId));
    return rows.map((row) => ({
      type: row.type,
      targetId: row.targetId,
      snapshot: JSON.parse(row.snapshotJson),
    }));
  }

  updateProtectedId(guildId, type, oldId, newId, snapshot) {
    this.db
      .prepare(
        "DELETE FROM security_protected WHERE guild_id = ? AND target_type = ? AND target_id = ?",
      )
      .run(String(guildId), type, String(oldId));
    this.protect(guildId, type, newId, snapshot, "automatic-restore");
  }

  recordIncident({ guildId, category, severity = "medium", actorId = null, targetId = null, details }) {
    const result = this.db
      .prepare(
        `INSERT INTO security_incidents
         (guild_id, category, severity, actor_id, target_id, details, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        String(guildId),
        String(category).slice(0, 80),
        String(severity).slice(0, 20),
        actorId == null ? null : String(actorId),
        targetId == null ? null : String(targetId),
        String(details).slice(0, 3500),
        this.now(),
      );
    return String(result.lastInsertRowid);
  }

  listIncidents(guildId, limit = 10) {
    const boundedLimit = Math.max(1, Math.min(25, Math.floor(Number(limit) || 10)));
    return this.db
      .prepare(
        `SELECT id, category, severity, actor_id AS actorId, target_id AS targetId,
                details, created_at AS createdAt
         FROM security_incidents WHERE guild_id = ?
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(String(guildId), boundedLimit)
      .map((row) => ({ ...row, id: String(row.id), createdAt: Number(row.createdAt) }));
  }

  incidentCount(guildId, sinceSeconds = 86_400) {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM security_incidents WHERE guild_id = ? AND created_at >= ?",
      )
      .get(String(guildId), this.now() - sinceSeconds);
    return Number(row?.count ?? 0);
  }

  createBackup(guildId, createdBy, snapshot) {
    const snapshotJson = JSON.stringify(snapshot);
    if (Buffer.byteLength(snapshotJson, "utf8") > 2_000_000) {
      throw new Error("This server snapshot is too large to store safely (maximum 2 MB).");
    }
    const backupId = randomUUID().slice(0, 12);
    const createdAt = this.now();
    this.db
      .prepare(
        `INSERT INTO security_backups (backup_id, guild_id, created_by, created_at, snapshot_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(backupId, String(guildId), String(createdBy), createdAt, snapshotJson);
    return { backupId, createdAt };
  }

  getBackup(guildId, backupId) {
    const row = this.db
      .prepare(
        `SELECT backup_id AS backupId, created_by AS createdBy, created_at AS createdAt,
                snapshot_json AS snapshotJson
         FROM security_backups WHERE guild_id = ? AND backup_id = ?`,
      )
      .get(String(guildId), String(backupId));
    if (!row) return null;
    return {
      backupId: row.backupId,
      createdBy: row.createdBy,
      createdAt: Number(row.createdAt),
      snapshot: JSON.parse(row.snapshotJson),
    };
  }

  close() {
    this.db.close();
  }
}