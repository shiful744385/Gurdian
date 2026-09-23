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


@dataclass(frozen=True)
class ShopItem:
    id: int
    guild_id: int
    name: str
    price: int
    role_id: int | None
    created_at: int
    updated_at: int


@dataclass(frozen=True)
class BalanceHistoryEntry:
    transaction_id: int
    from_user_id: int | None
    to_user_id: int | None
    amount: int
    delta: int
    reason: str
    created_at: int


@dataclass(frozen=True)
class InventoryEntry:
    animal: str
    quantity: int


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

                CREATE TABLE IF NOT EXISTS shop_items (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    guild_id INTEGER NOT NULL,
                    name TEXT NOT NULL COLLATE NOCASE,
                    price INTEGER NOT NULL CHECK (price > 0),
                    role_id INTEGER,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    UNIQUE (guild_id, name)
                );

                CREATE TABLE IF NOT EXISTS inventory (
                    guild_id INTEGER NOT NULL,
                    user_id INTEGER NOT NULL,
                    animal TEXT NOT NULL,
                    quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
                    PRIMARY KEY (guild_id, user_id, animal)
                );

                CREATE TABLE IF NOT EXISTS hunt_cooldowns (
                    guild_id INTEGER NOT NULL,
                    user_id INTEGER NOT NULL,
                    last_hunt INTEGER NOT NULL,
                    PRIMARY KEY (guild_id, user_id)
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
            if amount:
                connection.execute(
                    """
                    INSERT INTO economy_transactions
                        (guild_id, from_user_id, to_user_id, amount, reason, created_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        guild_id,
                        user_id if amount < 0 else None,
                        user_id if amount > 0 else None,
                        abs(amount),
                        reason,
                        now,
                    ),
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

    @staticmethod
    def _shop_item_from_row(row: sqlite3.Row) -> ShopItem:
        return ShopItem(**dict(row))

    @staticmethod
    def _validate_shop_item(name: str, price: int) -> str:
        normalized_name = name.strip()
        if not normalized_name:
            raise ValueError("Shop item names cannot be empty")
        if len(normalized_name) > 100:
            raise ValueError("Shop item names cannot exceed 100 characters")
        if price <= 0:
            raise ValueError("Shop item prices must be positive")
        return normalized_name

    def list_shop_items(self, guild_id: int) -> list[ShopItem]:
        with self._lock, self._connect() as connection:
            rows = connection.execute(
                """
                SELECT id, guild_id, name, price, role_id, created_at, updated_at
                FROM shop_items
                WHERE guild_id = ?
                ORDER BY id ASC
                """,
                (guild_id,),
            ).fetchall()
            return [self._shop_item_from_row(row) for row in rows]

    def get_shop_item(self, guild_id: int, item_id: int) -> ShopItem | None:
        with self._lock, self._connect() as connection:
            row = connection.execute(
                """
                SELECT id, guild_id, name, price, role_id, created_at, updated_at
                FROM shop_items
                WHERE guild_id = ? AND id = ?
                """,
                (guild_id, item_id),
            ).fetchone()
            return self._shop_item_from_row(row) if row else None

    def create_shop_item(
        self,
        guild_id: int,
        name: str,
        price: int,
        role_id: int | None = None,
    ) -> ShopItem:
        normalized_name = self._validate_shop_item(name, price)
        now = self._now()
        with self._lock, self._connect() as connection:
            try:
                cursor = connection.execute(
                    """
                    INSERT INTO shop_items
                        (guild_id, name, price, role_id, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (guild_id, normalized_name, price, role_id, now, now),
                )
            except sqlite3.IntegrityError as error:
                raise ValueError("A shop item with that name already exists") from error
            row = connection.execute(
                """
                SELECT id, guild_id, name, price, role_id, created_at, updated_at
                FROM shop_items
                WHERE id = ?
                """,
                (cursor.lastrowid,),
            ).fetchone()
            if row is None:
                raise RuntimeError("Shop item could not be created")
            return self._shop_item_from_row(row)

    _UNSET = object()

    def update_shop_item(
        self,
        guild_id: int,
        item_id: int,
        *,
        name: str | None = None,
        price: int | None = None,
        role_id: int | None | object = _UNSET,
    ) -> ShopItem | None:
        with self._lock, self._connect() as connection:
            current = connection.execute(
                """
                SELECT id, guild_id, name, price, role_id, created_at, updated_at
                FROM shop_items
                WHERE guild_id = ? AND id = ?
                """,
                (guild_id, item_id),
            ).fetchone()
            if current is None:
                return None

            next_name = self._validate_shop_item(
                name if name is not None else current["name"],
                price if price is not None else current["price"],
            )
            next_price = price if price is not None else current["price"]
            next_role_id = current["role_id"] if role_id is self._UNSET else role_id
            try:
                connection.execute(
                    """
                    UPDATE shop_items
                    SET name = ?, price = ?, role_id = ?, updated_at = ?
                    WHERE guild_id = ? AND id = ?
                    """,
                    (next_name, next_price, next_role_id, self._now(), guild_id, item_id),
                )
            except sqlite3.IntegrityError as error:
                raise ValueError("A shop item with that name already exists") from error
            updated = connection.execute(
                """
                SELECT id, guild_id, name, price, role_id, created_at, updated_at
                FROM shop_items
                WHERE guild_id = ? AND id = ?
                """,
                (guild_id, item_id),
            ).fetchone()
            if updated is None:
                raise RuntimeError("Shop item could not be updated")
            return self._shop_item_from_row(updated)

    def delete_shop_item(self, guild_id: int, item_id: int) -> bool:
        with self._lock, self._connect() as connection:
            cursor = connection.execute(
                "DELETE FROM shop_items WHERE guild_id = ? AND id = ?",
                (guild_id, item_id),
            )
            return cursor.rowcount == 1

    def purchase(
        self,
        guild_id: int,
        user_id: int,
        item_id: int,
    ) -> tuple[bool, ShopItem | None, int]:
        """Atomically charge a member and record a shop purchase."""
        now = self._now()
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            self._ensure_user(connection, guild_id, user_id)
            item_row = connection.execute(
                """
                SELECT id, guild_id, name, price, role_id, created_at, updated_at
                FROM shop_items
                WHERE guild_id = ? AND id = ?
                """,
                (guild_id, item_id),
            ).fetchone()
            if item_row is None:
                return False, None, 0

            item = self._shop_item_from_row(item_row)
            account = connection.execute(
                """
                SELECT balance
                FROM economy_users
                WHERE guild_id = ? AND user_id = ?
                """,
                (guild_id, user_id),
            ).fetchone()
            if account is None:
                raise RuntimeError("Economy user could not be initialized")
            if account["balance"] < item.price:
                return False, item, account["balance"]

            updated = connection.execute(
                """
                UPDATE economy_users
                SET balance = balance - ?
                WHERE guild_id = ? AND user_id = ? AND balance >= ?
                """,
                (item.price, guild_id, user_id, item.price),
            )
            if updated.rowcount != 1:
                current = connection.execute(
                    """
                    SELECT balance
                    FROM economy_users
                    WHERE guild_id = ? AND user_id = ?
                    """,
                    (guild_id, user_id),
                ).fetchone()
                return False, item, current["balance"] if current else 0

            connection.execute(
                """
                INSERT INTO economy_transactions
                    (guild_id, from_user_id, amount, reason, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    guild_id,
                    user_id,
                    item.price,
                    f"shop purchase: {item.name}",
                    now,
                ),
            )
            return True, item, account["balance"] - item.price

    def balance_history(
        self,
        guild_id: int,
        user_id: int,
        limit: int = 10,
    ) -> list[BalanceHistoryEntry]:
        with self._lock, self._connect() as connection:
            rows = connection.execute(
                """
                SELECT
                    id AS transaction_id,
                    from_user_id,
                    to_user_id,
                    amount,
                    CASE
                        WHEN from_user_id = ? THEN -amount
                        WHEN to_user_id = ? THEN amount
                        ELSE 0
                    END AS delta,
                    reason,
                    created_at
                FROM economy_transactions
                WHERE guild_id = ?
                  AND (from_user_id = ? OR to_user_id = ?)
                ORDER BY created_at DESC, id DESC
                LIMIT ?
                """,
                (user_id, user_id, guild_id, user_id, user_id, limit),
            ).fetchall()
            return [BalanceHistoryEntry(**dict(row)) for row in rows]

    def record_hunt(
        self,
        guild_id: int,
        user_id: int,
        animal: str,
        quantity: int,
        cooldown_seconds: int = 60,
    ) -> tuple[bool, int, int]:
        """Record a hunt atomically and return (claimed, remaining, new_quantity)."""
        now = self._now()
        normalized_animal = animal.strip()
        if not normalized_animal:
            raise ValueError("Animal names cannot be empty")
        if quantity <= 0:
            raise ValueError("Hunt quantity must be positive")

        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            last_hunt_row = connection.execute(
                """
                SELECT last_hunt
                FROM hunt_cooldowns
                WHERE guild_id = ? AND user_id = ?
                """,
                (guild_id, user_id),
            ).fetchone()
            if cooldown_seconds > 0 and last_hunt_row is not None:
                elapsed = now - last_hunt_row["last_hunt"]
                if elapsed < cooldown_seconds:
                    return False, cooldown_seconds - elapsed, 0

            connection.execute(
                """
                INSERT INTO hunt_cooldowns (guild_id, user_id, last_hunt)
                VALUES (?, ?, ?)
                ON CONFLICT (guild_id, user_id)
                DO UPDATE SET last_hunt = excluded.last_hunt
                """,
                (guild_id, user_id, now),
            )
            connection.execute(
                """
                INSERT INTO inventory (guild_id, user_id, animal, quantity)
                VALUES (?, ?, ?, ?)
                ON CONFLICT (guild_id, user_id, animal)
                DO UPDATE SET quantity = inventory.quantity + excluded.quantity
                """,
                (guild_id, user_id, normalized_animal, quantity),
            )
            inventory_row = connection.execute(
                """
                SELECT quantity
                FROM inventory
                WHERE guild_id = ? AND user_id = ? AND animal = ?
                """,
                (guild_id, user_id, normalized_animal),
            ).fetchone()
            if inventory_row is None:
                raise RuntimeError("Hunt inventory could not be updated")
            return True, 0, inventory_row["quantity"]

    def get_inventory(self, guild_id: int, user_id: int) -> list[InventoryEntry]:
        with self._lock, self._connect() as connection:
            rows = connection.execute(
                """
                SELECT animal, quantity
                FROM inventory
                WHERE guild_id = ? AND user_id = ? AND quantity > 0
                ORDER BY quantity DESC, animal ASC
                """,
                (guild_id, user_id),
            ).fetchall()
            return [InventoryEntry(**dict(row)) for row in rows]