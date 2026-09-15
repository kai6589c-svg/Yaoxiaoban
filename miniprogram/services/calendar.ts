import { RUNTIME_CONFIG } from "../config/runtime";
import { addDays, dayOfWeek, localDateTimeToMs, todayKey } from "../core/dates";
import { resolveExpiry } from "../core/expiry";
import type { Medication, PlanVersion } from "../core/models";
import { calendarFingerprint } from "./calendar-fingerprint";

export { calendarFingerprint } from "./calendar-fingerprint";

export interface CalendarEventSpec {
  key: string;
  firstDate: string;
  time: string;
  weekday: number | null;
  windowStart: string;
  windowEnd: string;
  eventTitle: string;
}

export interface CalendarWriteResult {
  success: boolean;
  status: "success" | "partial" | "failed" | "noop" | "ended";
  eventTitle: string;
  writtenKeys: string[];
  skippedKeys: string[];
  failedKeys: string[];
  trackingFailedKeys?: string[];
  reason?: "unsupported" | "denied" | "failed" | "ended" | "tracking-failed";
  permissionTarget?: CalendarPermissionTarget;
}

export type CalendarPermissionTarget = "miniprogram" | "system" | "unknown";

interface WechatCalendarError {
  message?: string;
  errMsg?: string;
  errno?: number;
  errCode?: number;
}

const maxDate = (left: string, right: string): string =>
  left > right ? left : right;
const minDate = (left: string, right: string): string =>
  left < right ? left : right;

const LOCAL_CALENDAR_LEDGER_KEY = "yxb_calendar_written_v1";
const CALENDAR_EVENT_DURATION_SECONDS = 60;

const readLocalCalendarLedger = (): Set<string> => {
  try {
    if (typeof wx.getStorageSync !== "function") return new Set();
    const value: unknown = wx.getStorageSync(LOCAL_CALENDAR_LEDGER_KEY);
    if (!Array.isArray(value)) return new Set();
    return new Set(
      value.filter(
        (item): item is string =>
          typeof item === "string" && item.length <= 240,
      ),
    );
  } catch {
    return new Set();
  }
};

const rememberLocalCalendarWrite = (fingerprint: string): void => {
  try {
    if (typeof wx.setStorageSync !== "function") return;
    const ledger = readLocalCalendarLedger();
    ledger.add(fingerprint);
    wx.setStorageSync(LOCAL_CALENDAR_LEDGER_KEY, [...ledger].slice(-500));
  } catch {
    // The server ledger remains the primary source when local storage is full
    // or unavailable.
  }
};

const firstWeekdayOnOrAfter = (date: string, targetWeekday: number): string => {
  let candidate = date;
  for (let offset = 0; offset < 7; offset += 1) {
    if (dayOfWeek(candidate) === targetWeekday) return candidate;
    candidate = addDays(candidate, 1);
  }
  return candidate;
};

export const buildCalendarEvents = (args: {
  medication: Medication;
  plan: PlanVersion;
  showDetails: boolean;
  nowMs?: number;
}): CalendarEventSpec[] => {
  const { medication, plan, showDetails } = args;
  if (plan.scheduleType === "as_needed" || !plan.times.length) return [];
  const nowMs = args.nowMs ?? Date.now();
  const today = todayKey(nowMs);
  const start = maxDate(today, plan.startDate);
  const horizonEnd = addDays(start, RUNTIME_CONFIG.calendarHorizonDays - 1);
  const planEnd = plan.endDate ? minDate(plan.endDate, horizonEnd) : horizonEnd;
  const end = minDate(planEnd, resolveExpiry(medication).effectiveExpiryDate);
  if (start > end) return [];
  const eventTitle = showDetails ? `服用${medication.name}` : "药小伴服药提醒";
  const specs: CalendarEventSpec[] = [];

  if (plan.scheduleType === "daily") {
    for (const time of plan.times) {
      const firstDate =
        start === today && localDateTimeToMs(start, time) <= nowMs
          ? addDays(start, 1)
          : start;
      if (firstDate > end) continue;
      specs.push({
        key: calendarFingerprint({
          medicationId: medication.id,
          planId: plan.id,
          weekday: null,
          time,
        }),
        firstDate,
        time,
        weekday: null,
        windowStart: firstDate,
        windowEnd: end,
        eventTitle,
      });
    }
  } else {
    for (const weekday of plan.weekdays) {
      const firstDate = firstWeekdayOnOrAfter(start, weekday);
      for (const time of plan.times) {
        const futureFirstDate =
          firstDate === today && localDateTimeToMs(firstDate, time) <= nowMs
            ? addDays(firstDate, 7)
            : firstDate;
        if (futureFirstDate > end) continue;
        specs.push({
          key: calendarFingerprint({
            medicationId: medication.id,
            planId: plan.id,
            weekday,
            time,
          }),
          firstDate: futureFirstDate,
          time,
          weekday,
          windowStart: futureFirstDate,
          windowEnd: end,
          eventTitle,
        });
      }
    }
  }
  return specs;
};

