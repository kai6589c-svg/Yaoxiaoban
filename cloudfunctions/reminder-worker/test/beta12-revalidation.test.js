"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ReminderStore } = require("../lib/store");

function createDb({ medications, intakeLogs }) {
  const command = {
    in(values) {
      return { operator: "in", values };
    },
    exists(value) {
      return { operator: "exists", value };
    },
  };
  const match = (row, query) =>
    Object.entries(query).every(([key, expected]) => {
      const actual = row[key];
      if (expected && expected.operator === "in")
        return expected.values.includes(actual);
      if (expected && expected.operator === "exists")
        return expected.value ? key in row : !(key in row);
      return actual === expected;
    });
  const dataFor = (name) =>
    name.endsWith("medications") ? medications : intakeLogs;
  return {
    command,
    collection(name) {
      return {
        where(query) {
          let rows = dataFor(name).filter((row) => match(row, query));
          return {
            limit() {
              return {
                async get() {
                  return { data: rows.slice(0, 1).map((row) => ({ ...row })) };
                },
              };
            },
          };
        },
      };
    },
  };
}

test("G3 red: a voided earlier log must not hide a later active taken log", async () => {
  const store = new ReminderStore(
    createDb({
      medications: [
        {
          _id: "med-1",
          accountId: "acct-1",
          status: "active",
          activePlanId: "plan-1",
        },
      ],
      intakeLogs: [
        {
          _id: "log-voided",
          accountId: "acct-1",
          medicationId: "med-1",
          planId: "plan-1",
          scheduledAt: "2026-09-08T08:00:00.000Z",
          status: "taken",
          voidedAt: "2026-09-08T08:05:00.000Z",
        },
        {
          _id: "log-active",
          accountId: "acct-1",
          medicationId: "med-1",
          planId: "plan-1",
          scheduledAt: "2026-09-08T08:00:00.000Z",
          status: "taken",
          voidedAt: null,
        },
      ],
    }),
    { collectionPrefix: "test_" },
  );

  const shouldSend = await store.revalidateTask({
    accountId: "acct-1",
    medicationId: "med-1",
    planId: "plan-1",
    kind: "dose",
    scheduledAt: "2026-09-08T08:00:00.000Z",
  });

  assert.equal(shouldSend, false);
});
