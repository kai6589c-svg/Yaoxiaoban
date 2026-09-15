"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const {
  MAX_PHOTO_BYTES,
  PhotoStorage,
  downloadBoundedImage,
  fileIdMatchesCloudPath,
  inspectImage,
} = require("../lib/photo-storage");

const CLOUD_PATH =
  "medication-photos/owner_0123456789abcdef/media_0123456789abcdef.jpg";
const FILE_ID = `cloud://prod-env.123456/${CLOUD_PATH}`;

async function photoServer(t, handler) {
  const sockets = new Set();
  const server = http.createServer(handler);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return (url, options, callback) => {
    const parsed = new URL(url);
    // Exercise the actual Node HTTP parser/stream locally while production still
    // only accepts HTTPS download URLs obtained from the trusted CloudBase SDK.
    return http.request(
      `http://127.0.0.1:${server.address().port}${parsed.pathname}${parsed.search}`,
      options,
      callback,
    );
  };
}

function cloudStorage(readRemoteImage) {
  const calls = { tempFileLists: [], urls: [], deletions: [] };
  const storage = new PhotoStorage(
    {
      async getTempFileURL({ fileList }) {
        calls.tempFileLists.push(fileList);
        return {
          fileList: [{ status: 0, tempFileURL: "https://media.test/photo" }],
        };
      },
      async deleteFile({ fileList }) {
        calls.deletions.push(fileList);
        return { fileList: [{ status: 0 }] };
      },
    },
    {
      readRemoteImage: async (url) => {
        calls.urls.push(url);
        return readRemoteImage(url);
      },
    },
  );
  return { storage, calls };
}

function validOnePixelPng() {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
}

test("云文件 ID 只匹配完整且精确相等的对象路径", () => {
  assert.equal(fileIdMatchesCloudPath(FILE_ID, CLOUD_PATH), true);

  const nonMatchingCases = [
    [`cloud://prod-env.123456/prefix/${CLOUD_PATH}`, CLOUD_PATH],
    [`${FILE_ID}.bak`, CLOUD_PATH],
    [`${FILE_ID}/thumbnail`, CLOUD_PATH],
    [`${FILE_ID}?download=1`, CLOUD_PATH],
    [`${FILE_ID}#preview`, CLOUD_PATH],
    ["https://example.test/" + CLOUD_PATH, CLOUD_PATH],
    [`cloud:///` + CLOUD_PATH, CLOUD_PATH],
    [`cloud://bad authority/${CLOUD_PATH}`, CLOUD_PATH],
    [FILE_ID, `../${CLOUD_PATH}`],
    [FILE_ID, CLOUD_PATH.replace("/media_", "//media_")],
    [FILE_ID, CLOUD_PATH.replace("/media_", "/./media_")],
  ];

  for (const [fileId, cloudPath] of nonMatchingCases) {
    assert.equal(
      fileIdMatchesCloudPath(fileId, cloudPath),
      false,
      `${fileId} 不应匹配 ${cloudPath}`,
    );
  }
});

