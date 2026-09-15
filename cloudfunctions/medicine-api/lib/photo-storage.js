"use strict";

const https = require("node:https");
const { AppError, fail, isAppError } = require("./errors");

const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const MAX_PHOTO_EDGE = 6000;
const MAX_PHOTO_PIXELS = 20_000_000;
const PHOTO_DOWNLOAD_TIMEOUT_MS = 10_000;

class PhotoStorage {
  constructor(cloud, options = {}) {
    this.cloud = cloud;
    this.readRemoteImage = options.readRemoteImage ?? downloadBoundedImage;
    this.viewUrls = new Map();
    this.clock = options.clock ?? Date.now;
  }

  async uploadImage(cloudPath, content) {
    if (!Buffer.isBuffer(content) || content.length === 0)
      fail("INVALID_MEDIA", "照片文件无效，请重新选择");
    if (content.length > MAX_PHOTO_BYTES)
      fail("PAYLOAD_TOO_LARGE", "照片压缩后仍超过 2MB，请重新拍摄");
    const inspected = inspectImage(content);
    if (
      !inspected ||
      inspected.width > MAX_PHOTO_EDGE ||
      inspected.height > MAX_PHOTO_EDGE ||
      inspected.width * inspected.height > MAX_PHOTO_PIXELS
    )
      fail("INVALID_MEDIA", "照片格式或尺寸无效，请重新选择");
    try {
      const result = await this.cloud.uploadFile({
        cloudPath,
        fileContent: content,
      });
      if (!fileIdMatchesCloudPath(result?.fileID, cloudPath))
        throw new Error("INVALID_UPLOAD_RESULT");
      return result.fileID;
    } catch (_) {
      fail("MEDIA_UNAVAILABLE", "照片上传暂时失败，请稍后重试");
    }
  }

  async inspectOwnedImage(fileId, cloudPath, { retryThumbnail = false } = {}) {
    if (!fileIdMatchesCloudPath(fileId, cloudPath)) {
      fail("FORBIDDEN", "照片不属于当前上传任务");
    }
    const url = await this.getDownloadUrl(fileId);
    let content;
    try {
      content = await this.readRemoteImage(url);
    } catch (error) {
      if (isAppError(error)) {
        if (error.code === "PAYLOAD_TOO_LARGE")
          await this.deleteFile(fileId).catch(() => {});
        throw error;
      }
      fail("MEDIA_UNAVAILABLE", "照片校验暂时失败，请稍后重试");
    }
    if (!Buffer.isBuffer(content) || content.length === 0) {
      fail("INVALID_MEDIA", "照片文件无效，请重新选择");
    }
    if (content.length > MAX_PHOTO_BYTES) {
      await this.deleteFile(fileId).catch(() => {});
      fail("PAYLOAD_TOO_LARGE", "照片压缩后仍超过 2MB，请重新拍摄");
    }
    const inspected = inspectImage(content);
    if (!inspected) {
      await this.deleteFile(fileId).catch(() => {});
      fail("INVALID_MEDIA", "照片不是完整的 JPG、PNG 或 WebP 图片");
    }
    if (
      inspected.width > MAX_PHOTO_EDGE ||
      inspected.height > MAX_PHOTO_EDGE ||
      inspected.width * inspected.height > MAX_PHOTO_PIXELS
    ) {
      await this.deleteFile(fileId).catch(() => {});
      fail("INVALID_MEDIA", "照片像素尺寸过大，请重新拍摄");
    }
    let thumbnailFileId;
    let thumbnailByteSize = 0;
    const thumbnailStartedAtMs = Date.now();
    // Derive from the same validated bytes, never from a second client input.
    // The optional thumbnail cannot turn a successful main upload into failure.
    try {
      const thumbnail = require("./photo-thumbnail").createThumbnail(
        content,
        inspected,
      );
      if (thumbnail && thumbnail.length < content.length) {
        thumbnailByteSize = thumbnail.length;
        thumbnailFileId = await this.uploadImage(
          `${cloudPath}.thumb.jpg`,
          thumbnail,
        );
      }
    } catch (error) {
      if (
        retryThumbnail &&
        isAppError(error) &&
        error.code === "MEDIA_UNAVAILABLE"
      )
        throw error;
      /* Unsupported images retain their validated medium preview. */
    }
    return {
      ...(thumbnailFileId
        ? {
            thumbnailFileId,
            thumbnailByteSize,
            thumbnailMs: Date.now() - thumbnailStartedAtMs,
          }
        : {}),
      byteSize: content.length,
      mimeType: inspected.mimeType,
      width: inspected.width,
      height: inspected.height,
    };
  }

