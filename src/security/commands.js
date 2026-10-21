import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
} from "discord.js";
import { RESTORABLE_CHANNEL_TYPES } from "./monitor.js";

const featureLabels = [
  ["antiNuke", "Anti-nuke"],
  ["antiRaid", "Anti-raid"],
  ["antiSpam", "Anti-spam"],
  ["antiWebhook", "Anti-webhook abuse"],
  ["antiMaliciousBot", "Unapproved bot blocking"],
  ["roleProtection", "Protected roles"],
  ["channelProtection", "Protected channels"],
  ["permissionMonitoring", "Permission monitoring"],
];

const boolSettings = [
  ["enabled", "Security system"],
  ["anti_nuke", "Anti-nuke"],
  ["anti_raid", "Anti-raid"],
  ["anti_spam", "Anti-spam"],
  ["anti_webhook", "Anti-webhook abuse"],
  ["anti_malicious_bot", "Unapproved bot blocking"],
  ["role_protection", "Role protection"],
  ["channel_protection", "Channel protection"],
  ["permission_monitoring", "Permission monitoring"],
];

function requireGuild(interaction) {
  if (!interaction.guild || !interaction.guildId) {
    throw new Error("Security commands can only be used inside a server.");
  }
  return interaction.guild;
}

function requireManager(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    throw new Error("You need the Manage Server permission to use this security command.");
  }
}

function botHas(guild, permission) {
  return Boolean(guild.members.me?.permissions.has(permission));
}

function settingLabel(key) {
  return featureLabels.find(([setting]) => setting === key)?.[1] ?? key;
}

function configSummary(config, memberJoinMonitoringEnabled) {
  const features = featureLabels
    .map(([key, label]) => {
      const intentNote = key === "antiRaid" && !memberJoinMonitoringEnabled
        ? " (needs Server Members intent)"
        : "";
      return `${config[key] ? "ON" : "OFF"} · ${label}${intentNote}`;
    })
    .join("\n");
  return (
    `System: **${config.enabled ? "Enabled" : "Disabled"}**\n` +
    `${features}\n\n` +
    `Nuke: **${config.nukeLimit} actions / ${config.nukeWindowSeconds}s**\n` +
    `Raid: **${config.raidJoinLimit} joins / ${config.raidWindowSeconds}s**\n` +
    `Spam: **${config.spamMessageLimit} messages / ${config.spamWindowSeconds}s**\n` +
    `Alert channel: ${config.logChannelId ? `<#${config.logChannelId}>` : "not set"}\n` +
    `Verification role: ${config.verificationRoleId ? `<@&${config.verificationRoleId}>` : "not set"}\n` +
    `Lockdown: **${config.lockdownSnapshot ? "Active" : "Inactive"}**\n` +
    `Individual channel lockdowns: **${Object.keys(config.channelLockSnapshots ?? {}).length}**`
  );
}

async function reply(interaction, content, ephemeral = true) {
  if (interaction.deferred || interaction.replied) {
    return interaction.followUp({ content, ephemeral, allowedMentions: { parse: [] } });
  }
  return interaction.reply({ content, ephemeral, allowedMentions: { parse: [] } });
}

async function dashboard(interaction, securityStore, monitor) {
  const guild = requireGuild(interaction);
  const config = securityStore.getConfig(guild.id);
  const botMember = guild.members.me;
  const criticalPermissions = [
    ["View Audit Log", PermissionFlagsBits.ViewAuditLog],
    ["Manage Channels", PermissionFlagsBits.ManageChannels],
    ["Manage Roles", PermissionFlagsBits.ManageRoles],
    ["Manage Messages", PermissionFlagsBits.ManageMessages],
    ["Moderate Members", PermissionFlagsBits.ModerateMembers],
    ["Kick Members", PermissionFlagsBits.KickMembers],
    ["Manage Webhooks", PermissionFlagsBits.ManageWebhooks],
  ];
  const permissions = criticalPermissions
    .map(([label, permission]) => `${botMember?.permissions.has(permission) ? "Ready" : "Missing"} · ${label}`)
    .concat(
      `${monitor?.memberJoinMonitoringEnabled ? "Ready" : "Unavailable"} · Server Members intent`,
    )
    .join("\n");
  const protectedCount = securityStore.listProtected(guild.id).length;
  const whitelistCount = securityStore.listAllowlist(guild.id).length;
  const embed = new EmbedBuilder()
    .setTitle(`${guild.name} · Security Dashboard`)
    .setColor(config.enabled ? 0x347a62 : 0x777777)
    .setDescription(configSummary(config, monitor?.memberJoinMonitoringEnabled))
    .addFields(
      { name: "Incidents · last 24 hours", value: String(securityStore.incidentCount(guild.id)), inline: true },
      { name: "Trusted entries", value: String(whitelistCount), inline: true },
      { name: "Protected targets", value: String(protectedCount), inline: true },
      { name: "Bot permission readiness", value: permissions },
    )
    .setFooter({ text: "Actions respect Discord permissions and role hierarchy. Restore never deletes server content." })
    .setTimestamp();
  const latest = securityStore.listIncidents(guild.id, 3);
  if (latest.length) {
    embed.addFields({
      name: "Recent incidents",
      value: latest
        .map((incident) => `• ${incident.severity.toUpperCase()} ${incident.category} · <t:${incident.createdAt}:R>`)
        .join("\n")
        .slice(0, 1000),
    });
  }
  await interaction.reply({ embeds: [embed], ephemeral: true, allowedMentions: { parse: [] } });
}

