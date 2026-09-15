import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildCalendarEvents,
  openCalendarPermissionSettings,
  writePlanToCalendar,
  type CalendarEventSpec,
} from "../miniprogram/services/calendar";
import type { Medication, PlanVersion } from "../miniprogram/core/models";

type CalendarOption = Parameters<typeof wx.addPhoneRepeatCalendar>[0];

const NOW_MS = Date.parse("2026-08-19T04:00:00.000Z");

const makeMedication = (patch: Partial<Medication> = {}): Medication => ({
  id: "med-1",
  profileId: "profile-1",
  name: "缬沙坦片",
  specification: "80mg",
  unit: "片",
  mode: "scheduled",
  expiryPrecision: "day",
  expiryValue: "2027-12-31",
  openedDate: null,
  afterOpenDays: null,
  note: "",
  photo: null,
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: 1,
  ...patch,
});

const makePlan = (patch: Partial<PlanVersion> = {}): PlanVersion => ({
  id: "plan-1",
  medicationId: "med-1",
  scheduleType: "daily",
  startDate: "2026-01-01",
  endDate: null,
  weekdays: [],
  times: ["08:00"],
  doseMilli: 1000,
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  effectiveTo: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  version: 1,
  ...patch,
});

const installWxMock = (supported = true) => {
  const storage = new Map<string, unknown>();
  const canIUse = vi
    .fn<(schema: string) => boolean>()
    .mockReturnValue(supported);
  const addPhoneRepeatCalendar =
    vi.fn<(option: CalendarOption) => Promise<unknown>>();
  const getSetting = vi
    .fn<() => Promise<{ authSetting: Record<string, boolean> }>>()
    .mockResolvedValue({ authSetting: { "scope.addPhoneCalendar": true } });
  const openSetting = vi.fn<() => Promise<unknown>>().mockResolvedValue({});
  const getAppAuthorizeSetting = vi
    .fn<
      () => {
        phoneCalendarAuthorized: "authorized" | "denied" | "not determined";
      }
    >()
    .mockReturnValue({ phoneCalendarAuthorized: "authorized" });
  const openAppAuthorizeSetting = vi
    .fn<() => Promise<unknown>>()
    .mockResolvedValue({});

  vi.stubGlobal("wx", {
    canIUse,
    addPhoneRepeatCalendar,
    getSetting,
    openSetting,
    getAppAuthorizeSetting,
    openAppAuthorizeSetting,
    getStorageSync: (key: string) => storage.get(key),
    setStorageSync: (key: string, value: unknown) => storage.set(key, value),
    removeStorageSync: (key: string) => storage.delete(key),
  });

  return {
    canIUse,
    addPhoneRepeatCalendar,
    getSetting,
    openSetting,
    getAppAuthorizeSetting,
    openAppAuthorizeSetting,
    storage,
  };
};

