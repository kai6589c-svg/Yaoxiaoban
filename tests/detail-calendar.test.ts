import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {} from "../miniprogram/types/global";
import type { AppState, CalendarExport } from "../miniprogram/core/models";
import type * as CalendarModule from "../miniprogram/services/calendar";
import type { CalendarWriteResult } from "../miniprogram/services/calendar";
import { appState } from "./fixtures";

const { openCalendarPermissionSettings, writePlanToCalendar } = vi.hoisted(
  () => ({
    openCalendarPermissionSettings:
      vi.fn<typeof CalendarModule.openCalendarPermissionSettings>(),
    writePlanToCalendar: vi.fn<typeof CalendarModule.writePlanToCalendar>(),
  }),
);

vi.mock("../miniprogram/services/calendar", async (importOriginal) => {
  const actual = await importOriginal<typeof CalendarModule>();
  return { ...actual, openCalendarPermissionSettings, writePlanToCalendar };
});

interface DetailCalendarPage {
  data: { medicationId: string; busy: boolean };
  setData(values: Partial<DetailCalendarPage["data"]>): void;
  loadData: () => Promise<void>;
  addCalendar(): Promise<void>;
}

const result = (
  overrides: Partial<CalendarWriteResult> = {},
): CalendarWriteResult => ({
  success: true,
  status: "success",
  eventTitle: "药小伴服药提醒",
  writtenKeys: ["test-key"],
  skippedKeys: [],
  failedKeys: [],
  ...overrides,
});

async function mountDetail(state = appState()) {
  const bootstrap = vi.fn<() => Promise<AppState>>().mockResolvedValue(state);
  const saveCalendarExport = vi.fn().mockResolvedValue(state);
  vi.stubGlobal("getApp", () => ({
    getService: () => ({ bootstrap, saveCalendarExport }),
  }));
  const showModal = vi
    .fn<
      (options: {
        title: string;
        content: string;
        confirmText?: string;
      }) => Promise<{ confirm: boolean }>
    >()
    .mockResolvedValue({ confirm: true });
  const showToast = vi.fn();
  vi.stubGlobal("wx", { showModal, showToast });
  let page: DetailCalendarPage | undefined;
  vi.stubGlobal("Page", (definition: DetailCalendarPage) => {
    page = Object.assign(definition, {
      setData(values: Partial<DetailCalendarPage["data"]>) {
        Object.assign(definition.data, values);
      },
    });
  });
  await import("../miniprogram/pages/medicine-detail/index");
  if (!page) throw new Error("药盒详情未注册");
  page.setData({ medicationId: "med-1" });
  page.loadData = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  return { page, bootstrap, saveCalendarExport, showModal, showToast };
}

