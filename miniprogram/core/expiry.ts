import {
  addDays,
  daysBetween,
  endOfMonth,
  isValidDateKey,
  isValidMonthKey,
  todayKey,
} from "./dates";
import type { Medication } from "./models";
import type { DatePrecision } from "./status";

export interface EffectiveExpiryInput {
  expiryPrecision: DatePrecision;
  expiryValue: string;
  openedDate: string | null;
  afterOpenDays: number | null;
}

export interface ExpiryResolution {
  packageExpiryDate: string;
  openedExpiryDate: string | null;
  effectiveExpiryDate: string;
  source: "package" | "after-open";
}

/**
 * Resolves the last usable local calendar date. Month-only package dates use
 * the month's final day, and the opening day is Day 1. Invalid/incomplete
 * drafts return null so presentation code can show a neutral preview without
 * reimplementing the rule.
 */
export const calculateEffectiveExpiry = (
  input: EffectiveExpiryInput,
): ExpiryResolution | null => {
  const packageValid =
    input.expiryPrecision === "month"
      ? isValidMonthKey(input.expiryValue)
      : isValidDateKey(input.expiryValue);
  if (!packageValid) return null;

  const packageExpiryDate =
    input.expiryPrecision === "month"
      ? endOfMonth(input.expiryValue)
      : input.expiryValue;
  if (
    !input.openedDate ||
    !isValidDateKey(input.openedDate) ||
    !Number.isInteger(input.afterOpenDays) ||
    (input.afterOpenDays ?? 0) < 1
  ) {
    return {
      packageExpiryDate,
      openedExpiryDate: null,
      effectiveExpiryDate: packageExpiryDate,
      source: "package",
    };
  }

  const openedExpiryDate = addDays(
    input.openedDate,
    (input.afterOpenDays ?? 1) - 1,
  );
  const openingWins = openedExpiryDate < packageExpiryDate;
  return {
    packageExpiryDate,
    openedExpiryDate,
    effectiveExpiryDate: openingWins ? openedExpiryDate : packageExpiryDate,
    source: openingWins ? "after-open" : "package",
  };
};

export const resolveExpiry = (
  medication: Pick<
    Medication,
    "expiryPrecision" | "expiryValue" | "openedDate" | "afterOpenDays"
  >,
): ExpiryResolution => {
  const result = calculateEffectiveExpiry(medication);
  if (!result) throw new Error("Medication has an invalid package expiry");
  return result;
};

export const effectiveExpiryDate = (
  medication: Pick<
    Medication,
    "expiryPrecision" | "expiryValue" | "openedDate" | "afterOpenDays"
  >,
): string => resolveExpiry(medication).effectiveExpiryDate;

export const daysUntilExpiry = (
  medication: Pick<
    Medication,
    "expiryPrecision" | "expiryValue" | "openedDate" | "afterOpenDays"
  >,
  nowMs = Date.now(),
): number => daysBetween(todayKey(nowMs), effectiveExpiryDate(medication));
