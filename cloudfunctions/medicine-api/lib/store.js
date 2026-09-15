"use strict";

const { COLLECTIONS, DEFAULT_SETTINGS } = require("./constants");
const { fail } = require("./errors");
const { deterministicId, sha256 } = require("./hash");

const PAGE_SIZE = 100;
const EXPORT_LIMIT = 5000;
const EXPORT_BYTES_LIMIT = 4 * 1024 * 1024;

class CloudStore {
  constructor(db, options = {}) {
    this.db = db;
    this.command = db.command;
    const prefix =
      options.collectionPrefix ?? process.env.COLLECTION_PREFIX ?? "yxb_";
    if (!/^[A-Za-z][A-Za-z0-9_]{0,20}$/.test(prefix))
      throw new Error("INVALID_COLLECTION_PREFIX");
    this.prefix = prefix;
    this.photoStorage = options.photoStorage ?? null;
  }

  collection(key) {
    const logical = COLLECTIONS[key];
    if (!logical) throw new Error(`UNKNOWN_COLLECTION:${key}`);
    return this.db.collection(`${this.prefix}${logical}`);
  }

  accountIdFor(openid) {
    return deterministicId("acct", openid);
  }

  ownerHashFor(openid) {
    return sha256(openid);
  }

  async ensureAccount(openid, now) {
    const accountId = this.accountIdFor(openid);
    const existing = await this.getDocument("accounts", accountId);
    if (existing) {
      if (existing.status !== "active")
        fail("ACCOUNT_UNAVAILABLE", "账号当前不可用");
      return existing;
    }
    const account = {
      _id: accountId,
      openid,
      status: "active",
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.collection("accounts").add({ data: account });
      return account;
    } catch (error) {
      if (!isDuplicateError(error)) throw error;
      const raced = await this.getDocument("accounts", accountId);
      if (!raced) throw error;
      if (raced.status !== "active")
        fail("ACCOUNT_UNAVAILABLE", "账号当前不可用");
      return raced;
    }
  }

  async assertAccountActive(accountId) {
    const account = await this.getDocument("accounts", accountId);
    if (!account || account.status !== "active")
      fail("ACCOUNT_UNAVAILABLE", "账号当前不可用");
    return account;
  }

  async assertPrivacyAccepted(accountId, requiredVersion) {
    await this.assertAccountActive(accountId);
    const settings = await this.ensureSettings(
      accountId,
      new Date().toISOString(),
    );
    if (
      settings.privacyAcceptedVersion !== requiredVersion ||
      typeof settings.privacyAcceptedAt !== "string"
    ) {
      fail("FORBIDDEN", "请先阅读并同意隐私说明");
    }
    return settings;
  }

  async markAccountDeleting(accountId, now) {
    const account = await this.getDocument("accounts", accountId);
    if (!account || account.status === "deleting") return account;
    await this.collection("accounts")
      .doc(accountId)
      .update({
        data: {
          status: "deleting",
          version: this.command.inc(1),
          updatedAt: now,
        },
      });
    return this.getDocument("accounts", accountId);
  }

