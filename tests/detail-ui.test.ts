import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {} from "../miniprogram/types/global";
import { appState, log, medication, snapshot } from "./fixtures";

interface DetailPage {
  data: { medicationId: string; medicationVersion: number; busy: boolean };
  setData(values: Partial<DetailPage["data"]>): void;
  edit(): void;
  history(): void;
  archive(): Promise<void>;
}

interface HistoryPage {
  data: {
    medicationId: string;
    loading: boolean;
    error: string;
    logs: Array<{ id: string; title: string; time: string }>;
  };
  setData(values: Partial<HistoryPage["data"]>): void;
  onLoad(options: Record<string, string | undefined>): void;
  loadData(): Promise<void>;
}

function capturePage<T extends { data: object }>() {
  let page: T | undefined;
  vi.stubGlobal("Page", (definition: T) => {
    page = Object.assign(definition, {
      setData(values: Partial<T["data"]>) {
        Object.assign(definition.data, values);
      },
    });
  });
  return () => {
    if (!page) throw new Error("页面未注册");
    return page;
  };
}

const readSource = (path: string) =>
  readFileSync(resolve("miniprogram", path), "utf8");

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("药盒详情和导航交互", () => {
  it("返回区不使用会套用原生默认布局的 button，并保留固定点击宽度", () => {
    const markup = readSource("components/app-nav/index.wxml");
    const style = readSource("components/app-nav/index.wxss");
    expect(markup).toMatch(
      /<view class="app-nav-back"[^>]*bindtap="goBack"[^>]*role="button"[^>]*aria-label="返回"/,
    );
    expect(markup).not.toContain('<button class="app-nav-back"');
    expect(style).toContain("flex: 0 0 88rpx");
    expect(style).toContain("justify-content: flex-start");
  });

  it("返回按钮按页面栈返回，直接进入子页时回到今天", async () => {
    let goBack: (() => void) | undefined;
    vi.stubGlobal(
      "Component",
      (definition: { methods: { goBack(): void } }) => {
        goBack = () => definition.methods.goBack();
      },
    );
    const navigateBack = vi.fn();
    const switchTab = vi.fn();
    const getCurrentPages = vi.fn().mockReturnValue([{}, {}]);
    vi.stubGlobal("wx", { navigateBack, switchTab });
    vi.stubGlobal("getCurrentPages", getCurrentPages);
    await import("../miniprogram/components/app-nav/index");

    goBack?.();
    expect(navigateBack).toHaveBeenCalledOnce();
    expect(switchTab).not.toHaveBeenCalled();
    getCurrentPages.mockReturnValue([{}]);
    goBack?.();
    expect(switchTab).toHaveBeenCalledWith({ url: "/pages/today/index" });
  });

  it("记录区只提供编辑药盒与最近服药记录，并保持原页面路由", async () => {
    const markup = readSource("pages/medicine-detail/index.wxml");
    const recordSection = markup.split('<view class="card action-list">')[1];
    expect(recordSection).toMatch(
      /bindtap="edit"[^>]*>[\s\S]*?<text>编辑药盒<\/text>/,
    );
    expect(recordSection).toMatch(
      /bindtap="history"[^>]*>[\s\S]*?<text>最近服药记录<\/text>/,
    );
    expect(markup).toContain('bindtap="recordExtra"');
    expect(markup).toContain('bindtap="previewPhoto"');
    expect(markup).toContain('class="edit-button" bindtap="edit"');

    const navigateTo = vi.fn();
    vi.stubGlobal("wx", { navigateTo });
    const getPage = capturePage<DetailPage>();
    await import("../miniprogram/pages/medicine-detail/index");
    const page = getPage();
    page.setData({ medicationId: "med-1" });
    page.edit();
    page.history();
    expect(navigateTo.mock.calls).toEqual([
      [{ url: "/pages/medicine-form/index?id=med-1" }],
      [{ url: "/pages/history/index?id=med-1" }],
    ]);
  });

  it("移除明确保留历史且仍调用可恢复操作，不触发永久删除", async () => {
    vi.useFakeTimers();
    const archiveMedication = vi.fn().mockResolvedValue(appState());
    const deleteMedication = vi.fn();
    vi.stubGlobal("getApp", () => ({
      getService: () => ({ archiveMedication, deleteMedication }),
    }));
    const showModal = vi
      .fn<
        (options: {
          title: string;
          content: string;
          confirmText: string;
        }) => Promise<{ confirm: boolean }>
      >()
      .mockResolvedValue({ confirm: true });
    const showToast = vi.fn();
    const switchTab = vi.fn();
    vi.stubGlobal("wx", { showModal, showToast, switchTab });
    const getPage = capturePage<DetailPage>();
    await import("../miniprogram/pages/medicine-detail/index");
    const page = getPage();
    page.setData({ medicationId: "med-1", medicationVersion: 3 });

    await page.archive();
    const modal = showModal.mock.calls[0]?.[0];
    expect(modal?.title).toBe("移除这个药盒？");
    expect(modal?.confirmText).toBe("移除");
    expect(modal?.content).toMatch(/历史记录会保留.*恢复.*自行删除/);
    expect(archiveMedication).toHaveBeenCalledWith("med-1", 3);
    expect(deleteMedication).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith({
      title: "已移除",
      icon: "success",
    });
    await vi.runAllTimersAsync();
    expect(switchTab).toHaveBeenCalledWith({ url: "/pages/cabinet/index" });
  });
});

describe("最近服药记录", () => {
  it("只展示本药盒未撤销的服药记录，不混入盘点或其他药盒", async () => {
    const state = appState();
    state.medications.push(medication({ id: "med-2", name: "另一盒药" }));
    state.snapshots = [snapshot({ id: "inventory-not-an-intake" })];
    state.intakeLogs = [
      log({ id: "taken", status: "taken", occurredAt: "2026-09-01T00:00:00Z" }),
      log({ id: "skipped", occurredAt: "2026-09-02T00:00:00Z" }),
      log({ id: "extra", status: "extra", occurredAt: "2026-09-03T00:00:00Z" }),
      log({ id: "voided", voidedAt: "2026-09-03T01:00:00Z" }),
      log({ id: "other-medicine", medicationId: "med-2" }),
    ];
    vi.stubGlobal("getApp", () => ({
      getService: () => ({ bootstrap: vi.fn().mockResolvedValue(state) }),
    }));
    const getPage = capturePage<HistoryPage>();
    await import("../miniprogram/pages/history/index");
    const page = getPage();
    page.onLoad({ id: "med-1" });
    await page.loadData();

    expect(page.data.error).toBe("");
    expect(page.data.logs.map((item) => item.id)).toEqual([
      "extra",
      "skipped",
      "taken",
    ]);
    expect(page.data.logs[0]?.time).toContain("08:00");
    expect(readSource("pages/history/index.wxml")).toContain(
      '<app-nav title="最近服药记录" />',
    );
  });

  it("已移除入口保留恢复和永久删除的区别", () => {
    const markup = readSource("pages/cabinet/index.wxml");
    expect(markup).toContain("已移除药盒");
    expect(markup).toContain('bindtap="restoreArchived"');
    expect(markup).toContain('bindtap="deleteArchived"');
    expect(markup).toContain(">永久删除</button>");
    expect(markup).not.toContain("归档");
  });
});
