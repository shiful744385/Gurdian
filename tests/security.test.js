import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  ChannelType,
  PermissionFlagsBits,
  PermissionsBitField,
} from "discord.js";
import {
  buildGuardianLogOverwrites,
  GUARDIAN_LOG_CHANNEL_NAME,
} from "../src/security/guardian-logs.js";
import {
  matchesSecurityPrefix,
  handleSecurityPrefixMessage,
  parseSecurityPrefixInvocation,
} from "../src/security/prefix-commands.js";
import { SecurityStore } from "../src/security/store.js";
import { SecurityMonitor } from "../src/security/monitor.js";

function temporaryDatabase(t) {
  const directory = mkdtempSync(join(tmpdir(), "discord-security-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "test.sqlite3");
}

test("security management commands are routed through the ?r prefix", () => {
  const subcommands = [
    "dashboard",
    "status",
    "setup",
    "config",
    "logs",
    "lockdown",
    "unlock",
    "lock-channel",
    "unlock-channel",
    "whitelist",
    "protect-role",
    "protect-channel",
    "backup",
    "restore",
    "verify",
    "test",
  ];
  for (const subcommand of subcommands) {
    assert.equal(
      parseSecurityPrefixInvocation(`?r ${subcommand}`).subcommand,
      subcommand,
    );
  }
});

test("GuardianX log channel denies everyone and grants only bot/admin visibility", () => {
  const guild = {
    id: "guild-1",
    roles: {
      cache: new Map([
        [
          "manage-guild",
          {
            id: "manage-guild",
            position: 5,
            permissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild),
          },
        ],
        [
          "administrator",
          {
            id: "administrator",
            position: 10,
            permissions: new PermissionsBitField(PermissionFlagsBits.Administrator),
          },
        ],
        [
          "member",
          {
            id: "member",
            position: 1,
            permissions: new PermissionsBitField(PermissionFlagsBits.SendMessages),
          },
        ],
      ]),
    },
  };
  const overwrites = buildGuardianLogOverwrites(guild, "bot-1");

  assert.equal(GUARDIAN_LOG_CHANNEL_NAME, "🔐・guardian-logs");
  assert.deepEqual(overwrites[0], {
    id: "guild-1",
    type: 0,
    deny: ["ViewChannel"],
  });
  assert.deepEqual(overwrites[1], {
    id: "bot-1",
    type: 1,
    allow: ["ViewChannel", "ReadMessageHistory", "SendMessages", "EmbedLinks"],
  });
  assert.ok(overwrites.some((overwrite) => overwrite.id === "manage-guild"));
  assert.ok(!overwrites.some((overwrite) => overwrite.id === "member"));
  assert.ok(!overwrites.some((overwrite) => overwrite.id === "administrator"));
});

test("security prefix accepts only ?r and parses config and whitelist options", () => {
  assert.equal(matchesSecurityPrefix("?r status"), true);
  assert.equal(matchesSecurityPrefix("  ?R setup"), true);
  assert.equal(matchesSecurityPrefix("?random status"), false);
  assert.equal(matchesSecurityPrefix("o balance"), false);

  assert.deepEqual(parseSecurityPrefixInvocation("?r config anti-spam false"), {
    subcommand: "config",
    values: {
      setting: "anti_spam",
      enabled: "false",
      clear: null,
    },
  });
  assert.deepEqual(
    parseSecurityPrefixInvocation("?r whitelist action:add type:user user:<@12345678901234567>"),
    {
      subcommand: "whitelist",
      values: {
        action: "add",
        type: "user",
        user: "<@12345678901234567>",
      },
    },
  );
  assert.deepEqual(
    parseSecurityPrefixInvocation("?r lock-channel channel:<#12345678901234567> confirm:true"),
    {
      subcommand: "lock-channel",
      values: {
        channel: "<#12345678901234567>",
        confirm: "true",
      },
    },
  );
  assert.deepEqual(
    parseSecurityPrefixInvocation("?r unlock-channel #general"),
    {
      subcommand: "unlock-channel",
      values: { channel: "#general", confirm: null },
    },
  );
  assert.equal(parseSecurityPrefixInvocation("o balance"), null);
});

test("security prefix updates settings and sends the result privately", async (t) => {
  const store = new SecurityStore(temporaryDatabase(t));
  const privateReplies = [];
  const message = {
    content: "?r config setting:anti_spam enabled:false",
    guild: { id: "guild-1" },
    guildId: "guild-1",
    member: { permissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild) },
    mentions: {
      users: new Map(),
      roles: new Map(),
      channels: new Map(),
    },
    author: {
      id: "moderator-1",
      tag: "moderator#0001",
      send: async (payload) => {
        privateReplies.push(payload);
        return {
          edit: async (updatedPayload) => {
            privateReplies.push(updatedPayload);
            return updatedPayload;
          },
        };
      },
    },
    reply: async () => {},
  };

  await handleSecurityPrefixMessage(message, {
    client: { users: { fetch: async () => null } },
    securityStore: store,
    monitor: { memberJoinMonitoringEnabled: false },
    guardianLogs: { logToGuild: async () => {} },
  });

  assert.equal(store.getConfig("guild-1").antiSpam, false);
  assert.equal(privateReplies[0], "Processing your security command…");
  assert.match(privateReplies[1].content, /disabled/);
  store.close();
});

