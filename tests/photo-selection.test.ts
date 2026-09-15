import { afterEach, expect, it, vi } from "vitest";
import { selectMedicationPhoto } from "../miniprogram/services/medication-photo";
afterEach(() => vi.unstubAllGlobals());
function install(width: number, height: number) {
  const compressImage = vi
    .fn()
    .mockResolvedValue({ tempFilePath: "/compressed.jpg" });
  vi.stubGlobal("wx", {
    chooseMedia: vi.fn().mockResolvedValue({
      tempFiles: [{ tempFilePath: "/selected.jpg", size: 5000000 }],
    }),
    getImageInfo: vi.fn().mockResolvedValue({ width, height }),
    compressImage,
    getFileSystemManager: () => ({
      getFileInfo: (options: WechatMiniprogram.GetFileInfoOption) =>
        options.success?.({
          size: 240000,
        } as WechatMiniprogram.GetFileInfoSuccessCallbackResult),
    }),
  });
  return compressImage;
}
it("选图后在压缩完成之前提供本地预览，竖图最长边限制为 1280", async () => {
  const compress = install(3000, 4000);
  let finish: ((value: unknown) => void) | undefined;
  compress.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const onSelected = vi.fn();
  const selected = selectMedicationPhoto({ onSelected });
  await vi.waitFor(() => expect(compress).toHaveBeenCalled());
  expect(onSelected).toHaveBeenCalledWith("/selected.jpg");
  expect(compress).toHaveBeenCalledWith({
    src: "/selected.jpg",
    quality: 65,
    compressedWidth: 960,
    compressedHeight: 1280,
  });
  finish?.({ tempFilePath: "/compressed.jpg" });
  expect(await selected).toEqual({
    tempFilePath: "/compressed.jpg",
    byteSize: 240000,
  });
});
it("横图等比压缩，小图只调整质量而不放大", async () => {
  const compress = install(4000, 2000);
  await selectMedicationPhoto();
  expect(compress).toHaveBeenCalledWith(
    expect.objectContaining({ compressedWidth: 1280, compressedHeight: 640 }),
  );
  const small = install(300, 400);
  await selectMedicationPhoto();
  expect(small).toHaveBeenCalledWith({ src: "/selected.jpg", quality: 65 });
});
it("用户取消不触发预览或压缩", async () => {
  const compress = install(300, 400);
  const onSelected = vi.fn();
  // eslint-disable-next-line @typescript-eslint/unbound-method
  vi.mocked(wx.chooseMedia).mockRejectedValue({
    errMsg: "chooseMedia:fail cancel",
  });
  expect(await selectMedicationPhoto({ onSelected })).toBeNull();
  expect(onSelected).not.toHaveBeenCalled();
  expect(compress).not.toHaveBeenCalled();
});
