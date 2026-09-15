import type { AppState } from "../core/models";
import type { DataService, MedicationPhotoUploadTicket } from "./data-service";
import { ServiceError } from "./data-service";
import { recordPhotoEvent, type PhotoRpcContext } from "./diagnostics";

import { uploadPhotoDirectWithRetry } from "./photo-transport";

const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const TARGET_PHOTO_EDGE = 1280;
const PHOTO_QUALITY = 65;

export interface SelectedMedicationPhoto {
  tempFilePath: string;
  byteSize: number;
}

export interface StagedMedicationPhoto {
  ticket: MedicationPhotoUploadTicket;
  fileId: string;
  completedState?: AppState;
}

export interface PendingMedicationPhoto {
  ticket: MedicationPhotoUploadTicket;
  tempFilePath: string;
  staged?: StagedMedicationPhoto;
}

export class PhotoOperationError extends ServiceError {
  constructor(
    code: ConstructorParameters<typeof ServiceError>[0],
    message: string,
    public readonly pending: PendingMedicationPhoto,
    rawError?: unknown,
  ) {
    super(code, message, true, "unknown", rawError);
  }
}

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "errMsg" in error) {
    const value = (error as { errMsg?: unknown }).errMsg;
    return typeof value === "string" ? value : "";
  }
  return typeof error === "string" ? error : "";
};

const fileSize = async (filePath: string): Promise<number> =>
  new Promise<number>((resolve, reject) => {
    wx.getFileSystemManager().getFileInfo({
      filePath,
      success: (result) => resolve(result.size),
      fail: reject,
    });
  });