async function handleConfig(interaction, securityStore) {
  const guild = requireGuild(interaction);
  const setting = interaction.options.getString("setting", true);
  const enabledValue = interaction.options.getBoolean("enabled");
  const threshold = interaction.options.getInteger("threshold");
  const channel = interaction.options.getChannel("channel");
  const role = interaction.options.getRole("role");
  const clear = interaction.options.getBoolean("clear") ?? false;
  const config = securityStore.getConfig(guild.id);

  if (boolSettings.some(([key]) => key === setting)) {
    if (enabledValue === null) {
      const key = setting.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase());
      await reply(interaction, `${settingLabel(key)} is **${config[key] ? "enabled" : "disabled"}**. Provide the enabled option to change it.`);
      return;
    }
    const key = setting.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase());
    const updated = securityStore.saveConfig(guild.id, { ...config, [key]: enabledValue });
    await reply(interaction, `${settingLabel(key)} is now **${updated[key] ? "enabled" : "disabled"}**.`);
    return;
  }

  const thresholdKeys = {
    nuke_limit: ["nukeLimit", 2, 20],
    raid_join_limit: ["raidJoinLimit", 3, 50],
    spam_message_limit: ["spamMessageLimit", 3, 30],
  };
  if (setting in thresholdKeys) {
    const [key, min, max] = thresholdKeys[setting];
    if (threshold === null) {
      await reply(interaction, `${settingLabel(key)} is **${config[key]}**. Provide a threshold from ${min} to ${max} to change it.`);
      return;
    }
    if (threshold < min || threshold > max) {
      await reply(interaction, `Threshold must be between ${min} and ${max}.`);
      return;
    }
    securityStore.saveConfig(guild.id, { ...config, [key]: threshold });
    await reply(interaction, `${settingLabel(key)} set to **${threshold}**.`);
    return;
  }

  if (setting === "log_channel") {
    if (clear) {
      securityStore.saveConfig(guild.id, { ...config, logChannelId: null });
      await reply(interaction, "Security alerts will be written to bot logs until an alert channel is configured.");
      return;
    }
    if (!channel) {
      await reply(interaction, `Alert channel is ${config.logChannelId ? `<#${config.logChannelId}>` : "not set"}. Provide a channel or set clear to true.`);
      return;
    }
    const botPermissions = guild.members.me?.permissionsIn(channel);
    if (!botPermissions?.has(PermissionFlagsBits.ViewChannel) || !botPermissions.has(PermissionFlagsBits.SendMessages)) {
      await reply(interaction, "The bot needs View Channel and Send Messages in that alert channel.");
      return;
    }
    securityStore.saveConfig(guild.id, { ...config, logChannelId: channel.id });
    await reply(interaction, `Security alerts will be sent to <#${channel.id}>.`);
    return;
  }

  if (setting === "verification_role") {
    if (clear) {
      securityStore.saveConfig(guild.id, { ...config, verificationRoleId: null });
      await reply(interaction, "Verification role cleared.");
      return;
    }
    if (!role) {
      await reply(interaction, `Verification role is ${config.verificationRoleId ? `<@&${config.verificationRoleId}>` : "not set"}. Provide a role or set clear to true.`);
      return;
    }
    const bot = guild.members.me;
    if (
      role.managed ||
      !botHas(guild, PermissionFlagsBits.ManageRoles) ||
      !bot ||
      role.position >= bot.roles.highest.position
    ) {
      await reply(interaction, "The bot needs Manage Roles and a highest role above the selected verification role.");
      return;
    }
    securityStore.saveConfig(guild.id, { ...config, verificationRoleId: role.id });
    await reply(interaction, `Verification role set to <@&${role.id}>.`);
    return;
  }

  await reply(interaction, "Unknown security setting.");
}

