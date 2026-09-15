import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {} from "../miniprogram/types/global";
import { RUNTIME_CONFIG } from "../miniprogram/config/runtime";
import { createDefaultSettings } from "../miniprogram/core/defaults";
import type * as CalendarModule from "../miniprogram/services/calendar";

const { openCalendarPermissionSettings } = vi.hoisted(() => ({
  openCalendarPermissionSettings:
    vi.fn<() => Promise<"system" | "miniprogram">>(),
}));

vi.mock("../miniprogram/services/calendar", async (importOriginal) => {
  const actual = await importOriginal<typeof CalendarModule>();
  return { ...actual, openCalendarPermissionSettings };
});

interface ReminderInstance {
  data: { openingSettings: boolean; calendarDenied: boolean };
  properties: {
    open: boolean;
    hasFixedPlan: boolean;
    calendarText: string;
    busy: boolean;
  };
  setData(values: Partial<ReminderInstance["data"]>): void;
  triggerEvent(this: void, name: string, detail?: unknown): void;
  refreshPermissionDisplay(): Promise<void>;
  close(): void;
  requestKind(event: WechatMiniprogram.BaseEvent): void;
  explainWechat(): Promise<void>;
  openCalendarSettings(): Promise<void>;
  writeCalendar(): void;
}

interface ComponentDefinition {
  data: ReminderInstance["data"];
  methods: Pick<
    ReminderInstance,
    | "refreshPermissionDisplay"
    | "close"
    | "requestKind"
    | "explainWechat"
    | "openCalendarSettings"
    | "writeCalendar"
  >;
}

interface ReminderPage {
  data: { reminderOpen: boolean; busy?: boolean };
  setData(values: Partial<ReminderPage["data"]>): void;
  openReminders(): void;
  closeReminders(): void;
}

const readSource = (path: string) =>
  readFileSync(resolve("miniprogram", path), "utf8");

async function mountReminder(
  properties: Partial<ReminderInstance["properties"]> = {},
) {
  let definition: ComponentDefinition | undefined;
  vi.stubGlobal("Component", (value: ComponentDefinition) => {
    definition = value;
  });
  await import("../miniprogram/components/reminder-settings/index");
  if (!definition) throw new Error("设置提醒组件未注册");
  const instance: ReminderInstance = {
    ...definition.methods,
    data: { ...definition.data },
    properties: {
      open: true,
      hasFixedPlan: false,
      calendarText: "",
      busy: false,
      ...properties,
    },
    setData(values) {
      Object.assign(this.data, values);
    },
    triggerEvent: vi.fn<(name: string, detail?: unknown) => void>(),
  };
  return instance;
}

const installWx = () => {
  const showModal = vi
    .fn<
      (options: {
        title: string;
        content: string;
        showCancel?: boolean;
      }) => Promise<{ confirm: boolean }>
    >()
    .mockResolvedValue({ confirm: true });
  const requestSubscribeMessage = vi.fn();
  const showToast = vi.fn();
  const addPhoneRepeatCalendar = vi.fn();
  const getLocation = vi.fn();
  vi.stubGlobal("wx", {
    showModal,
    requestSubscribeMessage,
    showToast,
    addPhoneRepeatCalendar,
    getLocation,
  });
  return {
    showModal,
    requestSubscribeMessage,
    showToast,
    addPhoneRepeatCalendar,
    getLocation,
  };
};

