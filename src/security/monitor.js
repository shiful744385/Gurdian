import {
  AuditLogEvent,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
} from "discord.js";

const DESTRUCTIVE_ACTIONS = new Map([
  [AuditLogEvent.ChannelCreate, "channel creation"],
  [AuditLogEvent.ChannelUpdate, "channel settings change"],
  [AuditLogEvent.ChannelDelete, "channel deletion"],
  [AuditLogEvent.RoleCreate, "role creation"],
  [AuditLogEvent.RoleUpdate, "role settings change"],
  [AuditLogEvent.RoleDelete, "role deletion"],
  [AuditLogEvent.MemberBanAdd, "member ban"],
  [AuditLogEvent.MemberKick, "member kick"],
  [AuditLogEvent.WebhookCreate, "webhook creation"],
  [AuditLogEvent.WebhookUpdate, "webhook update"],
  [AuditLogEvent.WebhookDelete, "webhook deletion"],
  [AuditLogEvent.ChannelOverwriteCreate, "permission overwrite creation"],
  [AuditLogEvent.ChannelOverwriteUpdate, "permission overwrite update"],
  [AuditLogEvent.ChannelOverwriteDelete, "permission overwrite deletion"],
]);

const PROTECTED_ROLE_ACTIONS = new Set([
  AuditLogEvent.RoleUpdate,
  AuditLogEvent.RoleDelete,
]);
const PROTECTED_CHANNEL_ACTIONS = new Set([
  AuditLogEvent.ChannelUpdate,
  AuditLogEvent.ChannelDelete,
]);
const LOCKDOWN_FLAGS = [
  "SendMessages",
  "SendMessagesInThreads",
  "CreatePublicThreads",
  "CreatePrivateThreads",
];
const RESTORABLE_CHANNEL_TYPES = new Set([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildVoice,
  ChannelType.GuildStageVoice,
  ChannelType.GuildCategory,
  ChannelType.GuildForum,
  ChannelType.GuildMedia,
]);

function permissionSnapshot(overwrite, flag) {
  if (overwrite?.allow.has(flag)) return true;
  if (overwrite?.deny.has(flag)) return false;
  return null;
}

function snapshotRole(role) {
  return {
    name: role.name,
    color: role.color,
    hoist: role.hoist,
    mentionable: role.mentionable,
    permissions: role.permissions.bitfield.toString(),
    position: role.position,
  };
}

function snapshotChannel(channel) {
  const overwrites = channel.permissionOverwrites?.cache?.map((overwrite) => ({
    id: overwrite.id,
    type: overwrite.type,
    allow: overwrite.allow.bitfield.toString(),
    deny: overwrite.deny.bitfield.toString(),
  })) ?? [];

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
    permissionOverwrites: overwrites,
  };
}

function channelCreateOptions(data, { parentId = null, reason, permissionOverwrites = data.permissionOverwrites }) {
  const options = {
    name: data.name,
    type: data.type,
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
    ].includes(data.type)
  ) {
    if (typeof data.topic === "string") options.topic = data.topic;
    options.nsfw = data.nsfw;
    options.rateLimitPerUser = data.rateLimitPerUser;
  }
  if ([ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(data.type)) {
    if (data.bitrate) options.bitrate = data.bitrate;
    if (data.userLimit) options.userLimit = data.userLimit;
  }
  return options;
}

function isTextMessageChannel(channel) {
  return (
    channel?.isTextBased?.() &&
    !channel.isThread?.() &&
    typeof channel.permissionOverwrites?.edit === "function"
  );
}

export class SecurityMonitor {
  constructor(client, store) {
    this.client = client;
    this.store = store;
    this.actionWindows = new Map();
    this.joinWindows = new Map();
    this.messageWindows = new Map();
    this.alertCooldowns = new Map();
    this.activeResponses = new Set();
    this.started = false;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.client.on("guildAuditLogEntryCreate", (entry, guild) => {
      void this.guard("audit entry", () => this.handleAuditEntry(entry, guild));
    });
    this.client.on("guildMemberAdd", (member) => {
      void this.guard("member join", () => this.handleMemberJoin(member));
    });
    this.client.on("messageCreate", (message) => {
      void this.guard("message scan", () => this.handleMessage(message));
    });
    this.client.on("webhooksUpdate", (channel) => {
      void this.guard("webhook update", async () => {
        const config = this.store.getConfig(channel.guild.id);
        if (config.enabled && config.antiWebhook) {
          await this.incident(channel.guild, {
            category: "webhook-change",
            severity: "medium",
            targetId: channel.id,
            details: `Webhooks changed in #${channel.name}. Reviewing audit events.`,
          });
        }
      });
    });
  }

