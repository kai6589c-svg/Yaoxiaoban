"use strict";

const { DEFAULT_SETTINGS } = require("../../lib/constants");
const { fail } = require("../../lib/errors");
const { deterministicId } = require("../../lib/hash");

class MemoryStore {
  constructor() {
    this.data = new Map();
    for (const key of [
      "profiles",
      "medications",
      "plans",
      "snapshots",
      "intakeLogs",
      "settings",
      "calendarExports",
      "reminderTasks",
      "media",
      "subscriptionGrants",
    ]) {
      this.data.set(key, new Map());
    }
  }

  bucket(key) {
    const result = this.data.get(key);
    if (!result) throw new Error(`Missing memory collection ${key}`);
    return result;
  }

  async getOwned(key, id, accountId, { required = true } = {}) {
    const item = this.bucket(key).get(id);
    if (!item || item.accountId !== accountId) {
      if (required) fail("NOT_FOUND", "记录不存在或无权访问");
      return null;
    }
    return structuredClone(item);
  }

  async listOwned(
    key,
    accountId,
    { where = {}, cursor = null, limit = 100 } = {},
  ) {
    const all = await this.listAllOwned(key, accountId, where);
    const filtered = all.filter((item) => !cursor || item._id > cursor);
    const items = filtered.slice(0, limit);
    return {
      items,
      nextCursor: filtered.length > limit ? items[items.length - 1]._id : null,
    };
  }

  async listAllOwned(key, accountId, where = {}) {
    return [...this.bucket(key).values()]
      .filter((item) => item.accountId === accountId)
      .filter((item) =>
        Object.entries(where).every(([field, value]) => item[field] === value),
      )
      .sort((a, b) => a._id.localeCompare(b._id))
      .map((item) => structuredClone(item));
  }

  async createOwned(key, document) {
    if (this.bucket(key).has(document._id)) fail("CONFLICT", "记录已存在");
    this.bucket(key).set(document._id, structuredClone(document));
    return structuredClone(document);
  }

  async attachMedicationThumbnail(
    medicationId,
    accountId,
    mediaId,
    thumbnailFileId,
  ) {
    const medication = await this.getOwned(
      "medications",
      medicationId,
      accountId,
    );
    if (medication.status !== "active" || medication.photo?.mediaId !== mediaId)
      fail("VERSION_CONFLICT", "照片已更换");
    medication.photo = { ...medication.photo, thumbnailFileId };
    this.bucket("medications").set(medicationId, medication);
  }

  async attachMedicationPhoto({
    medicationId,
    accountId,
    expectedMedicationVersion,
    mediaId,
    expectedMediaVersion,
    fileId,
    metadata,
    now,
    requestId,
  }) {
    const medication = await this.getOwned(
      "medications",
      medicationId,
      accountId,
    );
    const media = await this.getOwned("media", mediaId, accountId);
    if (
      medication.photo?.mediaId === mediaId &&
      medication.photo?.fileId === fileId
    )
      return { medication, media };
    if (medication.version !== expectedMedicationVersion)
      fail("VERSION_CONFLICT", "版本冲突");
    if (
      media.version !== expectedMediaVersion ||
      !["prepared", "uploaded"].includes(media.status) ||
      (media.fileId && media.fileId !== fileId)
    )
      fail("INVALID_MEDIA_STATE", "照片上传任务已被其他操作占用");
    const updatedMedication = {
      ...medication,
      photo: { mediaId, fileId, updatedAt: now },
      version: medication.version + 1,
      updatedAt: now,
      lastRequestId: requestId,
    };
    const updatedMedia = {
      ...media,
      ...structuredClone(metadata),
      status: "attached",
      attachedAt: now,
      expiresAt: null,
      version: media.version + 1,
      updatedAt: now,
      lastRequestId: requestId,
    };
    this.bucket("medications").set(medicationId, updatedMedication);
    this.bucket("media").set(mediaId, updatedMedia);
    return {
      medication: structuredClone(updatedMedication),
      media: structuredClone(updatedMedia),
    };
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
    const current = await this.getOwned(key, id, accountId);
    if (current.version !== expectedVersion)
      fail("VERSION_CONFLICT", "版本冲突", { currentVersion: current.version });
    const updated = {
      ...current,
      ...structuredClone(patch),
      version: current.version + 1,
      updatedAt: now,
      lastRequestId: requestId,
    };
    this.bucket(key).set(id, updated);
    return structuredClone(updated);
  }

  async removeOwnedVersioned(key, id, accountId, expectedVersion) {
    const current = await this.getOwned(key, id, accountId);
    if (current.version !== expectedVersion)
      fail("VERSION_CONFLICT", "版本冲突");
    this.bucket(key).delete(id);
    return { id, deleted: true };
  }

