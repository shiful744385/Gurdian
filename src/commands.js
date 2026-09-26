import {
  SlashCommandBuilder,
} from "discord.js";
import { formatAmount, formatDuration } from "./economy.js";

export function slashCommands() {
  return [
    new SlashCommandBuilder()
      .setName("balance")
      .setDescription("Check your cash, bank, and total balance"),
    new SlashCommandBuilder().setName("daily").setDescription("Claim your daily reward"),
    new SlashCommandBuilder().setName("work").setDescription("Work for credits"),
    new SlashCommandBuilder()
      .setName("deposit")
      .setDescription("Move cash into your bank")
      .addIntegerOption((option) =>
        option.setName("amount").setDescription("Amount to deposit").setRequired(true).setMinValue(1),
      ),
    new SlashCommandBuilder()
      .setName("withdraw")
      .setDescription("Move credits from your bank into cash")
      .addIntegerOption((option) =>
        option.setName("amount").setDescription("Amount to withdraw").setRequired(true).setMinValue(1),
      ),
    new SlashCommandBuilder()
      .setName("give")
      .setDescription("Give cash credits to another member")
      .addUserOption((option) =>
        option.setName("user").setDescription("Member to receive credits").setRequired(true),
      )
      .addIntegerOption((option) =>
        option.setName("amount").setDescription("Amount to give").setRequired(true).setMinValue(1),
      ),
    new SlashCommandBuilder()
      .setName("coinflip")
      .setDescription("Bet credits on heads or tails")
      .addIntegerOption((option) =>
        option.setName("amount").setDescription("Amount to bet").setRequired(true).setMinValue(1),
      )
      .addStringOption((option) =>
        option
          .setName("choice")
          .setDescription("Your choice")
          .setRequired(true)
          .addChoices({ name: "Heads", value: "heads" }, { name: "Tails", value: "tails" }),
      ),
    new SlashCommandBuilder().setName("leaderboard").setDescription("Show the richest members"),
  ].map((command) => command.toJSON());
}

function guildContext(interactionOrMessage) {
  if (!interactionOrMessage.guildId) {
    return { error: "This command can only be used inside a server." };
  }
  return { guildId: interactionOrMessage.guildId };
}

function memberLabel(client, guildId, userId) {
  const guild = client.guilds.cache.get(guildId);
  const member = guild?.members.cache.get(userId);
  return member?.displayName ?? `<@${userId}>`;
}

