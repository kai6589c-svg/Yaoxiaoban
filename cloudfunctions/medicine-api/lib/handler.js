"use strict";

const crypto = require("node:crypto");
const { parseCompatAction } = require("./compat-schemas");
const {
  ACTIONS,
  COMPAT_ACTIONS,
  MUTATING_ACTIONS,
  PRIVACY_VERSION,
} = require("./constants");
const { fail, isAppError } = require("./errors");
const { sha256, stableStringify } = require("./hash");
const { parseAction } = require("./schemas");

const MAX_EVENT_BYTES = 64 * 1024;
const PHOTO_ACTIONS = new Set([
  "saveMedicationFast",
  "uploadMedicationPhoto",
  "putMedicationPhotoChunk",
  "finishMedicationPhotoUpload",
  "completeMedicationPhotoUpload",
  "processMedicationPhoto",
  "prepareMedicationPhoto",
  "commitMedicationPhoto",
  "removeMedicationPhoto",
  "discardMedicationPhoto",
  "getMedicationPhotoStatus",
]);
const PHOTO_ERROR_CODES = new Set([
  "FORBIDDEN",
  "PAYLOAD_TOO_LARGE",
  "INVALID_MEDIA",
  "INVALID_MEDIA_STATE",
  "MEDIA_NOT_FOUND",
  "MEDIA_UPLOAD_EXPIRED",
  "MEDIA_UNAVAILABLE",
]);

function createApiHandler({
  store,
  service,
  compatibilityService,
  getIdentity,
  clock = () => new Date(),
  logger = console,
}) {
  return async function handle(event) {
    const traceId = crypto.randomBytes(8).toString("hex");
    let action = null;
    let requestId = null;
    let compatibility = false;
    try {
      if (!event || typeof event !== "object" || Array.isArray(event)) {
        fail("INVALID_ARGUMENT", "请求格式不正确");
      }
      // Only the authenticated photo relay accepts a bounded image payload.
      const eventLimit =
        event.action === "uploadMedicationPhoto"
          ? 3 * 1024 * 1024
          : MAX_EVENT_BYTES;
      if (Buffer.byteLength(JSON.stringify(event), "utf8") > eventLimit) {
        fail("PAYLOAD_TOO_LARGE", "请求内容过大");
      }
      // WeChat CloudBase appends platform metadata to every callFunction event.
      // Accept those transport-owned keys but never trust them for identity; OPENID
      // is still read exclusively from cloud.getWXContext() below.
      const allowedTopLevel = new Set([
        "action",
        "payload",
        "requestId",
        "privacyVersion",
        "tcbContext",
        "userInfo",
      ]);
      const extra = Object.keys(event).filter(
        (key) => !allowedTopLevel.has(key),
      );
      if (extra.length) {
        fail("INVALID_ARGUMENT", "请求包含不支持的字段", { fields: extra });
      }
      action = typeof event.action === "string" ? event.action : "";
      if (!ACTIONS.has(action)) fail("INVALID_ARGUMENT", "action 不受支持");
      if (
        action === "acceptPrivacy" &&
        event.payload?.version !== PRIVACY_VERSION
      ) {
        fail("INVALID_ARGUMENT", "隐私说明版本无效，请重新加载");
      }
      compatibility = COMPAT_ACTIONS.has(action);
      requestId = event.requestId ?? event.payload?.requestId ?? null;
      if (PHOTO_ACTIONS.has(action)) {
        logger.info?.("MEDICINE_API_PHOTO_STAGE", {
          action,
          stage: "handler_received",
          traceId,
          requestId,
          eventBytes: Buffer.byteLength(JSON.stringify(event), "utf8"),
        });
      }
      const payload = compatibility
        ? parseCompatAction(action, event.payload ?? {})
        : parseAction(action, event.payload ?? {});
      const identity = await getIdentity();
      const openid = identity?.OPENID;
      if (typeof openid !== "string" || !openid) {
        fail("UNAUTHENTICATED", "无法确认微信身份");
      }
      const now = clock().toISOString();
      if (MUTATING_ACTIONS.has(action) && !requestId && compatibility) {
        requestId = compatibilityRequestId(openid, action, payload, now);
      }

      if (action === "account.delete" || action === "deleteAccount") {
        const validatedRequestId = requireRequestId(requestId);
        const existing = await store.findDeletionTombstone(
          openid,
          validatedRequestId,
        );
        if (existing?.state === "completed") {
          return success(
            action === "deleteAccount"
              ? null
              : { deleted: true, completedAt: existing.completedAt },
            validatedRequestId,
          );
        }
        const accountId = store.accountIdFor(openid);
        const tombstone =
          existing ??
          (await store.createDeletionTombstone(
            openid,
            validatedRequestId,
            accountId,
            now,
          ));
        await store.markAccountDeleting?.(accountId, now);
        const completed =
          typeof store.processAccountDeletion === "function"
            ? await store.processAccountDeletion(accountId)
            : (await store.deleteAccountData(accountId), true);
        if (!completed) {
          await store.markDeletionPending?.(
            tombstone._id,
            clock().toISOString(),
            "PHOTO_CLEANUP_PENDING",
          );
          return success(
            action === "deleteAccount"
              ? { status: "processing" }
              : { deleted: false, status: "processing" },
            validatedRequestId,
          );
        }
        const completedAt = clock().toISOString();
        await store.finishDeletionTombstone(tombstone._id, completedAt);
        return success(
          action === "deleteAccount" ? null : { deleted: true, completedAt },
          validatedRequestId,
        );
      }

      const account = await store.ensureAccount(openid, now);
      if (
        requiresPrivacyConsent(action) &&
        typeof store.assertPrivacyAccepted === "function"
      ) {
        await store.assertPrivacyAccepted(account._id, PRIVACY_VERSION);
      }
      const target = compatibility ? compatibilityService : service;
      if (!target) throw new Error("COMPATIBILITY_SERVICE_NOT_CONFIGURED");
      if (!MUTATING_ACTIONS.has(action)) {
        const data = await target.execute(action, payload, {
          accountId: account._id,
          requestId: null,
          traceId,
        });
        return success(data, requestId);
      }

      const validatedRequestId = requireRequestId(requestId);
      const requestHash = sha256(stableStringify({ action, payload }));
      const claim = await store.claimIdempotency({
        accountId: account._id,
        action,
        requestId: validatedRequestId,
        requestHash,
        now,
      });
      if (claim.state === "replay") return claim.response;

      let response;
      try {
        const data = await target.execute(action, payload, {
          accountId: account._id,
          requestId: validatedRequestId,
          traceId,
        });
        response = success(data, validatedRequestId);
      } catch (error) {
        response = errorResponse(
          error,
          validatedRequestId,
          traceId,
          compatibility,
          action,
        );
        logError(logger, error, { action, traceId });
      }
      await store.completeIdempotency(
        claim.id,
        response,
        clock().toISOString(),
      );
      return response;
    } catch (error) {
      logError(logger, error, { action, traceId });
      return errorResponse(error, requestId, traceId, compatibility, action);
    }
  };
}