  async ensureSettings(accountId, now) {
    const id = deterministicId("settings", accountId);
    const current = await this.getOwned("settings", id, accountId, {
      required: false,
    });
    if (current) return current;
    return this.createOwned("settings", {
      _id: id,
      accountId,
      ...DEFAULT_SETTINGS,
      subscriptions: { ...DEFAULT_SETTINGS.subscriptions },
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
  }

  async exportAccount(accountId, now) {
    const keys = [
      "profiles",
      "medications",
      "plans",
      "snapshots",
      "intakeLogs",
      "settings",
      "calendarExports",
    ];
    const result = {};
    for (const key of keys) {
      result[key] = (await this.listAllOwned(key, accountId)).map((item) => {
        const clone = structuredClone(item);
        if (key === "medications" && clone.photo) {
          clone.photo = {
            included: false,
            updatedAt: clone.photo.updatedAt,
            notice: "照片文件与内部存储地址不包含在文本导出中",
          };
        }
        return clone;
      });
    }
    return { schemaVersion: 1, exportedAt: now, ...result };
  }

  async deleteAllOwned(key, accountId, where = {}) {
    const items = await this.listAllOwned(key, accountId, where);
    for (const item of items) this.bucket(key).delete(item._id);
  }

  async cancelReminderTasks(accountId, medicationId, now, keepIds = []) {
    const keep = new Set(keepIds);
    const tasks = await this.listAllOwned("reminderTasks", accountId, {
      medicationId,
    });
    for (const task of tasks) {
      if (task.status === "pending" && !keep.has(task._id)) {
        this.bucket("reminderTasks").set(task._id, {
          ...task,
          status: "canceled",
          updatedAt: now,
        });
      }
    }
  }

  async putReminderTask(task) {
    const current = await this.getOwned(
      "reminderTasks",
      task._id,
      task.accountId,
      { required: false },
    );
    if (current) {
      if (current.status === "pending") {
        this.bucket("reminderTasks").set(task._id, {
          ...current,
          dueAt: task.dueAt,
          nextAttemptAt:
            current.nextAttemptAt &&
            Date.parse(current.nextAttemptAt) > Date.parse(task.nextAttemptAt)
              ? current.nextAttemptAt
              : task.nextAttemptAt,
          payload: structuredClone(task.payload),
          sourceVersion: task.sourceVersion,
          updatedAt: task.updatedAt,
        });
      }
      return this.getOwned("reminderTasks", task._id, task.accountId);
    }
    return this.createOwned("reminderTasks", task);
  }

  async markReminderTaskExpired(task, now) {
    const current = this.bucket("reminderTasks").get(task._id);
    if (current)
      this.bucket("reminderTasks").set(task._id, {
        ...current,
        status: "expired",
        leaseUntil: null,
        updatedAt: now,
      });
  }

  async revalidateTask(task) {
    const medication = await this.getOwned(
      "medications",
      task.medicationId,
      task.accountId,
      { required: false },
    );
    if (!medication || medication.status !== "active") return false;
    if (task.kind !== "dose") return true;
    if (!task.planId || medication.activePlanId !== task.planId) return false;
    const logs = await this.listAllOwned("intakeLogs", task.accountId, {
      medicationId: task.medicationId,
    });
    return !logs.some(
      (log) =>
        !log.voidedAt &&
        log.planId === task.planId &&
        log.scheduledAt === task.scheduledAt &&
        (log.status === "taken" || log.status === "skipped"),
    );
  }

  async recordSubscriptionGrant(accountId, document) {
    const existing = await this.getOwned(
      "subscriptionGrants",
      document._id,
      accountId,
      { required: false },
    );
    return existing ?? this.createOwned("subscriptionGrants", document);
  }

  async reserveSubscriptionGrant(accountId, templateId, _now, binding = {}) {
    const existingReservation = [
      ...this.bucket("subscriptionGrants").values(),
    ].find(
      (item) =>
        item.accountId === accountId && item.reservedTaskId === binding.taskId,
    );
    if (existingReservation)
      return {
        reserved: true,
        grantId: existingReservation._id,
        idempotent: true,
      };
    const grant = [...this.bucket("subscriptionGrants").values()].find(
      (item) =>
        item.accountId === accountId &&
        item.templateId === templateId &&
        item.status === "accept" &&
        (item.usableCount ?? 0) > 0 &&
        Number.isInteger(item.version) &&
        !item.reservedTaskId,
    );
    if (!grant) return false;
    grant.usableCount -= 1;
    grant.version += 1;
    grant.reservedTaskId = binding.taskId ?? null;
    grant.reservedMedicationId = binding.medicationId ?? null;
    grant.reservedKind = binding.kind ?? null;
    return { reserved: true, grantId: grant._id };
  }

  async releaseSubscriptionGrant(accountId, grantId, _now, binding = {}) {
    const grant = this.bucket("subscriptionGrants").get(grantId);
    if (!grant || grant.accountId !== accountId) return false;
    if (binding.taskId && grant.reservedTaskId !== binding.taskId) return false;
    if (!grant.reservedTaskId) return false;
    grant.usableCount += 1;
    grant.version += 1;
    grant.reservedTaskId = null;
    grant.reservedMedicationId = null;
    grant.reservedKind = null;
    return true;
  }

  async finalizeSubscriptionGrant(accountId, grantId, _now, binding = {}) {
    const grant = this.bucket("subscriptionGrants").get(grantId);
    if (!grant || grant.accountId !== accountId) return false;
    if (binding.taskId && grant.reservedTaskId !== binding.taskId) return false;
    if (!grant.reservedTaskId) return false;
    grant.reservedTaskId = null;
    grant.reservedMedicationId = null;
    grant.reservedKind = null;
    return true;
  }

  async migrateSubscriptionGrantVersions() {
    let migrated = 0;
    for (const grant of this.bucket("subscriptionGrants").values()) {
      if (grant.status === "accept" && !Number.isInteger(grant.version)) {
        grant.version = 1;
        migrated += 1;
      }
    }
    return migrated;
  }

  async listSubscriptionGrants(accountId, where = {}) {
    return this.listAllOwned("subscriptionGrants", accountId, where);
  }

  async markCalendarExportsStale(accountId, medicationId, now) {
    const items = await this.listAllOwned("calendarExports", accountId, {
      medicationId,
    });
    for (const item of items) {
      if (!item.staleAt) {
        this.bucket("calendarExports").set(item._id, {
          ...item,
          staleAt: now,
          updatedAt: now,
          version: item.version + 1,
        });
      }
    }
  }
}

module.exports = { MemoryStore };
