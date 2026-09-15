import { RUNTIME_CONFIG } from "../config/runtime";
import type { DataService, ReminderKind } from "./data-service";

export interface SubscriptionResult {
  configured: boolean;
  accepted: string[];
  rejected: string[];
}

export const templateIdForKind = (kind: ReminderKind): string => {
  if (kind === "dose") return RUNTIME_CONFIG.subscriptionTemplates.dose;
  if (kind === "expiry") return RUNTIME_CONFIG.subscriptionTemplates.expiry;
  return RUNTIME_CONFIG.subscriptionTemplates.lowStock;
};

export const requestSubscriptionForKind = async (
  kind: ReminderKind,
  service: DataService,
  medicationId?: string,
): Promise<SubscriptionResult> => {
  const templateId = templateIdForKind(kind);
  if (!templateId) return { configured: false, accepted: [], rejected: [] };
  const result = await wx.requestSubscribeMessage({ tmplIds: [templateId] });
  const accepted = result[templateId] === "accept";
  await service.recordSubscriptionGrant(
    kind,
    templateId,
    accepted ? "accept" : "reject",
    medicationId,
  );
  return {
    configured: true,
    accepted: accepted ? [templateId] : [],
    rejected: accepted ? [] : [templateId],
  };
};

export const requestLowFrequencySubscriptions =
  async (): Promise<SubscriptionResult> => {
    const templateIds = [
      RUNTIME_CONFIG.subscriptionTemplates.expiry,
      RUNTIME_CONFIG.subscriptionTemplates.lowStock,
    ].filter(Boolean);
    if (!templateIds.length)
      return { configured: false, accepted: [], rejected: [] };

    const result = await wx.requestSubscribeMessage({ tmplIds: templateIds });
    const accepted = templateIds.filter((id) => result[id] === "accept");
    const rejected = templateIds.filter((id) => result[id] !== "accept");
    return { configured: true, accepted, rejected };
  };
