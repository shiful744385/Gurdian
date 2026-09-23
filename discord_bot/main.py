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
MINES_SQUARES = 9
MINES_MULTIPLIER_STEP = 1.41


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
active_mines_games: dict[tuple[int, int], dict[str, object]] = {}
active_wheels: dict[tuple[int, int], "WheelView"] = {}
active_aviator: dict[tuple[int, int], dict[str, object]] = {}
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


class MineButton(discord.ui.Button):
    def __init__(self, position: int) -> None:
        super().__init__(
            label="❓",
            style=discord.ButtonStyle.secondary,
            row=position // 3,
        )
        self.position = position

    async def callback(self, interaction: discord.Interaction) -> None:
        view = self.view
        if not isinstance(view, MineView):
            await interaction.response.send_message(
                "❌ This Mines game is no longer available.",
                ephemeral=True,
            )
            return

        game_key = (view.guild_id, view.user_id)
        game = active_mines_games.get(game_key)
        if game is None:
            await interaction.response.send_message(
                "❌ You don't have an active Mines game!",
                ephemeral=True,
            )
            return
        if interaction.user.id != view.user_id:
            await interaction.response.send_message(
                "❌ This is not your game!",
                ephemeral=True,
            )
            return

        lock = game["lock"]
        if not isinstance(lock, asyncio.Lock):
            raise RuntimeError("Mines game lock is missing")
        async with lock:
            if self.position in game["opened"]:
                await interaction.response.send_message(
                    "⚠️ You already opened this!",
                    ephemeral=True,
                )
                return

            await interaction.response.defer()
            mines = game["mines"]
            opened = game["opened"]
            bet = game["bet"]
            if not isinstance(mines, set) or not isinstance(opened, set):
                raise RuntimeError("Mines game state is invalid")
            if not isinstance(bet, int):
                raise RuntimeError("Mines bet is invalid")

            if self.position in mines:
                for button in view.children:
                    if isinstance(button, MineButton):
                        if button.position in mines:
                            button.label = "💣"
                            button.style = discord.ButtonStyle.danger
                        elif button.position in opened:
                            button.label = "💎"
                            button.style = discord.ButtonStyle.success
                        button.disabled = True

                embed = discord.Embed(
                    title="💣 BOOM!",
                    description=(
                        f"{interaction.user.mention}\n\n"
                        f"💥 You hit a mine!\n"
                        f"💸 Lost: **{format_amount(bet)}**"
                    ),
                    color=discord.Color.red(),
                )
                active_mines_games.pop(game_key, None)
                await interaction.edit_original_response(embed=embed, view=view)
                return

            opened.add(self.position)
            self.label = "💎"
            self.style = discord.ButtonStyle.success
            self.disabled = True

            multiplier = game["multiplier"]
            if not isinstance(multiplier, float):
                raise RuntimeError("Mines multiplier is invalid")
            multiplier *= MINES_MULTIPLIER_STEP
            game["multiplier"] = multiplier
            current_win = int(bet * multiplier)

            mines_count = game["mines_count"]
            if not isinstance(mines_count, int):
                raise RuntimeError("Mines count is invalid")
            safe_count = MINES_SQUARES - mines_count

            if len(opened) >= safe_count:
                for button in view.children:
                    if isinstance(button, MineButton):
                        if button.position in mines:
                            button.label = "💣"
                            button.style = discord.ButtonStyle.danger
                        button.disabled = True

                bot.database.settle_mines_payout(
                    view.guild_id,
                    view.user_id,
                    current_win,
                    "mines win",
                )
                embed = discord.Embed(
                    title="🏆 MINES WIN!",
                    description=(
                        f"{interaction.user.mention}\n\n"
                        f"💎 All safe squares found!\n"
                        f"📈 Multiplier: **{multiplier:.2f}x**\n"
                        f"💰 Won: **{format_amount(current_win)}**"
                    ),
                    color=discord.Color.gold(),
                )
                active_mines_games.pop(game_key, None)
                await interaction.edit_original_response(embed=embed, view=view)
                return

            embed = discord.Embed(
                title="💣 Mines",
                description=(
                    f"{interaction.user.mention}\n\n"
                    f"💰 Bet: **{format_amount(bet)}**\n"
                    f"💵 Cash Out: **{format_amount(current_win)}** "
                    f"(**{multiplier:.2f}x**)\n\n"
                    f"💎 Safe: **{len(opened)}**"
                ),
                color=discord.Color.blurple(),
            )
            await interaction.edit_original_response(embed=embed, view=view)


