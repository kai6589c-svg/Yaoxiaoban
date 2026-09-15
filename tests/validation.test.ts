import { describe, expect, it } from "vitest";
import type { MedicationDraft } from "../miniprogram/core/models";
import {
  validateMedicationDraft,
  validateProfile,
} from "../miniprogram/core/validation";

const validDraft = (): MedicationDraft => ({
  profileId: "profile-1",
  name: "测试药",
  specification: "",
  unit: "片",
  mode: "scheduled",
  expiryPrecision: "month",
  expiryValue: "2027-03",
  openedDate: null,
  afterOpenDays: null,
  note: "",
  initialQuantityMilli: 20_000,
  schedule: {
    type: "daily",
    startDate: "2026-08-19",
    endDate: null,
    weekdays: [],
    times: ["08:00"],
    doseMilli: 1000,
  },
});

describe("input validation", () => {
  it("accepts a valid progressive medication form", () => {
    expect(validateMedicationDraft(validDraft())).toEqual({
      valid: true,
      fieldErrors: {},
    });
  });

  it("requires only name/profile/expiry for expiry-only mode", () => {
    const draft = validDraft();
    draft.mode = "expiry_only";
    draft.schedule = null;
    draft.unit = "";
    draft.initialQuantityMilli = null;
    expect(validateMedicationDraft(draft).valid).toBe(true);
  });

  it("reports unsafe or incomplete values by field", () => {
    const draft = validDraft();
    draft.name = " ".repeat(2);
    draft.profileId = "";
    draft.expiryValue = "2027-13";
    draft.initialQuantityMilli = -1;
    draft.openedDate = null;
    draft.afterOpenDays = 0;
    draft.schedule = {
      type: "weekly",
      startDate: "bad",
      endDate: "2020-01-01",
      weekdays: [],
      times: ["25:00", "25:00"],
      doseMilli: 0,
    };
    const result = validateMedicationDraft(draft);
    expect(result.valid).toBe(false);
    expect(Object.keys(result.fieldErrors)).toEqual(
      expect.arrayContaining([
        "name",
        "profileId",
        "expiryValue",
        "initialQuantityMilli",
        "afterOpenDays",
        "openedDate",
        "startDate",
        "endDate",
        "weekdays",
        "times",
        "doseMilli",
      ]),
    );
  });

  it("rejects duplicated times and end before start", () => {
    const draft = validDraft();
    draft.schedule!.times = ["08:00", "08:00"];
    draft.schedule!.endDate = "2026-08-18";
    const result = validateMedicationDraft(draft);
    expect(result.fieldErrors["times"]).toContain("重复");
    expect(result.fieldErrors["endDate"]).toContain("不能早于");
  });

  it("rejects an opened date later than the deterministic current local date", () => {
    const draft = validDraft();
    draft.openedDate = "2026-08-20";
    draft.afterOpenDays = 30;

    const result = validateMedicationDraft(draft, { today: "2026-08-19" });

    expect(result.fieldErrors["openedDate"]).toContain("不能晚于今天");
  });

  it("rejects an opened date later than the package expiry", () => {
    const draft = validDraft();
    draft.expiryPrecision = "day";
    draft.expiryValue = "2026-08-18";
    draft.openedDate = "2026-08-19";
    draft.afterOpenDays = 30;

    const result = validateMedicationDraft(draft, { today: "2026-08-20" });

    expect(result.fieldErrors["openedDate"]).toContain("包装有效期");
  });

  it("accepts an opened date equal to both today and the package expiry", () => {
    const draft = validDraft();
    draft.expiryPrecision = "day";
    draft.expiryValue = "2026-08-19";
    draft.openedDate = "2026-08-19";
    draft.afterOpenDays = 30;

    expect(
      validateMedicationDraft(draft, { today: "2026-08-19" }).fieldErrors[
        "openedDate"
      ],
    ).toBeUndefined();
  });

  it("requires opening date and after-open days as a complete pair", () => {
    const missingDays = validDraft();
    missingDays.openedDate = "2026-08-19";
    missingDays.afterOpenDays = null;

    const missingDate = validDraft();
    missingDate.openedDate = null;
    missingDate.afterOpenDays = 30;

    expect(
      validateMedicationDraft(missingDays, { today: "2026-08-19" }).fieldErrors[
        "afterOpenDays"
      ],
    ).toContain("请填写");
    expect(
      validateMedicationDraft(missingDate, { today: "2026-08-19" }).fieldErrors[
        "openedDate"
      ],
    ).toContain("请先填写");
  });

  it("rejects plans that start or end after the effective management expiry", () => {
    const afterPackageExpiry = validDraft();
    afterPackageExpiry.expiryPrecision = "day";
    afterPackageExpiry.expiryValue = "2026-08-25";
    afterPackageExpiry.schedule!.startDate = "2026-08-26";

    const afterOpenedExpiry = validDraft();
    afterOpenedExpiry.expiryPrecision = "day";
    afterOpenedExpiry.expiryValue = "2026-12-31";
    afterOpenedExpiry.openedDate = "2026-08-19";
    afterOpenedExpiry.afterOpenDays = 7;
    afterOpenedExpiry.schedule!.startDate = "2026-08-19";
    afterOpenedExpiry.schedule!.endDate = "2026-08-26";

    expect(
      validateMedicationDraft(afterPackageExpiry, {
        today: "2026-08-19",
      }).fieldErrors["startDate"],
    ).toContain("管理期限");
    expect(
      validateMedicationDraft(afterOpenedExpiry, {
        today: "2026-08-19",
      }).fieldErrors["endDate"],
    ).toContain("管理期限");
  });

  it("keeps medication mode and schedule type consistent", () => {
    const scheduledWithPrnPlan = validDraft();
    scheduledWithPrnPlan.schedule!.type = "as_needed";
    scheduledWithPrnPlan.schedule!.times = [];

    const prnWithDailyPlan = validDraft();
    prnWithDailyPlan.mode = "as_needed";

    expect(
      validateMedicationDraft(scheduledWithPrnPlan).fieldErrors["schedule"],
    ).toContain("不一致");
    expect(
      validateMedicationDraft(prnWithDailyPlan).fieldErrors["schedule"],
    ).toContain("不一致");
  });

  it("requires a selected unit whenever quantity is tracked", () => {
    const scheduled = validDraft();
    scheduled.unit = "";

    const expiryOnlyWithStock = validDraft();
    expiryOnlyWithStock.mode = "expiry_only";
    expiryOnlyWithStock.schedule = null;
    expiryOnlyWithStock.unit = "";
    expiryOnlyWithStock.initialQuantityMilli = 0;

    expect(validateMedicationDraft(scheduled).fieldErrors["unit"]).toBeTruthy();
    expect(
      validateMedicationDraft(expiryOnlyWithStock).fieldErrors["unit"],
    ).toBeTruthy();
  });

  it("validates profile name", () => {
    expect(validateProfile({ name: "妈妈", relation: "parent" }).valid).toBe(
      true,
    );
    expect(
      validateProfile({ name: "", relation: "other" }).fieldErrors["name"],
    ).toBeTruthy();
    expect(
      validateProfile({ name: "超过十个字的家庭成员称呼", relation: "other" })
        .valid,
    ).toBe(false);
  });
});
