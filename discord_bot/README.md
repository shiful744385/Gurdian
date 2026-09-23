# Discord Economy Bot

Python Discord bot for server utilities and a persistent per-server economy.

## Commands

- `/balance [member]` — view a balance; new members start with 250 credits
- `/daily` — claim 100 credits once every 24 hours
- `/pay member amount` — transfer credits to another member
- `/leaderboard` — see the top balances
- `/hunt` — catch a random animal once per minute
- `/inventory [member]` — view collected animals
- `/history [member]` — view recent balance changes, including shop purchases
- `/shop list` — browse this server's shop
- `/shop buy item` — purchase a shop item with credits
- `/serverinfo` — show basic server details
- `/economy grant member amount` — admin credit
- `/economy remove member amount` — admin debit
- `/economy set member amount` — admin balance override
- `/economy shop add name price [role]` — add a shop item (Manage Server)
- `/economy shop edit item [name] [price] [role] [clear_role]` — edit a shop item (Manage Server)
- `/economy shop remove item` — remove a shop item (Manage Server)

Balances, balance history, shop items, hunt cooldowns, and inventories are stored in `data/economy.sqlite3`. Each Discord server has an isolated economy and inventory.
Shop purchases are charged atomically and are recorded in balance history. Role rewards require the bot to have
Manage Roles and its highest role to be above the reward role.

## Required setup

1. Create a Discord application and bot in the Discord Developer Portal.
2. Enable the `applications.commands` scope and the bot scope when generating the invite URL.
3. Store the bot token as the `DISCORD_BOT_TOKEN` secret.
4. Optionally set `DISCORD_GUILD_ID` for immediate command sync in one development server. Without it, commands sync globally.

The bot needs permission to view channels and send messages. Slash commands also require the `applications.commands` scope.