beforeEach(() => {
  openCalendarPermissionSettings.mockReset().mockResolvedValue("system");
  writePlanToCalendar.mockReset().mockResolvedValue(result());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("详情页添加日历的失败与取消恢复", () => {
  it("加载失败显示错误且释放 busy，不尝试写入", async () => {
    const { page, bootstrap, showModal, showToast } = await mountDetail();
    bootstrap.mockRejectedValueOnce(new Error("网络连接失败"));

    await expect(page.addCalendar()).resolves.toBeUndefined();

    expect(page.data.busy).toBe(false);
    expect(showToast).toHaveBeenCalledWith({
      title: "网络连接失败",
      icon: "none",
      duration: 2600,
    });
    expect(showModal).not.toHaveBeenCalled();
    expect(writePlanToCalendar).not.toHaveBeenCalled();
  });

  it("取消首次确认后释放 busy，不写入也不显示成功", async () => {
    const { page, showModal, showToast } = await mountDetail();
    showModal.mockResolvedValueOnce({ confirm: false });

    await page.addCalendar();

    expect(page.data.busy).toBe(false);
    expect(showModal.mock.calls[0]?.[0].content).toContain(
      "中国北京时间（UTC+8）",
    );
    expect(writePlanToCalendar).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it("确认弹窗异常也会释放 busy", async () => {
    const { page, showModal, showToast } = await mountDetail();
    showModal.mockRejectedValueOnce(new Error("操作没有完成"));

    await expect(page.addCalendar()).resolves.toBeUndefined();

    expect(page.data.busy).toBe(false);
    expect(showToast).toHaveBeenCalledOnce();
    expect(writePlanToCalendar).not.toHaveBeenCalled();
  });

  it("无固定服药计划时给出明确提示且释放 busy", async () => {
    const state = appState();
    state.plans = [];
    const { page, showToast, showModal } = await mountDetail(state);

    await page.addCalendar();

    expect(page.data.busy).toBe(false);
    expect(showToast).toHaveBeenCalledWith({
      title: "请先设置固定服药计划",
      icon: "none",
      duration: 2600,
    });
    expect(showModal).not.toHaveBeenCalled();
    expect(writePlanToCalendar).not.toHaveBeenCalled();
  });

  it("不支持日历写入时说明真实限制，不提示成功且释放 busy", async () => {
    const { page, showModal, showToast } = await mountDetail();
    writePlanToCalendar.mockResolvedValueOnce(
      result({ success: false, status: "failed", reason: "unsupported" }),
    );

    await page.addCalendar();

    expect(page.data.busy).toBe(false);
    expect(showModal.mock.calls[1]?.[0].title).toBe("当前环境不支持添加日历");
    expect(showModal.mock.calls[1]?.[0].content).toContain(
      "药盒和服药计划已保留",
    );
    expect(showToast).not.toHaveBeenCalled();
    expect(openCalendarPermissionSettings).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "系统权限被拒绝、是否前往设置=%s 时不误报成功并释放 busy",
    async (goToSettings) => {
      const { page, showModal, showToast } = await mountDetail();
      showModal
        .mockResolvedValueOnce({ confirm: true })
        .mockResolvedValueOnce({ confirm: goToSettings });
      writePlanToCalendar.mockResolvedValueOnce(
        result({
          success: false,
          status: "failed",
          reason: "denied",
          permissionTarget: "system",
        }),
      );

      await page.addCalendar();

      expect(page.data.busy).toBe(false);
      expect(page.loadData).toHaveBeenCalledOnce();
      expect(showModal.mock.calls[1]?.[0].title).toBe("需要日历权限");
      expect(showModal.mock.calls[1]?.[0].content).toContain("系统中的微信");
      expect(openCalendarPermissionSettings).toHaveBeenCalledTimes(
        goToSettings ? 1 : 0,
      );
      expect(showToast).not.toHaveBeenCalled();
    },
  );

  it("部分写入后遇到不支持时刷新状态，不把整组提醒说成失败", async () => {
    const { page, showModal, showToast } = await mountDetail();
    writePlanToCalendar.mockResolvedValueOnce(
      result({
        success: false,
        status: "partial",
        reason: "unsupported",
        writtenKeys: ["morning"],
        failedKeys: ["evening"],
      }),
    );

    await page.addCalendar();

    expect(page.data.busy).toBe(false);
    expect(page.loadData).toHaveBeenCalledOnce();
    expect(showModal.mock.calls[1]?.[0].title).toBe("部分日历提醒已添加");
    expect(showModal.mock.calls[1]?.[0].content).toContain(
      "部分时间已成功添加",
    );
    expect(showToast).not.toHaveBeenCalled();
  });

  it("权限设置跳转失败释放 busy 并保留失败说明", async () => {
    const { page, showToast } = await mountDetail();
    writePlanToCalendar.mockResolvedValueOnce(
      result({ success: false, status: "failed", reason: "denied" }),
    );
    openCalendarPermissionSettings.mockRejectedValueOnce(
      new Error("未能打开日历授权设置"),
    );

    await page.addCalendar();

    expect(page.data.busy).toBe(false);
    expect(showToast).toHaveBeenCalledWith({
      title: "未能打开日历授权设置",
      icon: "none",
      duration: 2600,
    });
  });

  it("加载尚未完成时防止双击，完成后释放 busy", async () => {
    const { page, bootstrap, showModal } = await mountDetail();
    let finish: ((state: AppState) => void) | undefined;
    bootstrap.mockImplementationOnce(
      () =>
        new Promise<AppState>((resolveState) => {
          finish = resolveState;
        }),
    );
    const pending = page.addCalendar();
    expect(page.data.busy).toBe(true);
    await page.addCalendar();
    expect(bootstrap).toHaveBeenCalledOnce();
    expect(showModal).not.toHaveBeenCalled();
    if (!finish) throw new Error("日历数据加载未开始");
    finish(appState());
    await pending;

    expect(writePlanToCalendar).toHaveBeenCalledOnce();
    expect(showModal).toHaveBeenCalledOnce();
    expect(page.data.busy).toBe(false);
  });
});

describe("详情页已有日历事件", () => {
  it("待处理提醒展示本药盒真实且去重后的标题，不固定使用通用标题", async () => {
    const state = appState();
    const staleExport = (overrides: Partial<CalendarExport>): CalendarExport =>
      ({
        id: "export-1",
        medicationId: "med-1",
        planId: "old-plan",
        fingerprint: "old-key",
        eventTitle: "服用测试药",
        exportedAt: "2026-08-01T00:00:00Z",
        staleAt: "2026-08-02T00:00:00Z",
        version: 1,
        ...overrides,
      }) satisfies CalendarExport;
    state.calendarExports = [
      staleExport({}),
      staleExport({ id: "export-2", fingerprint: "duplicate-title" }),
      staleExport({ id: "export-3", eventTitle: "我的自定义日程" }),
      staleExport({
        id: "other",
        medicationId: "med-2",
        eventTitle: "另一盒药的提醒",
      }),
    ];
    const { page, showModal } = await mountDetail(state);
    showModal.mockResolvedValueOnce({ confirm: false });

    await page.addCalendar();

    const modal = showModal.mock.calls[0]?.[0];
    expect(modal?.title).toBe("先处理旧提醒");
    expect(modal?.content).toContain("“服用测试药”、“我的自定义日程”");
    expect(modal?.content.match(/服用测试药/g)).toHaveLength(1);
    expect(modal?.content).not.toContain("另一盒药的提醒");
    expect(modal?.content).not.toContain("药小伴服药提醒");
    expect(page.data.busy).toBe(false);
  });

  it("已有计划的 noop 只说明已经添加，不声称再次写入", async () => {
    const { page, showToast } = await mountDetail();
    writePlanToCalendar.mockResolvedValueOnce(
      result({ success: false, status: "noop", writtenKeys: [] }),
    );

    await page.addCalendar();

    expect(page.data.busy).toBe(false);
    expect(showToast).toHaveBeenCalledWith({
      title: "当前计划已经添加过",
      icon: "success",
    });
  });
});