const calendarApiSupported = (api: string): boolean => {
  try {
    return typeof wx.canIUse === "function" && wx.canIUse(api);
  } catch {
    return false;
  }
};

const deniedCalendarPermission = async (): Promise<Exclude<
  CalendarPermissionTarget,
  "unknown"
> | null> => {
  try {
    const setting = await wx.getSetting();
    if (setting.authSetting?.["scope.addPhoneCalendar"] === false)
      return "miniprogram";
  } catch {
    // Older clients may not expose the mini-program permission result.
  }
  try {
    if (
      typeof wx.getAppAuthorizeSetting === "function" &&
      wx.getAppAuthorizeSetting().phoneCalendarAuthorized === "denied"
    )
      return "system";
  } catch {
    // A missing system-permission API does not imply permission was denied.
  }
  return null;
};

const classifyCalendarFailure = async (
  error: unknown,
): Promise<{
  reason: "unsupported" | "denied" | "failed";
  permissionTarget?: CalendarPermissionTarget;
}> => {
  const details =
    error && typeof error === "object" ? (error as WechatCalendarError) : {};
  const message = details.errMsg ?? details.message ?? "";
  if (/not\s*support|unsupported|不支持/i.test(message))
    return { reason: "unsupported" };
  const permissionTarget = await deniedCalendarPermission();
  if (permissionTarget) return { reason: "denied", permissionTarget };
  if (/deny|denied|auth|permission|未授权|拒绝|权限/i.test(message))
    return { reason: "denied", permissionTarget: "unknown" };
  return { reason: "failed" };
};

