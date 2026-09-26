import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const STARTING_BALANCE = 250;
const DAILY_REWARD = 100;
const DAILY_COOLDOWN = 86_400;
const WORK_COOLDOWN = 3_600;

export class EconomyStore {
  constructor(databasePath = "data/economy.sqlite3") {
    const resolvedPath = resolve(databasePath);
    mkdirSync(dirname(resolvedPath), { recursive: true });
    this.db = new DatabaseSync(resolvedPath, { readBigInts: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.initialize();
  }

  initialize() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS economy_users (
        guild_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
        last_daily INTEGER,
        PRIMARY KEY (guild_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS economy_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id INTEGER NOT NULL,
        from_user_id INTEGER,
        to_user_id INTEGER,
        amount INTEGER NOT NULL CHECK (amount > 0),
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS work_cooldowns (
        guild_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        last_work INTEGER NOT NULL,
        PRIMARY KEY (guild_id, user_id)
      );
    `);

    const columns = this.db
      .prepare("PRAGMA table_info(economy_users)")
      .all()
      .map((column) => column.name);
    if (!columns.includes("bank_balance")) {
      this.db.exec(
        "ALTER TABLE economy_users ADD COLUMN bank_balance INTEGER NOT NULL DEFAULT 0 CHECK (bank_balance >= 0)",
      );
    }
  }

  now() {
    return Math.floor(Date.now() / 1000);
  }

  transaction(callback) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  ensureUser(guildId, userId) {
    this.db
      .prepare(
        `INSERT INTO economy_users (guild_id, user_id, balance, bank_balance)
         VALUES (?, ?, ?, 0)
         ON CONFLICT (guild_id, user_id) DO NOTHING`,
      )
      .run(guildId, userId, STARTING_BALANCE);
  }

  account(guildId, userId) {
    this.ensureUser(guildId, userId);
    const row = this.db
      .prepare(
        `SELECT guild_id, user_id, balance, bank_balance, last_daily
         FROM economy_users
         WHERE guild_id = ? AND user_id = ?`,
      )
      .get(guildId, userId);
    if (!row) throw new Error("Economy account could not be initialized");
    return {
      guildId: String(row.guild_id),
      userId: String(row.user_id),
      balance: Number(row.balance),
      bankBalance: Number(row.bank_balance ?? 0),
      total: Number(row.balance) + Number(row.bank_balance ?? 0),
      lastDaily: row.last_daily == null ? null : Number(row.last_daily),
    };
  }

  recordTransaction(guildId, fromUserId, toUserId, amount, reason) {
    this.db
      .prepare(
        `INSERT INTO economy_transactions
         (guild_id, from_user_id, to_user_id, amount, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(guildId, fromUserId, toUserId, amount, reason, this.now());
  }

  daily(guildId, userId) {
    return this.transaction(() => {
      this.ensureUser(guildId, userId);
      const current = this.account(guildId, userId);
      const now = this.now();
      if (current.lastDaily != null && now - current.lastDaily < DAILY_COOLDOWN) {
        return {
          claimed: false,
          remaining: DAILY_COOLDOWN - (now - current.lastDaily),
          account: current,
        };
      }
      this.db
        .prepare(
          `UPDATE economy_users
           SET balance = balance + ?, last_daily = ?
           WHERE guild_id = ? AND user_id = ?`,
        )
        .run(DAILY_REWARD, now, guildId, userId);
      this.recordTransaction(guildId, null, userId, DAILY_REWARD, "daily reward");
      return {
        claimed: true,
        amount: DAILY_REWARD,
        account: this.account(guildId, userId),
      };
    });
  }

  work(guildId, userId) {
    return this.transaction(() => {
      this.ensureUser(guildId, userId);
      const cooldown = this.db
        .prepare(
          "SELECT last_work FROM work_cooldowns WHERE guild_id = ? AND user_id = ?",
        )
        .get(guildId, userId);
      const now = this.now();
      if (cooldown && now - Number(cooldown.last_work) < WORK_COOLDOWN) {
        return {
          worked: false,
          remaining: WORK_COOLDOWN - (now - Number(cooldown.last_work)),
          account: this.account(guildId, userId),
        };
      }

      const amount = 100 + Math.floor(Math.random() * 401);
      this.db
        .prepare(
          `INSERT INTO work_cooldowns (guild_id, user_id, last_work)
           VALUES (?, ?, ?)
           ON CONFLICT (guild_id, user_id)
           DO UPDATE SET last_work = excluded.last_work`,
        )
        .run(guildId, userId, now);
      this.db
        .prepare(
          "UPDATE economy_users SET balance = balance + ? WHERE guild_id = ? AND user_id = ?",
        )
        .run(amount, guildId, userId);
      this.recordTransaction(guildId, null, userId, amount, "work reward");
      return {
        worked: true,
        amount,
        account: this.account(guildId, userId),
      };
    });
  }

  deposit(guildId, userId, amount) {
    return this.transaction(() => {
      this.ensureUser(guildId, userId);
      const result = this.db
        .prepare(
          `UPDATE economy_users
           SET balance = balance - ?, bank_balance = bank_balance + ?
           WHERE guild_id = ? AND user_id = ? AND balance >= ?`,
        )
        .run(amount, amount, guildId, userId, amount);
      if (Number(result.changes) !== 1) return { success: false, account: this.account(guildId, userId) };
      this.recordTransaction(guildId, userId, null, amount, "deposit");
      return { success: true, account: this.account(guildId, userId) };
    });
  }

  withdraw(guildId, userId, amount) {
    return this.transaction(() => {
      this.ensureUser(guildId, userId);
      const result = this.db
        .prepare(
          `UPDATE economy_users
           SET balance = balance + ?, bank_balance = bank_balance - ?
           WHERE guild_id = ? AND user_id = ? AND bank_balance >= ?`,
        )
        .run(amount, amount, guildId, userId, amount);
      if (Number(result.changes) !== 1) return { success: false, account: this.account(guildId, userId) };
      this.recordTransaction(guildId, null, userId, amount, "withdraw");
      return { success: true, account: this.account(guildId, userId) };
    });
  }

  transfer(guildId, fromUserId, toUserId, amount) {
    return this.transaction(() => {
      this.ensureUser(guildId, fromUserId);
      this.ensureUser(guildId, toUserId);
      const result = this.db
        .prepare(
          `UPDATE economy_users SET balance = balance - ?
           WHERE guild_id = ? AND user_id = ? AND balance >= ?`,
        )
        .run(amount, guildId, fromUserId, amount);
      if (Number(result.changes) !== 1) {
        return { success: false, account: this.account(guildId, fromUserId) };
      }
      this.db
        .prepare(
          "UPDATE economy_users SET balance = balance + ? WHERE guild_id = ? AND user_id = ?",
        )
        .run(amount, guildId, toUserId);
      this.recordTransaction(guildId, fromUserId, toUserId, amount, "member transfer");
      return { success: true, account: this.account(guildId, fromUserId) };
    });
  }

  placeBet(guildId, userId, amount, reason) {
    return this.transaction(() => {
      this.ensureUser(guildId, userId);
      const result = this.db
        .prepare(
          `UPDATE economy_users SET balance = balance - ?
           WHERE guild_id = ? AND user_id = ? AND balance >= ?`,
        )
        .run(amount, guildId, userId, amount);
      if (Number(result.changes) !== 1) return { success: false, account: this.account(guildId, userId) };
      this.recordTransaction(guildId, userId, null, amount, reason);
      return { success: true, account: this.account(guildId, userId) };
    });
  }

  payout(guildId, userId, amount, reason) {
    return this.transaction(() => {
      this.ensureUser(guildId, userId);
      this.db
        .prepare(
          "UPDATE economy_users SET balance = balance + ? WHERE guild_id = ? AND user_id = ?",
        )
        .run(amount, guildId, userId);
      this.recordTransaction(guildId, null, userId, amount, reason);
      return this.account(guildId, userId);
    });
  }

  coinflip(guildId, userId, amount, choice) {
    return this.transaction(() => {
      this.ensureUser(guildId, userId);
      const debited = this.db
        .prepare(
          `UPDATE economy_users SET balance = balance - ?
           WHERE guild_id = ? AND user_id = ? AND balance >= ?`,
        )
        .run(amount, guildId, userId, amount);
      if (Number(debited.changes) !== 1) return { success: false, account: this.account(guildId, userId) };
      this.recordTransaction(guildId, userId, null, amount, "coinflip bet");
      const result = Math.random() < 0.5 ? "heads" : "tails";
      const won = result === choice;
      const winnings = won ? amount * 2 : 0;
      if (winnings > 0) {
        this.db
          .prepare(
            "UPDATE economy_users SET balance = balance + ? WHERE guild_id = ? AND user_id = ?",
          )
          .run(winnings, guildId, userId);
        this.recordTransaction(guildId, null, userId, winnings, "coinflip payout");
      }
      return {
        success: true,
        result,
        won,
        winnings,
        account: this.account(guildId, userId),
      };
    });
  }

  leaderboard(guildId, limit = 10) {
    return this.db
      .prepare(
        `SELECT user_id, balance, bank_balance, balance + bank_balance AS total
         FROM economy_users
         WHERE guild_id = ?
         ORDER BY total DESC, user_id ASC
         LIMIT ?`,
      )
      .all(guildId, limit)
      .map((row) => ({
        userId: String(row.user_id),
        balance: Number(row.balance),
        bankBalance: Number(row.bank_balance ?? 0),
        total: Number(row.total),
      }));
  }
}

export function formatAmount(amount) {
  return `${Number(amount).toLocaleString("en-US")} credits`;
}

export function formatDuration(seconds) {
  const safe = Math.max(0, Math.ceil(Number(seconds)));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const remainingSeconds = safe % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${remainingSeconds}s`;
  return `${remainingSeconds}s`;
}