"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseAction } = require("../lib/schemas");

test("拒绝身份和所有权相关的客户端字段", () => {
  assert.throws(
    () =>
      parseAction("medication.create", {
        profileId: "profile_1",
        name: "药",
        openid: "spoofed",
      }),
    (error) => error.code === "INVALID_ARGUMENT",
  );
});

test("完整解析指定星期计划并排序去重", () => {
  const result = parseAction("plan.save", {
    medicationId: "med_123",
    expectedMedicationVersion: 2,
    kind: "weekdays",
    dose: 0.5,
    unit: "片",
    times: ["20:00", "08:00"],
    weekdays: [5, 1, 3],
    startDate: "2026-08-19",
  });
  assert.deepEqual(result.times, ["08:00", "20:00"]);
  assert.deepEqual(result.weekdays, [1, 3, 5]);
});

test("拒绝不存在的日期、重复时间和倒置日期区间", () => {
  assert.throws(() =>
    parseAction("medication.create", {
      profileId: "profile_1",
      name: "药",
      expiry: { precision: "day", value: "2026-02-31" },
    }),
  );
  assert.throws(() =>
    parseAction("plan.save", {
      medicationId: "med_123",
      expectedMedicationVersion: 1,
      kind: "daily",
      dose: 1,
      unit: "片",
      times: ["08:00", "08:00"],
      weekdays: [],
      startDate: "2026-08-20",
      endDate: "2026-08-19",
    }),
  );
});

test("按需记录不接受计划字段，额外服用必须有数量和单位", () => {
  assert.throws(() =>
    parseAction("intake.record", {
      medicationId: "med_123",
      status: "extra",
      quantity: 1,
    }),
  );
  const result = parseAction("intake.record", {
    medicationId: "med_123",
    status: "extra",
    quantity: 1,
    unit: "片",
  });
  assert.equal(result.planId, null);
  assert.equal(result.quantity, 1);
});
