"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { MaintenanceWorker } = require("../lib/worker");

test("maintenance 续建提醒并处理删除中的账号", async () => {
  const refreshed = [];
  const deleted = [];
  const service = {
    cleanupPendingMedia: async () => {},
    refreshReminders: async (id) => refreshed.push(id),
  };
  const store = {
    listAccountsForMaintenance: async () => [
      { _id: "acct_active", status: "active" },
      { _id: "acct_deleting", status: "deleting" },
    ],
    processAccountDeletion: async (id) => {
      deleted.push(id);
      return true;
    },
    listAllOwned: async (key, accountId) =>
      key === "medications"
        ? [{ _id: `med_${accountId}`, status: "active" }]
        : [],
  };
  const result = await new MaintenanceWorker({
    store,
    service,
    clock: () => new Date("2026-09-06T00:00:00.000Z"),
    logger: { warn() {} },
  }).run();
  assert.equal(result.accounts, 2);
  assert.deepEqual(deleted, ["acct_deleting"]);
  assert.deepEqual(refreshed, ["med_acct_active"]);
});

test("125 个账号跨三次新实例按 50/50/25 持久续跑且覆盖尾部删除账号", async () => {
  const accounts = Array.from({ length: 125 }, (_, index) => ({
    _id: String(index + 1).padStart(3, "0"),
    status: index === 124 ? "deleting" : "active",
  }));
  const checkpoint = { cursor: null, round: 1 };
  const processed = [];
  const store = {
    async getMaintenanceCheckpoint() {
      return { ...checkpoint };
    },
    async saveMaintenanceCheckpoint(next) {
      Object.assign(checkpoint, next);
    },
    async listAccountsForMaintenancePage(cursor, limit) {
      const rows = accounts.filter(
        (account) => !cursor || account._id > cursor,
      );
      const items = rows.slice(0, limit);
      return {
        items,
        nextCursor: rows.length > items.length ? items.at(-1)._id : null,
      };
    },
    async processAccountDeletion(id) {
      processed.push(`delete:${id}`);
      return true;
    },
    async listAllOwned(name, accountId) {
      processed.push(`${name}:${accountId}`);
      return [];
    },
  };
  const service = {
    async cleanupPendingMedia() {},
    async refreshReminders() {},
  };

  for (let round = 0; round < 3; round += 1) {
    await new MaintenanceWorker({
      store,
      service,
      logger: { warn() {} },
    }).run();
  }

  const processedAccountIds = new Set(
    processed.map((item) => item.split(":").at(-1)),
  );
  assert.equal(processedAccountIds.size, 125);
  assert.equal(
    processed.filter((item) => item.startsWith("media:")).length,
    124,
  );
  assert.equal(processed.includes("delete:125"), true);
  assert.equal(checkpoint.cursor, null);
  assert.equal(checkpoint.round, 2);
});

test("删除队列优先、半途失败不跳过，下一实例可续跑", async () => {
  const checkpoint = {
    cursor: null,
    deletingCursor: null,
    deletingSweepComplete: false,
    round: 1,
  };
  const deleted = [];
  const refreshed = [];
  let failedOnce = true;
  const deletingAccount = { _id: "delete-tail", status: "deleting" };
  const store = {
    async getMaintenanceCheckpoint() {
      return { ...checkpoint };
    },
    async saveMaintenanceCheckpoint(next) {
      Object.assign(checkpoint, next);
    },
    async listDeletingAccountsForMaintenancePage(cursor, limit) {
      const rows = [deletingAccount].filter(
        (x) => !x.processed && (!cursor || x._id > cursor),
      );
      return { items: rows.slice(0, limit), nextCursor: null };
    },
    async listAccountsForMaintenancePage(cursor, limit) {
      const rows = ["001", "002", "003"]
        .map((_id) => ({ _id, status: "active" }))
        .filter((x) => !cursor || x._id > cursor);
      const items = rows.slice(0, limit);
      return {
        items,
        nextCursor: rows.length > items.length ? items.at(-1)._id : null,
      };
    },
    async processAccountDeletion(id) {
      deleted.push(id);
      if (id === "delete-tail") deletingAccount.processed = true;
      return true;
    },
    async listAllOwned(key, id) {
      if (key === "medications" && id === "001" && failedOnce) {
        failedOnce = false;
        throw Object.assign(new Error("retryable"), { code: "RETRYABLE" });
      }
      if (key === "medications") return [{ _id: id, status: "active" }];
      return [];
    },
    async recordMaintenanceFailure(id, code) {
      checkpoint.failure = { id, code };
    },
  };
  const service = {
    async cleanupPendingMedia() {},
    async refreshReminders(id) {
      refreshed.push(id);
    },
  };
  const first = await new MaintenanceWorker({
    store,
    service,
    logger: { warn() {} },
  }).run({ limit: 2 });
  assert.equal(first.failures, 1);
  assert.deepEqual(deleted, ["delete-tail"]);
  assert.equal(checkpoint.deletingSweepComplete, true);
  // The first active page begins with 001 and leaves it retryable; the next
  // instance starts at the same cursor and reaches all three accounts.
  const second = await new MaintenanceWorker({
    store,
    service,
    logger: { warn() {} },
  }).run({ limit: 2 });
  assert.equal(second.failures, 0);
  const third = await new MaintenanceWorker({
    store,
    service,
    logger: { warn() {} },
  }).run({ limit: 2 });
  assert.equal(third.failures, 0);
  assert.deepEqual(refreshed.sort(), ["001", "002", "003"]);
});

test("并发执行者由持久租约拒绝第二个，时间预算退出保留游标", async () => {
  let locked = false;
  const checkpoint = {
    cursor: null,
    deletingCursor: null,
    deletingSweepComplete: true,
    round: 1,
  };
  const store = {
    async claimMaintenanceLease() {
      if (locked) return false;
      locked = true;
      return true;
    },
    async getMaintenanceCheckpoint() {
      return { ...checkpoint };
    },
    async saveMaintenanceCheckpoint(next) {
      Object.assign(checkpoint, next);
      locked = false;
    },
    async listAccountsForMaintenancePage(cursor, limit) {
      const rows = ["001", "002"]
        .map((_id) => ({ _id, status: "active" }))
        .filter((x) => !cursor || x._id > cursor);
      const items = rows.slice(0, limit);
      return {
        items,
        nextCursor: rows.length > items.length ? items.at(-1)._id : null,
      };
    },
    async listAllOwned() {
      return [];
    },
  };
  const service = {
    async cleanupPendingMedia() {},
    async refreshReminders() {},
  };
  const first = new MaintenanceWorker({
    store,
    service,
    clock: () => new Date("2026-09-07T00:00:00.000Z"),
  });
  const second = new MaintenanceWorker({
    store,
    service,
    clock: () => new Date("2026-09-07T00:00:00.000Z"),
  });
  // A zero budget still leaves a durable checkpoint rather than claiming a
  // second worker's work; the second invocation is rejected while the first
  // lease is held.
  const [a, b] = await Promise.all([
    first.run({ budgetMs: 1 }),
    second.run({ budgetMs: 1 }),
  ]);
  assert.equal(
    [a.locked === true, b.locked === true].filter(Boolean).length,
    1,
  );
  assert.equal(checkpoint.cursor === null || checkpoint.cursor === "001", true);
});
