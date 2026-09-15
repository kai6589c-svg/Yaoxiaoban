import {
  createEmptyState,
  createDefaultProfile,
} from "../miniprogram/core/defaults";
import { localDateTimeToIso } from "../miniprogram/core/dates";
import type {
  AppState,
  IntakeLog,
  InventorySnapshot,
  Medication,
  PlanVersion,
} from "../miniprogram/core/models";

export const medication = (
  overrides: Partial<Medication> = {},
): Medication => ({
  id: "med-1",
  profileId: "profile-1",
  name: "测试药",
  specification: "10mg/片",
  unit: "片",
  mode: "scheduled",
  expiryPrecision: "day",
  expiryValue: "2027-08-31",
  openedDate: null,
  afterOpenDays: null,
  note: "",
  photo: null,
  archivedAt: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  version: 1,
  ...overrides,
});

export const plan = (overrides: Partial<PlanVersion> = {}): PlanVersion => ({
  id: "plan-1",
  medicationId: "med-1",
  scheduleType: "daily",
  startDate: "2026-08-01",
  endDate: null,
  weekdays: [],
  times: ["08:00"],
  doseMilli: 1000,
  effectiveFrom: "2026-07-31T16:00:00.000Z",
  effectiveTo: null,
  createdAt: "2026-07-31T16:00:00.000Z",
  version: 1,
  ...overrides,
});

export const snapshot = (
  overrides: Partial<InventorySnapshot> = {},
): InventorySnapshot => ({
  id: "snapshot-1",
  medicationId: "med-1",
  quantityMilli: 20_000,
  recordedAt: localDateTimeToIso("2026-08-19", "09:00"),
  note: "测试盘点",
  createdAt: localDateTimeToIso("2026-08-19", "09:00"),
  version: 1,
  ...overrides,
});

export const log = (overrides: Partial<IntakeLog> = {}): IntakeLog => ({
  id: "log-1",
  medicationId: "med-1",
  planId: "plan-1",
  occurrenceKey: "plan-1|2026-08-21|08:00",
  status: "skipped",
  quantityMilli: 1000,
  scheduledAt: localDateTimeToIso("2026-08-21", "08:00"),
  occurredAt: localDateTimeToIso("2026-08-21", "09:00"),
  requestId: "request-1",
  voidedAt: null,
  createdAt: localDateTimeToIso("2026-08-21", "09:00"),
  version: 1,
  ...overrides,
});

export const appState = (): AppState => {
  const state = createEmptyState("2026-08-19T00:00:00.000Z");
  state.settings.privacyAcceptedVersion = "test";
  state.profiles = [
    createDefaultProfile("2026-08-01T00:00:00.000Z", "profile-1"),
  ];
  state.medications = [medication()];
  state.plans = [plan()];
  state.snapshots = [snapshot()];
  return state;
};
