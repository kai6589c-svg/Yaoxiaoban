"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { MaintenanceWorker } = require("../lib/worker");

const service = {
  async cleanupPendingMedia() {},
  async refreshReminders() {},
};

function page(items, cursor, limit) {
  const rows = items.filter((item) => !cursor || item._id > cursor);
  return {
    items: rows.slice(0, limit),
    nextCursor: rows.length > limit ? rows[limit - 1]._id : null,
  };
}

function baseStore({
  accounts = [],
  deleting = [],
  checkpoint,
  onFailure,
} = {}) {
  const state = checkpoint ?? {
    cursor: null,
    deletingCursor: null,
    deletingSweepComplete: false,
    round: 1,
  };
  const calls = { normalLimits: [], deletingLimits: [], processed: [] };
  const store = {
    calls,
    async getMaintenanceCheckpoint() {
      return { ...state };
    },
    async saveMaintenanceCheckpoint(next) {
      Object.assign(state, next);
      return true;
    },
    async listAccountsForMaintenancePage(cursor, limit) {
      calls.normalLimits.push(limit);
      return page(accounts, cursor, limit);
    },
    async listDeletingAccountsForMaintenancePage(cursor, limit) {
      calls.deletingLimits.push(limit);
      return page(deleting, cursor, limit);
    },
    async processAccountDeletion(id) {
      calls.processed.push(`delete:${id}`);
      return true;
    },
    async listAllOwned() {
      return [];
    },
    async recordMaintenanceFailure(id, code) {
      onFailure?.({ id, code });
    },
  };
  return { store, state };
}

async function run(store, options) {
  return new MaintenanceWorker({
    store,
    service,
    logger: { warn() {}, error() {} },
  }).run(options);
}

test("M01: default work budget is capped at 50", async () => {
  const { store } = baseStore({
    accounts: Array.from({ length: 100 }, (_, i) => ({
      _id: String(i).padStart(3, "0"),
      status: "active",
    })),
  });
  await run(store);
  assert.equal(store.calls.normalLimits[0], 50);
});

test("M02: one invocation consumes no more than its requested budget", async () => {
  const { store } = baseStore({
    accounts: Array.from({ length: 80 }, (_, i) => ({
      _id: String(i).padStart(3, "0"),
      status: "active",
    })),
  });
  const result = await run(store, { limit: 17 });
  assert.ok(result.accounts <= 17);
});

test("M03: deleting scan is bounded to ten accounts", async () => {
  const { store } = baseStore({
    deleting: Array.from({ length: 20 }, (_, i) => ({
      _id: `d${String(i).padStart(2, "0")}`,
      status: "deleting",
    })),
  });
  await run(store);
  assert.equal(store.calls.deletingLimits[0], 10);
});

test("M04: completed deletion sweep is reopened for newly deleting accounts", async () => {
  const deleting = [{ _id: "new-delete", status: "deleting" }];
  const { store } = baseStore({
    deleting,
    checkpoint: {
      cursor: null,
      deletingCursor: null,
      deletingSweepComplete: true,
      round: 4,
    },
  });
  await run(store);
  assert.deepEqual(store.calls.processed, ["delete:new-delete"]);
});

test("M05: account failure is recorded and later account remains reachable", async () => {
  const failures = [];
  const processed = [];
  const { store } = baseStore({
    accounts: [
      { _id: "001", status: "active" },
      { _id: "002", status: "active" },
    ],
    onFailure: (failure) => failures.push(failure),
  });
  store.listAllOwned = async (collection, accountId) => {
    if (collection === "medications") {
      if (accountId === "001") throw Object.assign(new Error(), { code: "E1" });
      processed.push(accountId);
    }
    return [];
  };
  await run(store, { limit: 2 });
  assert.deepEqual(failures, [{ id: "001", code: "E1" }]);
  assert.deepEqual(processed, ["002"]);
});

test("M06: failure-record persistence failure blocks cursor advancement", async () => {
  const checkpoint = {
    cursor: null,
    deletingCursor: null,
    deletingSweepComplete: true,
    round: 1,
  };
  const { store } = baseStore({
    accounts: [{ _id: "001", status: "active" }],
    checkpoint,
  });
  store.listAllOwned = async (collection) => {
    if (collection === "medications") throw new Error("work failed");
    return [];
  };
  store.recordMaintenanceFailure = async () => {
    throw new Error("queue unavailable");
  };
  const result = await run(store);
  assert.equal(result.checkpointSaveFailed, undefined);
  assert.equal(checkpoint.cursor, null);
});

test("M07: persisted retry job is processed before normal work", async () => {
  const processed = [];
  const { store } = baseStore({
    accounts: [{ _id: "002", status: "active" }],
    checkpoint: {
      cursor: null,
      deletingCursor: null,
      deletingSweepComplete: true,
      round: 1,
    },
  });
  store.listMaintenanceRetryJobs = async () => [
    { _id: "job-1", accountId: "001" },
  ];
  store.getAccountForMaintenance = async (id) => ({
    _id: id,
    status: "active",
  });
  store.markMaintenanceRetryJob = async (id, status) =>
    processed.push(`${id}:${status}`);
  store.listAllOwned = async (collection, accountId) => {
    if (collection === "medications") processed.push(`account:${accountId}`);
    return [];
  };
  await run(store, { limit: 2 });
  assert.equal(processed.includes("job-1:completed"), true);
  assert.equal(processed.includes("account:001"), true);
});

test("M08: retry job for a deleted account is closed without dereferencing user data", async () => {
  const closed = [];
  const { store } = baseStore({
    checkpoint: {
      cursor: null,
      deletingCursor: null,
      deletingSweepComplete: true,
      round: 1,
    },
  });
  store.listMaintenanceRetryJobs = async () => [
    { _id: "job-gone", accountId: "gone" },
  ];
  store.getAccountForMaintenance = async () => null;
  store.markMaintenanceRetryJob = async (id, status) =>
    closed.push(`${id}:${status}`);
  await run(store, { limit: 1 });
  assert.deepEqual(closed, ["job-gone:completed"]);
});

test("M09: deletion returning false becomes a recorded failure", async () => {
  const failures = [];
  const { store } = baseStore({
    deleting: [{ _id: "d1", status: "deleting" }],
    onFailure: (failure) => failures.push(failure),
  });
  store.processAccountDeletion = async () => false;
  await run(store);
  assert.deepEqual(failures, [{ id: "d1", code: "DELETION_NOT_COMPLETE" }]);
});

test("M10: checkpoint CAS failure is surfaced instead of reported as success", async () => {
  const { store } = baseStore({ accounts: [] });
  store.saveMaintenanceCheckpoint = async () => false;
  const result = await run(store);
  assert.equal(result.checkpointSaveFailed, true);
});

test("M11: paged normal cursor advances through the last successful page", async () => {
  const { store, state } = baseStore({
    accounts: ["001", "002", "003"].map((_id) => ({ _id, status: "active" })),
  });
  await run(store, { limit: 2 });
  assert.equal(state.cursor, "002");
});

test("M12: a claimed maintenance lease rejects a concurrent runner", async () => {
  const checkpoint = {
    cursor: null,
    deletingCursor: null,
    deletingSweepComplete: true,
    round: 1,
  };
  const { store } = baseStore({ checkpoint });
  store.claimMaintenanceLease = async () => false;
  const result = await run(store);
  assert.equal(result.locked, true);
});