class CashOutButton(discord.ui.Button):
    def __init__(self) -> None:
        super().__init__(
            label="💵 Cash Out",
            style=discord.ButtonStyle.success,
            row=3,
        )

    async def callback(self, interaction: discord.Interaction) -> None:
        view = self.view
        if not isinstance(view, MineView):
            await interaction.response.send_message(
                "❌ This Mines game is no longer available.",
                ephemeral=True,
            )
            return

        game_key = (view.guild_id, view.user_id)
        game = active_mines_games.get(game_key)
        if game is None:
            await interaction.response.send_message(
                "❌ You don't have an active Mines game!",
                ephemeral=True,
            )
            return
        if interaction.user.id != view.user_id:
            await interaction.response.send_message(
                "❌ This is not your game!",
                ephemeral=True,
            )
            return

        lock = game["lock"]
        if not isinstance(lock, asyncio.Lock):
            raise RuntimeError("Mines game lock is missing")
        async with lock:
            multiplier = game["multiplier"]
            bet = game["bet"]
            if not isinstance(multiplier, float) or not isinstance(bet, int):
                raise RuntimeError("Mines game state is invalid")
            current_win = int(bet * multiplier)
            bot.database.settle_mines_payout(
                view.guild_id,
                view.user_id,
                current_win,
                "mines cash out",
            )

            for button in view.children:
                button.disabled = True

            embed = discord.Embed(
                title="💵 CASH OUT!",
                description=(
                    f"{interaction.user.mention}\n\n"
                    f"📈 Multiplier: **{multiplier:.2f}x**\n"
                    f"💰 Cashed out: **{format_amount(current_win)}**"
                ),
                color=discord.Color.green(),
            )
            active_mines_games.pop(game_key, None)
            await interaction.response.edit_message(embed=embed, view=view)


class MineView(discord.ui.View):
    def __init__(
        self,
        guild_id: int,
        user_id: int,
        mines_count: int,
        bet: int,
    ) -> None:
        super().__init__(timeout=300)
        self.guild_id = guild_id
        self.user_id = user_id

        mine_positions = random.sample(range(MINES_SQUARES), mines_count)
        active_mines_games[(guild_id, user_id)] = {
            "user_id": user_id,
            "bet": bet,
            "mines": set(mine_positions),
            "opened": set(),
            "mines_count": mines_count,
            "multiplier": 1.0,
            "lock": asyncio.Lock(),
        }

        for position in range(MINES_SQUARES):
            self.add_item(MineButton(position))
        self.add_item(CashOutButton())

    async def on_timeout(self) -> None:
        game_key = (self.guild_id, self.user_id)
        game = active_mines_games.pop(game_key, None)
        if game is None:
            return
        for button in self.children:
            button.disabled = True


