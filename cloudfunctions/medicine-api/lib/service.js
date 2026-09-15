"use strict";

const {
  calculateEffectiveExpiry,
  effectiveExpiry,
  estimateInventory,
  expiryState,
  occurrencesForDate,
  projectedRunOut,
} = require("./domain");
const { fail, isAppError } = require("./errors");
const { deterministicId, sha256 } = require("./hash");
const {
  fileIdMatchesCloudPath,
  MAX_PHOTO_BYTES,
  inspectImage,
} = require("./photo-storage");
const { publicDocument } = require("./store");
const {
  addCalendarDays,
  addDays,
  chinaDate,
  chinaDateTime,
  chinaStartOfDay,
} = require("./time");

class MedicineService {
  constructor(store, options = {}) {
    this.store = store;
    this.clock = options.clock ?? (() => new Date());
    this.logger = options.logger ?? { warn() {} };
    this.photoStorage = options.photoStorage ?? null;
  }

  now() {
    return this.clock().toISOString();
  }

  photoStage(stage, context, details = {}) {
    this.logger.info?.("MEDICINE_API_PHOTO_STAGE", {
      stage,
      requestId: context?.requestId,
      traceId: context?.traceId,
      ...details,
    });
  }

  async publicMedication(document) {
    const safe = publicDocument(document);
    if (!safe.photo || !this.photoStorage?.getViewUrl) return safe;
    try {
      const [url, thumbnailUrl] = await Promise.all([
        this.photoStorage.getViewUrl(safe.photo.fileId),
        safe.photo.thumbnailFileId
          ? this.photoStorage
              .getViewUrl(safe.photo.thumbnailFileId)
              .catch(() => null)
          : null,
      ]);
      safe.photo = {
        mediaId: safe.photo.mediaId,
        updatedAt: safe.photo.updatedAt,
        url,
        ...(thumbnailUrl ? { thumbnailUrl } : {}),
        ...(safe.photo.width
          ? { width: safe.photo.width, height: safe.photo.height }
          : {}),
        viewStatus: "ready",
      };
    } catch (error) {
      // A single signed-URL failure is a view failure, not a failed bootstrap
      // or failed medication save. The next read can refresh the URL.
      this.logger.warn?.("PHOTO_VIEW_FAILED", { code: "PHOTO_VIEW_FAILED" });
      safe.photo = {
        mediaId: safe.photo.mediaId,
        updatedAt: safe.photo.updatedAt,
        url: null,
        viewStatus: "view_failed",
      };
    }
    return safe;
  }

  async execute(action, payload, context) {
    switch (action) {
      case "bootstrap":
        return this.bootstrap(context);
      case "today.get":
        return this.getToday(context);
      case "cabinet.get":
        return this.getCabinet(context);
      case "profile.list":
        return this.listProfiles(context);
      case "profile.create":
        return this.createProfile(payload, context);
      case "profile.update":
        return this.updateProfile(payload, context);
      case "profile.delete":
        return this.deleteProfile(payload, context);
      case "medication.get":
        return this.getMedication(payload, context);
      case "medication.create":
        return this.createMedication(payload, context);
      case "medication.update":
        return this.updateMedication(payload, context);
      case "medication.archive":
        return this.archiveMedication(payload, context);
      case "medication.delete":
        return this.deleteMedication(payload, context);
      case "plan.list":
        return this.listPlans(payload, context);
      case "plan.save":
        return this.savePlan(payload, context);
      case "plan.stop":
        return this.stopPlan(payload, context);
      case "snapshot.list":
        return this.listSnapshots(payload, context);
      case "snapshot.create":
        return this.createSnapshot(payload, context);
      case "intake.list":
        return this.listIntake(payload, context);
      case "intake.record":
        return this.recordIntake(payload, context);
      case "intake.undo":
        return this.undoIntake(payload, context);
      case "settings.get":
        return this.getSettings(context);
      case "settings.update":
        return this.updateSettings(payload, context);
      case "getMedicationPhotoStatus":
        return this.getMedicationPhotoStatus(payload, context);
      case "recordSubscriptionGrant":
        return this.recordSubscriptionGrant(payload, context);
      case "getReminderStatus":
        return this.getReminderStatus(payload, context);
      case "updateReminderSettings":
        return this.updateReminderSettings(payload, context);
      case "data.export":
        return this.store.exportAccount(context.accountId, this.now());
      default:
        fail("INVALID_ARGUMENT", "action 不受支持");
    }
  }