  async getDocument(key, id) {
    try {
      const result = await this.collection(key).doc(id).get();
      return result.data || null;
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  }

  async getOwned(key, id, accountId, { required = true } = {}) {
    const result = await this.collection(key)
      .where({ _id: id, accountId })
      .limit(1)
      .get();
    const document = result.data?.[0] ?? null;
    if (!document && required) fail("NOT_FOUND", "记录不存在或无权访问");
    return document;
  }

  async listOwned(key, accountId, options = {}) {
    const where = { accountId, ...(options.where ?? {}) };
    if (options.cursor) where._id = this.command.gt(options.cursor);
    let query = this.collection(key).where(where).orderBy("_id", "asc");
    const limit = Math.min(options.limit ?? 100, 100);
    query = query.limit(limit + 1);
    const result = await query.get();
    const data = result.data ?? [];
    const hasMore = data.length > limit;
    const items = hasMore ? data.slice(0, limit) : data;
    return { items, nextCursor: hasMore ? items[items.length - 1]._id : null };
  }

  async listAllOwned(key, accountId, where = {}, max = EXPORT_LIMIT) {
    const items = [];
    let offset = 0;
    while (true) {
      const result = await this.collection(key)
        .where({ accountId, ...where })
        .orderBy("_id", "asc")
        .skip(offset)
        .limit(PAGE_SIZE)
        .get();
      const page = result.data ?? [];
      items.push(...page);
      if (items.length > max)
        fail("EXPORT_TOO_LARGE", "数据量过大，请联系支持人员导出");
      if (page.length < PAGE_SIZE) return items;
      offset += page.length;
    }
  }

  async createOwned(key, document) {
    await this.assertAccountActive(document.accountId);
    try {
      await this.collection(key).add({ data: document });
      try {
        await this.assertAccountActive(document.accountId);
      } catch (error) {
        await this.collection(key)
          .doc(document._id)
          .remove()
          .catch(() => {});
        throw error;
      }
      return document;
    } catch (error) {
      if (isDuplicateError(error)) {
        const existing = await this.getOwned(
          key,
          document._id,
          document.accountId,
          { required: false },
        );
        if (
          existing?.lastRequestId &&
          existing.lastRequestId === document.lastRequestId
        )
          return existing;
        fail("CONFLICT", "记录已存在");
      }
      throw error;
    }
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
    await this.assertAccountActive(accountId);
    const result = await this.collection(key)
      .where({ _id: id, accountId, version: expectedVersion })
      .update({
        data: {
          ...patch,
          // Plain nested objects become dotted updates in CloudBase. A new or
          // cleared medication has photo:null, so photo.fileId cannot be set
          // beneath it. Replace this reference atomically, retaining the same
          // account/version filter and leaving other medication fields intact.
          ...(key === "medications" && patch.photo
            ? { photo: this.command.set(patch.photo) }
            : {}),
          version: this.command.inc(1),
          updatedAt: now,
          lastRequestId: requestId,
        },
      });
    if (updatedCount(result) === 1) {
      await this.assertAccountActive(accountId);
      return this.getOwned(key, id, accountId);
    }
    const existing = await this.getOwned(key, id, accountId, {
      required: false,
    });
    if (!existing) fail("NOT_FOUND", "记录不存在或无权访问");
    if (
      existing.lastRequestId === requestId &&
      existing.version === expectedVersion + 1
    )
      return existing;
    fail("VERSION_CONFLICT", "记录已在其他设备上更新，请刷新后重试", {
      currentVersion: existing.version,
    });
  }

  /**
   * Attach a validated photo and its media ledger in one database transaction.
   * The conditional fallback is kept for the in-memory test store and older
   * SDKs; production wx-server-sdk exposes runTransaction and takes this path.
   */
  async attachMedicationThumbnail(
    medicationId,
    accountId,
    mediaId,
    thumbnailFileId,
  ) {
    await this.assertAccountActive(accountId);
    const result = await this.collection("medications")
      .where({
        _id: medicationId,
        accountId,
        "photo.mediaId": mediaId,
        status: "active",
      })
      .update({ data: { "photo.thumbnailFileId": thumbnailFileId } });
    if (updatedCount(result) !== 1)
      fail("VERSION_CONFLICT", "照片已更换，缩略图任务待重新核对");
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
    const apply = async (reader, writer, command) => {
      const account = await reader("accounts", accountId);
      const medication = await reader("medications", medicationId);
      const media = await reader("media", mediaId);
      if (!account || account.status !== "active")
        fail("ACCOUNT_UNAVAILABLE", "账号当前不可用");
      if (!medication || medication.accountId !== accountId)
        fail("NOT_FOUND", "药盒不存在或无权访问");
      if (medication.status !== "active")
        fail("MEDICATION_ARCHIVED", "只有正在管理的药盒可以添加照片");
      if (!media || media.accountId !== accountId)
        fail("MEDIA_NOT_FOUND", "照片上传任务不存在或无权访问");
      if (
        media.kind !== "medication-photo" ||
        media.medicationId !== medicationId
      )
        fail("INVALID_MEDIA_STATE", "照片上传任务与药盒不匹配");
      if (
        medication.photo?.mediaId === mediaId &&
        medication.photo?.fileId === fileId
      ) {
        return { medication, media };
      }
      if (medication.version !== expectedMedicationVersion)
        fail("VERSION_CONFLICT", "药盒已在其他设备更新，请刷新后重试");
      if (media.version !== expectedMediaVersion)
        fail("INVALID_MEDIA_STATE", "照片上传任务已被其他操作占用");
      if (
        !["prepared", "uploaded"].includes(media.status) ||
        (media.fileId && media.fileId !== fileId)
      )
        fail("INVALID_MEDIA_STATE", "照片上传任务尚未完成校验");
      const photo = {
        mediaId,
        fileId,
        updatedAt: now,
        ...(metadata.width
          ? { width: metadata.width, height: metadata.height }
          : {}),
        ...(metadata.thumbnailFileId
          ? { thumbnailFileId: metadata.thumbnailFileId }
          : {}),
      };
      const medicationPatch = {
        // A plain nested object is expanded to dotted updates by CloudBase.
        // Replacing the complete value also works when the old value is null.
        photo: command.set(photo),
        version: command.inc(1),
        updatedAt: now,
        lastRequestId: requestId,
      };
      const mediaPatch = {
        ...metadata,
        status: "attached",
        attachedAt: now,
        expiresAt: null,
        version: command.inc(1),
        updatedAt: now,
        lastRequestId: requestId,
      };
      await writer("medications", medicationId, medicationPatch);
      await writer("media", mediaId, mediaPatch);
      return {
        // Never return database command objects in the API DTO.
        medication: {
          ...medication,
          photo,
          version: medication.version + 1,
          updatedAt: now,
          lastRequestId: requestId,
        },
        media: {
          ...media,
          ...metadata,
          status: "attached",
          attachedAt: now,
          expiresAt: null,
          version: media.version + 1,
          updatedAt: now,
          lastRequestId: requestId,
        },
      };
    };

    if (typeof this.db.runTransaction === "function") {
      return this.db.runTransaction(async (transaction) => {
        const transactionCommand = transaction.command ?? this.command;
        const reader = async (key, id) => {
          const result = await transaction
            .collection(`${this.prefix}${COLLECTIONS[key]}`)
            .doc(id)
            .get();
          return result.data ?? null;
        };
        const writer = async (key, id, data) =>
          transaction
            .collection(`${this.prefix}${COLLECTIONS[key]}`)
            .doc(id)
            .update({ data });
        return apply(reader, writer, transactionCommand);
      });
    }

    const reader = async (key, id) =>
      key === "accounts"
        ? this.getDocument(key, id)
        : this.getOwned(key, id, accountId, { required: false });
    const writer = async (key, id, data) => {
      const current = await this.getOwned(key, id, accountId);
      const expected = current.version;
      const patch = { ...data };
      delete patch.version;
      return this.updateOwnedVersioned(
        key,
        id,
        accountId,
        expected,
        patch,
        now,
        requestId,
      );
    };
    return apply(reader, writer, this.command);
  }

  async removeOwnedVersioned(key, id, accountId, expectedVersion, requestId) {
    await this.assertAccountActive(accountId);
    const existing = await this.getOwned(key, id, accountId);
    if (existing.version !== expectedVersion) {
      fail("VERSION_CONFLICT", "记录已在其他设备上更新，请刷新后重试", {
        currentVersion: existing.version,
      });
    }
    const result = await this.collection(key)
      .where({ _id: id, accountId, version: expectedVersion })
      .remove();
    if (removedCount(result) !== 1)
      fail("VERSION_CONFLICT", "记录已在其他设备上更新，请刷新后重试");
    return { id, deleted: true, requestId };
  }

  async ensureSettings(accountId, now) {
    const id = deterministicId("settings", accountId);
    const existing = await this.getOwned("settings", id, accountId, {
      required: false,
    });
    if (existing) return existing;
    const settings = {
      _id: id,
      accountId,
      ...DEFAULT_SETTINGS,
      subscriptions: { ...DEFAULT_SETTINGS.subscriptions },
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    return this.createOwned("settings", settings);
  }

  async recordSubscriptionGrant(accountId, document) {
    const existing = await this.getOwned(
      "subscriptionGrants",
      document._id,
      accountId,
      { required: false },
    );
    if (existing) return existing;
    return this.createOwned("subscriptionGrants", document);
  }

  async listSubscriptionGrants(accountId, where = {}) {
    return this.listAllOwned("subscriptionGrants", accountId, where);
  }

  async listActiveAccounts() {
    const result = await this.collection("accounts")
      .where({ status: "active" })
      .limit(PAGE_SIZE)
      .get();
    return result.data ?? [];
  }

  async listAccountsForMaintenance() {
    return (await this.listAccountsForMaintenancePage()).items;
  }

  async listAccountsForMaintenancePage(
    cursor = null,
    limit = PAGE_SIZE,
    { status } = {},
  ) {
    let query = this.collection("accounts").orderBy("_id", "asc");
    const where = {};
    if (cursor) where._id = this.command.gt(cursor);
    if (status) where.status = status;
    if (Object.keys(where).length > 0) query = query.where(where);
    const result = await query.limit(Math.min(limit, PAGE_SIZE) + 1).get();
    const data = result.data ?? [];
    const page = data.length > limit ? data.slice(0, limit) : data;
    return {
      items: page,
      nextCursor: data.length > limit ? page[page.length - 1]._id : null,
    };
  }

  async listDeletingAccountsForMaintenancePage(
    cursor = null,
    limit = PAGE_SIZE,
  ) {
    return this.listAccountsForMaintenancePage(cursor, limit, {
      status: "deleting",
    });
  }

  async getMaintenanceCheckpoint() {
    return (
      (await this.getDocument("maintenanceCheckpoints", "global")) ?? {
        _id: "global",
        cursor: null,
        deletingCursor: null,
        deletingSweepComplete: false,
        round: 1,
        version: 1,
      }
    );
  }

  async saveMaintenanceCheckpoint(next) {
    const current = await this.getDocument("maintenanceCheckpoints", "global");
    const now = new Date().toISOString();
    if (!current) {
      await this.collection("maintenanceCheckpoints").add({
        data: {
          _id: "global",
          cursor: next.cursor ?? null,
          deletingCursor: next.deletingCursor ?? null,
          deletingSweepComplete: next.deletingSweepComplete === true,
          round: next.round ?? 1,
          version: 1,
          leaseId: next.releaseLease ? null : (next.leaseId ?? null),
          leaseUntil: next.releaseLease ? null : (next.leaseUntil ?? null),
          updatedAt: now,
        },
      });
      return true;
    }
    const where = { _id: "global", version: current.version };
    if (next.leaseId) where.leaseId = next.leaseId;
    const result = await this.collection("maintenanceCheckpoints")
      .where(where)
      .update({
        data: {
          cursor: next.cursor ?? null,
          deletingCursor: next.deletingCursor ?? null,
          deletingSweepComplete: next.deletingSweepComplete === true,
          round: next.round ?? current.round ?? 1,
          leaseId: next.releaseLease ? null : (next.leaseId ?? null),
          leaseUntil: next.releaseLease ? null : (next.leaseUntil ?? null),
          version: this.command.inc(1),
          updatedAt: now,
        },
      });
    return updatedCount(result) === 1;
  }

  async claimMaintenanceLease(now, leaseUntil, leaseId) {
    let current = await this.getDocument("maintenanceCheckpoints", "global");
    if (!current) {
      try {
        await this.collection("maintenanceCheckpoints").add({
          data: {
            _id: "global",
            cursor: null,
            deletingCursor: null,
            deletingSweepComplete: false,
            round: 1,
            version: 1,
            leaseId,
            leaseUntil,
            updatedAt: now,
          },
        });
        return true;
      } catch (error) {
        if (!isDuplicateError(error)) throw error;
        current = await this.getDocument("maintenanceCheckpoints", "global");
      }
    }
    if (!current) return false;
    const base = { _id: "global", version: current.version };
    const expired = await this.collection("maintenanceCheckpoints")
      .where({ ...base, leaseUntil: this.command.lte(now) })
      .update({
        data: {
          leaseId,
          leaseUntil,
          version: this.command.inc(1),
          updatedAt: now,
        },
      });
    if (updatedCount(expired) === 1) return true;
    const neverLeased = await this.collection("maintenanceCheckpoints")
      .where({ ...base, leaseUntil: null })
      .update({
        data: {
          leaseId,
          leaseUntil,
          version: this.command.inc(1),
          updatedAt: now,
        },
      });
    return updatedCount(neverLeased) === 1;
  }

  async getAccountForMaintenance(accountId) {
    return this.getDocument("accounts", accountId);
  }

  async recordMaintenanceFailure(accountId, code, now) {
    const jobId = deterministicId("maintenance-job", accountId);
    const existing = await this.getDocument("maintenanceJobs", jobId);
    const currentAttempts = Number(existing?.attempts ?? 0);
    const attempts = Math.min(currentAttempts + 1, 5);
    const status = attempts >= 5 ? "needs_attention" : "retryable";
    const nextAttemptAt = new Date(
      Date.parse(now) + Math.min(60 * 60_000, 2 ** (attempts - 1) * 60_000),
    ).toISOString();
    const data = {
      _id: jobId,
      accountId,
      type: "account-maintenance",
      attempts,
      status,
      nextAttemptAt,
      lastErrorCode: safeMaintenanceCode(code),
      updatedAt: now,
      createdAt: existing?.createdAt ?? now,
    };
    if (!existing) {
      await this.collection("maintenanceJobs").add({ data });
      return data;
    }
    await this.collection("maintenanceJobs").doc(jobId).update({ data });
    return data;
  }

  async listMaintenanceRetryJobs(now, limit = 10) {
    const result = await this.collection("maintenanceJobs")
      .where({ status: "retryable", nextAttemptAt: this.command.lte(now) })
      .orderBy("nextAttemptAt", "asc")
      .limit(Math.min(limit, 10))
      .get();
    return result.data ?? [];
  }

  async markMaintenanceRetryJob(jobId, status, now) {
    await this.collection("maintenanceJobs")
      .doc(jobId)
      .update({
        data: {
          status,
          completedAt: status === "completed" ? now : null,
          updatedAt: now,
        },
      });
  }

  async claimIdempotency({ accountId, action, requestId, requestHash, now }) {
    await this.assertAccountActive(accountId);
    const id = deterministicId("idem", accountId, action, requestId);
    const document = {
      _id: id,
      accountId,
      action,
      requestId,
      requestHash,
      state: "pending",
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(Date.parse(now) + 7 * 86400000).toISOString(),
    };
    try {
      await this.collection("idempotency").add({ data: document });
      try {
        await this.assertAccountActive(accountId);
      } catch (error) {
        await this.collection("idempotency")
          .doc(id)
          .remove()
          .catch(() => {});
        throw error;
      }
      return { state: "claimed", id };
    } catch (error) {
      if (!isDuplicateError(error)) throw error;
      const existing = await this.getDocument("idempotency", id);
      if (!existing) throw error;
      if (existing.requestHash !== requestHash)
        fail("IDEMPOTENCY_KEY_REUSED", "requestId 已用于不同请求");
      if (existing.state === "completed")
        return { state: "replay", id, response: existing.response };
      if (existing.state === "failed")
        return { state: "replay", id, response: existing.response };
      fail("OPERATION_IN_PROGRESS", "相同请求正在处理，请稍后重试");
    }
  }

  async completeIdempotency(id, response, now) {
    await this.collection("idempotency")
      .doc(id)
      .update({
        data: {
          state: response.ok ? "completed" : "failed",
          response,
          updatedAt: now,
        },
      });
  }

  async findDeletionTombstone(openid, requestId) {
    const id = deterministicId("delete", this.ownerHashFor(openid), requestId);
    return this.getDocument("deletionJobs", id);
  }

  async createDeletionTombstone(openid, requestId, accountId, now) {
    const id = deterministicId("delete", this.ownerHashFor(openid), requestId);
    const document = {
      _id: id,
      ownerHash: this.ownerHashFor(openid),
      accountIdHash: sha256(accountId),
      requestIdHash: sha256(requestId),
      state: "processing",
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(Date.parse(now) + 30 * 86400000).toISOString(),
    };
    try {
      await this.collection("deletionJobs").add({ data: document });
      return document;
    } catch (error) {
      if (!isDuplicateError(error)) throw error;
      return this.getDocument("deletionJobs", id);
    }
  }

  async finishDeletionTombstone(id, now) {
    await this.collection("deletionJobs")
      .doc(id)
      .update({
        data: { state: "completed", completedAt: now, updatedAt: now },
      });
  }

  async markDeletionPending(id, now, reason = "CLEANUP_PENDING") {
    await this.collection("deletionJobs")
      .doc(id)
      .update({
        data: { state: "pending", lastError: reason, updatedAt: now },
      });
  }

  async exportAccount(accountId, now) {
    const [
      profiles,
      medications,
      plans,
      snapshots,
      intakeLogs,
      settings,
      calendarExports,
    ] = await Promise.all([
      this.listAllOwned("profiles", accountId),
      this.listAllOwned("medications", accountId),
      this.listAllOwned("plans", accountId),
      this.listAllOwned("snapshots", accountId),
      this.listAllOwned("intakeLogs", accountId),
      this.listAllOwned("settings", accountId),
      this.listAllOwned("calendarExports", accountId),
    ]);
    const clean = (documents) => documents.map(publicDocument);
    const cleanMedications = medications.map((document) => {
      const safe = publicDocument(document);
      return {
        ...safe,
        photo: safe.photo
          ? {
              included: false,
              updatedAt: safe.photo.updatedAt,
              notice: "照片文件与内部存储地址不包含在文本导出中",
            }
          : null,
      };
    });
    const exported = {
      schemaVersion: 1,
      exportedAt: now,
      timezone: "Asia/Shanghai",
      profiles: clean(profiles),
      medications: cleanMedications,
      plans: clean(plans),
      inventorySnapshots: clean(snapshots),
      intakeLogs: clean(intakeLogs),
      settings: clean(settings),
      calendarExports: clean(calendarExports),
    };
    if (
      Buffer.byteLength(JSON.stringify(exported), "utf8") > EXPORT_BYTES_LIMIT
    ) {
      fail("EXPORT_TOO_LARGE", "导出文件过大，请联系支持人员导出");
    }
    return exported;
  }

  async deleteAccountData(accountId) {
    const completed = await this.processAccountDeletion(accountId);
    if (!completed) throw new Error("ACCOUNT_DELETION_PENDING");
  }

  async processAccountDeletion(accountId) {
    const media = await this.listAllOwned("media", accountId);
    let complete = true;
    for (const item of media) {
      if (item.fileId) {
        if (!this.photoStorage) {
          complete = false;
          continue;
        }
        try {
          await this.photoStorage.deleteFile(item.fileId);
        } catch (_) {
          complete = false;
        }
      }
    }
    if (!complete) return false;
    const keys = [
      "profiles",
      "medications",
      "plans",
      "snapshots",
      "intakeLogs",
      "settings",
      "calendarExports",
      "reminderTasks",
      "idempotency",
      "media",
      "subscriptionGrants",
    ];
    for (const key of keys) await this.deleteAllOwned(key, accountId);
    const account = await this.getDocument("accounts", accountId);
    if (account) await this.collection("accounts").doc(accountId).remove();
    // Maintenance can finish a deletion without the original request in
    // hand. Close every matching tombstone after physical cleanup so a
    // replay cannot leave a permanent `processing` marker.
    const tombstones = await this.collection("deletionJobs")
      .where({ accountIdHash: sha256(accountId), state: "processing" })
      .limit(PAGE_SIZE)
      .get();
    await Promise.all(
      (tombstones.data ?? []).map((item) =>
        this.collection("deletionJobs")
          .doc(item._id)
          .update({
            data: {
              state: "completed",
              completedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          }),
      ),
    );
    return true;
  }

  async deleteAllOwned(key, accountId, where = {}) {
    while (true) {
      const result = await this.collection(key)
        .where({ accountId, ...where })
        .limit(PAGE_SIZE)
        .get();
      const page = result.data ?? [];
      if (!page.length) return;
      await Promise.all(
        page.map((document) => this.collection(key).doc(document._id).remove()),
      );
    }
  }

  async cancelReminderTasks(accountId, medicationId, now, keepIds = []) {
    const result = await this.collection("reminderTasks")
      .where({ accountId, medicationId, status: "pending" })
      .limit(PAGE_SIZE)
      .get();
    const keep = new Set(
      Array.isArray(keepIds) ? keepIds : [keepIds].filter(Boolean),
    );
    const tasks = (result.data ?? []).filter((item) => !keep.has(item._id));
    await Promise.all(
      tasks.map((task) =>
        this.collection("reminderTasks")
          .doc(task._id)
          .update({ data: { status: "canceled", updatedAt: now } }),
      ),
    );
  }

  async putReminderTask(task) {
    const existing = await this.getOwned(
      "reminderTasks",
      task._id,
      task.accountId,
      { required: false },
    );
    if (existing) {
      if (existing.status === "pending") {
        await this.collection("reminderTasks")
          .doc(existing._id)
          .update({
            data: {
              dueAt: task.dueAt,
              nextAttemptAt: task.nextAttemptAt,
              payload: task.payload,
              sourceVersion: task.sourceVersion,
              templateId: task.templateId ?? null,
              updatedAt: task.updatedAt,
            },
          });
      }
      return this.getOwned("reminderTasks", task._id, task.accountId);
    }
    return this.createOwned("reminderTasks", task);
  }

  async markReminderTaskExpired(task, now) {
    await this.collection("reminderTasks")
      .doc(task._id)
      .update({
        data: { status: "expired", leaseUntil: null, updatedAt: now },
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
    // This is a point lookup, not an account-wide first page scan. A large
    // history must not make an already-taken occurrence look sendable.
    const base = {
      accountId: task.accountId,
      medicationId: task.medicationId,
      planId: task.planId,
      scheduledAt: task.scheduledAt,
      status: this.command.in(["taken", "skipped"]),
    };
    const queries = [
      { ...base, voidedAt: null },
      ...(typeof this.command.exists === "function"
        ? [{ ...base, voidedAt: this.command.exists(false) }]
        : []),
    ];
    const results = await Promise.all(
      queries.map((query) =>
        this.collection("intakeLogs").where(query).limit(1).get(),
      ),
    );
    return !results.some((result) =>
      (result.data ?? []).some((log) => !log.voidedAt),
    );
  }

  async reserveSubscriptionGrant(accountId, templateId, now, binding = {}) {
    if (!binding.taskId || !binding.medicationId || !binding.kind) return false;
    const grants = await this.listAllOwned("subscriptionGrants", accountId);
    const existing = grants.find(
      (item) =>
        item.templateId === templateId &&
        item.status === "accept" &&
        item.authorizedMedicationId === binding.medicationId &&
        item.reservedTaskId === binding.taskId,
    );
    if (existing)
      return { reserved: true, grantId: existing._id, idempotent: true };
    const candidate = grants.find(
      (item) =>
        item.templateId === templateId &&
        item.status === "accept" &&
        item.authorizedMedicationId === binding.medicationId &&
        (item.usableCount ?? 0) > 0,
    );
    if (!candidate) return false;
    const result = await this.collection("subscriptionGrants")
      .where({
        _id: candidate._id,
        accountId,
        version: candidate.version,
        reservedTaskId: null,
        usableCount: this.command.gt(0),
      })
      .update({
        data: {
          usableCount: this.command.inc(-1),
          updatedAt: now,
          version: this.command.inc(1),
          reservedTaskId: binding.taskId,
          reservedMedicationId: binding.medicationId,
          reservedKind: binding.kind,
        },
      });
    if (updatedCount(result) === 1)
      return { reserved: true, grantId: candidate._id };
    const raced = await this.getDocument("subscriptionGrants", candidate._id);
    return raced?.reservedTaskId === binding.taskId
      ? { reserved: true, grantId: raced._id, idempotent: true }
      : false;
  }

  async finalizeSubscriptionGrant(accountId, grantId, now, binding = {}) {
    if (!grantId) return false;
    if (!binding.taskId) return false;
    const result = await this.collection("subscriptionGrants")
      .where({ _id: grantId, accountId, reservedTaskId: binding.taskId })
      .update({
        data: {
          reservedTaskId: null,
          reservedMedicationId: null,
          reservedKind: null,
          updatedAt: now,
        },
      });
    return updatedCount(result) === 1;
  }

  async releaseSubscriptionGrant(accountId, grantId, now, binding = {}) {
    if (!grantId) return false;
    if (!binding.taskId) return false;
    const result = await this.collection("subscriptionGrants")
      .where({ _id: grantId, accountId, reservedTaskId: binding.taskId })
      .update({
        data: {
          usableCount: this.command.inc(1),
          reservedTaskId: null,
          reservedMedicationId: null,
          reservedKind: null,
          version: this.command.inc(1),
          updatedAt: now,
        },
      });
    return updatedCount(result) === 1;
  }

  async markCalendarExportsStale(accountId, medicationId, now) {
    const result = await this.collection("calendarExports")
      .where({ accountId, medicationId, staleAt: null })
      .limit(PAGE_SIZE)
      .get();
    await Promise.all(
      (result.data ?? []).map((item) =>
        this.collection("calendarExports")
          .doc(item._id)
          .update({
            data: {
              staleAt: now,
              version: this.command.inc(1),
              updatedAt: now,
            },
          }),
      ),
    );
  }
}

function publicDocument(document) {
  const { _openid, accountId, lastRequestId, ...safe } = document;
  return safe;
}

function updatedCount(result) {
  return result?.stats?.updated ?? result?.updated ?? 0;
}

function removedCount(result) {
  return result?.stats?.removed ?? result?.removed ?? 0;
}

function safeMaintenanceCode(value) {
  const code = String(value ?? "UNKNOWN");
  return /^[A-Za-z0-9_-]{1,40}$/.test(code) ? code : "UNSAFE";
}

function isDuplicateError(error) {
  const code = String(error?.errCode ?? error?.code ?? "");
  const message = String(error?.errMsg ?? error?.message ?? "");
  return (
    code.includes("-501001") ||
    code.includes("DUPLICATE") ||
    /already exists|duplicate/i.test(message)
  );
}

function isNotFoundError(error) {
  const code = String(error?.errCode ?? error?.code ?? "");
  const message = String(error?.errMsg ?? error?.message ?? "");
  return (
    code.includes("-502005") ||
    code.includes("NOT_FOUND") ||
    /not exist|not found/i.test(message)
  );
}

module.exports = { CloudStore, publicDocument };
