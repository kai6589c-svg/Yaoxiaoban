"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const jpeg = require("jpeg-js");
const { createThumbnail } = require("../lib/photo-thumbnail");
const { PhotoStorage, inspectImage } = require("../lib/photo-storage");
const cloudPath = "medication-photos/owner_fixture/media_fixture.jpg";
const fileId = `cloud://test.env/${cloudPath}`;

function fixture() {
  const width = 960,
    height = 1280;
  const data = Buffer.alloc(width * height * 4, 255);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = (x * 7 + y * 3) % 256;
      data[i + 1] = (x + y * 5) % 256;
      data[i + 2] = x % 256;
    }
  return jpeg.encode({ data, width, height }, 72).data;
}
const medium = fixture();
test("竖图生成不超过 400px / 100KB 的有效 JPEG 缩略图，完整图字节不改变", () => {
  const original = Buffer.from(medium);
  const start = performance.now();
  const thumbnail = createThumbnail(medium, inspectImage(medium));
  const metadata = inspectImage(thumbnail);
  assert.equal(metadata.width, 300);
  assert.equal(metadata.height, 400);
  assert.ok(thumbnail.length < 100 * 1024);
  assert.ok(thumbnail.length < medium.length);
  assert.deepEqual(medium, original);
  console.log(
    JSON.stringify({
      case: "synthetic-portrait",
      mediumBytes: medium.length,
      thumbnailBytes: thumbnail.length,
      thumbnailMs: Math.round(performance.now() - start),
    }),
  );
});

test("超出解码预算或不支持格式跳过缩略图，不扩大图片尺寸", () => {
  assert.equal(
    createThumbnail(Buffer.alloc(0), {
      width: 6000,
      height: 6000,
      mimeType: "image/jpeg",
    }),
    null,
  );
  assert.equal(
    createThumbnail(Buffer.alloc(0), {
      width: 200,
      height: 200,
      mimeType: "image/webp",
    }),
    null,
  );
});

test("完整图只下载一次，缩略图来源相同；派生上传失败仍保留完整图", async () => {
  let reads = 0;
  let uploads = 0;
  const storage = new PhotoStorage(
    {
      getTempFileURL: async () => ({
        fileList: [{ status: 0, tempFileURL: "https://private.test/photo" }],
      }),
      uploadFile: async ({ cloudPath: path, fileContent }) => {
        uploads++;
        assert.ok(fileContent.length < medium.length);
        return { fileID: `cloud://test.env/${path}` };
      },
    },
    {
      readRemoteImage: async () => {
        reads++;
        return medium;
      },
    },
  );
  const result = await storage.inspectOwnedImage(fileId, cloudPath);
  assert.equal(reads, 1);
  assert.equal(uploads, 1);
  assert.equal(result.thumbnailFileId, `${fileId}.thumb.jpg`);
  storage.cloud.uploadFile = async () => {
    throw new Error("temporary");
  };
  const fallback = await storage.inspectOwnedImage(fileId, cloudPath);
  assert.equal(fallback.thumbnailFileId, undefined);
  assert.equal(fallback.width, 960);
});

test("私有地址并发合并、限时复用，过期后刷新；删除同时清理派生文件", async () => {
  let now = 0;
  let calls = 0;
  let deleted;
  const storage = new PhotoStorage(
    {
      getTempFileURL: async () => ({
        fileList: [
          { status: 0, tempFileURL: `https://private.test/${++calls}` },
        ],
      }),
      deleteFile: async ({ fileList }) => {
        deleted = fileList;
        return { fileList: fileList.map(() => ({ status: 0 })) };
      },
    },
    { clock: () => now },
  );
  const values = await Promise.all([
    storage.getViewUrl(fileId),
    storage.getViewUrl(fileId),
  ]);
  assert.equal(values[0], values[1]);
  assert.equal(calls, 1);
  assert.equal(await storage.getViewUrl(fileId), values[0]);
  now = 300001;
  await storage.getViewUrl(fileId);
  assert.equal(calls, 2);
  await storage.deleteFile(fileId);
  assert.deepEqual(deleted, [fileId, `${fileId}.thumb.jpg`]);
  await storage.getViewUrl(fileId);
  assert.equal(calls, 3);
});
