import { afterEach, expect, it, vi } from "vitest";
import type {} from "../miniprogram/types/global";
import { appState, log } from "./fixtures";
import { readableMedicineList } from "../miniprogram/services/readable-export";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});
it("可读导出包含识别信息，不暴露照片云地址", () => {
  const state = appState();
  state.medications[0]!.photo = {
    mediaId: "private-media",
    fileId: "cloud://private-photo",
    updatedAt: "2026-09-06",
  };
  const text = readableMedicineList(state);
  expect(text).toContain(state.medications[0]!.name);
  expect(text).toContain("管理期限：");
  expect(text).toContain("成员：");
  expect(text).not.toContain("private-photo");
});
it("诊断编号可复制且只保留允许的技术字段", async () => {
  vi.stubGlobal("wx", { setStorageSync: vi.fn(), getStorageSync: vi.fn() });
  const { recordDiagnostic, diagnosticReport } =
    await import("../miniprogram/services/diagnostics");
  const item = recordDiagnostic(
    "uploadMedicationPhoto",
    "NETWORK",
    "request-123",
  );
  expect(diagnosticReport()).toContain(item.id);
  expect(diagnosticReport()).toContain("request-123");
  recordDiagnostic("药名隐私 cloud://photo", "invalid data", "姓名");
  expect(diagnosticReport()).not.toContain("药名隐私");
  expect(diagnosticReport()).not.toContain("姓名");
});
it("历史可加载超过100条并按日期筛选，反向日期明确报错", async () => {
  const state = appState();
  state.intakeLogs = Array.from({ length: 125 }, (_, index) =>
    log({
      id: `log-${index}`,
      occurredAt: index < 20 ? "2026-08-20T04:00:00Z" : "2026-08-21T04:00:00Z",
    }),
  );
  interface History {
    data: {
      logs: unknown[];
      allLogs: unknown[];
      fromDate: string;
      toDate: string;
      matchedCount: number;
      filterError: string;
    };
    setData(v: Record<string, unknown>): void;
    loadData(): Promise<void>;
    loadMore(): void;
    applyFilters(): void;
  }
  let page!: History;
  vi.stubGlobal("Page", (definition: History) => {
    page = definition;
    page.setData = (values) => Object.assign(page.data, values);
  });
  vi.stubGlobal("getApp", () => ({
    getService: () => ({ bootstrap: async () => state }),
  }));
  await import("../miniprogram/pages/history/index");
  await page.loadData();
  expect(page.data.logs).toHaveLength(50);
  page.loadMore();
  page.loadMore();
  expect(page.data.logs).toHaveLength(125);
  page.data.fromDate = "2026-08-21";
  page.data.toDate = "2026-08-21";
  page.applyFilters();
  expect(page.data.matchedCount).toBe(105);
  page.data.fromDate = "2026-08-22";
  page.applyFilters();
  expect(page.data.filterError).toContain("开始日期");
  expect(page.data.logs).toHaveLength(0);
});
it("药箱日期状态可核对，筛选数量不随选中状态丢失", async () => {
  const state = appState();
  state.settings.privacyAcceptedVersion = "2026-08-01";
  const med = state.medications[0]!;
  state.medications = [
    { ...med, id: "today", expiryPrecision: "day", expiryValue: "2026-09-06" },
    { ...med, id: "old", expiryPrecision: "day", expiryValue: "2026-09-05" },
    { ...med, id: "later", expiryPrecision: "day", expiryValue: "2027-09-06" },
  ];
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-06T04:00:00Z"));
  interface Cabinet {
    data: {
      selectedExpiry: string;
      cards: { status: string }[];
      expiryCounts: { all: number; expired: number; expiring: number };
      archivedExpanded: boolean;
    };
    setData(v: Record<string, unknown>): void;
    loadData(): Promise<void>;
    applyFilters(): void;
  }
  let page!: Cabinet;
  vi.stubGlobal("Page", (definition: Cabinet) => {
    page = definition;
    page.setData = (values) => Object.assign(page.data, values);
  });
  vi.stubGlobal("getApp", () => ({
    getService: () => ({ bootstrap: async () => state }),
  }));
  await import("../miniprogram/pages/cabinet/index");
  await page.loadData();
  expect(page.data.expiryCounts).toEqual({ all: 3, expiring: 1, expired: 1 });
  expect(page.data.cards.map((item) => item.status)).toContain("今天到期");
  expect(page.data.archivedExpanded).toBe(false);
  page.data.selectedExpiry = "expired";
  page.applyFilters();
  expect(page.data.cards).toHaveLength(1);
  expect(page.data.expiryCounts.all).toBe(3);
  vi.restoreAllMocks();
});
it("顶部安全区结合胶囊位置预留，小屏和大字体保留可用空间", async () => {
  interface Nav {
    data: { top: number; rowHeight: number; reserve: number };
    methods: { measure(this: Nav): void };
    setData(v: Record<string, unknown>): void;
  }
  let component!: Nav;
  const setData = vi.fn();
  vi.stubGlobal("Component", (definition: Nav) => {
    component = definition;
    component.setData = (values) => Object.assign(component.data, values);
  });
  vi.stubGlobal("getCurrentPages", () => [{ setData }]);
  vi.stubGlobal("wx", {
    getWindowInfo: () => ({
      windowWidth: 320,
      statusBarHeight: 44,
      safeArea: { top: 44 },
    }),
    getMenuButtonBoundingClientRect: () => ({ top: 48, bottom: 80, left: 224 }),
    getAppBaseInfo: () => ({ fontSizeSetting: 24 }),
  });
  await import("../miniprogram/components/app-nav/index");
  component.methods.measure.call(component);
  expect(component.data.top).toBe(44);
  expect(component.data.top + component.data.rowHeight).toBeGreaterThanOrEqual(
    84,
  );
  expect(component.data.reserve).toBe(108);
  expect(setData).toHaveBeenCalledWith({ textScale: 1.5 });
});

it("照片诊断包含请求体积和运行版本，保留脱敏错误", async () => {
  const storage = new Map<string, unknown>();
  vi.stubGlobal("wx", {
    getStorageSync: (key: string) => storage.get(key),
    setStorageSync: (key: string, value: unknown) => storage.set(key, value),
    getAccountInfoSync: () => ({ miniProgram: { envVersion: "trial" } }),
    getSystemInfoSync: () => ({ SDKVersion: "3.16.2" }),
  });
  const { createPhotoAttempt, recordPhotoEvent, photoAttemptReport } =
    await import("../miniprogram/services/diagnostics");
  const attemptId = createPhotoAttempt();
  recordPhotoEvent({
    attemptId,
    stage: "upload_rpc",
    outcome: "unknown",
    transport: "relay",
    rawByteSize: 530000,
    base64Length: 706668,
    eventUtf8Bytes: 707000,
    error: {
      errCode: -1,
      errMsg: "request:fail network cloud://private-photo 药名隐私",
    },
  });
  const report = photoAttemptReport(attemptId);
  expect(report).toContain("bytes=530000");
  expect(report).toContain("base64=706668");
  expect(report).toContain("requestBytes=707000");
  expect(report).toContain("env=trial");
  expect(report).toContain("sdk=3.16.2");
  expect(report).not.toContain("private-photo");
  expect(report).not.toContain("药名隐私");
});
