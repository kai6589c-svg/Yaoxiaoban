import { expect, it } from "vitest";
import { buildReminderHealth } from "../miniprogram/services/reminder-health";
import type { ReminderStatus } from "../miniprogram/services/data-service";
const now = Date.parse("2026-09-10T03:00:00Z");
const state = (): ReminderStatus => ({
  preferences: { dose: true, expiry: false, shortage: false },
  grants: {
    dose: { accepted: true, usableCount: 1 },
    expiry: { accepted: false, usableCount: 0 },
    shortage: { accepted: false, usableCount: 0 },
  },
  tasks: [],
});
it("distinguishes unreadable, disabled and exhausted authorization", () => {
  expect(buildReminderHealth(null).level).toBe("warning");
  const value = state();
  value.preferences.dose = false;
  expect(buildReminderHealth(value).level).toBe("off");
  value.preferences.dose = true;
  value.grants.dose.usableCount = 0;
  expect(buildReminderHealth(value).title).toBe("提醒可能无法发送");
});
it("unknown delivery stays visible and future task only promises a planned attempt", () => {
  const value = state();
  value.tasks.push({
    id: "task",
    kind: "dose",
    status: "pending",
    dueAt: "2026-09-10T04:00:00Z",
    sentAt: null,
    failureCode: null,
  });
  const health = buildReminderHealth(value, now);
  expect(health.level).toBe("ok");
  expect(health.next).toContain("下一次计划");
  expect(health.detail).toContain("不代表");
  value.tasks[0]!.status = "delivery_unknown";
  expect(buildReminderHealth(value, now).title).toContain("待核对");
});
it("stale pending task is a warning instead of healthy", () => {
  const value = state();
  value.tasks.push({
    id: "task",
    kind: "dose",
    status: "pending",
    dueAt: "2026-09-10T02:00:00Z",
    sentAt: null,
    failureCode: null,
  });
  expect(buildReminderHealth(value, now).level).toBe("warning");
});
