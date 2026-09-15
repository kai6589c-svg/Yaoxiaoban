"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  effectiveExpiry,
  estimateInventory,
  expiryState,
  occurrencesBetween,
  occurrencesForDate,
  projectedRunOut,
} = require("../lib/domain");

function plan(overrides = {}) {
  return {
    _id: "plan_1",
    medicationId: "med_1",
    kind: "daily",
    dose: 2,
    unit: "片",
    times: ["09:00"],
    weekdays: [],
    startDate: "2026-01-01",
    endDate: null,
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    supersededAt: null,
    ...overrides,
  };
}

test("月精度有效期按当月最后一天，包含闰年", () => {
  assert.equal(
    effectiveExpiry({ expiry: { precision: "month", value: "2028-02" } }),
    "2028-02-29",
  );
  assert.equal(
    effectiveExpiry({ expiry: { precision: "month", value: "2027-02" } }),
    "2027-02-28",
  );
});

test("开封期限早于包装期限时采用开封期限", () => {
  assert.equal(
    effectiveExpiry({
      expiry: { precision: "day", value: "2027-12-31" },
      openedOn: "2026-08-01",
      afterOpenDays: 30,
    }),
    "2026-08-30",
  );
});

test("有效期风险不会把当天到期标成已过期", () => {
  const result = expiryState(
    { expiry: { precision: "day", value: "2026-08-19" } },
    new Date("2026-08-19T03:00:00Z"),
    30,
  );
  assert.equal(result.state, "expiring");
  assert.equal(result.daysRemaining, 0);
});

test("计划只生成生效后、失效前的任务", () => {
  const changed = plan({
    times: ["08:00", "20:00"],
    effectiveFrom: "2026-08-19T02:00:00.000Z", // 中国时间 10:00
    supersededAt: "2026-08-19T14:00:00.000Z", // 中国时间 22:00
  });
  assert.deepEqual(
    occurrencesForDate(changed, "2026-08-19").map((item) => item.time),
    ["20:00"],
  );
});

test("指定星期计划只在选中日期展开", () => {
  const mondayOnly = plan({ kind: "weekdays", weekdays: [1] });
  assert.equal(occurrencesForDate(mondayOnly, "2026-08-17").length, 1);
  assert.equal(occurrencesForDate(mondayOnly, "2026-08-18").length, 0);
});

test("预计库存以最近盘点为锚：已服不二扣、未服返还、额外服用扣减", () => {
  const activePlan = plan({ effectiveFrom: "2026-07-01T00:00:00.000Z" });
  const result = estimateInventory({
    snapshot: {
      quantity: 10,
      unit: "片",
      capturedAt: "2026-08-01T00:00:00.000Z",
    },
    plans: [activePlan],
    logs: [
      {
        status: "taken",
        quantity: 2,
        unit: "片",
        occurredAt: "2026-08-01T01:30:00.000Z",
        undoneAt: null,
      },
      {
        status: "skipped",
        quantity: 2,
        unit: "片",
        occurredAt: "2026-08-02T01:30:00.000Z",
        undoneAt: null,
      },
      {
        status: "extra",
        quantity: 1,
        unit: "片",
        occurredAt: "2026-08-02T03:00:00.000Z",
        undoneAt: null,
      },
    ],
    now: new Date("2026-08-03T03:00:00.000Z"),
  });
  assert.deepEqual(
    {
      quantity: result.quantity,
      consumed: result.consumed,
      deficit: result.deficit,
    },
    { quantity: 5, consumed: 5, deficit: 0 },
  );
});

test("预计库存不足时对外数量钳制为零并单列缺口", () => {
  const result = estimateInventory({
    snapshot: {
      quantity: 1,
      unit: "片",
      capturedAt: "2026-08-01T00:00:00.000Z",
    },
    plans: [plan({ effectiveFrom: "2026-07-01T00:00:00.000Z" })],
    logs: [],
    now: new Date("2026-08-02T03:00:00.000Z"),
  });
  assert.equal(result.quantity, 0);
  assert.equal(result.deficit, 3);
});

test("预计用完时间是第一次计划消耗超过现有数量的时间", () => {
  const now = new Date("2026-08-19T00:00:00.000Z");
  const result = projectedRunOut({
    quantity: 2,
    unit: "片",
    activePlan: plan({ dose: 1, effectiveFrom: "2026-01-01T00:00:00.000Z" }),
    now,
  });
  const future = occurrencesBetween(
    [plan({ dose: 1, effectiveFrom: "2026-01-01T00:00:00.000Z" })],
    now,
    new Date("2026-08-23T00:00:00.000Z"),
  );
  assert.equal(result, future[2].scheduledAt);
});