  async bootstrap(context) {
    const now = this.now();
    const [settings, profilesPage] = await Promise.all([
      this.store.ensureSettings(context.accountId, now),
      this.store.listOwned("profiles", context.accountId, { limit: 10 }),
    ]);
    let profiles = profilesPage.items;
    if (
      !profiles.length &&
      (settings.privacyAcceptedVersion ||
        typeof this.store.assertPrivacyAccepted !== "function")
    ) {
      const profile = await this.store.createOwned("profiles", {
        _id: deterministicId("profile", context.accountId, "self"),
        accountId: context.accountId,
        displayName: "我",
        relation: "self",
        color: "#2B7A67",
        archivedAt: null,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      profiles = [profile];
    }
    return {
      profiles: profiles.map(publicDocument),
      settings: publicDocument(settings),
    };
  }

  async listProfiles(context) {
    const page = await this.store.listOwned("profiles", context.accountId, {
      limit: 20,
    });
    return { items: page.items.map(publicDocument), nextCursor: null };
  }

  async createProfile(payload, context) {
    const page = await this.store.listOwned("profiles", context.accountId, {
      limit: 20,
    });
    if (page.items.length >= 10)
      fail("LIMIT_EXCEEDED", "最多可管理 10 位家庭成员");
    if (
      payload.relation === "self" &&
      page.items.some((profile) => profile.relation === "self")
    ) {
      fail("CONFLICT", "“我”成员已存在");
    }
    const now = this.now();
    const document = {
      _id: deterministicId("profile", context.accountId, context.requestId),
      accountId: context.accountId,
      ...payload,
      archivedAt: null,
      version: 1,
      lastRequestId: context.requestId,
      createdAt: now,
      updatedAt: now,
    };
    return publicDocument(await this.store.createOwned("profiles", document));
  }

  async updateProfile(payload, context) {
    if (payload.patch.relation === "self") {
      const profiles = (
        await this.store.listOwned("profiles", context.accountId, { limit: 20 })
      ).items;
      if (
        profiles.some(
          (profile) =>
            profile.relation === "self" && profile._id !== payload.id,
        )
      )
        fail("CONFLICT", "“我”成员已存在");
    }
    const updated = await this.store.updateOwnedVersioned(
      "profiles",
      payload.id,
      context.accountId,
      payload.expectedVersion,
      payload.patch,
      this.now(),
      context.requestId,
    );
    return publicDocument(updated);
  }

  async deleteProfile(payload, context) {
    const medications = await this.store.listOwned(
      "medications",
      context.accountId,
      { where: { profileId: payload.id }, limit: 1 },
    );
    if (medications.items.length)
      fail("PROFILE_IN_USE", "该成员仍有药品，请先移除或转移药品");
    const profiles = await this.store.listOwned("profiles", context.accountId, {
      limit: 20,
    });
    if (profiles.items.length <= 1)
      fail("LAST_PROFILE", "至少需要保留一位成员");
    return this.store.removeOwnedVersioned(
      "profiles",
      payload.id,
      context.accountId,
      payload.expectedVersion,
      context.requestId,
    );
  }

  async getMedication(payload, context) {
    const medication = await this.store.getOwned(
      "medications",
      payload.id,
      context.accountId,
    );
    const [plans, snapshots] = await Promise.all([
      this.store.listAllOwned("plans", context.accountId, {
        medicationId: payload.id,
      }),
      this.store.listAllOwned("snapshots", context.accountId, {
        medicationId: payload.id,
      }),
    ]);
    snapshots.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
    return {
      medication: await this.publicMedication(medication),
      activePlan: publicDocumentOrNull(
        plans.find((plan) => plan._id === medication.activePlanId),
      ),
      latestSnapshot: publicDocumentOrNull(snapshots[0]),
    };
  }

  async createMedication(payload, context) {
    await this.store.getOwned("profiles", payload.profileId, context.accountId);
    assertMedicationDates(payload, this.now());
    const now = this.now();
    const medication = await this.store.createOwned("medications", {
      _id: deterministicId("med", context.accountId, context.requestId),
      accountId: context.accountId,
      ...payload,
      photo: null,
      mode: payload.mode ?? "expiry_only",
      status: "active",
      archivedAt: null,
      activePlanId: null,
      version: 1,
      lastRequestId: context.requestId,
      createdAt: now,
      updatedAt: now,
    });
    await this.safeRefreshReminders(medication._id, context);
    return this.publicMedication(medication);
  }

  async updateMedication(payload, context) {
    const current = await this.store.getOwned(
      "medications",
      payload.id,
      context.accountId,
    );
    if (current.status === "deleting")
      fail("MEDICATION_DELETING", "药品正在删除，请稍后刷新");
    if (payload.patch.profileId)
      await this.store.getOwned(
        "profiles",
        payload.patch.profileId,
        context.accountId,
      );
    const reconciled = { ...current, ...payload.patch };
    assertMedicationDates(reconciled, this.now());
    if (payload.patch.unit && current.activePlanId) {
      const plan = await this.store.getOwned(
        "plans",
        current.activePlanId,
        context.accountId,
        { required: false },
      );
      if (plan && plan.unit !== payload.patch.unit)
        fail("UNIT_MISMATCH", "药品单位与当前计划不一致，请先停止计划");
    }
    const updated = await this.store.updateOwnedVersioned(
      "medications",
      payload.id,
      context.accountId,
      payload.expectedVersion,
      payload.patch,
      this.now(),
      context.requestId,
    );
    await this.safeRefreshReminders(updated._id, context);
    return this.publicMedication(updated);
  }

  async archiveMedication(payload, context) {
    let current = await this.store.getOwned(
      "medications",
      payload.id,
      context.accountId,
    );
    if (current.status === "deleting")
      fail("MEDICATION_DELETING", "药品正在删除，请稍后刷新");
    if (current.version !== payload.expectedVersion) {
      fail("VERSION_CONFLICT", "记录已在其他设备上更新，请刷新后重试", {
        currentVersion: current.version,
      });
    }
    if (current.activePlanId) {
      const stopped = await this.stopPlan(
        {
          medicationId: current._id,
          expectedMedicationVersion: current.version,
        },
        context,
      );
      current = stopped.medication;
    }
    const updated = await this.store.updateOwnedVersioned(
      "medications",
      payload.id,
      context.accountId,
      current.version,
      { status: "archived", archivedAt: this.now(), activePlanId: null },
      this.now(),
      context.requestId,
    );
    await this.store.cancelReminderTasks(
      context.accountId,
      payload.id,
      this.now(),
    );
    await this.store.markCalendarExportsStale(
      context.accountId,
      payload.id,
      this.now(),
    );
    return this.publicMedication(updated);
  }

  async deleteMedication(payload, context) {
    const medication = await this.store.getOwned(
      "medications",
      payload.id,
      context.accountId,
    );
    const resumingDeletion = medication.status === "deleting";
    const acceptedDeletionVersion = resumingDeletion
      ? (medication.deletionStartedFromVersion ?? medication.version)
      : medication.version;
    if (
      payload.expectedVersion !== acceptedDeletionVersion &&
      !(resumingDeletion && payload.expectedVersion === medication.version)
    ) {
      fail("VERSION_CONFLICT", "记录已在其他设备上更新，请刷新后重试", {
        currentVersion: medication.version,
      });
    }
    const locked = resumingDeletion
      ? medication
      : await this.store.updateOwnedVersioned(
          "medications",
          payload.id,
          context.accountId,
          payload.expectedVersion,
          {
            status: "deleting",
            activePlanId: null,
            deletionStartedFromVersion: payload.expectedVersion,
            deletionStartedAt: this.now(),
          },
          this.now(),
          context.requestId,
        );
    await Promise.all([
      this.store.deleteAllOwned("plans", context.accountId, {
        medicationId: payload.id,
      }),
      this.store.deleteAllOwned("snapshots", context.accountId, {
        medicationId: payload.id,
      }),
      this.store.deleteAllOwned("intakeLogs", context.accountId, {
        medicationId: payload.id,
      }),
      this.store.deleteAllOwned("reminderTasks", context.accountId, {
        medicationId: payload.id,
      }),
      this.store.deleteAllOwned("calendarExports", context.accountId, {
        medicationId: payload.id,
      }),
    ]);
    await this.cleanupMedicationMedia(payload.id, context);
    return this.store.removeOwnedVersioned(
      "medications",
      payload.id,
      context.accountId,
      locked.version,
      context.requestId,
    );
  }

  async prepareMedicationPhoto(payload, context) {
    this.photoStage("prepare_start", context);
    const medication = await this.store.getOwned(
      "medications",
      payload.medicationId,
      context.accountId,
    );
    if (medication.status !== "active")
      fail("MEDICATION_ARCHIVED", "只有正在管理的药盒可以添加照片");
    if (medication.version !== payload.expectedVersion) {
      fail("VERSION_CONFLICT", "药盒已在其他设备更新，请刷新后重试", {
        currentVersion: medication.version,
      });
    }
    // Expired media is handled by the durable maintenance sweep.
    const now = this.now();
    const mediaId = deterministicId(
      "media",
      context.accountId,
      context.requestId,
    );
    const ownerFolder = deterministicId("owner", context.accountId);
    const cloudPath = `medication-photos/${ownerFolder}/${mediaId}.jpg`;
    const existing = await this.store.getOwned(
      "media",
      mediaId,
      context.accountId,
      { required: false },
    );
    if (
      existing &&
      (existing.kind !== "medication-photo" ||
        existing.medicationId !== medication._id ||
        existing.status !== "prepared")
    ) {
      fail("INVALID_MEDIA_STATE", "照片上传任务已经失效，请重新选择");
    }
    if (!existing) {
      await this.store.createOwned("media", {
        _id: mediaId,
        accountId: context.accountId,
        medicationId: medication._id,
        kind: "medication-photo",
        cloudPath,
        fileId: null,
        status: "prepared",
        leaseUntil: new Date(Date.parse(now) + 30 * 60 * 1000).toISOString(),
        expiresAt: new Date(
          Date.parse(now) + 24 * 60 * 60 * 1000,
        ).toISOString(),
        version: 1,
        lastRequestId: context.requestId,
        createdAt: now,
        updatedAt: now,
      });
    }
    const ticket = {
      mediaId,
      cloudPath,
      expiresAt:
        existing?.expiresAt ??
        new Date(Date.parse(now) + 24 * 60 * 60 * 1000).toISOString(),
      maxBytes: MAX_PHOTO_BYTES,
      transport: "cloud",
      protocol: "chunks-v2",
    };
    this.photoStage("prepare_success", context);
    return ticket;
  }

  async uploadMedicationPhoto(payload, context, sealed = false) {
    if (!this.photoStorage) fail("MEDIA_UNAVAILABLE", "照片服务暂时不可用");
    this.photoStage("storage_write_start", context, {
      byteSize: Buffer.byteLength(payload.base64, "base64"),
    });
    const medication = await this.store.getOwned(
      "medications",
      payload.medicationId,
      context.accountId,
    );
    const media = await this.store.getOwned(
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
    if (media.expiresAt < this.now())
      fail("MEDIA_UPLOAD_EXPIRED", "照片上传已超时，请重新选择");
    const contentHash = sha256(payload.base64);
    if (media.fileId) {
      if (media.contentHash !== contentHash)
        fail("INVALID_MEDIA_STATE", "照片上传任务已用于另一张照片，请重新选择");
      return {
        fileId: media.fileId,
        ...(sealed ? { inspected: media.sealedMetadata } : {}),
      };
    }
    // Claim the ticket before writing: concurrent requests cannot overwrite a
    // file that another request is validating or attaching.
    const locked = await this.store.updateOwnedVersioned(
      "media",
      media._id,
      context.accountId,
      media.version,
      {
        status: "uploading",
        contentHash,
        leaseUntil: new Date(
          Date.parse(this.now()) + 30 * 60 * 1000,
        ).toISOString(),
      },
      this.now(),
      context.requestId,
    );
    let fileId;
    const bytes = Buffer.from(payload.base64, "base64");
    const inspected = { ...inspectImage(bytes), byteSize: bytes.length };
    // A separate path prevents a late native upload to the ticket path
    // from replacing bytes already validated by this pipeline.
    const writePath = sealed
      ? `${media.cloudPath}.sealed.jpg`
      : media.cloudPath;
    try {
      fileId = await this.photoStorage.uploadImage(writePath, bytes);
      await this.store.updateOwnedVersioned(
        "media",
        media._id,
        context.accountId,
        locked.version,
        {
          status: "uploaded",
          fileId,
          ...(sealed
            ? {
                cloudPath: writePath,
                sealedMetadata: inspected,
                thumbnailStatus: "pending",
              }
            : {}),
          leaseUntil: new Date(
            Date.parse(this.now()) + 30 * 60 * 1000,
          ).toISOString(),
        },
        this.now(),
        context.requestId,
      );
      this.photoStage("storage_write_success", context, {
        byteSize: Buffer.byteLength(payload.base64, "base64"),
      });
      return { fileId, ...(sealed ? { inspected } : {}) };
    } catch (error) {
      this.photoStage("storage_write_failure", context, {
        errorCategory: isAppError(error) ? error.code : "INTERNAL",
      });
      // The storage write or the ledger update may have succeeded before the
      // SDK returned the error. Mark it for leased background reconciliation;
      // never delete an object directly from this ambiguous path.
      await this.store
        .updateOwnedVersioned(
          "media",
          locked._id,
          context.accountId,
          locked.version,
          {
            status: "cleanup_pending",
            leaseUntil: new Date(
              Date.parse(this.now()) + 30 * 60 * 1000,
            ).toISOString(),
          },
          this.now(),
          context.requestId,
        )
        .catch(() => undefined);
      throw error;
    }
  }

  async commitMedicationPhoto(payload, context, trustedMetadata = null) {
    if (!this.photoStorage) fail("MEDIA_UNAVAILABLE", "照片服务暂时不可用");
    this.photoStage("commit_start", context);
    const expectedCloudPath = `medication-photos/${deterministicId(
      "owner",
      context.accountId,
    )}/${payload.mediaId}.jpg`;
    if (
      !fileIdMatchesCloudPath(
        payload.fileId,
        trustedMetadata ? `${expectedCloudPath}.sealed.jpg` : expectedCloudPath,
      )
    )
      fail("FORBIDDEN", "照片不属于当前上传任务");
    const media = await this.store.getOwned(
      "media",
      payload.mediaId,
      context.accountId,
      { required: false },
    );
    if (!media) {
      await this.photoStorage.deleteFile(payload.fileId).catch(() => {});
      fail("INVALID_MEDIA_STATE", "照片上传任务已经失效，请重新选择");
    }
    const medication = await this.store.getOwned(
      "medications",
      payload.medicationId,
      context.accountId,
    );
    if (medication.status !== "active")
      fail("MEDICATION_ARCHIVED", "只有正在管理的药盒可以添加照片");
    if (
      medication.photo?.mediaId === payload.mediaId &&
      medication.photo?.fileId === payload.fileId
    ) {
      return this.publicMedication(medication);
    }
    if (medication.version !== payload.expectedVersion) {
      fail("VERSION_CONFLICT", "药盒已在其他设备更新，请刷新后重试", {
        currentVersion: medication.version,
      });
    }
    if (
      media.kind !== "medication-photo" ||
      media.medicationId !== medication._id ||
      !["prepared", "uploaded"].includes(media.status)
    ) {
      fail("INVALID_MEDIA_STATE", "照片上传任务已经失效，请重新选择");
    }
    if (media.expiresAt < this.now())
      fail("MEDIA_UPLOAD_EXPIRED", "照片上传已超时，请重新选择");
    const validationStartedAtMs = Date.now();
    if (
      trustedMetadata &&
      (media.fileId !== payload.fileId || !media.sealedMetadata)
    )
      fail("INVALID_MEDIA_STATE", "照片尚未完成校验");
    const inspected =
      trustedMetadata ??
      (await this.photoStorage.inspectOwnedImage(
        payload.fileId,
        media.cloudPath,
      ));
    this.photoStage("commit_validated", context, {
      byteSize: inspected.byteSize,
      elapsedMs: Date.now() - validationStartedAtMs,
      thumbnailByteSize: inspected.thumbnailByteSize ?? 0,
      thumbnailMs: inspected.thumbnailMs ?? 0,
    });
    const previousPhoto = medication.photo ?? null;
    const now = this.now();
    let attached;
    if (typeof this.store.attachMedicationPhoto === "function") {
      try {
        attached = await this.store.attachMedicationPhoto({
          medicationId: medication._id,
          accountId: context.accountId,
          expectedMedicationVersion: payload.expectedVersion,
          mediaId: media._id,
          expectedMediaVersion: media.version,
          fileId: payload.fileId,
          metadata: {
            fileId: payload.fileId,
            byteSize: inspected.byteSize,
            mimeType: inspected.mimeType,
            width: inspected.width,
            height: inspected.height,
            ...(inspected.thumbnailFileId
              ? { thumbnailFileId: inspected.thumbnailFileId }
              : {}),
          },
          now,
          requestId: context.requestId,
        });
      } catch (error) {
        // A failed transaction is not proof that the object was not written.
        // Keep a ledger entry for reconciliation and let the client query the
        // photo status before deciding whether to retry or discard it.
        await this.store
          .updateOwnedVersioned(
            "media",
            media._id,
            context.accountId,
            media.version,
            {
              status: "cleanup_pending",
              fileId: payload.fileId,
              leaseUntil: new Date(
                Date.parse(now) + 30 * 60 * 1000,
              ).toISOString(),
            },
            now,
            context.requestId,
          )
          .catch(() => undefined);
        throw error;
      }
    } else {
      // Test doubles and legacy stores retain the prior conditional behavior;
      // production stores implement the transaction above.
      const validatedMedia = await this.store.updateOwnedVersioned(
        "media",
        media._id,
        context.accountId,
        media.version,
        {
          fileId: payload.fileId,
          status: "validated",
          byteSize: inspected.byteSize,
          mimeType: inspected.mimeType,
          width: inspected.width,
          height: inspected.height,
          ...(inspected.thumbnailFileId
            ? { thumbnailFileId: inspected.thumbnailFileId }
            : {}),
        },
        now,
        context.requestId,
      );
      const updated = await this.store.updateOwnedVersioned(
        "medications",
        medication._id,
        context.accountId,
        payload.expectedVersion,
        {
          photo: {
            mediaId: media._id,
            fileId: payload.fileId,
            updatedAt: now,
            width: inspected.width,
            height: inspected.height,
            ...(inspected.thumbnailFileId
              ? { thumbnailFileId: inspected.thumbnailFileId }
              : {}),
          },
        },
        now,
        context.requestId,
      );
      await this.store.updateOwnedVersioned(
        "media",
        validatedMedia._id,
        context.accountId,
        validatedMedia.version,
        { status: "attached", attachedAt: now, expiresAt: null },
        now,
        context.requestId,
      );
      attached = { medication: updated };
    }
    const updated = attached.medication;
    if (
      previousPhoto &&
      previousPhoto.mediaId !== media._id &&
      !trustedMetadata
    ) {
      await this.cleanupMediaById(previousPhoto.mediaId, context);
    }
    this.photoStage("commit_success", context);
    return this.publicMedication(updated);
  }

  async removeMedicationPhoto(payload, context) {
    const medication = await this.store.getOwned(
      "medications",
      payload.medicationId,
      context.accountId,
    );
    if (!medication.photo) return this.publicMedication(medication);
    if (medication.version !== payload.expectedVersion) {
      fail("VERSION_CONFLICT", "药盒已在其他设备更新，请刷新后重试", {
        currentVersion: medication.version,
      });
    }
    const previousPhoto = medication.photo;
    const updated = await this.store.updateOwnedVersioned(
      "medications",
      medication._id,
      context.accountId,
      medication.version,
      { photo: null },
      this.now(),
      context.requestId,
    );
    await this.cleanupMediaById(previousPhoto.mediaId, context);
    return this.publicMedication(updated);
  }

  async discardMedicationPhoto(payload, context) {
    const media = await this.store.getOwned(
      "media",
      payload.mediaId,
      context.accountId,
      { required: false },
    );
    if (!media) return { discarded: true };
    if (media.status === "attached" || media.status === "validated") {
      const medication = await this.store.getOwned(
        "medications",
        media.medicationId,
        context.accountId,
        { required: false },
      );
      if (medication?.photo?.mediaId === media._id)
        return { discarded: false, attached: true };
    }
    if (
      payload.fileId &&
      !fileIdMatchesCloudPath(payload.fileId, media.cloudPath)
    ) {
      fail("FORBIDDEN", "照片不属于当前上传任务");
    }
    let current = media;
    if (payload.fileId && media.fileId !== payload.fileId) {
      current = await this.store.updateOwnedVersioned(
        "media",
        media._id,
        context.accountId,
        media.version,
        { fileId: payload.fileId, status: "cleanup_pending" },
        this.now(),
        context.requestId,
      );
    }
    await this.cleanupMedia(current, context);
    return { discarded: true };
  }

  async getMedicationPhotoStatus(payload, context) {
    const medication = await this.store.getOwned(
      "medications",
      payload.medicationId,
      context.accountId,
    );
    const media = await this.store.getOwned(
      "media",
      payload.mediaId,
      context.accountId,
      { required: false },
    );
    if (!media || media.medicationId !== medication._id)
      fail("MEDIA_NOT_FOUND", "照片上传任务不存在或无权访问");
    const expired = Boolean(media.expiresAt && media.expiresAt < this.now());
    const attached = medication.photo?.mediaId === media._id;
    const status = attached
      ? "attached"
      : expired
        ? "expired"
        : media.status === "cleanup_pending"
          ? "cleanup_pending"
          : media.status === "uploaded" ||
              (media.status === "prepared" && media.fileId)
            ? "uploaded"
            : media.status;
    return {
      mediaId: media._id,
      medicationId: medication._id,
      status,
      allowedActions:
        status === "prepared"
          ? ["upload"]
          : status === "uploaded"
            ? ["commit", "discard"]
            : status === "attached"
              ? ["remove"]
              : status === "cleanup_pending"
                ? ["retry_cleanup", "refresh"]
                : ["refresh"],
      fileId: attached ? medication.photo.fileId : (media.fileId ?? null),
      expiresAt: media.expiresAt ?? null,
    };
  }

  async cleanupMedicationMedia(medicationId, context) {
    const media = await this.store.listAllOwned("media", context.accountId, {
      medicationId,
    });
    for (const item of media) await this.cleanupMedia(item, context);
  }

  async cleanupPendingMedia(context, medicationId = null) {
    const now = this.now();
    const media = await this.store.listAllOwned(
      "media",
      context.accountId,
      medicationId ? { medicationId } : {},
    );
    for (const item of media) {
      if (item.status === "attached") {
        const medication = await this.store.getOwned(
          "medications",
          item.medicationId,
          context.accountId,
          { required: false },
        );
        if (medication?.photo?.mediaId !== item._id) {
          await this.cleanupMedia(item, context);
        } else if (item.thumbnailStatus === "pending" && this.photoStorage) {
          const inspected = await this.photoStorage.inspectOwnedImage(
            item.fileId,
            item.cloudPath,
            { retryThumbnail: true },
          );
          if (inspected.thumbnailFileId) {
            // Derived presentation data must not invalidate an open edit form.
            // A changed photo reference still rejects this late thumbnail.
            await this.store.attachMedicationThumbnail(
              medication._id,
              context.accountId,
              item._id,
              inspected.thumbnailFileId,
            );
          }
          await this.store.updateOwnedVersioned(
            "media",
            item._id,
            context.accountId,
            item.version,
            {
              thumbnailStatus: inspected.thumbnailFileId
                ? "ready"
                : "unavailable",
            },
            now,
            context.requestId,
          );
        }
        continue;
      }
      if (item.status === "validated") {
        const medication = await this.store.getOwned(
          "medications",
          item.medicationId,
          context.accountId,
          { required: false },
        );
        if (medication?.photo?.mediaId === item._id) {
          try {
            await this.store.updateOwnedVersioned(
              "media",
              item._id,
              context.accountId,
              item.version,
              {
                status: "attached",
                attachedAt: item.updatedAt,
                expiresAt: null,
              },
              now,
              context.requestId,
            );
          } catch (_) {
            this.logger.warn("PHOTO_ATTACH_STATE_DEFERRED", {
              code: "PHOTO_ATTACH_STATE_DEFERRED",
            });
          }
        } else if (
          !item.leaseUntil ||
          Date.parse(item.leaseUntil) <= Date.parse(now) - 24 * 60 * 60 * 1000
        ) {
          await this.cleanupMedia(item, context);
        }
        continue;
      }
      if (
        (item.status === "cleanup_pending" &&
          (!item.leaseUntil || item.leaseUntil <= now)) ||
        (["prepared", "uploading", "uploaded"].includes(item.status) &&
          item.expiresAt &&
          item.expiresAt < now)
      ) {
        await this.cleanupMedia(item, context);
      }
    }
  }

  async cleanupMediaById(mediaId, context) {
    const media = await this.store.getOwned(
      "media",
      mediaId,
      context.accountId,
      { required: false },
    );
    if (media) await this.cleanupMedia(media, context);
  }

  async cleanupMedia(media, context) {
    const referenced = await this.store.getOwned(
      "medications",
      media.medicationId,
      context.accountId,
      { required: false },
    );
    if (referenced?.photo?.mediaId === media._id) {
      this.logger.warn("PHOTO_CLEANUP_SKIPPED_ATTACHED", {
        code: "PHOTO_CLEANUP_SKIPPED_ATTACHED",
      });
      return;
    }
    let current = media;
    if (media.status !== "cleanup_pending") {
      try {
        current = await this.store.updateOwnedVersioned(
          "media",
          media._id,
          context.accountId,
          media.version,
          { status: "cleanup_pending" },
          this.now(),
          context.requestId,
        );
      } catch (_) {
        // Losing the compare-and-set means this invocation does not own the
        // cleanup lease. A re-read may legitimately show another worker's
        // cleanup_pending state; it is not permission to delete that worker's
        // object.
        this.logger.warn("PHOTO_CLEANUP_CLAIM_LOST", {
          code: "PHOTO_CLEANUP_CLAIM_LOST",
        });
        return;
      }
    }
    // If the compare-and-set did not win, the cleanup caller must stop. The
    // stale input must never be used to delete a file owned by another flow.
    if (current.status !== "cleanup_pending") return;
    const latestReference = await this.store.getOwned(
      "medications",
      current.medicationId,
      context.accountId,
      { required: false },
    );
    if (latestReference?.photo?.mediaId === current._id) return;
    try {
      if (current.fileId && this.photoStorage)
        await this.photoStorage.deleteFile(current.fileId);
      await this.store.removeOwnedVersioned(
        "media",
        current._id,
        context.accountId,
        current.version,
        context.requestId,
      );
    } catch (_) {
      this.logger.warn("PHOTO_CLEANUP_DEFERRED", {
        code: "PHOTO_CLEANUP_DEFERRED",
      });
    }
  }

  async listPlans(payload, context) {
    const where = payload.medicationId
      ? { medicationId: payload.medicationId }
      : {};
    if (payload.medicationId)
      await this.store.getOwned(
        "medications",
        payload.medicationId,
        context.accountId,
      );
    const page = await this.store.listOwned("plans", context.accountId, {
      where,
      cursor: payload.cursor,
      limit: payload.limit,
    });
    return {
      items: page.items.map(publicDocument),
      nextCursor: page.nextCursor,
    };
  }

  async savePlan(payload, context) {
    const medication = await this.store.getOwned(
      "medications",
      payload.medicationId,
      context.accountId,
    );
    if (medication.status !== "active")
      fail("MEDICATION_ARCHIVED", "已移除药盒不能创建服药计划");
    if (medication.unit && medication.unit !== payload.unit)
      fail("UNIT_MISMATCH", "计划单位必须与药品库存单位一致");
    if (medication.version !== payload.expectedMedicationVersion) {
      fail("VERSION_CONFLICT", "药品已在其他设备上更新，请刷新后重试", {
        currentVersion: medication.version,
      });
    }
    const managementDate = effectiveExpiry(medication);
    if (managementDate && payload.startDate > managementDate)
      fail("INVALID_ARGUMENT", "计划开始日期不能晚于管理期限");
    if (managementDate && payload.endDate && payload.endDate > managementDate)
      fail("INVALID_ARGUMENT", "计划结束日期不能晚于管理期限");
    const previous = medication.activePlanId
      ? await this.store.getOwned(
          "plans",
          medication.activePlanId,
          context.accountId,
          { required: false },
        )
      : null;
    const now = this.now();
    const plan = await this.store.createOwned("plans", {
      _id: deterministicId("plan", context.accountId, context.requestId),
      accountId: context.accountId,
      medicationId: payload.medicationId,
      kind: payload.kind,
      dose: payload.dose,
      unit: payload.unit,
      times: payload.times,
      weekdays: payload.weekdays,
      startDate: payload.startDate,
      endDate: payload.endDate,
      notes: payload.notes,
      revision: (previous?.revision ?? 0) + 1,
      effectiveFrom: now,
      supersededAt: null,
      version: 1,
      lastRequestId: context.requestId,
      createdAt: now,
      updatedAt: now,
    });
    try {
      await this.store.updateOwnedVersioned(
        "medications",
        medication._id,
        context.accountId,
        payload.expectedMedicationVersion,
        {
          activePlanId: plan._id,
          unit: medication.unit ?? payload.unit,
        },
        now,
        context.requestId,
      );
    } catch (error) {
      if (isAppError(error)) {
        try {
          await this.store.removeOwnedVersioned(
            "plans",
            plan._id,
            context.accountId,
            plan.version,
            context.requestId,
          );
        } catch (_) {}
      }
      throw error;
    }
    if (previous && !previous.supersededAt) {
      try {
        await this.store.updateOwnedVersioned(
          "plans",
          previous._id,
          context.accountId,
          previous.version,
          { supersededAt: now },
          now,
          context.requestId,
        );
      } catch (_) {
        this.logger.warn("PLAN_HISTORY_MARK_FAILED", {
          code: "PLAN_HISTORY_MARK_FAILED",
        });
      }
    }
    await this.store.markCalendarExportsStale(
      context.accountId,
      medication._id,
      now,
    );
    await this.safeRefreshReminders(medication._id, context);
    const latestMedication = await this.store.getOwned(
      "medications",
      medication._id,
      context.accountId,
    );
    return {
      plan: publicDocument(plan),
      medication: await this.publicMedication(latestMedication),
    };
  }

  async stopPlan(payload, context) {
    const medication = await this.store.getOwned(
      "medications",
      payload.medicationId,
      context.accountId,
    );
    if (medication.version !== payload.expectedMedicationVersion) {
      fail("VERSION_CONFLICT", "药品已在其他设备上更新，请刷新后重试", {
        currentVersion: medication.version,
      });
    }
    const now = this.now();
    const updatedMedication = await this.store.updateOwnedVersioned(
      "medications",
      medication._id,
      context.accountId,
      medication.version,
      { activePlanId: null },
      now,
      context.requestId,
    );
    let plan = null;
    if (medication.activePlanId) {
      plan = await this.store.getOwned(
        "plans",
        medication.activePlanId,
        context.accountId,
        { required: false },
      );
      if (plan && !plan.supersededAt) {
        try {
          plan = await this.store.updateOwnedVersioned(
            "plans",
            plan._id,
            context.accountId,
            plan.version,
            { supersededAt: now },
            now,
            context.requestId,
          );
        } catch (_) {}
      }
    }
    await this.store.markCalendarExportsStale(
      context.accountId,
      medication._id,
      now,
    );
    await this.safeRefreshReminders(medication._id, context);
    return {
      stopped: true,
      plan: publicDocumentOrNull(plan),
      medication: await this.publicMedication(updatedMedication),
    };
  }

  async listSnapshots(payload, context) {
    if (payload.medicationId)
      await this.store.getOwned(
        "medications",
        payload.medicationId,
        context.accountId,
      );
    const where = payload.medicationId
      ? { medicationId: payload.medicationId }
      : {};
    const page = await this.store.listOwned("snapshots", context.accountId, {
      where,
      cursor: payload.cursor,
      limit: payload.limit,
    });
    return {
      items: page.items.map(publicDocument),
      nextCursor: page.nextCursor,
    };
  }

  async createSnapshot(payload, context) {
    const medication = await this.store.getOwned(
      "medications",
      payload.medicationId,
      context.accountId,
    );
    if (medication.unit && medication.unit !== payload.unit)
      fail("UNIT_MISMATCH", "盘点单位必须与药品单位一致");
    const now = this.now();
    const capturedAt = payload.capturedAt ?? now;
    if (Date.parse(capturedAt) > Date.parse(now) + 5 * 60000)
      fail("INVALID_ARGUMENT", "盘点时间不能晚于当前时间");
    const snapshot = await this.store.createOwned("snapshots", {
      _id: deterministicId("snapshot", context.accountId, context.requestId),
      accountId: context.accountId,
      medicationId: payload.medicationId,
      quantity: payload.quantity,
      unit: payload.unit,
      capturedAt,
      source: "manual",
      note: payload.note ?? "手动盘点",
      version: 1,
      lastRequestId: context.requestId,
      createdAt: now,
      updatedAt: now,
    });
    await this.safeRefreshReminders(medication._id, context);
    return publicDocument(snapshot);
  }

  async listIntake(payload, context) {
    if (payload.medicationId)
      await this.store.getOwned(
        "medications",
        payload.medicationId,
        context.accountId,
      );
    const all = await this.store.listAllOwned(
      "intakeLogs",
      context.accountId,
      payload.medicationId ? { medicationId: payload.medicationId } : {},
    );
    const filtered = all
      .filter((item) => !payload.from || item.occurredAt >= payload.from)
      .filter((item) => !payload.to || item.occurredAt <= payload.to)
      .filter((item) => !payload.cursor || item._id > payload.cursor)
      .sort((a, b) => a._id.localeCompare(b._id));
    const items = filtered.slice(0, payload.limit);
    return {
      items: items.map(publicDocument),
      nextCursor:
        filtered.length > payload.limit ? items[items.length - 1]._id : null,
    };
  }

  async recordIntake(payload, context, createOnly = false) {
    const medication = await this.store.getOwned(
      "medications",
      payload.medicationId,
      context.accountId,
    );
    if (medication.status === "deleting")
      fail("MEDICATION_DELETING", "药品正在删除，请稍后刷新");
    if (createOnly && medication.status !== "active")
      fail(
        "MEDICATION_ARCHIVED",
        "药品状态已变化，请核对历史记录后处理待同步记录",
      );
    const now = this.now();
    let quantity = payload.quantity;
    let unit = payload.unit;
    let plan = null;
    if (payload.status !== "extra") {
      plan = await this.store.getOwned(
        "plans",
        payload.planId,
        context.accountId,
      );
      if (plan.medicationId !== medication._id)
        fail("INVALID_ARGUMENT", "计划不属于该药品");
      const expected = occurrencesForDate(
        plan,
        chinaDate(payload.scheduledAt),
      ).find((item) => item.scheduledAt === payload.scheduledAt);
      if (!expected) fail("INVALID_SCHEDULE", "scheduledAt 不属于该计划");
      if (Date.parse(payload.scheduledAt) > Date.parse(now) + 10 * 60000)
        fail("INVALID_ARGUMENT", "不能提前记录尚未到达的服药任务");
      quantity = plan.dose;
      unit = plan.unit;
    } else if (medication.unit && medication.unit !== unit) {
      fail("UNIT_MISMATCH", "记录单位必须与药品单位一致");
    }
    const id =
      payload.status === "extra"
        ? deterministicId("intake", context.accountId, context.requestId)
        : deterministicId(
            "intake",
            context.accountId,
            payload.planId,
            payload.scheduledAt,
          );
    const existing = await this.store.getOwned(
      "intakeLogs",
      id,
      context.accountId,
      { required: false },
    );
    if (existing) {
      if (
        createOnly &&
        existing.requestId !== context.requestId &&
        (existing.undoneAt || existing.status !== payload.status)
      )
        fail("CONFLICT", "这次服药已在其他设备更新，请核对历史记录");
      if (!existing.undoneAt && existing.status === payload.status)
        return publicDocument(existing);
      const updated = await this.store.updateOwnedVersioned(
        "intakeLogs",
        id,
        context.accountId,
        existing.version,
        {
          status: payload.status,
          quantity,
          unit,
          occurredAt: payload.occurredAt ?? now,
          occurrenceKey:
            payload.occurrenceKey ?? existing.occurrenceKey ?? null,
          requestId: context.requestId,
          undoneAt: null,
        },
        now,
        context.requestId,
      );
      await this.safeRefreshReminders(medication._id, context);
      return publicDocument(updated);
    }
    const occurredAt = payload.occurredAt ?? now;
    if (Date.parse(occurredAt) > Date.parse(now) + 5 * 60000)
      fail("INVALID_ARGUMENT", "记录时间不能晚于当前时间");
    const log = await this.store.createOwned("intakeLogs", {
      _id: id,
      accountId: context.accountId,
      medicationId: medication._id,
      planId: payload.planId,
      status: payload.status,
      scheduledAt: payload.scheduledAt,
      occurrenceKey: payload.occurrenceKey ?? null,
      occurredAt,
      quantity,
      unit,
      undoneAt: null,
      requestId: context.requestId,
      version: 1,
      lastRequestId: context.requestId,
      createdAt: now,
      updatedAt: now,
    });
    await this.safeRefreshReminders(medication._id, context);
    return publicDocument(log);
  }

  async undoIntake(payload, context) {
    const current = await this.store.getOwned(
      "intakeLogs",
      payload.id,
      context.accountId,
    );
    if (current.undoneAt) return publicDocument(current);
    const updated = await this.store.updateOwnedVersioned(
      "intakeLogs",
      payload.id,
      context.accountId,
      payload.expectedVersion,
      { undoneAt: this.now() },
      this.now(),
      context.requestId,
    );
    await this.safeRefreshReminders(updated.medicationId, context);
    return publicDocument(updated);
  }

  async getSettings(context) {
    return publicDocument(
      await this.store.ensureSettings(context.accountId, this.now()),
    );
  }

  async updateSettings(payload, context) {
    const current = await this.store.ensureSettings(
      context.accountId,
      this.now(),
    );
    const updated = await this.store.updateOwnedVersioned(
      "settings",
      current._id,
      context.accountId,
      payload.expectedVersion,
      payload.patch,
      this.now(),
      context.requestId,
    );
    const meds = await this.store.listOwned("medications", context.accountId, {
      where: { status: "active" },
      limit: 100,
    });
    await Promise.all(
      meds.items.map((medication) =>
        this.safeRefreshReminders(medication._id, context),
      ),
    );
    return publicDocument(updated);
  }

  async getToday(context) {
    const now = this.clock();
    const date = chinaDate(now);
    const start = chinaStartOfDay(now).toISOString();
    const end = addDays(chinaStartOfDay(now), 1).toISOString();
    const [profiles, medications, plans, snapshots, logs, settings] =
      await Promise.all([
        this.store.listAllOwned("profiles", context.accountId),
        this.store.listAllOwned("medications", context.accountId, {
          status: "active",
        }),
        this.store.listAllOwned("plans", context.accountId),
        this.store.listAllOwned("snapshots", context.accountId),
        this.store.listAllOwned("intakeLogs", context.accountId),
        this.store.ensureSettings(context.accountId, this.now()),
      ]);
    const medicationMap = new Map(medications.map((item) => [item._id, item]));
    const logMap = new Map(
      logs
        .filter(
          (log) =>
            !log.undoneAt &&
            log.scheduledAt &&
            log.scheduledAt >= start &&
            log.scheduledAt < end,
        )
        .map((log) => [`${log.planId}|${log.scheduledAt}`, log]),
    );
    const tasks = [];
    for (const medication of medications) {
      // A plan may remain in storage for historical reasons, but an expired
      // medication must not create a new normal task. The expiry day itself
      // is still usable; the following local day is the first day excluded.
      const medicationExpiry = effectiveExpiry(medication);
      if (medicationExpiry && date > medicationExpiry) continue;
      if (!medication.activePlanId) continue;
      const plan = plans.find((item) => item._id === medication.activePlanId);
      if (!plan) continue;
      for (const occurrence of occurrencesForDate(plan, date)) {
        const log = logMap.get(`${plan._id}|${occurrence.scheduledAt}`);
        tasks.push({
          ...occurrence,
          medicationName: medication.name,
          profileId: medication.profileId,
          status: log?.status ?? "pending",
          intakeLogId: log?._id ?? null,
          intakeVersion: log?.version ?? null,
        });
      }
    }
    tasks.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
    const risks = [];
    for (const medication of medications) {
      const expiry = expiryState(medication, now, settings.expiryLeadDays);
      if (expiry.state !== "ok" && expiry.state !== "unknown") {
        risks.push({ kind: "expiry", medicationId: medication._id, ...expiry });
      }
      const medicationPlans = plans.filter(
        (plan) => plan.medicationId === medication._id,
      );
      const activePlan =
        medicationPlans.find((plan) => plan._id === medication.activePlanId) ??
        null;
      const snapshot =
        snapshots
          .filter((item) => item.medicationId === medication._id)
          .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))[0] ?? null;
      const inventory = estimateInventory({
        snapshot,
        plans: medicationPlans,
        logs: logs.filter((log) => log.medicationId === medication._id),
        now,
      });
      const runOutAt =
        inventory.quantity === null
          ? null
          : projectedRunOut({
              quantity: inventory.quantity,
              unit: inventory.unit,
              activePlan,
              now,
            });
      if (
        runOutAt &&
        Date.parse(runOutAt) <=
          addDays(now, settings.shortageLeadDays).getTime()
      ) {
        risks.push({
          kind: "shortage",
          medicationId: medication._id,
          projectedRunOutAt: runOutAt,
        });
      }
    }
    return {
      date,
      generatedAt: this.now(),
      profiles: profiles.map(publicDocument),
      medications: await Promise.all(
        [...medicationMap.values()].map((item) => this.publicMedication(item)),
      ),
      tasks,
      risks,
    };
  }

  async getCabinet(context) {
    const now = this.clock();
    const [profiles, medications, plans, snapshots, logs, settings] =
      await Promise.all([
        this.store.listAllOwned("profiles", context.accountId),
        this.store.listAllOwned("medications", context.accountId),
        this.store.listAllOwned("plans", context.accountId),
        this.store.listAllOwned("snapshots", context.accountId),
        this.store.listAllOwned("intakeLogs", context.accountId),
        this.store.ensureSettings(context.accountId, this.now()),
      ]);
    const items = await Promise.all(
      medications.map(async (medication) => {
        const medicationPlans = plans.filter(
          (plan) => plan.medicationId === medication._id,
        );
        const activePlan =
          medicationPlans.find(
            (plan) => plan._id === medication.activePlanId,
          ) ?? null;
        const latestSnapshot =
          snapshots
            .filter((snapshot) => snapshot.medicationId === medication._id)
            .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))[0] ??
          null;
        const inventory = estimateInventory({
          snapshot: latestSnapshot,
          plans: medicationPlans,
          logs: logs.filter((log) => log.medicationId === medication._id),
          now,
        });
        const runOutAt =
          inventory.quantity === null
            ? null
            : projectedRunOut({
                quantity: inventory.quantity,
                unit: inventory.unit,
                activePlan,
                now,
              });
        return {
          medication: await this.publicMedication(medication),
          activePlan: publicDocumentOrNull(activePlan),
          latestSnapshot: publicDocumentOrNull(latestSnapshot),
          inventory,
          projectedRunOutAt: runOutAt,
          expiry: expiryState(medication, now, settings.expiryLeadDays),
        };
      }),
    );
    return {
      generatedAt: this.now(),
      profiles: profiles.map(publicDocument),
      items,
    };
  }

  async safeRefreshReminders(medicationId, context) {
    try {
      await this.refreshReminders(medicationId, context);
    } catch (_) {
      this.logger.warn("REMINDER_REFRESH_FAILED", {
        code: "REMINDER_REFRESH_FAILED",
      });
    }
  }

  async refreshReminders(medicationId, context) {
    const now = this.clock();
    const medication = await this.store.getOwned(
      "medications",
      medicationId,
      context.accountId,
      { required: false },
    );
    if (!medication || medication.status !== "active") {
      await this.store.cancelReminderTasks(
        context.accountId,
        medicationId,
        this.now(),
      );
      return;
    }
    const [settings, plans, snapshots, logs] = await Promise.all([
      this.store.ensureSettings(context.accountId, this.now()),
      this.store.listAllOwned("plans", context.accountId, { medicationId }),
      this.store.listAllOwned("snapshots", context.accountId, { medicationId }),
      this.store.listAllOwned("intakeLogs", context.accountId, {
        medicationId,
      }),
    ]);
    const tasks = [];
    const expiry = effectiveExpiry(medication);
    const today = chinaDate(now);
    const reminderPreferences = settings.reminderPreferences ?? {
      dose: false,
      expiry: Boolean(settings.subscriptions?.expiry),
      shortage: Boolean(settings.subscriptions?.shortage),
    };
    if (reminderPreferences.expiry && expiry) {
      const nominal = chinaDateTime(
        addCalendarDays(expiry, -settings.expiryLeadDays),
        "09:00",
      );
      const dueAt = nominal < now ? now.toISOString() : nominal.toISOString();
      tasks.push(
        makeReminderTask({
          accountId: context.accountId,
          medication,
          kind: "expiry",
          dueAt,
          source: `${expiry}|${settings.expiryLeadDays}`,
          payload: {
            medicineName: medication.name,
            date: expiry,
            message:
              expiry < today
                ? `药品已于 ${expiry} 到期，请核对或移除`
                : `药品将在 ${expiry} 到期`,
          },
          now: this.now(),
        }),
      );
    }
    const activePlan =
      plans.find((plan) => plan._id === medication.activePlanId) ?? null;
    const snapshot =
      snapshots.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))[0] ??
      null;
    const inventory = estimateInventory({ snapshot, plans, logs, now });
    const runOutAt =
      inventory.quantity === null
        ? null
        : projectedRunOut({
            quantity: inventory.quantity,
            unit: inventory.unit,
            activePlan,
            now,
          });
    if (
      reminderPreferences.shortage &&
      runOutAt &&
      (!expiry || (expiry >= today && chinaDate(runOutAt) <= expiry))
    ) {
      const runOutDate = chinaDate(runOutAt);
      const nominal = chinaDateTime(
        addCalendarDays(runOutDate, -settings.shortageLeadDays),
        "09:00",
      );
      const dueAt = nominal < now ? now.toISOString() : nominal.toISOString();
      tasks.push(
        makeReminderTask({
          accountId: context.accountId,
          medication,
          kind: "shortage",
          dueAt,
          source: `${runOutDate}|${settings.shortageLeadDays}|${snapshot?._id ?? "none"}`,
          payload: {
            medicineName: medication.name,
            date: runOutDate,
            message: `按当前记录预计在 ${runOutDate} 前后用完`,
          },
          now: this.now(),
        }),
      );
    }
    if (reminderPreferences.dose && activePlan && activePlan.kind !== "prn") {
      const firstDate = chinaDate(now);
      const lastDate = addCalendarDays(firstDate, 6);
      for (
        let cursor = chinaStartOfDay(now);
        chinaDate(cursor) <= lastDate;
        cursor = addDays(cursor, 1)
      ) {
        const date = chinaDate(cursor);
        for (const occurrence of occurrencesForDate(activePlan, date)) {
          const age = now.getTime() - Date.parse(occurrence.scheduledAt);
          if (age > 10 * 60 * 1000) continue;
          if (expiry && date > expiry) continue;
          tasks.push(
            makeReminderTask({
              accountId: context.accountId,
              medication,
              kind: "dose",
              dueAt: occurrence.scheduledAt,
              source: occurrence.scheduledAt,
              payload: {
                medicineName: medication.name,
                productName: "药小伴",
                dose: `${activePlan.dose}${activePlan.unit}`,
                doseTime: occurrence.time,
                expiryDate: expiry,
                planId: activePlan._id,
                scheduledAt: occurrence.scheduledAt,
                occurrenceKey: occurrence.key,
              },
              now: this.now(),
            }),
          );
        }
      }
    }
    const keep = new Set(tasks.map((task) => task._id));
    await this.store.cancelReminderTasks(
      context.accountId,
      medicationId,
      this.now(),
      [...keep],
    );
    for (const task of tasks) await this.store.putReminderTask(task);
  }
}

