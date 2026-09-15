import { RUNTIME_CONFIG } from "../config/runtime";
import type { AccountSettings, AppState, Profile } from "./models";

export const DEFAULT_PROFILE_COLOR = "#4E8D70";

export const createDefaultSettings = (): AccountSettings => ({
  privacyAcceptedVersion: null,
  privacyAcceptedAt: null,
  notificationPrivacy: "generic",
  expiryLeadDays: RUNTIME_CONFIG.defaultExpiryLeadDays,
  lowStockLeadDays: RUNTIME_CONFIG.defaultLowStockLeadDays,
  timezone: "Asia/Shanghai",
  lowFrequencyReminders: false,
});

export const createDefaultProfile = (
  nowIso: string,
  id = "profile-self",
): Profile => ({
  id,
  name: "我",
  relation: "self",
  color: DEFAULT_PROFILE_COLOR,
  archivedAt: null,
  createdAt: nowIso,
  updatedAt: nowIso,
  version: 1,
});

export const createEmptyState = (nowIso: string): AppState => ({
  schemaVersion: 1,
  settings: createDefaultSettings(),
  profiles: [],
  medications: [],
  plans: [],
  snapshots: [],
  intakeLogs: [],
  calendarExports: [],
  updatedAt: nowIso,
});