describe("手机日历导出", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("已经开始的计划从今天起建立包含首尾的 90 天窗口", () => {
    const events = buildCalendarEvents({
      medication: makeMedication(),
      plan: makePlan({ startDate: "2026-01-01", times: ["08:00", "20:00"] }),
      showDetails: false,
      nowMs: NOW_MS,
    });

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.windowStart)).toEqual([
      "2026-08-20",
      "2026-08-19",
    ]);
    expect(events.map((event) => event.windowEnd)).toEqual([
      "2026-11-16",
      "2026-11-16",
    ]);
    expect(events.map((event) => event.firstDate)).toEqual([
      "2026-08-20",
      "2026-08-19",
    ]);
  });

  it("每日计划为每个时间生成与滚动窗口和标题无关的稳定事件键", () => {
    const events = buildCalendarEvents({
      medication: makeMedication(),
      plan: makePlan({ times: ["08:00", "20:00"] }),
      showDetails: false,
      nowMs: NOW_MS,
    });

    expect(events.map((event) => event.key)).toEqual([
      "med-1|plan-1|daily|08:00",
      "med-1|plan-1|daily|20:00",
    ]);
    expect(events.map((event) => event.weekday)).toEqual([null, null]);
  });

  it("指定星期计划为每个星期与时间生成独立事件键", () => {
    const events = buildCalendarEvents({
      medication: makeMedication(),
      plan: makePlan({
        scheduleType: "weekly",
        weekdays: [3, 7],
        times: ["08:00", "20:00"],
      }),
      showDetails: true,
      nowMs: NOW_MS,
    });

    expect(events.map((event) => event.key)).toEqual([
      "med-1|plan-1|weekday-3|08:00",
      "med-1|plan-1|weekday-3|20:00",
      "med-1|plan-1|weekday-7|08:00",
      "med-1|plan-1|weekday-7|20:00",
    ]);
    expect(events.map((event) => event.firstDate)).toEqual([
      "2026-08-26",
      "2026-08-19",
      "2026-08-23",
      "2026-08-23",
    ]);
    expect(events.map((event) => event.weekday)).toEqual([3, 3, 7, 7]);
  });

  it("隔天重试与隐私标题切换不会改变同一计划槽位的事件键", () => {
    const firstRun = buildCalendarEvents({
      medication: makeMedication(),
      plan: makePlan({ times: ["08:00", "20:00"] }),
      showDetails: false,
      nowMs: NOW_MS,
    });
    const nextDayDetailed = buildCalendarEvents({
      medication: makeMedication(),
      plan: makePlan({ times: ["08:00", "20:00"] }),
      showDetails: true,
      nowMs: NOW_MS + 24 * 60 * 60 * 1000,
    });

    expect(nextDayDetailed.map((event) => event.key)).toEqual(
      firstRun.map((event) => event.key),
    );
    expect(nextDayDetailed[0]?.windowEnd).not.toBe(firstRun[0]?.windowEnd);
    expect(nextDayDetailed[0]?.eventTitle).not.toBe(firstRun[0]?.eventTitle);
  });

  it("以实际管理到期日截止重复日历事件", () => {
    const events = buildCalendarEvents({
      medication: makeMedication({
        expiryValue: "2026-12-31",
        openedDate: "2026-08-19",
        afterOpenDays: 3,
      }),
      plan: makePlan({ times: ["08:00", "20:00"] }),
      showDetails: false,
      nowMs: NOW_MS,
    });

    expect(events.map((event) => event.windowEnd)).toEqual([
      "2026-08-21",
      "2026-08-21",
    ]);
    expect(events.map((event) => event.firstDate)).toEqual([
      "2026-08-20",
      "2026-08-19",
    ]);
  });

  it("计划已结束时不调用微信日历 API", async () => {
    const wxMock = installWxMock();

    const result = await writePlanToCalendar({
      medication: makeMedication(),
      plan: makePlan({ endDate: "2026-08-18" }),
      showDetails: false,
    });

    expect(result).toMatchObject({
      success: false,
      status: "ended",
      reason: "ended",
      writtenKeys: [],
      skippedKeys: [],
      failedKeys: [],
    });
    expect(wxMock.canIUse).not.toHaveBeenCalled();
    expect(wxMock.addPhoneRepeatCalendar).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "今天是计划最后一天且所有时间已过",
      medication: makeMedication(),
      plan: makePlan({ endDate: "2026-08-19", times: ["08:00"] }),
    },
    {
      name: "今天是药盒最后有效日且所有时间已过",
      medication: makeMedication({ expiryValue: "2026-08-19" }),
      plan: makePlan({ times: ["08:00"] }),
    },
    {
      name: "当前时刻恰好等于最后一次提醒时间",
      medication: makeMedication(),
      plan: makePlan({ endDate: "2026-08-19", times: ["12:00"] }),
    },
    {
      name: "指定星期的最后一次提醒已过且下次超出计划日期",
      medication: makeMedication(),
      plan: makePlan({
        scheduleType: "weekly",
        weekdays: [3],
        endDate: "2026-08-20",
        times: ["08:00"],
      }),
    },
  ])("$name 时返回 ended 而非 unsupported", async ({ medication, plan }) => {
    const wxMock = installWxMock();

    const result = await writePlanToCalendar({
      medication,
      plan,
      showDetails: false,
    });

    expect(result).toMatchObject({
      success: false,
      status: "ended",
      reason: "ended",
      writtenKeys: [],
      skippedKeys: [],
      failedKeys: [],
    });
    expect(wxMock.canIUse).not.toHaveBeenCalled();
    expect(wxMock.addPhoneRepeatCalendar).not.toHaveBeenCalled();
  });

  it("计划最后一天仍有未来时间时只写入剩余提醒，不误判结束", async () => {
    const wxMock = installWxMock();
    wxMock.addPhoneRepeatCalendar.mockResolvedValue({
      errMsg: "addPhoneRepeatCalendar:ok",
    });

    const result = await writePlanToCalendar({
      medication: makeMedication({ expiryValue: "2026-08-19" }),
      plan: makePlan({ endDate: "2026-08-19", times: ["08:00", "20:00"] }),
      showDetails: false,
    });

    expect(result).toMatchObject({
      success: true,
      status: "success",
      writtenKeys: ["med-1|plan-1|daily|20:00"],
    });
    expect(wxMock.addPhoneRepeatCalendar).toHaveBeenCalledOnce();
  });

  it("跳过已成功事件，仅写入尚未成功的事件", async () => {
    const wxMock = installWxMock();
    wxMock.addPhoneRepeatCalendar.mockResolvedValue({
      errMsg: "addPhoneRepeatCalendar:ok",
    });
    const plan = makePlan({ times: ["08:00", "20:00"] });
    const specs = buildCalendarEvents({
      medication: makeMedication(),
      plan,
      showDetails: false,
      nowMs: NOW_MS,
    });
    const onEventWritten = vi
      .fn<(event: CalendarEventSpec) => Promise<void>>()
      .mockResolvedValue(undefined);

    const result = await writePlanToCalendar({
      medication: makeMedication(),
      plan,
      showDetails: false,
      knownFingerprints: [specs[0]!.key],
      onEventWritten,
    });

    expect(result).toEqual({
      success: true,
      status: "success",
      eventTitle: "药小伴服药提醒",
      writtenKeys: [specs[1]!.key],
      skippedKeys: [specs[0]!.key],
      failedKeys: [],
      reason: undefined,
    });
    expect(wxMock.addPhoneRepeatCalendar).toHaveBeenCalledTimes(1);
    expect(wxMock.addPhoneRepeatCalendar).toHaveBeenCalledWith(
      expect.objectContaining({ repeatInterval: "day" }),
    );
    expect(onEventWritten).toHaveBeenCalledOnce();
    expect(onEventWritten).toHaveBeenCalledWith(specs[1]);
  });

  it("多事件中途失败时返回 partial 并保留已写入事件键", async () => {
    const wxMock = installWxMock();
    wxMock.addPhoneRepeatCalendar
      .mockResolvedValueOnce({ errMsg: "addPhoneRepeatCalendar:ok" })
      .mockRejectedValueOnce({
        errMsg: "addPhoneRepeatCalendar:fail system error",
      });
    const onEventWritten = vi
      .fn<(event: CalendarEventSpec) => Promise<void>>()
      .mockResolvedValue(undefined);
    const plan = makePlan({ times: ["08:00", "20:00"] });
    const specs = buildCalendarEvents({
      medication: makeMedication(),
      plan,
      showDetails: false,
      nowMs: NOW_MS,
    });

    const result = await writePlanToCalendar({
      medication: makeMedication(),
      plan,
      showDetails: false,
      onEventWritten,
    });

    expect(result).toMatchObject({
      success: false,
      status: "partial",
      writtenKeys: [specs[0]!.key],
      skippedKeys: [],
      failedKeys: [specs[1]!.key],
      reason: "failed",
    });
    expect(wxMock.addPhoneRepeatCalendar).toHaveBeenCalledTimes(2);
    expect(onEventWritten).toHaveBeenCalledOnce();
    expect(onEventWritten).toHaveBeenCalledWith(specs[0]);
  });

  it("日历时间固定按北京时间转换，事件保留一分钟正时长", async () => {
    const wxMock = installWxMock();
    wxMock.addPhoneRepeatCalendar.mockResolvedValue({
      errMsg: "addPhoneRepeatCalendar:ok",
    });

    await writePlanToCalendar({
      medication: makeMedication(),
      plan: makePlan({ times: ["08:00", "20:00"] }),
      showDetails: false,
    });

    const options = wxMock.addPhoneRepeatCalendar.mock.calls.map(
      ([option]) => option,
    );
    expect(options.map((option) => option.startTime)).toEqual([
      Date.parse("2026-08-20T00:00:00.000Z") / 1000,
      Date.parse("2026-08-19T12:00:00.000Z") / 1000,
    ]);
    for (const option of options) {
      expect(Number(option.endTime) - option.startTime).toBe(60);
      expect(option.alarmOffset).toBe(0);
      expect(option.repeatEndTime).toBe(
        Date.parse("2026-11-16T15:59:00.000Z") / 1000,
      );
    }
  });

  it("系统日历已写入但服务端台账失败时，重试只补台账不重复写事件", async () => {
    const wxMock = installWxMock();
    wxMock.addPhoneRepeatCalendar.mockResolvedValue({
      errMsg: "addPhoneRepeatCalendar:ok",
    });
    const plan = makePlan({ times: ["08:00"] });
    const firstLedger = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error("ledger unavailable"));

    const first = await writePlanToCalendar({
      medication: makeMedication(),
      plan,
      showDetails: false,
      onEventWritten: firstLedger,
    });
    expect(first).toMatchObject({
      success: false,
      status: "partial",
      reason: "tracking-failed",
      writtenKeys: ["med-1|plan-1|daily|08:00"],
      trackingFailedKeys: ["med-1|plan-1|daily|08:00"],
    });

    const repairedLedger = vi.fn<() => Promise<void>>().mockResolvedValue();
    const second = await writePlanToCalendar({
      medication: makeMedication(),
      plan,
      showDetails: false,
      onEventWritten: repairedLedger,
    });

    expect(second).toMatchObject({
      success: true,
      status: "noop",
      writtenKeys: [],
      skippedKeys: ["med-1|plan-1|daily|08:00"],
    });
    expect(wxMock.addPhoneRepeatCalendar).toHaveBeenCalledTimes(1);
    expect(repairedLedger).toHaveBeenCalledOnce();
  });

  it("微信权限设置显示已拒绝时返回 denied", async () => {
    const wxMock = installWxMock();
    wxMock.addPhoneRepeatCalendar.mockRejectedValue({
      errMsg: "addPhoneRepeatCalendar:fail",
    });
    wxMock.getSetting.mockResolvedValue({
      authSetting: { "scope.addPhoneCalendar": false },
    });

    const result = await writePlanToCalendar({
      medication: makeMedication(),
      plan: makePlan(),
      showDetails: false,
    });

    expect(result).toMatchObject({
      success: false,
      status: "failed",
      reason: "denied",
      permissionTarget: "miniprogram",
    });
    expect(wxMock.getSetting).toHaveBeenCalledOnce();
  });

  it("系统微信日历权限拒绝与小程序授权拒绝分别返回", async () => {
    const wxMock = installWxMock();
    wxMock.addPhoneRepeatCalendar.mockRejectedValue({
      errMsg: "addPhoneRepeatCalendar:fail",
    });
    wxMock.getAppAuthorizeSetting.mockReturnValue({
      phoneCalendarAuthorized: "denied",
    });

    const result = await writePlanToCalendar({
      medication: makeMedication(),
      plan: makePlan({ times: ["08:00", "20:00"] }),
      showDetails: false,
    });

    expect(result).toMatchObject({
      success: false,
      status: "failed",
      reason: "denied",
      permissionTarget: "system",
      failedKeys: ["med-1|plan-1|daily|08:00", "med-1|plan-1|daily|20:00"],
    });
    expect(wxMock.addPhoneRepeatCalendar).toHaveBeenCalledOnce();
  });

  it("无法查询权限时保留拒绝原因但不猜测拒绝层级", async () => {
    const wxMock = installWxMock();
    wxMock.addPhoneRepeatCalendar.mockRejectedValue({
      errMsg: "addPhoneRepeatCalendar:fail auth deny",
    });
    wxMock.getSetting.mockRejectedValue(new Error("unavailable"));
    wxMock.getAppAuthorizeSetting.mockImplementation(() => {
      throw new Error("unavailable");
    });

    const result = await writePlanToCalendar({
      medication: makeMedication(),
      plan: makePlan(),
      showDetails: false,
    });

    expect(result).toMatchObject({
      reason: "denied",
      permissionTarget: "unknown",
    });
  });

  it("基础库不支持重复日历时返回 unsupported 且列出未写入事件", async () => {
    const wxMock = installWxMock(false);
    const plan = makePlan({ times: ["08:00", "20:00"] });
    const specs = buildCalendarEvents({
      medication: makeMedication(),
      plan,
      showDetails: false,
      nowMs: NOW_MS,
    });

    const result = await writePlanToCalendar({
      medication: makeMedication(),
      plan,
      showDetails: false,
    });

    expect(result).toMatchObject({
      success: false,
      status: "failed",
      reason: "unsupported",
      writtenKeys: [],
      skippedKeys: [],
      failedKeys: specs.map((event) => event.key),
    });
    expect(wxMock.addPhoneRepeatCalendar).not.toHaveBeenCalled();
  });

  it("接口存在但运行平台不支持时仍返回 unsupported，且不反复调用", async () => {
    const wxMock = installWxMock();
    wxMock.addPhoneRepeatCalendar.mockRejectedValue({
      errMsg: "addPhoneRepeatCalendar:fail not supported on this platform",
    });

    const result = await writePlanToCalendar({
      medication: makeMedication(),
      plan: makePlan({ times: ["08:00", "20:00"] }),
      showDetails: false,
    });

    expect(result).toMatchObject({
      success: false,
      status: "failed",
      reason: "unsupported",
      failedKeys: ["med-1|plan-1|daily|08:00", "med-1|plan-1|daily|20:00"],
    });
    expect(wxMock.addPhoneRepeatCalendar).toHaveBeenCalledOnce();
    expect(wxMock.getSetting).not.toHaveBeenCalled();
  });

  it("小程序日历权限被明确拒绝时打开小程序授权页", async () => {
    const wxMock = installWxMock();
    wxMock.getSetting.mockResolvedValue({
      authSetting: { "scope.addPhoneCalendar": false },
    });

    await expect(openCalendarPermissionSettings()).resolves.toBe("miniprogram");

    expect(wxMock.openSetting).toHaveBeenCalledOnce();
    expect(wxMock.openAppAuthorizeSetting).not.toHaveBeenCalled();
    expect(wxMock.addPhoneRepeatCalendar).not.toHaveBeenCalled();
  });

  it("系统日历权限被拒绝时打开系统微信授权管理页", async () => {
    const wxMock = installWxMock();
    wxMock.getAppAuthorizeSetting.mockReturnValue({
      phoneCalendarAuthorized: "denied",
    });

    await expect(openCalendarPermissionSettings()).resolves.toBe("system");

    expect(wxMock.openAppAuthorizeSetting).toHaveBeenCalledOnce();
    expect(wxMock.openSetting).not.toHaveBeenCalled();
    expect(wxMock.addPhoneRepeatCalendar).not.toHaveBeenCalled();
  });

  it("默认直接前往系统微信授权页，不把查看设置当作写入成功", async () => {
    const wxMock = installWxMock();

    await expect(openCalendarPermissionSettings()).resolves.toBe("system");

    expect(wxMock.openAppAuthorizeSetting).toHaveBeenCalledOnce();
    expect(wxMock.openSetting).not.toHaveBeenCalled();
    expect(wxMock.addPhoneRepeatCalendar).not.toHaveBeenCalled();
    expect(wxMock.storage.size).toBe(0);
  });

  it("未曾请求系统授权时仍允许查看设置，不假定已经获得日历权限", async () => {
    const wxMock = installWxMock();
    wxMock.getAppAuthorizeSetting.mockReturnValue({
      phoneCalendarAuthorized: "not determined",
    });

    await expect(openCalendarPermissionSettings()).resolves.toBe("system");

    expect(wxMock.openAppAuthorizeSetting).toHaveBeenCalledOnce();
    expect(wxMock.addPhoneRepeatCalendar).not.toHaveBeenCalled();
  });

  it("系统授权跳转不支持时返回可操作说明，不回退到错误的权限页", async () => {
    const wxMock = installWxMock();
    wxMock.canIUse.mockImplementation(
      (api) => api !== "openAppAuthorizeSetting",
    );

    await expect(openCalendarPermissionSettings()).rejects.toThrow(
      "请在手机设置中打开微信的日历权限",
    );

    expect(wxMock.openAppAuthorizeSetting).not.toHaveBeenCalled();
    expect(wxMock.openSetting).not.toHaveBeenCalled();
  });

  it("小程序授权跳转不支持时不误开系统权限页", async () => {
    const wxMock = installWxMock();
    wxMock.getSetting.mockResolvedValue({
      authSetting: { "scope.addPhoneCalendar": false },
    });
    wxMock.canIUse.mockImplementation((api) => api !== "openSetting");

    await expect(openCalendarPermissionSettings()).rejects.toThrow(
      "当前微信无法打开小程序日历权限设置",
    );

    expect(wxMock.openSetting).not.toHaveBeenCalled();
    expect(wxMock.openAppAuthorizeSetting).not.toHaveBeenCalled();
  });
});
