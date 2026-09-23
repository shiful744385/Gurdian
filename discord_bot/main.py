from __future__ import annotations

import asyncio
import logging
import os
from datetime import timedelta

import discord
from discord import app_commands
from discord.ext import commands

from discord_bot.database import EconomyDatabase


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)
logger = logging.getLogger("discord_economy_bot")

STARTING_BALANCE = 250
DAILY_REWARD = 100
COIN_NAME = os.getenv("ECONOMY_CURRENCY_NAME", "credits")
GUILD_ID = os.getenv("DISCORD_GUILD_ID")


def format_amount(amount: int) -> str:
    return f"{amount:,} {COIN_NAME}"


def format_duration(seconds: int) -> str:
    duration = timedelta(seconds=max(0, seconds))
    hours, remainder = divmod(int(duration.total_seconds()), 3600)
    minutes, _ = divmod(remainder, 60)
    if hours:
        return f"{hours}h {minutes}m"
    return f"{minutes}m"


class EconomyBot(commands.Bot):
    def __init__(self) -> None:
        intents = discord.Intents.default()
        super().__init__(
            command_prefix="!",
            intents=intents,
            help_command=None,
        )
        self.database = EconomyDatabase(starting_balance=STARTING_BALANCE)
        self.synced = False

    async def setup_hook(self) -> None:
        if GUILD_ID:
            guild = discord.Object(id=int(GUILD_ID))
            self.tree.copy_global_to(guild=guild)
            await self.tree.sync(guild=guild)
            logger.info("Synced commands to guild %s", GUILD_ID)
        else:
            await self.tree.sync()
            logger.info("Synced global commands")
        self.synced = True

    async def on_ready(self) -> None:
        if self.user:
            logger.info("Logged in as %s (%s)", self.user, self.user.id)


bot = EconomyBot()
economy_group = app_commands.Group(
    name="economy",
    description="Admin controls for the server economy",
)


async def ensure_guild(interaction: discord.Interaction) -> bool:
    if interaction.guild is None:
        await interaction.response.send_message(
            "This command can only be used inside a server.",
            ephemeral=True,
        )
        return False
    return True


def guild_id(interaction: discord.Interaction) -> int:
    if interaction.guild_id is None:
        raise RuntimeError("This command requires a guild")
    return interaction.guild_id


@bot.tree.command(name="balance", description="Check your balance or another member's balance")
@app_commands.describe(member="The member whose balance you want to see")
async def balance(
    interaction: discord.Interaction,
    member: discord.Member | None = None,
) -> None:
    if not await ensure_guild(interaction):
        return
    target = member or interaction.user
    account = bot.database.get_user(guild_id(interaction), target.id)
    await interaction.response.send_message(
        f"**{target.display_name}** has **{format_amount(account.balance)}**."
    )


@bot.tree.command(name="daily", description="Claim your daily economy reward")
async def daily(interaction: discord.Interaction) -> None:
    if not await ensure_guild(interaction):
        return
    claimed, account, remaining = bot.database.claim_daily(
        guild_id(interaction),
        interaction.user.id,
        DAILY_REWARD,
    )
    if not claimed:
        await interaction.response.send_message(
            f"You already claimed your daily reward. Try again in **{format_duration(remaining)}**.",
            ephemeral=True,
        )
        return
    await interaction.response.send_message(
        f"You claimed **{format_amount(DAILY_REWARD)}**. "
        f"Your balance is now **{format_amount(account.balance)}**."
    )


@bot.tree.command(name="pay", description="Pay another member from your balance")
@app_commands.describe(member="The member to pay", amount="A positive whole-number amount")
async def pay(
    interaction: discord.Interaction,
    member: discord.Member,
    amount: app_commands.Range[int, 1, 1_000_000],
) -> None:
    if not await ensure_guild(interaction):
        return
    if member.bot:
        await interaction.response.send_message(
            "Bots cannot receive economy payments.",
            ephemeral=True,
        )
        return
    if member.id == interaction.user.id:
        await interaction.response.send_message(
            "You cannot pay yourself.",
            ephemeral=True,
        )
        return
    success, new_balance = bot.database.transfer(
        guild_id(interaction),
        interaction.user.id,
        member.id,
        amount,
    )
    if not success:
        await interaction.response.send_message(
            f"You need **{format_amount(amount)}**, but your balance is only "
            f"**{format_amount(new_balance)}**.",
            ephemeral=True,
        )
        return
    await interaction.response.send_message(
        f"{interaction.user.mention} paid {member.mention} **{format_amount(amount)}**. "
        f"Your new balance is **{format_amount(new_balance)}**."
    )


