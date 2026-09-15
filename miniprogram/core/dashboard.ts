import {
  daysBetween,
  formatChineseDate,
  formatShortChineseDate,
  todayKey,
} from "./dates";
import { daysUntilExpiry, resolveExpiry } from "./expiry";
import { estimateInventory } from "./inventory";
import type { AppState, RiskItem, TodayTask } from "./models";
import { occurrencesForLocalDay } from "./schedule";

export const buildTodayTasks = (
  state: AppState,
  nowMs = Date.now(),
): TodayTask[] => {
  const activeMedicationIds = new Set(
    state.medications.filter((item) => !item.archivedAt).map((item) => item.id),
  );
  const occurrences = occurrencesForLocalDay(
    state.plans.filter((plan) => activeMedicationIds.has(plan.medicationId)),
    nowMs,
  );
  const logByOccurrence = new Map(
    state.intakeLogs
      .filter((log) => log.occurrenceKey && !log.voidedAt)
      .map((log) => [log.occurrenceKey as string, log]),
  );

  return occurrences.flatMap((occurrence): TodayTask[] => {
    const medication = state.medications.find(
      (item) => item.id === occurrence.medicationId,
    );
    if (!medication) return [];
    const profile = state.profiles.find(
      (item) => item.id === medication.profileId,
    );
    if (!profile || profile.archivedAt) return [];
    const log = logByOccurrence.get(occurrence.key);
    let status: TodayTask["status"];
    if (log?.status === "taken") status = "taken";
    else if (log?.status === "skipped") status = "skipped";
    else if (daysUntilExpiry(medication, nowMs) < 0) status = "needs-review";
    else status = occurrence.scheduledAtMs <= nowMs ? "due" : "upcoming";

    return [
      {
        ...occurrence,
        medicationName: medication.name,
        profileName: profile.name,
        profileColor: profile.color,
        unit: medication.unit,
        status,
        logId: log?.id ?? null,
      },
    ];
  });
};

