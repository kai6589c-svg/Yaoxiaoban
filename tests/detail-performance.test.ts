import { afterEach, expect, it, vi } from "vitest";
import { appState, medication } from "./fixtures";
interface Detail {
  data: {
    medicationId: string;
    loading: boolean;
    view: { photoUrl: string; photoFullUrl: string } | null;
  };
  setData(values: Partial<Detail["data"]>): void;
  loadData(): Promise<void>;
  previewPhoto(): void;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});
it("提醒请求未返回时详情已可操作，小图走缩略图而查看大图走完整图", async () => {
  let page: Detail | undefined;
  vi.stubGlobal("Page", (definition: Detail) => {
    page = Object.assign(definition, {
      setData(values: Partial<Detail["data"]>) {
        Object.assign(definition.data, values);
      },
    });
  });
  let finish: ((value: null) => void) | undefined;
  const reminder = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const state = appState();
  state.medications = [
    medication({
      photo: {
        mediaId: "media-test",
        url: "https://test/medium",
        thumbnailUrl: "https://test/thumb",
        updatedAt: "2026-09-09",
      },
    }),
  ];
  vi.stubGlobal("getApp", () => ({
    getService: () => ({
      bootstrap: async () => state,
      getReminderStatus: reminder,
    }),
  }));
  const previewImage = vi.fn().mockResolvedValue({});
  vi.stubGlobal("wx", { setNavigationBarTitle: vi.fn(), previewImage });
  await import("../miniprogram/pages/medicine-detail/index");
  if (!page) throw new Error("page missing");
  page.setData({ medicationId: state.medications[0]!.id });
  const loading = page.loadData();
  await vi.waitFor(() => expect(reminder).toHaveBeenCalled());
  expect(page.data.loading).toBe(false);
  expect(page.data.view?.photoUrl).toBe("https://test/thumb");
  page.previewPhoto();
  expect(previewImage).toHaveBeenCalledWith({
    current: "https://test/medium",
    urls: ["https://test/medium"],
  });
  finish?.(null);
  await loading;
});