/** Opens the native camera/album chooser and returns a compressed local image. */
export const selectMedicationPhoto = async (
  args: {
    attemptId?: string;
    onSelected?: (tempFilePath: string) => void;
  } = {},
): Promise<SelectedMedicationPhoto | null> => {
  const startedAtMs = Date.now();
  if (args.attemptId)
    recordPhotoEvent({
      attemptId: args.attemptId,
      stage: "select",
      outcome: "start",
      startedAtMs,
    });
  let selected: WechatMiniprogram.ChooseMediaSuccessCallbackResult;
  try {
    selected = await wx.chooseMedia({
      count: 1,
      mediaType: ["image"],
      sourceType: ["camera", "album"],
      sizeType: ["compressed"],
      camera: "back",
    });
  } catch (error) {
    if (/cancel/i.test(errorMessage(error))) {
      if (args.attemptId)
        recordPhotoEvent({
          attemptId: args.attemptId,
          stage: "select",
          outcome: "failure",
          startedAtMs,
          errorCategory: "cancelled",
          sanitizedErrMsg: "cancelled",
        });
      return null;
    }
    if (args.attemptId)
      recordPhotoEvent({
        attemptId: args.attemptId,
        stage: "select",
        outcome: "failure",
        startedAtMs,
        error,
      });
    throw new ServiceError("INVALID_MEDIA", "没有取得照片，请重试");
  }
  const source = selected.tempFiles[0];
  if (!source?.tempFilePath) {
    if (args.attemptId)
      recordPhotoEvent({
        attemptId: args.attemptId,
        stage: "select",
        outcome: "failure",
        startedAtMs,
        errorCategory: "empty_selection",
        sanitizedErrMsg: "empty selection",
      });
    return null;
  }

  args.onSelected?.(source.tempFilePath);
  if (args.attemptId)
    recordPhotoEvent({
      attemptId: args.attemptId,
      stage: "select",
      outcome: "success",
      startedAtMs,
      rawByteSize: source.size,
    });
  let tempFilePath = source.tempFilePath;
  const compressStartedAtMs = Date.now();
  if (args.attemptId)
    recordPhotoEvent({
      attemptId: args.attemptId,
      stage: "compress",
      startedAtMs: compressStartedAtMs,
      outcome: "start",
    });
  try {
    let dimensions: { compressedWidth?: number; compressedHeight?: number } =
      {};
    try {
      const info = await wx.getImageInfo({ src: source.tempFilePath });
      const edge = Math.max(info.width, info.height);
      if (edge > TARGET_PHOTO_EDGE) {
        const scale = TARGET_PHOTO_EDGE / edge;
        dimensions = {
          compressedWidth: Math.max(1, Math.round(info.width * scale)),
          compressedHeight: Math.max(1, Math.round(info.height * scale)),
        };
      }
    } catch {
      /* Quality compression still works when metadata is unavailable. */
    }
    const compressed = await wx.compressImage({
      src: source.tempFilePath,
      quality: PHOTO_QUALITY,
      ...dimensions,
    });
    tempFilePath = compressed.tempFilePath;
    if (args.attemptId)
      recordPhotoEvent({
        attemptId: args.attemptId,
        stage: "compress",
        startedAtMs: compressStartedAtMs,
        outcome: "success",
      });
  } catch (error) {
    if (args.attemptId)
      recordPhotoEvent({
        attemptId: args.attemptId,
        stage: "compress",
        startedAtMs: compressStartedAtMs,
        outcome: "unknown",
        error,
      });
    // Some already-compressed image formats cannot be compressed again. The
    // byte limit below remains authoritative before any upload is attempted.
  }
  const statStartedAtMs = Date.now();
  try {
    if (args.attemptId)
      recordPhotoEvent({
        attemptId: args.attemptId,
        stage: "stat",
        outcome: "start",
        startedAtMs: statStartedAtMs,
      });
  } catch {
    // Diagnostics must not affect the native file operation.
  }
  let byteSize = await fileSize(tempFilePath).catch(() => source.size);
  if (byteSize > 300 * 1024) {
    try {
      const info = await wx.getImageInfo({ src: tempFilePath });
      const scale = Math.min(1, 960 / Math.max(info.width, info.height));
      const smaller = await wx.compressImage({
        src: tempFilePath,
        quality: 55,
        compressedWidth: Math.max(1, Math.round(info.width * scale)),
        compressedHeight: Math.max(1, Math.round(info.height * scale)),
      });
      const smallerBytes = await fileSize(smaller.tempFilePath);
      if (smallerBytes > 0 && smallerBytes < byteSize) {
        tempFilePath = smaller.tempFilePath;
        byteSize = smallerBytes;
      }
    } catch {
      /* Keep the first valid compression. */
    }
  }
  if (args.attemptId)
    recordPhotoEvent({
      attemptId: args.attemptId,
      stage: "stat",
      outcome: "success",
      startedAtMs: statStartedAtMs,
      rawByteSize: byteSize,
    });
  if (!Number.isFinite(byteSize) || byteSize <= 0) {
    throw new ServiceError("INVALID_MEDIA", "照片文件无效，请重新选择");
  }
  if (byteSize > MAX_PHOTO_BYTES) {
    throw new ServiceError(
      "PAYLOAD_TOO_LARGE",
      "照片压缩后仍超过 2MB，请靠近药盒重新拍摄",
    );
  }
  return { tempFilePath, byteSize };
};

const readPhotoBase64 = async (filePath: string): Promise<string> =>
  new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath,
      encoding: "base64",
      success: (result) =>
        typeof result.data === "string"
          ? resolve(result.data)
          : reject(
              new ServiceError("INVALID_MEDIA", "照片文件无法读取，请重新选择"),
            ),
      fail: () =>
        reject(
          new ServiceError("INVALID_MEDIA", "照片文件无法读取，请重新选择"),
        ),
    });
  });

const saveLocalPhoto = async (tempFilePath: string): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    wx.getFileSystemManager().saveFile({
      tempFilePath,
      success: (result) => resolve(result.savedFilePath),
      fail: reject,
    });
  });

const discardTicket = async (
  service: DataService,
  ticket: MedicationPhotoUploadTicket,
  context?: PhotoRpcContext,
): Promise<void> => {
  if (context)
    await service.discardMedicationPhoto(ticket.mediaId, null, context);
  else await service.discardMedicationPhoto(ticket.mediaId, null);
};

