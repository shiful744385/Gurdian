import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const STARTING_BALANCE = 250n;
const DAILY_REWARD = 100;
const DAILY_COOLDOWN = 86_400;
const WORK_COOLDOWN = 3_600;
const EXISTING_USER_BONUS = 1_000_000_000_000n;
const EXISTING_USER_BONUS_MIGRATION = "existing-user-1-trillion-bonus-v1";

export class EconomyStore {
  constructor(databasePath = "data/economy.sqlite3") {
    const resolvedPath = resolve(databasePath);
    mkdirSync(dirname(resolvedPath), { recursive: true });
    this.db = new DatabaseSync(resolvedPath, { readBigInts: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.initialize();
    this.applyExistingUserBonus();
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

      CREATE TABLE IF NOT EXISTS economy_migrations (
        name TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
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

  applyExistingUserBonus() {
    const result = this.transaction(() => {
      const applied = this.db
        .prepare(
          "INSERT OR IGNORE INTO economy_migrations (name, applied_at) VALUES (?, ?)",
        )
        .run(EXISTING_USER_BONUS_MIGRATION, this.now());

      if (Number(applied.changes) !== 1) {
        return { applied: false, users: 0 };
      }

      const users = this.db
        .prepare("SELECT guild_id, user_id FROM economy_users")
        .all();
      this.db
        .prepare("UPDATE economy_users SET balance = balance + ?")
        .run(EXISTING_USER_BONUS);
      for (const user of users) {
        this.recordTransaction(
          user.guild_id,
          null,
          user.user_id,
          EXISTING_USER_BONUS,
          "one-time existing-user bonus",
        );
      }
      return { applied: true, users: users.length };
    });

    if (result.applied) {
      console.log(
        `Applied ${EXISTING_USER_BONUS.toString()}-coin bonus to ${result.users} existing users`,
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
      balance: BigInt(row.balance),
      bankBalance: BigInt(row.bank_balance ?? 0),
      total: BigInt(row.balance) + BigInt(row.bank_balance ?? 0),
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
      this.recordTransaction(guildId, null, userId, BigInt(DAILY_REWARD), "daily reward");
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

      const amount = BigInt(100 + Math.floor(Math.random() * 401));
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
    const value = BigInt(amount);
    return this.transaction(() => {
      this.ensureUser(guildId, userId);
      const result = this.db
        .prepare(
          `UPDATE economy_users
           SET balance = balance - ?, bank_balance = bank_balance + ?
           WHERE guild_id = ? AND user_id = ? AND balance >= ?`,
        )
        .run(value, value, guildId, userId, value);
      if (Number(result.changes) !== 1) return { success: false, account: this.account(guildId, userId) };
      this.recordTransaction(guildId, userId, null, value, "deposit");
      return { success: true, account: this.account(guildId, userId) };
    });
  }

  withdraw(guildId, userId, amount) {
    const value = BigInt(amount);
    return this.transaction(() => {
      this.ensureUser(guildId, userId);
      const result = this.db
        .prepare(
          `UPDATE economy_users
           SET balance = balance + ?, bank_balance = bank_balance - ?
           WHERE guild_id = ? AND user_id = ? AND bank_balance >= ?`,
        )
        .run(value, value, guildId, userId, value);
      if (Number(result.changes) !== 1) return { success: false, account: this.account(guildId, userId) };
      this.recordTransaction(guildId, null, userId, value, "withdraw");
      return { success: true, account: this.account(guildId, userId) };
    });
  }

  transfer(guildId, fromUserId, toUserId, amount) {
    const value = BigInt(amount);
    return this.transaction(() => {
      this.ensureUser(guildId, fromUserId);
      this.ensureUser(guildId, toUserId);
      const result = this.db
        .prepare(
          `UPDATE economy_users SET balance = balance - ?
           WHERE guild_id = ? AND user_id = ? AND balance >= ?`,
        )
        .run(value, guildId, fromUserId, value);
      if (Number(result.changes) !== 1) {
        return { success: false, account: this.account(guildId, fromUserId) };
      }
      this.db
        .prepare(
          "UPDATE economy_users SET balance = balance + ? WHERE guild_id = ? AND user_id = ?",
        )
        .run(value, guildId, toUserId);
      this.recordTransaction(guildId, fromUserId, toUserId, value, "member transfer");
      return { success: true, account: this.account(guildId, fromUserId) };
    });
  }

  placeBet(guildId, userId, amount, reason) {
    const value = BigInt(amount);
    return this.transaction(() => {
      this.ensureUser(guildId, userId);
      const result = this.db
        .prepare(
          `UPDATE economy_users SET balance = balance - ?
           WHERE guild_id = ? AND user_id = ? AND balance >= ?`,
        )
        .run(value, guildId, userId, value);
      if (Number(result.changes) !== 1) return { success: false, account: this.account(guildId, userId) };
      this.recordTransaction(guildId, userId, null, value, reason);
      return { success: true, account: this.account(guildId, userId) };
    });
  }

  payout(guildId, userId, amount, reason) {
    const value = BigInt(amount);
    return this.transaction(() => {
      this.ensureUser(guildId, userId);
      this.db
        .prepare(
          "UPDATE economy_users SET balance = balance + ? WHERE guild_id = ? AND user_id = ?",
        )
        .run(value, guildId, userId);
      this.recordTransaction(guildId, null, userId, value, reason);
      return this.account(guildId, userId);
    });
  }

  coinflip(guildId, userId, amount, choice) {
    const value = BigInt(amount);
    return this.transaction(() => {
      this.ensureUser(guildId, userId);
      const debited = this.db
        .prepare(
          `UPDATE economy_users SET balance = balance - ?
           WHERE guild_id = ? AND user_id = ? AND balance >= ?`,
        )
        .run(value, guildId, userId, value);
      if (Number(debited.changes) !== 1) return { success: false, account: this.account(guildId, userId) };
      this.recordTransaction(guildId, userId, null, value, "coinflip bet");
      const result = Math.random() < 0.5 ? "heads" : "tails";
      const won = result === choice;
      const winnings = won ? value * 2n : 0n;
      if (winnings > 0n) {
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
        balance: BigInt(row.balance),
        bankBalance: BigInt(row.bank_balance ?? 0),
        total: BigInt(row.total),
      }));
  }
}

export function formatAmount(amount) {
  return `${BigInt(amount).toLocaleString("en-US")} credits`;
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