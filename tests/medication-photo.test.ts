import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  commitStagedMedicationPhoto,
  stageMedicationPhoto,
} from "../miniprogram/services/medication-photo";
import {
  ServiceError,
  type DataService,
} from "../miniprogram/services/data-service";

const directUpload = vi.fn();
const relay = vi.fn();
const prepare = vi.fn();
const discard = vi.fn();
const readFile = vi.fn();
const abort = vi.fn();
const ticket = {
  mediaId: "media_123",
  cloudPath: "medication-photos/owner_123/media_123.jpg",
  expiresAt: "2099-01-01T00:00:00Z",
  maxBytes: 2097152,
  transport: "cloud" as const,
};
let service: DataService;
let args: Parameters<typeof stageMedicationPhoto>[0];
const failDirect = (options: ICloud.UploadFileParam) => {
  options.fail?.({ errMsg: "uploadFile:fail timeout" });
  return { abort };
};
const succeedDirect = (options: ICloud.UploadFileParam) => {
  options.success?.({
    fileID: "cloud://env/direct",
    statusCode: 200,
    errMsg: "uploadFile:ok",
  });
  return { abort };
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  service = {
    prepareMedicationPhoto: prepare,
    uploadMedicationPhoto: relay,
    discardMedicationPhoto: discard,
  } as unknown as DataService;
  args = {
    service,
    medicationId: "med_123",
    expectedVersion: 2,
    tempFilePath: "/local/photo.jpg",
  };
  prepare.mockResolvedValue(ticket);
  discard.mockResolvedValue(undefined);
  relay.mockResolvedValue({ fileId: "cloud://env/chunk" });
  directUpload.mockImplementation(failDirect);
  readFile.mockImplementation((options: WechatMiniprogram.ReadFileOption) =>
    options.success?.({ data: "aW1hZ2U=", errMsg: "readFile:ok" }),
  );
  vi.stubGlobal("wx", {
    cloud: { uploadFile: directUpload },
    getFileSystemManager: () => ({
      getFileInfo: (options: WechatMiniprogram.GetFileInfoOption) =>
        options.success?.({
          size: 510000,
        } as WechatMiniprogram.GetFileInfoSuccessCallbackResult),
      readFile,
    }),
  });
});
afterEach(() => vi.useRealTimers());

it("一级直传成功不读 Base64，返回同一 commit 所需的票据与 fileId", async () => {
  directUpload.mockImplementation(succeedDirect);
  expect(await stageMedicationPhoto(args)).toEqual({
    ticket,
    fileId: "cloud://env/direct",
  });
  expect(prepare).toHaveBeenCalledOnce();
  expect(directUpload).toHaveBeenCalledOnce();
  expect(readFile).not.toHaveBeenCalled();
  expect(relay).not.toHaveBeenCalled();
});

it("直传首次瞬时失败就切换，不再等待 1 秒和 3 秒重试", async () => {
  directUpload.mockImplementation(failDirect);
  const started = Date.now();
  expect((await stageMedicationPhoto(args)).fileId).toBe("cloud://env/chunk");
  expect(Date.now() - started).toBe(0);
  expect(directUpload).toHaveBeenCalledOnce();
  expect(relay).toHaveBeenCalledOnce();
});

it("直传失败后读取 Base64 并通过同一 mediaId 分块兜底", async () => {
  const result = expect(stageMedicationPhoto(args)).resolves.toEqual({
    ticket,
    fileId: "cloud://env/chunk",
  });
  await vi.runAllTimersAsync();
  await result;
  expect(prepare).toHaveBeenCalledOnce();
  expect(directUpload).toHaveBeenCalledTimes(1);
  expect(readFile).toHaveBeenCalledOnce();
  expect(relay).toHaveBeenCalledWith({
    medicationId: args.medicationId,
    expectedVersion: 2,
    mediaId: ticket.mediaId,
    base64: "aW1hZ2U=",
  });
  expect(discard).not.toHaveBeenCalled();
});

it("首次失败触发会话熔断，下一张直接兜底，新会话重新直传", async () => {
  const first = expect(stageMedicationPhoto(args)).resolves.toBeTruthy();
  await vi.runAllTimersAsync();
  await first;
  await stageMedicationPhoto(args);
  expect(directUpload).toHaveBeenCalledTimes(1);
  directUpload.mockImplementation(succeedDirect);
  const freshService = { ...service };
  expect(
    (await stageMedicationPhoto({ ...args, service: freshService })).fileId,
  ).toBe("cloud://env/direct");
  expect(directUpload).toHaveBeenCalledTimes(2);
});