test("只有魔数、低于最小长度或声明超出缓冲区的伪图片会被拒绝", () => {
  const shortJpeg = Buffer.alloc(63);
  shortJpeg.set([0xff, 0xd8, 0xff], 0);
  shortJpeg.set([0xff, 0xd9], shortJpeg.length - 2);

  const truncatedJpeg = Buffer.alloc(64);
  truncatedJpeg.set([0xff, 0xd8, 0xff, 0xc0], 0);
  truncatedJpeg.writeUInt16BE(0xffff, 4);
  truncatedJpeg.set([0xff, 0xd9], truncatedJpeg.length - 2);

  const shortPng = Buffer.alloc(44);
  shortPng.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  shortPng.writeUInt32BE(13, 8);
  shortPng.write("IHDR", 12, "ascii");
  shortPng.writeUInt32BE(1, 16);
  shortPng.writeUInt32BE(1, 20);

  const truncatedWebp = Buffer.alloc(30);
  truncatedWebp.write("RIFF", 0, "ascii");
  truncatedWebp.writeUInt32LE(100, 4);
  truncatedWebp.write("WEBP", 8, "ascii");
  truncatedWebp.write("VP8X", 12, "ascii");

  const cases = [
    ["JPEG 魔数", Buffer.from([0xff, 0xd8, 0xff, 0xd9])],
    ["低于最小长度的 JPEG", shortJpeg],
    ["段长越界的 JPEG", truncatedJpeg],
    ["PNG 魔数", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ["被截断的 PNG", shortPng],
    ["WebP 魔数", Buffer.from("RIFF\u0000\u0000\u0000\u0000WEBP", "binary")],
    ["块长越界的 WebP", truncatedWebp],
  ];

  for (const [label, content] of cases) {
    assert.equal(inspectImage(content), null, label);
  }
});

test("下载到的截断伪图片会报 INVALID_MEDIA 并清理远程文件", async () => {
  const truncatedPng = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  const { storage, calls } = cloudStorage(async () => truncatedPng);

  await assert.rejects(
    () => storage.inspectOwnedImage(FILE_ID, CLOUD_PATH),
    (error) => error.code === "INVALID_MEDIA",
  );
  assert.deepEqual(calls.deletions, [[FILE_ID, `${FILE_ID}.thumb.jpg`]]);
});

test("使用 GET 原样读取签名下载 URL，合法照片只下载一次", async (t) => {
  const received = [];
  const content = validOnePixelPng();
  const request = await photoServer(t, (req, res) => {
    received.push({ method: req.method, url: req.url });
    // Model a method-bound download signature: HEAD is forbidden.
    if (req.method !== "GET") {
      res.writeHead(403).end();
      return;
    }
    res.writeHead(200, { "Content-Length": content.length });
    res.end(content);
  });
  const signedUrl = "https://media.test/photo?q-signature=kept%2Funchanged";
  const { storage, calls } = cloudStorage(() =>
    downloadBoundedImage(signedUrl, { request }),
  );
  assert.deepEqual(await storage.inspectOwnedImage(FILE_ID, CLOUD_PATH), {
    byteSize: content.length,
    mimeType: "image/png",
    width: 1,
    height: 1,
  });
  assert.deepEqual(received, [
    { method: "GET", url: "/photo?q-signature=kept%2Funchanged" },
  ]);
  assert.deepEqual(calls.tempFileLists, [[FILE_ID]]);
  assert.deepEqual(calls.deletions, []);
});

test("Content-Length 超过 2MiB 时不等待正文，关闭连接并清理对象", async (t) => {
  let connectionClosed;
  const request = await photoServer(t, (req, res) => {
    connectionClosed = once(req.socket, "close");
    res.writeHead(200, { "Content-Length": MAX_PHOTO_BYTES + 1 });
    res.flushHeaders();
  });
  const { storage, calls } = cloudStorage((url) =>
    downloadBoundedImage(url, { request }),
  );
  await assert.rejects(
    () => storage.inspectOwnedImage(FILE_ID, CLOUD_PATH),
    (error) => error.code === "PAYLOAD_TOO_LARGE",
  );
  await connectionClosed;
  assert.deepEqual(calls.tempFileLists, [[FILE_ID]]);
  assert.deepEqual(calls.urls, ["https://media.test/photo"]);
  assert.deepEqual(calls.deletions, [[FILE_ID, `${FILE_ID}.thumb.jpg`]]);
});

test("2MiB 整数边界可以完整读取", async (t) => {
  const content = Buffer.alloc(MAX_PHOTO_BYTES, 1);
  const request = await photoServer(t, (_req, res) => {
    res.writeHead(200, { "Content-Length": content.length });
    res.end(content);
  });
  assert.deepEqual(
    await downloadBoundedImage("https://media.test/photo", { request }),
    content,
  );
});

test("缺失 Content-Length 的分块合法图片按实际字节检查", async (t) => {
  const content = validOnePixelPng();
  const request = await photoServer(t, (_req, res) => {
    res.writeHead(200, { "Transfer-Encoding": "chunked" });
    res.write(content.subarray(0, 10));
    res.end(content.subarray(10));
  });
  const { storage, calls } = cloudStorage((url) =>
    downloadBoundedImage(url, { request }),
  );
  assert.deepEqual(await storage.inspectOwnedImage(FILE_ID, CLOUD_PATH), {
    byteSize: content.length,
    mimeType: "image/png",
    width: 1,
    height: 1,
  });
  assert.deepEqual(calls.deletions, []);
});

test("分块正文累计超过 2MiB 即中止，不等无限正文结束", async (t) => {
  let connectionClosed;
  const request = await photoServer(t, (req, res) => {
    connectionClosed = once(req.socket, "close");
    res.writeHead(200, { "Transfer-Encoding": "chunked" });
    res.write(Buffer.alloc(MAX_PHOTO_BYTES / 2));
    res.write(Buffer.alloc(MAX_PHOTO_BYTES / 2));
    res.write(Buffer.alloc(1));
    // Deliberately never end: only the cumulative byte limit can finish this.
  });
  const { storage, calls } = cloudStorage((url) =>
    downloadBoundedImage(url, { request }),
  );
  await assert.rejects(
    () => storage.inspectOwnedImage(FILE_ID, CLOUD_PATH),
    (error) => error.code === "PAYLOAD_TOO_LARGE",
  );
  await connectionClosed;
  assert.deepEqual(calls.deletions, [[FILE_ID, `${FILE_ID}.thumb.jpg`]]);
});

test("拒绝 403、重定向和部分响应，404 明确报告文件未就绪", async (t) => {
  for (const status of [403, 302, 206, 404]) {
    await t.test(`HTTP ${status}`, async (child) => {
      const request = await photoServer(child, (_req, res) => {
        res.writeHead(status, { Location: "https://other.test/photo" });
        res.end(validOnePixelPng());
      });
      const { storage, calls } = cloudStorage((url) =>
        downloadBoundedImage(url, { request }),
      );
      await assert.rejects(
        () => storage.inspectOwnedImage(FILE_ID, CLOUD_PATH),
        (error) =>
          error.code ===
          (status === 404 ? "MEDIA_NOT_FOUND" : "MEDIA_UNAVAILABLE"),
      );
      assert.deepEqual(calls.deletions, [], "临时读取失败应保留已上传对象");
    });
  }
});

test("绝对超时会终止无响应连接和持续慢速分块连接", async (t) => {
  for (const mode of ["no-headers", "slow-stream"]) {
    await t.test(mode, async (child) => {
      let connectionClosed;
      const request = await photoServer(child, (req, res) => {
        // A deliberate client abort can emit ECONNRESET before close. The
        // assertion observes closure, not the server-side reset notification.
        connectionClosed = new Promise((resolve) => {
          req.socket.on("error", () => {});
          req.socket.once("close", resolve);
        });
        if (mode === "slow-stream") {
          res.writeHead(200, { "Transfer-Encoding": "chunked" });
          const interval = setInterval(() => res.write("x"), 5);
          req.socket.on("close", () => clearInterval(interval));
        }
      });
      const { storage, calls } = cloudStorage((url) =>
        downloadBoundedImage(url, { request, timeoutMs: 80 }),
      );
      await assert.rejects(
        () => storage.inspectOwnedImage(FILE_ID, CLOUD_PATH),
        (error) => error.code === "MEDIA_UNAVAILABLE",
      );
      await connectionClosed;
      assert.deepEqual(calls.deletions, []);
    });
  }
});

test("空正文和提前断开的正文不能被当成完整图片", async (t) => {
  for (const mode of ["empty", "truncated"]) {
    await t.test(mode, async (child) => {
      const request = await photoServer(child, (_req, res) => {
        if (mode === "empty") {
          res.writeHead(200, { "Content-Length": 0 }).end();
        } else {
          res.writeHead(200, { "Content-Length": 1000 });
          res.write(validOnePixelPng());
          res.socket.end();
        }
      });
      await assert.rejects(
        () => downloadBoundedImage("https://media.test/photo", { request }),
        (error) =>
          error.code ===
          (mode === "empty" ? "INVALID_MEDIA" : "MEDIA_UNAVAILABLE"),
      );
    });
  }
});

test("非 HTTPS 下载地址在发出请求之前拒绝", async () => {
  let requests = 0;
  await assert.rejects(
    () =>
      downloadBoundedImage("http://media.test/photo", {
        request() {
          requests += 1;
        },
      }),
    (error) => error.code === "MEDIA_UNAVAILABLE",
  );
  assert.equal(requests, 0);
});

test("云删除只把明确成功或已不存在视为成功，其他响应一律 fail-closed", async (t) => {
  for (const status of [0, -1]) {
    await t.test(`status=${status} 可以完成删除`, async () => {
      const storage = new PhotoStorage({
        async deleteFile() {
          return { fileList: [{ status }] };
        },
      });
      await assert.doesNotReject(() => storage.deleteFile(FILE_ID));
    });
  }

  const ambiguousResponses = [
    undefined,
    {},
    { fileList: [] },
    { fileList: [{}] },
    { fileList: [{ status: 1 }] },
    { fileList: [{ status: "0" }] },
  ];
  for (const [index, response] of ambiguousResponses.entries()) {
    await t.test(`不明确响应 ${index + 1} 被拒绝`, async () => {
      const storage = new PhotoStorage({
        async deleteFile() {
          return response;
        },
      });
      await assert.rejects(
        () => storage.deleteFile(FILE_ID),
        (error) => error.message === "PHOTO_DELETE_FAILED",
      );
    });
  }
});

test("云函数中转在写入前验证图片和大小", async () => {
  let writes = 0;
  const photoStorage = new PhotoStorage({
    uploadFile: async ({ cloudPath, fileContent }) => {
      writes++;
      assert.ok(Buffer.isBuffer(fileContent));
      return { fileID: `cloud://prod-env.123456/${cloudPath}` };
    },
  });
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  assert.equal(await photoStorage.uploadImage(CLOUD_PATH, png), FILE_ID);
  await assert.rejects(
    photoStorage.uploadImage(CLOUD_PATH, Buffer.from("not an image")),
    { code: "INVALID_MEDIA" },
  );
  await assert.rejects(
    photoStorage.uploadImage(CLOUD_PATH, Buffer.alloc(MAX_PHOTO_BYTES + 1)),
    { code: "PAYLOAD_TOO_LARGE" },
  );
  assert.equal(writes, 1);
});
