"use strict";

const { fail } = require("./errors");
const v = require("./validation");
const { deterministicId } = require("./hash");
const CHUNK_LENGTH = 48 * 1024;
const MAX_BASE64_LENGTH = 2796204;

function parsePhotoChunks(payload, withChunk) {
  v.keys(payload, [
    "medicationId",
    "expectedVersion",
    "mediaId",
    "totalLength",
    ...(withChunk ? ["index", "base64"] : []),
  ]);
  const totalLength = payload.totalLength;
  if (
    !Number.isInteger(totalLength) ||
    totalLength < 4 ||
    totalLength > MAX_BASE64_LENGTH ||
    totalLength % 4
  )
    fail("PAYLOAD_TOO_LARGE", "照片数据大小无效");
  const result = {
    medicationId: v.id(payload.medicationId, "medicationId"),
    expectedVersion: v.expectedVersion(payload.expectedVersion),
    mediaId: v.id(payload.mediaId, "mediaId"),
    totalLength,
  };
  if (withChunk) {
    const { index, base64 } = payload;
    const count = Math.ceil(totalLength / CHUNK_LENGTH);
    if (!Number.isInteger(index) || index < 0 || index >= count)
      fail("INVALID_MEDIA", "照片分块序号无效");
    const length = Math.min(CHUNK_LENGTH, totalLength - index * CHUNK_LENGTH);
    if (
      typeof base64 !== "string" ||
      base64.length !== length ||
      Buffer.from(base64, "base64").toString("base64") !== base64 ||
      (index < count - 1 && base64.includes("="))
    )
      fail("INVALID_MEDIA", "照片分块数据无效");
    Object.assign(result, { index, base64 });
  }
  return result;
}

const chunkId = (mediaId, index) =>
  deterministicId("photochunk", mediaId, String(index));

async function ownedTicket(service, payload, context) {
  const medication = await service.store.getOwned(
    "medications",
    payload.medicationId,
    context.accountId,
  );
  const media = await service.store.getOwned(
    "media",
    payload.mediaId,
    context.accountId,
  );
  if (medication.status !== "active")
    fail("MEDICATION_ARCHIVED", "只有正在管理的药盒可以添加照片");
  if (medication.version !== payload.expectedVersion)
    fail("VERSION_CONFLICT", "药盒已在其他设备更新，请刷新后重试");
  if (
    media.kind !== "medication-photo" ||
    media.medicationId !== medication._id ||
    !["prepared", "uploaded"].includes(media.status)
  )
    fail("INVALID_MEDIA_STATE", "照片上传任务已经失效，请重新选择");
  if (media.expiresAt <= service.now())
    fail("MEDIA_UPLOAD_EXPIRED", "照片上传已超时，请重新选择");
  return media;
}

async function putPhotoChunk(service, payload, context) {
  const media = await ownedTicket(service, payload, context);
  const id = chunkId(media._id, payload.index);
  const existing = await service.store.getOwned(
    "media",
    id,
    context.accountId,
    { required: false },
  );
  if (existing) {
    if (
      existing.base64 !== payload.base64 ||
      existing.totalLength !== payload.totalLength
    )
      fail("INVALID_MEDIA_STATE", "照片分块与原上传不一致，请重新选择");
    return { accepted: true };
  }
  if (media.status !== "prepared")
    fail("INVALID_MEDIA_STATE", "照片已经上传完成");
  const now = service.now();
  await service.store.createOwned("media", {
    _id: id,
    accountId: context.accountId,
    medicationId: payload.medicationId,
    kind: "medication-photo-chunk",
    parentMediaId: media._id,
    index: payload.index,
    totalLength: payload.totalLength,
    base64: payload.base64,
    status: "prepared",
    expiresAt: media.expiresAt,
    leaseUntil: media.leaseUntil,
    fileId: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
    lastRequestId: context.requestId,
  });
  return { accepted: true };
}

async function finishPhotoChunks(service, payload, context, complete = false) {
  if (complete) {
    const medication = await service.store.getOwned(
      "medications",
      payload.medicationId,
      context.accountId,
    );
    if (medication.status !== "active")
      fail("MEDICATION_ARCHIVED", "药盒已移除");
    if (medication.photo?.mediaId === payload.mediaId)
      return service.publicMedication(medication);
  }
  const media = await ownedTicket(service, payload, context);
  // Completed finalization can be recovered even after temporary chunks were removed.
  if (media.status === "uploaded" && media.fileId) {
    if (complete && media.sealedMetadata)
      return service.commitMedicationPhoto(
        { ...payload, fileId: media.fileId },
        context,
        media.sealedMetadata,
      );
    if (!complete) return { fileId: media.fileId };
  }
  const chunks = await Promise.all(
    Array.from(
      { length: Math.ceil(payload.totalLength / CHUNK_LENGTH) },
      (_, index) =>
        service.store.getOwned(
          "media",
          chunkId(media._id, index),
          context.accountId,
          { required: false },
        ),
    ),
  );
  if (
    chunks.some(
      (item, index) =>
        !item ||
        item.kind !== "medication-photo-chunk" ||
        item.parentMediaId !== media._id ||
        item.index !== index ||
        item.totalLength !== payload.totalLength,
    )
  )
    fail("INVALID_MEDIA", "照片分块尚未完整，请重试");
  const base64 = chunks.map((item) => item.base64).join("");
  if (
    base64.length !== payload.totalLength ||
    Buffer.byteLength(base64, "base64") > 2 * 1024 * 1024 ||
    Buffer.from(base64, "base64").toString("base64") !== base64
  )
    fail("INVALID_MEDIA", "照片合并数据无效");
  const result = await service.uploadMedicationPhoto(
    {
      medicationId: payload.medicationId,
      expectedVersion: payload.expectedVersion,
      mediaId: payload.mediaId,
      base64,
    },
    context,
    complete,
  );
  if (complete) {
    // Expiring chunk documents remain a durable cleanup queue. Do not wait for
    // many deletes before acknowledging the atomic photo attachment.
    return service.commitMedicationPhoto(
      { ...payload, fileId: result.fileId },
      context,
      result.inspected,
    );
  }
  // Chunks use the existing private media collection and expiry/deletion sweep.
  // Best-effort eager removal reduces retention without changing upload outcome.
  await Promise.all(
    chunks.map((item) =>
      service.store
        .removeOwnedVersioned(
          "media",
          item._id,
          context.accountId,
          item.version,
        )
        .catch(() => undefined),
    ),
  );
  return result;
}

module.exports = {
  CHUNK_LENGTH,
  parsePhotoChunks,
  putPhotoChunk,
  finishPhotoChunks,
  completePhotoChunks: (service, payload, context) =>
    finishPhotoChunks(service, payload, context, true),
};
