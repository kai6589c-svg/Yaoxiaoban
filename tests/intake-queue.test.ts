import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IntakeQueue } from "../miniprogram/services/intake-queue";
import {
  ServiceError,
  type DataService,
  type RecordIntakeInput,
} from "../miniprogram/services/data-service";
import { appState } from "./fixtures";
import { buildTodayTasks } from "../miniprogram/core/dashboard";
const values = new Map<string, unknown>();
const record =
  vi.fn<(input: RecordIntakeInput) => Promise<ReturnType<typeof appState>>>();
let service: DataService;
beforeEach(() => {
  values.clear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-19T01:00:00Z"));
  record.mockReset().mockResolvedValue(appState());
  vi.stubGlobal("wx", {
    getStorageSync: (key: string) => structuredClone(values.get(key)),
    setStorageSync: (key: string, value: unknown) =>
      values.set(key, structuredClone(value)),
    removeStorageSync: (key: string) => values.delete(key),
  });
  service = {
    syncScope: "account-A",
    recordIntake: record,
  } as unknown as DataService;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("offline record is durable before transport and restart preserves the requestId and occurredAt", async () => {
  record.mockRejectedValueOnce(
    new ServiceError("NETWORK", "offline", true, "unknown"),
  );
  const queue = new IntakeQueue(service);
  const task = buildTodayTasks(appState())[0]!;
  const job = queue.enqueue(task, "taken");
  expect(queue.list()[0]?.message).toBe("已记录，待同步");
  expect(record).not.toHaveBeenCalled();
  await queue.run(job.id);
  expect(queue.list()[0]?.status).toBe("failed");
  const recovered = new IntakeQueue(service);
  await recovered.run(job.id);
  expect(record.mock.calls[0]?.[0]).toEqual(record.mock.calls[1]?.[0]);
  expect(recovered.list()[0]?.status).toBe("synced");
});
it("duplicate taps and concurrent resume share one occurrence and one running request", async () => {
  const queue = new IntakeQueue(service);
  const task = buildTodayTasks(appState())[0]!;
  const first = queue.enqueue(task, "taken"),
    second = queue.enqueue(task, "taken");
  expect(second.id).toBe(first.id);
  await Promise.all([queue.run(first.id), queue.run(second.id)]);
  expect(record).toHaveBeenCalledOnce();
});
it("server conflicts remain visible and never silently overwrite a different record", async () => {
  record.mockRejectedValue(
    new ServiceError("CONFLICT", "其他设备已记录", false),
  );
  const queue = new IntakeQueue(service);
  const job = queue.enqueue(buildTodayTasks(appState())[0]!, "skipped");
  await queue.run(job.id);
  expect(queue.list()[0]).toMatchObject({
    terminal: true,
    message: "其他设备已记录",
  });
  await queue.resume();
  expect(record).toHaveBeenCalledOnce();
  service.syncScope = "account-B";
  expect(queue.list()).toEqual([]);
});
it("quota failure gives no optimistic success or network mutation", () => {
  const queue = new IntakeQueue(service);
  vi.spyOn(wx, "setStorageSync").mockImplementation(() => {
    throw new Error("quota");
  });
  expect(() => queue.enqueue(buildTodayTasks(appState())[0]!, "taken")).toThrow(
    "quota",
  );
  expect(record).not.toHaveBeenCalled();
});
it("intake not yet eligible is rejected locally", () => {
  const task = buildTodayTasks(appState())[0]!;
  expect(() =>
    new IntakeQueue(service).enqueue(
      { ...task, status: "upcoming", scheduledAtMs: Date.now() + 3600000 },
      "taken",
    ),
  ).toThrow();
});
