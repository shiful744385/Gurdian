import {
  AuditLogEvent,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
} from "discord.js";

export const GUARDIAN_LOG_CHANNEL_NAME = "🔐・guardian-logs";

const VIEW_CHANNEL_ALLOW = ["ViewChannel", "ReadMessageHistory"];
const BOT_CHANNEL_ALLOW = [...VIEW_CHANNEL_ALLOW, "SendMessages", "EmbedLinks"];
const SEVERITY_COLORS = {
  info: 0x3978c5,
  low: 0x4c9f70,
  medium: 0xe7a53b,
  high: 0xd94f45,
  critical: 0x8c1d2c,
};

const AUDIT_LABELS = new Map([
  [AuditLogEvent.MemberBanAdd, "Member banned"],
  [AuditLogEvent.MemberBanRemove, "Member unbanned"],
  [AuditLogEvent.MemberKick, "Member kicked"],
  [AuditLogEvent.MemberPrune, "Members pruned"],
  [AuditLogEvent.MemberUpdate, "Member updated"],
  [AuditLogEvent.MemberRoleUpdate, "Member roles changed"],
  [AuditLogEvent.ChannelCreate, "Channel created"],
  [AuditLogEvent.ChannelUpdate, "Channel updated"],
  [AuditLogEvent.ChannelDelete, "Channel deleted"],
  [AuditLogEvent.ChannelOverwriteCreate, "Channel permission overwrite created"],
  [AuditLogEvent.ChannelOverwriteUpdate, "Channel permission overwrite updated"],
  [AuditLogEvent.ChannelOverwriteDelete, "Channel permission overwrite deleted"],
  [AuditLogEvent.RoleCreate, "Role created"],
  [AuditLogEvent.RoleUpdate, "Role updated"],
  [AuditLogEvent.RoleDelete, "Role deleted"],
  [AuditLogEvent.BotAdd, "Bot added"],
  [AuditLogEvent.WebhookCreate, "Webhook created"],
  [AuditLogEvent.WebhookUpdate, "Webhook updated"],
  [AuditLogEvent.WebhookDelete, "Webhook deleted"],
  [AuditLogEvent.GuildUpdate, "Server settings updated"],
  [AuditLogEvent.MessageDelete, "Message deleted"],
  [AuditLogEvent.MessageBulkDelete, "Messages bulk deleted"],
]);

export function buildGuardianLogOverwrites(guild, botUserId) {
  const adminRoles = [...guild.roles.cache.values()]
    .filter(
      (role) =>
        role.id !== guild.id &&
        !role.permissions.has(PermissionFlagsBits.Administrator) &&
        role.permissions.has(PermissionFlagsBits.ManageGuild),
    )
    .sort((left, right) => right.position - left.position);

  if (adminRoles.length > 98) {
    throw new Error("Too many Manage Server roles to grant log-channel access safely.");
  }

  return [
    { id: guild.id, type: 0, deny: ["ViewChannel"] },
    { id: botUserId, type: 1, allow: BOT_CHANNEL_ALLOW },
    ...adminRoles.map((role) => ({
      id: role.id,
      type: 0,
      allow: VIEW_CHANNEL_ALLOW,
    })),
  ];
}

function auditDescription(entry) {
  const label = AUDIT_LABELS.get(entry.action);
  if (!label) return null;

  let actionLabel = label;
  let timeoutDetail = "";
  if (entry.action === AuditLogEvent.MemberUpdate) {
    const timeoutChange = entry.changes?.find(
      (change) => change.key === "communication_disabled_until",
    );
    if (timeoutChange) {
      actionLabel = timeoutChange.new ? "Member timed out" : "Member timeout removed";
      timeoutDetail = timeoutChange.new ? `Until: ${timeoutChange.new}` : "";
    }
  }

  const actor = entry.executor?.tag
    ? `${entry.executor.tag} (${entry.executorId ?? entry.executor.id})`
    : entry.executorId ?? "Unknown actor";
  const targetName = entry.target?.name ?? entry.target?.tag ?? entry.target?.username;
  const isInvite = [AuditLogEvent.InviteCreate, AuditLogEvent.InviteDelete].includes(entry.action);
  const targetId = isInvite ? null : (entry.targetId ?? entry.target?.id);
  const target = targetName
    ? `${targetName}${targetId ? ` (${targetId})` : ""}`
    : targetId ?? "Not available";
  const changeKeys = (entry.changes ?? [])
    .map((change) => change.key)
    .filter(Boolean)
    .slice(0, 8)
    .join(", ");
  const extraChannel = entry.extra?.channel?.name;
  const details = [
    `Actor: ${actor}`,
    `Target: ${target}`,
    extraChannel ? `Channel: #${extraChannel}` : "",
    timeoutDetail,
    changeKeys ? `Changed: ${changeKeys}` : "",
  ].filter(Boolean);
  return { title: actionLabel, description: details.join("\n") };
}

