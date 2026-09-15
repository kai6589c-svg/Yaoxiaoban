import { afterEach, expect, it, vi } from "vitest";
import type {} from "../miniprogram/types/global";
import { appState, log } from "./fixtures";
interface UsagePage {
  data: {
    medicationId: string;
    busy: boolean;
    recordOpen: boolean;
    recordQuantity: string;
    recordDate: string;
    recordTime: string;
    recordError: string;
    recordRequestId: string;
    view: {
      photoUrl: string;
      recordLabel: string;
      recentUsage: { id: string; version: number }[];
    };
  };
  setData(values: Record<string, unknown>): void;
  loadData(): Promise<void>;
  recordExtra(): void;
  saveUsage(): Promise<void>;
  previewPhoto(): void;
  undoUsage(e: WechatMiniprogram.BaseEvent): Promise<void>;
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});
async function mount() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-05T04:00:00Z"));
  const state = appState();
  state.medications[0]!.mode = "as_needed";
  state.medications[0]!.photo = {
    mediaId: "media",
    fileId: "cloud://env/photo.jpg",
    updatedAt: new Date().toISOString(),
  };
  state.intakeLogs = [
    log({ status: "extra", planId: null, occurrenceKey: null }),
    log({ id: "void", status: "extra", voidedAt: new Date().toISOString() }),
  ];
  const recordIntake = vi.fn().mockResolvedValue(state),
    undoIntake = vi.fn().mockResolvedValue(state),
    previewImage = vi.fn().mockResolvedValue({});
  vi.stubGlobal("getApp", () => ({
    getService: () => ({
      bootstrap: async () => state,
      recordIntake,
      undoIntake,
    }),
  }));
  vi.stubGlobal("wx", {
    setNavigationBarTitle: vi.fn(),
    showToast: vi.fn(),
    showModal: vi.fn().mockResolvedValue({ confirm: true }),
    previewImage,
  });
  let page!: UsagePage;
  vi.stubGlobal("Page", (definition: UsagePage) => {
    page = definition;
    page.setData = (values) => Object.assign(page.data, values);
  });
  await import("../miniprogram/pages/medicine-detail/index");
  page.data.medicationId = "med-1";
  await page.loadData();
  return { page, recordIntake, undoIntake, previewImage };
}
it("按需记录有入口，数量及选定北京时间正确传入，失败重试复用请求号", async () => {
  const { page, recordIntake } = await mount();
  expect(page.data.view.recordLabel).toBe("记录本次使用");
  page.recordExtra();
  page.data.recordQuantity = "0.125";
  page.data.recordDate = "2026-09-04";
  page.data.recordTime = "09:30";
  recordIntake.mockRejectedValueOnce(new Error("连接失败"));
  await page.saveUsage();
  expect(page.data.recordOpen).toBe(true);
  expect(page.data.busy).toBe(false);
  const requestId = page.data.recordRequestId;
  await page.saveUsage();
  expect(recordIntake).toHaveBeenLastCalledWith(
    expect.objectContaining({
      quantityMilli: 125,
      occurredAt: "2026-09-04T01:30:00.000Z",
      requestId,
      planId: null,
      status: "extra",
    }),
  );
  expect(page.data.recordOpen).toBe(false);
});
it("非法数量及未来时间不会写入", async () => {
  const { page, recordIntake } = await mount();
  page.recordExtra();
  page.data.recordQuantity = "0";
  await page.saveUsage();
  expect(recordIntake).not.toHaveBeenCalled();
  page.data.recordQuantity = "1";
  page.data.recordDate = "2026-09-06";
  await page.saveUsage();
  expect(page.data.recordError).toContain("不能晚于现在");
  expect(recordIntake).not.toHaveBeenCalled();
});
it("照片预览使用保存引用，撤销仅操作当前未撤销记录", async () => {
  const { page, undoIntake, previewImage } = await mount();
  page.previewPhoto();
  expect(previewImage).toHaveBeenCalledWith({
    current: "cloud://env/photo.jpg",
    urls: ["cloud://env/photo.jpg"],
  });
  expect(page.data.view.recentUsage).toHaveLength(1);
  await page.undoUsage({
    currentTarget: { dataset: { id: "log-1" } },
  } as unknown as WechatMiniprogram.BaseEvent);
  expect(undoIntake).toHaveBeenCalledWith("log-1", 1);
});
