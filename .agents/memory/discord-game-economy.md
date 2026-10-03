---
name: Discord game economy
description: Data-safety boundaries and conventions for the Discord economy bot's game and security features.
---

Interactive games are scoped by both Discord server and user, and bets, payouts, and balance-history entries are handled through atomic database methods rather than direct SQL from UI callbacks.

**Why:** The bot supports multiple isolated server economies, and button callbacks can be retried or clicked concurrently; direct global cursor state risks cross-server data leaks and inconsistent balances.

**How to apply:** New economy games should key in-memory sessions by `(guild_id, user_id)`, verify the initiating member before handling buttons, and settle all money through the database layer.

Security features must use the existing Discord bot and database, with security-specific persistence kept separate from economy and game records. Do not modify or reset economy/game behavior or data while implementing security.

**Why:** The user requires all current economy and game features and balances to remain intact while security is added to the same bot.

**How to apply:** Extend the existing client with security event handling and add isolated security tables; do not create a second bot client or alter economy/game modules for security work.