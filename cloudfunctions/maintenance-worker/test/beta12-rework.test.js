"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { MaintenanceWorker } = require("../lib/worker");

function createWorkerStore({ checkpoint, deleting, active, onFailure }) {
  return {
    async getMaintenanceCheckpoint() {
      return { ...checkpoint };
    },
    async saveMaintenanceCheckpoint(next) {
      Object.assign(checkpoint, next);
    },
    async listDeletingAccountsForMaintenancePage(cursor, limit) {
      const rows = deleting.filter((item) => !cursor || item._id > cursor);
      return {
        items: rows.slice(0, limit),
        nextCursor: rows.length > limit ? rows.at(limit - 1)._id : null,
      };
    },
    async listAccountsForMaintenancePage(cursor, limit) {
      const rows = active.filter((item) => !cursor || item._id > cursor);
      return {
        items: rows.slice(0, limit),
        nextCursor: rows.length > limit ? rows.at(limit - 1)._id : null,
      };
    },
    async processAccountDeletion(accountId) {
      const account = deleting.find((item) => item._id === accountId);
      account.processed = true;
      return true;
    },
    async listAllOwned(collection, accountId) {
      if (collection === "medications" && accountId === "001") {
        throw Object.assign(new Error("transient account failure"), {
          code: "TRANSIENT",
        });
      }
      return [];
    },
    async recordMaintenanceFailure(accountId, code) {
      onFailure({ accountId, code });
    },
  };
}

const service = {
  async cleanupPendingMedia() {},
  async refreshReminders() {},
};

test("G2 red: a new deleting account is not skipped after the prior sweep", async () => {
  const checkpoint = {
    cursor: null,
    deletingCursor: null,
    deletingSweepComplete: true,
    round: 4,
  };
  const deleting = [{ _id: "003", status: "deleting" }];
  const store = createWorkerStore({
    checkpoint,
    deleting,
    active: [],
    onFailure() {},
  });

  await new MaintenanceWorker({
    store,
    service,
    logger: { warn() {} },
  }).run();

  assert.equal(deleting[0].processed, true);
});

test("G2 red: a persistent first-account failure must not starve later accounts", async () => {
  const checkpoint = {
    cursor: null,
    deletingCursor: null,
    deletingSweepComplete: true,
    round: 1,
  };
  const failures = [];
  const active = [
    { _id: "001", status: "active" },
    { _id: "002", status: "active" },
  ];
  const processed = [];
  const store = createWorkerStore({
    checkpoint,
    deleting: [],
    active,
    onFailure: (failure) => failures.push(failure),
  });
  store.listAllOwned = async (collection, accountId) => {
    if (collection === "medications" && accountId === "001") {
      throw Object.assign(new Error("persistent account failure"), {
        code: "PERSISTENT",
      });
    }
    if (collection === "medications") processed.push(accountId);
    return [];
  };

  await new MaintenanceWorker({
    store,
    service,
    logger: { warn() {} },
  }).run({ limit: 2 });

  assert.deepEqual(failures, [{ accountId: "001", code: "PERSISTENT" }]);
  assert.deepEqual(processed, ["002"]);
});
