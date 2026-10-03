import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
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

const settingChoices = [
  ...boolSettings.map(([value, label]) => ({ name: label, value })),
  { name: "Nuke action limit", value: "nuke_limit" },
  { name: "Raid join limit", value: "raid_join_limit" },
  { name: "Spam message limit", value: "spam_message_limit" },
  { name: "Alert log channel", value: "log_channel" },
  { name: "Verification role", value: "verification_role" },
];

const securityCommand = new SlashCommandBuilder()
  .setName("security")
  .setDescription("Configure and monitor this server's security system")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((subcommand) =>
    subcommand.setName("dashboard").setDescription("View the security dashboard"),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("status").setDescription("View security status and bot permission readiness"),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("setup").setDescription("Enable security monitoring with safe default thresholds"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("config")
      .setDescription("View or update this server's security configuration")
      .addStringOption((option) =>
        option
          .setName("setting")
          .setDescription("Setting to update")
          .setRequired(true)
          .addChoices(...settingChoices),
      )
      .addBooleanOption((option) =>
        option.setName("enabled").setDescription("Enable or disable the selected feature"),
      )
      .addIntegerOption((option) =>
        option.setName("threshold").setDescription("Set a numeric threshold"),
      )
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("Set the alert channel")
          .addChannelTypes(
            ChannelType.GuildText,
            ChannelType.GuildAnnouncement,
          ),
      )
      .addRoleOption((option) =>
        option.setName("role").setDescription("Set the verification role"),
      )
      .addBooleanOption((option) =>
        option.setName("clear").setDescription("Clear the selected channel or role setting"),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("logs")
      .setDescription("Show recent stored security incidents")
      .addIntegerOption((option) =>
        option
          .setName("limit")
          .setDescription("How many incidents to show")
          .setMinValue(1)
          .setMaxValue(20),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("lockdown").setDescription("Temporarily pause messaging and thread creation across channels"),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("unlock").setDescription("Restore the @everyone permissions saved before lockdown"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("whitelist")
      .setDescription("Manage trusted users, roles, and bots")
      .addStringOption((option) =>
        option
          .setName("action")
          .setDescription("Action")
          .setRequired(true)
          .addChoices(
            { name: "Add", value: "add" },
            { name: "Remove", value: "remove" },
            { name: "List", value: "list" },
          ),
      )
      .addStringOption((option) =>
        option
          .setName("type")
          .setDescription("Type of trusted target")
          .addChoices(
            { name: "User", value: "user" },
            { name: "Role", value: "role" },
            { name: "Bot account", value: "bot" },
          ),
      )
      .addUserOption((option) =>
        option.setName("user").setDescription("User or bot to trust"),
      )
      .addRoleOption((option) =>
        option.setName("role").setDescription("Role to trust"),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("protect-role")
      .setDescription("Protect or unprotect a role's stored settings")
      .addStringOption((option) =>
        option
          .setName("action")
          .setDescription("Action")
          .setRequired(true)
          .addChoices(
            { name: "Protect", value: "protect" },
            { name: "Unprotect", value: "unprotect" },
            { name: "List protected roles", value: "list" },
          ),
      )
      .addRoleOption((option) =>
        option.setName("role").setDescription("Role to protect or unprotect"),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("protect-channel")
      .setDescription("Protect or unprotect a channel's stored settings")
      .addStringOption((option) =>
        option
          .setName("action")
          .setDescription("Action")
          .setRequired(true)
          .addChoices(
            { name: "Protect", value: "protect" },
            { name: "Unprotect", value: "unprotect" },
            { name: "List protected channels", value: "list" },
          ),
      )
      .addChannelOption((option) =>
        option.setName("channel").setDescription("Channel to protect or unprotect"),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("backup").setDescription("Save a non-destructive snapshot of roles and channels"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("restore")
      .setDescription("Recreate missing roles and channels from a saved snapshot; nothing is deleted")
      .addStringOption((option) =>
        option.setName("backup_id").setDescription("ID returned by /security backup").setRequired(true),
      )
      .addBooleanOption((option) =>
        option
          .setName("confirm")
          .setDescription("Confirm creation of missing roles and channels")
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("verify")
      .setDescription("Post a member verification panel")
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("Channel where members can verify")
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
      )
      .addRoleOption((option) =>
        option.setName("role").setDescription("Role granted when a member verifies").setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("test").setDescription("Send and store a test security alert"),
  );

export const securityCommandData = securityCommand.toJSON();

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
    `Lockdown: **${config.lockdownSnapshot ? "Active" : "Inactive"}**`
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
      `Set an alert channel with \`/security config\` and protect sensitive targets with the protect commands. Automatic actions require the matching Discord permissions.`,
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
      `**Lockdown:** ${config.lockdownSnapshot ? "active" : "inactive"}`,
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
        : `Lockdown applied to ${result.changed} channels/categories. Failed: ${result.failures}. Use /security unlock to restore saved messaging permissions.`,
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
    await reply(interaction, `Security test stored as incident #${incidentId}. ${config.logChannelId ? "The configured alert channel was tested." : "No alert channel is configured; the incident is available in /security logs."}`);
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