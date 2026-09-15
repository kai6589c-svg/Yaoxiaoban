import { describe, expect, it } from "vitest";
import { localDateTimeToMs } from "../miniprogram/core/dates";
import {
  expandOccurrences,
  occurrenceKey,
  occurrencesForLocalDay,
} from "../miniprogram/core/schedule";
import { plan } from "./fixtures";

describe("schedule expansion", () => {
  it("expands daily times in stable order", () => {
    const items = expandOccurrences(
      [plan({ times: ["20:00", "08:00"] })],
      localDateTimeToMs("2026-08-19", "00:00"),
      localDateTimeToMs("2026-08-20", "23:59"),
    );
    expect(items.map((item) => `${item.localDate} ${item.time}`)).toEqual([
      "2026-08-19 08:00",
      "2026-08-19 20:00",
      "2026-08-20 08:00",
      "2026-08-20 20:00",
    ]);
  });

  it("expands only selected weekdays", () => {
    const items = expandOccurrences(
      [plan({ scheduleType: "weekly", weekdays: [1, 3, 5], times: ["08:00"] })],
      localDateTimeToMs("2026-08-17", "00:00"),
      localDateTimeToMs("2026-08-23", "23:59"),
    );
    expect(items.map((item) => item.localDate)).toEqual([
      "2026-08-17",
      "2026-08-19",
      "2026-08-21",
    ]);
  });

  it("honors effective timestamps instead of whole-day approximations", () => {
    const createdAtTen = new Date(
      localDateTimeToMs("2026-08-19", "10:00"),
    ).toISOString();
    const items = expandOccurrences(
      [plan({ times: ["08:00", "12:00"], effectiveFrom: createdAtTen })],
      localDateTimeToMs("2026-08-19", "00:00"),
      localDateTimeToMs("2026-08-19", "23:59"),
    );
    expect(items.map((item) => item.time)).toEqual(["12:00"]);

    const retiredAtTen = createdAtTen;
    const oldItems = expandOccurrences(
      [plan({ times: ["08:00", "12:00"], effectiveTo: retiredAtTen })],
      localDateTimeToMs("2026-08-19", "00:00"),
      localDateTimeToMs("2026-08-19", "23:59"),
    );
    expect(oldItems.map((item) => item.time)).toEqual(["08:00"]);
  });

  it("honors start/end dates, skips as-needed plans and filters medication", () => {
    const items = expandOccurrences(
      [
        plan({ startDate: "2026-08-20", endDate: "2026-08-20" }),
        plan({ id: "plan-as-needed", scheduleType: "as_needed" }),
        plan({ id: "other", medicationId: "other-med" }),
      ],
      localDateTimeToMs("2026-08-19", "00:00"),
      localDateTimeToMs("2026-08-21", "23:59"),
      "med-1",
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.localDate).toBe("2026-08-20");
  });

  it("returns a local day and stable occurrence key", () => {
    const now = localDateTimeToMs("2026-08-19", "10:00");
    const items = occurrencesForLocalDay([plan()], now);
    expect(items[0]?.key).toBe(occurrenceKey("plan-1", "2026-08-19", "08:00"));
    expect(expandOccurrences([plan()], now, now - 1)).toEqual([]);
  });
});
