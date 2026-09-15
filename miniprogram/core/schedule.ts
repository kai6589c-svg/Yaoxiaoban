import {
  addDays,
  dateKeyFromMs,
  dayOfWeek,
  endOfLocalDayMs,
  localDateTimeToIso,
  localDateTimeToMs,
  startOfLocalDayMs,
} from "./dates";
import type { PlanVersion, ScheduleOccurrence } from "./models";

const isPlanActiveAt = (
  plan: PlanVersion,
  scheduledAtMs: number,
  date: string,
): boolean => {
  if (date < plan.startDate) return false;
  if (plan.endDate && date > plan.endDate) return false;
  if (scheduledAtMs < Date.parse(plan.effectiveFrom)) return false;
  if (plan.effectiveTo && scheduledAtMs >= Date.parse(plan.effectiveTo))
    return false;
  return true;
};

const appliesOnDate = (plan: PlanVersion, date: string): boolean => {
  if (plan.scheduleType === "daily") return true;
  if (plan.scheduleType === "weekly")
    return plan.weekdays.includes(dayOfWeek(date));
  return false;
};

export const occurrenceKey = (
  planId: string,
  date: string,
  time: string,
): string => `${planId}|${date}|${time}`;

export const expandOccurrences = (
  plans: readonly PlanVersion[],
  fromMs: number,
  toMs: number,
  medicationId?: string,
): ScheduleOccurrence[] => {
  if (toMs < fromMs) return [];
  const occurrences: ScheduleOccurrence[] = [];
  const startDate = dateKeyFromMs(fromMs);
  const endDate = dateKeyFromMs(toMs);

  for (const plan of plans) {
    if (medicationId && plan.medicationId !== medicationId) continue;
    if (plan.scheduleType === "as_needed") continue;

    let date = startDate;
    while (date <= endDate) {
      if (appliesOnDate(plan, date)) {
        for (const time of plan.times) {
          const scheduledAtMs = localDateTimeToMs(date, time);
          if (
            scheduledAtMs >= fromMs &&
            scheduledAtMs <= toMs &&
            isPlanActiveAt(plan, scheduledAtMs, date)
          ) {
            occurrences.push({
              key: occurrenceKey(plan.id, date, time),
              medicationId: plan.medicationId,
              planId: plan.id,
              scheduledAt: localDateTimeToIso(date, time),
              scheduledAtMs,
              localDate: date,
              time,
              doseMilli: plan.doseMilli,
            });
          }
        }
      }
      date = addDays(date, 1);
    }
  }

  return occurrences.sort(
    (a, b) => a.scheduledAtMs - b.scheduledAtMs || a.key.localeCompare(b.key),
  );
};

export const occurrencesForLocalDay = (
  plans: readonly PlanVersion[],
  nowMs: number,
  medicationId?: string,
): ScheduleOccurrence[] =>
  expandOccurrences(
    plans,
    startOfLocalDayMs(nowMs),
    endOfLocalDayMs(nowMs),
    medicationId,
  );
