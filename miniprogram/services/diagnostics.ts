import { APP_VERSION } from "../config/version";

export type PhotoStage =
  | "save_total"
  | "image_load"
  | "select"
  | "compress"
  | "stat"
  | "save_fields"
  | "prepare"
  | "read_base64"
  | "direct_upload"
  | "direct_retry"
  | "direct_circuit_open"
  | "upload_rpc"
  | "upload_chunk"
  | "upload_finalize"
  | "cloud_storage_write"
  | "commit"
  | "read_back"
  | "preview"
  | "retry_bootstrap"
  | "discard";

export type PhotoOutcome = "start" | "success" | "failure" | "unknown";

export interface PhotoRpcContext {
  attemptId: string;
  deadlineAt?: number;
  requestId?: string;
  completePhoto?: boolean;
  preparePhoto?: boolean;
  stage: PhotoStage;
  transport?: "relay" | "direct" | "local";
  rawByteSize?: number;
  base64Length?: number;
}

export interface PhotoEventInput extends PhotoRpcContext {
  requestId?: string;
  parentAttemptId?: string;
  outcome: PhotoOutcome;
  startedAtMs?: number;
  elapsedMs?: number;
  eventUtf8Bytes?: number;
  error?: unknown;
  errorCode?: string;
  errorCategory?: string;
  sanitizedErrMsg?: string;
  cloudTraceId?: string;
  platformRequestId?: string;
  backendBuild?: string;
}

interface PhotoEvent {
  requestId?: string;
  parentAttemptId?: string;
  stage: PhotoStage;
  outcome: PhotoOutcome;
  at: string;
  elapsedMs?: number;
  rawByteSize?: number;
  base64Length?: number;
  eventUtf8Bytes?: number;
  transport?: "relay" | "direct" | "local";
  clientVersion: string;
  backendBuild?: string;
  envVersion?: string;
  sdkVersion?: string;
  networkType?: string;
  errorCode?: string;
  errorCategory?: string;
  sanitizedErrMsg?: string;
  cloudTraceId?: string;
  platformRequestId?: string;
}

interface PhotoAttempt {
  attemptId: string;
  startedAt: string;
  events: PhotoEvent[];
}

interface Diagnostic {
  id: string;
  at: string;
  action: string;
  code: string;
  requestId: string;
}

const diagnosticKey = "yaoxiaoban:last-diagnostic";
const attemptsKey = "yaoxiaoban:photo-attempts-v1";
const maxAttempts = 10;
const maxEventsPerAttempt = 160;
const retentionMs = 7 * 24 * 60 * 60 * 1000;
let latest: Diagnostic | null = null;
let latestCleanup: Diagnostic | null = null;

const safe = (value: string, fallback = "unknown"): string =>
  /^[a-zA-Z0-9_:.\-/ ]{1,140}$/.test(value) ? value : fallback;

const safeErrorMessage = (value: string): string => {
  const knownSafe = [
    "照片服务暂时不可用，请稍后重试",
    "照片服务响应超时，请稍后重试",
    "照片上传失败，请检查网络后重试",
    "照片上传超时，请稍后重试",
  ];
  if (knownSafe.includes(String(value))) return String(value);
  const lower = String(value).toLowerCase();
  // Diagnostics are a technical support artifact, not an error-message dump.
  // Keep only a small platform vocabulary so medicine names, doses, identity,
  // signed URLs and local paths cannot enter storage or the copied report.
  if (/timeout|timed\s*out|time_limit/.test(lower)) return "platform_timeout";
  if (/network|request:fail|socket|dns|connect/.test(lower))
    return "network_failure";
  if (/permission|forbidden|unauthor/.test(lower)) return "permission_failure";
  if (/payload|too large|image|file|media/.test(lower))
    return "media_or_payload";
  if (/function|system_error|internal/.test(lower)) return "service_failure";
  return "platform_error";
};

const stringField = (error: unknown, key: string): string => {
  if (!error || typeof error !== "object") return "";
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
};

export const errorMetadata = (
  error: unknown,
): {
  errorCode?: string;
  errorCategory: string;
  sanitizedErrMsg: string;
} => {
  const errCode =
    stringField(error, "errCode") ||
    stringField(error, "errorCode") ||
    stringField(error, "code");
  const message =
    stringField(error, "errMsg") ||
    stringField(error, "message") ||
    (typeof error === "string" ? error : "");
  const lower = `${errCode} ${message}`.toLowerCase();
  const errorCategory = /timeout|timed out|time_limit/.test(lower)
    ? "platform_timeout"
    : /network|request:fail|socket|dns|connect/.test(lower)
      ? "network"
      : /invalid_media|payload|file|image/.test(lower)
        ? "media_or_payload"
        : errCode
          ? "sdk_or_service"
          : "unknown_runtime";
  return {
    ...(errCode ? { errorCode: safe(errCode) } : {}),
    errorCategory,
    sanitizedErrMsg: safeErrorMessage(message),
  };
};

