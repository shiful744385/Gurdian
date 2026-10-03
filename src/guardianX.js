
const {
  Client,
  GatewayIntentBits,
  PermissionsBitField,
  AuditLogEvent,
  EmbedBuilder,
  SlashCommandBuilder,
  REST,
  Routes
} = require("discord.js");

const TOKEN = process.env.SECURITY_BOT_TOKEN;
const CLIENT_ID = process.env.SECURITY_CLIENT_ID;
const GUILD_ID = process.env.SECURITY_GUILD_ID;
const LOG_CHANNEL_ID = process.env.SECURITY_LOG_CHANNEL_ID;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  throw new Error("Please configure Discord Secrets in Replit.");
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const trusted = new Set(
  (process.env.SECURITY_TRUSTED_USERS || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean)
);

const events = new Map();
const joins = new Map();
const messages = new Map();

const DRY_RUN = true;

async function securityLog(guild, title, description) {
  console.log(`[GuardianX] ${title}: ${description}`);

  if (!LOG_CHANNEL_ID) return;

  const channel = await guild.channels
    .fetch(LOG_CHANNEL_ID)
    .catch(() => null);

  if (!channel || !channel.isTextBased()) return;

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setTitle(title)
        .setDescription(description.slice(0, 4000))
        .setColor(0xe74c3c)
        .setTimestamp()
    ]
  }).catch(console.error);
}

function countEvent(map, key, windowMs) {
  const now = Date.now();

  const list = (map.get(key) || [])
    .filter(t => now - t < windowMs);

  list.push(now);
  map.set(key, list);

  return list.length;
}

async function findActor(guild, type, targetId) {
  try {
    const audit = await guild.fetchAuditLogs({
      type,
      limit: 10
    });

    const entry = audit.entries.find(e =>
      e.target?.id === targetId &&
      Date.now() - e.createdTimestamp < 8000
    );

    return entry?.executor || null;
  } catch {
    return null;
  }
}

async function respondToThreat(guild, actor, action) {
  if (!actor) {
    return securityLog(
      guild,
      "Unknown Actor",
      `Could not verify actor for ${action}. Manual review required.`
    );
  }

  await securityLog(
    guild,
    "Security Alert",
    `Action: ${action}\nUser: ${actor.tag}\nID: ${actor.id}`
  );

  if (actor.id === guild.ownerId || trusted.has(actor.id)) {
    return securityLog(
      guild,
      "Trusted User",
      "No automatic punishment was performed."
    );
  }

  if (DRY_RUN) {
    return securityLog(
      guild,
      "Dry Run",
      "Threat detected. No punishment performed."
    );
  }

  const member = await guild.members
    .fetch(actor.id)
    .catch(() => null);

  if (!member || !member.moderatable) return;

  await member.timeout(
    10 * 60 * 1000,
    `GuardianX: ${action}`
  ).catch(console.error);
}

// Anti-nuke: channel deletion

client.on("channelDelete", async channel => {
  if (!channel.guild) return;

  const actor = await findActor(
    channel.guild,
    AuditLogEvent.ChannelDelete,
    channel.id
  );

  if (!actor) {
    return securityLog(
      channel.guild,
      "Channel Deleted",
      "Actor could not be verified."
    );
  }

  const n = countEvent(
    events,
    `${channel.guild.id}:${actor.id}:channelDelete`,
    15000
  );

  if (n >= 3) {
    await respondToThreat(
      channel.guild,
      actor,
      `Deleted ${n} channels within 15 seconds`
    );
  }
});

// Anti-nuke: role deletion

client.on("roleDelete", async role => {
  const actor = await findActor(
    role.guild,
    AuditLogEvent.RoleDelete,
    role.id
  );

  if (!actor) return;

  const n = countEvent(
    events,
    `${role.guild.id}:${actor.id}:roleDelete`,
    15000
  );

  if (n >= 3) {
    await respondToThreat(
      role.guild,
      actor,
      `Deleted ${n} roles within 15 seconds`
    );
  }
});

// Anti-raid

client.on("guildMemberAdd", async member => {
  const n = countEvent(
    joins,
    member.guild.id,
    20000
  );

  const age = Date.now() - member.user.createdTimestamp;
  const sevenDays = 7 * 24 * 60 * 60 * 1000;

  if (age < sevenDays) {
    await securityLog(
      member.guild,
      "New Account",
      `${member.user.tag} joined with an account less than 7 days old.`
    );
  }

  if (n >= 10) {
    await securityLog(
      member.guild,
      "Possible Raid",
      `${n} users joined within 20 seconds.`
    );
  }
});

// Anti-spam

client.on("messageCreate", async message => {
  if (!message.guild || message.author.bot) return;

  if (message.member?.permissions.has(
    PermissionsBitField.Flags.ManageMessages
  )) return;

  if (trusted.has(message.author.id)) return;

  const n = countEvent(
    messages,
    `${message.guild.id}:${message.author.id}`,
    10000
  );

  if (n >= 7 || message.mentions.users.size >= 5) {
    await securityLog(
      message.guild,
      "Spam Alert",
      `${message.author.tag} sent excessive messages or mentions.`
    );

    if (!DRY_RUN) {
      await message.delete().catch(() => null);
    }
  }

  if (/discord\.gg\/[a-zA-Z0-9-]+/i.test(message.content)) {
    await securityLog(
      message.guild,
      "Invite Link",
      `Invite link detected from ${message.author.tag}.`
    );
  }
});

// Slash commands

const commands = [
  new SlashCommandBuilder()
    .setName("security")
    .setDescription("GuardianX Security")
    .addSubcommand(s =>
      s.setName("status")
        .setDescription("Show security status")
    )
    .addSubcommand(s =>
      s.setName("test")
        .setDescription("Test security logging")
    )
].map(c => c.toJSON());

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "security") return;

  if (!interaction.memberPermissions?.has(
    PermissionsBitField.Flags.Administrator
  )) {
    return interaction.reply({
      content: "Administrator permission required.",
      ephemeral: true
    });
  }

  if (interaction.options.getSubcommand() === "status") {
    return interaction.reply({
      content:
        `GuardianX Online\n` +
        `Dry Run: ${DRY_RUN}\n` +
        `Anti-nuke: Active\n` +
        `Anti-raid: Active\n` +
        `Anti-spam: Active`,
      ephemeral: true
    });
  }

  await securityLog(
    interaction.guild,
    "Security Test",
    `Test requested by ${interaction.user.tag}`
  );

  await interaction.reply({
    content: "GuardianX security test completed.",
    ephemeral: true
  });
});

client.once("ready", async () => {
  console.log(`GuardianX online: ${client.user.tag}`);

  const rest = new REST({ version: "10" }).setToken(TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );

  console.log("Security commands registered.");
});

client.login(TOKEN);
