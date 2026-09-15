import { ServiceError, type DataService } from "./data-service";
import { recordPhotoEvent } from "./diagnostics";

const RETRY_DELAYS_MS = [0] as const;
const DIRECT_TIMEOUT_MS = 1800;
// The app creates a new DataService on launch. No device flag is persisted.
const unstableSessions = new WeakSet<DataService>();

const nativeMessage = (error: unknown): string => {
  if (!error || typeof error !== "object")
    return typeof error === "string" || typeof error === "number"
      ? String(error)
      : "";
  const item = error as {
    code?: unknown;
    errCode?: unknown;
    errMsg?: unknown;
    message?: unknown;
  };
  return [item.code, item.errCode, item.errMsg, item.message]
    .filter((x) => typeof x === "string" || typeof x === "number")
    .join(" ");
};

export const classifyDirectUploadError = (error: unknown): ServiceError => {
  if (error instanceof ServiceError) return error;
  const message = nativeMessage(error);
  // Business/security failures must never be retried through another transport.
  if (/auth|permission|forbidden|denied|无权限|未授权/i.test(message))
    return new ServiceError(
      "FORBIDDEN",
      "没有照片上传权限，请重新登录后重试",
      false,
      "definite",
      error,
    );
  if (/expired|ticket.*invalid|过期/i.test(message))
    return new ServiceError(
      "MEDIA_UPLOAD_EXPIRED",
      "照片上传任务已过期，请重新选择",
      false,
      "definite",
      error,
    );
  if (/too.large|size.limit|payload|超限|过大/i.test(message))
    return new ServiceError(
      "PAYLOAD_TOO_LARGE",
      "照片超过上传大小限制，请重新选择",
      false,
      "definite",
      error,
    );
  if (
    /not.found|not.exist|enoent|invalid.*(file|media)|file.*type|不存在|格式/i.test(
      message,
    )
  )
    return new ServiceError(
      "INVALID_MEDIA",
      "照片文件无效，请重新选择",
      false,
      "definite",
      error,
    );
  return new ServiceError(
    "NETWORK",
    /timeout|timed.out/i.test(message)
      ? "照片上传超时，请稍后重试"
      : "照片上传失败，请稍后重试",
    true,
    "unknown",
    error,
  );
};

const directUpload = (
  cloudPath: string,
  filePath: string,
  timeoutMs: number,
): Promise<string> =>
  new Promise((resolve, reject) => {
    let settled = false;
    let task: WechatMiniprogram.UploadTask | undefined;
    const finish = (error?: unknown, fileId?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(classifyDirectUploadError(error));
      else if (fileId) resolve(fileId);
      else
        reject(classifyDirectUploadError(new Error("SDK_EMPTY_UPLOAD_RESULT")));
    };
    const timer = setTimeout(() => {
      // Ignore late callbacks before abort: abort itself may synchronously fail.
      finish(new Error("UPLOAD_TIMEOUT"));
      try {
        task?.abort();
      } catch {
        /* SDK abort is best effort. */
      }
    }, timeoutMs);
    try {
      task = wx.cloud.uploadFile({
        cloudPath,
        filePath,
        success: (result) => finish(undefined, result.fileID),
        fail: (error) => finish(error),
      });
      // Cloud SDK bridges may return a Promise even when callbacks were passed.
      // Observe both contracts; finish() makes duplicate/late completion harmless.
      const result = task as unknown as PromiseLike<{ fileID: string }>;
      if (typeof result?.then === "function") {
        void Promise.resolve(result).then(
          (value) => finish(undefined, value?.fileID),
          (error: unknown) => finish(error),
        );
      }
    } catch (error) {
      finish(error);
    }
  });

/** null means all transient direct attempts failed; use the same ticket for chunks. */
export const uploadPhotoDirectWithRetry = async (args: {
  service: DataService;
  cloudPath: string;
  filePath: string;
  expiresAt: string;
  attemptId?: string;
  deadlineAt?: number;
}): Promise<string | null> => {
  if (unstableSessions.has(args.service)) {
    if (args.attemptId)
      recordPhotoEvent({
        attemptId: args.attemptId,
        stage: "direct_circuit_open",
        transport: "direct",
        outcome: "success",
      });
    return null;
  }
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    const delay = RETRY_DELAYS_MS[attempt]!;
    if (delay) await new Promise<void>((resolve) => setTimeout(resolve, delay));
    if (Date.parse(args.expiresAt) <= Date.now())
      throw new ServiceError(
        "MEDIA_UPLOAD_EXPIRED",
        "照片上传任务已过期，请重新选择",
        false,
      );
    const startedAtMs = Date.now();
    const event = {
      attemptId: args.attemptId!,
      stage:
        attempt === 0 ? ("direct_upload" as const) : ("direct_retry" as const),
      transport: "direct" as const,
      startedAtMs,
    };
    if (args.attemptId) recordPhotoEvent({ ...event, outcome: "start" });
    try {
      const remaining = args.deadlineAt
        ? args.deadlineAt - Date.now()
        : DIRECT_TIMEOUT_MS;
      if (remaining <= 0)
        throw new ServiceError(
          "NETWORK",
          "保存时间已到，请稍后继续同步",
          true,
          "unknown",
        );
      const fileId = await directUpload(
        args.cloudPath,
        args.filePath,
        Math.min(DIRECT_TIMEOUT_MS, remaining),
      );
      if (args.attemptId) recordPhotoEvent({ ...event, outcome: "success" });
      return fileId;
    } catch (error) {
      const failure = classifyDirectUploadError(error);
      const transient = failure.code === "NETWORK" && failure.retryable;
      if (args.attemptId)
        recordPhotoEvent({
          ...event,
          outcome: transient ? "unknown" : "failure",
          error: failure.rawError ?? failure,
        });
      if (!transient) throw failure;
      if (attempt === RETRY_DELAYS_MS.length - 1) {
        unstableSessions.add(args.service);
        return null;
      }
    }
  }
  return null;
};