function memberLabel(member) {
  const user = member?.user ?? member;
  return user?.tag
    ? `${user.tag} (${user.id})`
    : user?.id
      ? `User ${user.id}`
      : "Unknown user";
}

function safeError(error) {
  return `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`.slice(0, 1800);
}

export class GuardianLogs {
  constructor(client, { memberJoinMonitoringEnabled = false } = {}) {
    this.client = client;
    this.memberJoinMonitoringEnabled = memberJoinMonitoringEnabled;
    this.channels = new Map();
    this.provisioning = new Map();
    this.started = false;
  }

  start() {
    if (this.started) return;
    this.started = true;

    this.client.once("ready", () => {
      void this.guard("startup", async () => {
        for (const guild of this.client.guilds.cache.values()) {
          await this.ensureChannel(guild);
          await this.logToGuild(guild, {
            title: "Bot started / restarted",
            severity: "info",
            description: this.memberJoinMonitoringEnabled
              ? "The economy/security bot connected and GuardianX logging is active."
              : "The economy/security bot connected. Member join/leave logging requires the privileged Server Members intent.",
          });
        }
      });
    });

    this.client.on("guildCreate", (guild) => {
      void this.guard("new server setup", async () => {
        await this.ensureChannel(guild);
        await this.logToGuild(guild, {
          title: "Bot added to server",
          severity: "info",
          description: "The bot joined this server and initialized its private security log channel.",
        });
      });
    });

    if (this.memberJoinMonitoringEnabled) {
      this.client.on("guildMemberAdd", (member) => {
        void this.logToGuild(member.guild, {
          title: "Member joined",
          description: `${memberLabel(member)} joined the server.`,
        });
      });
      this.client.on("guildMemberRemove", (member) => {
        void this.logToGuild(member.guild, {
          title: "Member left",
          description: `${memberLabel(member)} left or was removed from the server.`,
        });
      });
    }

    this.client.on("inviteCreate", (invite) => {
      if (!invite.guild) return;
      void this.logToGuild(invite.guild, {
        title: "Invite created",
        description: [
          `Created by: ${memberLabel(invite.inviter)}`,
          `Channel: ${invite.channel?.name ? `#${invite.channel.name}` : "Not available"}`,
          `Max uses: ${invite.maxUses ?? "Unlimited"}`,
        ].join("\n"),
      });
    });
    this.client.on("inviteDelete", (invite) => {
      if (!invite.guild) return;
      void this.logToGuild(invite.guild, {
        title: "Invite deleted",
        description: `Invite for ${invite.channel?.name ? `#${invite.channel.name}` : "an unknown channel"} was deleted. Invite codes are not included in logs.`,
      });
    });

    this.client.on("messageDelete", (message) => {
      if (!message.guild) return;
      const logChannel = this.channels.get(message.guild.id);
      if (
        message.author?.id === this.client.user?.id &&
        message.channelId === logChannel?.id
      ) {
        return;
      }
      void this.logToGuild(message.guild, {
        title: "Message deleted",
        description: [
          `Author: ${memberLabel(message.author)}`,
          `Channel: #${message.channel?.name ?? message.channelId ?? "unknown"}`,
          `Message ID: ${message.id}`,
          "Message content is intentionally not stored.",
        ].join("\n"),
      });
    });
    this.client.on("messageDeleteBulk", (messages, channel) => {
      if (!channel.guild) return;
      void this.logToGuild(channel.guild, {
        title: "Messages bulk deleted",
        description: `${messages.size} messages were deleted in #${channel.name} (${channel.id}). Message content is intentionally not stored.`,
        severity: "medium",
      });
    });

    this.client.on("channelDelete", (channel) => {
      if (channel.name === GUARDIAN_LOG_CHANNEL_NAME && channel.guild) {
        this.channels.delete(channel.guild.id);
      }
    });
    this.client.on("error", (error) => {
      void this.logToAllGuilds("Discord client error", safeError(error), "high");
    });
    this.client.on("shardError", (error) => {
      void this.logToAllGuilds("Discord gateway error", safeError(error), "high");
    });
  }