export const writePlanToCalendar = async (args: {
  medication: Medication;
  plan: PlanVersion;
  showDetails: boolean;
  knownFingerprints?: readonly string[];
  onEventWritten?: (event: CalendarEventSpec) => Promise<void>;
}): Promise<CalendarWriteResult> => {
  const eventTitle = args.showDetails
    ? `服用${args.medication.name}`
    : "药小伴服药提醒";
  const specs = buildCalendarEvents(args);
  if (!specs.length) {
    const today = todayKey();
    const hasFixedSlots =
      args.plan.times.length > 0 &&
      (args.plan.scheduleType === "daily" ||
        (args.plan.scheduleType === "weekly" && args.plan.weekdays.length > 0));
    // A valid fixed schedule with no generated events has no remaining
    // occurrence inside its plan/expiry limits, including a final time that
    // has already passed today. This is not a platform capability failure.
    const ended =
      hasFixedSlots ||
      (args.plan.endDate !== null && args.plan.endDate < today) ||
      resolveExpiry(args.medication).effectiveExpiryDate < today;
    return {
      success: false,
      status: ended ? "ended" : "failed",
      eventTitle,
      writtenKeys: [],
      skippedKeys: [],
      failedKeys: [],
      reason: ended ? "ended" : "unsupported",
    };
  }
  if (
    !calendarApiSupported("addPhoneRepeatCalendar") ||
    typeof wx.addPhoneRepeatCalendar !== "function"
  ) {
    return {
      success: false,
      status: "failed",
      eventTitle,
      writtenKeys: [],
      skippedKeys: [],
      failedKeys: specs.map((item) => item.key),
      reason: "unsupported",
    };
  }

  const serverKnown = new Set(args.knownFingerprints ?? []);
  const localKnown = readLocalCalendarLedger();
  const known = new Set([...serverKnown, ...localKnown]);
  const skippedKeys = specs
    .filter((item) => known.has(item.key))
    .map((item) => item.key);
  const pending = specs.filter((item) => !known.has(item.key));
  const trackingFailedKeys: string[] = [];
  for (const event of specs) {
    if (!localKnown.has(event.key) || serverKnown.has(event.key)) continue;
    try {
      await args.onEventWritten?.(event);
    } catch {
      trackingFailedKeys.push(event.key);
    }
  }
  if (!pending.length) {
    return {
      success: trackingFailedKeys.length === 0,
      status: trackingFailedKeys.length ? "partial" : "noop",
      eventTitle,
      writtenKeys: [],
      skippedKeys,
      failedKeys: [],
      ...(trackingFailedKeys.length ? { trackingFailedKeys } : {}),
      ...(trackingFailedKeys.length
        ? { reason: "tracking-failed" as const }
        : {}),
    };
  }

  const writtenKeys: string[] = [];
  const failedKeys: string[] = [];
  let failure: Awaited<ReturnType<typeof classifyCalendarFailure>> | undefined;
  for (const [index, event] of pending.entries()) {
    try {
      const startTime = Math.floor(
        localDateTimeToMs(event.firstDate, event.time) / 1000,
      );
      await wx.addPhoneRepeatCalendar({
        title: event.eventTitle,
        startTime,
        // Give the reminder a positive event interval; the alarm remains at
        // the exact planned time. The API typings specify a string endTime.
        endTime: String(startTime + CALENDAR_EVENT_DURATION_SECONDS),
        description: args.showDetails
          ? `${args.medication.name}；用量以你在药小伴中记录的内容为准。`
          : "打开药小伴查看本次记录。",
        alarm: true,
        alarmOffset: 0,
        repeatInterval: event.weekday === null ? "day" : "week",
        repeatEndTime: Math.floor(
          localDateTimeToMs(event.windowEnd, "23:59") / 1000,
        ),
      });
      // Persist before the server callback. If that callback or its response
      // fails, a later retry reconciles the ledger without writing a duplicate
      // system-calendar event on this device.
      rememberLocalCalendarWrite(event.key);
      writtenKeys.push(event.key);
    } catch (error) {
      failedKeys.push(event.key);
      failure = await classifyCalendarFailure(error);
      if (failure.reason !== "failed") {
        // Permission or platform failures apply to every remaining slot.
        // Avoid repeatedly opening the same failing native permission flow.
        failedKeys.push(...pending.slice(index + 1).map((item) => item.key));
        break;
      }
      continue;
    }
    try {
      await args.onEventWritten?.(event);
    } catch {
      trackingFailedKeys.push(event.key);
    }
  }

  const status =
    failedKeys.length || trackingFailedKeys.length
      ? writtenKeys.length
        ? "partial"
        : "failed"
      : "success";
  return {
    success: status === "success",
    status,
    eventTitle,
    writtenKeys,
    skippedKeys,
    failedKeys,
    ...(trackingFailedKeys.length ? { trackingFailedKeys } : {}),
    ...(failure?.permissionTarget
      ? { permissionTarget: failure.permissionTarget }
      : {}),
    reason: failedKeys.length
      ? (failure?.reason ?? "failed")
      : trackingFailedKeys.length
        ? "tracking-failed"
        : undefined,
  };
};

export const openCalendarPermissionSettings = async (): Promise<
  Exclude<CalendarPermissionTarget, "unknown">
> => {
  const deniedTarget = await deniedCalendarPermission();
  if (deniedTarget === "miniprogram") {
    if (
      !calendarApiSupported("openSetting") ||
      typeof wx.openSetting !== "function"
    )
      throw new Error("当前微信无法打开小程序日历权限设置，请更新微信后重试。");
    await wx.openSetting();
    return "miniprogram";
  }
  if (
    !calendarApiSupported("openAppAuthorizeSetting") ||
    typeof wx.openAppAuthorizeSetting !== "function"
  )
    throw new Error(
      "当前微信无法跳转系统授权设置，请在手机设置中打开微信的日历权限。",
    );
  // This opens the system's WeChat permissions, not the Calendar app itself.
  await wx.openAppAuthorizeSetting();
  return "system";
};

export const clearLocalCalendarLedger = (): void => {
  try {
    wx.removeStorageSync(LOCAL_CALENDAR_LEDGER_KEY);
  } catch {
    // Account deletion must continue even when local storage is unavailable.
  }
};
