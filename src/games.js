import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import { formatAmount } from "./economy.js";

const activeMines = new Map();
const activeWheels = new Map();
const activeAviator = new Map();

const gameKey = (guildId, userId) => `${guildId}:${userId}`;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function amount(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function gameContext(message) {
  if (!message.guildId) throw new Error("Games can only be played inside a server.");
  return { guildId: message.guildId, userId: message.author.id, key: gameKey(message.guildId, message.author.id) };
}

function minesRows(state) {
  const rows = [];
  for (let row = 0; row < 3; row += 1) {
    rows.push(
      new ActionRowBuilder().addComponents(
        ...[0, 1, 2].map((column) => {
          const position = row * 3 + column;
          const opened = state.opened.has(position);
          const button = new ButtonBuilder()
            .setCustomId(`mines:${state.guildId}:${state.userId}:${position}`)
            .setLabel(opened ? "💎" : state.ended && state.mines.has(position) ? "💣" : "❓")
            .setStyle(opened ? ButtonStyle.Success : state.ended && state.mines.has(position) ? ButtonStyle.Danger : ButtonStyle.Secondary)
            .setDisabled(opened || state.ended);
          return button;
        }),
      ),
    );
  }
  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`mines-cashout:${state.guildId}:${state.userId}`)
        .setLabel("💵 Cash Out")
        .setStyle(ButtonStyle.Success)
        .setDisabled(state.ended),
    ),
  );
  return rows;
}

export async function startMines(message, store, rawBet, rawMines = 3) {
  const bet = amount(rawBet);
  const minesCount = Number(rawMines);
  if (!bet) return message.reply("❌ Bet must be a positive whole number.");
  if (!Number.isInteger(minesCount) || minesCount < 1 || minesCount > 8) return message.reply("❌ Mines must be between 1 and 8.");
  const context = gameContext(message);
  if (activeMines.has(context.key)) return message.reply("❌ You already have an active Mines game.");
  const placed = store.placeBet(context.guildId, context.userId, bet, "mines bet");
  if (!placed.success) return message.reply(`❌ You only have **${formatAmount(placed.account.balance)}** in cash.`);
  const positions = [...Array(9).keys()].sort(() => Math.random() - 0.5).slice(0, minesCount);
  const state = {
    ...context,
    bet,
    mines: new Set(positions),
    opened: new Set(),
    multiplier: 1,
    ended: false,
    message: null,
  };
  activeMines.set(context.key, state);
  const sent = await message.reply({
    embeds: [
      new EmbedBuilder().setTitle("💣 Mines").setDescription(
        `${message.author}\n\n💰 Bet: **${formatAmount(bet)}**\n💣 Mines: **${minesCount}**\n💵 Cash Out: **${formatAmount(0)} (0.00x)**`,
      ),
    ],
    components: minesRows(state),
  });
  state.message = sent;
}

function wheelEmbed(message, title, description, color = 0x5865f2) {
  return new EmbedBuilder().setTitle(title).setDescription(description).setColor(color);
}

export async function startWheel(message, store, rawBet) {
  const bet = amount(rawBet);
  if (!bet) return message.reply("❌ Bet must be a positive whole number.");
  const context = gameContext(message);
  if (activeWheels.has(context.key)) return message.reply("❌ You already have an active Mega Wheel.");
  const placed = store.placeBet(context.guildId, context.userId, bet, "megawheel bet");
  if (!placed.success) return message.reply(`❌ You only have **${formatAmount(placed.account.balance)}** in cash.`);
  const state = { ...context, bet, spinning: false, ended: false, message: null };
  activeWheels.set(context.key, state);
  const sent = await message.reply({
    embeds: [wheelEmbed(message, "🎡 MEGA WHEEL", `${message.author} started a wheel.\n\n💰 Bet: **${formatAmount(bet)}**\nPress **🎡 SPIN**.`)],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`wheel:${context.guildId}:${context.userId}`).setLabel("🎡 SPIN").setStyle(ButtonStyle.Primary),
      ),
    ],
  });
  state.message = sent;
}

