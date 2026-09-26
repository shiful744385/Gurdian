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

const token = process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;

if (!token) {
  throw new Error("Missing DISCORD_TOKEN");
}
if (!clientId) {
  throw new Error("Missing CLIENT_ID");
}

const store = new EconomyStore(process.env.ECONOMY_DATABASE_PATH || "data/economy.sqlite3");
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

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
  await rest.put(route, { body: slashCommands() });
  console.log(guildId ? `Registered commands in guild ${guildId}` : "Registered global commands");
}

client.once("ready", async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  await registerSlashCommands();
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isButton()) {
      await handleGameInteraction(interaction, store);
      return;
    }
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(interaction, { store, client });
    }
  } catch (error) {
    console.error("Interaction error:", error);
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
    await message.reply("❌ Something went wrong while running that command.").catch(() => {});
  }
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down`);
  client.destroy();
  if (healthServer) {
    await new Promise((resolve) => healthServer.close(resolve));
  }
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

startHealthServer();
client.login(token).catch(async (error) => {
  console.error("Discord login failed:", error);
  await shutdown("login failure");
  process.exitCode = 1;
});