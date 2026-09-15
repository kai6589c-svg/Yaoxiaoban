"use strict";

class MaintenanceWorker {
  constructor({ store, service, clock = () => new Date(), logger = console }) {
    this.store = store;
    this.service = service;
    this.clock = clock;
    this.logger = logger;
  }

  async run({ limit = 50, budgetMs = 45_000 } = {}) {
    const budget = Math.max(1, Math.min(limit, 50));
    const startedAt = this.clock().getTime();
    const startedAtIso = new Date(startedAt).toISOString();
    const leaseId = `maintenance:${startedAt}:${Math.random().toString(36).slice(2, 10)}`;
    const leaseUntil = new Date(startedAt + budgetMs + 5_000).toISOString();
    if (typeof this.store.claimMaintenanceLease === "function") {
      const claimed = await this.store.claimMaintenanceLease(
        startedAtIso,
        leaseUntil,
        leaseId,
      );
      if (!claimed) return { accounts: 0, locked: true };
    }
    const checkpoint = (await this.store.getMaintenanceCheckpoint?.()) ?? {
      cursor: null,
      deletingCursor: null,
      deletingSweepComplete: false,
      round: 1,
    };
    let cursor = checkpoint.cursor ?? null;
    // A completed sweep is a boundary, not a permanent skip flag.  Starting
    // each invocation from the beginning lets accounts that entered deleting
    // after the previous sweep be observed without requiring a synthetic
    // checkpoint write from the account-delete request.
    let deletingCursor = checkpoint.deletingSweepComplete
      ? null
      : (checkpoint.deletingCursor ?? null);
    let deletingSweepComplete = false;
    const summary = {
      accounts: 0,
      mediaScanned: 0,
      remindersRefreshed: 0,
      deletionsCompleted: 0,
      failures: 0,
    };

    const processAccount = async (account) => {
      summary.accounts += 1;
      if (account.status === "deleting") {
        const deleted = await this.store.processAccountDeletion(account._id);
        if (!deleted)
          throw Object.assign(new Error("deletion is not complete"), {
            code: "DELETION_NOT_COMPLETE",
          });
        if (deleted) summary.deletionsCompleted += 1;
        return;
      }
      const context = {
        accountId: account._id,
        requestId: `maintenance:${account._id}:${this.clock().toISOString()}`,
        traceId: "maintenance",
      };
      const media = await this.store.listAllOwned("media", account._id);
      summary.mediaScanned += media.length;
      await this.service.cleanupPendingMedia(context);
      const medications = await this.store.listAllOwned(
        "medications",
        account._id,
        { status: "active" },
      );
      for (const medication of medications) {
        await this.service.refreshReminders(medication._id, context);
        summary.remindersRefreshed += 1;
      }
    };

    const processPage = async (items, startCursor) => {
      let completed = 0;
      let consumed = 0;
      let lastId = null;
      let blocked = false;
      let hadFailure = false;
      let firstFailureIndex = -1;
      for (const account of items) {
        if (this.clock().getTime() - startedAt >= budgetMs) break;
        try {
          await processAccount(account);
          completed += 1;
        } catch (error) {
          summary.failures += 1;
          hadFailure = true;
          if (firstFailureIndex < 0) firstFailureIndex = consumed;
          try {
            // The failure record is part of the cursor transaction boundary:
            // if it cannot be persisted, do not advance beyond this account.
            await this.store.recordMaintenanceFailure?.(
              account._id,
              error?.code ?? "UNKNOWN",
              startedAtIso,
            );
          } catch (recordError) {
            blocked = true;
            this.logger.error?.("MAINTENANCE_FAILURE_RECORD_FAILED", {
              code: recordError?.code ?? "UNKNOWN",
            });
            break;
          }
          this.logger.warn?.("MAINTENANCE_ACCOUNT_FAILED", {
            code: error?.code ?? "UNKNOWN",
          });
        }
        consumed += 1;
        lastId = account._id;
      }
      return {
        completed,
        consumed,
        lastId,
        blocked,
        hadFailure,
        // When the store has no durable retry queue adapter, retain the
        // cursor before the first failed account. Later accounts are still
        // processed in this invocation, while the failed account remains
        // reachable on the next one. Production CloudStore supplies a retry
        // adapter and can safely advance after persisting the job.
        safeCursor:
          hadFailure &&
          typeof this.store.listMaintenanceRetryJobs !== "function"
            ? firstFailureIndex > 0
              ? items[firstFailureIndex - 1]._id
              : startCursor
            : lastId,
      };
    };

    let remaining = budget;
    let deletionBlocked = false;
    if (
      typeof this.store.listDeletingAccountsForMaintenancePage === "function"
    ) {
      const deletingBudget = Math.min(10, remaining);
      const page = await this.store.listDeletingAccountsForMaintenancePage(
        deletingCursor,
        deletingBudget,
      );
      const items = page.items ?? [];
      const pageResult = await processPage(items, deletingCursor);
      remaining -= pageResult.consumed;
      if (pageResult.safeCursor) deletingCursor = pageResult.safeCursor;
      deletionBlocked = pageResult.blocked;
      if (
        !deletionBlocked &&
        !pageResult.hadFailure &&
        pageResult.consumed === items.length &&
        !page.nextCursor
      ) {
        deletingCursor = null;
        deletingSweepComplete = true;
      }
    } else if (
      typeof this.store.listDeletingAccountsForMaintenancePage !== "function"
    ) {
      deletingSweepComplete = true;
    }

    if (
      remaining > 0 &&
      !deletionBlocked &&
      typeof this.store.listMaintenanceRetryJobs === "function" &&
      typeof this.store.getAccountForMaintenance === "function"
    ) {
      const retryBudget = Math.min(10, remaining);
      const jobs = await this.store.listMaintenanceRetryJobs(
        this.clock().toISOString(),
        retryBudget,
      );
      for (const job of jobs) {
        if (remaining <= 0) break;
        const account = await this.store.getAccountForMaintenance(
          job.accountId,
        );
        if (!account) {
          await this.store.markMaintenanceRetryJob?.(
            job._id,
            "completed",
            this.clock().toISOString(),
          );
          remaining -= 1;
          continue;
        }
        try {
          await processAccount(account);
          await this.store.markMaintenanceRetryJob?.(
            job._id,
            "completed",
            this.clock().toISOString(),
          );
        } catch (error) {
          summary.failures += 1;
          await this.store.recordMaintenanceFailure?.(
            account._id,
            error?.code ?? "UNKNOWN",
            this.clock().toISOString(),
          );
        }
        remaining -= 1;
      }
    }

    if (remaining > 0 && deletingSweepComplete && !deletionBlocked) {
      const page =
        typeof this.store.listAccountsForMaintenancePage === "function"
          ? await this.store.listAccountsForMaintenancePage(cursor, remaining, {
              status: "active",
            })
          : { items: await this.store.listAccountsForMaintenance() };
      const items = page.items ?? [];
      const pageResult = await processPage(items, cursor);
      if (pageResult.safeCursor) cursor = pageResult.safeCursor;
      if (
        !pageResult.blocked &&
        !pageResult.hadFailure &&
        pageResult.consumed === items.length &&
        !page.nextCursor
      )
        cursor = null;
    }

    // A failed account must not advance the round boundary merely because
    // the current cursor happens to be null.  The failure record/retry job is
    // the durable hand-off; until the invocation is failure-free, this is not
    // a completed sweep.
    const finished =
      cursor === null && deletingSweepComplete && summary.failures === 0;
    const checkpointSaved = await this.store.saveMaintenanceCheckpoint?.({
      cursor,
      deletingCursor,
      deletingSweepComplete,
      round: finished ? (checkpoint.round ?? 1) + 1 : (checkpoint.round ?? 1),
      leaseId,
      leaseUntil: null,
      releaseLease: true,
    });
    if (checkpointSaved === false) {
      summary.checkpointSaveFailed = true;
      return summary;
    }
    return summary;
  }
}

module.exports = { MaintenanceWorker };
