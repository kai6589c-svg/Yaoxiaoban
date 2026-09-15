"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { MedicineService } = require("../lib/service");
const { MemoryStore } = require("./support/memory-store");

test("从建药、计划、盘点到已服/未服的核心旅程保持库存语义", async () => {
  let instant = new Date("2026-08-19T00:00:00.000Z"); // 中国时间 08:00
  const store = new MemoryStore();
  const service = new MedicineService(store, {
    clock: () => instant,
    logger: { warn() {} },
  });
  const accountId = "acct_test";

  const boot = await service.execute(
    "bootstrap",
    {},
    { accountId, requestId: null },
  );
  assert.equal(boot.profiles.length, 1);
  const profileId = boot.profiles[0]._id;

  const medication = await service.execute(
    "medication.create",
    {
      profileId,
      name: "测试药",
      specification: null,
      unit: "片",
      expiry: { precision: "month", value: "2027-06" },
      openedOn: null,
      afterOpenDays: null,
      notes: null,
    },
    { accountId, requestId: "create-med-0001" },
  );

  const saved = await service.execute(
    "plan.save",
    {
      medicationId: medication._id,
      expectedMedicationVersion: medication.version,
      kind: "daily",
      dose: 1,
      unit: "片",
      times: ["09:00"],
      weekdays: [],
      startDate: "2026-08-19",
      endDate: null,
      notes: null,
    },
    { accountId, requestId: "save-plan-0001" },
  );
  assert.equal(saved.medication.version, 2);

  await service.execute(
    "snapshot.create",
    {
      medicationId: medication._id,
      quantity: 10,
      unit: "片",
      capturedAt: "2026-08-19T00:00:00.000Z",
    },
    { accountId, requestId: "snapshot-000001" },
  );

  instant = new Date("2026-08-19T02:00:00.000Z"); // 任务已到达
  const today = await service.execute(
    "today.get",
    {},
    { accountId, requestId: null },
  );
  assert.equal(today.tasks.length, 1);
  assert.equal(today.tasks[0].status, "pending");

  const taken = await service.execute(
    "intake.record",
    {
      medicationId: medication._id,
      planId: saved.plan._id,
      status: "taken",
      scheduledAt: today.tasks[0].scheduledAt,
      occurredAt: null,
      quantity: null,
      unit: null,
    },
    { accountId, requestId: "take-dose-000001" },
  );
  let cabinet = await service.execute(
    "cabinet.get",
    {},
    { accountId, requestId: null },
  );
  assert.equal(
    cabinet.items[0].inventory.quantity,
    9,
    "已服日志不应在计划消耗之外再次扣减",
  );

  const skipped = await service.execute(
    "intake.record",
    {
      medicationId: medication._id,
      planId: saved.plan._id,
      status: "skipped",
      scheduledAt: today.tasks[0].scheduledAt,
      occurredAt: null,
      quantity: null,
      unit: null,
    },
    { accountId, requestId: "skip-dose-000001" },
  );
  assert.equal(skipped._id, taken._id, "同一计划时刻只能有一条当前状态记录");
  cabinet = await service.execute(
    "cabinet.get",
    {},
    { accountId, requestId: null },
  );
  assert.equal(
    cabinet.items[0].inventory.quantity,
    10,
    "未服应抵消默认计划消耗",
  );
});

test("今天页不会在管理期限之后生成新的固定任务", async () => {
  let instant = new Date("2026-08-19T00:00:00.000Z"); // 中国时间 08:00
  const store = new MemoryStore();
  const service = new MedicineService(store, {
    clock: () => instant,
    logger: { warn() {} },
  });
  const accountId = "acct_expired_today";
  const boot = await service.execute(
    "bootstrap",
    {},
    { accountId, requestId: null },
  );
  const medication = await service.execute(
    "medication.create",
    {
      profileId: boot.profiles[0]._id,
      name: "已到期任务测试药",
      specification: null,
      unit: "片",
      expiry: { precision: "day", value: "2026-08-20" },
      openedOn: null,
      afterOpenDays: null,
      notes: null,
    },
    { accountId, requestId: "create-expired-today" },
  );
  await service.execute(
    "plan.save",
    {
      medicationId: medication._id,
      expectedMedicationVersion: medication.version,
      kind: "daily",
      dose: 1,
      unit: "片",
      times: ["09:00"],
      weekdays: [],
      startDate: "2026-08-19",
      endDate: null,
      notes: null,
    },
    { accountId, requestId: "save-expired-today-plan" },
  );

  // Aug 21 in Asia/Shanghai is the first day after the package expiry.
  instant = new Date("2026-08-20T16:00:00.000Z");
  const today = await service.execute(
    "today.get",
    {},
    { accountId, requestId: null },
  );
  assert.equal(today.date, "2026-08-21");
  assert.equal(today.tasks.length, 0);
});