async function runAviator(state, store) {
  state.crashPoint = Number((1.1 + Math.random() * 6.9).toFixed(2));
  while (!state.ended && state.multiplier < state.crashPoint) {
    state.multiplier = Number((state.multiplier + 0.05).toFixed(2));
    try {
      await state.message.edit({
        embeds: [
          wheelEmbed(
            state.message,
            "✈️ AVIATOR",
            `<@${state.userId}>\n\n✈️ **Plane is flying...**\n\n📈 Multiplier: **${state.multiplier.toFixed(2)}x**\n💰 Bet: **${formatAmount(state.bet)}**\n💵 Cash Out: **${formatAmount(Math.floor(state.bet * state.multiplier))}**`,
          ),
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`aviator:${state.guildId}:${state.userId}`).setLabel("💰 CASH OUT").setStyle(ButtonStyle.Success).setDisabled(state.ended),
          ),
        ],
      });
    } catch {
      state.ended = true;
      activeAviator.delete(state.key);
      return;
    }
    await sleep(350);
  }
  if (state.ended) return;
  state.ended = true;
  activeAviator.delete(state.key);
  try {
    await state.message.edit({
      embeds: [
        wheelEmbed(
          state.message,
          "💥 CRASH!",
          `<@${state.userId}>\n\n✈️ The plane crashed!\n\n💥 Crash Point: **${state.crashPoint.toFixed(2)}x**\n💸 Lost: **${formatAmount(state.bet)}**`,
          0xed4245,
        ),
      ],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`aviator-ended:${state.guildId}:${state.userId}`).setLabel("💰 CASH OUT").setStyle(ButtonStyle.Secondary).setDisabled(true),
        ),
      ],
    });
  } catch {
    // The bet remains settled as a crash if the message was deleted.
  }
}

export async function startAviator(message, store, rawBet) {
  const bet = amount(rawBet);
  if (!bet) return message.reply("❌ Bet must be a positive whole number.");
  const context = gameContext(message);
  if (activeAviator.has(context.key)) return message.reply("❌ You already have an Aviator game running.");
  const placed = store.placeBet(context.guildId, context.userId, bet, "aviator bet");
  if (!placed.success) return message.reply(`❌ You only have **${formatAmount(placed.account.balance)}** in cash.`);
  const state = { ...context, bet, multiplier: 1, ended: false, message: null };
  activeAviator.set(context.key, state);
  const sent = await message.reply({
    embeds: [wheelEmbed(message, "✈️ AVIATOR", `${message.author}\n\n✈️ **Plane is taking off!**\n\n💰 Bet: **${formatAmount(bet)}**\n📈 Multiplier: **1.00x**\n\nPress **CASH OUT** before the plane crashes.`)],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`aviator:${context.guildId}:${context.userId}`).setLabel("💰 CASH OUT").setStyle(ButtonStyle.Success),
      ),
    ],
  });
  state.message = sent;
  void runAviator(state, store);
}