const runtimeInfo = (): {
  envVersion?: string;
  sdkVersion?: string;
  networkType?: string;
} => {
  try {
    const account = wx.getAccountInfoSync?.() as
      { miniProgram?: { envVersion?: string } } | undefined;
    const system = wx.getSystemInfoSync?.() as
      { SDKVersion?: string } | undefined;
    return {
      ...(account?.miniProgram?.envVersion
        ? { envVersion: account.miniProgram.envVersion }
        : {}),
      ...(system?.SDKVersion ? { sdkVersion: system.SDKVersion } : {}),
    };
  } catch {
    return {};
  }
};

const readAttempts = (): PhotoAttempt[] => {
  try {
    const value = wx.getStorageSync(attemptsKey) as unknown;
    if (!Array.isArray(value)) return [];
    const cutoff = Date.now() - retentionMs;
    return value.filter((item): item is PhotoAttempt =>
      Boolean(
        item &&
        typeof item === "object" &&
        typeof (item as PhotoAttempt).attemptId === "string" &&
        typeof (item as PhotoAttempt).startedAt === "string" &&
        Date.parse((item as PhotoAttempt).startedAt) >= cutoff &&
        Array.isArray((item as PhotoAttempt).events),
      ),
    );
  } catch {
    return [];
  }
};

const writeAttempts = (attempts: PhotoAttempt[]): void => {
  try {
    wx.setStorageSync(attemptsKey, attempts.slice(-maxAttempts));
  } catch {
    // Diagnostics are best-effort and must never block saving a photo.
  }
};

