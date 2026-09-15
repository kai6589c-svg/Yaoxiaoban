"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const jpeg = require("jpeg-js");
const { MedicineService } = require("../lib/service");
const { CompatibilityService } = require("../lib/compat-service");
const { PhotoStorage } = require("../lib/photo-storage");
const {
  putPhotoChunk,
  completePhotoChunks,
  CHUNK_LENGTH,
} = require("../lib/photo-chunks");
const { MemoryStore } = require("./support/memory-store");
const now = "2026-09-10T03:00:00.000Z";
async function setup() {
  const store = new MemoryStore();
  const objects = new Map();
  let reads = 0;
  const storage = new PhotoStorage(
    {
      uploadFile: async ({ cloudPath, fileContent }) => {
        objects.set(cloudPath, fileContent);
        return { fileID: `cloud://test.env/${cloudPath}` };
      },
      getTempFileURL: async ({ fileList }) => ({
        fileList: fileList.map((fileID) => ({
          status: 0,
          tempFileURL: `https://private.test/${fileID.split("/").slice(3).join("/")}`,
        })),
      }),
      deleteFile: async ({ fileList }) => ({
        fileList: fileList.map((id) => {
          objects.delete(id.split("/").slice(3).join("/"));
          return { status: 0 };
        }),
      }),
    },
    {
      readRemoteImage: async (url) => {
        reads++;
        return objects.get(url.replace("https://private.test/", ""));
      },
    },
  );
  const service = new MedicineService(store, {
    photoStorage: storage,
    clock: () => new Date(now),
  });
  const context = { accountId: "acct_fast", requestId: "request-fast-0001" };
  await store.createOwned("medications", {
    _id: "med_fast",
    accountId: context.accountId,
    profileId: "profile_fast",
    status: "active",
    name: "Fixture",
    version: 1,
    photo: null,
    expiry: { precision: "day", value: "2027-09-10" },
    createdAt: now,
    updatedAt: now,
  });
  const ticket = await service.prepareMedicationPhoto(
    { medicationId: "med_fast", expectedVersion: 1 },
    context,
  );
  const bytes = jpeg.encode(
    { data: Buffer.alloc(80 * 120 * 4, 255), width: 80, height: 120 },
    65,
  ).data;
  const base64 = bytes.toString("base64");
  const payload = {
    medicationId: "med_fast",
    expectedVersion: 1,
    mediaId: ticket.mediaId,
    totalLength: base64.length,
  };
  for (let index = 0; index < Math.ceil(base64.length / CHUNK_LENGTH); index++)
    await putPhotoChunk(
      service,
      {
        ...payload,
        index,
        base64: base64.slice(index * CHUNK_LENGTH, (index + 1) * CHUNK_LENGTH),
      },
      context,
    );
  return {
    store,
    service,
    context,
    ticket,
    payload,
    objects,
    bytes,
    reads: () => reads,
  };
}
test("fast completion validates original bytes and atomically binds without remote readback; replay writes once", async () => {
  const f = await setup();
  const result = await completePhotoChunks(f.service, f.payload, f.context);
  assert.equal(result.photo.mediaId, f.ticket.mediaId);
  assert.equal(f.reads(), 0);
  assert.equal(f.objects.size, 1);
  assert.deepEqual(f.objects.get(`${f.ticket.cloudPath}.sealed.jpg`), f.bytes);
  assert.equal(
    (await f.store.getOwned("medications", "med_fast", f.context.accountId))
      .version,
    2,
  );
  await completePhotoChunks(f.service, f.payload, f.context);
  assert.equal(f.objects.size, 1);
  const ledger = await f.store.getOwned(
    "media",
    f.ticket.mediaId,
    f.context.accountId,
  );
  assert.equal(ledger.status, "attached");
  assert.equal(ledger.thumbnailStatus, "pending");
  // A late native upload has a distinct path and cannot change validated bytes.
  f.objects.set(f.ticket.cloudPath, Buffer.from("late upload"));
  assert.deepEqual(f.objects.get(`${f.ticket.cloudPath}.sealed.jpg`), f.bytes);
});
test("fast completion rejects cross-account, missing chunks and version conflicts before storage writes", async () => {
  const f = await setup();
  await assert.rejects(
    completePhotoChunks(f.service, f.payload, {
      ...f.context,
      accountId: "other",
    }),
  );
  await assert.rejects(
    completePhotoChunks(
      f.service,
      { ...f.payload, expectedVersion: 2 },
      f.context,
    ),
  );
  f.store.bucket("media").forEach((item, id) => {
    if (item.kind === "medication-photo-chunk")
      f.store.bucket("media").delete(id);
  });
  await assert.rejects(completePhotoChunks(f.service, f.payload, f.context));
  assert.equal(f.objects.size, 0);
});
test("maintenance derives thumbnail after commit and does not delete referenced main photo", async () => {
  const f = await setup();
  await completePhotoChunks(f.service, f.payload, f.context);
  await f.service.cleanupPendingMedia(f.context);
  assert.equal(f.reads(), 1);
  assert.equal(
    (await f.store.getOwned("medications", "med_fast", f.context.accountId))
      .version,
    2,
  );
  assert.ok(f.objects.has(`${f.ticket.cloudPath}.sealed.jpg`));
  const media = await f.store.getOwned(
    "media",
    f.ticket.mediaId,
    f.context.accountId,
  );
  assert.ok(["ready", "unavailable"].includes(media.thumbnailStatus));
});
test("Today DTO performs no photo signing and omits history and private file references", async () => {
  const f = await setup();
  await completePhotoChunks(f.service, f.payload, f.context);
  f.service.publicMedication = async () => {
    throw new Error("must not sign on Today");
  };
  const compat = new CompatibilityService(f.store, f.service, {
    clock: () => new Date(now),
  });
  const result = await compat.execute("getTodayDashboard", {}, f.context);
  assert.equal(result.summary.medicationCount, 1);
  assert.equal(result.medications, undefined);
  assert.equal(result.intakeLogs, undefined);
  assert.ok(!JSON.stringify(result).includes("cloud://"));
});

test("late thumbnail never overwrites a new photo or increments an edit version", async () => {
  const f = await setup();
  await completePhotoChunks(f.service, f.payload, f.context);
  await f.store.attachMedicationThumbnail(
    "med_fast",
    f.context.accountId,
    f.ticket.mediaId,
    "cloud://thumbnail",
  );
  assert.equal(
    (await f.store.getOwned("medications", "med_fast", f.context.accountId))
      .version,
    2,
  );
  await assert.rejects(
    f.store.attachMedicationThumbnail(
      "med_fast",
      f.context.accountId,
      "other-media",
      "cloud://stale",
    ),
  );
  assert.equal(
    (await f.store.getOwned("medications", "med_fast", f.context.accountId))
      .photo.thumbnailFileId,
    "cloud://thumbnail",
  );
});
