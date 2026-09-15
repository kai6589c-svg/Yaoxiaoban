import { formatChineseDate, todayKey } from "../core/dates";
import type { AppState, Medication } from "../core/models";
import { buildCalendarEvents } from "./calendar";

/** Calendar exports confirm an API write, not continued system notification delivery. */
export const reminderStatus = (
  state: AppState,
  medication: Medication,
  nowMs = Date.now(),
) => {
  const plan = state.plans.find(
    (p) => p.medicationId === medication.id && p.effectiveTo === null,
  );
  const exports = state.calendarExports.filter(
    (e) => e.medicationId === medication.id,
  );
  const stale = exports.some((e) => Boolean(e.staleAt));
  const oldCalendarText = stale
    ? "计划曾变更：请在手机日历核对并删除旧提醒，旧事件不会自动更新。"
    : "";
  if (!plan || plan.scheduleType === "as_needed")
    return {
      text: plan
        ? "按需使用，不生成固定时间提醒"
        : "只管效期，未设置固定服药提醒",
      coverage: "",
      oldCalendarText,
      action: "查看提醒设置",
      hasFixedPlan: false,
    };
  const expected = buildCalendarEvents({
    medication,
    plan,
    showDetails: false,
    nowMs,
  });
  const written = exports.filter((e) => e.planId === plan.id && !e.staleAt);
  const ends = written
    .flatMap((e) => {
      const spec = buildCalendarEvents({
        medication,
        plan,
        showDetails: false,
        nowMs: Date.parse(e.exportedAt),
      }).find((s) => s.key === e.fingerprint);
      return spec ? [spec.windowEnd] : [];
    })
    .sort();
  const complete =
    expected.length > 0 &&
    expected.every((s) => written.some((e) => e.fingerprint === s.key));
  const expired = ends.length > 0 && ends[0]! < todayKey(nowMs);
  return {
    text: expired
      ? "日历添加记录的覆盖期限已结束"
      : complete
        ? "计划已保存，已请求添加手机日历"
        : written.length
          ? "计划已保存，日历仅添加了部分时间"
          : "计划已保存，尚未添加日历",
    coverage: ends.length
      ? `按添加记录估算${complete ? "覆盖" : "部分时间覆盖"}至 ${formatChineseDate(ends[0]!)}；实际提醒请在手机日历核对。`
      : "保存计划不会自动开启通知，需另行添加手机日历。",
    oldCalendarText,
    action: expired
      ? "查看日历设置"
      : complete
        ? "查看提醒设置"
        : written.length
          ? "继续添加日历"
          : "添加手机日历",
    hasFixedPlan: true,
  };
};
