import { describe, expect, it } from "vitest";
import {
  addDays,
  dateKeyFromMs,
  dayOfWeek,
  daysBetween,
  endOfMonth,
  formatChineseDate,
  formatDose,
  isValidDateKey,
  isValidMonthKey,
  isValidTimeKey,
  localDateTimeToMs,
  timeKeyFromMs,
} from "../miniprogram/core/dates";
import {
  daysUntilExpiry,
  effectiveExpiryDate,
  resolveExpiry,
} from "../miniprogram/core/expiry";
import { medication } from "./fixtures";

describe("date utilities", () => {
  it("validates date, month and time keys", () => {
    expect(isValidDateKey("2024-02-29")).toBe(true);
    expect(isValidDateKey("2023-02-29")).toBe(false);
    expect(isValidDateKey("2026/08/19")).toBe(false);
    expect(isValidMonthKey("2026-12")).toBe(true);
    expect(isValidMonthKey("2026-13")).toBe(false);
    expect(isValidTimeKey("23:59")).toBe(true);
    expect(isValidTimeKey("24:00")).toBe(false);
  });

  it("calculates month end including leap years", () => {
    expect(endOfMonth("2024-02")).toBe("2024-02-29");
    expect(endOfMonth("2025-02")).toBe("2025-02-28");
    expect(endOfMonth("2026-04")).toBe("2026-04-30");
    expect(() => endOfMonth("2026-14")).toThrow("Invalid month");
  });

  it("converts Shanghai local time without depending on host timezone", () => {
    const ms = localDateTimeToMs("2026-08-19", "09:30");
    expect(new Date(ms).toISOString()).toBe("2026-08-19T01:30:00.000Z");
    expect(dateKeyFromMs(ms)).toBe("2026-08-19");
    expect(timeKeyFromMs(ms)).toBe("09:30");
  });

  it("adds and compares days across boundaries", () => {
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2024-12-31", 1)).toBe("2025-01-01");
    expect(daysBetween("2026-08-19", "2026-08-25")).toBe(6);
    expect(dayOfWeek("2026-08-17")).toBe(1);
    expect(dayOfWeek("2026-08-23")).toBe(7);
  });

  it("uses the earlier of package and after-open expiry", () => {
    expect(
      effectiveExpiryDate(
        medication({ expiryPrecision: "month", expiryValue: "2026-09" }),
      ),
    ).toBe("2026-09-30");
    expect(
      effectiveExpiryDate(
        medication({
          expiryValue: "2026-12-31",
          openedDate: "2026-08-19",
          afterOpenDays: 30,
        }),
      ),
    ).toBe("2026-09-17");
  });

  it("resolves package and after-open expiry with an explicit source", () => {
    expect(
      resolveExpiry(
        medication({
          expiryPrecision: "month",
          expiryValue: "2026-09",
          openedDate: null,
          afterOpenDays: null,
        }),
      ),
    ).toEqual({
      packageExpiryDate: "2026-09-30",
      openedExpiryDate: null,
      effectiveExpiryDate: "2026-09-30",
      source: "package",
    });

    expect(
      resolveExpiry(
        medication({
          expiryPrecision: "day",
          expiryValue: "2026-12-31",
          openedDate: "2026-08-19",
          afterOpenDays: 30,
        }),
      ),
    ).toEqual({
      packageExpiryDate: "2026-12-31",
      openedExpiryDate: "2026-09-17",
      effectiveExpiryDate: "2026-09-17",
      source: "after-open",
    });

    expect(
      resolveExpiry(
        medication({
          expiryPrecision: "day",
          expiryValue: "2026-08-31",
          openedDate: "2026-08-19",
          afterOpenDays: 30,
        }),
      ),
    ).toEqual({
      packageExpiryDate: "2026-08-31",
      openedExpiryDate: "2026-09-17",
      effectiveExpiryDate: "2026-08-31",
      source: "package",
    });
  });

  it("counts the opening date as day one of the after-open period", () => {
    expect(
      resolveExpiry(
        medication({
          expiryValue: "2026-12-31",
          openedDate: "2026-08-19",
          afterOpenDays: 1,
        }),
      ),
    ).toMatchObject({
      openedExpiryDate: "2026-08-19",
      effectiveExpiryDate: "2026-08-19",
      source: "after-open",
    });
  });

  it("keeps a medicine valid through its expiry date and expires it the next local day", () => {
    const item = medication({
      expiryPrecision: "day",
      expiryValue: "2026-09-01",
    });

    expect(
      daysUntilExpiry(item, localDateTimeToMs("2026-09-01", "00:00")),
    ).toBe(0);
    expect(
      daysUntilExpiry(item, localDateTimeToMs("2026-09-01", "23:59")),
    ).toBe(0);
    expect(
      daysUntilExpiry(item, localDateTimeToMs("2026-09-02", "00:00")),
    ).toBe(-1);
  });

  it("formats dates and quantities for display", () => {
    expect(formatChineseDate("2027-03", "month")).toBe("2027年3月");
    expect(formatChineseDate("2027-03-01")).toBe("2027年3月1日");
    expect(formatDose(1000, "片")).toBe("1片");
    expect(formatDose(1250, "片")).toBe("1.25片");
  });
});
