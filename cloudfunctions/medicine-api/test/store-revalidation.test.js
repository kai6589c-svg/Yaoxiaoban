"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { CloudStore } = require("../lib/store");

function makeDb({ logs, medications }) {
  const command = {
    in: (value) => ({ op: "in", value }),
    exists: (value) => ({ op: "exists", value }),
  };
  const matches = (row, query) =>
    Object.entries(query).every(([key, value]) => {
      if (value?.op === "in") return value.value.includes(row[key]);
      if (value?.op === "exists")
        return value.value ? key in row : !(key in row);
      return row[key] === value;
    });
  return {
    command,
    collection(name) {
      const rows = name.endsWith("intake_logs") ? logs : medications;
      return {
        where(query) {
          let limit = Infinity;
          const api = {
            limit(value) {
              limit = value;
              return api;
            },
            async get() {
              return {
                data: rows.filter((row) => matches(row, query)).slice(0, limit),
              };
            },
          };
          return api;
        },
      };
    },
  };
}

test("生产 CloudStore 对服药记录按完整键精确回查，不受历史分页影响", async () => {
  const logs = Array.from({ length: 201 }, (_, index) => ({
    _id: `log-${index + 1}`,
    accountId: "acct-1",
    medicationId: "med-1",
    planId: "plan-1",
    scheduledAt: `slot-${index + 1}`,
    status: "taken",
  }));
  const store = new CloudStore(
    makeDb({
      logs,
      medications: [
        {
          _id: "med-1",
          accountId: "acct-1",
          status: "active",
          activePlanId: "plan-1",
        },
      ],
    }),
  );
  assert.equal(
    await store.revalidateTask({
      accountId: "acct-1",
      medicationId: "med-1",
      planId: "plan-1",
      kind: "dose",
      scheduledAt: "slot-101",
    }),
    false,
  );
  assert.equal(
    await store.revalidateTask({
      accountId: "acct-1",
      medicationId: "med-1",
      planId: "plan-1",
      kind: "dose",
      scheduledAt: "slot-new",
    }),
    true,
  );
});
