"use strict";

const LEASE_MS = 2 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const PERMANENT_CODES = new Set(["40037", "41028", "43101", "47003"]);

class ReminderWorker {
  constructor({
    store,
    sender,
    config,
    clock = () => new Date(),
    logger = console,
  }) {
    this.store = store;
    this.sender = sender;
    this.config = config;
    this.clock = clock;
    this.logger = logger;
  }

  async run({ limit = 50, runtimeEnvironmentId = null } = {}) {
    const safeLimit = Number.isInteger(limit)
      ? Math.min(Math.max(limit, 1), 100)
      : 50;
    if (
      !this.config.enabled ||
      (runtimeEnvironmentId &&
        runtimeEnvironmentId !== this.config.environmentId)
    ) {
      return {
        enabled: false,
        examined: 0,
        sent: 0,
        skippedConfig: 0,
        failed: 0,
        recovered: 0,
      };
    }
    const now = this.clock().toISOString();
    await this.store.migrateSubscriptionGrantVersions?.(now);
    const recovered = await this.store.recoverExpiredLeases(now);
    const due = await this.store.listDue(now, safeLimit);
    const summary = {
      enabled: true,
      examined: due.length,
      sent: 0,
      skippedConfig: 0,
      failed: 0,
      canceled: 0,
      recovered,
      unknown: 0,
    };
    for (const candidate of due) {
      const template = this.config.templates[candidate.kind];
      if (!template?.enabled) {
        summary.skippedConfig += 1;
        continue;
      }
      const leaseUntil = new Date(
        this.clock().getTime() + LEASE_MS,
      ).toISOString();
      const task = await this.store.claim(
        candidate,
        this.clock().toISOString(),
        leaseUntil,
      );
      if (!task) continue;
      const privacy = settingsPrivacy(
        await this.store.getSettings(task.accountId),
      );
      const templatePrivacy = template.privacy ?? "generic";
      if (templatePrivacy === "detailed" && privacy !== "detailed") {
        await (this.store.markWaitingConfiguration?.(
          task,
          this.clock().toISOString(),
          "PRIVACY_MODE_BLOCKED",
        ) ??
          this.store.markCanceled(
            task,
            this.clock().toISOString(),
            "PRIVACY_MODE_BLOCKED",
          ));
        summary.skippedConfig += 1;
        continue;
      }
      let data;
      try {
        data = buildTemplateData(
          task.payload,
          template.map,
          template.deliveryType ?? "longTerm",
          privacy,
        );
      } catch (error) {
        await this.store.markPermanentFailure(
          task,
          this.clock().toISOString(),
          error?.message === "TEMPLATE_FIELD_INVALID"
            ? "TEMPLATE_FIELD_INVALID"
            : "TEMPLATE_CONFIGURATION_INVALID",
        );
        summary.failed += 1;
        continue;
      }
      if (
        task.kind === "dose" &&
        task.scheduledAt &&
        Date.parse(now) > Date.parse(task.scheduledAt) + 10 * 60 * 1000
      ) {
        await (this.store.markReminderTaskExpired?.(
          task,
          this.clock().toISOString(),
        ) ?? this.store.markExpired?.(task, this.clock().toISOString()));
        summary.canceled += 1;
        continue;
      }
      const account = await this.store.getAccount(task.accountId);
      const settings = await this.store.getSettings(task.accountId);
      if (!account?.openid || account.status !== "active") {
        await this.store.markCanceled(
          task,
          this.clock().toISOString(),
          "ACCOUNT_UNAVAILABLE",
        );
        summary.canceled += 1;
        continue;
      }
      if (!settings?.subscriptions?.[task.kind]) {
        if (task.kind === "dose" && !settings?.reminderPreferences?.dose) {
          await this.store.markCanceled(
            task,
            this.clock().toISOString(),
            "REMINDER_DISABLED",
          );
          summary.canceled += 1;
          continue;
        }
      }
      if (
        task.kind !== "dose" &&
        !settings?.reminderPreferences?.[task.kind] &&
        !settings?.subscriptions?.[task.kind]
      ) {
        await this.store.markCanceled(
          task,
          this.clock().toISOString(),
          "SUBSCRIPTION_DISABLED",
        );
        summary.canceled += 1;
        continue;
      }
      if (typeof this.store.revalidateTask === "function") {
        const valid = await this.store.revalidateTask(task);
        if (!valid) {
          await this.store.markCanceled(
            task,
            this.clock().toISOString(),
            "PLAN_OR_EVENT_CHANGED",
          );
          summary.canceled += 1;
          continue;
        }
      }
      let reservation = null;
      if (typeof this.store.reserveSubscriptionGrant === "function") {
        reservation = await this.store.reserveSubscriptionGrant(
          task.accountId,
          task.templateId ?? template.templateId,
          this.clock().toISOString(),
          {
            taskId: task._id,
            medicationId: task.medicationId,
            kind: task.kind,
          },
        );
      }
      if (
        typeof this.store.reserveSubscriptionGrant === "function" &&
        !reservation
      ) {
        await this.store.markCanceled(
          task,
          this.clock().toISOString(),
          "SUBSCRIPTION_EXHAUSTED",
        );
        summary.canceled += 1;
        continue;
      }
      try {
        await this.store.markAttempt?.(task, this.clock().toISOString());
        const response = await this.sender.send({
          touser: account.openid,
          templateId: template.templateId,
          page: this.config.page,
          miniprogramState: this.config.miniprogramState,
          lang: "zh_CN",
          data,
        });
        const responseCode = providerErrorCode(response);
        if (responseCode === null) {
          const unknown = new Error("DELIVERY_OUTCOME_UNKNOWN");
          unknown.outcome = "unknown";
          throw unknown;
        }
        if (responseCode !== null && responseCode !== "0") {
          const providerError = new Error("PROVIDER_REJECTED");
          providerError.errCode = responseCode;
          throw providerError;
        }
        try {
          await this.store.markSent(task, this.clock().toISOString(), {
            accepted: true,
            errCode: responseCode === null ? null : responseCode,
          });
          await this.store.finalizeSubscriptionGrant?.(
            task.accountId,
            reservation?.grantId,
            this.clock().toISOString(),
            { taskId: task._id },
          );
        } catch (error) {
          await this.store.markDeliveryUnknown?.(
            task,
            this.clock().toISOString(),
            "MARK_SENT_FAILED",
          );
          summary.unknown += 1;
          this.logger.warn("REMINDER_MARK_SENT_UNKNOWN", {
            code: "MARK_SENT_FAILED",
          });
          continue;
        }
        summary.sent += 1;
      } catch (error) {
        if (error?.message === "TEMPLATE_FIELD_INVALID") {
          await this.store.markPermanentFailure(
            task,
            this.clock().toISOString(),
            "TEMPLATE_FIELD_INVALID",
          );
          summary.failed += 1;
          continue;
        }
        const code = normalizeErrorCode(error);
        if (isDeliveryOutcomeUnknown(error)) {
          await this.store.markDeliveryUnknown?.(
            task,
            this.clock().toISOString(),
            "DELIVERY_OUTCOME_UNKNOWN",
          );
          summary.unknown += 1;
          this.logger.warn("REMINDER_DELIVERY_UNKNOWN", {
            code: "DELIVERY_OUTCOME_UNKNOWN",
          });
          continue;
        }
        if (
          reservation?.grantId &&
          typeof this.store.releaseSubscriptionGrant === "function"
        ) {
          await this.store
            .releaseSubscriptionGrant(
              task.accountId,
              reservation.grantId,
              this.clock().toISOString(),
              { taskId: task._id },
            )
            .catch(() => undefined);
        }
        const attempts = (task.attempts ?? 0) + 1;
        if (PERMANENT_CODES.has(code)) {
          await this.store.markPermanentFailure(
            task,
            this.clock().toISOString(),
            code,
          );
        } else {
          const exhausted = attempts >= MAX_ATTEMPTS;
          const nextAttemptAt = new Date(
            this.clock().getTime() + retryDelayMs(attempts),
          ).toISOString();
          await this.store.markRetry(
            task,
            this.clock().toISOString(),
            nextAttemptAt,
            code,
            exhausted,
          );
        }
        summary.failed += 1;
        this.logger.warn("REMINDER_DELIVERY_FAILED", { code });
      }
    }
    return summary;
  }
}

