from __future__ import annotations

import asyncio
import logging
import os
import random
from datetime import datetime, timedelta, timezone

import discord
from discord import app_commands
from discord.ext import commands

from discord_bot.database import EconomyDatabase, ShopItem


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)
logger = logging.getLogger("discord_economy_bot")

STARTING_BALANCE = 250
DAILY_REWARD = 100
HUNT_ANIMALS = (
    ("🐰 Rabbit", 50),
    ("🐱 Cat", 30),
    ("🐶 Dog", 15),
    ("🦊 Fox", 5),
    ("🐺 Wolf", 3),
    ("🐯 Tiger", 1),
)
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
shop_group = app_commands.Group(
    name="shop",
    description="Browse and buy items from the server shop",
)
economy_shop_group = app_commands.Group(
    name="shop",
    description="Manage the server shop",
    parent=economy_group,
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


@bot.tree.command(name="hunt", description="Go hunting and find an animal")
async def hunt(interaction: discord.Interaction) -> None:
    if not await ensure_guild(interaction):
        return
    animal, _ = random.choices(
        HUNT_ANIMALS,
        weights=[weight for _, weight in HUNT_ANIMALS],
        k=1,
    )[0]
    claimed, _, _ = bot.database.record_hunt(
        guild_id(interaction),
        interaction.user.id,
        animal,
        1,
        cooldown_seconds=0,
    )
    if not claimed:
        await interaction.response.send_message(
            "You cannot hunt right now. Please try again shortly.",
            ephemeral=True,
        )
        return
    await interaction.response.send_message(
        f"🏹 **Hunt!**\n\n"
        f"{interaction.user.mention} found **{animal}**!"
    )


@bot.tree.command(name="inventory", description="View your hunting inventory")
@app_commands.describe(member="The member whose inventory you want to see")
async def inventory(
    interaction: discord.Interaction,
    member: discord.Member | None = None,
) -> None:
    if not await ensure_guild(interaction):
        return
    target = member or interaction.user
    entries = bot.database.get_inventory(guild_id(interaction), target.id)
    if not entries:
        await interaction.response.send_message(
            "🎒 Your inventory is empty!\n"
            "Use `/hunt` to find animals.",
            ephemeral=True,
        )
        return

    description = "\n".join(
        f"{entry.animal} × **{entry.quantity}**" for entry in entries
    )
    embed = discord.Embed(
        title="🎒 Animal Inventory",
        description=description,
        color=discord.Color.green(),
    )
    await interaction.response.send_message(embed=embed)


@bot.tree.command(name="history", description="View recent balance changes")
@app_commands.describe(member="The member whose history you want to see")
async def history(
    interaction: discord.Interaction,
    member: discord.Member | None = None,
) -> None:
    if not await ensure_guild(interaction):
        return
    target = member or interaction.user
    entries = bot.database.balance_history(guild_id(interaction), target.id)
    if not entries:
        await interaction.response.send_message(
            f"No balance history exists for **{target.display_name}** yet.",
            ephemeral=True,
        )
        return

    lines = []
    for entry in entries:
        sign = "+" if entry.delta >= 0 else "-"
        timestamp = datetime.fromtimestamp(entry.created_at, tz=timezone.utc)
        lines.append(
            f"`{sign}{format_amount(abs(entry.delta))}` — {entry.reason} "
            f"({discord.utils.format_dt(timestamp, style='R')})"
        )
    embed = discord.Embed(
        title=f"{target.display_name}'s balance history",
        description="\n".join(lines),
        color=discord.Color.blurple(),
    )
    await interaction.response.send_message(embed=embed)


def shop_role(guild: discord.Guild, role_id: int | None) -> discord.Role | None:
    return guild.get_role(role_id) if role_id is not None else None


def role_reward_is_available(guild: discord.Guild, role: discord.Role) -> bool:
    me = guild.me
    return (
        me is not None
        and me.guild_permissions.manage_roles
        and role.is_assignable()
    )


def format_shop_item(item: ShopItem, guild: discord.Guild) -> str:
    reward = ""
    if item.role_id is not None:
        role = shop_role(guild, item.role_id)
        reward = f"\nRole reward: {role.mention if role else 'role no longer exists'}"
    return f"**#{item.id} — {item.name}**\nPrice: {format_amount(item.price)}{reward}"


@shop_group.command(name="list", description="Browse the items in this server's shop")
async def shop_list(interaction: discord.Interaction) -> None:
    if not await ensure_guild(interaction):
        return
    items = bot.database.list_shop_items(guild_id(interaction))
    if not items:
        await interaction.response.send_message(
            "The shop is empty right now.",
            ephemeral=True,
        )
        return

    embed = discord.Embed(
        title=f"{interaction.guild.name} shop",
        description="Use `/shop buy` with an item number to purchase an item.",
        color=discord.Color.gold(),
    )
    for item in items[:25]:
        role = shop_role(interaction.guild, item.role_id)
        reward = f"\nRole reward: {role.mention}" if role else ""
        if item.role_id is not None and role is None:
            reward = "\nRole reward: role no longer exists"
        embed.add_field(
            name=f"#{item.id} — {item.name}",
            value=f"Price: **{format_amount(item.price)}**{reward}",
            inline=False,
        )
    if len(items) > 25:
        embed.set_footer(text=f"Showing 25 of {len(items)} items. Use item numbers shown above.")
    await interaction.response.send_message(embed=embed)


@shop_group.command(name="buy", description="Purchase an item from the server shop")
@app_commands.describe(item_id="The item number shown by /shop list")
@app_commands.rename(item_id="item")
async def shop_buy(
    interaction: discord.Interaction,
    item_id: app_commands.Range[int, 1, 2_147_483_647],
) -> None:
    if not await ensure_guild(interaction):
        return
    item = bot.database.get_shop_item(guild_id(interaction), item_id)
    if item is None:
        await interaction.response.send_message(
            "That shop item does not exist.",
            ephemeral=True,
        )
        return

    role = shop_role(interaction.guild, item.role_id)
    if item.role_id is not None and (
        role is None or not role_reward_is_available(interaction.guild, role)
    ):
        await interaction.response.send_message(
            "This item's role reward is currently unavailable. Please ask a server admin to fix it.",
            ephemeral=True,
        )
        return

    success, purchased_item, new_balance = bot.database.purchase(
        guild_id(interaction),
        interaction.user.id,
        item_id,
    )
    if not success:
        if purchased_item is None:
            message = "That shop item does not exist."
        else:
            message = (
                f"You need **{format_amount(purchased_item.price)}**, but your balance is only "
                f"**{format_amount(new_balance)}**."
            )
        await interaction.response.send_message(message, ephemeral=True)
        return

    if role is not None:
        try:
            await interaction.user.add_roles(
                role,
                reason=f"Shop purchase: {purchased_item.name if purchased_item else item.name}",
            )
        except (discord.Forbidden, discord.HTTPException):
            logger.exception("Could not grant role reward for shop item %s", item_id)
            try:
                bot.database.adjust_balance(
                    guild_id(interaction),
                    interaction.user.id,
                    item.price,
                    "shop purchase refund",
                )
            except Exception:
                logger.exception("Could not refund failed shop role reward for item %s", item_id)
                await interaction.response.send_message(
                    "Your purchase was charged, but I could not grant the role reward. "
                    "Please contact a server admin.",
                    ephemeral=True,
                )
                return
            await interaction.response.send_message(
                "The role reward could not be granted, so your credits were refunded. "
                "Please contact a server admin.",
                ephemeral=True,
            )
            return

    await interaction.response.send_message(
        f"You purchased **{item.name}** for **{format_amount(item.price)}**. "
        f"Your new balance is **{format_amount(new_balance)}**."
    )


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


@economy_shop_group.command(name="add", description="Add an item to the server shop")
@app_commands.checks.has_permissions(manage_guild=True)
@app_commands.describe(
    name="The item name",
    price="The item's price in credits",
    role="An optional role to grant when purchased",
)
async def economy_shop_add(
    interaction: discord.Interaction,
    name: app_commands.Range[str, 1, 100],
    price: app_commands.Range[int, 1, 10_000_000],
    role: discord.Role | None = None,
) -> None:
    if not await ensure_guild(interaction):
        return
    if role is not None and not role_reward_is_available(interaction.guild, role):
        await interaction.response.send_message(
            "I cannot assign that role. Move it below my highest role and ensure I have Manage Roles.",
            ephemeral=True,
        )
        return
    try:
        item = bot.database.create_shop_item(
            guild_id(interaction),
            name,
            price,
            role.id if role else None,
        )
    except ValueError as error:
        await interaction.response.send_message(str(error), ephemeral=True)
        return
    reward = f" and grants {role.mention}" if role else ""
    await interaction.response.send_message(
        f"Added shop item **#{item.id} — {item.name}** for **{format_amount(item.price)}**{reward}."
    )


@economy_shop_group.command(name="edit", description="Edit an item in the server shop")
@app_commands.checks.has_permissions(manage_guild=True)
@app_commands.describe(
    item_id="The item number shown by /shop list",
    name="The new item name",
    price="The new price in credits",
    role="The new role reward",
    clear_role="Remove the current role reward",
)
@app_commands.rename(item_id="item")
async def economy_shop_edit(
    interaction: discord.Interaction,
    item_id: app_commands.Range[int, 1, 2_147_483_647],
    name: app_commands.Range[str, 1, 100] | None = None,
    price: app_commands.Range[int, 1, 10_000_000] | None = None,
    role: discord.Role | None = None,
    clear_role: bool = False,
) -> None:
    if not await ensure_guild(interaction):
        return
    if role is not None and clear_role:
        await interaction.response.send_message(
            "Choose a role or clear the role reward, not both.",
            ephemeral=True,
        )
        return
    if name is None and price is None and role is None and not clear_role:
        await interaction.response.send_message(
            "Provide a new name, price, role, or set clear_role to true.",
            ephemeral=True,
        )
        return
    if role is not None and not role_reward_is_available(interaction.guild, role):
        await interaction.response.send_message(
            "I cannot assign that role. Move it below my highest role and ensure I have Manage Roles.",
            ephemeral=True,
        )
        return
    try:
        item = bot.database.update_shop_item(
            guild_id(interaction),
            item_id,
            name=name,
            price=price,
            role_id=None if clear_role else (role.id if role else EconomyDatabase._UNSET),
        )
    except ValueError as error:
        await interaction.response.send_message(str(error), ephemeral=True)
        return
    if item is None:
        await interaction.response.send_message(
            "That shop item does not exist.",
            ephemeral=True,
        )
        return
    reward = " with no role reward"
    if item.role_id is not None:
        reward_role = shop_role(interaction.guild, item.role_id)
        reward = f" granting {reward_role.mention}" if reward_role else ""
    await interaction.response.send_message(
        f"Updated shop item **#{item.id} — {item.name}** to **{format_amount(item.price)}**{reward}."
    )


@economy_shop_group.command(name="remove", description="Remove an item from the server shop")
@app_commands.checks.has_permissions(manage_guild=True)
@app_commands.describe(item_id="The item number shown by /shop list")
@app_commands.rename(item_id="item")
async def economy_shop_remove(
    interaction: discord.Interaction,
    item_id: app_commands.Range[int, 1, 2_147_483_647],
) -> None:
    if not await ensure_guild(interaction):
        return
    item = bot.database.get_shop_item(guild_id(interaction), item_id)
    if item is None:
        await interaction.response.send_message(
            "That shop item does not exist.",
            ephemeral=True,
        )
        return
    bot.database.delete_shop_item(guild_id(interaction), item_id)
    await interaction.response.send_message(
        f"Removed shop item **#{item.id} — {item.name}**."
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
bot.tree.add_command(shop_group)


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