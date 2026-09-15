"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadConfig } = require("../lib/config");
const { ReminderStore } = require("../lib/store");
const { ReminderWorker, buildTemplateData } = require("../lib/worker");

function database({ logs = [] } = {}) {
  const command = {
    in: (values) => ({ op: "in", values }),
    exists: (value) => ({ op: "exists", value }),
  };
  const rows = {
    yxb_medications: [
      {
        _id: "med-1",
        accountId: "acct-1",
        status: "active",
        activePlanId: "plan-1",
      },
    ],
    yxb_intake_logs: logs,
  };
  const matches = (row, query) =>
    Object.entries(query).every(([key, value]) => {
      if (value?.op === "in") return value.values.includes(row[key]);
      if (value?.op === "exists")
        return value.value ? key in row : !(key in row);
      return value === null && !(key in row) ? true : row[key] === value;
    });
  return {
    command,
    collection(name) {
      return {
        where(query) {
          const filtered = (rows[name] ?? []).filter((row) =>
            matches(row, query),
          );
          return {
            limit: () => ({
              get: async () => ({ data: filtered.slice(0, 1) }),
            }),
          };
        },
      };
    },
  };
}

function workerFixture({
  response = { errCode: 0 },
  markSentError = null,
  attempts = 0,
} = {}) {
  const task = {
    _id: "task-1",
    accountId: "acct-1",
    medicationId: "med-1",
    kind: "expiry",
    status: "pending",
    dueAt: "2026-09-07T08:00:00.000Z",
    nextAttemptAt: "2026-09-07T08:00:00.000Z",
    version: 1,
    attempts,
    payload: { date: "2026-09-30", message: "请核对有效期" },
  };
  const events = [];
  const store = {
    async recoverExpiredLeases() {
      return 0;
    },
    async migrateSubscriptionGrantVersions() {
      return 0;
    },
    async listDue() {
      return task.status === "pending" ? [task] : [];
    },
    async claim() {
      task.status = "sending";
      return { ...task };
    },
    async getSettings() {
      return {
        notificationPrivacy: "generic",
        subscriptions: { expiry: true },
      };
    },
    async getAccount() {
      return { openid: "openid-1", status: "active" };
    },
    async revalidateTask() {
      return true;
    },
    async reserveSubscriptionGrant() {
      events.push("reserve");
      return { reserved: true, grantId: "grant-1" };
    },
    async finalizeSubscriptionGrant() {
      events.push("finalize");
    },
    async releaseSubscriptionGrant() {
      events.push("release");
    },
    async markSent() {
      if (markSentError) throw markSentError;
      task.status = "sent";
      events.push("sent");
    },
    async markRetry(_task, _now, _next, _code, exhausted) {
      events.push(exhausted ? "permanent" : "retry");
      task.status = exhausted ? "failed_permanent" : "pending";
    },
    async markPermanentFailure() {
      events.push("permanent");
      task.status = "failed_permanent";
    },
    async markDeliveryUnknown() {
      events.push("unknown");
      task.status = "delivery_unknown";
    },
  };
  const sender = {
    async send(message) {
      events.push({ send: message });
      return response;
    },
  };
  const config = {
    enabled: true,
    environmentId: "env-prod",
    page: "pages/today/index",
    miniprogramState: "formal",
    templates: {
      expiry: {
        enabled: true,
        templateId: "expiry-template",
        deliveryType: "oneTime",
        privacy: "generic",
        map: { date: "date1", message: "thing2" },
      },
    },
  };
  return {
    task,
    events,
    worker: new ReminderWorker({
      store,
      sender,
      config,
      clock: () => new Date("2026-09-07T08:01:00.000Z"),
      logger: { warn() {} },
    }),
  };
}

test("I01: revoked earlier taken log plus active later log blocks delivery", async () => {
  const store = new ReminderStore(
    database({
      logs: [
        {
          status: "taken",
          accountId: "acct-1",
          medicationId: "med-1",
          planId: "plan-1",
          scheduledAt: "slot",
          voidedAt: "2026-09-07T08:01:00Z",
        },
        {
          status: "taken",
          accountId: "acct-1",
          medicationId: "med-1",
          planId: "plan-1",
          scheduledAt: "slot",
          voidedAt: null,
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
      scheduledAt: "slot",
    }),
    false,
  );
});

test("I02: a missing voidedAt field is treated as an active log", async () => {
  const store = new ReminderStore(
    database({
      logs: [
        {
          status: "taken",
          accountId: "acct-1",
          medicationId: "med-1",
          planId: "plan-1",
          scheduledAt: "slot",
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
      scheduledAt: "slot",
    }),
    false,
  );
});

test("I03: expiry and shortage stay disabled until type and map are explicitly configured", () => {
  const config = loadConfig({
    REMINDER_ENV_ID: "env-prod",
    REMINDER_SEND_ENABLED: "true",
    EXPIRY_TEMPLATE_ID: "x",
    EXPIRY_TEMPLATE_DATA_MAP: '{"date":"date1","message":"thing2"}',
  });
  assert.equal(config.templates.expiry.enabled, false);
  assert.equal(config.templates.shortage.enabled, false);
});

test("I04: generic privacy changes actual sent fields, not just settings", () => {
  const data = buildTemplateData(
    { medicineName: "阿司匹林", dose: "2片", message: "请查看" },
    { medicineName: "thing1", dose: "thing2", message: "thing3" },
    "oneTime",
    "generic",
  );
  assert.deepEqual(data, { thing3: { value: "请查看" } });
});

test("I05: missing required template values fail closed", () => {
  assert.throws(
    () => buildTemplateData({ message: "" }, { message: "thing1" }, "oneTime"),
    /TEMPLATE_FIELD_INVALID/,
  );
});

test("I06: non-zero provider response is failed and releases reservation", async () => {
  const fixture = workerFixture({ response: { errCode: 40001 } });
  const result = await fixture.worker.run();
  assert.equal(result.sent, 0);
  assert.equal(fixture.events.includes("retry"), true);
  assert.equal(fixture.events.includes("release"), true);
});

test("I07: unknown provider response is not converted into a resendable success", async () => {
  const fixture = workerFixture({ response: {} });
  const result = await fixture.worker.run();
  assert.equal(result.unknown, 1);
  assert.equal(fixture.events.includes("sent"), false);
  assert.equal(fixture.events.includes("release"), false);
});

test("I08: successful provider response followed by markSent failure becomes unknown", async () => {
  const fixture = workerFixture({
    markSentError: new Error("DB_WRITE_FAILED"),
  });
  const result = await fixture.worker.run();
  assert.equal(result.unknown, 1);
  assert.equal(fixture.events.includes("finalize"), false);
  assert.equal(fixture.events.includes("release"), false);
});

test("I09: retry exhaustion is bounded at five attempts", async () => {
  const fixture = workerFixture({ response: { errCode: 40001 }, attempts: 4 });
  await fixture.worker.run();
  assert.equal(fixture.events.includes("permanent"), true);
  assert.equal(fixture.events.includes("release"), true);
});

test("I10: an accepted successful response is finalized once", async () => {
  const fixture = workerFixture();
  const result = await fixture.worker.run();
  assert.equal(result.sent, 1);
  assert.deepEqual(
    fixture.events.filter((item) => typeof item === "string"),
    ["reserve", "sent", "finalize"],
  );
});
