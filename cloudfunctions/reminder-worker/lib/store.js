"use strict";

const PAGE_SIZE = 100;

class ReminderStore {
  constructor(db, options = {}) {
    this.db = db;
    this.command = db.command;
    const prefix =
      options.collectionPrefix ?? process.env.COLLECTION_PREFIX ?? "yxb_";
    if (!/^[A-Za-z][A-Za-z0-9_]{0,20}$/.test(prefix))
      throw new Error("INVALID_COLLECTION_PREFIX");
    this.prefix = prefix;
  }

  collection(name) {
    return this.db.collection(`${this.prefix}${name}`);
  }

  async listDue(now, limit) {
    const capped = Math.min(limit, PAGE_SIZE);
    const base = { status: "pending", dueAt: this.command.lte(now) };
    const [ready, legacy] = await Promise.all([
      this.collection("reminder_tasks")
        .where({ ...base, nextAttemptAt: this.command.lte(now) })
        .orderBy("dueAt", "asc")
        .limit(capped)
        .get(),
      this.collection("reminder_tasks")
        .where({ ...base, nextAttemptAt: null })
        .orderBy("dueAt", "asc")
        .limit(capped)
        .get(),
    ]);
    return [...(ready.data ?? []), ...(legacy.data ?? [])]
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
      .slice(0, capped);
  }

  async recoverExpiredLeases(now) {
    const result = await this.collection("reminder_tasks")
      .where({ status: "sending", leaseUntil: this.command.lte(now) })
      .limit(PAGE_SIZE)
      .get();
    const tasks = result.data ?? [];
    await Promise.all(
      tasks.map((task) =>
        this.collection("reminder_tasks")
          .doc(task._id)
          .update({
            // An expired lease has an unknown provider outcome. It must be
            // reconciled explicitly; making it pending would blind-resend.
            data: {
              status: "delivery_unknown",
              failureCode: "DELIVERY_OUTCOME_UNKNOWN",
              leaseUntil: null,
              updatedAt: now,
            },
          }),
      ),
    );
    return tasks.length;
  }

  async claim(task, now, leaseUntil) {
    const result = await this.collection("reminder_tasks")
      .where({
        _id: task._id,
        status: "pending",
        version: task.version,
      })
      .update({
        data: {
          status: "sending",
          leaseUntil,
          version: this.command.inc(1),
          updatedAt: now,
        },
      });
    if ((result?.stats?.updated ?? result?.updated ?? 0) !== 1) return null;
    const refreshed = await this.collection("reminder_tasks")
      .doc(task._id)
      .get();
    return refreshed.data ?? null;
  }