function roleSnapshot(role) {
  return {
    name: role.name,
    color: role.color,
    hoist: role.hoist,
    mentionable: role.mentionable,
    permissions: role.permissions.bitfield.toString(),
    position: role.position,
  };
}

function channelSnapshot(channel) {
  return {
    name: channel.name,
    type: channel.type,
    parentId: channel.parentId ?? null,
    position: channel.rawPosition ?? channel.position ?? 0,
    topic: channel.topic ?? null,
    nsfw: Boolean(channel.nsfw),
    rateLimitPerUser: channel.rateLimitPerUser ?? 0,
    bitrate: channel.bitrate ?? null,
    userLimit: channel.userLimit ?? null,
    permissionOverwrites: channel.permissionOverwrites?.cache?.map((overwrite) => ({
      id: overwrite.id,
      type: overwrite.type,
      allow: overwrite.allow.bitfield.toString(),
      deny: overwrite.deny.bitfield.toString(),
    })) ?? [],
  };
}

function channelCreateOptions(channelData, { parentId = null, permissionOverwrites, reason }) {
  const options = {
    name: channelData.name,
    type: channelData.type,
    permissionOverwrites,
    reason,
  };
  if (parentId) options.parent = parentId;
  if (
    [
      ChannelType.GuildText,
      ChannelType.GuildAnnouncement,
      ChannelType.GuildForum,
      ChannelType.GuildMedia,
    ].includes(channelData.type)
  ) {
    if (typeof channelData.topic === "string") options.topic = channelData.topic;
    options.nsfw = channelData.nsfw;
    options.rateLimitPerUser = channelData.rateLimitPerUser;
  }
  if ([ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(channelData.type)) {
    if (channelData.bitrate) options.bitrate = channelData.bitrate;
    if (channelData.userLimit) options.userLimit = channelData.userLimit;
  }
  return options;
}

async function handleRestore(interaction, securityStore) {
  const guild = requireGuild(interaction);
  const backupId = interaction.options.getString("backup_id", true);
  const confirmed = interaction.options.getBoolean("confirm", true);
  if (!confirmed) {
    await reply(interaction, "Restore cancelled. No server data was changed.");
    return;
  }
  const backup = securityStore.getBackup(guild.id, backupId);
  if (!backup) {
    await reply(interaction, "That backup was not found for this server.");
    return;
  }
  if (securityStore.getConfig(guild.id).lockdownSnapshot) {
    await reply(interaction, "End the active lockdown before restoring a backup. This prevents newly recreated channels from bypassing the lockdown.");
    return;
  }
  if (
    !botHas(guild, PermissionFlagsBits.ManageRoles) ||
    !botHas(guild, PermissionFlagsBits.ManageChannels)
  ) {
    await reply(interaction, "The bot needs Manage Roles and Manage Channels to restore missing items.");
    return;
  }
  await interaction.deferReply({ ephemeral: true });

  const roleIdMap = new Map([[guild.id, guild.id]]);
  const existingRoles = await guild.roles.fetch().catch(() => guild.roles.cache);
  const sortedRoles = [...backup.snapshot.roles].sort((a, b) => a.position - b.position);
  let createdRoles = 0;
  let failedRoles = 0;
  for (const roleData of sortedRoles) {
    const existing = existingRoles.find((candidate) => candidate.name === roleData.name && !candidate.managed);
    if (existing) {
      roleIdMap.set(roleData.id, existing.id);
      continue;
    }
    const me = guild.members.me;
    try {
      const created = await guild.roles.create({
        name: roleData.name,
        color: roleData.color,
        hoist: roleData.hoist,
        mentionable: roleData.mentionable,
        permissions: BigInt(roleData.permissions),
        position: Math.max(1, Math.min(roleData.position, (me?.roles.highest.position ?? 1) - 1)),
        reason: `Security backup restore ${backupId}; non-destructive recreation`,
      });
      roleIdMap.set(roleData.id, created.id);
      createdRoles += 1;
    } catch (error) {
      failedRoles += 1;
      console.warn(`[Security][${guild.id}] Backup role restore failed: ${error.message}`);
    }
  }

  const existingChannels = await guild.channels.fetch().catch(() => guild.channels.cache);
  const channelIdMap = new Map();
  const sortedChannels = [...backup.snapshot.channels].sort((a, b) => {
    const aCategory = a.type === ChannelType.GuildCategory ? 0 : 1;
    const bCategory = b.type === ChannelType.GuildCategory ? 0 : 1;
    return aCategory - bCategory || a.position - b.position;
  });
  let createdChannels = 0;
  let failedChannels = 0;
  for (const channelData of sortedChannels) {
    if (!RESTORABLE_CHANNEL_TYPES.has(channelData.type)) continue;
    const existing = existingChannels.find(
      (candidate) => candidate.name === channelData.name && candidate.type === channelData.type,
    );
    if (existing) {
      channelIdMap.set(channelData.id, existing.id);
      continue;
    }
    const parentId = channelData.parentId
      ? channelIdMap.get(channelData.parentId) ?? channelData.parentId
      : null;
    const parent = parentId ? guild.channels.cache.get(parentId) ?? existingChannels.get(parentId) : null;
    const permissionOverwrites = channelData.permissionOverwrites
      .map((overwrite) => {
        const id = overwrite.type === 0
          ? (roleIdMap.get(overwrite.id) ?? overwrite.id)
          : overwrite.id;
        if (overwrite.type === 0 && !roleIdMap.has(overwrite.id) && !guild.roles.cache.has(id)) return null;
        return {
          id,
          type: overwrite.type,
          allow: BigInt(overwrite.allow),
          deny: BigInt(overwrite.deny),
        };
      })
      .filter(Boolean);
    try {
      const created = await guild.channels.create(channelCreateOptions(channelData, {
        parentId: parent?.type === ChannelType.GuildCategory ? parent.id : null,
        permissionOverwrites,
        reason: `Security backup restore ${backupId}; non-destructive recreation`,
      }));
      await created.setPosition(channelData.position).catch(() => {});
      channelIdMap.set(channelData.id, created.id);
      createdChannels += 1;
    } catch (error) {
      failedChannels += 1;
      console.warn(`[Security][${guild.id}] Backup channel restore failed: ${error.message}`);
    }
  }

  const currentConfig = securityStore.getConfig(guild.id);
  const savedConfig = backup.snapshot.securityConfig;
  if (savedConfig && typeof savedConfig === "object") {
    const savedLogChannelId = savedConfig.logChannelId;
    const savedVerificationRoleId = savedConfig.verificationRoleId;
    securityStore.saveConfig(guild.id, {
      ...savedConfig,
      logChannelId: savedLogChannelId
        ? channelIdMap.get(savedLogChannelId) ??
          (guild.channels.cache.has(savedLogChannelId) ? savedLogChannelId : null)
        : null,
      verificationRoleId: savedVerificationRoleId
        ? roleIdMap.get(savedVerificationRoleId) ??
          (guild.roles.cache.has(savedVerificationRoleId) ? savedVerificationRoleId : null)
        : null,
      // Keep an in-progress lockdown recoverable rather than replacing it with a backup's stale state.
      lockdownSnapshot: currentConfig.lockdownSnapshot,
      // Preserve live per-channel lockdowns rather than replacing them with stale backup IDs.
      channelLockSnapshots: currentConfig.channelLockSnapshots ?? {},
    });
  }

  let restoredTrustedEntries = 0;
  for (const entry of backup.snapshot.allowlist ?? []) {
    if (!["user", "role", "bot"].includes(entry.type) || !entry.targetId) continue;
    const targetId = entry.type === "role"
      ? roleIdMap.get(entry.targetId) ?? (guild.roles.cache.has(entry.targetId) ? entry.targetId : null)
      : entry.targetId;
    if (!targetId) continue;
    securityStore.addAllowlist(guild.id, entry.type, targetId, interaction.user.id);
    restoredTrustedEntries += 1;
  }

  let restoredProtectedEntries = 0;
  for (const entry of backup.snapshot.protected ?? []) {
    if (!["role", "channel"].includes(entry.type) || !entry.targetId) continue;
    const targetId = entry.type === "role"
      ? roleIdMap.get(entry.targetId) ?? (guild.roles.cache.has(entry.targetId) ? entry.targetId : null)
      : channelIdMap.get(entry.targetId) ?? (guild.channels.cache.has(entry.targetId) ? entry.targetId : null);
    if (!targetId) continue;
    let snapshot = entry.snapshot;
    if (entry.type === "channel") {
      snapshot = {
        ...snapshot,
        parentId: snapshot.parentId
          ? channelIdMap.get(snapshot.parentId) ?? snapshot.parentId
          : null,
        permissionOverwrites: (snapshot.permissionOverwrites ?? [])
          .map((overwrite) => {
            if (overwrite.type !== 0) return overwrite;
            const mappedRoleId = roleIdMap.get(overwrite.id) ??
              (guild.roles.cache.has(overwrite.id) ? overwrite.id : null);
            return mappedRoleId ? { ...overwrite, id: mappedRoleId } : null;
          })
          .filter(Boolean),
      };
    }
    securityStore.protect(guild.id, entry.type, targetId, snapshot, interaction.user.id);
    restoredProtectedEntries += 1;
  }

  securityStore.recordIncident({
    guildId: guild.id,
    category: "backup-restore",
    severity: "medium",
    actorId: interaction.user.id,
    details: `Backup ${backupId} restored non-destructively: ${createdRoles} roles and ${createdChannels} channels created; ${restoredTrustedEntries} trusted entries and ${restoredProtectedEntries} protections imported; ${failedRoles + failedChannels} items failed. Existing items and role assignments were not changed.`,
  });
  await interaction.editReply(
    `Restore finished without deleting or editing existing items.\n` +
    `Created roles: **${createdRoles}** (failed: ${failedRoles})\n` +
    `Created channels: **${createdChannels}** (failed: ${failedChannels})\n` +
    `Trusted entries added: **${restoredTrustedEntries}**\n` +
    `Protected targets added: **${restoredProtectedEntries}**\n` +
    `Security settings were restored; trusted/protected lists were merged. Existing role assignments, messages, and integrations were not restored.`,
  );
}

async function handleVerificationPanel(interaction, securityStore) {
  const guild = requireGuild(interaction);
  const channel = interaction.options.getChannel("channel", true);
  const role = interaction.options.getRole("role", true);
  const bot = guild.members.me;
  if (
    role.managed ||
    !botHas(guild, PermissionFlagsBits.ManageRoles) ||
    !bot ||
    role.position >= bot.roles.highest.position
  ) {
    throw new Error("The bot needs Manage Roles and a highest role above the verification role.");
  }
  const channelPermissions = guild.members.me?.permissionsIn(channel);
  if (!channelPermissions?.has(PermissionFlagsBits.ViewChannel) || !channelPermissions.has(PermissionFlagsBits.SendMessages)) {
    throw new Error("The bot needs View Channel and Send Messages in the verification channel.");
  }
  const config = securityStore.getConfig(guild.id);
  securityStore.saveConfig(guild.id, { ...config, verificationRoleId: role.id });
  const button = new ButtonBuilder()
    .setCustomId(`security:verify:${guild.id}:${role.id}`)
    .setLabel("Verify")
    .setStyle(ButtonStyle.Success);
  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setTitle(`${guild.name} member verification`)
        .setDescription("Press Verify to receive access to verified-member channels. If access is still unavailable afterward, contact a server moderator.")
        .setColor(0x347a62),
    ],
    components: [new ActionRowBuilder().addComponents(button)],
    allowedMentions: { parse: [] },
  });
  await reply(interaction, `Verification panel posted in <#${channel.id}>. Configure that role's channel access using Discord channel permissions.`);
}

