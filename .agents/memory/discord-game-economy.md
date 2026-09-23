---
name: Discord game economy
description: Durable conventions for adding interactive games to the Discord economy bot.
---

Interactive games are scoped by both Discord server and user, and bets, payouts, and balance-history entries are handled through atomic database methods rather than direct SQL from UI callbacks.

**Why:** The bot supports multiple isolated server economies, and button callbacks can be retried or clicked concurrently; direct global cursor state risks cross-server data leaks and inconsistent balances.

**How to apply:** New economy games should key in-memory sessions by `(guild_id, user_id)`, verify the initiating member before handling buttons, and settle all money through the database layer.