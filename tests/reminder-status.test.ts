import { expect, it } from "vitest";
import { appState } from "./fixtures";
import { buildCalendarEvents } from "../miniprogram/services/calendar";
import { reminderStatus } from "../miniprogram/services/reminder-status";
const now = Date.parse("2026-09-05T00:00:00Z");
it("未添加日历时不把保存计划称为提醒已开启", () => {
  const state = appState();
  const status = reminderStatus(state, state.medications[0]!, now);
  expect(status.text).toBe("计划已保存，尚未添加日历");
  expect(status.action).toBe("添加手机日历");
});
it("覆盖日期按实际添加日记录计算，不随今天向后滚动，旧提醒提示不被新状态掩盖", () => {
  const state = appState();
  const med = state.medications[0]!;
  const plan = state.plans[0]!;
  const exportedAt = "2026-08-01T00:00:00Z";
  const event = buildCalendarEvents({
    medication: med,
    plan,
    showDetails: false,
    nowMs: Date.parse(exportedAt),
  })[0]!;
  state.calendarExports = [
    {
      id: "export-1",
      medicationId: med.id,
      planId: plan.id,
      fingerprint: event.key,
      eventTitle: "提醒",
      exportedAt,
      staleAt: null,
      version: 1,
    },
    {
      id: "old",
      medicationId: med.id,
      planId: "old-plan",
      fingerprint: "old",
      eventTitle: "旧提醒",
      exportedAt,
      staleAt: exportedAt,
      version: 1,
    },
  ];
  const status = reminderStatus(state, med, now);
  expect(status.text).toContain("已请求添加");
  expect(status.coverage).toContain("10月29日");
  expect(status.oldCalendarText).toContain("删除旧提醒");
  expect(
    reminderStatus(state, med, Date.parse("2026-11-01T00:00:00Z")).text,
  ).toContain("覆盖期限已结束");
});
it("部分日历和按需模式明确区分", () => {
  const state = appState();
  const med = state.medications[0]!;
  const plan = state.plans[0]!;
  plan.times = ["08:00", "20:00"];
  const event = buildCalendarEvents({
    medication: med,
    plan,
    showDetails: false,
    nowMs: now,
  })[0]!;
  state.calendarExports = [
    {
      id: "one",
      medicationId: med.id,
      planId: plan.id,
      fingerprint: event.key,
      eventTitle: "提醒",
      exportedAt: new Date(now).toISOString(),
      staleAt: null,
      version: 1,
    },
  ];
  expect(reminderStatus(state, med, now).text).toContain("部分时间");
  plan.scheduleType = "as_needed";
  expect(reminderStatus(state, med, now).hasFixedPlan).toBe(false);
});