  async guard(label, callback) {
    try {
      await callback();
    } catch (error) {
      console.error(`[Security] ${label} handler failed:`, error);
    }
  }

  pruneMap(map, maxEntries = 1000) {
    if (map.size <= maxEntries) return;
    const removeCount = map.size - maxEntries;
    for (const key of map.keys()) {
      map.delete(key);
      if (map.size <= maxEntries - removeCount) break;
    }
  }

  countWindow(map, key, windowMs, now = Date.now()) {
    const list = (map.get(key) ?? []).filter((timestamp) => now - timestamp < windowMs);
    list.push(now);
    map.set(key, list);
    this.pruneMap(map);
    return list.length;
  }

  trusted(guild, userId, member = null, isBot = false) {
    return Boolean(userId && String(guild.ownerId) === String(userId)) ||
      this.store.isTrusted(guild.id, userId, member, isBot);
  }

  canReadAuditLogs(guild) {
    return Boolean(
      guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog),
    );
  }

  async actorMember(guild, userId) {
    if (!userId) return null;
    return guild.members.fetch({ user: userId, force: true }).catch(() => null);
  }

  async incident(guild, incident) {
    const incidentId = this.store.recordIncident({ guildId: guild.id, ...incident });
    const cooldownKey = `${guild.id}:${incident.category}:${incident.actorId ?? incident.targetId ?? "all"}`;
    const now = Date.now();
    const lastSent = this.alertCooldowns.get(cooldownKey) ?? 0;
    if (now - lastSent < 5000) return incidentId;
    this.alertCooldowns.set(cooldownKey, now);
    this.pruneMap(this.alertCooldowns, 1000);

    const config = this.store.getConfig(guild.id);
    const channelId = config.logChannelId;
    if (!channelId) {
      console.warn(
        `[Security][${guild.id}] ${incident.severity ?? "medium"} ${incident.category}: ${incident.details}`,
      );
      return incidentId;
    }

    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!isTextMessageChannel(channel)) {
      console.warn(`[Security][${guild.id}] Configured alert channel is unavailable.`);
      return incidentId;
    }

    const colors = { low: 0x4c9f70, medium: 0xe7a53b, high: 0xd94f45, critical: 0x8c1d2c };
    const embed = new EmbedBuilder()
      .setTitle(`Security alert · ${incident.category}`)
      .setDescription(String(incident.details).slice(0, 3800))
      .setColor(colors[incident.severity] ?? colors.medium)
      .addFields(
        { name: "Severity", value: incident.severity ?? "medium", inline: true },
        { name: "Incident", value: `#${incidentId}`, inline: true },
      )
      .setTimestamp();

    await channel.send({
      embeds: [embed],
      allowedMentions: { parse: [] },
    }).catch((error) => {
      console.warn(`[Security][${guild.id}] Could not send alert: ${error.message}`);
    });
    return incidentId;
  }

  async handleAuditEntry(entry, guild) {
    if (!guild || !entry || !this.store.getConfig(guild.id).enabled) return;
    const config = this.store.getConfig(guild.id);
    const action = entry.action;
    const actorId = entry.executorId ?? entry.executor?.id ?? null;
    const targetId = entry.targetId ?? entry.target?.id ?? null;
    if (actorId && actorId === this.client.user?.id) return;
    const actionName = DESTRUCTIVE_ACTIONS.get(action);
    const actor = entry.executor ?? null;
    const member = actorId ? await this.actorMember(guild, actorId) : null;
    const isTrusted = this.trusted(guild, actorId, member, actor?.bot ?? false);

    if (actionName && actorId && !isTrusted && config.antiNuke) {
      const count = this.countWindow(
        this.actionWindows,
        `${guild.id}:${actorId ?? "unknown"}`,
        config.nukeWindowSeconds * 1000,
      );
      await this.incident(guild, {
        category: "destructive-audit-action",
        severity: count >= config.nukeLimit ? "critical" : "medium",
        actorId,
        targetId,
        details: `Audit log recorded ${actionName} by ${actor?.tag ?? actorId ?? "an unknown actor"}${targetId ? ` against ${targetId}` : ""}. ${count} monitored destructive actions occurred in ${config.nukeWindowSeconds} seconds.`,
      });

      if (count >= config.nukeLimit) {
        await this.respondToNuke(guild, member, actorId, count, config);
      }
    }

    if (
      config.permissionMonitoring &&
      [
        AuditLogEvent.ChannelOverwriteCreate,
        AuditLogEvent.ChannelOverwriteUpdate,
        AuditLogEvent.ChannelOverwriteDelete,
        AuditLogEvent.MemberRoleUpdate,
        AuditLogEvent.RoleUpdate,
      ].includes(action)
    ) {
      await this.incident(guild, {
        category: "permission-change",
        severity: isTrusted ? "low" : "high",
        actorId,
        targetId,
        details: `Permission-related audit change detected (action ${action}) by ${actor?.tag ?? actorId ?? "an unknown actor"}.`,
      });
    }

    if (
      [AuditLogEvent.WebhookCreate, AuditLogEvent.WebhookUpdate].includes(action) &&
      config.antiWebhook &&
      !isTrusted
    ) {
      await this.handleUntrustedWebhook(guild, entry, actorId);
    }

    if (
      action === AuditLogEvent.BotAdd &&
      config.antiMaliciousBot &&
      targetId
    ) {
      const botMember = await guild.members.fetch(targetId).catch(() => null);
      if (
        botMember?.user.bot &&
        !this.trusted(guild, targetId, botMember, true) &&
        !isTrusted
      ) {
        await this.incident(guild, {
          category: "unapproved-bot",
          severity: "high",
          actorId,
          targetId,
          details: `An unapproved bot (${botMember.user.tag}) was added. It will be removed if the bot has Kick Members permission and hierarchy allows it.`,
        });
        if (
          botMember.kickable &&
          guild.members.me?.permissions.has(PermissionFlagsBits.KickMembers)
        ) {
          await botMember.kick("Security: unapproved bot added").catch((error) => {
            console.warn(`[Security][${guild.id}] Could not remove unapproved bot: ${error.message}`);
          });
        }
      }
    }

    if (
      config.roleProtection &&
      PROTECTED_ROLE_ACTIONS.has(action) &&
      targetId
    ) {
      await this.restoreProtectedRole(guild, action, targetId, actorId, member, isTrusted);
    }

    if (
      config.channelProtection &&
      PROTECTED_CHANNEL_ACTIONS.has(action) &&
      targetId
    ) {
      await this.restoreProtectedChannel(guild, action, targetId, actorId, isTrusted);
    }
  }

  async respondToNuke(guild, member, actorId, count, config) {
    const key = `nuke:${guild.id}:${actorId ?? "unknown"}`;
    if (this.activeResponses.has(key)) return;
    this.activeResponses.add(key);
    try {
      if (member?.moderatable && guild.members.me?.permissions.has(PermissionFlagsBits.ModerateMembers)) {
        await member.timeout(10 * 60 * 1000, "Security system: destructive action threshold exceeded").catch((error) => {
          console.warn(`[Security][${guild.id}] Could not timeout suspected nuker: ${error.message}`);
        });
      }
      await this.incident(guild, {
        category: "anti-nuke-response",
        severity: "critical",
        actorId,
        details: `${count} destructive actions exceeded the configured threshold. Available moderation was applied. ${config.lockdownSnapshot ? "The server is already locked down." : "Emergency lockdown will be attempted."}`,
      });
      if (!config.lockdownSnapshot) await this.applyLockdown(guild, "automatic anti-nuke response");
    } finally {
      setTimeout(() => this.activeResponses.delete(key), 30_000).unref?.();
    }
  }

  async handleUntrustedWebhook(guild, entry, actorId) {
    const webhookId = entry.targetId ?? entry.target?.id;
    let removed = false;
    if (
      webhookId &&
      guild.members.me?.permissions.has(PermissionFlagsBits.ManageWebhooks)
    ) {
      const webhooks = await guild.fetchWebhooks().catch(() => null);
      const webhook = webhooks?.get(webhookId);
      if (webhook) {
        await webhook.delete("Security: webhook created by an untrusted actor")
          .then(() => { removed = true; })
          .catch((error) => console.warn(`[Security][${guild.id}] Could not remove webhook: ${error.message}`));
      }
    }
    await this.incident(guild, {
      category: "untrusted-webhook",
      severity: "high",
      actorId,
      targetId: webhookId ?? null,
      details: `Webhook creation by an untrusted actor was detected. ${removed ? "The webhook was removed." : "It could not be removed automatically; check Manage Webhooks permission and review it manually."}`,
    });
  }

  async restoreProtectedRole(guild, action, roleId, actorId, actorMember, isTrusted) {
    const protectedRole = this.store.getProtected(guild.id, "role", roleId);
    if (!protectedRole || isTrusted) return;
    const me = guild.members.me;
    if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
      await this.incident(guild, {
        category: "protected-role-change",
        severity: "high",
        actorId,
        targetId: roleId,
        details: "A protected role changed, but the bot lacks Manage Roles to restore it.",
      });
      return;
    }

    const data = protectedRole.snapshot;
    if (action === AuditLogEvent.RoleDelete) {
      const created = await guild.roles.create({
        name: data.name,
        color: data.color,
        hoist: data.hoist,
        mentionable: data.mentionable,
        permissions: BigInt(data.permissions),
        position: Math.max(1, Math.min(data.position, me.roles.highest.position - 1)),
        reason: `Security: restore protected role after untrusted deletion by ${actorId ?? "unknown actor"}`,
      }).catch((error) => {
        console.warn(`[Security][${guild.id}] Protected role restore failed: ${error.message}`);
        return null;
      });
      if (created) {
        this.store.updateProtectedId(guild.id, "role", roleId, created.id, data);
        for (const protectedChannel of this.store.listProtected(guild.id, "channel")) {
          const permissions = protectedChannel.snapshot.permissionOverwrites ?? [];
          if (!permissions.some((overwrite) => overwrite.type === 0 && overwrite.id === roleId)) {
            continue;
          }
          const updatedSnapshot = {
            ...protectedChannel.snapshot,
            permissionOverwrites: permissions.map((overwrite) =>
              overwrite.type === 0 && overwrite.id === roleId
                ? { ...overwrite, id: created.id }
                : overwrite,
            ),
          };
          this.store.protect(
            guild.id,
            "channel",
            protectedChannel.targetId,
            updatedSnapshot,
            "automatic-restore",
          );
        }
      }
      await this.incident(guild, {
        category: "protected-role-delete",
        severity: "critical",
        actorId,
        targetId: created?.id ?? roleId,
        details: created
          ? `An untrusted actor deleted protected role ${data.name}. A replacement role was created as ${created.id}; role assignments may need administrator review.`
          : `An untrusted actor deleted protected role ${data.name}; automatic recreation failed.`,
      });
      return;
    }

    const role = await guild.roles.fetch(roleId).catch(() => null);
    if (!role || role.managed || role.position >= me.roles.highest.position) {
      await this.incident(guild, {
        category: "protected-role-change",
        severity: "high",
        actorId,
        targetId: roleId,
        details: "A protected role was changed, but role hierarchy prevents automatic restoration.",
      });
      return;
    }

    await role.edit({
      name: data.name,
      color: data.color,
      hoist: data.hoist,
      mentionable: data.mentionable,
      permissions: BigInt(data.permissions),
      reason: `Security: restore protected role after untrusted edit by ${actorId ?? "unknown actor"}`,
    }).catch((error) => {
      console.warn(`[Security][${guild.id}] Protected role restore failed: ${error.message}`);
    });
    await role
      .setPosition(Math.max(1, Math.min(data.position, me.roles.highest.position - 1)), {
        reason: "Security: restore protected role position",
      })
      .catch(() => {});
    await this.incident(guild, {
      category: "protected-role-change",
      severity: "high",
      actorId,
      targetId: roleId,
      details: `Protected role ${data.name} was modified by an untrusted actor; stored settings were reapplied where Discord permissions allowed.`,
    });
  }

  async restoreProtectedChannel(guild, action, channelId, actorId, isTrusted) {
    const protectedChannel = this.store.getProtected(guild.id, "channel", channelId);
    if (!protectedChannel || isTrusted) return;
    const me = guild.members.me;
    if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
      await this.incident(guild, {
        category: "protected-channel-change",
        severity: "high",
        actorId,
        targetId: channelId,
        details: "A protected channel changed, but the bot lacks Manage Channels to restore it.",
      });
      return;
    }
    const data = protectedChannel.snapshot;
    if (action === AuditLogEvent.ChannelDelete) {
      if (!RESTORABLE_CHANNEL_TYPES.has(data.type)) {
        await this.incident(guild, {
          category: "protected-channel-delete",
          severity: "critical",
          actorId,
          targetId: channelId,
          details: `Deleted protected channel ${data.name} has an unsupported channel type and could not be recreated automatically.`,
        });
        return;
      }
      const parent = data.parentId ? guild.channels.cache.get(data.parentId) : null;
      const created = await guild.channels.create(channelCreateOptions(data, {
        parentId: parent?.type === ChannelType.GuildCategory ? parent.id : null,
        reason: `Security: restore protected channel after untrusted deletion by ${actorId ?? "unknown actor"}`,
      })).catch((error) => {
        console.warn(`[Security][${guild.id}] Protected channel restore failed: ${error.message}`);
        return null;
      });
      if (created) {
        await created.setPosition(data.position).catch(() => {});
        this.store.updateProtectedId(guild.id, "channel", channelId, created.id, data);
      }
      await this.incident(guild, {
        category: "protected-channel-delete",
        severity: "critical",
        actorId,
        targetId: created?.id ?? channelId,
        details: created
          ? `An untrusted actor deleted protected channel #${data.name}. A replacement was created as ${created.id}; review its visibility and integrations.`
          : `An untrusted actor deleted protected channel #${data.name}; automatic recreation failed.`,
      });
      return;
    }

    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || !isTextMessageChannel(channel) && !channel.permissionOverwrites) return;
    const parent = data.parentId ? guild.channels.cache.get(data.parentId) : null;
    const editOptions = {
      name: data.name,
      parent: parent?.type === ChannelType.GuildCategory ? parent.id : null,
      permissionOverwrites: data.permissionOverwrites,
      reason: `Security: restore protected channel after untrusted edit by ${actorId ?? "unknown actor"}`,
    };
    if (
      [
        ChannelType.GuildText,
        ChannelType.GuildAnnouncement,
        ChannelType.GuildForum,
        ChannelType.GuildMedia,
      ].includes(data.type)
    ) {
      if (typeof data.topic === "string") editOptions.topic = data.topic;
      editOptions.nsfw = data.nsfw;
      editOptions.rateLimitPerUser = data.rateLimitPerUser;
    }
    await channel.edit(editOptions).catch((error) => {
      console.warn(`[Security][${guild.id}] Protected channel restore failed: ${error.message}`);
    });
    await channel.setPosition(data.position).catch(() => {});
    await this.incident(guild, {
      category: "protected-channel-change",
      severity: "high",
      actorId,
      targetId: channelId,
      details: `Protected channel #${data.name} was modified by an untrusted actor; stored settings were reapplied where Discord permissions allowed.`,
    });
  }

  async handleMemberJoin(member) {
    if (member.user.bot) {
      const config = this.store.getConfig(member.guild.id);
      if (config.enabled && config.antiMaliciousBot && !this.trusted(member.guild, member.id, member, true)) {
        await this.incident(member.guild, {
          category: "unapproved-bot-join",
          severity: "high",
          targetId: member.id,
          details: `Bot ${member.user.tag} joined. The security system will review its inviter and trusted-bot list in the audit log.`,
        });
      }
    }

    const config = this.store.getConfig(member.guild.id);
    if (!config.enabled) return;

    const now = Date.now();
    const joinCount = this.countWindow(
      this.joinWindows,
      member.guild.id,
      config.raidWindowSeconds * 1000,
      now,
    );
    const accountAgeMs = now - member.user.createdTimestamp;
    if (config.antiRaid && accountAgeMs < 7 * 24 * 60 * 60 * 1000) {
      await this.incident(member.guild, {
        category: "new-account-join",
        severity: "low",
        targetId: member.id,
        details: `${member.user.tag} joined with an account less than seven days old.`,
      });
    }
    if (config.antiRaid && joinCount >= config.raidJoinLimit) {
      const key = `raid:${member.guild.id}`;
      if (this.activeResponses.has(key)) return;
      this.activeResponses.add(key);
      try {
        await this.incident(member.guild, {
          category: "possible-raid",
          severity: "critical",
          targetId: member.id,
          details: `${joinCount} members joined within ${config.raidWindowSeconds} seconds. Emergency lockdown is being attempted; human members are not auto-kicked.`,
        });
        if (!config.lockdownSnapshot) await this.applyLockdown(member.guild, "automatic anti-raid response");
      } finally {
        setTimeout(() => this.activeResponses.delete(key), config.raidWindowSeconds * 1000).unref?.();
      }
    }
  }

  async handleMessage(message) {
    if (!message.guild || message.author.bot) return;
    const config = this.store.getConfig(message.guild.id);
    if (!config.enabled || !config.antiSpam) return;
    const member = message.member;
    if (
      this.trusted(message.guild, message.author.id, member) ||
      member?.permissions.has(PermissionFlagsBits.ManageMessages)
    ) {
      return;
    }

    const key = `${message.guild.id}:${message.author.id}`;
    const now = Date.now();
    const events = (this.messageWindows.get(key) ?? []).filter(
      (event) => now - event.timestamp < config.spamWindowSeconds * 1000,
    );
    const content = message.content.trim().slice(0, 500);
    events.push({ timestamp: now, content });
    this.messageWindows.set(key, events);
    this.pruneMap(this.messageWindows);

    const repeated = content
      ? events.filter((event) => event.content && event.content === content).length
      : 0;
    const excessiveMentions =
      message.mentions.users.size >= 5 ||
      message.mentions.roles.size >= 5 ||
      message.mentions.everyone;
    if (events.length < config.spamMessageLimit && repeated < 4 && !excessiveMentions) return;

    const alertKey = `spam:${key}`;
    if (this.activeResponses.has(alertKey)) {
      if (
        message.deletable &&
        message.guild.members.me?.permissionsIn(message.channel).has(PermissionFlagsBits.ManageMessages)
      ) {
        await message.delete().catch(() => {});
      }
      return;
    }
    this.activeResponses.add(alertKey);
    try {
      if (
        message.deletable &&
        message.guild.members.me?.permissionsIn(message.channel).has(PermissionFlagsBits.ManageMessages)
      ) {
        await message.delete().catch(() => {});
      }
      if (member?.moderatable && message.guild.members.me?.permissions.has(PermissionFlagsBits.ModerateMembers)) {
        await member.timeout(60_000, "Security: anti-spam rate limit exceeded").catch(() => {});
      }
      await this.incident(message.guild, {
        category: "anti-spam",
        severity: "high",
        actorId: message.author.id,
        targetId: message.channelId,
        details: `${message.author.tag} exceeded the configured message rate, repeated-message, or mention threshold. The message was removed and moderation applied where permissions allow.`,
      });
    } finally {
      setTimeout(() => this.activeResponses.delete(alertKey), 10_000).unref?.();
    }
  }

  async applyLockdown(guild, reason = "administrator-requested lockdown") {
    if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
      await this.incident(guild, {
        category: "lockdown-failed",
        severity: "high",
        details: "Lockdown was requested but the bot lacks Manage Channels.",
      });
      return { success: false, changed: 0, failures: 0 };
    }
    const config = this.store.getConfig(guild.id);
    if (config.lockdownSnapshot) {
      return { success: true, alreadyLocked: true, changed: 0, failures: 0 };
    }

    const channels = await guild.channels.fetch().catch(() => guild.channels.cache);
    const snapshot = {};
    for (const channel of channels.values()) {
      if (
        !channel.permissionOverwrites?.edit ||
        channel.isThread?.() ||
        (channel.type !== ChannelType.GuildCategory && channel.permissionsLocked)
      ) {
        continue;
      }
      const overridesToPause = [];
      const everyoneOverwrite = channel.permissionOverwrites.cache.get(guild.id);
      overridesToPause.push({ id: guild.id, type: 0, overwrite: everyoneOverwrite });
      for (const overwrite of channel.permissionOverwrites.cache.values()) {
        if (overwrite.id === guild.id) continue;
        const grantsMessaging = LOCKDOWN_FLAGS.some((flag) => overwrite.allow.has(flag));
        if (grantsMessaging) {
          overridesToPause.push({
            id: overwrite.id,
            type: overwrite.type,
            overwrite,
          });
        }
      }
      snapshot[channel.id] = Object.fromEntries(
        overridesToPause.map(({ id, type, overwrite }) => [
          id,
          {
            type,
            permissions: Object.fromEntries(
              LOCKDOWN_FLAGS.map((flag) => [flag, permissionSnapshot(overwrite, flag)]),
            ),
          },
        ]),
      );
    }
    this.store.saveConfig(guild.id, { ...config, lockdownSnapshot: snapshot });

    let changed = 0;
    let failures = 0;
    for (const [channelId, overwrites] of Object.entries(snapshot)) {
      const channel = channels.get(channelId);
      if (
        !channel?.permissionOverwrites?.edit ||
        channel.isThread?.() ||
        (channel.type !== ChannelType.GuildCategory && channel.permissionsLocked)
      ) {
        continue;
      }
      try {
        for (const [targetId, overwrite] of Object.entries(overwrites)) {
          await channel.permissionOverwrites.edit(
            targetId,
            Object.fromEntries(LOCKDOWN_FLAGS.map((flag) => [flag, false])),
            { type: overwrite.type, reason: `Security lockdown: ${reason}` },
          );
        }
        changed += 1;
      } catch (error) {
        failures += 1;
        console.warn(`[Security][${guild.id}] Could not lock channel ${channel.id}: ${error.message}`);
      }
    }
    await this.incident(guild, {
      category: "lockdown",
      severity: "critical",
      details: `Emergency lockdown applied to ${changed} channels/categories. ${failures} could not be changed. Messaging permission grants on @everyone, roles, and individual users were temporarily paused. Reason: ${reason}. Use /security unlock to restore the saved permissions.`,
    });
    return { success: true, changed, failures };
  }

  async removeLockdown(guild) {
    const config = this.store.getConfig(guild.id);
    const snapshot = config.lockdownSnapshot;
    if (!snapshot) return { success: false, changed: 0, failures: 0, missing: true };
    if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
      return { success: false, changed: 0, failures: 0, missingPermission: true };
    }
    let changed = 0;
    let failures = 0;
    const remaining = {};
    for (const [channelId, overwrites] of Object.entries(snapshot)) {
      const channel = await guild.channels.fetch(channelId).catch(() => null);
      if (
        !channel?.permissionOverwrites?.edit ||
        channel.isThread?.() ||
        (channel.type !== ChannelType.GuildCategory && channel.permissionsLocked)
      ) continue;
      try {
        const targets = overwrites.permissions
          ? [[guild.id, overwrites]]
          : [[guild.id, { type: 0, permissions: overwrites }]];
        for (const [targetId, overwrite] of targets) {
          await channel.permissionOverwrites.edit(targetId, overwrite.permissions, {
            type: overwrite.type,
            reason: "Security lockdown ended; restore saved messaging permissions",
          });
        }
        changed += 1;
      } catch (error) {
        failures += 1;
        remaining[channelId] = overwrites;
        console.warn(`[Security][${guild.id}] Could not restore channel ${channelId}: ${error.message}`);
      }
    }
    this.store.saveConfig(guild.id, {
      ...config,
      lockdownSnapshot: failures ? remaining : null,
    });
    await this.incident(guild, {
      category: "lockdown-ended",
      severity: "medium",
      details: `Lockdown ended. Restored saved messaging permission overwrites in ${changed} channels; ${failures} failed. Unrelated permissions were not changed. Changes to these same messaging permissions made during lockdown are replaced by the saved snapshot.`,
    });
    return { success: true, changed, failures };
  }

  async makeBackup(guild, createdBy) {
    await guild.roles.fetch().catch(() => {});
    const channels = await guild.channels.fetch().catch(() => guild.channels.cache);
    const roles = [...guild.roles.cache.values()]
      .filter((role) => !role.managed && role.id !== guild.id)
      .map((role) => ({ id: role.id, ...snapshotRole(role) }));
    const channelSnapshots = [...channels.values()]
      .filter((channel) => RESTORABLE_CHANNEL_TYPES.has(channel.type))
      .map((channel) => ({ id: channel.id, ...snapshotChannel(channel) }));
    return this.store.createBackup(guild.id, createdBy, {
      version: 1,
      guildId: guild.id,
      guildName: guild.name,
      createdAt: new Date().toISOString(),
      securityConfig: {
        ...this.store.getConfig(guild.id),
        lockdownSnapshot: null,
      },
      allowlist: this.store.listAllowlist(guild.id),
      protected: this.store.listProtected(guild.id),
      roles,
      channels: channelSnapshots,
    });
  }
}

export {
  RESTORABLE_CHANNEL_TYPES,
  snapshotChannel,
  snapshotRole,
};