class WheelView(discord.ui.View):
    WHEEL_OUTCOMES = (
        ("💀", 0.0, 30),
        ("1.2x", 1.2, 20),
        ("1.5x", 1.5, 15),
        ("2x", 2.0, 12),
        ("3x", 3.0, 8),
        ("5x", 5.0, 5),
        ("7x", 7.0, 2),
        ("10x", 10.0, 1),
    )

    def __init__(self, guild_id: int, user_id: int, bet: int) -> None:
        super().__init__(timeout=60)
        self.guild_id = guild_id
        self.user_id = user_id
        self.bet = bet
        self._lock = asyncio.Lock()
        self._spinning = False

        spin_button = discord.ui.Button(
            label="🎡 SPIN",
            style=discord.ButtonStyle.primary,
        )
        spin_button.callback = self.spin
        self.add_item(spin_button)
        active_wheels[(guild_id, user_id)] = self

    async def spin(self, interaction: discord.Interaction) -> None:
        if interaction.user.id != self.user_id:
            await interaction.response.send_message(
                "❌ This is not your wheel!",
                ephemeral=True,
            )
            return

        game_key = (self.guild_id, self.user_id)
        if active_wheels.get(game_key) is not self:
            await interaction.response.send_message(
                "❌ You don't have an active Mega Wheel!",
                ephemeral=True,
            )
            return

        async with self._lock:
            if self._spinning:
                await interaction.response.send_message(
                    "⚠️ Your wheel is already spinning!",
                    ephemeral=True,
                )
                return
            self._spinning = True

            for item in self.children:
                item.disabled = True
            await interaction.response.edit_message(
                content="🎡 **Wheel is spinning...**\n\n"
                "🔄 🔄 🔄 🔄 🔄",
                embed=None,
                view=self,
            )

            await asyncio.sleep(2)

            result_index = random.choices(
                range(len(self.WHEEL_OUTCOMES)),
                weights=[outcome[2] for outcome in self.WHEEL_OUTCOMES],
                k=1,
            )[0]
            symbol, multiplier, _ = self.WHEEL_OUTCOMES[result_index]
            winnings = int(self.bet * multiplier)

            if multiplier == 0:
                result_text = (
                    "💥 **BOOM!**\n\n"
                    f"💸 You lost **{format_amount(self.bet)}**"
                )
                color = discord.Color.red()
            else:
                bot.database.settle_payout(
                    self.guild_id,
                    self.user_id,
                    winnings,
                    "megawheel payout",
                )
                result_text = (
                    f"🎉 **You won!**\n\n"
                    f"🎯 Multiplier: **{multiplier:g}x**\n"
                    f"💰 Won: **{format_amount(winnings)}**"
                )
                color = discord.Color.gold()

            active_wheels.pop(game_key, None)
            embed = discord.Embed(
                title="🎡 MEGA WHEEL",
                description=(
                    f"{interaction.user.mention}\n\n"
                    f"🎯 Result: **{symbol}**\n\n"
                    f"{result_text}"
                ),
                color=color,
            )
            await interaction.edit_original_response(
                content=None,
                embed=embed,
                view=self,
            )

    async def on_timeout(self) -> None:
        game_key = (self.guild_id, self.user_id)
        if active_wheels.pop(game_key, None) is self and not self._spinning:
            bot.database.settle_payout(
                self.guild_id,
                self.user_id,
                self.bet,
                "megawheel timeout refund",
            )
        for item in self.children:
            item.disabled = True


class AviatorView(discord.ui.View):
    def __init__(self, guild_id: int, user_id: int) -> None:
        super().__init__(timeout=None)
        self.guild_id = guild_id
        self.user_id = user_id

        cashout = discord.ui.Button(
            label="💰 CASH OUT",
            style=discord.ButtonStyle.success,
        )
        cashout.callback = self.cashout
        self.add_item(cashout)

    async def cashout(self, interaction: discord.Interaction) -> None:
        game_key = (self.guild_id, self.user_id)
        game = active_aviator.get(game_key)
        if game is None:
            await interaction.response.send_message(
                "❌ No active Aviator game!",
                ephemeral=True,
            )
            return
        if interaction.user.id != self.user_id:
            await interaction.response.send_message(
                "❌ This is not your game!",
                ephemeral=True,
            )
            return

        lock = game["lock"]
        if not isinstance(lock, asyncio.Lock):
            raise RuntimeError("Aviator game lock is missing")
        async with lock:
            if active_aviator.get(game_key) is not game:
                await interaction.response.send_message(
                    "❌ No active Aviator game!",
                    ephemeral=True,
                )
                return
            if game["cashed_out"]:
                await interaction.response.send_message(
                    "❌ You already cashed out!",
                    ephemeral=True,
                )
                return

            multiplier = game["multiplier"]
            bet = game["bet"]
            if not isinstance(multiplier, float) or not isinstance(bet, int):
                raise RuntimeError("Aviator game state is invalid")

            winnings = int(bet * multiplier)
            game["cashed_out"] = True
            bot.database.settle_payout(
                self.guild_id,
                self.user_id,
                winnings,
                "aviator cash out",
            )

            for button in self.children:
                button.disabled = True

            embed = discord.Embed(
                title="✈️ AVIATOR",
                description=(
                    f"{interaction.user.mention}\n\n"
                    f"💰 Bet: **{format_amount(bet)}**\n"
                    f"📈 Cash Out: **{multiplier:.2f}x**\n\n"
                    f"🎉 You won **{format_amount(winnings)}**!"
                ),
                color=discord.Color.green(),
            )
            active_aviator.pop(game_key, None)
            await interaction.response.edit_message(embed=embed, view=self)