@bot.tree.command(name="leaderboard", description="See the richest members in this server")
async def leaderboard(interaction: discord.Interaction) -> None:
    if not await ensure_guild(interaction):
        return
    entries = bot.database.leaderboard(guild_id(interaction))
    if not entries:
        await interaction.response.send_message(
            "No economy activity yet. Use `/daily` to start earning.",
            ephemeral=True,
        )
        return

    lines = []
    for rank, entry in enumerate(entries, start=1):
        member = interaction.guild.get_member(entry.user_id) if interaction.guild else None
        display_name = member.display_name if member else f"Member {entry.user_id}"
        lines.append(f"**{rank}.** {display_name} — **{format_amount(entry.balance)}**")
    embed = discord.Embed(
        title=f"{interaction.guild.name} leaderboard",
        description="\n".join(lines),
        color=discord.Color.blurple(),
    )
    await interaction.response.send_message(embed=embed)


@bot.tree.command(name="serverinfo", description="Show useful information about this server")
async def serverinfo(interaction: discord.Interaction) -> None:
    if not await ensure_guild(interaction):
        return
    guild = interaction.guild
    embed = discord.Embed(
        title=guild.name,
        color=discord.Color.blurple(),
    )
    embed.add_field(name="Members", value=str(guild.member_count or 0))
    embed.add_field(name="Channels", value=str(len(guild.channels)))
    embed.add_field(name="Created", value=discord.utils.format_dt(guild.created_at, style="D"))
    if guild.icon:
        embed.set_thumbnail(url=guild.icon.url)
    await interaction.response.send_message(embed=embed)


@economy_group.command(name="grant", description="Give a member economy credits")
@app_commands.checks.has_permissions(manage_guild=True)
@app_commands.describe(member="The member to credit", amount="A positive whole-number amount")
async def economy_grant(
    interaction: discord.Interaction,
    member: discord.Member,
    amount: app_commands.Range[int, 1, 10_000_000],
) -> None:
    if not await ensure_guild(interaction):
        return
    account = bot.database.adjust_balance(
        guild_id(interaction),
        member.id,
        amount,
        "admin grant",
    )
    await interaction.response.send_message(
        f"Added **{format_amount(amount)}** to {member.mention}. "
        f"Their balance is now **{format_amount(account.balance)}**."
    )


@economy_group.command(name="remove", description="Remove economy credits from a member")
@app_commands.checks.has_permissions(manage_guild=True)
@app_commands.describe(member="The member to debit", amount="A positive whole-number amount")
async def economy_remove(
    interaction: discord.Interaction,
    member: discord.Member,
    amount: app_commands.Range[int, 1, 10_000_000],
) -> None:
    if not await ensure_guild(interaction):
        return
    current = bot.database.get_user(guild_id(interaction), member.id)
    if current.balance < amount:
        await interaction.response.send_message(
            f"{member.mention} only has **{format_amount(current.balance)}**.",
            ephemeral=True,
        )
        return
    account = bot.database.adjust_balance(
        guild_id(interaction),
        member.id,
        -amount,
        "admin removal",
    )
    await interaction.response.send_message(
        f"Removed **{format_amount(amount)}** from {member.mention}. "
        f"Their balance is now **{format_amount(account.balance)}**."
    )


@economy_group.command(name="set", description="Set a member's exact economy balance")
@app_commands.checks.has_permissions(manage_guild=True)
@app_commands.describe(member="The member to update", amount="The new whole-number balance")
async def economy_set(
    interaction: discord.Interaction,
    member: discord.Member,
    amount: app_commands.Range[int, 0, 10_000_000],
) -> None:
    if not await ensure_guild(interaction):
        return
    current = bot.database.get_user(guild_id(interaction), member.id)
    account = bot.database.adjust_balance(
        guild_id(interaction),
        member.id,
        amount - current.balance,
        "admin balance set",
    )
    await interaction.response.send_message(
        f"Set {member.mention}'s balance to **{format_amount(account.balance)}**."
    )


@bot.tree.error
async def on_app_command_error(
    interaction: discord.Interaction,
    error: app_commands.AppCommandError,
) -> None:
    if isinstance(error, app_commands.MissingPermissions):
        message = "You need the **Manage Server** permission to use that command."
    elif isinstance(error, app_commands.CommandOnCooldown):
        message = "That command is cooling down. Try again shortly."
    else:
        logger.exception("Unhandled application command error", exc_info=error)
        message = "Something went wrong while running that command."

    if interaction.response.is_done():
        await interaction.followup.send(message, ephemeral=True)
    else:
        await interaction.response.send_message(message, ephemeral=True)


bot.tree.add_command(economy_group)


async def run() -> None:
    token = os.getenv("DISCORD_BOT_TOKEN")
    if not token:
        raise RuntimeError("DISCORD_BOT_TOKEN is not configured")
    await bot.start(token)


if __name__ == "__main__":
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        logger.info("Bot stopped")