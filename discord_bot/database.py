from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock


@dataclass(frozen=True)
class EconomyUser:
    guild_id: int
    user_id: int
    balance: int
    last_daily: int | None


@dataclass(frozen=True)
class LeaderboardEntry:
    user_id: int
    balance: int


class EconomyDatabase:
    def __init__(
        self,
        database_path: str | Path = "data/economy.sqlite3",
        starting_balance: int = 0,
    ) -> None:
        self.database_path = Path(database_path)
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self.starting_balance = starting_balance
        self._lock = Lock()
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.executescript(
                """
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
                """
            )

    @staticmethod
    def _now() -> int:
        return int(datetime.now(timezone.utc).timestamp())

    def _ensure_user(self, connection: sqlite3.Connection, guild_id: int, user_id: int) -> None:
        connection.execute(
            """
            INSERT INTO economy_users (guild_id, user_id, balance)
            VALUES (?, ?, ?)
            ON CONFLICT (guild_id, user_id) DO NOTHING
            """,
            (guild_id, user_id, self.starting_balance),
        )

    def get_user(self, guild_id: int, user_id: int) -> EconomyUser:
        with self._lock, self._connect() as connection:
            self._ensure_user(connection, guild_id, user_id)
            row = connection.execute(
                """
                SELECT guild_id, user_id, balance, last_daily
                FROM economy_users
                WHERE guild_id = ? AND user_id = ?
                """,
                (guild_id, user_id),
            ).fetchone()
            if row is None:
                raise RuntimeError("Economy user could not be initialized")
            return EconomyUser(**dict(row))

    def claim_daily(
        self,
        guild_id: int,
        user_id: int,
        amount: int,
        cooldown_seconds: int = 86_400,
    ) -> tuple[bool, EconomyUser, int]:
        now = self._now()
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            self._ensure_user(connection, guild_id, user_id)
            row = connection.execute(
                """
                SELECT guild_id, user_id, balance, last_daily
                FROM economy_users
                WHERE guild_id = ? AND user_id = ?
                """,
                (guild_id, user_id),
            ).fetchone()
            if row is None:
                raise RuntimeError("Economy user could not be initialized")

            last_daily = row["last_daily"]
            if last_daily is not None and now - last_daily < cooldown_seconds:
                return False, EconomyUser(**dict(row)), cooldown_seconds - (now - last_daily)

            new_balance = row["balance"] + amount
            connection.execute(
                """
                UPDATE economy_users
                SET balance = ?, last_daily = ?
                WHERE guild_id = ? AND user_id = ?
                """,
                (new_balance, now, guild_id, user_id),
            )
            connection.execute(
                """
                INSERT INTO economy_transactions
                    (guild_id, to_user_id, amount, reason, created_at)
                VALUES (?, ?, ?, 'daily reward', ?)
                """,
                (guild_id, user_id, amount, now),
            )
            return True, EconomyUser(guild_id, user_id, new_balance, now), 0

    def transfer(
        self,
        guild_id: int,
        from_user_id: int,
        to_user_id: int,
        amount: int,
    ) -> tuple[bool, int]:
        now = self._now()
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            self._ensure_user(connection, guild_id, from_user_id)
            self._ensure_user(connection, guild_id, to_user_id)
            sender = connection.execute(
                """
                SELECT balance FROM economy_users
                WHERE guild_id = ? AND user_id = ?
                """,
                (guild_id, from_user_id),
            ).fetchone()
            if sender is None or sender["balance"] < amount:
                return False, sender["balance"] if sender else 0

            connection.execute(
                """
                UPDATE economy_users SET balance = balance - ?
                WHERE guild_id = ? AND user_id = ?
                """,
                (amount, guild_id, from_user_id),
            )
            connection.execute(
                """
                UPDATE economy_users SET balance = balance + ?
                WHERE guild_id = ? AND user_id = ?
                """,
                (amount, guild_id, to_user_id),
            )
            connection.execute(
                """
                INSERT INTO economy_transactions
                    (guild_id, from_user_id, to_user_id, amount, reason, created_at)
                VALUES (?, ?, ?, ?, 'member transfer', ?)
                """,
                (guild_id, from_user_id, to_user_id, amount, now),
            )
            return True, sender["balance"] - amount

    def adjust_balance(
        self,
        guild_id: int,
        user_id: int,
        amount: int,
        reason: str,
    ) -> EconomyUser:
        now = self._now()
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            self._ensure_user(connection, guild_id, user_id)
            row = connection.execute(
                """
                SELECT guild_id, user_id, balance, last_daily
                FROM economy_users
                WHERE guild_id = ? AND user_id = ?
                """,
                (guild_id, user_id),
            ).fetchone()
            if row is None:
                raise RuntimeError("Economy user could not be initialized")
            new_balance = row["balance"] + amount
            if new_balance < 0:
                raise ValueError("Balance cannot go below zero")

            connection.execute(
                """
                UPDATE economy_users SET balance = ?
                WHERE guild_id = ? AND user_id = ?
                """,
                (new_balance, guild_id, user_id),
            )
            connection.execute(
                """
                INSERT INTO economy_transactions
                    (guild_id, to_user_id, amount, reason, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (guild_id, user_id, abs(amount), reason, now),
            )
            return EconomyUser(guild_id, user_id, new_balance, row["last_daily"])

    def leaderboard(self, guild_id: int, limit: int = 10) -> list[LeaderboardEntry]:
        with self._lock, self._connect() as connection:
            rows = connection.execute(
                """
                SELECT user_id, balance
                FROM economy_users
                WHERE guild_id = ?
                ORDER BY balance DESC, user_id ASC
                LIMIT ?
                """,
                (guild_id, limit),
            ).fetchall()
            return [LeaderboardEntry(row["user_id"], row["balance"]) for row in rows]