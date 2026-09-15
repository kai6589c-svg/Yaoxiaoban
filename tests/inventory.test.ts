import { describe, expect, it } from "vitest";
import { localDateTimeToMs } from "../miniprogram/core/dates";
import { estimateInventory } from "../miniprogram/core/inventory";
import { log, plan, snapshot } from "./fixtures";

const asOf = localDateTimeToMs("2026-08-23", "09:00");

describe("inventory estimation", () => {
  it("automatically consumes scheduled doses without requiring check-ins", () => {
    const result = estimateInventory({
      medicationId: "med-1",
      plans: [plan()],
      snapshots: [snapshot()],
      logs: [],
      asOfMs: asOf,
    });
    expect(result.currentQuantityMilli).toBe(16_000);
  });

  it("excludes skipped occurrences but does not double-consume taken records", () => {
    const skipped = log();
    const taken = log({
      id: "log-taken",
      occurrenceKey: "plan-1|2026-08-22|08:00",
      status: "taken",
      occurredAt: new Date(
        localDateTimeToMs("2026-08-22", "09:00"),
      ).toISOString(),
    });
    const result = estimateInventory({
      medicationId: "med-1",
      plans: [plan()],
      snapshots: [snapshot()],
      logs: [skipped, taken],
      asOfMs: asOf,
    });
    expect(result.currentQuantityMilli).toBe(17_000);
  });

  it("restores default consumption when skipped is voided and counts extra use once", () => {
    const voidedSkip = log({ voidedAt: new Date(asOf).toISOString() });
    const extra = log({
      id: "extra",
      occurrenceKey: null,
      planId: null,
      status: "extra",
      occurredAt: new Date(
        localDateTimeToMs("2026-08-22", "12:00"),
      ).toISOString(),
    });
    const result = estimateInventory({
      medicationId: "med-1",
      plans: [plan()],
      snapshots: [snapshot()],
      logs: [voidedSkip, extra],
      asOfMs: asOf,
    });
    expect(result.currentQuantityMilli).toBe(15_000);
  });

  it("uses a new inventory snapshot as the fresh truth baseline", () => {
    const result = estimateInventory({
      medicationId: "med-1",
      plans: [plan()],
      snapshots: [
        snapshot(),
        snapshot({
          id: "new",
          quantityMilli: 12_000,
          recordedAt: new Date(asOf).toISOString(),
        }),
      ],
      logs: [],
      asOfMs: asOf,
    });
    expect(result.currentQuantityMilli).toBe(12_000);
  });

  it("finds the first shortage after exactly covered occurrences", () => {
    const result = estimateInventory({
      medicationId: "med-1",
      plans: [plan()],
      snapshots: [snapshot({ quantityMilli: 2000 })],
      logs: [],
      asOfMs: localDateTimeToMs("2026-08-19", "09:00"),
    });
    expect(result.lastCoveredAt).toContain("2026-08-21T00:00:00.000Z");
    expect(result.firstShortageAt).toContain("2026-08-22T00:00:00.000Z");
  });

  it("returns explicit non-predictable reasons", () => {
    expect(
      estimateInventory({
        medicationId: "med-1",
        plans: [plan()],
        snapshots: [],
        logs: [],
        asOfMs: asOf,
      }).reason,
    ).toBe("no-snapshot");
    expect(
      estimateInventory({
        medicationId: "med-1",
        plans: [],
        snapshots: [snapshot()],
        logs: [],
        asOfMs: asOf,
      }).reason,
    ).toBe("no-plan");
    expect(
      estimateInventory({
        medicationId: "med-1",
        plans: [plan({ scheduleType: "as_needed" })],
        snapshots: [snapshot()],
        logs: [],
        asOfMs: asOf,
      }).reason,
    ).toBe("as-needed");
  });

  it("does not let a superseded PRN plan poison the current fixed-plan forecast", () => {
    const result = estimateInventory({
      medicationId: "med-1",
      plans: [
        plan({
          id: "plan-prn-old",
          scheduleType: "as_needed",
          times: [],
          effectiveFrom: new Date(
            localDateTimeToMs("2026-08-01", "00:00"),
          ).toISOString(),
          effectiveTo: new Date(
            localDateTimeToMs("2026-08-20", "00:00"),
          ).toISOString(),
        }),
        plan({
          id: "plan-fixed-current",
          scheduleType: "daily",
          times: ["08:00"],
          effectiveFrom: new Date(
            localDateTimeToMs("2026-08-20", "00:00"),
          ).toISOString(),
          effectiveTo: null,
        }),
      ],
      snapshots: [snapshot()],
      logs: [],
      asOfMs: asOf,
    });

    expect(result.reason).not.toBe("as-needed");
    expect(result.predictable).toBe(true);
    expect(result.currentQuantityMilli).toBe(16_000);
  });

  it("counts an early confirmed intake immediately and not again at schedule time", () => {
    const baseline = snapshot({
      quantityMilli: 10_000,
      recordedAt: new Date(
        localDateTimeToMs("2026-08-19", "07:00"),
      ).toISOString(),
    });
    const earlyTaken = log({
      occurrenceKey: "plan-1|2026-08-19|08:00",
      status: "taken",
      scheduledAt: new Date(
        localDateTimeToMs("2026-08-19", "08:00"),
      ).toISOString(),
      occurredAt: new Date(
        localDateTimeToMs("2026-08-19", "07:30"),
      ).toISOString(),
    });
    const fixedPlan = plan({
      startDate: "2026-08-19",
      times: ["08:00"],
      doseMilli: 1000,
    });

    const beforeSchedule = estimateInventory({
      medicationId: "med-1",
      plans: [fixedPlan],
      snapshots: [baseline],
      logs: [earlyTaken],
      asOfMs: localDateTimeToMs("2026-08-19", "07:45"),
    });
    const afterSchedule = estimateInventory({
      medicationId: "med-1",
      plans: [fixedPlan],
      snapshots: [baseline],
      logs: [earlyTaken],
      asOfMs: localDateTimeToMs("2026-08-19", "08:30"),
    });

    expect(beforeSchedule.currentQuantityMilli).toBe(9000);
    expect(afterSchedule.currentQuantityMilli).toBe(9000);
  });

  it("never displays negative current stock", () => {
    const result = estimateInventory({
      medicationId: "med-1",
      plans: [plan()],
      snapshots: [snapshot({ quantityMilli: 1000 })],
      logs: [],
      asOfMs: asOf,
    });
    expect(result.currentQuantityMilli).toBe(0);
    expect(result.firstShortageAt).not.toBeNull();
  });

  it("stops automatic consumption and forecasting at the management expiry", () => {
    const result = estimateInventory({
      medicationId: "med-1",
      plans: [plan()],
      snapshots: [snapshot()],
      logs: [],
      asOfMs: asOf,
      stopAtDate: "2026-08-21",
    });

    expect(result.currentQuantityMilli).toBe(18_000);
    expect(result.firstShortageAt).toBeNull();
    expect(result.reason).toBe("plan-ended");
  });

  it("keeps a currently active PRN plan non-predictable", () => {
    const result = estimateInventory({
      medicationId: "med-1",
      plans: [
        plan({
          scheduleType: "as_needed",
          times: [],
          effectiveFrom: new Date(
            localDateTimeToMs("2026-08-20", "00:00"),
          ).toISOString(),
        }),
      ],
      snapshots: [snapshot()],
      logs: [],
      asOfMs: asOf,
    });

    expect(result).toMatchObject({
      currentQuantityMilli: 20_000,
      predictable: false,
      reason: "as-needed",
    });
  });
});
