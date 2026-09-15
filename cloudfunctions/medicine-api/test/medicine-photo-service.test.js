"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { MAX_PHOTO_BYTES } = require("../lib/photo-storage");
const { MedicineService } = require("../lib/service");
const { deterministicId } = require("../lib/hash");
const { MemoryStore } = require("./support/memory-store");

const NOW = "2026-08-19T00:00:00.000Z";
const OWNER = "acct_photo_owner";
const OTHER_ACCOUNT = "acct_photo_other";

class FailureInjectingStore extends MemoryStore {
  failNextUpdateWhere(predicate, message) {
    this.updateFailure = { predicate, message };
  }

  async updateOwnedVersioned(
    key,
    id,
    accountId,
    expectedVersion,
    patch,
    now,
    requestId,
  ) {
    if (
      this.updateFailure &&
      this.updateFailure.predicate({ key, id, accountId, patch })
    ) {
      const { message } = this.updateFailure;
      this.updateFailure = null;
      throw new Error(message);
    }
    return super.updateOwnedVersioned(
      key,
      id,
      accountId,
      expectedVersion,
      patch,
      now,
      requestId,
    );
  }

  failNextAttach(message) {
    this.attachFailure = message;
  }

  async attachMedicationPhoto(args) {
    if (this.attachFailure) {
      const message = this.attachFailure;
      this.attachFailure = null;
      throw new Error(message);
    }
    return super.attachMedicationPhoto(args);
  }
}

class CleanupClaimRaceStore extends FailureInjectingStore {
  async updateOwnedVersioned(
    key,
    id,
    accountId,
    expectedVersion,
    patch,
    now,
    requestId,
  ) {
    if (key === "media" && patch.status === "cleanup_pending") {
      const current = await this.getOwned(key, id, accountId);
      this.bucket("media").set(id, {
        ...current,
        status: "cleanup_pending",
        version: current.version + 1,
      });
      throw new Error("CLEANUP_CLAIM_RACE");
    }
    return super.updateOwnedVersioned(
      key,
      id,
      accountId,
      expectedVersion,
      patch,
      now,
      requestId,
    );
  }
}