export const stageMedicationPhoto = async (args: {
  service: DataService;
  medicationId: string;
  expectedVersion: number;
  tempFilePath: string;
  attemptId?: string;
  ticket?: MedicationPhotoUploadTicket;
  deadlineAt?: number;
  requestId?: string;
  onTicket?: (ticket: MedicationPhotoUploadTicket) => void;
}): Promise<StagedMedicationPhoto> => {
  const rpc = (stage: PhotoRpcContext["stage"]): PhotoRpcContext | undefined =>
    args.attemptId
      ? {
          attemptId: args.attemptId,
          stage,
          deadlineAt: args.deadlineAt,
          requestId: args.requestId ? `${args.requestId}:${stage}` : undefined,
          transport: "relay",
        }
      : undefined;
  const prepareContext = rpc("prepare");
  const ticket =
    args.ticket ??
    (await (prepareContext
      ? args.service.prepareMedicationPhoto(
          args.medicationId,
          args.expectedVersion,
          prepareContext,
        )
      : args.service.prepareMedicationPhoto(
          args.medicationId,
          args.expectedVersion,
        )));
  args.onTicket?.(ticket);
  const statStartedAtMs = Date.now();
  const byteSize = await fileSize(args.tempFilePath).catch(() => 0);
  if (args.attemptId)
    recordPhotoEvent({
      ...rpc("stat")!,
      outcome: byteSize > 0 ? "success" : "failure",
      startedAtMs: statStartedAtMs,
      rawByteSize: byteSize,
      ...(byteSize > 0
        ? {}
        : {
            errorCategory: "file_unreadable",
            sanitizedErrMsg: "file info failed",
          }),
    });
  const expiresAtMs = Date.parse(ticket.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    await discardTicket(args.service, ticket, rpc("discard")).catch(
      () => undefined,
    );
    throw new ServiceError("INVALID_MEDIA", "照片上传任务已过期，请重新选择");
  }
  if (
    !Number.isInteger(byteSize) ||
    byteSize <= 0 ||
    !Number.isInteger(ticket.maxBytes) ||
    byteSize > ticket.maxBytes
  ) {
    await discardTicket(args.service, ticket, rpc("discard")).catch(
      () => undefined,
    );
    throw new ServiceError(
      "PAYLOAD_TOO_LARGE",
      `照片超过 ${Math.max(1, Math.floor(ticket.maxBytes / 1024 / 1024))}MB，请重新拍摄`,
    );
  }
  if (ticket.transport === "cloud" && !ticket.cloudPath) {
    await discardTicket(args.service, ticket, rpc("discard")).catch(
      () => undefined,
    );
    throw new ServiceError(
      "MEDIA_UNAVAILABLE",
      "照片上传配置不完整，请稍后重试",
    );
  }
  try {
    let fileId: string;
    if (ticket.transport === "cloud") {
      const directFileId =
        ticket.protocol === "chunks-v2"
          ? null
          : await uploadPhotoDirectWithRetry({
              service: args.service,
              cloudPath: ticket.cloudPath!,
              filePath: args.tempFilePath,
              expiresAt: ticket.expiresAt,
              attemptId: args.attemptId,
              deadlineAt: args.deadlineAt,
            });
      if (directFileId) return { ticket, fileId: directFileId };
      if (!args.service.uploadMedicationPhoto) {
        throw new ServiceError(
          "NETWORK",
          "照片上传暂时不可用，请稍后重试",
          true,
          "unknown",
        );
      }
      if (Date.parse(ticket.expiresAt) <= Date.now())
        throw new ServiceError(
          "MEDIA_UPLOAD_EXPIRED",
          "照片上传任务已过期，请重新选择",
          false,
        );
      // Every transport uses the same immutable local file and ticket. Aborted
      // direct writes may finish late, but contain the identical photo bytes.
      const readStartedAtMs = Date.now();
      if (args.attemptId)
        recordPhotoEvent({
          ...rpc("read_base64")!,
          outcome: "start",
          startedAtMs: readStartedAtMs,
          rawByteSize: byteSize,
        });
      const base64 = await readPhotoBase64(args.tempFilePath).catch((error) => {
        if (args.attemptId)
          recordPhotoEvent({
            ...rpc("read_base64")!,
            outcome: "failure",
            startedAtMs: readStartedAtMs,
            rawByteSize: byteSize,
            error,
          });
        throw error;
      });
      if (args.attemptId)
        recordPhotoEvent({
          ...rpc("read_base64")!,
          outcome: "success",
          startedAtMs: readStartedAtMs,
          rawByteSize: byteSize,
          base64Length: base64.length,
        });
      const input = {
        medicationId: args.medicationId,
        expectedVersion: args.expectedVersion,
        mediaId: ticket.mediaId,
        base64,
      };
      const uploaded = await (args.attemptId
        ? args.service.uploadMedicationPhoto(input, {
            ...rpc("upload_rpc")!,
            completePhoto: ticket.protocol === "chunks-v2",
            rawByteSize: byteSize,
            base64Length: base64.length,
          })
        : args.service.uploadMedicationPhoto(input));
      fileId = uploaded.fileId;
      if (uploaded.completedState)
        return { ticket, fileId, completedState: uploaded.completedState };
    } else {
      fileId = await saveLocalPhoto(args.tempFilePath);
    }
    if (typeof fileId !== "string" || !fileId) {
      throw new Error("EMPTY_PHOTO_FILE_ID");
    }
    return { ticket, fileId };
  } catch (error) {
    const pending = { ticket, tempFilePath: args.tempFilePath };
    if (error instanceof ServiceError && error.outcome === "unknown") {
      throw new PhotoOperationError(
        error.code,
        error.message,
        pending,
        error.rawError ?? error,
      );
    }
    const cleanup = rpc("discard");
    await (
      cleanup
        ? args.service.discardMedicationPhoto(ticket.mediaId, null, cleanup)
        : args.service.discardMedicationPhoto(ticket.mediaId, null)
    ).catch((cleanupError) => {
      if (args.attemptId)
        recordPhotoEvent({
          ...rpc("discard")!,
          outcome: "failure",
          error: cleanupError,
        });
    });
    if (error instanceof ServiceError) throw error;
    throw new ServiceError(
      "NETWORK",
      /timeout|timed\s*out/i.test(errorMessage(error))
        ? "照片上传超时，请稍后重试"
        : "照片上传失败，请检查网络后重试",
    );
  }
};