  async getDownloadUrl(fileId) {
    if (typeof this.cloud.getTempFileURL !== "function") {
      fail("MEDIA_UNAVAILABLE", "照片预检服务暂时不可用");
    }
    let result;
    try {
      result = await this.cloud.getTempFileURL({ fileList: [fileId] });
    } catch (_) {
      fail("MEDIA_UNAVAILABLE", "照片预检服务暂时不可用");
    }
    const item = result?.fileList?.[0];
    const url = item?.tempFileURL;
    if (!item || item.status !== 0 || typeof url !== "string" || !url) {
      fail("MEDIA_NOT_FOUND", "照片上传未完成，请重新选择");
    }
    return url;
  }

  async getViewUrl(fileId) {
    // The client receives only this short-lived URL. Permanent cloud file IDs
    // remain inside the service and are never exported or logged.
    const cached = this.viewUrls.get(fileId);
    if (cached && cached.expiresAt > this.clock()) return cached.url;
    // Coalesce concurrent requests for the same private object. Cache only in
    // this cloud instance and for less than CloudBase's signed URL lifetime.
    if (cached?.pending) return cached.pending;
    const pending = this.getDownloadUrl(fileId);
    this.viewUrls.set(fileId, { pending });
    try {
      const url = await pending;
      this.viewUrls.delete(fileId);
      this.viewUrls.set(fileId, {
        url,
        expiresAt: this.clock() + 5 * 60 * 1000,
      });
      while (this.viewUrls.size > 200)
        this.viewUrls.delete(this.viewUrls.keys().next().value);
      return url;
    } catch (error) {
      this.viewUrls.delete(fileId);
      throw error;
    }
  }

  async deleteFile(fileId) {
    if (!fileId) return;
    // Companion paths are deterministic, so failed/ambiguous commits and the
    // existing maintenance/account-deletion flows also clean up thumbnails.
    const fileList = [fileId];
    if (/\/medication-photos\/[^/]+\/media_[^/]+\.jpg$/.test(fileId))
      fileList.push(`${fileId}.thumb.jpg`);
    for (const id of fileList) this.viewUrls.delete(id);
    const result = await this.cloud.deleteFile({ fileList });
    if (
      !result?.fileList?.length ||
      result.fileList.some((item) => item.status !== 0 && item.status !== -1)
    ) {
      throw new Error("PHOTO_DELETE_FAILED");
    }
  }
}

function downloadBoundedImage(url, options = {}) {
  const requestImage = options.request ?? https.request;
  const timeoutMs = options.timeoutMs ?? PHOTO_DOWNLOAD_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let request;
    let response;
    let timer;
    let settled = false;
    const chunks = [];
    let byteSize = 0;
    const unavailable = () =>
      new AppError("MEDIA_UNAVAILABLE", "照片校验暂时失败，请稍后重试");
    const tooLarge = () =>
      new AppError("PAYLOAD_TOO_LARGE", "照片压缩后仍超过 2MB，请重新拍摄");
    const invalid = () =>
      new AppError("INVALID_MEDIA", "照片文件不完整，请重新选择");
    const finish = (error, content) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chunks.length = 0;
      if (error) {
        response?.destroy();
        request?.destroy();
        reject(error);
      } else {
        resolve(content);
      }
    };
    try {
      if (new URL(url).protocol !== "https:") {
        finish(unavailable());
        return;
      }
      // CloudBase returns a signed download URL. The signature can bind the GET
      // method, so using HEAD on it can fail even when the photo was uploaded.
      // Read the image once, rejecting oversized headers and stopping the stream
      // as soon as its actual bytes exceed the limit (including chunked bodies).
      request = requestImage(url, { method: "GET" }, (incoming) => {
        response = incoming;
        if (settled) {
          incoming.destroy();
          return;
        }
        incoming.on("error", () => finish(unavailable()));
        incoming.on("aborted", () => finish(unavailable()));
        if (incoming.statusCode === 404) {
          finish(new AppError("MEDIA_NOT_FOUND", "照片上传未完成，请重新选择"));
          return;
        }
        // Do not treat redirects or partial/error responses as a complete image.
        if (incoming.statusCode !== 200) {
          finish(unavailable());
          return;
        }
        const rawLength = incoming.headers["content-length"];
        const declaredSize = rawLength === undefined ? null : Number(rawLength);
        if (
          rawLength !== undefined &&
          (typeof rawLength !== "string" ||
            !/^\d+$/.test(rawLength) ||
            !Number.isSafeInteger(declaredSize) ||
            declaredSize <= 0)
        ) {
          finish(invalid());
          return;
        }
        if (declaredSize > MAX_PHOTO_BYTES) {
          finish(tooLarge());
          return;
        }
        incoming.on("data", (chunk) => {
          if (settled) return;
          byteSize += chunk.length;
          if (byteSize > MAX_PHOTO_BYTES) {
            finish(tooLarge());
            return;
          }
          chunks.push(chunk);
        });
        incoming.on("end", () => {
          if (settled) return;
          if (
            !incoming.complete ||
            byteSize === 0 ||
            (declaredSize !== null && byteSize !== declaredSize)
          ) {
            finish(invalid());
            return;
          }
          finish(null, Buffer.concat(chunks, byteSize));
        });
      });
      request.on("error", () => finish(unavailable()));
      // An absolute deadline also covers DNS/TLS and slow continuous streams;
      // a socket inactivity timeout alone does not bound the cloud invocation.
      timer = setTimeout(() => finish(unavailable()), timeoutMs);
      request.end();
    } catch (_) {
      finish(unavailable());
    }
  });
}