async def aviator_flight(
    message: discord.Message,
    guild_id: int,
    user_id: int,
) -> None:
    game_key = (guild_id, user_id)
    game = active_aviator.get(game_key)
    if game is None:
        return

    crash_point = round(random.uniform(1.10, 8.00), 2)
    lock = game["lock"]
    if not isinstance(lock, asyncio.Lock):
        raise RuntimeError("Aviator game lock is missing")

    async with lock:
        if active_aviator.get(game_key) is not game or game["cashed_out"]:
            return
        game["crash_point"] = crash_point

    while True:
        async with lock:
            if active_aviator.get(game_key) is not game or game["cashed_out"]:
                return

            multiplier = game["multiplier"]
            bet = game["bet"]
            if not isinstance(multiplier, float) or not isinstance(bet, int):
                raise RuntimeError("Aviator game state is invalid")

            if multiplier >= crash_point:
                break

            multiplier = round(multiplier + 0.05, 2)
            game["multiplier"] = multiplier
            embed = discord.Embed(
                title="✈️ AVIATOR",
                description=(
                    f"<@{user_id}>\n\n"
                    "✈️ **Plane is flying...**\n\n"
                    f"📈 Multiplier: **{multiplier:.2f}x**\n"
                    f"💰 Bet: **{format_amount(bet)}**\n"
                    f"💵 Cash Out: **{format_amount(int(bet * multiplier))}**\n\n"
                    "👇 Cash out before the plane crashes!"
                ),
                color=discord.Color.blurple(),
            )
            try:
                await message.edit(embed=embed, view=game["view"])
            except discord.HTTPException:
                active_aviator.pop(game_key, None)
                return

        await asyncio.sleep(0.35)

    async with lock:
        if active_aviator.get(game_key) is not game or game["cashed_out"]:
            return

        for button in game["view"].children:
            button.disabled = True
        embed = discord.Embed(
            title="💥 CRASH!",
            description=(
                f"<@{user_id}>\n\n"
                "✈️ The plane crashed!\n\n"
                f"💥 Crash Point: **{crash_point:.2f}x**\n"
                f"💸 Lost: **{format_amount(game['bet'])}**\n\n"
                "😢 You didn't cash out in time."
            ),
            color=discord.Color.red(),
        )
        active_aviator.pop(game_key, None)
        try:
            await message.edit(embed=embed, view=game["view"])
        except discord.HTTPException:
            return


@bot.tree.command(name="mine", description="Play Mines and win credits")
@app_commands.describe(
    bet="Amount to bet",
    mines="Number of mines (1-8)",
)
async def mine(
    interaction: discord.Interaction,
    bet: app_commands.Range[int, 1, 10_000_000],
    mines: app_commands.Range[int, 1, 8] = 3,
) -> None:
    if not await ensure_guild(interaction):
        return

    game_key = (guild_id(interaction), interaction.user.id)
    if game_key in active_mines_games:
        await interaction.response.send_message(
            "❌ You already have an active Mines game!",
            ephemeral=True,
        )
        return

    placed, balance = bot.database.place_mines_bet(
        guild_id(interaction),
        interaction.user.id,
        bet,
    )
    if not placed:
        await interaction.response.send_message(
            f"❌ You don't have enough money!\n"
            f"💰 Your balance: **{format_amount(balance)}**",
            ephemeral=True,
        )
        return

    view = MineView(guild_id(interaction), interaction.user.id, mines, bet)
    embed = discord.Embed(
        title="💣 Mines",
        description=(
            f"{interaction.user.mention} started a Mines game.\n\n"
            f"💰 Bet: **{format_amount(bet)}**\n"
            f"💣 Mines: **{mines}**\n"
            f"💵 Cash Out: **{format_amount(0)} (0.00x)**\n"
            f"📈 Next: **{format_amount(int(bet * MINES_MULTIPLIER_STEP))} "
            f"(1.41x)**"
        ),
        color=discord.Color.blurple(),
    )
    await interaction.response.send_message(embed=embed, view=view)


