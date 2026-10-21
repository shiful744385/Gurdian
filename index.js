import { createServer } from "node:http";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
} from "discord.js";
import { handleVerificationButton } from "./src/security/commands.js";
import { GuardianLogs } from "./src/security/guardian-logs.js";
import { SecurityMonitor } from "./src/security/monitor.js";
import { handleSecurityPrefixMessage } from "./src/security/prefix-commands.js";
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
  const routes = [Routes.applicationCommands(clientId)];
  if (guildId) routes.push(Routes.applicationGuildCommands(clientId, guildId));
  await Promise.all(routes.map((route) => rest.put(route, { body: [] })));
  console.log("Removed slash commands; use ?r for server security commands");
}

client.once("ready", async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  await registerSlashCommands();
});

client.on("interactionCreate", async (interaction) => {
  if (interaction.isButton() && interaction.customId.startsWith("security:verify:")) {
    await handleVerificationButton(interaction, securityStore).catch((error) => {
      console.error("Verification button error:", error);
      void guardianLogs.logToGuild(interaction.guild, {
        title: "Verification button error",
        description: `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`,
        severity: "high",
      });
      if (interaction.replied || interaction.deferred) {
        void interaction.followUp({ content: "❌ Verification failed.", ephemeral: true }).catch(() => {});
      } else {
        void interaction.reply({ content: "❌ Verification failed.", ephemeral: true }).catch(() => {});
      }
    });
    return;
  }
  if (interaction.isChatInputCommand()) {
    await interaction.reply({
      content: "Slash commands are disabled. Use `?r help` for server security commands.",
      ephemeral: true,
    }).catch(() => {});
  }
});

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guildId) return;
  await handleSecurityPrefixMessage(message, {
    client,
    securityStore,
    monitor: securityMonitor,
    guardianLogs,
  });
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