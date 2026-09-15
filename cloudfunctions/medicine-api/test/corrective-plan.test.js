"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { CloudStore } = require("../lib/store");
const { MedicineService } = require("../lib/service");
const { deterministicId } = require("../lib/hash");
const { MemoryStore } = require("./support/memory-store");

test("真实事务适配器从 null 首次绑定、替换、移除后再添加均使用 set", async () => {
  const docs = new Map([
    ["yxb_accounts/acct_1", { _id: "acct_1", status: "active" }],
    [
      "yxb_medications/med_1",
      {
        _id: "med_1",
        accountId: "acct_1",
        status: "active",
        version: 1,
        photo: null,
      },
    ],
    [
      "yxb_media/media_1",
      {
        _id: "media_1",
        accountId: "acct_1",
        kind: "medication-photo",
        medicationId: "med_1",
        status: "uploaded",
        version: 1,
        fileId: "cloud://env/p1.jpg",
      },
    ],
  ]);
  class Command {
    constructor(type, value) {
      this.type = type;
      this.value = value;
    }
  }
  const command = {
    inc: (value) => new Command("inc", value),
    set: (value) => new Command("set", value),
  };
  const apply = (target, patch) => {
    for (const [key, value] of Object.entries(patch)) {
      if (value instanceof Command) {
        target[key] =
          value.type === "inc"
            ? target[key] + value.value
            : structuredClone(value.value);
      } else if (value && typeof value === "object" && !Array.isArray(value)) {
        if (target[key] === null)
          throw new Error("Cannot create field in element {photo: null}");
        target[key] ??= {};
        apply(target[key], value);
      } else target[key] = value;
    }
  };
  const db = {
    command,
    collection(name) {
      return {
        doc(id) {
          return {
            async get() {
              const data = docs.get(`${name}/${id}`);
              return { data: data ? structuredClone(data) : null };
            },
            async update({ data }) {
              const key = `${name}/${id}`;
              const current = docs.get(key);
              apply(current, data);
              docs.set(key, current);
              return { stats: { updated: 1 } };
            },
          };
        },
      };
    },
    async runTransaction(callback) {
      return callback({ command, collection: this.collection });
    },
  };
  const result = await new CloudStore(db).attachMedicationPhoto({
    medicationId: "med_1",
    accountId: "acct_1",
    expectedMedicationVersion: 1,
    mediaId: "media_1",
    expectedMediaVersion: 1,
    fileId: "cloud://env/p1.jpg",
    metadata: {
      fileId: "cloud://env/p1.jpg",
      byteSize: 10,
      thumbnailFileId: "cloud://env/p1.jpg.thumb.jpg",
      width: 960,
      height: 1280,
    },
    now: "2026-09-07T00:00:00.000Z",
    requestId: "photo-1",
  });
  assert.deepEqual(result.medication.photo, {
    mediaId: "media_1",
    fileId: "cloud://env/p1.jpg",
    updatedAt: "2026-09-07T00:00:00.000Z",
    thumbnailFileId: "cloud://env/p1.jpg.thumb.jpg",
    width: 960,
    height: 1280,
  });
  assert.equal(docs.get("yxb_medications/med_1").version, 2);
  assert.equal(docs.get("yxb_media/media_1").status, "attached");
});

test("原生发生器两天四时刻得到四个任务，七天窗口恰好十四条且刷新幂等", async () => {
  const store = new MemoryStore();
  const accountId = "acct_occurrence";
  const medication = {
    _id: "med_occurrence",
    accountId,
    status: "active",
    name: "测试药",
    unit: "片",
    expiry: null,
    openedOn: null,
    afterOpenDays: null,
    activePlanId: "plan_occurrence",
    version: 1,
  };
  await store.createOwned("medications", medication);
  await store.createOwned("settings", {
    _id: deterministicId("settings", accountId),
    accountId,
    reminderPreferences: { dose: true, expiry: false, shortage: false },
    subscriptions: { expiry: false, shortage: false },
    expiryLeadDays: 30,
    shortageLeadDays: 7,
    version: 1,
  });
  await store.createOwned("plans", {
    _id: "plan_occurrence",
    accountId,
    medicationId: medication._id,
    kind: "daily",
    dose: 1,
    unit: "片",
    times: ["08:00", "20:00"],
    weekdays: [],
    startDate: "2026-09-07",
    endDate: null,
    effectiveFrom: "2026-09-01T00:00:00.000Z",
    supersededAt: null,
    version: 1,
  });
  const service = new MedicineService(store, {
    clock: () => new Date("2026-09-07T00:00:00.000Z"),
    logger: { warn() {} },
  });
  await service.refreshReminders(medication._id, {
    accountId,
    requestId: "refresh-1",
  });
  const first = await store.listAllOwned("reminderTasks", accountId, {
    medicationId: medication._id,
  });
  const dose = first.filter((task) => task.kind === "dose");
  assert.equal(dose.length, 14);
  assert.equal(new Set(dose.map((task) => task._id)).size, 14);
  assert.equal(new Set(dose.map((task) => task.scheduledAt)).size, 14);
  await service.refreshReminders(medication._id, {
    accountId,
    requestId: "refresh-2",
  });
  const second = await store.listAllOwned("reminderTasks", accountId, {
    medicationId: medication._id,
  });
  assert.equal(second.filter((task) => task.kind === "dose").length, 14);
  assert.deepEqual(
    second.map((task) => task._id).sort(),
    first.map((task) => task._id).sort(),
  );
});

test("照片 URL 单点失败不拖垮药盒读取，导出不含 fileId 或临时 URL", async () => {
  const store = new MemoryStore();
  await store.createOwned("medications", {
    _id: "med_export",
    accountId: "acct_export",
    status: "active",
    photo: {
      mediaId: "media_export",
      fileId: "cloud://env/private.jpg",
      url: "https://signed.example/x",
    },
  });
  const service = new MedicineService(store, {
    photoStorage: {
      getViewUrl: async () => {
        throw new Error("signed URL failed");
      },
    },
    logger: { warn() {} },
  });
  const medication = await service.publicMedication(
    await store.getOwned("medications", "med_export", "acct_export"),
  );
  assert.equal(medication.photo.viewStatus, "view_failed");
  assert.equal(medication.photo.fileId, undefined);
  const exported = await store.exportAccount(
    "acct_export",
    "2026-09-07T00:00:00.000Z",
  );
  const text = JSON.stringify(exported);
  assert.equal(text.includes("cloud://"), false);
  assert.equal(text.includes("signed.example"), false);
});
