import { daysBetween, todayKey } from "./dates";
import { resolveExpiry, type ExpiryResolution } from "./expiry";
import { estimateInventory } from "./inventory";
import type {
  AppState,
  InventoryEstimate,
  Medication,
  ScheduleOccurrence,
} from "./models";
import { expandOccurrences } from "./schedule";

export type CabinetMedicationStatus =
  "expired" | "empty" | "low-stock" | "expiring" | "scheduled" | "normal";

export interface CabinetMedicationFacts {
  estimate: InventoryEstimate;
  expiry: ExpiryResolution;
  daysToExpiry: number;
  shortageDays: number | null;
  nextOccurrence: ScheduleOccurrence | null;
  status: CabinetMedicationStatus;
  sortRank: number;
}

/**
 * Computes cabinet ordering and risk state without presentation text. Pages
 * only format these facts; they do not reimplement expiry, inventory, or
 * schedule eligibility rules.
 */
export const evaluateCabinetMedication = (args: {
  state: AppState;
  medication: Medication;
  nowMs?: number;
}): CabinetMedicationFacts => {
  const { state, medication } = args;
  const nowMs = args.nowMs ?? Date.now();
  const expiry = resolveExpiry(medication);
  const today = todayKey(nowMs);
  const estimate = estimateInventory({
    medicationId: medication.id,
    plans: state.plans,
    snapshots: state.snapshots,
    logs: state.intakeLogs,
    asOfMs: nowMs,
    stopAtDate: expiry.effectiveExpiryDate,
  });
  const nextOccurrence =
    expandOccurrences(
      state.plans,
      nowMs + 1,
      nowMs + 366 * 86_400_000,
      medication.id,
    ).find(
      (occurrence) => occurrence.localDate <= expiry.effectiveExpiryDate,
    ) ?? null;
  const daysToExpiry = daysBetween(today, expiry.effectiveExpiryDate);
  const shortageDays = estimate.firstShortageAt
    ? daysBetween(today, todayKey(Date.parse(estimate.firstShortageAt)))
    : null;

  if (daysToExpiry < 0)
    return {
      estimate,
      expiry,
      daysToExpiry,
      shortageDays,
      nextOccurrence,
      status: "expired",
      sortRank: 0,
    };
  if (estimate.currentQuantityMilli === 0 && estimate.snapshotAt)
    return {
      estimate,
      expiry,
      daysToExpiry,
      shortageDays,
      nextOccurrence,
      status: "empty",
      sortRank: 1,
    };
  if (
    shortageDays !== null &&
    shortageDays <= state.settings.lowStockLeadDays
  ) {
    return {
      estimate,
      expiry,
      daysToExpiry,
      shortageDays,
      nextOccurrence,
      status: "low-stock",
      sortRank: 1,
    };
  }
  if (daysToExpiry <= state.settings.expiryLeadDays)
    return {
      estimate,
      expiry,
      daysToExpiry,
      shortageDays,
      nextOccurrence,
      status: "expiring",
      sortRank: 2,
    };
  return {
    estimate,
    expiry,
    daysToExpiry,
    shortageDays,
    nextOccurrence,
    status: nextOccurrence ? "scheduled" : "normal",
    sortRank: nextOccurrence ? 3 : 4,
  };
};