function requiresPrivacyConsent(action) {
  return !new Set([
    "bootstrap",
    "acceptPrivacy",
    "account.delete",
    "deleteAccount",
  ]).has(action);
}

function requireRequestId(value) {
  const { requestId } = require("./validation");
  return requestId(value);
}

function compatibilityRequestId(openid, action, payload, now) {
  const bucket = Math.floor(Date.parse(now) / (5 * 60 * 1000)).toString(36);
  const digest = sha256(
    stableStringify({ owner: sha256(openid), action, payload }),
  ).slice(0, 32);
  return `compat:${digest}:${bucket}`;
}

function success(data, requestId) {
  return { ok: true, data, ...(requestId ? { requestId } : {}) };
}

function errorResponse(
  error,
  requestId,
  traceId,
  compatibility = false,
  action = null,
) {
  if (isAppError(error)) {
    return {
      ok: false,
      error: {
        code: compatibility
          ? compatibilityErrorCode(error.code, action)
          : error.code,
        message: error.message,
        traceId,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
      ...(requestId ? { requestId } : {}),
    };
  }
  return {
    ok: false,
    error: {
      code: compatibility ? "UNKNOWN" : "INTERNAL",
      message: "服务暂时不可用，请稍后重试",
      traceId,
    },
    ...(requestId ? { requestId } : {}),
  };
}

function compatibilityErrorCode(code, action = null) {
  // Photo callers need the protocol error to distinguish a transient storage
  // failure from a file that must be selected again. Keep legacy mappings for
  // the other compatibility actions.
  if (PHOTO_ACTIONS.has(action) && PHOTO_ERROR_CODES.has(code)) return code;
  if (code === "NOT_FOUND") return "NOT_FOUND";
  if (code === "UNAUTHENTICATED" || code === "ACCOUNT_UNAVAILABLE")
    return "UNAUTHORIZED";
  if (
    code === "VERSION_CONFLICT" ||
    code === "CONFLICT" ||
    code.startsWith("IDEMPOTENCY") ||
    code === "OPERATION_IN_PROGRESS"
  ) {
    return "CONFLICT";
  }
  if (code === "INTERNAL") return "UNKNOWN";
  return "VALIDATION";
}

function logError(logger, error, context) {
  const code = isAppError(error) ? error.code : "INTERNAL";
  const level = isAppError(error) ? "warn" : "error";
  const sink =
    typeof logger[level] === "function"
      ? logger[level].bind(logger)
      : logger.log.bind(logger);
  // Never log request payloads, OPENID, medicine names, doses, notes, or photos.
  sink("MEDICINE_API_EVENT", {
    code,
    action: context.action,
    traceId: context.traceId,
  });
}

module.exports = {
  compatibilityErrorCode,
  compatibilityRequestId,
  createApiHandler,
  errorResponse,
  success,
};
