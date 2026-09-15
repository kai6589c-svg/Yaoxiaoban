import { createRequestId } from "../core/id";
import type { TodayTask } from "../core/models";
import {
  ServiceError,
  type DataService,
  type RecordIntakeInput,
} from "./data-service";
import { observeSave, SAVE_BUDGET_MS } from "./save-queue";
export interface IntakeJob {
  id: string;
  input: RecordIntakeInput;
  name: string;
  createdAt: number;
  attempts: number;
  retryAt: number;
  status: "pending" | "failed" | "synced";
  terminal: boolean;
  message: string;
}
const queues = new WeakMap<DataService, IntakeQueue>();
export const getIntakeQueue = (service: DataService): IntakeQueue => {
  let queue = queues.get(service);
  if (!queue) {
    queue = new IntakeQueue(service);
    queues.set(service, queue);
  }
  return queue;
};
export class IntakeQueue {
  private running = new Map<string, Promise<void>>();
  private listeners = new Set<() => void>();
  constructor(private service: DataService) {}
  private key() {
    return `yaoxiaoban:intake-queue-v1:${this.service.syncScope}`;
  }
  list(): IntakeJob[] {
    if (!this.service.syncScope) return [];
    const rows: unknown = wx.getStorageSync(this.key());
    return Array.isArray(rows) ? (rows as IntakeJob[]) : [];
  }
  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  private write(rows: IntakeJob[]) {
    wx.setStorageSync(this.key(), rows);
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        /* UI does not own sync. */
      }
    }
  }
  enqueue(task: TodayTask, status: "taken" | "skipped"): IntakeJob {
    if (!this.service.syncScope)
      throw new ServiceError("NETWORK", "请联网加载一次后再记录", true);
    const existing = this.list().find(
      (item) =>
        item.input.occurrenceKey === task.key && item.status !== "synced",
    );
    if (existing) return existing;
    const now = Date.now();
    if (
      !["due", "upcoming"].includes(task.status) ||
      (status === "skipped"
        ? task.scheduledAtMs > now
        : task.scheduledAtMs > now + 10 * 60_000)
    )
      throw new ServiceError("INVALID_ARGUMENT", "尚未到可记录的时间");
    const rows = this.list().filter((item) => item.status !== "synced");
    if (rows.length >= 100)
      throw new ServiceError("LIMIT_EXCEEDED", "待同步记录较多，请先联网同步");
    const id = createRequestId();
    const job: IntakeJob = {
      id,
      input: {
        medicationId: task.medicationId,
        planId: task.planId,
        occurrenceKey: task.key,
        scheduledAt: task.scheduledAt,
        status,
        quantityMilli: task.doseMilli,
        occurredAt: new Date(now).toISOString(),
        requestId: id,
      },
      name: task.medicationName,
      createdAt: now,
      attempts: 0,
      retryAt: 0,
      status: "pending",
      terminal: false,
      message: "已记录，待同步",
    };
    this.write([...rows, job]);
    return job;
  }
  run(id: string): Promise<void> {
    const active = this.running.get(id);
    if (active) return active;
    const scope = this.service.syncScope;
    const work = (async () => {
      const job = this.list().find((item) => item.id === id);
      if (!job || job.status === "synced" || job.terminal) return;
      job.attempts++;
      this.write(this.list().map((item) => (item.id === id ? job : item)));
      try {
        if (Date.now() - job.createdAt > 24 * 60 * 60_000)
          throw new ServiceError(
            "INVALID_ARGUMENT",
            "记录已超过自动恢复期限，请核对历史后处理",
            false,
          );
        const result = await observeSave(
          this.service.recordIntake(job.input, {
            attemptId: job.id,
            requestId: job.id,
            stage: "save_fields",
            deadlineAt: Date.now() + SAVE_BUDGET_MS,
          }),
          Date.now() + SAVE_BUDGET_MS,
        );
        if (!result)
          throw new ServiceError("NETWORK", "记录结果待确认", true, "unknown");
        job.status = "synced";
        job.message = "已同步";
      } catch (error) {
        const failure =
          error instanceof ServiceError
            ? error
            : new ServiceError("NETWORK", "记录待同步", true, "unknown");
        job.status = "failed";
        job.terminal = !failure.retryable;
        job.message = job.terminal ? failure.message : "记录待同步，联网后继续";
        job.retryAt =
          Date.now() + Math.min(60_000, 2_000 * 2 ** Math.min(job.attempts, 5));
      }
      if (
        scope === this.service.syncScope &&
        this.list().some((item) => item.id === id)
      )
        this.write(this.list().map((item) => (item.id === id ? job : item)));
    })().finally(() => {
      this.running.delete(id);
    });
    this.running.set(id, work);
    return work;
  }
  async resume() {
    for (const job of this.list())
      if (
        job.status !== "synced" &&
        !job.terminal &&
        job.attempts < 5 &&
        job.retryAt <= Date.now()
      )
        await this.run(job.id);
  }
  clear() {
    if (this.service.syncScope) wx.removeStorageSync(this.key());
  }
  discard(id: string) {
    if (this.running.has(id))
      throw new ServiceError(
        "OPERATION_IN_PROGRESS",
        "记录仍在同步，请稍后处理",
      );
    const job = this.list().find((item) => item.id === id);
    if (job && !job.terminal && job.status !== "synced")
      throw new ServiceError(
        "OPERATION_IN_PROGRESS",
        "请先联网确认记录结果，再决定是否撤销",
      );
    this.write(this.list().filter((item) => item.id !== id));
  }
}