test("所有权检查阻止其他账号读取对象", async () => {
  const store = new MemoryStore();
  const service = new MedicineService(store, {
    clock: () => new Date("2026-08-19T00:00:00Z"),
  });
  const boot = await service.execute(
    "bootstrap",
    {},
    { accountId: "acct_a", requestId: null },
  );
  const medication = await service.execute(
    "medication.create",
    {
      profileId: boot.profiles[0]._id,
      name: "私密药品",
      specification: null,
      unit: null,
      expiry: null,
      openedOn: null,
      afterOpenDays: null,
      notes: null,
    },
    { accountId: "acct_a", requestId: "create-private01" },
  );
  await assert.rejects(
    () =>
      service.execute(
        "medication.get",
        { id: medication._id },
        { accountId: "acct_b", requestId: null },
      ),
    (error) => error.code === "NOT_FOUND",
  );
});

test("服务端拒绝晚于今天或包装期限的开封日期", async () => {
  const store = new MemoryStore();
  const service = new MedicineService(store, {
    clock: () => new Date("2026-08-19T00:00:00.000Z"),
  });
  const context = { accountId: "acct_dates", requestId: "boot-dates-0001" };
  const boot = await service.execute("bootstrap", {}, context);

  await assert.rejects(
    () =>
      service.execute(
        "medication.create",
        {
          profileId: boot.profiles[0]._id,
          name: "日期测试药",
          specification: null,
          unit: "片",
          expiry: { precision: "day", value: "2026-08-18" },
          openedOn: "2026-08-19",
          afterOpenDays: 30,
          notes: null,
        },
        { ...context, requestId: "create-invalid-date" },
      ),
    (error) =>
      error.code === "INVALID_ARGUMENT" &&
      error.message.includes("不能晚于包装有效期"),
  );

  await assert.rejects(
    () =>
      service.execute(
        "medication.create",
        {
          profileId: boot.profiles[0]._id,
          name: "未来开封药",
          specification: null,
          unit: "片",
          expiry: { precision: "day", value: "2027-08-19" },
          openedOn: "2026-08-20",
          afterOpenDays: 30,
          notes: null,
        },
        { ...context, requestId: "create-future-open" },
      ),
    (error) =>
      error.code === "INVALID_ARGUMENT" && error.message.includes("晚于今天"),
  );
});

test("服务端计划不能越过药盒的实际管理期限", async () => {
  const store = new MemoryStore();
  const service = new MedicineService(store, {
    clock: () => new Date("2026-08-19T00:00:00.000Z"),
  });
  const accountId = "acct_plan_expiry";
  const boot = await service.execute(
    "bootstrap",
    {},
    { accountId, requestId: null },
  );
  const medication = await service.execute(
    "medication.create",
    {
      profileId: boot.profiles[0]._id,
      name: "短期开封药",
      specification: null,
      unit: "片",
      expiry: { precision: "day", value: "2027-12-31" },
      openedOn: "2026-08-19",
      afterOpenDays: 3,
      notes: null,
    },
    { accountId, requestId: "create-short-open" },
  );

  await assert.rejects(
    () =>
      service.execute(
        "plan.save",
        {
          medicationId: medication._id,
          expectedMedicationVersion: medication.version,
          kind: "daily",
          dose: 1,
          unit: "片",
          times: ["09:00"],
          weekdays: [],
          startDate: "2026-08-22",
          endDate: null,
          notes: null,
        },
        { accountId, requestId: "late-plan-start" },
      ),
    (error) =>
      error.code === "INVALID_ARGUMENT" &&
      error.message.includes("不能晚于管理期限"),
  );
});

test("药盒永久删除在关联删除中断后可用原版本安全重试", async () => {
  const store = new MemoryStore();
  const originalDeleteAll = store.deleteAllOwned.bind(store);
  let injected = false;
  store.deleteAllOwned = async (key, accountId, where) => {
    if (!injected && key === "snapshots") {
      injected = true;
      throw new Error("INJECTED_DELETE_FAILURE");
    }
    return originalDeleteAll(key, accountId, where);
  };
  const service = new MedicineService(store, {
    clock: () => new Date("2026-08-19T00:00:00.000Z"),
  });
  const accountId = "acct_delete_retry";
  const boot = await service.execute(
    "bootstrap",
    {},
    { accountId, requestId: null },
  );
  const medication = await service.execute(
    "medication.create",
    {
      profileId: boot.profiles[0]._id,
      name: "待删除药",
      specification: null,
      unit: null,
      expiry: { precision: "month", value: "2027-12" },
      openedOn: null,
      afterOpenDays: null,
      notes: null,
    },
    { accountId, requestId: "create-delete-retry" },
  );

  await assert.rejects(() =>
    service.execute(
      "medication.delete",
      { id: medication._id, expectedVersion: medication.version },
      { accountId, requestId: "delete-attempt-one" },
    ),
  );
  const locked = await store.getOwned("medications", medication._id, accountId);
  assert.equal(locked.status, "deleting");
  assert.equal(locked.deletionStartedFromVersion, medication.version);

  const result = await service.execute(
    "medication.delete",
    { id: medication._id, expectedVersion: medication.version },
    { accountId, requestId: "delete-attempt-two" },
  );
  assert.equal(result.deleted, true);
  assert.equal(
    await store.getOwned("medications", medication._id, accountId, {
      required: false,
    }),
    null,
  );
});