async function handleWhitelist(interaction, securityStore) {
  const guild = requireGuild(interaction);
  const action = interaction.options.getString("action", true);
  const type = interaction.options.getString("type");
  const user = interaction.options.getUser("user");
  const role = interaction.options.getRole("role");
  if (action === "list") {
    const rows = securityStore.listAllowlist(guild.id);
    await reply(
      interaction,
      rows.length
        ? rows.map((row) => `• ${row.type}: ${row.type === "role" ? `<@&${row.targetId}>` : `<@${row.targetId}>`}`).join("\n")
        : "No trusted users, roles, or bots are configured.",
    );
    return;
  }
  const targetId = type === "role" ? role?.id : user?.id;
  if (!type || !targetId) {
    await reply(interaction, "Choose a target type and provide the matching user, bot, or role.");
    return;
  }
  if (type === "bot" && !user?.bot) {
    await reply(interaction, "The bot whitelist type requires a bot account.");
    return;
  }
  if (type === "user" && user?.bot) {
    await reply(interaction, "Use the bot account type when trusting a bot.");
    return;
  }
  if (action === "add") {
    securityStore.addAllowlist(guild.id, type, targetId, interaction.user.id);
    await reply(interaction, `${type === "role" ? `<@&${targetId}>` : `<@${targetId}>`} added to the trusted list.`);
  } else {
    const removed = securityStore.removeAllowlist(guild.id, type, targetId);
    await reply(interaction, removed ? "Trusted entry removed." : "That entry was not on the trusted list.");
  }
}