test("security prefix does not change settings if the member cannot receive private replies", async () => {
  let saveCount = 0;
  const publicReplies = [];
  const message = {
    content: "?r config setting:anti_spam enabled:false",
    guild: { id: "guild-1" },
    guildId: "guild-1",
    member: { permissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild) },
    mentions: { users: new Map(), roles: new Map(), channels: new Map() },
    author: {
      id: "moderator-1",
      send: async () => {
        throw new Error("DMs are disabled");
      },
    },
    reply: async (payload) => publicReplies.push(payload),
  };

  await handleSecurityPrefixMessage(message, {
    client: { users: { fetch: async () => null } },
    securityStore: {
      getConfig: () => ({ enabled: false, antiSpam: true }),
      saveConfig: () => { saveCount += 1; },
    },
    monitor: { memberJoinMonitoringEnabled: false },
    guardianLogs: { logToGuild: async () => {} },
  });

  assert.equal(saveCount, 0);
  assert.match(publicReplies[0], /Enable DMs/);
});

test("individual channel lockdown saves and restores only that channel's messaging overwrites", async (t) => {
  const store = new SecurityStore(temporaryDatabase(t));
  t.after(() => store.close());
  const monitor = new SecurityMonitor({ user: { id: "bot-1" } }, store);
  monitor.incident = async () => {};
  const guild = {
    id: "guild-1",
    members: { me: { permissions: { has: () => true } } },
  };
  const edits = [];
  const channel = {
    id: "channel-1",
    guildId: guild.id,
    name: "general",
    type: ChannelType.GuildText,
    permissionsLocked: false,
    isThread: () => false,
    permissionOverwrites: {
      cache: new Map([
        [
          guild.id,
          {
            id: guild.id,
            type: 0,
            allow: { has: (permission) => permission === "SendMessages" },
            deny: { has: () => false },
          },
        ],
        [
          "role-1",
          {
            id: "role-1",
            type: 0,
            allow: { has: (permission) => permission === "SendMessagesInThreads" },
            deny: { has: () => false },
          },
        ],
      ]),
      edit: async (targetId, permissions) => edits.push({ targetId, permissions }),
    },
  };

  const locked = await monitor.applyChannelLockdown(guild, channel, "unit test");
  assert.equal(locked.success, true);
  assert.equal(locked.changed, 2);
  assert.equal(edits[0].permissions.SendMessages, false);
  assert.equal(edits[1].permissions.SendMessages, false);
  assert.equal(
    Object.keys(store.getConfig(guild.id).channelLockSnapshots).length,
    1,
  );

  const unlocked = await monitor.removeChannelLockdown(guild, channel);
  assert.equal(unlocked.success, true);
  assert.equal(unlocked.changed, 2);
  assert.equal(edits[2].permissions.SendMessages, true);
  assert.equal(edits[3].permissions.SendMessagesInThreads, true);
  assert.equal(
    Object.keys(store.getConfig(guild.id).channelLockSnapshots).length,
    0,
  );

  store.saveConfig(guild.id, {
    ...store.getConfig(guild.id),
    lockdownSnapshot: { "server-wide": {} },
  });
  const serverLockConflict = await monitor.applyChannelLockdown(guild, channel, "unit test");
  assert.equal(serverLockConflict.serverLocked, true);
  assert.equal(edits.length, 4);
});