  async guard(label, callback) {
    try {
      await callback();
    } catch (error) {
      console.error(`[GuardianX] ${label} failed:`, error);
      await this.logToAllGuilds(`${label} error`, safeError(error), "high");
    }
  }

  ensureChannel(guild) {
    const cached = this.channels.get(guild.id);
    if (cached && guild.channels.cache.has(cached.id)) {
      return Promise.resolve(cached);
    }
    const pending = this.provisioning.get(guild.id);
    if (pending) return pending;

    const promise = this.createOrSecureChannel(guild).finally(() => {
      this.provisioning.delete(guild.id);
    });
    this.provisioning.set(guild.id, promise);
    return promise;
  }

  async createOrSecureChannel(guild) {
    const botMember = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
    if (!botMember?.permissions.has(PermissionFlagsBits.ManageChannels)) {
      throw new Error(`Manage Channels is required to create or secure ${GUARDIAN_LOG_CHANNEL_NAME}.`);
    }

    const existing = guild.channels.cache.find(
      (channel) => channel.name === GUARDIAN_LOG_CHANNEL_NAME,
    );
    if (
      existing &&
      ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(existing.type)
    ) {
      throw new Error(`A non-text channel already uses the name ${GUARDIAN_LOG_CHANNEL_NAME}.`);
    }

    const overwrites = buildGuardianLogOverwrites(guild, this.client.user.id);
    if (!existing) {
      const created = await guild.channels.create({
        name: GUARDIAN_LOG_CHANNEL_NAME,
        type: ChannelType.GuildText,
        topic: "Private GuardianX security and moderation logs.",
        permissionOverwrites: overwrites,
        reason: "Initialize private GuardianX security logs",
      });
      this.channels.set(guild.id, created);
      return created;
    }

    const permittedIds = new Set(overwrites.map((overwrite) => overwrite.id));
    const additionalIds = overwrites.filter(
      (overwrite) => !existing.permissionOverwrites.cache.has(overwrite.id),
    ).length;
    if (existing.permissionOverwrites.cache.size + additionalIds > 100) {
      throw new Error(`Cannot secure ${GUARDIAN_LOG_CHANNEL_NAME}: Discord's 100-overwrite limit would be exceeded.`);
    }

    for (const current of existing.permissionOverwrites.cache.values()) {
      if (permittedIds.has(current.id) || !current.allow.has(PermissionFlagsBits.ViewChannel)) {
        continue;
      }
      await existing.permissionOverwrites.edit(
        current.id,
        { ViewChannel: false },
        {
          type: current.type,
          reason: "Keep the dedicated GuardianX log channel private",
        },
      );
    }

    for (const overwrite of overwrites) {
      const permissions = overwrite.deny?.length
        ? { ViewChannel: false }
        : overwrite.id === this.client.user.id
          ? Object.fromEntries(BOT_CHANNEL_ALLOW.map((permission) => [permission, true]))
          : Object.fromEntries(VIEW_CHANNEL_ALLOW.map((permission) => [permission, true]));
      await existing.permissionOverwrites.edit(overwrite.id, permissions, {
        type: overwrite.type,
        reason: "Secure the dedicated GuardianX log channel",
      });
    }

    this.channels.set(guild.id, existing);
    return existing;
  }

  async logToGuild(guild, { title, description, severity = "low" }) {
    if (!guild) return;
    try {
      const channel = await this.ensureChannel(guild);
      const embed = new EmbedBuilder()
        .setTitle(`GuardianX · ${String(title).slice(0, 230)}`)
        .setDescription(String(description).slice(0, 3800))
        .setColor(SEVERITY_COLORS[severity] ?? SEVERITY_COLORS.low)
        .setFooter({ text: "Security event log · Message content and invite codes are omitted" })
        .setTimestamp();
      await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    } catch (error) {
      console.error(`[GuardianX][${guild.id}] Could not write security log:`, error);
      this.channels.delete(guild.id);
    }
  }

  async logAuditEntry(guild, entry) {
    const audit = auditDescription(entry);
    if (!audit) return;
    await this.logToGuild(guild, {
      ...audit,
      severity: [
        AuditLogEvent.MemberBanAdd,
        AuditLogEvent.MemberKick,
        AuditLogEvent.RoleDelete,
        AuditLogEvent.ChannelDelete,
      ].includes(entry.action) ? "medium" : "low",
    });
  }

  async logToAllGuilds(title, description, severity = "high") {
    for (const guild of this.client.guilds.cache.values()) {
      await this.logToGuild(guild, { title, description, severity });
    }
  }
}