function medicationDocument(accountId, id) {
  return {
    _id: id,
    accountId,
    profileId: `profile_${accountId}`,
    name: "照片测试药盒",
    specification: null,
    unit: "片",
    expiry: null,
    openedOn: null,
    afterOpenDays: null,
    notes: null,
    photo: null,
    mode: "expiry_only",
    status: "active",
    archivedAt: null,
    activePlanId: null,
    version: 1,
    lastRequestId: "seed-request",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function fakePhotoStorage(overrides = {}) {
  const inspections = [];
  const deletions = [];
  return {
    inspections,
    deletions,
    async inspectOwnedImage(fileId, cloudPath) {
      inspections.push({ fileId, cloudPath });
      if (overrides.inspectOwnedImage) {
        return overrides.inspectOwnedImage(fileId, cloudPath);
      }
      return {
        byteSize: 1234,
        mimeType: "image/jpeg",
        width: 640,
        height: 480,
      };
    },
    async deleteFile(fileId) {
      deletions.push(fileId);
      if (overrides.deleteFile) return overrides.deleteFile(fileId);
    },
  };
}

async function fixture({
  store = new MemoryStore(),
  photoStorage = fakePhotoStorage(),
  logger = { warn() {} },
} = {}) {
  const medicationId = "med_photo_owner";
  await store.createOwned(
    "medications",
    medicationDocument(OWNER, medicationId),
  );
  const service = new MedicineService(store, {
    clock: () => new Date(NOW),
    logger,
    photoStorage,
  });
  return { store, service, photoStorage, medicationId };
}

function context(accountId, requestId) {
  return { accountId, requestId };
}

function assertErrorCode(expectedCode) {
  return (error) => error.code === expectedCode;
}

async function prepare(
  service,
  medicationId,
  requestId = "prepare-photo-0001",
) {
  return service.prepareMedicationPhoto(
    { medicationId, expectedVersion: 1 },
    context(OWNER, requestId),
  );
}

test("prepare 生成可重放的私有路径票据并持久化 prepared 媒体", async () => {
  const { store, service, medicationId } = await fixture();
  const requestId = "prepare-photo-0001";
  const expectedMediaId = deterministicId("media", OWNER, requestId);
  const expectedOwnerFolder = deterministicId("owner", OWNER);
  const expectedCloudPath = `medication-photos/${expectedOwnerFolder}/${expectedMediaId}.jpg`;

  const ticket = await prepare(service, medicationId, requestId);
  assert.deepEqual(ticket, {
    mediaId: expectedMediaId,
    cloudPath: expectedCloudPath,
    expiresAt: "2026-08-20T00:00:00.000Z",
    maxBytes: MAX_PHOTO_BYTES,
    transport: "cloud",
    protocol: "chunks-v2",
  });

  const media = await store.getOwned("media", expectedMediaId, OWNER);
  assert.deepEqual(media, {
    _id: expectedMediaId,
    accountId: OWNER,
    medicationId,
    kind: "medication-photo",
    cloudPath: expectedCloudPath,
    fileId: null,
    status: "prepared",
    leaseUntil: "2026-08-19T00:30:00.000Z",
    expiresAt: "2026-08-20T00:00:00.000Z",
    version: 1,
    lastRequestId: requestId,
    createdAt: NOW,
    updatedAt: NOW,
  });

  const replay = await prepare(service, medicationId, requestId);
  assert.deepEqual(replay, ticket);
  assert.equal(store.bucket("media").size, 1);
});

test("commit 绑定经检查的文件，remove 先去除药盒引用再清理媒体", async () => {
  const { store, service, photoStorage, medicationId } = await fixture();
  const ticket = await prepare(service, medicationId);
  const fileId = `cloud://prod-env.123456/${ticket.cloudPath}`;

  const committed = await service.commitMedicationPhoto(
    {
      medicationId,
      expectedVersion: 1,
      mediaId: ticket.mediaId,
      fileId,
    },
    context(OWNER, "commit-photo-0001"),
  );
  assert.deepEqual(committed.photo, {
    mediaId: ticket.mediaId,
    fileId,
    updatedAt: NOW,
  });
  assert.equal(committed.version, 2);
  assert.deepEqual(photoStorage.inspections, [
    { fileId, cloudPath: ticket.cloudPath },
  ]);

  const attachedMedia = await store.getOwned("media", ticket.mediaId, OWNER);
  assert.equal(attachedMedia.status, "attached");
  assert.equal(attachedMedia.fileId, fileId);
  assert.equal(attachedMedia.byteSize, 1234);
  assert.equal(attachedMedia.mimeType, "image/jpeg");
  assert.equal(attachedMedia.width, 640);
  assert.equal(attachedMedia.height, 480);
  assert.equal(attachedMedia.expiresAt, null);
  assert.equal(attachedMedia.attachedAt, NOW);
  assert.equal(attachedMedia.version, 2);

  const commitReplay = await service.commitMedicationPhoto(
    {
      medicationId,
      expectedVersion: 1,
      mediaId: ticket.mediaId,
      fileId,
    },
    context(OWNER, "commit-photo-replay"),
  );
  assert.deepEqual(commitReplay, committed);
  assert.equal(photoStorage.inspections.length, 1, "重放 commit 不应重复下载");

  const removed = await service.removeMedicationPhoto(
    { medicationId, expectedVersion: committed.version },
    context(OWNER, "remove-photo-0001"),
  );
  assert.equal(removed.photo, null);
  assert.equal(removed.version, 3);
  assert.deepEqual(photoStorage.deletions, [fileId]);
  assert.equal(
    await store.getOwned("media", ticket.mediaId, OWNER, { required: false }),
    null,
  );

  const removeReplay = await service.removeMedicationPhoto(
    { medicationId, expectedVersion: committed.version },
    context(OWNER, "remove-photo-replay"),
  );
  assert.deepEqual(removeReplay, removed);
  assert.deepEqual(photoStorage.deletions, [fileId]);
});

test("照片上传任务、药盒引用和丢弃操作都不能跨账号使用", async () => {
  const { store, service, photoStorage, medicationId } = await fixture();
  const otherMedicationId = "med_photo_other";
  await store.createOwned(
    "medications",
    medicationDocument(OTHER_ACCOUNT, otherMedicationId),
  );
  const ticket = await prepare(service, medicationId);
  const fileId = `cloud://prod-env.123456/${ticket.cloudPath}`;

  await assert.rejects(
    () =>
      service.prepareMedicationPhoto(
        { medicationId, expectedVersion: 1 },
        context(OTHER_ACCOUNT, "other-prepare-0001"),
      ),
    assertErrorCode("NOT_FOUND"),
  );
  await assert.rejects(
    () =>
      service.commitMedicationPhoto(
        {
          medicationId: otherMedicationId,
          expectedVersion: 1,
          mediaId: ticket.mediaId,
          fileId,
        },
        context(OTHER_ACCOUNT, "other-commit-0001"),
      ),
    assertErrorCode("FORBIDDEN"),
  );
  const otherOwnerFolder = deterministicId("owner", OTHER_ACCOUNT);
  const otherAccountFileId = `cloud://prod-env.123456/medication-photos/${otherOwnerFolder}/${ticket.mediaId}.jpg`;
  await assert.rejects(
    () =>
      service.commitMedicationPhoto(
        {
          medicationId: otherMedicationId,
          expectedVersion: 1,
          mediaId: ticket.mediaId,
          fileId: otherAccountFileId,
        },
        context(OTHER_ACCOUNT, "other-commit-owned-path-0001"),
      ),
    assertErrorCode("INVALID_MEDIA_STATE"),
  );
  await assert.rejects(
    () =>
      service.removeMedicationPhoto(
        { medicationId, expectedVersion: 1 },
        context(OTHER_ACCOUNT, "other-remove-0001"),
      ),
    assertErrorCode("NOT_FOUND"),
  );

  assert.deepEqual(
    await service.discardMedicationPhoto(
      { mediaId: ticket.mediaId, fileId },
      context(OTHER_ACCOUNT, "other-discard-0001"),
    ),
    { discarded: true },
  );
  assert.equal(photoStorage.inspections.length, 0);
  assert.deepEqual(photoStorage.deletions, [otherAccountFileId]);
  assert.equal(
    (await store.getOwned("media", ticket.mediaId, OWNER)).status,
    "prepared",
  );
});

test("commit 事务失败时保留 cleanup_pending 账本，不直接删除未知对象", async () => {
  const store = new FailureInjectingStore();
  const photoStorage = fakePhotoStorage();
  const { service, medicationId } = await fixture({ store, photoStorage });
  const ticket = await prepare(service, medicationId);
  const fileId = `cloud://prod-env.123456/${ticket.cloudPath}`;
  store.failNextAttach("INJECTED_PHOTO_ATTACH_TRANSACTION_FAILURE");

  await assert.rejects(
    () =>
      service.commitMedicationPhoto(
        {
          medicationId,
          expectedVersion: 1,
          mediaId: ticket.mediaId,
          fileId,
        },
        context(OWNER, "commit-photo-fail-0001"),
      ),
    /INJECTED_PHOTO_ATTACH_TRANSACTION_FAILURE/,
  );

  const medication = await store.getOwned("medications", medicationId, OWNER);
  assert.equal(medication.photo, null);
  assert.equal(medication.version, 1);
  assert.equal(
    (await store.getOwned("media", ticket.mediaId, OWNER)).status,
    "cleanup_pending",
  );
  assert.deepEqual(photoStorage.deletions, []);
});

test("原子 commit 直接写入 attached，后续重放不重复检查或清理", async () => {
  const store = new FailureInjectingStore();
  const photoStorage = fakePhotoStorage();
  const { service, medicationId } = await fixture({
    store,
    photoStorage,
  });
  const ticket = await prepare(service, medicationId);
  const fileId = `cloud://prod-env.123456/${ticket.cloudPath}`;
  const committed = await service.commitMedicationPhoto(
    {
      medicationId,
      expectedVersion: 1,
      mediaId: ticket.mediaId,
      fileId,
    },
    context(OWNER, "commit-photo-deferred-0001"),
  );
  const retained = await store.getOwned("media", ticket.mediaId, OWNER);
  assert.equal(committed.photo.mediaId, retained._id);
  assert.equal(retained.status, "attached");
  assert.equal(retained.fileId, committed.photo.fileId);
  assert.equal(photoStorage.deletions.length, 0);
});

test("remove 遇到存储删除失败时保留 cleanup_pending 账本以便重试", async () => {
  let failDeletion = true;
  const warnings = [];
  const photoStorage = fakePhotoStorage({
    async deleteFile() {
      if (failDeletion) throw new Error("AMBIGUOUS_CLOUD_DELETE_RESPONSE");
    },
  });
  const { store, service, medicationId } = await fixture({
    photoStorage,
    logger: { warn: (...args) => warnings.push(args) },
  });
  const ticket = await prepare(service, medicationId);
  const fileId = `cloud://prod-env.123456/${ticket.cloudPath}`;
  const committed = await service.commitMedicationPhoto(
    {
      medicationId,
      expectedVersion: 1,
      mediaId: ticket.mediaId,
      fileId,
    },
    context(OWNER, "commit-before-remove-0001"),
  );

  const removed = await service.removeMedicationPhoto(
    { medicationId, expectedVersion: committed.version },
    context(OWNER, "remove-photo-fail-0001"),
  );
  assert.equal(removed.photo, null);
  assert.equal(
    (await store.getOwned("media", ticket.mediaId, OWNER)).status,
    "cleanup_pending",
  );
  assert.equal(warnings[0][0], "PHOTO_CLEANUP_DEFERRED");

  failDeletion = false;
  service.clock = () => new Date("2026-08-19T00:31:00.000Z");
  await service.cleanupPendingMedia(context(OWNER, "retry-photo-cleanup-0001"));
  assert.equal(
    await store.getOwned("media", ticket.mediaId, OWNER, { required: false }),
    null,
  );
  assert.deepEqual(photoStorage.deletions, [fileId, fileId]);
});

test("清理抢占失败即使回读为 cleanup_pending 也不能盲删", async () => {
  const store = new CleanupClaimRaceStore();
  const photoStorage = fakePhotoStorage();
  const { service, medicationId } = await fixture({ store, photoStorage });
  const ticket = await prepare(service, medicationId);
  const fileId = `cloud://prod-env.123456/${ticket.cloudPath}`;
  await store.updateOwnedVersioned(
    "media",
    ticket.mediaId,
    OWNER,
    1,
    { fileId, status: "uploaded" },
    NOW,
    "seed-uploaded-0001",
  );

  await service.cleanupMedia(
    await store.getOwned("media", ticket.mediaId, OWNER),
    context(OWNER, "cleanup-race-0001"),
  );

  assert.deepEqual(photoStorage.deletions, []);
});

test("照片中转锁定票据、保存文件引用并复用相同内容，拒绝覆盖", async () => {
  const f = await fixture();
  let uploads = 0;
  f.photoStorage.uploadImage = async (path, content) => {
    uploads++;
    assert.equal(content.toString(), "test image");
    return `cloud://env.123/${path}`;
  };
  const ticket = await prepare(f.service, f.medicationId);
  const payload = {
    medicationId: f.medicationId,
    expectedVersion: 1,
    mediaId: ticket.mediaId,
    base64: Buffer.from("test image").toString("base64"),
  };
  const ctx = context(OWNER, "relay-test-0001");
  const uploaded = await f.service.uploadMedicationPhoto(payload, ctx);
  assert.deepEqual(
    await f.service.uploadMedicationPhoto(payload, ctx),
    uploaded,
  );
  assert.equal(uploads, 1);
  await assert.rejects(
    f.service.uploadMedicationPhoto({ ...payload, base64: "YQ==" }, ctx),
    assertErrorCode("INVALID_MEDIA_STATE"),
  );
  const result = await f.service.commitMedicationPhoto(
    { ...payload, fileId: uploaded.fileId },
    ctx,
  );
  assert.equal(result.photo.fileId, uploaded.fileId);
  await assert.rejects(
    f.service.uploadMedicationPhoto(
      { ...payload, expectedVersion: result.version },
      ctx,
    ),
    assertErrorCode("INVALID_MEDIA_STATE"),
  );
});

test("照片中转拒绝跨账号、过时版本、过期票据且不执行上传", async () => {
  const f = await fixture();
  f.photoStorage.uploadImage = async () => {
    throw new Error("must not upload");
  };
  const ticket = await prepare(f.service, f.medicationId);
  const payload = {
    medicationId: f.medicationId,
    expectedVersion: 1,
    mediaId: ticket.mediaId,
    base64: "YQ==",
  };
  await assert.rejects(
    f.service.uploadMedicationPhoto(
      payload,
      context(OTHER_ACCOUNT, "relay-other-0001"),
    ),
  );
  await assert.rejects(
    f.service.uploadMedicationPhoto(
      { ...payload, expectedVersion: 2 },
      context(OWNER, "relay-stale-0001"),
    ),
    assertErrorCode("VERSION_CONFLICT"),
  );
  f.service.clock = () => new Date("2026-08-21T00:00:00Z");
  await assert.rejects(
    f.service.uploadMedicationPhoto(
      payload,
      context(OWNER, "relay-expired-0001"),
    ),
    assertErrorCode("MEDIA_UPLOAD_EXPIRED"),
  );
});

test("并发中转仅一个请求可写文件，上传后数据库失败清理文件", async () => {
  const store = new FailureInjectingStore();
  const f = await fixture({ store });
  const ticket = await prepare(f.service, f.medicationId);
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  f.photoStorage.uploadImage = async (path) => {
    started();
    await blocked;
    return `cloud://env.123/${path}`;
  };
  const payload = {
    medicationId: f.medicationId,
    expectedVersion: 1,
    mediaId: ticket.mediaId,
    base64: "YQ==",
  };
  const first = f.service.uploadMedicationPhoto(
    payload,
    context(OWNER, "relay-first-0001"),
  );
  await ready;
  await assert.rejects(
    f.service.uploadMedicationPhoto(
      payload,
      context(OWNER, "relay-second-0001"),
    ),
    assertErrorCode("INVALID_MEDIA_STATE"),
  );
  store.failNextUpdateWhere(
    ({ patch }) => patch.status === "uploaded",
    "db failed",
  );
  release();
  await assert.rejects(first, /db failed/);
  assert.equal(f.photoStorage.deletions.length, 0);
  assert.equal(
    (await f.store.getOwned("media", ticket.mediaId, OWNER)).status,
    "cleanup_pending",
  );
});

const {
  CHUNK_LENGTH,
  parsePhotoChunks,
  putPhotoChunk,
  finishPhotoChunks,
} = require("../lib/photo-chunks");

test("分块上传恢复重放、完整合并、原图片校验和临时数据清理", async () => {
  const bytes = Buffer.alloc(434581, 17);
  const base64 = bytes.toString("base64");
  let uploads = 0;
  const photoStorage = fakePhotoStorage();
  photoStorage.uploadImage = async (path, content) => {
    uploads++;
    assert.deepEqual(content, bytes);
    return `cloud://env/${path}`;
  };
  const { service, medicationId, store } = await fixture({ photoStorage });
  const ticket = await prepare(service, medicationId);
  const common = {
    medicationId,
    expectedVersion: 1,
    mediaId: ticket.mediaId,
    totalLength: base64.length,
  };
  const ctx = context(OWNER, "chunk-upload-0001");
  await assert.rejects(
    finishPhotoChunks(service, common, ctx),
    assertErrorCode("INVALID_MEDIA"),
  );
  for (let offset = 0; offset < base64.length; offset += CHUNK_LENGTH) {
    const part = parsePhotoChunks(
      {
        ...common,
        index: offset / CHUNK_LENGTH,
        base64: base64.slice(offset, offset + CHUNK_LENGTH),
      },
      true,
    );
    await putPhotoChunk(service, part, ctx);
    await putPhotoChunk(service, part, ctx);
  }
  const first = {
    ...common,
    index: 0,
    base64: Buffer.alloc((CHUNK_LENGTH / 4) * 3, 18).toString("base64"),
  };
  await assert.rejects(
    putPhotoChunk(service, first, ctx),
    assertErrorCode("INVALID_MEDIA_STATE"),
  );
  const uploaded = await finishPhotoChunks(
    service,
    parsePhotoChunks(common, false),
    ctx,
  );
  assert.ok(uploaded.fileId);
  assert.deepEqual(await finishPhotoChunks(service, common, ctx), uploaded);
  assert.equal(uploads, 1);
  const media = await store.listAllOwned("media", OWNER);
  assert.equal(media.length, 1);
  assert.equal(media[0].status, "uploaded");
});

test("分块拒绝跨账号、过期任务以及超过边界的数据", async () => {
  const { service, medicationId } = await fixture();
  const ticket = await prepare(service, medicationId);
  const payload = {
    medicationId,
    expectedVersion: 1,
    mediaId: ticket.mediaId,
    totalLength: 4,
    index: 0,
    base64: "YWJj",
  };
  await assert.rejects(
    putPhotoChunk(service, payload, context(OTHER_ACCOUNT, "other-chunk-0001")),
  );
  for (const patch of [
    { totalLength: 2796208 },
    { index: -1 },
    { index: 1 },
    { base64: "!!!!" },
    { base64: "YQ==", totalLength: CHUNK_LENGTH + 4 },
  ]) {
    assert.throws(() => parsePhotoChunks({ ...payload, ...patch }, true));
  }
  service.clock = () => new Date("2099-01-01T00:00:00Z");
  await assert.rejects(
    putPhotoChunk(service, payload, context(OWNER, "expired-chunk-0001")),
    assertErrorCode("MEDIA_UPLOAD_EXPIRED"),
  );
});

test("未完成分块随媒体到期清理，删除药盒也删除临时照片内容", async () => {
  const { service, medicationId, store } = await fixture();
  const ticket = await prepare(service, medicationId);
  await putPhotoChunk(
    service,
    {
      medicationId,
      expectedVersion: 1,
      mediaId: ticket.mediaId,
      totalLength: 4,
      index: 0,
      base64: "YWJj",
    },
    context(OWNER, "cleanup-chunk-0001"),
  );
  service.clock = () => new Date("2099-01-01T00:00:00Z");
  await service.cleanupPendingMedia(context(OWNER, "cleanup-chunk-0002"));
  assert.equal((await store.listAllOwned("media", OWNER)).length, 0);
});