beforeEach(() => {
  openCalendarPermissionSettings.mockReset().mockResolvedValue("system");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("统一设置提醒", () => {
  it("微信列第一、日历列第二，分别点击配置且没有伪开关", () => {
    const markup = readSource("components/reminder-settings/index.wxml");
    const wechatIndex = markup.indexOf('bindtap="requestKind"');
    const calendarIndex = markup.indexOf('bindtap="openCalendarSettings"');
    expect(wechatIndex).toBeGreaterThan(-1);
    expect(calendarIndex).toBeGreaterThan(wechatIndex);
    expect(markup).toContain("微信提醒与手机日历互不影响，可分别设置");
    expect(markup).toContain('channel-title">服药时间');
    expect(markup).toContain('channel-title">药品到期');
    expect(markup).toContain('channel-title">余量不足');
    expect(markup).not.toContain("<switch");
    expect(markup).toContain('bindtap="writeCalendar"');
    expect(markup).toContain('wx:if="{{hasFixedPlan}}"');
  });

  it("权限显示只读取授权：缺失信息不误报拒绝，恢复授权后清除提示", async () => {
    installWx();
    const reminder = await mountReminder();
    await reminder.refreshPermissionDisplay();
    expect(reminder.data.calendarDenied).toBe(false);
    const getSetting = vi
      .fn()
      .mockResolvedValue({ authSetting: { "scope.addPhoneCalendar": false } });
    Object.assign(wx, { getSetting });
    await reminder.refreshPermissionDisplay();
    expect(reminder.data.calendarDenied).toBe(true);
    getSetting.mockResolvedValue({
      authSetting: { "scope.addPhoneCalendar": true },
    });
    await reminder.refreshPermissionDisplay();
    expect(reminder.data.calendarDenied).toBe(false);
  });

  it("分别点击提醒类别只请求对应授权事件", async () => {
    const wxMock = installWx();
    const reminder = await mountReminder({ hasFixedPlan: true });

    reminder.requestKind({
      currentTarget: { dataset: { kind: "dose" } },
    } as unknown as WechatMiniprogram.BaseEvent);

    expect(reminder.triggerEvent).toHaveBeenCalledExactlyOnceWith("request", {
      kind: "dose",
    });
    expect(wxMock.requestSubscribeMessage).not.toHaveBeenCalled();
    expect(wxMock.showToast).not.toHaveBeenCalled();
  });

  it("日历行直接调用授权跳转，不把查看权限当作写入日程", async () => {
    const wxMock = installWx();
    const reminder = await mountReminder({ hasFixedPlan: true });

    await reminder.openCalendarSettings();

    expect(openCalendarPermissionSettings).toHaveBeenCalledOnce();
    expect(reminder.data.openingSettings).toBe(false);
    expect(wxMock.addPhoneRepeatCalendar).not.toHaveBeenCalled();
    expect(wxMock.requestSubscribeMessage).not.toHaveBeenCalled();
    expect(wxMock.showToast).not.toHaveBeenCalled();
    expect(wxMock.showModal).not.toHaveBeenCalled();
    expect(reminder.triggerEvent).not.toHaveBeenCalled();
  });

  it("授权跳转失败可重试，并明确不是日历 App 内部设置", async () => {
    const wxMock = installWx();
    openCalendarPermissionSettings.mockRejectedValueOnce({ errMsg: "fail" });
    const reminder = await mountReminder();

    await reminder.openCalendarSettings();

    expect(reminder.data.openingSettings).toBe(false);
    const modal = wxMock.showModal.mock.calls[0]?.[0];
    expect(modal?.title).toBe("请在手机中设置日历权限");
    expect(modal?.content).toContain("小程序不能直接打开日历 App 的设置页");
    await reminder.openCalendarSettings();
    expect(openCalendarPermissionSettings).toHaveBeenCalledTimes(2);
    expect(wxMock.showToast).not.toHaveBeenCalled();
  });

  it("保留权限 helper 返回的具体错误说明", async () => {
    const wxMock = installWx();
    openCalendarPermissionSettings.mockRejectedValueOnce(
      new Error("请在手机设置中打开微信的日历权限。"),
    );
    const reminder = await mountReminder();

    await reminder.openCalendarSettings();

    expect(wxMock.showModal.mock.calls[0]?.[0].content).toBe(
      "请在手机设置中打开微信的日历权限。",
    );
    expect(reminder.data.openingSettings).toBe(false);
  });

  it("日历设置未返回前防止重复点击", async () => {
    installWx();
    let finish: ((target: "system") => void) | undefined;
    openCalendarPermissionSettings.mockImplementationOnce(
      () =>
        new Promise<"system">((resolveTarget) => {
          finish = resolveTarget;
        }),
    );
    const reminder = await mountReminder();
    const pending = reminder.openCalendarSettings();
    expect(reminder.data.openingSettings).toBe(true);
    await reminder.openCalendarSettings();
    expect(openCalendarPermissionSettings).toHaveBeenCalledOnce();
    if (!finish) throw new Error("权限设置未开始");
    finish("system");
    await pending;
    expect(reminder.data.openingSettings).toBe(false);
  });

  it("添加日程沿用现有事件，只有固定计划且空闲时允许，不附带微信授权", async () => {
    const wxMock = installWx();
    const reminder = await mountReminder();
    reminder.writeCalendar();
    expect(reminder.triggerEvent).not.toHaveBeenCalled();
    reminder.properties.hasFixedPlan = true;
    reminder.properties.busy = true;
    reminder.writeCalendar();
    expect(reminder.triggerEvent).not.toHaveBeenCalled();
    reminder.properties.busy = false;
    reminder.writeCalendar();
    expect(reminder.triggerEvent).toHaveBeenCalledExactlyOnceWith(
      "writecalendar",
    );
    expect(wxMock.requestSubscribeMessage).not.toHaveBeenCalled();
    expect(openCalendarPermissionSettings).not.toHaveBeenCalled();
  });

  it("写入期间保留弹层，空闲时可正常关闭", async () => {
    const reminder = await mountReminder({ busy: true });
    reminder.close();
    expect(reminder.triggerEvent).not.toHaveBeenCalled();
    reminder.properties.busy = false;
    reminder.close();
    expect(reminder.triggerEvent).toHaveBeenCalledExactlyOnceWith("close");
  });
});

describe("提醒入口与北京时间", () => {
  it.each(["settings", "medicine-detail"] as const)(
    "%s 页面注册共享组件并可开关设置提醒",
    async (pageName) => {
      let page: ReminderPage | undefined;
      vi.stubGlobal("Page", (definition: ReminderPage) => {
        page = Object.assign(definition, {
          setData(values: Partial<ReminderPage["data"]>) {
            Object.assign(definition.data, values);
          },
        });
      });
      if (pageName === "settings")
        await import("../miniprogram/pages/settings/index");
      else await import("../miniprogram/pages/medicine-detail/index");
      if (!page) throw new Error("提醒入口页面未注册");

      expect(page.data.reminderOpen).toBe(false);
      page.openReminders();
      expect(page.data.reminderOpen).toBe(true);
      page.closeReminders();
      expect(page.data.reminderOpen).toBe(false);
      const markup = readSource(`pages/${pageName}/index.wxml`);
      expect(markup).toContain('bindtap="openReminders"');
      expect(markup).toContain('<reminder-settings open="{{reminderOpen}}"');
      expect(markup).toContain('bindclose="closeReminders"');
      expect(readSource(`pages/${pageName}/index.json`)).toContain(
        '"reminder-settings": "/components/reminder-settings/index"',
      );
      if (pageName === "medicine-detail") {
        expect(markup).toContain('has-fixed-plan="{{view.hasFixedPlan}}"');
        expect(markup).toContain('bindwritecalendar="addCalendar"');
      } else {
        expect(markup).not.toContain("onLowFrequencyChange");
      }
    },
  );

  it("设置与弹层统一北京时间 UTC+8，不因打开提醒申请定位", async () => {
    const wxMock = installWx();
    const reminder = await mountReminder();
    await reminder.openCalendarSettings();
    await reminder.explainWechat();
    expect(RUNTIME_CONFIG.timezone).toBe("Asia/Shanghai");
    expect(RUNTIME_CONFIG.timezoneOffsetMinutes).toBe(480);
    expect(createDefaultSettings().timezone).toBe("Asia/Shanghai");
    expect(readSource("pages/settings/index.wxml")).toContain(
      "时区：中国北京时间（UTC+8）",
    );
    expect(readSource("components/reminder-settings/index.wxml")).toContain(
      "时区：北京时间 GMT+8",
    );
    expect(wxMock.getLocation).not.toHaveBeenCalled();
  });
});