test("synced channels require confirmation and are re-synced when unlocked", async (t) => {
  const store = new SecurityStore(temporaryDatabase(t));
  t.after(() => store.close());
  const monitor = new SecurityMonitor({ user: { id: "bot-1" } }, store);
  monitor.incident = async () => {};
  const guild = {
    id: "guild-2",
    members: { me: { permissions: { has: () => true } } },
  };
  const edits = [];
  let syncRestored = 0;
  const channel = {
    id: "channel-2",
    guildId: guild.id,
    name: "announcements",
    type: ChannelType.GuildText,
    permissionsLocked: true,
    isThread: () => false,
    lockPermissions: async () => { syncRestored += 1; },
    permissionOverwrites: {
      cache: new Map([
        [
          guild.id,
          {
            id: guild.id,
            type: 0,
            allow: { has: () => false },
            deny: { has: () => false },
          },
        ],
      ]),
      edit: async (targetId, permissions) => edits.push({ targetId, permissions }),
    },
  };

  const needsConfirmation = await monitor.applyChannelLockdown(guild, channel, "unit test");
  assert.equal(needsConfirmation.confirmationRequired, true);
  assert.equal(edits.length, 0);

  const locked = await monitor.applyChannelLockdown(guild, channel, "unit test", {
    confirmSynced: true,
  });
  assert.equal(locked.success, true);
  assert.equal(store.getConfig(guild.id).channelLockSnapshots[channel.id].wasSynced, true);

  const unlocked = await monitor.removeChannelLockdown(guild, channel);
  assert.equal(unlocked.success, true);
  assert.equal(syncRestored, 1);
  assert.equal(
    Object.keys(store.getConfig(guild.id).channelLockSnapshots).length,
    0,
  );
});

test("security persistence is guild-scoped and leaves economy rows unchanged", (t) => {
  const databasePath = temporaryDatabase(t);
  const initialDb = new DatabaseSync(databasePath);
  initialDb.exec(`
    CREATE TABLE economy_users (
      guild_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      balance INTEGER NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    );
  `);
  initialDb.prepare("INSERT INTO economy_users VALUES (?, ?, ?)").run("100", "200", 999);
  initialDb.close();

  const store = new SecurityStore(databasePath);
  assert.equal(store.getConfig("100").enabled, false);
  assert.equal(store.getConfig("101").enabled, false);

  store.saveConfig("100", { ...store.getConfig("100"), enabled: true, antiRaid: false });
  assert.equal(store.getConfig("100").enabled, true);
  assert.equal(store.getConfig("100").antiRaid, false);
  assert.equal(store.getConfig("101").enabled, false);

  store.addAllowlist("100", "user", "300", "400");
  store.addAllowlist("100", "role", "500", "400");
  assert.equal(store.isTrusted("100", "300"), true);
  assert.equal(
    store.isTrusted("100", "600", { roles: { cache: new Map([["500", {}]]) } }),
    true,
  );
  assert.equal(store.isTrusted("101", "300"), false);

  store.protect("100", "role", "500", { name: "Protected" }, "400");
  assert.equal(store.getProtected("100", "role", "500").snapshot.name, "Protected");
  store.recordIncident({
    guildId: "100",
    category: "unit-test",
    severity: "low",
    details: "stored securely",
  });
  assert.equal(store.listIncidents("100", 1)[0].details, "stored securely");

  const backup = store.createBackup("100", "400", {
    version: 1,
    roles: [],
    channels: [],
  });
  assert.equal(store.getBackup("100", backup.backupId).snapshot.version, 1);
  store.close();

  const finalDb = new DatabaseSync(databasePath, { readBigInts: true });
  const economyRow = finalDb.prepare("SELECT guild_id, user_id, balance FROM economy_users").get();
  assert.equal(String(economyRow.guild_id), "100");
  assert.equal(String(economyRow.user_id), "200");
  assert.equal(economyRow.balance, 999n);
  finalDb.close();
});