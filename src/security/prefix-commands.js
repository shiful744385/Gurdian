import { handleSecurityCommand } from "./commands.js";

const HELP_TEXT = [
  "**Security commands**",
  "`?r dashboard` · `?r status` · `?r setup`",
  "`?r config setting:anti_spam enabled:false`",
  "`?r config setting:nuke_limit threshold:5`",
  "`?r config setting:log_channel channel:#security-alerts`",
  "`?r logs limit:10` · `?r lockdown` · `?r unlock`",
  "`?r whitelist action:add type:user user:@member`",
  "`?r whitelist action:add type:role role:@role`",
  "`?r whitelist action:add type:bot user:@bot`",
  "`?r protect-role action:protect role:@role`",
  "`?r protect-channel action:protect channel:#channel`",
  "`?r backup` · `?r restore backup_id:<ID> confirm:true`",
  "`?r verify channel:#verify role:@member` · `?r test`",
  "Security command results are sent to your DMs.",
].join("\n");

const BOOLEAN_SETTINGS = new Set([
  "enabled",
  "anti_nuke",
  "anti_raid",
  "anti_spam",
  "anti_webhook",
  "anti_malicious_bot",
  "role_protection",
  "channel_protection",
  "permission_monitoring",
]);

export function matchesSecurityPrefix(content) {
  return /^\?r(?:\s|$)/i.test(content.trim());
}

export function parseSecurityPrefixTokens(tokens) {
  const positional = [];
  const named = {};

  for (const token of tokens) {
    const match = token.match(/^([a-z][a-z0-9_-]*)[:=](.*)$/i);
    if (match) {
      named[match[1].toLowerCase().replaceAll("-", "_")] = match[2];
    } else {
      positional.push(token);
    }
  }

  return { positional, named };
}

export function parseSecurityPrefixInvocation(content) {
  if (!matchesSecurityPrefix(content)) return null;
  const tokens = content.trim().split(/\s+/).slice(1);
  const subcommand = (tokens.shift() ?? "help").toLowerCase().replaceAll("_", "-");
  const { positional, named } = parseSecurityPrefixTokens(tokens);
  return {
    subcommand,
    values: makeOptionValues(subcommand, positional, named),
  };
}

function entityId(value, kind) {
  if (!value) return null;
  const patterns = {
    user: /^<@!?(\d+)>$/,
    role: /^<@&(\d+)>$/,
    channel: /^<#(\d+)>$/,
  };
  return value.match(patterns[kind])?.[1] ??
    (/^\d{15,25}$/.test(value) ? value : null);
}

function parseBoolean(value) {
  if (value == null) return null;
  const normalized = value.toLowerCase();
  if (["true", "on", "yes", "1", "enable", "enabled"].includes(normalized)) return true;
  if (["false", "off", "no", "0", "disable", "disabled"].includes(normalized)) return false;
  throw new Error(`"${value}" is not a valid true/false value.`);
}

function makeOptionValues(subcommand, positional, named) {
  const values = {};
  const take = (name, index) => named[name] ?? positional[index] ?? null;

  if (subcommand === "config") {
    const setting = (take("setting", 0) ?? "").toLowerCase().replaceAll("-", "_");
    values.setting = setting || null;
    if (BOOLEAN_SETTINGS.has(setting)) {
      values.enabled = named.enabled ?? positional[1] ?? null;
    }
    if (["nuke_limit", "raid_join_limit", "spam_message_limit"].includes(setting)) {
      values.threshold = named.threshold ?? positional[1] ?? null;
    }
    if (setting === "log_channel") values.channel = named.channel ?? positional[1] ?? null;
    if (setting === "verification_role") values.role = named.role ?? positional[1] ?? null;
    values.clear = named.clear ?? null;
  } else if (subcommand === "logs") {
    values.limit = take("limit", 0);
  } else if (subcommand === "whitelist") {
    values.action = take("action", 0)?.toLowerCase() ?? null;
    values.type = take("type", 1)?.toLowerCase() ?? null;
    const target = named.user ?? named.bot ?? named.role ?? positional[2] ?? null;
    if (values.type === "role") values.role = target;
    else values.user = target;
  } else if (subcommand === "protect-role") {
    values.action = take("action", 0)?.toLowerCase() ?? null;
    values.role = named.role ?? positional[1] ?? null;
  } else if (subcommand === "protect-channel") {
    values.action = take("action", 0)?.toLowerCase() ?? null;
    values.channel = named.channel ?? positional[1] ?? null;
  } else if (subcommand === "restore") {
    values.backup_id = take("backup_id", 0);
    values.confirm = named.confirm ?? positional[1] ?? null;
  } else if (subcommand === "verify") {
    values.channel = named.channel ?? positional[0] ?? null;
    values.role = named.role ?? positional[1] ?? null;
  }

  return values;
}

