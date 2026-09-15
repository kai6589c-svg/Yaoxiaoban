"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ReminderStore } = require("../lib/store");

function makeDb({ grants = [], logs = [], medications = [] } = {}) {
  const command = {
    gt: (value) => ({ op: "gt", value }),
    lte: (value) => ({ op: "lte", value }),
    in: (value) => ({ op: "in", value }),
    exists: (value) => ({ op: "exists", value }),
    inc: (value) => ({ op: "inc", value }),
  };
  const matches = (row, query) =>
    Object.entries(query).every(([key, value]) => {
      if (value?.op === "gt") return row[key] > value.value;
      if (value?.op === "lte") return row[key] <= value.value;
      if (value?.op === "in") return value.value.includes(row[key]);
      if (value?.op === "exists")
        return value.value ? key in row : !(key in row);
      if (value === null && !(key in row)) return true;
      return row[key] === value;
    });
  const rowsFor = (name) => {
    if (name.endsWith("subscription_grants")) return grants;
    if (name.endsWith("intake_logs")) return logs;
    if (name.endsWith("medications")) return medications;
    return [];
  };
  return {
    command,
    collection(name) {
      const rows = rowsFor(name);
      return {
        where(query) {
          let limit = Infinity;
          const api = {
            orderBy() {
              return api;
            },
            limit(nextLimit) {
              limit = nextLimit;
              return api;
            },
            async get() {
              return {
                data: rows.filter((row) => matches(row, query)).slice(0, limit),
              };
            },
            async update({ data }) {
              const matched = rows.filter((row) => matches(row, query));
              if (matched.length === 0) return { stats: { updated: 0 } };
              for (const row of matched) {
                for (const [key, value] of Object.entries(data)) {
                  row[key] =
                    value?.op === "inc" ? (row[key] ?? 0) + value.value : value;
                }
              }
              return { stats: { updated: matched.length } };
            },
          };
          return api;
        },
        doc(id) {
          return this.where({ _id: id });
        },
      };
    },
  };
}

test("同一 task 连续预留十次只扣一次并始终返回同一 reservation", async () => {
  const grants = [
    {
      _id: "grant-1",
      accountId: "account-1",
      templateId: "template-1",
      authorizedMedicationId: "med-1",
      status: "accept",
      version: 1,
      usableCount: 1,
      reservedTaskId: null,
      reservedMedicationId: null,
      reservedKind: null,
    },
  ];
  const store = new ReminderStore(makeDb({ grants }));
  const results = [];
  for (let index = 0; index < 10; index += 1) {
    results.push(
      await store.reserveSubscriptionGrant("account-1", "template-1", "now", {
        taskId: "task-1",
        medicationId: "med-1",
        kind: "dose",
      }),
    );
  }
  assert.equal(
    results.every((result) => result.reserved === true),
    true,
  );
  assert.equal(new Set(results.map((result) => result.grantId)).size, 1);
  assert.equal(grants[0].usableCount, 0);
  assert.equal(grants[0].reservedTaskId, "task-1");
});

test("第 101 和第 201 条已服记录都会阻止发送，不能只取前一页", async () => {
  const logs = Array.from({ length: 201 }, (_, index) => ({
    accountId: "account-1",
    medicationId: "med-1",
    planId: "plan-1",
    scheduledAt: `slot-${index + 1}`,
    status: "taken",
  }));
  const store = new ReminderStore(
    makeDb({
      medications: [
        {
          _id: "med-1",
          accountId: "account-1",
          status: "active",
          activePlanId: "plan-1",
        },
      ],
      logs,
    }),
  );
  for (const scheduledAt of ["slot-101", "slot-201"]) {
    assert.equal(
      await store.revalidateTask({
        accountId: "account-1",
        medicationId: "med-1",
        planId: "plan-1",
        kind: "dose",
        scheduledAt,
      }),
      false,
    );
  }
});

function grantFixture() {
  return [
    {
      _id: "grant-1",
      accountId: "account-1",
      templateId: "template-1",
      authorizedMedicationId: "med-1",
      status: "accept",
      version: 1,
      usableCount: 1,
      reservedTaskId: null,
      reservedMedicationId: null,
      reservedKind: null,
    },
  ];
}

test("额度 1 的两个不同 task 并发争抢恰好一胜一败", async () => {
  const grants = grantFixture();
  const store = new ReminderStore(makeDb({ grants }));
  const results = await Promise.all([
    store.reserveSubscriptionGrant("account-1", "template-1", "now", {
      taskId: "task-a",
      medicationId: "med-1",
      kind: "dose",
    }),
    store.reserveSubscriptionGrant("account-1", "template-1", "now", {
      taskId: "task-b",
      medicationId: "med-1",
      kind: "dose",
    }),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(grants[0].usableCount, 0);
  assert.equal(["task-a", "task-b"].includes(grants[0].reservedTaskId), true);
});

test("同一 task 并发预留会回查同一个 reservation", async () => {
  const grants = grantFixture();
  const store = new ReminderStore(makeDb({ grants }));
  const results = await Promise.all([
    store.reserveSubscriptionGrant("account-1", "template-1", "now", {
      taskId: "task-a",
      medicationId: "med-1",
      kind: "dose",
    }),
    store.reserveSubscriptionGrant("account-1", "template-1", "now", {
      taskId: "task-a",
      medicationId: "med-1",
      kind: "dose",
    }),
  ]);
  assert.equal(results.every(Boolean), true);
  assert.deepEqual(new Set(results.map((item) => item.grantId)).size, 1);
  assert.equal(grants[0].usableCount, 0);
});

test("授权只绑定指定药盒，错误 task 不能释放且重复释放不增发", async () => {
  const grants = grantFixture();
  const store = new ReminderStore(makeDb({ grants }));
  const reservation = await store.reserveSubscriptionGrant(
    "account-1",
    "template-1",
    "now",
    {
      taskId: "task-a",
      medicationId: "med-1",
      kind: "dose",
    },
  );
  assert.equal(reservation.reserved, true);
  const wrong = await store.releaseSubscriptionGrant(
    "account-1",
    reservation.grantId,
    "now",
    { taskId: "task-b" },
  );
  assert.equal(wrong, false);
  const releases = await Promise.all(
    Array.from({ length: 10 }, () =>
      store.releaseSubscriptionGrant("account-1", reservation.grantId, "now", {
        taskId: "task-a",
      }),
    ),
  );
  assert.equal(releases.filter(Boolean).length, 1);
  assert.equal(grants[0].usableCount, 1);
  assert.equal(grants[0].reservedTaskId, null);
});

test("事务条件更新注入失败时不留下只扣额度状态", async () => {
  const grants = grantFixture();
  const db = makeDb({ grants });
  const original = db.collection;
  db.collection = (name) => {
    const collection = original(name);
    if (!name.endsWith("subscription_grants")) return collection;
    const originalWhere = collection.where;
    collection.where = (query) => {
      const api = originalWhere(query);
      const originalUpdate = api.update;
      api.update = async () => {
        throw new Error("INJECTED_ATOMIC_FAILURE");
      };
      return api;
    };
    return collection;
  };
  const store = new ReminderStore(db);
  await assert.rejects(
    store.reserveSubscriptionGrant("account-1", "template-1", "now", {
      taskId: "task-a",
      medicationId: "med-1",
      kind: "dose",
    }),
    /INJECTED_ATOMIC_FAILURE/,
  );
  assert.equal(grants[0].usableCount, 1);
  assert.equal(grants[0].reservedTaskId, null);
});