export const buildRisks = (state: AppState, nowMs = Date.now()): RiskItem[] => {
  const today = todayKey(nowMs);
  const risks: RiskItem[] = [];

  for (const medication of state.medications.filter(
    (item) => !item.archivedAt,
  )) {
    const expiry = resolveExpiry(medication);
    const expiryDate = expiry.effectiveExpiryDate;
    const remainingDays = daysBetween(today, expiryDate);
    if (remainingDays < 0) {
      risks.push({
        id: `expired-${medication.id}`,
        medicationId: medication.id,
        level: "danger",
        type: "expired",
        title: `${medication.name} 已超过管理期限`,
        detail:
          expiry.source === "after-open"
            ? `开封后期限已于${formatChineseDate(expiryDate)}结束，请核对或移除这盒药`
            : `包装标注${formatChineseDate(medication.expiryValue, medication.expiryPrecision)}，请核对或移除这盒药`,
      });
    } else if (remainingDays <= state.settings.expiryLeadDays) {
      const relativeText =
        remainingDays === 0
          ? "今天到期"
          : remainingDays === 1
            ? "明天到期"
            : `还剩${remainingDays}天`;
      risks.push({
        id: `expiring-${medication.id}`,
        medicationId: medication.id,
        level: "warning",
        type: "expiring",
        title:
          remainingDays === 0
            ? `${medication.name} 今天到期`
            : `${medication.name} 即将到期`,
        detail: `${formatShortChineseDate(expiryDate)}管理到期，${relativeText}${expiry.source === "after-open" ? "（按开封后期限）" : ""}`,
      });
    }

    if (remainingDays >= 0) {
      const estimate = estimateInventory({
        medicationId: medication.id,
        plans: state.plans,
        snapshots: state.snapshots,
        logs: state.intakeLogs,
        asOfMs: nowMs,
        stopAtDate: expiryDate,
      });
      if (estimate.currentQuantityMilli === 0 && estimate.snapshotAt) {
        risks.push({
          id: `low-stock-${medication.id}`,
          medicationId: medication.id,
          level: "warning",
          type: "low-stock",
          title: `${medication.name} 预计余量为 0`,
          detail: "请盘点确认；如果已经用完，可以移除这盒药",
        });
      } else if (estimate.firstShortageAt) {
        const shortageDate = todayKey(Date.parse(estimate.firstShortageAt));
        const shortageDays = daysBetween(today, shortageDate);
        if (shortageDays <= state.settings.lowStockLeadDays) {
          risks.push({
            id: `low-stock-${medication.id}`,
            medicationId: medication.id,
            level: "warning",
            type: "low-stock",
            title: `${medication.name} 预计余量不足`,
            detail: `按计划估算，${formatShortChineseDate(shortageDate)}起可能不足，请先盘点`,
          });
        }
      } else if (medication.mode !== "expiry_only" && !estimate.snapshotAt) {
        risks.push({
          id: `unknown-stock-${medication.id}`,
          medicationId: medication.id,
          level: "info",
          type: "unknown-stock",
          title: `${medication.name} 尚未盘点`,
          detail: "填写现有数量后，可估算什么时候用完",
        });
      }
    }

    const activePlan = state.plans.find(
      (item) =>
        item.medicationId === medication.id && item.effectiveTo === null,
    );
    const hasCurrentCalendar = Boolean(
      activePlan &&
      state.calendarExports.some(
        (item) =>
          item.medicationId === medication.id &&
          item.planId === activePlan.id &&
          !item.staleAt,
      ),
    );
    const staleCalendar =
      !hasCurrentCalendar &&
      state.calendarExports.some(
        (item) => item.medicationId === medication.id && item.staleAt,
      );
    if (staleCalendar) {
      risks.push({
        id: `calendar-stale-${medication.id}`,
        medicationId: medication.id,
        level: "info",
        type: "calendar-stale",
        title: `${medication.name} 有旧日历提醒`,
        detail: "计划已变化，请到手机系统日历删除旧事件",
      });
    }
  }

  const levelOrder: Record<RiskItem["level"], number> = {
    danger: 0,
    warning: 1,
    info: 2,
  };
  return risks.sort(
    (a, b) =>
      levelOrder[a.level] - levelOrder[b.level] ||
      a.title.localeCompare(b.title),
  );
};

export interface TodayDashboard {
  syncScope?: string;
  privacyAcceptedVersion: string | null;
  generatedAt: string;
  tasks: TodayTask[];
  risks: RiskItem[];
  summary: {
    medicationCount: number;
    multipleProfiles: boolean;
    pendingCount: number;
    recordedCount: number;
    planlessMedicationId: string;
  };
  nextReminder: { scheduledAt: string; medicationId: string } | null;
}
export const buildTodayDashboard = (
  state: AppState,
  nowMs = Date.now(),
): TodayDashboard => {
  const tasks = buildTodayTasks(state, nowMs);
  const medications = state.medications.filter((item) => !item.archivedAt);
  const next = tasks.find((item) => ["upcoming", "due"].includes(item.status));
  return {
    syncScope: state.syncScope,
    privacyAcceptedVersion: state.settings.privacyAcceptedVersion,
    generatedAt: new Date(nowMs).toISOString(),
    tasks,
    risks: buildRisks(state, nowMs),
    summary: {
      medicationCount: medications.length,
      multipleProfiles:
        state.profiles.filter((item) => !item.archivedAt).length > 1,
      pendingCount: tasks.filter((item) =>
        ["upcoming", "due"].includes(item.status),
      ).length,
      recordedCount: tasks.filter((item) =>
        ["taken", "skipped"].includes(item.status),
      ).length,
      planlessMedicationId:
        medications.find(
          (item) =>
            item.mode !== "expiry_only" &&
            !state.plans.some(
              (plan) => plan.medicationId === item.id && !plan.effectiveTo,
            ),
        )?.id ?? "",
    },
    nextReminder: next
      ? { scheduledAt: next.scheduledAt, medicationId: next.medicationId }
      : null,
  };
};