@bot.tree.command(name="megawheel", description="Spin the Mega Wheel")
@app_commands.describe(bet="Amount of credits to bet")
async def megawheel(
    interaction: discord.Interaction,
    bet: app_commands.Range[int, 1, 10_000_000],
) -> None:
    if not await ensure_guild(interaction):
        return

    game_key = (guild_id(interaction), interaction.user.id)
    if game_key in active_wheels:
        await interaction.response.send_message(
            "❌ You already have an active Mega Wheel!",
            ephemeral=True,
        )
        return

    placed, balance = bot.database.place_bet(
        guild_id(interaction),
        interaction.user.id,
        bet,
        "megawheel bet",
    )
    if not placed:
        await interaction.response.send_message(
            f"❌ You don't have enough money!\n"
            f"💰 Your balance: **{format_amount(balance)}**",
            ephemeral=True,
        )
        return

    view = WheelView(guild_id(interaction), interaction.user.id, bet)
    embed = discord.Embed(
        title="🎡 MEGA WHEEL",
        description=(
            f"{interaction.user.mention} started a Mega Wheel spin.\n\n"
            f"💰 Bet: **{format_amount(bet)}**\n"
            "Press **🎡 SPIN** to spin the wheel."
        ),
        color=discord.Color.blurple(),
    )
    await interaction.response.send_message(embed=embed, view=view)


@bot.tree.command(name="aviator", description="Play Aviator crash game")
@app_commands.describe(bet="Amount of credits to bet")
async def aviator(
    interaction: discord.Interaction,
    bet: app_commands.Range[int, 1, 10_000_000],
) -> None:
    if not await ensure_guild(interaction):
        return

    game_key = (guild_id(interaction), interaction.user.id)
    if game_key in active_aviator:
        await interaction.response.send_message(
            "❌ You already have an Aviator game running!",
            ephemeral=True,
        )
        return

    placed, balance = bot.database.place_bet(
        guild_id(interaction),
        interaction.user.id,
        bet,
        "aviator bet",
    )
    if not placed:
        await interaction.response.send_message(
            f"❌ Not enough credits!\n\n"
            f"💰 Your balance: **{format_amount(balance)}**",
            ephemeral=True,
        )
        return

    view = AviatorView(guild_id(interaction), interaction.user.id)
    game = {
        "user_id": interaction.user.id,
        "bet": bet,
        "multiplier": 1.00,
        "crash_point": 0.0,
        "cashed_out": False,
        "view": view,
        "lock": asyncio.Lock(),
    }
    active_aviator[game_key] = game

    embed = discord.Embed(
        title="✈️ AVIATOR",
        description=(
            f"{interaction.user.mention}\n\n"
            "✈️ **Plane is taking off!**\n\n"
            f"💰 Bet: **{format_amount(bet)}**\n"
            "📈 Multiplier: **1.00x**\n\n"
            "💰 Press **CASH OUT** before the plane crashes!"
        ),
        color=discord.Color.blurple(),
    )
    await interaction.response.send_message(embed=embed, view=view)

    try:
        message = await interaction.original_response()
    except discord.HTTPException:
        active_aviator.pop(game_key, None)
        bot.database.settle_payout(
            guild_id(interaction),
            interaction.user.id,
            bet,
            "aviator message failure refund",
        )
        return

    asyncio.create_task(
        aviator_flight(
            message,
            guild_id(interaction),
            interaction.user.id,
        )
    )


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