  async getAccount(accountId) {
    try {
      const result = await this.collection("accounts").doc(accountId).get();
      return result.data ?? null;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async getSettings(accountId) {
    const result = await this.collection("settings")
      .where({ accountId })
      .limit(1)
      .get();
    return result.data?.[0] ?? null;
  }

  async migrateSubscriptionGrantVersions(now) {
    const result = await this.collection("subscription_grants")
      .where({ status: "accept" })
      .limit(PAGE_SIZE)
      .get();
    let migrated = 0;
    for (const grant of result.data ?? []) {
      if (Number.isInteger(grant.version)) continue;
      const updated = await this.collection("subscription_grants")
        .where({ _id: grant._id, status: "accept", version: null })
        .update({
          data: {
            version: 1,
            migratedAt: now,
            updatedAt: now,
          },
        });
      migrated += updatedCount(updated);
    }
    return migrated;
  }

  async markReminderTaskExpired(task, now) {
    await this.collection("reminder_tasks")
      .doc(task._id)
      .update({
        data: {
          status: "expired",
          failureCode: "DOSE_WINDOW_EXPIRED",
          leaseUntil: null,
          updatedAt: now,
        },
      });
  }

  async revalidateTask(task) {
    const medication = await this.collection("medications")
      .where({ _id: task.medicationId, accountId: task.accountId })
      .limit(1)
      .get();
    const current = medication.data?.[0] ?? null;
    if (!current || current.status !== "active") return false;
    if (task.kind !== "dose") return true;
    if (!task.planId || current.activePlanId !== task.planId) return false;
    const base = {
      accountId: task.accountId,
      medicationId: task.medicationId,
      planId: task.planId,
      scheduledAt: task.scheduledAt,
      status: this.command.in(["taken", "skipped"]),
    };
    // Apply the validity predicate in the database before limit(1).  A
    // revoked row must never occupy the one result slot and hide a later
    // active row for the same occurrence.  CloudBase treats null as matching
    // an absent field in the normal query engine; the exists(false) branch is
    // retained for deployments where that compatibility differs.
    const queries = [
      { ...base, voidedAt: null },
      ...(typeof this.command.exists === "function"
        ? [{ ...base, voidedAt: this.command.exists(false) }]
        : []),
    ];
    const results = await Promise.all(
      queries.map((query) =>
        this.collection("intake_logs").where(query).limit(1).get(),
      ),
    );
    return !results.some((result) =>
      (result.data ?? []).some((log) => !log.voidedAt),
    );
  }

  async reserveSubscriptionGrant(accountId, templateId, now, binding = {}) {
    if (!binding.taskId || !binding.medicationId || !binding.kind) return false;
    const existingReservationQuery = await this.collection(
      "subscription_grants",
    )
      .where({
        accountId,
        templateId,
        status: "accept",
        reservedTaskId: binding.taskId,
        reservedMedicationId: binding.medicationId,
        reservedKind: binding.kind,
      })
      .limit(1)
      .get();
    const existingReservation = existingReservationQuery.data?.[0];
    if (existingReservation)
      return {
        reserved: true,
        grantId: existingReservation._id,
        idempotent: true,
      };
    const result = await this.collection("subscription_grants")
      .where({
        accountId,
        templateId,
        status: "accept",
        authorizedMedicationId: binding.medicationId,
        usableCount: this.command.gt(0),
        reservedTaskId: null,
      })
      .limit(PAGE_SIZE)
      .get();
    const grant = (result.data ?? []).find(
      (item) =>
        Number.isInteger(item.version) &&
        (!item.reservedTaskId || item.reservedTaskId === binding.taskId),
    );
    if (!grant) return false;
    if (grant.reservedTaskId === binding.taskId)
      return { reserved: true, grantId: grant._id, idempotent: true };
    const updated = await this.collection("subscription_grants")
      .where({
        _id: grant._id,
        accountId,
        version: grant.version,
        usableCount: this.command.gt(0),
      })
      .update({
        data: {
          usableCount: this.command.inc(-1),
          version: this.command.inc(1),
          reservedTaskId: binding.taskId,
          reservedMedicationId: binding.medicationId,
          reservedKind: binding.kind,
          updatedAt: now,
        },
      });
    const reserved = (updated?.stats?.updated ?? updated?.updated ?? 0) === 1;
    if (reserved) return { reserved: true, grantId: grant._id };
    const raced = await this.collection("subscription_grants")
      .where({
        accountId,
        templateId,
        status: "accept",
        authorizedMedicationId: binding.medicationId,
        reservedTaskId: binding.taskId,
      })
      .limit(1)
      .get();
    const racedReservation = raced.data?.[0];
    return racedReservation
      ? { reserved: true, grantId: racedReservation._id, idempotent: true }
      : false;
  }

  async finalizeSubscriptionGrant(accountId, grantId, now, binding = {}) {
    if (!grantId) return false;
    const where = { _id: grantId, accountId };
    if (binding.taskId) where.reservedTaskId = binding.taskId;
    const result = await this.collection("subscription_grants")
      .where(where)
      .update({
        data: {
          reservedTaskId: null,
          reservedMedicationId: null,
          reservedKind: null,
          updatedAt: now,
        },
      });
    return (result?.stats?.updated ?? result?.updated ?? 0) === 1;
  }

  async releaseSubscriptionGrant(accountId, grantId, now, binding = {}) {
    if (!grantId) return false;
    const where = { _id: grantId, accountId };
    if (binding.taskId) where.reservedTaskId = binding.taskId;
    const result = await this.collection("subscription_grants")
      .where(where)
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
    return (result?.stats?.updated ?? result?.updated ?? 0) === 1;
  }

  async markAttempt(task, now) {
    const result = await this.collection("reminder_tasks")
      .where({ _id: task._id, status: "sending" })
      .update({
        data: { lastAttemptAt: now, attemptCount: this.command.inc(1) },
      });
    if ((result?.stats?.updated ?? result?.updated ?? 0) !== 1)
      throw new Error("ATTEMPT_CLAIM_LOST");
  }

  async markSent(task, now, response = {}) {
    await this.collection("reminder_tasks")
      .doc(task._id)
      .update({
        data: {
          status: "sent",
          sentAt: now,
          leaseUntil: null,
          attempts: this.command.inc(1),
          deliveryResponse: {
            accepted: response.accepted === true,
            errCode: safeCode(response.errCode),
          },
          updatedAt: now,
        },
      });
  }

  async markDeliveryUnknown(task, now, code = "DELIVERY_OUTCOME_UNKNOWN") {
    await this.collection("reminder_tasks")
      .doc(task._id)
      .update({
        data: {
          status: "delivery_unknown",
          failureCode: safeCode(code),
          leaseUntil: null,
          updatedAt: now,
        },
      });
  }

  async markWaitingConfiguration(task, now, reason) {
    await this.collection("reminder_tasks")
      .doc(task._id)
      .update({
        data: {
          status: "pending",
          failureCode: safeCode(reason),
          leaseUntil: null,
          nextAttemptAt: null,
          updatedAt: now,
        },
      });
  }

  async markCanceled(task, now, reason) {
    await this.collection("reminder_tasks")
      .doc(task._id)
      .update({
        data: {
          status: "canceled",
          cancelReason: reason,
          leaseUntil: null,
          updatedAt: now,
        },
      });
  }

  async markPermanentFailure(task, now, code) {
    await this.collection("reminder_tasks")
      .doc(task._id)
      .update({
        data: {
          status: "failed_permanent",
          failureCode: code,
          failedAt: now,
          leaseUntil: null,
          attempts: this.command.inc(1),
          updatedAt: now,
        },
      });
  }

  async markRetry(task, now, nextAttemptAt, code, exhausted) {
    await this.collection("reminder_tasks")
      .doc(task._id)
      .update({
        data: {
          status: exhausted ? "failed_permanent" : "pending",
          failureCode: code,
          failedAt: exhausted ? now : null,
          nextAttemptAt,
          leaseUntil: null,
          attempts: this.command.inc(1),
          updatedAt: now,
        },
      });
  }
}

function safeCode(value) {
  const text = String(value ?? "");
  return /^[A-Za-z0-9_-]{0,32}$/.test(text) ? text || null : "UNSAFE";
}

function updatedCount(result) {
  return result?.stats?.updated ?? result?.updated ?? 0;
}

function isNotFound(error) {
  const code = String(error?.errCode ?? error?.code ?? "");
  const message = String(error?.errMsg ?? error?.message ?? "");
  return (
    code.includes("-502005") ||
    code.includes("NOT_FOUND") ||
    /not exist|not found/i.test(message)
  );
}

module.exports = { ReminderStore };