async function handleProtected(interaction, securityStore, type) {
  const guild = requireGuild(interaction);
  const action = interaction.options.getString("action", true);
  const target = type === "role"
    ? interaction.options.getRole("role")
    : interaction.options.getChannel("channel");
  if (action === "list") {
    const rows = securityStore.listProtected(guild.id, type);
    await reply(
      interaction,
      rows.length
        ? rows.map((row) => `• ${type}: ${type === "role" ? `<@&${row.targetId}>` : `<#${row.targetId}>`}`).join("\n")
        : `No ${type}s are protected.`,
    );
    return;
  }
  if (!target || target.guildId !== guild.id && type === "channel") {
    await reply(interaction, `Choose a ${type} in this server.`);
    return;
  }
  if (action === "unprotect") {
    const removed = securityStore.unprotect(guild.id, type, target.id);
    await reply(interaction, removed ? `${type} protection removed.` : `That ${type} was not protected.`);
    return;
  }

  if (type === "role") {
    const bot = guild.members.me;
    if (
      target.id === guild.id ||
      target.managed ||
      !botHas(guild, PermissionFlagsBits.ManageRoles) ||
      !bot ||
      target.position >= bot.roles.highest.position
    ) {
      await reply(interaction, "The bot needs Manage Roles and a role hierarchy above the selected role; managed and @everyone roles cannot be protected.");
      return;
    }
    securityStore.protect(guild.id, type, target.id, roleSnapshot(target), interaction.user.id);
  } else {
    if (!target.permissionOverwrites) {
      await reply(interaction, "That channel type does not support permission overwrite protection.");
      return;
    }
    if (!botHas(guild, PermissionFlagsBits.ManageChannels)) {
      await reply(interaction, "The bot needs Manage Channels to restore protected channels.");
      return;
    }
    securityStore.protect(guild.id, type, target.id, channelSnapshot(target), interaction.user.id);
  }
  await reply(interaction, `${type === "role" ? `<@&${target.id}>` : `<#${target.id}>`} is now protected. Stored settings will be reapplied after untrusted changes; deleted targets may be recreated with a new ID.`);
}

async function handleLogs(interaction, securityStore) {
  const guild = requireGuild(interaction);
  const limit = interaction.options.getInteger("limit") ?? 10;
  const incidents = securityStore.listIncidents(guild.id, limit);
  if (!incidents.length) {
    await reply(interaction, "There are no stored security incidents for this server.");
    return;
  }
  const lines = incidents.map((incident) => {
    const actor = incident.actorId ? `<@${incident.actorId}>` : "unknown actor";
    const target = incident.targetId ? ` · target ${incident.targetId}` : "";
    const details = incident.details.replace(/\s+/g, " ").slice(0, 190);
    return `• <t:${incident.createdAt}:f> · **${incident.severity.toUpperCase()}** · ${incident.category} · ${actor}${target}\n  ${details}`;
  });
  await interaction.reply({
    content: lines.join("\n").slice(0, 1950),
    ephemeral: true,
    allowedMentions: { parse: [] },
  });
}

export async function handleSecurityCommand(interaction, { securityStore, monitor }) {
  requireManager(interaction);
  const guild = requireGuild(interaction);
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "dashboard") return dashboard(interaction, securityStore, monitor);
  if (subcommand === "config") return handleConfig(interaction, securityStore);
  if (subcommand === "logs") return handleLogs(interaction, securityStore);
  if (subcommand === "whitelist") return handleWhitelist(interaction, securityStore);
  if (subcommand === "protect-role") return handleProtected(interaction, securityStore, "role");
  if (subcommand === "protect-channel") return handleProtected(interaction, securityStore, "channel");
  if (subcommand === "restore") return handleRestore(interaction, securityStore);
  if (subcommand === "verify") return handleVerificationPanel(interaction, securityStore);
  if (subcommand === "lock-channel" || subcommand === "unlock-channel") {
    const channel = interaction.options.getChannel("channel", true);
    const locking = subcommand === "lock-channel";
    const confirmed = interaction.options.getBoolean("confirm") ?? false;
    if (
      channel.guildId !== guild.id ||
      channel.isThread?.() ||
      !channel.permissionOverwrites?.edit
    ) {
      await reply(interaction, "Choose a text, announcement, forum, or media channel in this server (threads are not supported).");
      return;
    }
    if (!botHas(guild, PermissionFlagsBits.ManageChannels)) {
      await reply(interaction, "The bot needs Manage Channels to lock or unlock an individual channel.");
      return;
    }
    if (locking && channel.permissionsLocked && !confirmed) {
      await reply(
        interaction,
        `This channel inherits permissions from its category. Locking only this channel will add channel-specific overwrites and unsync it. To continue, run \`?r lock-channel channel:<#${channel.id}> confirm:true\`.`,
      );
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    const result = locking
      ? await monitor.applyChannelLockdown(
          guild,
          channel,
          `requested by ${interaction.user.tag}`,
          { confirmSynced: confirmed },
        )
      : await monitor.removeChannelLockdown(guild, channel);
    let content;
    if (result.confirmationRequired) {
      content = `This channel inherits permissions from its category. Re-run \`?r lock-channel channel:<#${channel.id}> confirm:true\` to lock only this channel.`;
    } else if (result.serverLocked) {
      content = "A server-wide lockdown is active. End it with `?r unlock` before changing an individual channel lock.";
    } else if (result.alreadyLocked) {
      content = `#${channel.name} is already locked; its original permission snapshot was preserved.`;
    } else if (result.missing) {
      content = `#${channel.name} does not have an active individual lockdown.`;
    } else if (result.missingPermission) {
      content = "The bot needs Manage Channels to lock or unlock an individual channel.";
    } else if (result.unsupported) {
      content = "That channel type cannot be locked with this command. Choose a text, announcement, forum, or media channel.";
    } else if (result.failures && locking && result.changed === 0) {
      content = `The channel lockdown could not be applied. No permission overwrites succeeded, but the recovery snapshot was kept; run \`?r unlock-channel channel:<#${channel.id}>\` to restore safely or check the bot's Manage Channels permission.`;
    } else if (result.failures) {
      content = locking
        ? `The channel lockdown was only partially applied: ${result.changed} permission overwrites succeeded and ${result.failures} failed. The recovery snapshot was kept; use \`?r unlock-channel channel:<#${channel.id}>\` to restore safely, then retry if needed.`
        : `The channel unlock was only partially applied: ${result.changed} permission overwrites restored and ${result.failures} failed. The remaining recovery snapshot was kept; retry \`?r unlock-channel channel:<#${channel.id}>\` after checking the bot's Manage Channels permission.`;
    } else if (locking) {
      content = `#${channel.name} is locked. Messaging and thread creation are paused. Use \`?r unlock-channel channel:<#${channel.id}>\` to restore its saved permissions.`;
    } else {
      content = `#${channel.name} is unlocked. ${result.changed} permission overwrites were restored; ${result.failures} failed.`;
    }
    await interaction.editReply(content);
    return;
  }

  if (subcommand === "setup") {
    const config = securityStore.getConfig(guild.id);
    securityStore.saveConfig(guild.id, { ...config, enabled: true });
    securityStore.recordIncident({
      guildId: guild.id,
      category: "security-setup",
      severity: "low",
      actorId: interaction.user.id,
      details: "Security monitoring enabled using default thresholds. Confirm bot permissions and configure the alert channel.",
    });
    const auditReady = botHas(guild, PermissionFlagsBits.ViewAuditLog);
    await reply(
      interaction,
      `Security monitoring enabled with safe default thresholds.\n` +
      `Audit Log permission: **${auditReady ? "available" : "missing"}**\n` +
      `Server Members intent: **${monitor.memberJoinMonitoringEnabled ? "available" : "not enabled"}**\n` +
      `${monitor.memberJoinMonitoringEnabled ? "" : "Anti-raid join counting needs Discord's privileged Server Members intent; the bot will otherwise keep running without that event feed.\n"}` +
      `Set an alert channel with \`?r config setting:log_channel channel:#security-alerts\` and protect sensitive targets with the protect commands. Automatic actions require the matching Discord permissions.`,
    );
    return;
  }

  if (subcommand === "status") {
    const config = securityStore.getConfig(guild.id);
    await reply(
      interaction,
      `**Security system:** ${config.enabled ? "enabled" : "disabled"}\n` +
      `**View Audit Log:** ${botHas(guild, PermissionFlagsBits.ViewAuditLog) ? "available" : "missing"}\n` +
      `**Server Members intent:** ${monitor.memberJoinMonitoringEnabled ? "available" : "not enabled; anti-raid join events unavailable"}\n` +
      `**Manage Channels:** ${botHas(guild, PermissionFlagsBits.ManageChannels) ? "available" : "missing"}\n` +
      `**Manage Roles:** ${botHas(guild, PermissionFlagsBits.ManageRoles) ? "available" : "missing"}\n` +
      `**Manage Messages:** ${botHas(guild, PermissionFlagsBits.ManageMessages) ? "available" : "missing"}\n` +
      `**Moderate Members:** ${botHas(guild, PermissionFlagsBits.ModerateMembers) ? "available" : "missing"}\n` +
      `**Manage Webhooks:** ${botHas(guild, PermissionFlagsBits.ManageWebhooks) ? "available" : "missing"}\n` +
      `**Alert channel:** ${config.logChannelId ? `<#${config.logChannelId}>` : "not configured"}\n` +
      `**Server-wide lockdown:** ${config.lockdownSnapshot ? "active" : "inactive"}\n` +
      `**Individual channel lockdowns:** ${Object.keys(config.channelLockSnapshots ?? {}).length}`,
    );
    return;
  }

  if (subcommand === "lockdown") {
    if (!botHas(guild, PermissionFlagsBits.ManageChannels)) {
      await reply(interaction, "The bot needs Manage Channels before it can apply a lockdown.");
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    const result = await monitor.applyLockdown(guild, `requested by ${interaction.user.tag}`);
    await interaction.editReply(
      result.alreadyLocked
        ? "Lockdown is already active; the original permission snapshot was preserved."
        : `Lockdown applied to ${result.changed} channels/categories. Failed: ${result.failures}. Use ?r unlock to restore saved messaging permissions.`,
    );
    return;
  }

  if (subcommand === "unlock") {
    if (!botHas(guild, PermissionFlagsBits.ManageChannels)) {
      await reply(interaction, "The bot needs Manage Channels before it can restore a lockdown.");
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    const result = await monitor.removeLockdown(guild);
    await interaction.editReply(
      result.missing
        ? "No active lockdown snapshot exists."
        : `Lockdown permissions restored in ${result.changed} channels/categories. Failed: ${result.failures}. Other permission types were not changed.`,
    );
    return;
  }

  if (subcommand === "backup") {
    await interaction.deferReply({ ephemeral: true });
    const backup = await monitor.makeBackup(guild, interaction.user.id);
    securityStore.recordIncident({
      guildId: guild.id,
      category: "server-backup",
      severity: "low",
      actorId: interaction.user.id,
      details: `Server snapshot ${backup.backupId} created. It stores role/channel and security settings, not member data or integrations.`,
    });
    await interaction.editReply(
      `Backup created: \`${backup.backupId}\`\n` +
      `It contains role/channel settings plus this bot's security settings and trusted/protected lists. It does not contain member assignments, messages, webhook credentials, or integrations. Restore is non-destructive: it only creates missing items and merges trusted/protected entries.`,
    );
    return;
  }

  if (subcommand === "test") {
    const incidentId = securityStore.recordIncident({
      guildId: guild.id,
      category: "security-test",
      severity: "low",
      actorId: interaction.user.id,
      details: `Security alert test requested by ${interaction.user.tag}.`,
    });
    const config = securityStore.getConfig(guild.id);
    if (config.logChannelId) {
      const logChannel = await guild.channels.fetch(config.logChannelId).catch(() => null);
      if (logChannel?.isTextBased()) {
        await logChannel.send({
          embeds: [
            new EmbedBuilder()
              .setTitle("Security alert test")
              .setDescription(`Alert delivery is configured. Incident #${incidentId}.`)
              .setColor(0x347a62)
              .setTimestamp(),
          ],
          allowedMentions: { parse: [] },
        });
      }
    }
    await reply(interaction, `Security test stored as incident #${incidentId}. ${config.logChannelId ? "The configured alert channel was tested." : "No alert channel is configured; the incident is available in ?r logs."}`);
    return;
  }

  await reply(interaction, "Unknown security subcommand.");
}

export async function handleVerificationButton(interaction, securityStore) {
  const [, , guildId, roleId] = interaction.customId.split(":");
  if (!guildId || !roleId || interaction.guildId !== guildId || !interaction.guild) {
    await interaction.reply({ content: "This verification panel is invalid or belongs to another server.", ephemeral: true });
    return true;
  }
  if (interaction.user.bot) {
    await interaction.reply({ content: "Bot accounts cannot use member verification.", ephemeral: true });
    return true;
  }
  const guild = interaction.guild;
  const config = securityStore.getConfig(guild.id);
  if (config.verificationRoleId !== roleId) {
    await interaction.reply({ content: "This verification panel is no longer active. Ask a moderator for the current panel.", ephemeral: true });
    return true;
  }
  const role = await guild.roles.fetch(roleId).catch(() => null);
  const member = await guild.members.fetch(interaction.user.id).catch(() => null);
  const me = guild.members.me;
  if (!role || !member || !me?.permissions.has(PermissionFlagsBits.ManageRoles) || role.position >= me.roles.highest.position || role.managed) {
    await interaction.reply({ content: "Verification is temporarily unavailable. Contact a server moderator.", ephemeral: true });
    return true;
  }
  if (member.roles.cache.has(roleId)) {
    await interaction.reply({ content: "You are already verified.", ephemeral: true });
    return true;
  }
  await member.roles.add(role, "Member completed server verification");
  securityStore.recordIncident({
    guildId: guild.id,
    category: "member-verified",
    severity: "low",
    actorId: interaction.user.id,
    targetId: roleId,
    details: `${interaction.user.tag} completed the server verification button.`,
  });
  await interaction.reply({ content: "Verification complete. Your server role has been updated.", ephemeral: true });
  return true;
}