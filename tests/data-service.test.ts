import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  localDateTimeToIso,
  localDateTimeToMs,
} from "../miniprogram/core/dates";
import {
  createDataService,
  ServiceError,
} from "../miniprogram/services/data-service";
import { stageMedicationPhoto } from "../miniprogram/services/medication-photo";

const storage = new Map<string, unknown>();
const removedSavedFiles: string[] = [];

beforeEach(() => {
  storage.clear();
  removedSavedFiles.length = 0;
  (globalThis as unknown as { wx: Partial<WechatMiniprogram.Wx> }).wx = {
    getStorageSync: <T>(key: string): T => storage.get(key) as T,
    setStorageSync: (key: string, value: unknown): void => {
      storage.set(key, value);
    },
    removeStorageSync: (key: string): void => {
      storage.delete(key);
    },
    getFileSystemManager: () =>
      ({
        getFileInfo: (options: WechatMiniprogram.GetFileInfoOption): void => {
          options.success?.({
            size: 128,
          } as WechatMiniprogram.GetFileInfoSuccessCallbackResult);
        },
        readFile: (options: WechatMiniprogram.ReadFileOption): void => {
          options.success?.({ data: "aW1hZ2U=", errMsg: "readFile:ok" });
        },
        removeSavedFile: (
          options: WechatMiniprogram.RemoveSavedFileOption,
        ): void => {
          removedSavedFiles.push(options.filePath);
          options.success?.({ errMsg: "removeSavedFile:ok", errCode: 0 });
        },
      }) as unknown as WechatMiniprogram.FileSystemManager,
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("cloud photo deployment compatibility", () => {
  const photoInput = {
    medicationId: "med-1",
    expectedVersion: 1,
    mediaId: "media-1",
    fileId: "cloud://env/medication-photos/media-1.jpg",
  };

  function mockCloudCall(callFunction: ReturnType<typeof vi.fn>) {
    (wx as unknown as { cloud: unknown }).cloud = {
      callFunction,
      uploadFile: (options: ICloud.UploadFileParam) => {
        options.fail?.({ errMsg: "network" });
        return { abort() {} };
      },
    };
  }

  function requestIds(callFunction: ReturnType<typeof vi.fn>): string[] {
    return callFunction.mock.calls.map(
      ([input]) => (input as { data: { requestId: string } }).data.requestId,
    );
  }

  it("组合验证普通 SDK 断连保留 unknown，照片流程不 discard 票据", async () => {
    vi.useFakeTimers();
    const callFunction = vi
      .fn()
      .mockResolvedValueOnce({
        result: {
          ok: true,
          data: {
            mediaId: "media-composed-1",
            cloudPath: "medication-photos/owner/media-composed-1.jpg",
            expiresAt: "2099-01-01T00:00:00Z",
            maxBytes: 2097152,
            transport: "cloud",
          },
        },
      })
      .mockRejectedValueOnce({
        errMsg: "cloud.callFunction:fail request:fail network",
      });
    mockCloudCall(callFunction);
    const service = createDataService("cloud");
    const result = expect(
      stageMedicationPhoto({
        service,
        medicationId: "med-composed-1",
        expectedVersion: 1,
        tempFilePath: "/test/photo.jpg",
        attemptId: "PHT-COMPOSED-UNKNOWN",
      }),
    ).rejects.toMatchObject({ code: "NETWORK", outcome: "unknown" });
    await vi.runAllTimersAsync();
    await result;
    expect(callFunction).toHaveBeenCalledTimes(2);
    expect(
      callFunction.mock.calls.map(
        ([input]) => (input as { data: { action: string } }).data.action,
      ),
    ).toEqual(["prepareMedicationPhoto", "putMedicationPhotoChunk"]);
  });

  it("服务端仍在处理上传时保留同一请求编号及票据，不触发清理", async () => {
    vi.useFakeTimers();
    const ticket = {
      mediaId: "media-progress-1",
      cloudPath: "medication-photos/owner/media-progress-1.jpg",
      expiresAt: "2099-01-01T00:00:00Z",
      maxBytes: 2097152,
      transport: "cloud" as const,
    };
    const callFunction = vi
      .fn()
      .mockResolvedValueOnce({
        result: {
          ok: false,
          error: {
            code: "OPERATION_IN_PROGRESS",
            message: "相同请求正在处理，请稍后重试",
          },
        },
      })
      .mockResolvedValueOnce({ result: { ok: true, data: { accepted: true } } })
      .mockResolvedValueOnce({
        result: { ok: true, data: { fileId: "cloud://env/photo" } },
      });
    mockCloudCall(callFunction);
    const service = createDataService("cloud");
    const args = {
      service,
      medicationId: "med-progress-1",
      expectedVersion: 1,
      tempFilePath: "/test/photo.jpg",
      ticket,
    };
    const result = expect(stageMedicationPhoto(args)).rejects.toMatchObject({
      code: "OPERATION_IN_PROGRESS",
      retryable: true,
      outcome: "unknown",
      pending: { ticket },
    });
    await vi.runAllTimersAsync();
    await result;
    await expect(stageMedicationPhoto(args)).resolves.toMatchObject({
      fileId: "cloud://env/photo",
    });
    expect(callFunction).toHaveBeenCalledTimes(3);
    expect(requestIds(callFunction)[0]).toBe(requestIds(callFunction)[1]);
    expect(
      callFunction.mock.calls.map(
        ([input]) => (input as { data: { action: string } }).data.action,
      ),
    ).toEqual([
      "putMedicationPhotoChunk",
      "putMedicationPhotoChunk",
      "finishMedicationPhotoUpload",
    ]);
  });

  it("explains an old photo action response without offering a futile retry", async () => {
    const callFunction = vi.fn().mockResolvedValue({
      result: {
        ok: false,
        error: { code: "INVALID_ARGUMENT", message: "action 不受支持" },
      },
    });
    (wx as unknown as { cloud: { callFunction: typeof callFunction } }).cloud =
      { callFunction };
    const service = createDataService("cloud");

    await expect(
      service.prepareMedicationPhoto("med-1", 1),
    ).rejects.toMatchObject({
      code: "MEDIA_UNAVAILABLE",
      message: "照片服务尚未更新，暂时无法保存照片，请稍后再试",
      retryable: false,
    });
    expect(callFunction).toHaveBeenCalledOnce();
  });

  it("does not relabel unrelated backend action errors as photo failures", async () => {
    const callFunction = vi.fn().mockResolvedValue({
      result: {
        ok: false,
        error: { code: "INVALID_ARGUMENT", message: "action 不受支持" },
      },
    });
    (wx as unknown as { cloud: { callFunction: typeof callFunction } }).cloud =
      { callFunction };

    await expect(createDataService("cloud").bootstrap()).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: "action 不受支持",
    });
  });

  it.each(["MEDIA_UNAVAILABLE", "INTERNAL", "UNKNOWN"])(
    "allows retrying a confirmed photo service failure (%s) with a fresh request ID",
    async (code) => {
      const callFunction = vi.fn().mockResolvedValue({
        result: {
          ok: false,
          error: { code, message: "服务暂时不可用，请稍后重试" },
        },
      });
      mockCloudCall(callFunction);
      const service = createDataService("cloud");

      await expect(
        service.commitMedicationPhoto(photoInput),
      ).rejects.toMatchObject({
        code: "MEDIA_UNAVAILABLE",
        retryable: true,
      });
      await expect(
        service.commitMedicationPhoto(photoInput),
      ).rejects.toMatchObject({
        code: "MEDIA_UNAVAILABLE",
      });
      expect(requestIds(callFunction)[1]).not.toBe(requestIds(callFunction)[0]);
    },
  );

  it.each(["INVALID_MEDIA", "PAYLOAD_TOO_LARGE", "FORBIDDEN"])(
    "keeps invalid photo errors nonretryable (%s)",
    async (code) => {
      mockCloudCall(
        vi.fn().mockResolvedValue({
          result: { ok: false, error: { code, message: "请重新选择照片" } },
        }),
      );
      await expect(
        createDataService("cloud").commitMedicationPhoto(photoInput),
      ).rejects.toMatchObject({ code, retryable: false });
    },
  );

  it.each([
    { errMsg: "cloud.callFunction:fail request:fail timeout" },
    {
      errMsg:
        "cloud.callFunction:fail -504003 FUNCTIONS_TIME_LIMIT_EXCEEDED timeout",
    },
    { errMsg: "cloud.callFunction:fail -501005 FUNCTIONS_EXECUTE_FAIL" },
  ])(
    "explains cloud failures without calling them a lost connection (%j)",
    async (error) => {
      const callFunction = vi.fn().mockRejectedValue(error);
      mockCloudCall(callFunction);
      const service = createDataService("cloud");

      await expect(
        service.commitMedicationPhoto(photoInput),
      ).rejects.toMatchObject({
        code: "MEDIA_UNAVAILABLE",
        retryable: true,
      });
      await expect(
        service.commitMedicationPhoto(photoInput),
      ).rejects.toMatchObject({
        code: "MEDIA_UNAVAILABLE",
      });
      // The function may have committed before the transport failed.
      expect(requestIds(callFunction)[1]).toBe(requestIds(callFunction)[0]);
    },
  );

  it("releases a stalled photo call and can replay its late success", async () => {
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    const callFunction = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({ result: { ok: true, data: { medications: [] } } });
    mockCloudCall(callFunction);
    const service = createDataService("cloud");
    const pending = expect(
      service.commitMedicationPhoto(photoInput),
    ).rejects.toMatchObject({
      code: "MEDIA_UNAVAILABLE",
      message: "照片服务响应超时，请稍后重试",
      retryable: true,
    });

    await vi.advanceTimersByTimeAsync(35_000);
    await pending;
    finish({ result: { ok: true, data: { medications: [] } } });
    await service.commitMedicationPhoto(photoInput);
    expect(requestIds(callFunction)[1]).toBe(requestIds(callFunction)[0]);
    expect(vi.getTimerCount()).toBe(0);
    expect(callFunction.mock.calls[0]![0]).not.toHaveProperty("config.timeout");
  });

  it("clears its timeout after photo success", async () => {
    vi.useFakeTimers();
    mockCloudCall(
      vi.fn().mockResolvedValue({ result: { ok: true, data: {} } }),
    );
    await createDataService("cloud").commitMedicationPhoto(photoInput);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps non-photo transport and backend failure behavior unchanged", async () => {
    const callFunction = vi
      .fn()
      .mockRejectedValueOnce({ errMsg: "cloud.callFunction:fail timeout" })
      .mockResolvedValueOnce({
        result: {
          ok: false,
          error: { code: "UNKNOWN", message: "服务暂时不可用" },
        },
      });
    mockCloudCall(callFunction);
    const service = createDataService("cloud");
    await expect(service.bootstrap()).rejects.toMatchObject({
      code: "NETWORK",
    });
    await expect(service.bootstrap()).rejects.toMatchObject({
      code: "UNKNOWN",
      retryable: false,
    });
  });

  it("保留 SDK 原始错误码、阶段和云 traceId，不把未知结果伪装成普通断网", async () => {
    const callFunction = vi.fn().mockResolvedValue({
      result: {
        ok: false,
        error: {
          code: "MEDIA_UNAVAILABLE",
          message: "照片服务暂时不可用，请稍后重试",
          traceId: "trace-photo-0001",
        },
      },
    });
    mockCloudCall(callFunction);
    const service = createDataService("cloud");

    await expect(
      service.commitMedicationPhoto(photoInput, {
        attemptId: "PHT-DIAG-0001",
        stage: "commit",
        transport: "relay",
      }),
    ).rejects.toMatchObject({ code: "MEDIA_UNAVAILABLE" });

    const attempts = storage.get("yaoxiaoban:photo-attempts-v1") as Array<{
      events: Array<Record<string, unknown>>;
    }>;
    const lastAttempt = attempts[attempts.length - 1];
    const failure = lastAttempt?.events[lastAttempt.events.length - 1];
    expect(failure).toMatchObject({
      stage: "commit",
      outcome: "failure",
      cloudTraceId: "trace-photo-0001",
      sanitizedErrMsg: "照片服务暂时不可用，请稍后重试",
    });
  });
});

describe("local data service integration", () => {
  it("requires consent before creating the default profile", async () => {
    const service = createDataService("local");
    expect((await service.bootstrap()).profiles).toHaveLength(0);
    const accepted = await service.acceptPrivacy("test-v1");
    expect(accepted.settings.privacyAcceptedVersion).toBe("test-v1");
    expect(accepted.profiles[0]?.name).toBe("我");
  });

  it("creates a minimal expiry-only medication", async () => {
    const service = createDataService("local");
    const state = await service.acceptPrivacy("test-v1");
    const result = await service.saveMedication({
      profileId: state.profiles[0]!.id,
      name: "  家庭常备药  ",
      specification: "",
      unit: "",
      mode: "expiry_only",
      expiryPrecision: "month",
      expiryValue: "2027-03",
      openedDate: null,
      afterOpenDays: null,
      note: "",
      schedule: null,
      initialQuantityMilli: null,
    });
    expect(result.state.medications[0]?.name).toBe("家庭常备药");
    expect(result.planId).toBeNull();
    expect(result.state.snapshots).toHaveLength(0);
  });

  it("rejects mismatched photo tickets without deleting caller-provided files", async () => {
    const service = createDataService("local");
    const state = await service.acceptPrivacy("test-v1");
    const created = await service.saveMedication({
      profileId: state.profiles[0]!.id,
      name: "照片安全测试药",
      specification: "",
      unit: "",
      mode: "expiry_only",
      expiryPrecision: "month",
      expiryValue: "2027-03",
      openedDate: null,
      afterOpenDays: null,
      note: "",
      schedule: null,
      initialQuantityMilli: null,
    });
    const ticket = await service.prepareMedicationPhoto(
      created.medicationId,
      1,
    );

    await expect(
      service.commitMedicationPhoto({
        medicationId: created.medicationId,
        expectedVersion: 1,
        mediaId: "media_unknown",
        fileId: "/tmp/must-not-be-deleted.jpg",
      }),
    ).rejects.toMatchObject({ code: "INVALID_MEDIA" });
    await expect(
      service.commitMedicationPhoto({
        medicationId: "med_wrong-owner",
        expectedVersion: 1,
        mediaId: ticket.mediaId,
        fileId: "/tmp/must-not-be-deleted-either.jpg",
      }),
    ).rejects.toMatchObject({ code: "INVALID_MEDIA" });

    await service.discardMedicationPhoto(
      "media_unknown",
      "/tmp/arbitrary-saved-file.jpg",
    );
    expect(removedSavedFiles).toEqual([]);
    expect((await service.bootstrap()).medications[0]?.photo).toBeNull();
  });

  it("commits, exports and idempotently removes a local medication photo", async () => {
    const service = createDataService("local");
    const state = await service.acceptPrivacy("test-v1");
    const created = await service.saveMedication({
      profileId: state.profiles[0]!.id,
      name: "带照片的药",
      specification: "",
      unit: "片",
      mode: "expiry_only",
      expiryPrecision: "day",
      expiryValue: "2027-03-31",
      openedDate: null,
      afterOpenDays: null,
      note: "",
      schedule: null,
      initialQuantityMilli: null,
    });
    const ticket = await service.prepareMedicationPhoto(
      created.medicationId,
      1,
    );
    const savedFilePath = "/tmp/local-medication-photo.jpg";

    const committed = await service.commitMedicationPhoto({
      medicationId: created.medicationId,
      expectedVersion: 1,
      mediaId: ticket.mediaId,
      fileId: savedFilePath,
    });
    expect(committed.medications[0]).toMatchObject({
      version: 2,
      photo: {
        mediaId: ticket.mediaId,
        fileId: savedFilePath,
      },
    });
    expect(removedSavedFiles).toEqual([]);

    const exportedText = await service.exportData();
    const exported = JSON.parse(exportedText) as unknown as {
      data: {
        medications: Array<{
          photo: {
            included: boolean;
            updatedAt: string;
            notice: string;
          } | null;
        }>;
      };
    };
    expect(exported.data.medications[0]?.photo).toMatchObject({
      included: false,
      notice: "照片文件与内部存储地址不写入剪贴板导出",
    });
    expect(exportedText).not.toContain(savedFilePath);
    expect(exportedText).not.toContain(ticket.mediaId);
    expect(exportedText).not.toContain('"fileId"');
    expect(exportedText).not.toContain('"mediaId"');

    const removed = await service.removeMedicationPhoto(
      created.medicationId,
      2,
    );
    expect(removed.medications[0]).toMatchObject({ version: 3, photo: null });
    expect(removedSavedFiles).toEqual([savedFilePath]);

    const replayed = await service.removeMedicationPhoto(
      created.medicationId,
      3,
    );
    expect(replayed.medications[0]).toMatchObject({ version: 3, photo: null });
    expect(removedSavedFiles).toEqual([savedFilePath]);
  });

  it("falls back to an empty state when local storage is structurally incomplete", async () => {
    storage.set("yaoxiaoban_state_v1", {
      schemaVersion: 1,
      settings: {},
      profiles: [],
    });

    const state = await createDataService("local").bootstrap();

    expect(state.schemaVersion).toBe(1);
    expect(state.profiles).toEqual([]);
    expect(state.medications).toEqual([]);
    expect(state.plans).toEqual([]);
    expect(state.snapshots).toEqual([]);
    expect(state.intakeLogs).toEqual([]);
    expect(state.calendarExports).toEqual([]);
  });

  it("creates and version-updates a scheduled medication while retiring old plans", async () => {
    const service = createDataService("local");
    const state = await service.acceptPrivacy("test-v1");
    const draft = {
      profileId: state.profiles[0]!.id,
      name: "测试药",
      specification: "",
      unit: "片",
      mode: "scheduled" as const,
      expiryPrecision: "day" as const,
      expiryValue: "2027-03-31",
      openedDate: null,
      afterOpenDays: null,
      note: "",
      initialQuantityMilli: 20_000,
      schedule: {
        type: "daily" as const,
        startDate: "2026-08-19",
        endDate: null,
        weekdays: [],
        times: ["08:00"],
        doseMilli: 1000,
      },
    };
    const created = await service.saveMedication(draft);
    expect(created.state.plans).toHaveLength(1);
    expect(created.state.snapshots[0]?.quantityMilli).toBe(20_000);
    await service.saveCalendarExport({
      medicationId: created.medicationId,
      planId: created.planId!,
      fingerprint: "event-1",
      eventTitle: "药小伴服药提醒",
    });
    const updated = await service.saveMedication({
      ...draft,
      id: created.medicationId,
      expectedVersion: 1,
      initialQuantityMilli: null,
      schedule: { ...draft.schedule, times: ["09:00"] },
    });
    expect(updated.state.plans).toHaveLength(2);
    expect(updated.state.plans[0]?.effectiveTo).not.toBeNull();
    expect(updated.state.calendarExports[0]?.staleAt).not.toBeNull();

    await expect(
      service.saveMedication({
        ...draft,
        id: created.medicationId,
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("keeps the active plan and calendar export when only base medicine fields change", async () => {
    const service = createDataService("local");
    const state = await service.acceptPrivacy("test-v1");
    const draft = {
      profileId: state.profiles[0]!.id,
      name: "测试药",
      specification: "10mg",
      unit: "片",
      mode: "scheduled" as const,
      expiryPrecision: "day" as const,
      expiryValue: "2027-03-31",
      openedDate: null,
      afterOpenDays: null,
      note: "",
      initialQuantityMilli: 20_000,
      schedule: {
        type: "daily" as const,
        startDate: "2026-08-19",
        endDate: null,
        weekdays: [],
        times: ["08:00"],
        doseMilli: 1000,
      },
    };
    const created = await service.saveMedication(draft);
    const originalPlan = created.state.plans[0]!;
    await service.saveCalendarExport({
      medicationId: created.medicationId,
      planId: originalPlan.id,
      fingerprint: "base-edit-event",
      eventTitle: "药小伴服药提醒",
    });

    const updated = await service.saveMedication({
      ...draft,
      id: created.medicationId,
      expectedVersion: 1,
      name: "测试药新名",
      note: "只改备注",
      initialQuantityMilli: null,
    });

    expect(updated.planId).toBeNull();
    expect(updated.state.plans).toHaveLength(1);
    expect(updated.state.plans[0]).toMatchObject({
      id: originalPlan.id,
      effectiveTo: null,
      version: 1,
    });
    expect(updated.state.calendarExports[0]?.staleAt).toBeNull();

    const privacyChanged = await service.updateSettings({
      notificationPrivacy: "detailed",
    });
    expect(privacyChanged.calendarExports[0]?.staleAt).not.toBeNull();
  });

  it("keeps the plan but stales calendar events when their visible name or expiry window changes", async () => {
    const service = createDataService("local");
    let state = await service.acceptPrivacy("test-v1");
    state = await service.updateSettings({ notificationPrivacy: "detailed" });
    const draft = {
      profileId: state.profiles[0]!.id,
      name: "旧药名",
      specification: "",
      unit: "片",
      mode: "scheduled" as const,
      expiryPrecision: "day" as const,
      expiryValue: "2027-03-31",
      openedDate: null,
      afterOpenDays: null,
      note: "",
      initialQuantityMilli: null,
      schedule: {
        type: "daily" as const,
        startDate: "2026-08-19",
        endDate: null,
        weekdays: [],
        times: ["08:00"],
        doseMilli: 1000,
      },
    };
    const created = await service.saveMedication(draft);
    await service.saveCalendarExport({
      medicationId: created.medicationId,
      planId: created.planId!,
      fingerprint: "visible-title",
      eventTitle: "服用旧药名",
    });

    const updated = await service.saveMedication({
      ...draft,
      id: created.medicationId,
      expectedVersion: 1,
      name: "新药名",
    });

    expect(updated.state.plans).toHaveLength(1);
    expect(updated.state.plans[0]?.effectiveTo).toBeNull();
    expect(updated.state.calendarExports[0]?.staleAt).not.toBeNull();
  });

  it("blocks unit changes once a plan, snapshot or intake history exists", async () => {
    const service = createDataService("local");
    const state = await service.acceptPrivacy("test-v1");
    const draft = {
      profileId: state.profiles[0]!.id,
      name: "测试药",
      specification: "",
      unit: "片",
      mode: "scheduled" as const,
      expiryPrecision: "day" as const,
      expiryValue: "2027-03-31",
      openedDate: null,
      afterOpenDays: null,
      note: "",
      initialQuantityMilli: null,
      schedule: {
        type: "daily" as const,
        startDate: "2026-08-19",
        endDate: null,
        weekdays: [],
        times: ["08:00"],
        doseMilli: 1000,
      },
    };
    const created = await service.saveMedication(draft);

    await expect(
      service.saveMedication({
        ...draft,
        id: created.medicationId,
        expectedVersion: 1,
        unit: "粒",
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      message: "已有计划、盘点或使用记录，不能直接修改单位；请新建另一盒",
    });
  });

  it("makes intake and inventory writes idempotent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(localDateTimeToMs("2026-08-19", "07:55"));
    const service = createDataService("local");
    const state = await service.acceptPrivacy("test-v1");
    const created = await service.saveMedication({
      profileId: state.profiles[0]!.id,
      name: "测试药",
      specification: "",
      unit: "片",
      mode: "scheduled",
      expiryPrecision: "day",
      expiryValue: "2027-03-31",
      openedDate: null,
      afterOpenDays: null,
      note: "",
      schedule: {
        type: "daily",
        startDate: "2026-08-19",
        endDate: null,
        weekdays: [],
        times: ["08:00"],
        doseMilli: 1000,
      },
    });
    const intake = {
      medicationId: created.medicationId,
      planId: created.planId,
      occurrenceKey: `${created.planId}|2026-08-19|08:00`,
      scheduledAt: localDateTimeToIso("2026-08-19", "08:00"),
      status: "taken" as const,
      quantityMilli: 9000,
      requestId: "fixed-request",
    };
    await service.recordIntake(intake);
    const replayed = await service.recordIntake(intake);
    expect(replayed.intakeLogs).toHaveLength(1);
    expect(replayed.intakeLogs[0]?.quantityMilli).toBe(1000);
    const switched = await service.recordIntake({
      ...intake,
      status: "skipped",
      requestId: "new-request",
    });
    expect(switched.intakeLogs).toHaveLength(1);
    expect(switched.intakeLogs[0]?.status).toBe("skipped");

    await service.confirmInventory({
      medicationId: created.medicationId,
      quantityMilli: 5000,
      requestId: "snapshot-request",
    });
    const snapshotReplay = await service.confirmInventory({
      medicationId: created.medicationId,
      quantityMilli: 5000,
      requestId: "snapshot-request",
    });
    expect(snapshotReplay.snapshots).toHaveLength(1);
  });

  it("rejects task check-ins too early and future-dated manual records", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(localDateTimeToMs("2026-08-19", "07:55"));
    const service = createDataService("local");
    const state = await service.acceptPrivacy("test-v1");
    const created = await service.saveMedication({
      profileId: state.profiles[0]!.id,
      name: "测试药",
      specification: "",
      unit: "片",
      mode: "scheduled",
      expiryPrecision: "day",
      expiryValue: "2027-03-31",
      openedDate: null,
      afterOpenDays: null,
      note: "",
      schedule: {
        type: "daily",
        startDate: "2026-08-19",
        endDate: null,
        weekdays: [],
        times: ["08:30"],
        doseMilli: 1000,
      },
    });

    await expect(
      service.recordIntake({
        medicationId: created.medicationId,
        planId: created.planId,
        occurrenceKey: `${created.planId}|2026-08-19|08:30`,
        scheduledAt: localDateTimeToIso("2026-08-19", "08:30"),
        status: "taken",
        quantityMilli: 1000,
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      message: "距计划时间10分钟内才能记录",
    });

    await expect(
      service.recordIntake({
        medicationId: created.medicationId,
        planId: null,
        occurrenceKey: null,
        scheduledAt: null,
        status: "extra",
        quantityMilli: 1000,
        occurredAt: localDateTimeToIso("2026-08-19", "08:01"),
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      message: "记录时间不能晚于当前时间",
    });
  });

  it("supports undo, archive, safe restore and cascading permanent delete", async () => {
    const service = createDataService("local");
    const state = await service.acceptPrivacy("test-v1");
    const created = await service.saveMedication({
      profileId: state.profiles[0]!.id,
      name: "测试药",
      specification: "",
      unit: "片",
      mode: "scheduled",
      expiryPrecision: "day",
      expiryValue: "2027-03-31",
      openedDate: null,
      afterOpenDays: null,
      note: "",
      initialQuantityMilli: 10_000,
      schedule: {
        type: "daily",
        startDate: "2026-08-19",
        endDate: null,
        weekdays: [],
        times: ["08:00"],
        doseMilli: 1000,
      },
    });
    await service.saveCalendarExport({
      medicationId: created.medicationId,
      planId: created.planId!,
      fingerprint: "delete-cascade-event",
      eventTitle: "药小伴服药提醒",
    });
    await service.recordIntake({
      medicationId: created.medicationId,
      planId: null,
      occurrenceKey: null,
      scheduledAt: null,
      status: "extra",
      quantityMilli: 1000,
      requestId: "extra-request",
    });
    const beforeUndo = await service.bootstrap();
    const log = beforeUndo.intakeLogs[0]!;
    const undone = await service.undoIntake(log.id, log.version);
    expect(undone.intakeLogs[0]?.voidedAt).not.toBeNull();
    const archived = await service.archiveMedication(created.medicationId, 1);
    expect(archived.medications[0]?.archivedAt).not.toBeNull();
    expect(archived.plans[0]?.effectiveTo).not.toBeNull();
    expect(archived.calendarExports[0]?.staleAt).not.toBeNull();
    expect(await service.exportData()).toContain("本文件包含私人服药记录");

    const restored = await service.restoreMedication(created.medicationId, 2);
    expect(restored.medications[0]).toMatchObject({
      archivedAt: null,
      mode: "expiry_only",
      version: 3,
    });
    expect(restored.plans[0]?.effectiveTo).not.toBeNull();

    const deleted = await service.deleteMedication(created.medicationId, 3);
    expect(deleted.medications).toHaveLength(0);
    expect(deleted.plans).toHaveLength(0);
    expect(deleted.snapshots).toHaveLength(0);
    expect(deleted.intakeLogs).toHaveLength(0);
    expect(deleted.calendarExports).toHaveLength(0);
  });

  it("protects profile integrity", async () => {
    const service = createDataService("local");
    const state = await service.acceptPrivacy("test-v1");
    const profile = state.profiles[0]!;
    await expect(
      service.archiveProfile(profile.id, profile.version),
    ).rejects.toBeInstanceOf(ServiceError);
    const withParent = await service.upsertProfile({
      name: "妈妈",
      relation: "parent",
      color: "#3E719A",
    });
    const parent = withParent.profiles.find((item) => item.name === "妈妈")!;
    const archived = await service.archiveProfile(parent.id, parent.version);
    expect(
      archived.profiles.find((item) => item.id === parent.id)?.archivedAt,
    ).not.toBeNull();
  });
});

describe("bounded photo relay", () => {
  type ChunkCall = {
    data: {
      action: string;
      requestId: string;
      payload: { index?: number; base64?: string };
    };
  };
  const input = {
    medicationId: "med-chunks",
    expectedVersion: 1,
    mediaId: "media-chunks",
    base64: Buffer.alloc(434581, 17).toString("base64"),
  };
  it("434581 字节图片通过 12 个小于 50KB 的请求合并，完整图片不经过单次 RPC", async () => {
    const callFunction = vi.fn(async ({ data }: ChunkCall) => ({
      result: {
        ok: true,
        data:
          data.action === "finishMedicationPhotoUpload"
            ? { fileId: "cloud://env/photo" }
            : { accepted: true },
      },
    }));
    (wx as unknown as { cloud: { callFunction: typeof callFunction } }).cloud =
      { callFunction };
    const service = createDataService("cloud");
    await expect(service.uploadMedicationPhoto!(input)).resolves.toEqual({
      fileId: "cloud://env/photo",
    });
    const events = callFunction.mock.calls.map(([options]) => options.data);
    expect(events).toHaveLength(13);
    expect(
      events
        .slice(0, -1)
        .map((e) => e.payload.base64)
        .join(""),
    ).toBe(input.base64);
    expect(
      events.every((e) => Buffer.byteLength(JSON.stringify(e)) < 50 * 1024),
    ).toBe(true);
    expect(events[events.length - 1]!.action).toBe(
      "finishMedicationPhotoUpload",
    );
    expect(events[events.length - 1]!.payload.base64).toBeUndefined();
  });
  it("中途 -1 保留未知结果和原分块请求号，重试完整续传后才合并", async () => {
    let failed = false;
    const callFunction = vi.fn(async ({ data }: ChunkCall) => {
      if (
        data.action === "putMedicationPhotoChunk" &&
        data.payload.index === 3 &&
        !failed
      ) {
        failed = true;
        throw Object.assign(new Error("platform error"), { errCode: -1 });
      }
      return {
        result: {
          ok: true,
          data:
            data.action === "finishMedicationPhotoUpload"
              ? { fileId: "cloud://env/photo" }
              : { accepted: true },
        },
      };
    });
    (wx as unknown as { cloud: { callFunction: typeof callFunction } }).cloud =
      { callFunction };
    const service = createDataService("cloud");
    await expect(service.uploadMedicationPhoto!(input)).rejects.toMatchObject({
      outcome: "unknown",
    });
    expect(callFunction.mock.calls).toHaveLength(6);
    await service.uploadMedicationPhoto!(input);
    const retried = callFunction.mock.calls
      .map(([o]) => o.data)
      .filter((e) => e.payload.index === 3);
    expect(retried[0]!.requestId).toBe(retried[1]!.requestId);
    expect(
      callFunction.mock.calls[callFunction.mock.calls.length - 1]![0].data
        .action,
    ).toBe("finishMedicationPhotoUpload");
  });
  it("分块最多三路并发，全部确认后才合并", async () => {
    let active = 0;
    let maximum = 0;
    const pending: Array<() => void> = [];
    const actions: string[] = [];
    const callFunction = vi.fn(async ({ data }: ChunkCall) => {
      actions.push(data.action);
      if (data.action === "putMedicationPhotoChunk") {
        active++;
        maximum = Math.max(maximum, active);
        await new Promise<void>((resolve) => pending.push(resolve));
        active--;
      } else expect(active).toBe(0);
      return {
        result: {
          ok: true,
          data:
            data.action === "finishMedicationPhotoUpload"
              ? { fileId: "cloud://env/photo" }
              : { accepted: true },
        },
      };
    });
    (wx as unknown as { cloud: { callFunction: typeof callFunction } }).cloud =
      { callFunction };
    const service = createDataService("cloud");
    const result = service.uploadMedicationPhoto!(input);
    for (let batch = 0; batch < 4; batch++) {
      await vi.waitFor(() => expect(pending).toHaveLength(3));
      expect(actions).not.toContain("finishMedicationPhotoUpload");
      pending.splice(0).forEach((resolve) => resolve());
    }
    await expect(result).resolves.toEqual({ fileId: "cloud://env/photo" });
    expect(maximum).toBe(3);
    expect(actions[actions.length - 1]).toBe("finishMedicationPhotoUpload");
  });
});
