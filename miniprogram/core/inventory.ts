import { addDays, dateKeyFromMs, localDateTimeToMs, todayKey } from "./dates";
import type {
  IntakeLog,
  InventoryEstimate,
  InventorySnapshot,
  PlanVersion,
} from "./models";
import { expandOccurrences } from "./schedule";

const latestSnapshot = (
  snapshots: readonly InventorySnapshot[],
  medicationId: string,
  asOfMs: number,
): InventorySnapshot | null =>
  snapshots
    .filter(
      (item) =>
        item.medicationId === medicationId &&
        Date.parse(item.recordedAt) <= asOfMs,
    )
    .sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt))[0] ??
  null;

const activeLogs = (
  logs: readonly IntakeLog[],
  medicationId: string,
  fromMs: number,
  toMs: number,
): IntakeLog[] =>
  logs.filter((log) => {
    const occurredAt = Date.parse(log.occurredAt);
    return (
      log.medicationId === medicationId &&
      !log.voidedAt &&
      occurredAt > fromMs &&
      occurredAt <= toMs
    );
  });

export const estimateInventory = (args: {
  medicationId: string;
  plans: readonly PlanVersion[];
  snapshots: readonly InventorySnapshot[];
  logs: readonly IntakeLog[];
  asOfMs: number;
  forecastDays?: number;
  stopAtDate?: string;
}): InventoryEstimate => {
  const { medicationId, plans, snapshots, logs, asOfMs } = args;
  const snapshot = latestSnapshot(snapshots, medicationId, asOfMs);
  if (!snapshot) {
    return {
      medicationId,
      asOf: new Date(asOfMs).toISOString(),
      snapshotAt: null,
      currentQuantityMilli: null,
      lastCoveredAt: null,
      firstShortageAt: null,
      predictable: false,
      reason: "no-snapshot",
    };
  }

  const relevantPlans = plans.filter(
    (plan) => plan.medicationId === medicationId,
  );
  const asOfDate = todayKey(asOfMs);
  const hasAsNeeded = relevantPlans.some(
    (plan) =>
      plan.scheduleType === "as_needed" &&
      plan.startDate <= asOfDate &&
      (!plan.endDate || plan.endDate >= asOfDate) &&
      Date.parse(plan.effectiveFrom) <= asOfMs &&
      (!plan.effectiveTo || Date.parse(plan.effectiveTo) > asOfMs),
  );
  const logsSinceSnapshot = activeLogs(
    logs,
    medicationId,
    Date.parse(snapshot.recordedAt),
    asOfMs,
  );
  const scheduled = expandOccurrences(
    relevantPlans,
    Date.parse(snapshot.recordedAt) + 1,
    asOfMs,
    medicationId,
  ).filter(
    (occurrence) => !args.stopAtDate || occurrence.localDate <= args.stopAtDate,
  );
  const scheduledByKey = new Map(
    scheduled.map((occurrence) => [occurrence.key, occurrence]),
  );
  let loggedAdjustment = 0;
  for (const log of logsSinceSnapshot) {
    if (log.status === "extra") {
      loggedAdjustment += log.quantityMilli;
      continue;
    }
    const planned = log.occurrenceKey
      ? scheduledByKey.get(log.occurrenceKey)
      : undefined;
    if (log.status === "skipped" && planned) {
      loggedAdjustment -= planned.doseMilli;
    } else if (log.status === "taken" && !planned) {
      // An early or late confirmed intake is an actual stock change even when
      // its scheduled occurrence is outside the automatic estimate window.
      loggedAdjustment += log.quantityMilli;
    }
  }
  const scheduledConsumption = scheduled.reduce(
    (sum, item) => sum + item.doseMilli,
    0,
  );
  const currentQuantityMilli = Math.max(
    0,
    snapshot.quantityMilli - scheduledConsumption - loggedAdjustment,
  );

  if (hasAsNeeded) {
    return {
      medicationId,
      asOf: new Date(asOfMs).toISOString(),
      snapshotAt: snapshot.recordedAt,
      currentQuantityMilli,
      lastCoveredAt: null,
      firstShortageAt: null,
      predictable: false,
      reason: "as-needed",
    };
  }

  if (!relevantPlans.length) {
    return {
      medicationId,
      asOf: new Date(asOfMs).toISOString(),
      snapshotAt: snapshot.recordedAt,
      currentQuantityMilli,
      lastCoveredAt: null,
      firstShortageAt: null,
      predictable: false,
      reason: "no-plan",
    };
  }

  const forecastDays = args.forecastDays ?? 3650;
  const toDate = addDays(dateKeyFromMs(asOfMs), forecastDays);
  const forecastEndDate =
    args.stopAtDate && args.stopAtDate < toDate ? args.stopAtDate : toDate;
  const future = expandOccurrences(
    relevantPlans,
    asOfMs + 1,
    localDateTimeToMs(forecastEndDate, "23:59"),
    medicationId,
  );
  let remaining = currentQuantityMilli;
  let lastCoveredAt: string | null = null;

  for (const occurrence of future) {
    if (remaining < occurrence.doseMilli) {
      return {
        medicationId,
        asOf: new Date(asOfMs).toISOString(),
        snapshotAt: snapshot.recordedAt,
        currentQuantityMilli,
        lastCoveredAt,
        firstShortageAt: occurrence.scheduledAt,
        predictable: true,
        reason: "ok",
      };
    }
    remaining -= occurrence.doseMilli;
    lastCoveredAt = occurrence.scheduledAt;
  }

  return {
    medicationId,
    asOf: new Date(asOfMs).toISOString(),
    snapshotAt: snapshot.recordedAt,
    currentQuantityMilli,
    lastCoveredAt,
    firstShortageAt: null,
    predictable: true,
    reason: "plan-ended",
  };
};