function buildTemplateData(
  payload,
  map,
  deliveryType = "longTerm",
  privacy = "detailed",
) {
  if (!map || typeof map !== "object")
    throw new Error("TEMPLATE_CONFIGURATION_INVALID");
  const source = {
    medicineName: payload?.medicineName,
    productName: payload?.productName,
    date: payload?.date,
    expiryDate: payload?.expiryDate,
    doseTime: payload?.doseTime,
    dose: payload?.dose,
    message: payload?.message,
  };
  const data = {};
  for (const [semantic, keyword] of Object.entries(map)) {
    if (
      privacy === "generic" &&
      ["medicineName", "dose", "doseTime"].includes(semantic)
    )
      continue;
    if (["date", "expiryDate"].includes(semantic))
      source[semantic] = normalizeDate(source[semantic]);
    if (semantic === "doseTime")
      source[semantic] = normalizeTime(source[semantic]);
    if (typeof source[semantic] !== "string" || !source[semantic].trim())
      throw new Error("TEMPLATE_FIELD_INVALID");
    const isShortThing = keyword.startsWith("short_thing");
    const max = deliveryType === "oneTime" && isShortThing ? 5 : 20;
    const value = truncate(source[semantic], max);
    if (
      deliveryType === "oneTime" &&
      isShortThing &&
      value !== source[semantic]
    )
      throw new Error("TEMPLATE_FIELD_INVALID");
    data[keyword] = { value };
  }
  return data;
}

function normalizeDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new Error("TEMPLATE_FIELD_INVALID");
  const [year, month, day] = value.split("-").map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  )
    throw new Error("TEMPLATE_FIELD_INVALID");
  return value;
}

function normalizeTime(value) {
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value))
    throw new Error("TEMPLATE_FIELD_INVALID");
  const [hour, minute] = value.split(":").map(Number);
  if (hour > 23 || minute > 59) throw new Error("TEMPLATE_FIELD_INVALID");
  return value;
}

function providerErrorCode(response) {
  const value = response?.errCode ?? response?.errcode;
  return value === undefined || value === null ? null : String(value);
}

function settingsPrivacy(settings) {
  return (
    settings?.notificationPrivacy ??
    (settings?.privateCalendarTitle === false ? "detailed" : "generic")
  );
}

function truncate(value, max) {
  return [...String(value)].slice(0, max).join("");
}

function normalizeErrorCode(error) {
  const raw = String(error?.errCode ?? error?.code ?? "UNKNOWN");
  const match = raw.match(/-?\d+/);
  return match ? match[0].replace(/^-/, "") : "UNKNOWN";
}

function isDeliveryOutcomeUnknown(error) {
  if (error?.outcome === "unknown") return true;
  const raw = String(error?.errCode ?? error?.code ?? "").toUpperCase();
  return ["UNKNOWN", "ETIMEDOUT", "TIMEOUT", "ECONNRESET", "ECONNABORTED"].some(
    (marker) => raw === marker || raw.includes(marker),
  );
}

function retryDelayMs(attempt) {
  return Math.min(
    24 * 60 * 60 * 1000,
    15 * 60 * 1000 * 2 ** Math.max(0, attempt - 1),
  );
}

module.exports = {
  ReminderWorker,
  buildTemplateData,
  normalizeErrorCode,
  isDeliveryOutcomeUnknown,
  retryDelayMs,
};