it.each([
  "AUTH_FAILED",
  "MEDICATION_FORBIDDEN",
  "INVALID_FILE_TYPE",
  "PHOTO_TOO_LARGE",
  "UPLOAD_TICKET_EXPIRED",
  "MEDICATION_NOT_FOUND",
])("业务错误 %s 不重试、不兜底", async (code) => {
  directUpload.mockImplementation((options: ICloud.UploadFileParam) => {
    options.fail?.({ errMsg: code });
    return { abort };
  });
  await expect(stageMedicationPhoto(args)).rejects.toMatchObject({
    outcome: "definite",
    retryable: false,
  });
  expect(directUpload).toHaveBeenCalledOnce();
  expect(relay).not.toHaveBeenCalled();
});

it("原生 SDK 不回调时中止超时任务，迟到成功不改变分块结果", async () => {
  const callbacks: ICloud.UploadFileParam[] = [];
  directUpload.mockImplementation((options: ICloud.UploadFileParam) => {
    callbacks.push(options);
    return { abort };
  });
  const result = expect(stageMedicationPhoto(args)).resolves.toMatchObject({
    fileId: "cloud://env/chunk",
  });
  await vi.runAllTimersAsync();
  await result;
  expect(abort).toHaveBeenCalledTimes(1);
  callbacks[0]!.success?.({
    fileID: "cloud://env/late",
    statusCode: 200,
    errMsg: "ok",
  });
  expect(relay).toHaveBeenCalledOnce();
  expect(discard).not.toHaveBeenCalled();
});

it("兜底结果未知时保留同一票据及本地照片", async () => {
  relay.mockRejectedValue(
    new ServiceError("NETWORK", "上传中断", true, "unknown"),
  );
  const result = expect(stageMedicationPhoto(args)).rejects.toMatchObject({
    outcome: "unknown",
    pending: { ticket, tempFilePath: args.tempFilePath },
  });
  await vi.runAllTimersAsync();
  await result;
  expect(discard).not.toHaveBeenCalled();
});

it("直传超时期间票据过期会停止，不再兜底", async () => {
  directUpload.mockImplementation(() => ({ abort }));
  prepare.mockResolvedValue({
    ...ticket,
    expiresAt: new Date(Date.now() + 500).toISOString(),
  });
  const result = expect(stageMedicationPhoto(args)).rejects.toMatchObject({
    code: "MEDIA_UPLOAD_EXPIRED",
  });
  await vi.runAllTimersAsync();
  await result;
  expect(directUpload).toHaveBeenCalledOnce();
  expect(relay).not.toHaveBeenCalled();
});
it("commit 超时保留同一 mediaId 和 fileId，允许重放同一提交", async () => {
  const commit = vi
    .fn()
    .mockRejectedValue(
      new ServiceError(
        "MEDIA_UNAVAILABLE",
        "照片服务响应超时，请稍后重试",
        true,
        "unknown",
      ),
    );
  const staged = {
    ticket: ticket as Awaited<
      ReturnType<DataService["prepareMedicationPhoto"]>
    >,
    fileId: "cloud://env/photo",
  };
  await expect(
    commitStagedMedicationPhoto({
      service: {
        commitMedicationPhoto: commit,
      } as unknown as DataService,
      medicationId: args.medicationId,
      expectedVersion: args.expectedVersion,
      staged,
      attemptId: "PHT-COMMIT-0001",
    }),
  ).rejects.toMatchObject({
    outcome: "unknown",
    pending: { staged, ticket },
  });
  expect(commit).toHaveBeenCalledWith(
    {
      medicationId: args.medicationId,
      expectedVersion: args.expectedVersion,
      mediaId: ticket.mediaId,
      fileId: staged.fileId,
    },
    expect.objectContaining({ stage: "commit" }),
  );
});

it("SDK 仅返回 Promise 时也完成直传，不白等回调超时", async () => {
  directUpload.mockResolvedValue({ fileID: "cloud://env/promise" });
  expect(await stageMedicationPhoto(args)).toEqual({
    ticket,
    fileId: "cloud://env/promise",
  });
  expect(directUpload).toHaveBeenCalledOnce();
  expect(readFile).not.toHaveBeenCalled();
  expect(abort).not.toHaveBeenCalled();
});