function parseAmount(value) {
  if (!/^\d+$/.test(String(value ?? ""))) return null;
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

function replyTarget(target, payload) {
  if (typeof target.isChatInputCommand === "function") {
    return target.reply(payload);
  }
  const { ephemeral: _ephemeral, ...messagePayload } = payload;
  return target.reply(messagePayload);
}

function accountText(account) {
  return (
    `💵 Cash: **${formatAmount(account.balance)}**\n` +
    `🏦 Bank: **${formatAmount(account.bankBalance)}**\n` +
    `💰 Total: **${formatAmount(account.total)}**`
  );
}

async function executeCommand({ commandName, options, target, store, client }) {
  const context = guildContext(target);
  if (context.error) return replyTarget(target, { content: context.error, ephemeral: true });
  const { guildId } = context;
  const author = target.user ?? target.author;
  const userId = author.id;

  if (commandName === "balance" || commandName === "cash") {
    const account = store.account(guildId, userId);
    return replyTarget(target, {
      content: `💰 **${author.username}'s balance**\n${accountText(account)}`,
    });
  }

  if (commandName === "daily") {
    const result = store.daily(guildId, userId);
    if (!result.claimed) {
      return replyTarget(target, {
        content: `⏳ You already claimed daily. Try again in **${formatDuration(result.remaining)}**.`,
        ephemeral: true,
      });
    }
    return replyTarget(target, {
      content: `🎁 You claimed **${formatAmount(result.amount)}**.\n${accountText(result.account)}`,
    });
  }

  if (commandName === "work") {
    const result = store.work(guildId, userId);
    if (!result.worked) {
      return replyTarget(target, {
        content: `⏳ You are still working. Try again in **${formatDuration(result.remaining)}**.`,
        ephemeral: true,
      });
    }
    return replyTarget(target, {
      content: `🛠️ You earned **${formatAmount(result.amount)}**.\n${accountText(result.account)}`,
    });
  }

  if (commandName === "deposit" || commandName === "withdraw") {
    const amount = parseAmount(options.amount);
    if (!amount) return replyTarget(target, { content: "❌ Amount must be a positive whole number.", ephemeral: true });
    const result = store[commandName](guildId, userId, amount);
    if (!result.success) {
      const source = commandName === "deposit" ? result.account.balance : result.account.bankBalance;
      return replyTarget(target, {
        content: `❌ You only have **${formatAmount(source)}** available to ${commandName}.`,
        ephemeral: true,
      });
    }
    return replyTarget(target, {
      content: `${commandName === "deposit" ? "🏦 Deposited" : "💵 Withdrew"} **${formatAmount(amount)}**.\n${accountText(result.account)}`,
    });
  }

  if (commandName === "give") {
    const recipient = options.user;
    const amount = parseAmount(options.amount);
    if (!recipient || !amount) return replyTarget(target, { content: "❌ Choose a member and a positive amount.", ephemeral: true });
    if (recipient.bot) return replyTarget(target, { content: "❌ Bots cannot receive credits.", ephemeral: true });
    if (recipient.id === userId) return replyTarget(target, { content: "❌ You cannot give credits to yourself.", ephemeral: true });
    const result = store.transfer(guildId, userId, recipient.id, amount);
    if (!result.success) {
      return replyTarget(target, {
        content: `❌ You only have **${formatAmount(result.account.balance)}** in cash.`,
        ephemeral: true,
      });
    }
    return replyTarget(target, {
      content: `${target.user} gave ${recipient} **${formatAmount(amount)}**.`,
    });
  }

  if (commandName === "coinflip") {
    const amount = parseAmount(options.amount);
    const choice = String(options.choice ?? "").toLowerCase();
    if (!amount || !["heads", "tails"].includes(choice)) {
      return replyTarget(target, { content: "❌ Choose a positive amount and heads or tails.", ephemeral: true });
    }
    const result = store.coinflip(guildId, userId, amount, choice);
    if (!result.success) {
      return replyTarget(target, { content: `❌ You only have **${formatAmount(result.account.balance)}** in cash.`, ephemeral: true });
    }
    return replyTarget(target, {
      content:
        `${result.result === choice ? "🪙" : "💥"} The coin landed on **${result.result}**.\n` +
        (result.won
          ? `🎉 You won **${formatAmount(result.winnings)}**!`
          : `💸 You lost **${formatAmount(amount)}**.`) +
        `\n${accountText(result.account)}`,
    });
  }

  if (commandName === "leaderboard") {
    const rows = store.leaderboard(guildId);
    if (!rows.length) return replyTarget(target, { content: "No players have balances yet." });
    const lines = rows.map(
      (row, index) =>
        `**${index + 1}.** ${memberLabel(client, guildId, row.userId)} — **${formatAmount(row.total)}**`,
    );
    return replyTarget(target, { content: `🏆 **Leaderboard**\n${lines.join("\n")}` });
  }

  return null;
}

export async function handleSlashCommand(interaction, dependencies) {
  const options = {
    amount: interaction.options.getInteger("amount"),
    choice: interaction.options.getString("choice"),
    user: interaction.options.getUser("user"),
  };
  return executeCommand({
    commandName: interaction.commandName,
    options,
    target: interaction,
    ...dependencies,
  });
}

export async function handlePrefixMessage(message, dependencies) {
  if (message.author.bot || !message.guildId || !message.content.startsWith("o ")) return false;
  const input = message.content.slice(2).trim();
  if (!input) return false;
  const [command, ...args] = input.split(/\s+/);
  const lowerCommand = command.toLowerCase();
  const mentions = message.mentions.users;
  const options = {
    amount: args.at(-1),
    choice: args.find((value) => ["heads", "tails"].includes(value.toLowerCase())),
    user: mentions.first() ?? null,
  };
  await executeCommand({
    commandName: lowerCommand === "cash" ? "cash" : lowerCommand === "pay" ? "give" : lowerCommand,
    options,
    target: message,
    ...dependencies,
  });
  return true;
}

export { parseAmount };