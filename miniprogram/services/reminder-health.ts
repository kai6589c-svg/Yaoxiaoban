import type { ReminderStatus } from "./data-service";
import { formatLocalDateTime } from "../core/dates";
export interface ReminderHealth {
  level: "ok" | "warning" | "off";
  title: string;
  detail: string;
  next: string;
}
export const buildReminderHealth = (
  state: ReminderStatus | null,
  now = Date.now(),
): ReminderHealth => {
  if (!state)
    return {
      level: "warning",
      title: "提醒状态暂时无法读取",
      detail: "请联网后重新查看提醒设置。",
      next: "",
    };
  const kinds = (["dose", "expiry", "shortage"] as const).filter(
    (kind) => state.preferences[kind],
  );
  if (!kinds.length)
    return {
      level: "off",
      title: "微信提醒尚未开启",
      detail: "保存服药计划不会自动开启通知。",
      next: "",
    };
  const tasks = state.tasks
    .filter((task) => kinds.includes(task.kind))
    .sort((a, b) => b.dueAt.localeCompare(a.dueAt));
  const nextTask = tasks
    .filter(
      (task) => task.status === "pending" && Date.parse(task.dueAt) >= now,
    )
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt))[0];
  const next = nextTask
    ? `下一次计划：${formatLocalDateTime(nextTask.dueAt)}`
    : "尚无可确认的下一次微信提醒";
  const unknown = tasks.find((task) => task.status === "delivery_unknown");
  if (unknown)
    return {
      level: "warning",
      title: "有一条提醒结果待核对",
      detail: "平台响应不确定，系统不会自动重复发送。请核对提醒记录。",
      next,
    };
  const noGrant = kinds.some((kind) => state.grants[kind].usableCount <= 0);
  if (noGrant)
    return {
      level: "warning",
      title: "提醒可能无法发送",
      detail: "部分已开启的提醒缺少可用授权，请在提醒设置中重新授权。",
      next,
    };
  const recentFailure = tasks.find(
    (task) =>
      ["failed", "pending"].includes(task.status) &&
      task.failureCode &&
      Date.parse(task.dueAt) >= now - 24 * 60 * 60 * 1000,
  );
  const overdue = tasks.some(
    (task) =>
      task.status === "pending" && Date.parse(task.dueAt) < now - 5 * 60 * 1000,
  );
  if (recentFailure || overdue)
    return {
      level: "warning",
      title: "提醒执行需要留意",
      detail: recentFailure
        ? "最近有发送失败，请查看提醒设置；可重试的错误会有限重试。"
        : "有提醒超过计划时间仍未确认执行，请稍后核对。",
      next,
    };
  return {
    level: "ok",
    title: "提醒已开启，当前有可用授权",
    detail:
      "平台接受发送请求不代表手机一定展示通知；日历提醒请在系统日历核对。",
    next,
  };
};