function assertMedicationDates(medication, now) {
  const hasOpenedDate = Boolean(medication.openedOn);
  const hasAfterOpenDays = Number.isInteger(medication.afterOpenDays);
  if (hasOpenedDate !== hasAfterOpenDays) {
    fail("INVALID_ARGUMENT", "开封日期与开封后可用天数需要同时填写");
  }
  const resolution = calculateEffectiveExpiry(medication);
  if (hasOpenedDate && medication.openedOn > chinaDate(now))
    fail("INVALID_ARGUMENT", "开启日期不能晚于今天");
  if (
    hasOpenedDate &&
    resolution.packageDate &&
    medication.openedOn > resolution.packageDate
  ) {
    fail("INVALID_ARGUMENT", "开启日期不能晚于包装有效期");
  }
}

function makeReminderTask({
  accountId,
  medication,
  kind,
  dueAt,
  source,
  payload,
  now,
}) {
  return {
    _id: deterministicId(
      "reminder",
      accountId,
      medication._id,
      kind,
      payload.planId ?? "",
      payload.scheduledAt ?? source,
    ),
    accountId,
    medicationId: medication._id,
    kind,
    dueAt,
    nextAttemptAt: dueAt,
    planId: payload.planId ?? null,
    scheduledAt: payload.scheduledAt ?? null,
    occurrenceKey: payload.occurrenceKey ?? null,
    payload,
    sourceVersion: source,
    status: "pending",
    attempts: 0,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function publicDocumentOrNull(value) {
  return value ? publicDocument(value) : null;
}

module.exports = { MedicineService, makeReminderTask };