export const commitStagedMedicationPhoto = async (args: {
  service: DataService;
  medicationId: string;
  expectedVersion: number;
  staged: StagedMedicationPhoto;
  attemptId?: string;
  deadlineAt?: number;
  requestId?: string;
}): Promise<AppState> => {
  if (args.staged.completedState) return args.staged.completedState;
  const context = args.attemptId
    ? {
        attemptId: args.attemptId,
        stage: "commit" as const,
        deadlineAt: args.deadlineAt,
        requestId: args.requestId,
        transport: "relay" as const,
      }
    : undefined;
  const commitInput = {
    medicationId: args.medicationId,
    expectedVersion: args.expectedVersion,
    mediaId: args.staged.ticket.mediaId,
    fileId: args.staged.fileId,
  };
  return (
    context
      ? args.service.commitMedicationPhoto(commitInput, context)
      : args.service.commitMedicationPhoto(commitInput)
  ).catch((error) => {
    if (error instanceof ServiceError && error.outcome === "unknown") {
      throw new PhotoOperationError(
        error.code,
        error.message,
        {
          ticket: args.staged.ticket,
          tempFilePath: "",
          staged: args.staged,
        },
        error.rawError ?? error,
      );
    }
    throw error;
  });
};

export const discardStagedMedicationPhoto = async (
  service: DataService,
  staged: StagedMedicationPhoto,
  attemptId?: string,
): Promise<void> => {
  if (attemptId) {
    await service.discardMedicationPhoto(staged.ticket.mediaId, staged.fileId, {
      attemptId,
      stage: "discard",
      transport: "relay",
    });
  } else {
    await service.discardMedicationPhoto(staged.ticket.mediaId, staged.fileId);
  }
};

export const PHOTO_LIMITS = {
  maxBytes: MAX_PHOTO_BYTES,
  targetEdge: TARGET_PHOTO_EDGE,
  quality: PHOTO_QUALITY,
} as const;
