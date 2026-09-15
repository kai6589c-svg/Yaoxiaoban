/**
 * Product-state vocabulary shared by the mini-program domain, services, and
 * presentation layers. Keeping the wire values here prevents pages from
 * inventing near-duplicate state strings.
 */
export const DATE_PRECISION = {
  DAY: "day",
  MONTH: "month",
} as const;

export type DatePrecision =
  (typeof DATE_PRECISION)[keyof typeof DATE_PRECISION];

export const MEDICATION_MODE = {
  EXPIRY_ONLY: "expiry_only",
  SCHEDULED: "scheduled",
  AS_NEEDED: "as_needed",
} as const;

export type MedicationMode =
  (typeof MEDICATION_MODE)[keyof typeof MEDICATION_MODE];

export const SCHEDULE_TYPE = {
  DAILY: "daily",
  WEEKLY: "weekly",
  AS_NEEDED: "as_needed",
} as const;

export type ScheduleType = (typeof SCHEDULE_TYPE)[keyof typeof SCHEDULE_TYPE];

export const INTAKE_STATUS = {
  TAKEN: "taken",
  SKIPPED: "skipped",
  EXTRA: "extra",
} as const;

export type IntakeStatus = (typeof INTAKE_STATUS)[keyof typeof INTAKE_STATUS];

export const CALENDAR_SYNC_STATUS = {
  NOT_ADDED: "not-added",
  PARTIAL: "partial",
  SYNCED: "synced",
  STALE: "stale",
} as const;

export type CalendarSyncStatus =
  (typeof CALENDAR_SYNC_STATUS)[keyof typeof CALENDAR_SYNC_STATUS];

export const FORM_STATE = {
  CLEAN: "clean",
  DIRTY: "dirty",
  SAVING: "saving",
  SAVED: "saved",
  ERROR: "error",
} as const;

export type FormState = (typeof FORM_STATE)[keyof typeof FORM_STATE];

export const RISK_TYPE = {
  EXPIRED: "expired",
  EXPIRING: "expiring",
  LOW_STOCK: "low-stock",
  UNKNOWN_STOCK: "unknown-stock",
  CALENDAR_STALE: "calendar-stale",
} as const;

export type RiskType = (typeof RISK_TYPE)[keyof typeof RISK_TYPE];
