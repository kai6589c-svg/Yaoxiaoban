export const RUNTIME_CONFIG = {
  appName: "药小伴",
  // Production builds must use the CloudBase environment bound to the official AppID.
  // Local storage is reserved for explicit demo builds only.
  deploymentMode: "demo" as "demo" | "production",
  cloudEnvId: "",
  privacyVersion: "2026-09-07",
  timezone: "Asia/Shanghai",
  timezoneOffsetMinutes: 480,
  calendarHorizonDays: 90,
  defaultExpiryLeadDays: 30,
  defaultLowStockLeadDays: 7,
  subscriptionTemplates: {
    dose: "",
    expiry: "",
    lowStock: "",
  },
} as const;

export const isCloudConfigured = (): boolean =>
  RUNTIME_CONFIG.cloudEnvId.trim().length > 0;

export const isDemoDeployment = (): boolean =>
  RUNTIME_CONFIG.deploymentMode === "demo";