export async function handleGameInteraction(interaction, store) {
  const [type, guildId, userId, position] = interaction.customId.split(":");
  const key = gameKey(guildId, userId);
  if (interaction.user.id !== userId) {
    await interaction.reply({ content: "❌ This is not your game!", ephemeral: true });
    return true;
  }

  if (type === "mines" || type === "mines-cashout") {
    const state = activeMines.get(key);
    if (!state) {
      await interaction.reply({ content: "❌ You don't have an active Mines game.", ephemeral: true });
      return true;
    }
    if (type === "mines-cashout") {
      const winnings = Math.floor(state.bet * state.multiplier);
      state.ended = true;
      activeMines.delete(key);
      store.payout(guildId, userId, winnings, "mines cash out");
      await interaction.update({
        embeds: [wheelEmbed(interaction.message, "💵 CASH OUT!", `<@${userId}>\n\n📈 Multiplier: **${state.multiplier.toFixed(2)}x**\n💰 Cashed out: **${formatAmount(winnings)}**`, 0x57f287)],
        components: minesRows(state),
      });
      return true;
    }
    const square = Number(position);
    if (state.opened.has(square)) {
      await interaction.reply({ content: "⚠️ You already opened this!", ephemeral: true });
      return true;
    }
    if (state.mines.has(square)) {
      state.ended = true;
      activeMines.delete(key);
      await interaction.update({
        embeds: [wheelEmbed(interaction.message, "💣 BOOM!", `<@${userId}>\n\n💥 You hit a mine!\n💸 Lost: **${formatAmount(state.bet)}**`, 0xed4245)],
        components: minesRows(state),
      });
      return true;
    }
    state.opened.add(square);
    state.multiplier = Number((state.multiplier * 1.41).toFixed(2));
    if (state.opened.size >= 9 - state.mines.size) {
      state.ended = true;
      activeMines.delete(key);
      const winnings = Math.floor(state.bet * state.multiplier);
      store.payout(guildId, userId, winnings, "mines win");
      await interaction.update({
        embeds: [wheelEmbed(interaction.message, "🏆 MINES WIN!", `<@${userId}>\n\n💎 All safe squares found!\n📈 Multiplier: **${state.multiplier.toFixed(2)}x**\n💰 Won: **${formatAmount(winnings)}**`, 0xfee75c)],
        components: minesRows(state),
      });
      return true;
    }
    await interaction.update({
      embeds: [wheelEmbed(interaction.message, "💣 Mines", `<@${userId}>\n\n💰 Bet: **${formatAmount(state.bet)}**\n💵 Cash Out: **${formatAmount(Math.floor(state.bet * state.multiplier))}** (${state.multiplier.toFixed(2)}x)\n\n💎 Safe: **${state.opened.size}**`)],
      components: minesRows(state),
    });
    return true;
  }

  if (type === "wheel") {
    const state = activeWheels.get(key);
    if (!state) {
      await interaction.reply({ content: "❌ You don't have an active Mega Wheel.", ephemeral: true });
      return true;
    }
    if (state.spinning) {
      await interaction.reply({ content: "⚠️ The wheel is already spinning.", ephemeral: true });
      return true;
    }
    state.spinning = true;
    await interaction.update({ content: "🎡 **Wheel is spinning...**\n\n🔄 🔄 🔄 🔄 🔄", embeds: [], components: [] });
    await sleep(2_000);
    const outcomes = [
      ["💀", 0, 30], ["1.2x", 1.2, 20], ["1.5x", 1.5, 15], ["2x", 2, 12],
      ["3x", 3, 8], ["5x", 5, 5], ["7x", 7, 2], ["10x", 10, 1],
    ];
    const totalWeight = outcomes.reduce((sum, outcome) => sum + outcome[2], 0);
    let roll = Math.random() * totalWeight;
    let result = outcomes[0];
    for (const outcome of outcomes) {
      roll -= outcome[2];
      if (roll <= 0) {
        result = outcome;
        break;
      }
    }
    const [symbol, multiplier] = result;
    const winnings = Math.floor(state.bet * multiplier);
    state.ended = true;
    activeWheels.delete(key);
    if (winnings > 0) store.payout(guildId, userId, winnings, "megawheel payout");
    await interaction.message.edit({
      content: null,
      embeds: [wheelEmbed(interaction.message, "🎡 MEGA WHEEL", `<@${userId}>\n\n🎯 Result: **${symbol}**\n\n${multiplier === 0 ? `💥 **BOOM!** You lost **${formatAmount(state.bet)}**.` : `🎉 You won **${formatAmount(winnings)}** at **${multiplier}x**!`}`, multiplier === 0 ? 0xed4245 : 0xfee75c)],
      components: [],
    });
    return true;
  }

  if (type === "aviator") {
    const state = activeAviator.get(key);
    if (!state || state.ended) {
      await interaction.reply({ content: "❌ No active Aviator game.", ephemeral: true });
      return true;
    }
    const winnings = Math.floor(state.bet * state.multiplier);
    state.ended = true;
    activeAviator.delete(key);
    store.payout(guildId, userId, winnings, "aviator cash out");
    await interaction.update({
      embeds: [wheelEmbed(interaction.message, "✈️ AVIATOR", `<@${userId}>\n\n💰 Bet: **${formatAmount(state.bet)}**\n📈 Cash Out: **${state.multiplier.toFixed(2)}x**\n\n🎉 You won **${formatAmount(winnings)}**!`, 0x57f287)],
      components: [],
    });
    return true;
  }

  return false;
}