import { describe, expect, it } from "vitest";
import { buildRisks, buildTodayTasks } from "../miniprogram/core/dashboard";
import { localDateTimeToMs } from "../miniprogram/core/dates";
import { appState, log, medication } from "./fixtures";

describe("dashboard projections", () => {
  it("builds upcoming/due/taken/skipped tasks for active members", () => {
    const state = appState();
    const now = localDateTimeToMs("2026-08-19", "07:00");
    expect(buildTodayTasks(state, now)[0]?.status).toBe("upcoming");
    expect(
      buildTodayTasks(state, localDateTimeToMs("2026-08-19", "09:00"))[0]
        ?.status,
    ).toBe("due");

    state.intakeLogs = [
      log({
        occurrenceKey: "plan-1|2026-08-19|08:00",
        status: "taken",
        occurredAt: new Date(
          localDateTimeToMs("2026-08-19", "08:10"),
        ).toISOString(),
      }),
    ];
    expect(
      buildTodayTasks(state, localDateTimeToMs("2026-08-19", "09:00"))[0]
        ?.status,
    ).toBe("taken");
    state.intakeLogs[0]!.status = "skipped";
    expect(
      buildTodayTasks(state, localDateTimeToMs("2026-08-19", "09:00"))[0]
        ?.status,
    ).toBe("skipped");
  });

  it("marks an unrecorded task past its effective management expiry for review", () => {
    const state = appState();
    state.medications = [
      medication({
        expiryValue: "2027-12-31",
        openedDate: "2026-08-01",
        afterOpenDays: 10,
      }),
    ];

    const tasks = buildTodayTasks(
      state,
      localDateTimeToMs("2026-08-19", "09:00"),
    );

    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.status).toBe("needs-review");
  });

  it("keeps a recorded result visible even after the medicine expires", () => {
    const state = appState();
    state.medications = [medication({ expiryValue: "2026-08-18" })];
    state.intakeLogs = [
      log({
        occurrenceKey: "plan-1|2026-08-19|08:00",
        status: "taken",
      }),
    ];

    const tasks = buildTodayTasks(
      state,
      localDateTimeToMs("2026-08-19", "09:00"),
    );

    expect(tasks[0]?.status).toBe("taken");
  });

  it("prioritizes expired before expiring and low-stock risks", () => {
    const state = appState();
    state.medications = [
      medication({ expiryValue: "2026-08-18" }),
      medication({ id: "med-2", expiryValue: "2026-08-25" }),
    ];
    const risks = buildRisks(state, localDateTimeToMs("2026-08-19", "09:00"));
    expect(risks[0]?.type).toBe("expired");
    expect(risks.some((item) => item.type === "expiring")).toBe(true);
  });

  it("explains an after-open management deadline instead of the later package date", () => {
    const state = appState();
    state.medications = [
      medication({
        name: "开封药",
        expiryValue: "2027-12-31",
        openedDate: "2026-08-01",
        afterOpenDays: 10,
      }),
    ];

    const risks = buildRisks(state, localDateTimeToMs("2026-08-19", "09:00"));
    const expired = risks.find((item) => item.type === "expired");

    expect(expired).toMatchObject({
      title: "开封药 已超过管理期限",
    });
    expect(expired?.detail).toContain("开封后期限");
    expect(expired?.detail).toContain("2026年8月10日");
    expect(expired?.detail).not.toContain("2027年");
  });

  it("does not raise stock warnings after the management deadline", () => {
    const state = appState();
    state.medications = [medication({ expiryValue: "2026-08-18" })];
    state.snapshots[0]!.quantityMilli = 0;

    const risks = buildRisks(state, localDateTimeToMs("2026-08-19", "09:00"));

    expect(risks.some((item) => item.type === "expired")).toBe(true);
    expect(risks.some((item) => item.type === "low-stock")).toBe(false);
    expect(risks.some((item) => item.type === "unknown-stock")).toBe(false);
  });

  it("shows unknown stock and stale calendar without inventing inventory", () => {
    const state = appState();
    state.snapshots = [];
    state.calendarExports = [
      {
        id: "cal-1",
        medicationId: "med-1",
        planId: "plan-old",
        fingerprint: "old",
        eventTitle: "药小伴服药提醒",
        exportedAt: "2026-08-01T00:00:00.000Z",
        staleAt: "2026-08-02T00:00:00.000Z",
        version: 2,
      },
    ];
    const types = buildRisks(
      state,
      localDateTimeToMs("2026-08-19", "09:00"),
    ).map((item) => item.type);
    expect(types).toContain("unknown-stock");
    expect(types).toContain("calendar-stale");
  });

  it("clears the stale-calendar warning after the current plan is written", () => {
    const state = appState();
    state.calendarExports = [
      {
        id: "cal-old",
        medicationId: "med-1",
        planId: "plan-old",
        fingerprint: "old",
        eventTitle: "旧提醒",
        exportedAt: "2026-08-01T00:00:00.000Z",
        staleAt: "2026-08-02T00:00:00.000Z",
        version: 2,
      },
      {
        id: "cal-current",
        medicationId: "med-1",
        planId: "plan-1",
        fingerprint: "current",
        eventTitle: "药小伴服药提醒",
        exportedAt: "2026-08-19T00:00:00.000Z",
        staleAt: null,
        version: 1,
      },
    ];

    const risks = buildRisks(state, localDateTimeToMs("2026-08-19", "09:00"));

    expect(risks.some((item) => item.type === "calendar-stale")).toBe(false);
  });

  it("creates a stock risk for a confirmed zero balance even without a plan", () => {
    const state = appState();
    state.plans = [];
    state.snapshots = [
      {
        ...state.snapshots[0]!,
        quantityMilli: 0,
      },
    ];

    const risks = buildRisks(state, localDateTimeToMs("2026-08-19", "09:00"));
    const stockRisk = risks.find((item) => item.type === "low-stock");

    expect(stockRisk).toMatchObject({
      medicationId: "med-1",
      level: "warning",
      title: "测试药 预计余量为 0",
    });
  });
});

it("Today aggregate retains the existing task/risk results and exposes only a compact summary", async () => {
  const { buildTodayDashboard } = await import("../miniprogram/core/dashboard");
  const state = appState();
  const now = localDateTimeToMs("2026-08-19", "09:00");
  const board = buildTodayDashboard(state, now);
  expect(board.tasks).toEqual(buildTodayTasks(state, now));
  expect(board.risks).toEqual(buildRisks(state, now));
  expect(board.summary.medicationCount).toBe(1);
  expect(board.nextReminder).toBeTruthy();
  state.medications = [];
  expect(buildTodayDashboard(state, now).nextReminder).toBeNull();
});
