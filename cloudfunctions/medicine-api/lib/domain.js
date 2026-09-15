"use strict";

const {
  addCalendarDays,
  addDays,
  chinaDate,
  chinaDateTime,
  chinaParts,
  endOfMonth,
  minDate,
} = require("./time");

function calculateEffectiveExpiry(medication) {
  const packageDate = medication.expiry
    ? medication.expiry.precision === "month"
      ? endOfMonth(medication.expiry.value)
      : medication.expiry.value
    : null;
  const openedDate =
    medication.openedOn && medication.afterOpenDays
      ? addCalendarDays(medication.openedOn, medication.afterOpenDays - 1)
      : null;
  const effectiveDate = minDate(packageDate, openedDate);
  return {
    packageDate,
    openedDate,
    effectiveDate,
    source:
      openedDate && (!packageDate || openedDate < packageDate)
        ? "after-open"
        : "package",
  };
}

function effectiveExpiry(medication) {
  return calculateEffectiveExpiry(medication).effectiveDate;
}

function expiryState(medication, now, leadDays) {
  const date = effectiveExpiry(medication);
  if (!date)
    return { effectiveExpiry: null, state: "unknown", daysRemaining: null };
  const today = chinaDate(now);
  const daysRemaining = Math.round(
    (chinaDateTime(date).getTime() - chinaDateTime(today).getTime()) / 86400000,
  );
  return {
    effectiveExpiry: date,
    state:
      daysRemaining < 0
        ? "expired"
        : daysRemaining <= leadDays
          ? "expiring"
          : "ok",
    daysRemaining,
  };
}

function isPlanActiveOn(plan, date) {
  if (plan.kind === "prn") return false;
  if (plan.startDate > date) return false;
  if (plan.endDate && plan.endDate < date) return false;
  if (plan.effectiveFrom && chinaDate(plan.effectiveFrom) > date) return false;
  if (plan.supersededAt && chinaDate(plan.supersededAt) < date) return false;
  if (plan.kind === "weekdays") {
    const weekday = chinaParts(chinaDateTime(date)).weekday;
    return plan.weekdays.includes(weekday);
  }
  return true;
}

function occurrencesForDate(plan, date) {
  if (!isPlanActiveOn(plan, date)) return [];
  return plan.times
    .map((time) => ({
      planId: plan._id,
      medicationId: plan.medicationId,
      // Stable event identity; it must not depend on the position in times.
      key: `${date}|${time}`,
      scheduledAt: chinaDateTime(date, time).toISOString(),
      time,
      quantity: plan.dose,
      unit: plan.unit,
    }))
    .filter(
      (occurrence) =>
        !plan.effectiveFrom || occurrence.scheduledAt >= plan.effectiveFrom,
    )
    .filter(
      (occurrence) =>
        !plan.supersededAt || occurrence.scheduledAt < plan.supersededAt,
    );
}

function occurrencesBetween(plans, start, end, maxOccurrences = 10000) {
  const result = [];
  let cursor = new Date(start);
  const endMs = new Date(end).getTime();
  while (cursor.getTime() <= endMs) {
    const date = chinaDate(cursor);
    for (const plan of plans) {
      for (const occurrence of occurrencesForDate(plan, date)) {
        const timestamp = Date.parse(occurrence.scheduledAt);
        if (timestamp > new Date(start).getTime() && timestamp <= endMs)
          result.push(occurrence);
        if (result.length > maxOccurrences)
          throw new Error("OCCURRENCE_LIMIT_EXCEEDED");
      }
    }
    cursor = addDays(chinaDateTime(date), 1);
  }
  return result.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
}

function estimateInventory({ snapshot, plans, logs, now }) {
  if (!snapshot)
    return {
      quantity: null,
      consumed: null,
      deficit: null,
      reason: "NO_SNAPSHOT",
    };
  const hasOverlappingUnitMismatch = plans.some(
    (plan) =>
      plan.kind !== "prn" &&
      plan.unit !== snapshot.unit &&
      (!plan.supersededAt || plan.supersededAt > snapshot.capturedAt),
  );
  if (hasOverlappingUnitMismatch) {
    return {
      quantity: null,
      consumed: null,
      deficit: null,
      reason: "UNIT_MISMATCH",
    };
  }
  const relevantPlans = plans.filter(
    (plan) => plan.kind !== "prn" && plan.unit === snapshot.unit,
  );
  const occurrences = occurrencesBetween(
    relevantPlans,
    snapshot.capturedAt,
    now,
  );
  let consumed = occurrences.reduce((sum, item) => sum + item.quantity, 0);
  for (const log of logs) {
    if (
      log.undoneAt ||
      log.occurredAt <= snapshot.capturedAt ||
      log.occurredAt > new Date(now).toISOString()
    )
      continue;
    if (log.unit !== snapshot.unit) continue;
    if (log.status === "skipped") consumed -= log.quantity;
    if (log.status === "extra") consumed += log.quantity;
  }
  consumed = Math.max(0, roundQuantity(consumed));
  const raw = roundQuantity(snapshot.quantity - consumed);
  return {
    quantity: Math.max(0, raw),
    consumed,
    deficit: Math.max(0, -raw),
    reason: null,
    asOf: new Date(now).toISOString(),
    snapshotAt: snapshot.capturedAt,
    unit: snapshot.unit,
  };
}

function projectedRunOut({
  quantity,
  unit,
  activePlan,
  now,
  horizonDays = 365,
}) {
  if (
    quantity === null ||
    quantity === undefined ||
    quantity <= 0 ||
    !activePlan ||
    activePlan.kind === "prn"
  )
    return null;
  if (activePlan.unit !== unit) return null;
  const end = addDays(now, horizonDays);
  const occurrences = occurrencesBetween([activePlan], now, end);
  let remaining = quantity;
  for (const occurrence of occurrences) {
    remaining = roundQuantity(remaining - occurrence.quantity);
    if (remaining < 0) return occurrence.scheduledAt;
  }
  return null;
}

function roundQuantity(value) {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

module.exports = {
  calculateEffectiveExpiry,
  effectiveExpiry,
  estimateInventory,
  expiryState,
  isPlanActiveOn,
  occurrencesBetween,
  occurrencesForDate,
  projectedRunOut,
  roundQuantity,
};
