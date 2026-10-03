import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { securityCommandData } from "../src/security/commands.js";
import { SecurityStore } from "../src/security/store.js";

function temporaryDatabase(t) {
  const directory = mkdtempSync(join(tmpdir(), "discord-security-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "test.sqlite3");
}

test("security command registers the requested management subcommands", () => {
  const subcommands = securityCommandData.options.map((option) => option.name);
  assert.deepEqual(subcommands, [
    "dashboard",
    "status",
    "setup",
    "config",
    "logs",
    "lockdown",
    "unlock",
    "whitelist",
    "protect-role",
    "protect-channel",
    "backup",
    "restore",
    "verify",
    "test",
  ]);
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