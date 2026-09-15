import { describe, expect, it } from "vitest";

import { evaluateCabinetMedication } from "../miniprogram/core/cabinet";
import { localDateTimeToMs } from "../miniprogram/core/dates";
import { appState, medication, snapshot } from "./fixtures";

describe("药箱领域摘要", () => {
  const nowMs = localDateTimeToMs("2026-09-03", "09:00");

  it("到期当天仍为即将到期，第二天才标记过期", () => {
    const state = appState();
    state.medications = [medication({ expiryValue: "2026-09-03" })];
    state.plans = [];
    state.snapshots = [];

    expect(
      evaluateCabinetMedication({
        state,
        medication: state.medications[0]!,
        nowMs,
      }).status,
    ).toBe("expiring");
    expect(
      evaluateCabinetMedication({
        state,
        medication: state.medications[0]!,
        nowMs: localDateTimeToMs("2026-09-04", "00:01"),
      }).status,
    ).toBe("expired");
  });

  it("有确认盘点且预计为零时优先提示余量风险", () => {
    const state = appState();
    state.medications = [medication({ expiryValue: "2027-12-31" })];
    state.plans = [];
    state.snapshots = [
      snapshot({
        quantityMilli: 0,
        recordedAt: "2026-09-03T00:00:00.000Z",
      }),
    ];

    const facts = evaluateCabinetMedication({
      state,
      medication: state.medications[0]!,
      nowMs,
    });
    expect(facts.status).toBe("empty");
    expect(facts.sortRank).toBe(1);
    expect(facts.estimate.currentQuantityMilli).toBe(0);
  });

  it("开封后期限早于包装日期时停止生成更晚的下次任务", () => {
    const state = appState();
    state.medications = [
      medication({
        expiryValue: "2027-12-31",
        openedDate: "2026-09-01",
        afterOpenDays: 3,
      }),
    ];

    const facts = evaluateCabinetMedication({
      state,
      medication: state.medications[0]!,
      nowMs,
    });
    expect(facts.expiry.effectiveExpiryDate).toBe("2026-09-03");
    expect(facts.nextOccurrence).toBeNull();
  });
});