function fileIdMatchesCloudPath(fileId, cloudPath) {
  if (typeof fileId !== "string" || typeof cloudPath !== "string") return false;
  if (!fileId.startsWith("cloud://")) return false;
  const normalized = cloudPath.replace(/^\/+/, "");
  if (
    !normalized ||
    normalized.includes("\\") ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    return false;
  }
  const locator = fileId.slice("cloud://".length);
  const separator = locator.indexOf("/");
  if (separator <= 0) return false;
  const authority = locator.slice(0, separator);
  const objectPath = locator.slice(separator + 1);
  return (
    /^[A-Za-z0-9._-]+$/.test(authority) &&
    !objectPath.includes("?") &&
    !objectPath.includes("#") &&
    objectPath === normalized
  );
}

function inspectImage(content) {
  return inspectJpeg(content) ?? inspectPng(content) ?? inspectWebp(content);
}

function inspectJpeg(content) {
  if (
    content.length < 64 ||
    content[0] !== 0xff ||
    content[1] !== 0xd8 ||
    content[2] !== 0xff ||
    content[content.length - 2] !== 0xff ||
    content[content.length - 1] !== 0xd9
  ) {
    return null;
  }
  const startOfFrame = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
    0xcf,
  ]);
  let offset = 2;
  while (offset + 8 < content.length) {
    if (content[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = content[offset + 1];
    offset += 2;
    if (marker === 0xd9 || marker === 0xda) break;
    if (
      marker === 0x00 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    )
      continue;
    if (offset + 2 > content.length) return null;
    const segmentLength = content.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > content.length)
      return null;
    if (startOfFrame.has(marker) && segmentLength >= 7) {
      const height = content.readUInt16BE(offset + 3);
      const width = content.readUInt16BE(offset + 5);
      return validDimensions(width, height)
        ? { mimeType: "image/jpeg", width, height }
        : null;
    }
    offset += segmentLength;
  }
  return null;
}

function inspectPng(content) {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  if (
    content.length < 45 ||
    !content.subarray(0, 8).equals(signature) ||
    content.readUInt32BE(8) !== 13 ||
    content.subarray(12, 16).toString("ascii") !== "IHDR" ||
    content
      .subarray(content.length - 8, content.length - 4)
      .toString("ascii") !== "IEND"
  ) {
    return null;
  }
  const width = content.readUInt32BE(16);
  const height = content.readUInt32BE(20);
  return validDimensions(width, height)
    ? { mimeType: "image/png", width, height }
    : null;
}

function inspectWebp(content) {
  if (
    content.length < 30 ||
    content.subarray(0, 4).toString("ascii") !== "RIFF" ||
    content.subarray(8, 12).toString("ascii") !== "WEBP" ||
    content.readUInt32LE(4) + 8 !== content.length
  ) {
    return null;
  }
  const chunk = content.subarray(12, 16).toString("ascii");
  let width = 0;
  let height = 0;
  if (chunk === "VP8X" && content.length >= 30) {
    width = 1 + readUInt24LE(content, 24);
    height = 1 + readUInt24LE(content, 27);
  } else if (chunk === "VP8L" && content.length >= 25 && content[20] === 0x2f) {
    const bits = content.readUInt32LE(21);
    width = (bits & 0x3fff) + 1;
    height = ((bits >>> 14) & 0x3fff) + 1;
  } else if (
    chunk === "VP8 " &&
    content.length >= 30 &&
    content[23] === 0x9d &&
    content[24] === 0x01 &&
    content[25] === 0x2a
  ) {
    width = content.readUInt16LE(26) & 0x3fff;
    height = content.readUInt16LE(28) & 0x3fff;
  }
  return validDimensions(width, height)
    ? { mimeType: "image/webp", width, height }
    : null;
}

function readUInt24LE(buffer, offset) {
  return (
    buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16)
  );
}

function validDimensions(width, height) {
  return (
    Number.isInteger(width) &&
    width > 0 &&
    Number.isInteger(height) &&
    height > 0
  );
}

function detectImageMime(content) {
  return inspectImage(content)?.mimeType ?? null;
}

module.exports = {
  MAX_PHOTO_BYTES,
  PhotoStorage,
  detectImageMime,
  fileIdMatchesCloudPath,
  downloadBoundedImage,
  inspectImage,
};
