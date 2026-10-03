import { createServer } from "node:http";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
} from "discord.js";
import { EconomyStore } from "./src/economy.js";
import { handlePrefixMessage, handleSlashCommand, slashCommands } from "./src/commands.js";
import { handleGameInteraction, startAviator, startMines, startWheel } from "./src/games.js";
import { handleSecurityCommand, handleVerificationButton, securityCommandData } from "./src/security/commands.js";
import { GuardianLogs } from "./src/security/guardian-logs.js";
import { SecurityMonitor } from "./src/security/monitor.js";
import { SecurityStore } from "./src/security/store.js";

const token = process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;
const guildMembersIntentEnabled = process.env.DISCORD_GUILD_MEMBERS_INTENT === "true";

if (!token) {
  throw new Error("Missing DISCORD_TOKEN");
}
if (!clientId) {
  throw new Error("Missing CLIENT_ID");
}

const store = new EconomyStore(process.env.ECONOMY_DATABASE_PATH || "data/economy.sqlite3");
const securityStore = new SecurityStore(process.env.ECONOMY_DATABASE_PATH || "data/economy.sqlite3");
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildWebhooks,
    GatewayIntentBits.GuildInvites,
    ...(guildMembersIntentEnabled ? [GatewayIntentBits.GuildMembers] : []),
  ],
});
const guardianLogs = new GuardianLogs(client, {
  memberJoinMonitoringEnabled: guildMembersIntentEnabled,
});
guardianLogs.start();
const securityMonitor = new SecurityMonitor(client, securityStore, {
  memberJoinMonitoringEnabled: guildMembersIntentEnabled,
  guardianLogs,
});
securityMonitor.start();

const healthPort = process.env.PORT ? Number(process.env.PORT) : null;
let healthServer;

function startHealthServer() {
  if (healthPort == null) return;
  if (!Number.isInteger(healthPort) || healthPort <= 0) {
    throw new Error(`Invalid PORT value: "${process.env.PORT}"`);
  }

  healthServer = createServer((request, response) => {
    if (request.url !== "/healthz" || !["GET", "HEAD"].includes(request.method ?? "")) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    const body = JSON.stringify({
      service: "discord-economy-bot",
      status: client.isReady() ? "ready" : "starting",
    });
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    });
    response.end(request.method === "HEAD" ? undefined : body);
  });

  healthServer.listen(healthPort, "0.0.0.0", () => {
    console.log(`Health server listening on port ${healthPort}`);
  });
}

async function registerSlashCommands() {
  const rest = new REST({ version: "10" }).setToken(token);
  const route = guildId
    ? Routes.applicationGuildCommands(clientId, guildId)
    : Routes.applicationCommands(clientId);
  await rest.put(route, { body: [...slashCommands(), securityCommandData] });
  console.log(guildId ? `Registered commands in guild ${guildId}` : "Registered global commands");
}

client.once("ready", async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  await registerSlashCommands();
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isButton()) {
      if (interaction.customId.startsWith("security:verify:")) {
        await handleVerificationButton(interaction, securityStore);
        return;
      }
      await handleGameInteraction(interaction, store);
      return;
    }
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "security") {
        await handleSecurityCommand(interaction, { securityStore, monitor: securityMonitor });
        return;
      }
      await handleSlashCommand(interaction, { store, client });
    }
  } catch (error) {
    console.error("Interaction error:", error);
    void guardianLogs.logToGuild(interaction.guild, {
      title: "Bot command error",
      description: `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`,
      severity: "high",
    });
    const payload = { content: "❌ Something went wrong while running that command.", ephemeral: true };
    if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => {});
    else await interaction.reply(payload).catch(() => {});
  }
});

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.content.startsWith("o ")) return;
  const input = message.content.slice(2).trim();
  const [command, ...args] = input.split(/\s+/);
  try {
    if (command.toLowerCase() === "aviator") {
      await startAviator(message, store, args[0]);
      return;
    }
    if (command.toLowerCase() === "mines") {
      await startMines(message, store, args[0], args[1] ?? 3);
      return;
    }
    if (command.toLowerCase() === "megawheel") {
      await startWheel(message, store, args[0]);
      return;
    }
    await handlePrefixMessage(message, { store, client });
  } catch (error) {
    console.error("Prefix command error:", error);
    void guardianLogs.logToGuild(message.guild, {
      title: "Bot command error",
      description: `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`,
      severity: "high",
    });
    await message.reply("❌ Something went wrong while running that command.").catch(() => {});
  }
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down`);
  client.destroy();
  securityStore.close();
  if (healthServer) {
    await new Promise((resolve) => healthServer.close(resolve));
  }
}

process.once("uncaughtException", (error) => {
  console.error("Fatal uncaught exception:", error);
  void guardianLogs
    .logToAllGuilds(
      "Fatal process error",
      `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`,
      "critical",
    )
    .finally(() => shutdown("uncaught exception").finally(() => process.exit(1)));
});

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

startHealthServer();
client.login(token).catch(async (error) => {
  console.error("Discord login failed:", error);
  await shutdown("login failure");
  process.exitCode = 1;
});