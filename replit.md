# Discord Economy Bot

A Python Discord bot that provides server utilities and a persistent custom economy per server.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `python -m discord_bot.main` — run the Discord bot
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required secret: `DISCORD_BOT_TOKEN`
- Optional env: `DISCORD_GUILD_ID` for immediate slash-command sync to one development server

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `discord_bot/main.py` — Discord client and slash commands
- `discord_bot/database.py` — SQLite economy persistence and atomic balance operations
- `discord_bot/README.md` — setup and command reference

## Architecture decisions

- Economy balances are scoped by `(guild_id, user_id)` so servers never share currency.
- SQLite uses WAL mode and short atomic transactions to keep transfers safe.
- Slash commands are synced to `DISCORD_GUILD_ID` when provided, otherwise globally.

## Product

- Members can check balances, claim daily credits, pay each other, and view a leaderboard.
- Moderators with Manage Server can grant, remove, or set balances.
- The bot also provides a basic `/serverinfo` utility command.

## Gotchas

- Global slash-command sync can take time to appear; set `DISCORD_GUILD_ID` during development.
- Invite the bot with both `bot` and `applications.commands` scopes.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