const createReferenceId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random()
    .toString(36)
    .slice(2, 6)
    .toUpperCase()}`;

export const createPhotoAttempt = (): string => {
  const attempt: PhotoAttempt = {
    attemptId: createReferenceId("PHT"),
    startedAt: new Date().toISOString(),
    events: [],
  };
  const attempts = readAttempts();
  attempts.push(attempt);
  writeAttempts(attempts);
  return attempt.attemptId;
};

export const recordPhotoEvent = (input: PhotoEventInput): void => {
  const attempts = readAttempts();
  let attempt = attempts.find((item) => item.attemptId === input.attemptId);
  if (!attempt) {
    attempt = {
      attemptId: input.attemptId,
      startedAt: new Date().toISOString(),
      events: [],
    };
    attempts.push(attempt);
  }
  const runtime = runtimeInfo();
  const metadata = input.error ? errorMetadata(input.error) : undefined;
  const event: PhotoEvent = {
    ...(input.requestId ? { requestId: safe(input.requestId) } : {}),
    ...(input.parentAttemptId
      ? { parentAttemptId: safe(input.parentAttemptId) }
      : {}),
    stage: input.stage,
    outcome: input.outcome,
    at: new Date().toISOString(),
    ...(input.elapsedMs !== undefined
      ? { elapsedMs: Math.max(0, Math.round(input.elapsedMs)) }
      : input.startedAtMs !== undefined
        ? { elapsedMs: Math.max(0, Date.now() - input.startedAtMs) }
        : {}),
    ...(Number.isFinite(input.rawByteSize)
      ? { rawByteSize: Math.max(0, Math.floor(input.rawByteSize!)) }
      : {}),
    ...(Number.isFinite(input.base64Length)
      ? { base64Length: Math.max(0, Math.floor(input.base64Length!)) }
      : {}),
    ...(Number.isFinite(input.eventUtf8Bytes)
      ? { eventUtf8Bytes: Math.max(0, Math.floor(input.eventUtf8Bytes!)) }
      : {}),
    ...(input.transport ? { transport: input.transport } : {}),
    clientVersion: APP_VERSION,
    ...(input.backendBuild ? { backendBuild: safe(input.backendBuild) } : {}),
    ...runtime,
    ...(input.errorCode || metadata?.errorCode
      ? { errorCode: safe(input.errorCode ?? metadata?.errorCode ?? "") }
      : {}),
    ...(input.errorCategory || metadata?.errorCategory
      ? {
          errorCategory: safe(
            input.errorCategory ?? metadata?.errorCategory ?? "unknown",
          ),
        }
      : {}),
    ...(input.sanitizedErrMsg || metadata?.sanitizedErrMsg
      ? {
          sanitizedErrMsg: safeErrorMessage(
            input.sanitizedErrMsg ?? metadata?.sanitizedErrMsg ?? "",
          ),
        }
      : {}),
    ...(input.cloudTraceId ? { cloudTraceId: safe(input.cloudTraceId) } : {}),
    ...(input.platformRequestId
      ? { platformRequestId: safe(input.platformRequestId) }
      : {}),
  };
  attempt.events.push(event);
  attempt.events = attempt.events.slice(-maxEventsPerAttempt);
  writeAttempts(attempts);
};

export const photoAttemptReport = (attemptId: string): string => {
  const attempt = readAttempts().find((item) => item.attemptId === attemptId);
  if (!attempt)
    return `照片诊断编号：${safe(attemptId, "unknown")}\n暂无本次阶段记录`;
  const lines = attempt.events.map((event) => {
    const refs = [event.requestId, event.cloudTraceId]
      .filter(Boolean)
      .join("/");
    const details = [
      event.rawByteSize === undefined ? "" : `bytes=${event.rawByteSize}`,
      event.base64Length === undefined ? "" : `base64=${event.base64Length}`,
      event.eventUtf8Bytes === undefined
        ? ""
        : `requestBytes=${event.eventUtf8Bytes}`,
      event.transport ? `transport=${event.transport}` : "",
      event.envVersion ? `env=${safe(event.envVersion)}` : "",
      event.sdkVersion ? `sdk=${safe(event.sdkVersion)}` : "",
      event.errorCode,
      event.errorCategory,
      event.sanitizedErrMsg,
      refs,
    ]
      .filter(Boolean)
      .join(" ");
    return `${event.at} ${event.stage} ${event.outcome}${event.elapsedMs === undefined ? "" : ` ${event.elapsedMs}ms`}${details ? ` ${details}` : ""}`;
  });
  return [
    `照片诊断编号：${attempt.attemptId}`,
    `版本：${APP_VERSION}`,
    `开始：${attempt.startedAt}`,
    "阶段记录：",
    ...lines,
    "不包含药名、照片内容、原始路径、完整云文件地址或用户身份。",
  ].join("\n");
};

export const recordDiagnostic = (
  action: string,
  code: string,
  requestId = "",
  options: { cleanup?: boolean } = {},
): Diagnostic => {
  const item: Diagnostic = {
    id: createReferenceId("YXB"),
    at: new Date().toISOString(),
    action: safe(action),
    code: safe(code),
    requestId: requestId ? safe(requestId) : "无",
  };
  if (options.cleanup && latest) latestCleanup = item;
  else latest = item;
  try {
    wx.setStorageSync(diagnosticKey, latest ?? item);
  } catch {
    /* Session reference remains available. */
  }
  return latest ?? item;
};

export const diagnosticReport = (): string => {
  if (!latest) {
    try {
      const cached = wx.getStorageSync(diagnosticKey) as Diagnostic | undefined;
      if (
        cached &&
        /^YXB-[A-Z0-9-]+$/.test(cached.id) &&
        !Number.isNaN(Date.parse(cached.at))
      )
        latest = {
          id: cached.id,
          at: cached.at,
          action: safe(cached.action),
          code: safe(cached.code),
          requestId: safe(cached.requestId),
        };
    } catch {
      /* No saved diagnostic. */
    }
  }
  const item = latest ?? recordDiagnostic("manual-check", "NO_RECENT_ERROR");
  return `药小伴诊断编号：${item.id}\n版本：${APP_VERSION}\n时间：${item.at}\n操作：${item.action}\n状态：${item.code}\n请求编号：${item.requestId}${latestCleanup ? `\n清理附属状态：${latestCleanup.code}` : ""}\n这是本机反馈参考编号，未自动发送反馈；不包含药名、照片或使用记录。\n${photoPerformanceSummary()}`;
};

/** Small, local-only diagnostic sample; no user content or URLs are exported. */
export const photoPerformanceSummary = (): string => {
  const totals = readAttempts().flatMap((attempt) =>
    attempt.events.filter(
      (event) => event.stage === "save_total" && event.outcome !== "start",
    ),
  );
  const times = totals
    .map((event) => event.elapsedMs)
    .filter(
      (time): time is number =>
        typeof time === "number" && Number.isFinite(time),
    )
    .sort((a, b) => a - b);
  if (!times.length) return "照片保存：暂无完整计时样本";
  const percentile = (p: number) =>
    times[Math.max(0, Math.ceil(times.length * p) - 1)];
  return `照片保存（本机最近任务，含失败/重试）：${totals.length} 次结果；成功 ${totals.filter((event) => event.outcome === "success").length}；超过10秒 ${times.filter((time) => time > 10000).length}；P50 ${percentile(0.5)}ms / P95 ${percentile(0.95)}ms / 最大 ${times[times.length - 1]}ms`;
};