function parsedInteger(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

async function resolveOptions(message, client, subcommand, values) {
  const guild = message.guild;
  const resolveUser = async (value) => {
    const id = entityId(value, "user");
    if (!id) return null;
    return message.mentions.users.get(id) ??
      await client.users.fetch(id).catch(() => null);
  };
  const resolveRole = async (value) => {
    const id = entityId(value, "role");
    if (!id) return null;
    return await guild.roles.fetch(id).catch(() => null);
  };
  const resolveChannel = async (value) => {
    const id = entityId(value, "channel");
    if (!id) return null;
    const channel = await guild.channels.fetch(id).catch(() => null);
    return channel?.guildId === guild.id ? channel : null;
  };

  if (values.user) values.user = await resolveUser(values.user);
  if (values.role) values.role = await resolveRole(values.role);
  if (values.channel) values.channel = await resolveChannel(values.channel);

  if (subcommand === "whitelist" && values.type !== "role" && !values.user) {
    values.user = message.mentions.users.first() ?? null;
  }
  if (subcommand === "whitelist" && values.type === "role" && !values.role) {
    values.role = message.mentions.roles.first() ?? null;
  }
  if (subcommand === "protect-role" && !values.role) {
    values.role = message.mentions.roles.first() ?? null;
  }
  if (subcommand === "protect-channel" && !values.channel) {
    values.channel = message.mentions.channels.first() ?? null;
  }
  if (subcommand === "verify") {
    values.channel ??= message.mentions.channels.first() ?? null;
    values.role ??= message.mentions.roles.first() ?? null;
  }

  return values;
}

function messagePayload(payload = {}) {
  const result = {};
  for (const key of ["content", "embeds", "components", "allowedMentions", "files"]) {
    if (payload[key] !== undefined) result[key] = payload[key];
  }
  return result;
}

class PrefixSecurityInteraction {
  constructor(message, subcommand, values) {
    this.guild = message.guild;
    this.guildId = message.guildId;
    this.user = message.author;
    this.memberPermissions = message.member?.permissions;
    this.options = {
      getSubcommand: () => subcommand,
      getString: (name, required = false) => {
        const value = values[name] ?? null;
        if (required && value == null) throw new Error(`Missing "${name}". Use \`?r help\` to see command examples.`);
        return value;
      },
      getInteger: (name) => parsedInteger(values[name]),
      getBoolean: (name) => parseBoolean(values[name]),
      getChannel: (name, required = false) => {
        const value = values[name] ?? null;
        if (required && value == null) throw new Error(`Missing "${name}". Use \`?r help\` to see command examples.`);
        return value;
      },
      getRole: (name, required = false) => {
        const value = values[name] ?? null;
        if (required && value == null) throw new Error(`Missing "${name}". Use \`?r help\` to see command examples.`);
        return value;
      },
      getUser: (name, required = false) => {
        const value = values[name] ?? null;
        if (required && value == null) throw new Error(`Missing "${name}". Use \`?r help\` to see command examples.`);
        return value;
      },
    };
    this.responseMessage = null;
    this.deferred = false;
    this.replied = false;
  }

  async prepare() {
    this.responseMessage = await this.user.send("Processing your security command…");
  }

  async reply(payload) {
    this.replied = true;
    const formatted = messagePayload(payload);
    return this.responseMessage
      ? this.responseMessage.edit(formatted)
      : this.user.send(formatted);
  }

  async deferReply() {
    this.deferred = true;
    return this.responseMessage;
  }

  async editReply(payload) {
    this.replied = true;
    const formatted = messagePayload(payload);
    return this.responseMessage
      ? this.responseMessage.edit(formatted)
      : this.user.send(formatted);
  }

  async followUp(payload) {
    return this.user.send(messagePayload(payload));
  }
}

export async function handleSecurityPrefixMessage(message, dependencies) {
  const trimmed = message.content.trim();
  const invocation = parseSecurityPrefixInvocation(trimmed);
  if (!invocation || !message.guild || !message.guildId) return false;

  const { subcommand, values } = invocation;
  if (!subcommand || subcommand === "help") {
    await message.author.send(HELP_TEXT).catch(() => {
      void message.reply("Enable DMs from server members so I can send security command help privately.")
        .catch(() => {});
    });
    return true;
  }

  await resolveOptions(message, dependencies.client, subcommand, values);
  const interaction = new PrefixSecurityInteraction(message, subcommand, values);

  try {
    await interaction.prepare();
    await handleSecurityCommand(interaction, dependencies);
  } catch (error) {
    if (interaction.responseMessage) {
      console.error(`[Security][${message.guildId}] Prefix command failed:`, error);
      void dependencies.guardianLogs?.logToGuild(message.guild, {
        title: "Security command error",
        description: `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`,
        severity: "high",
      });
      await interaction.reply({ content: `❌ ${error?.message ?? "Security command failed."}` }).catch(() => {});
    } else {
      await message.reply("Enable DMs from server members to use private security commands.").catch(() => {});
    }
  }
  return true;
}
