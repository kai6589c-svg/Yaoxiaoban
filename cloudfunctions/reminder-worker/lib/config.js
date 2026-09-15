"use strict";

function loadConfig(env = process.env) {
  const environmentId = clean(env.REMINDER_ENV_ID);
  const enabled = clean(env.REMINDER_SEND_ENABLED).toLowerCase() === "true";
  const doseTemplateId = clean(env.DOSE_TEMPLATE_ID);
  const doseMap = parseMap(
    env.DOSE_TEMPLATE_DATA_MAP ||
      JSON.stringify({
        expiryDate: "time3",
        doseTime: "time6",
        dose: "short_thing7",
        medicineName: "short_thing4",
        productName: "thing1",
      }),
  );
  const expiryTemplateId = clean(env.EXPIRY_TEMPLATE_ID);
  const shortageTemplateId = clean(env.SHORTAGE_TEMPLATE_ID);
  const expiryMap = parseMap(env.EXPIRY_TEMPLATE_DATA_MAP);
  const shortageMap = parseMap(env.SHORTAGE_TEMPLATE_DATA_MAP);
  const page = clean(env.REMINDER_PAGE) || "pages/today/index";
  const miniprogramState = ["developer", "trial", "formal"].includes(
    env.MINIPROGRAM_STATE,
  )
    ? env.MINIPROGRAM_STATE
    : "developer";
  return {
    enabled: Boolean(enabled && environmentId),
    environmentId,
    page,
    miniprogramState,
    templates: {
      // The known dose template is detailed and one-time. Expiry and
      // shortage are intentionally disabled until their approved template
      // type and field map are supplied; they are never guessed as long-term.
      dose: templateConfig(doseTemplateId, doseMap, "oneTime", "detailed"),
      expiry: templateConfig(
        expiryTemplateId,
        expiryMap,
        env.EXPIRY_TEMPLATE_DELIVERY_TYPE,
        env.EXPIRY_TEMPLATE_PRIVACY,
      ),
      shortage: templateConfig(
        shortageTemplateId,
        shortageMap,
        env.SHORTAGE_TEMPLATE_DELIVERY_TYPE,
        env.SHORTAGE_TEMPLATE_PRIVACY,
      ),
    },
  };
}

function templateConfig(templateId, map, deliveryType, privacy = "generic") {
  const validDeliveryType = ["oneTime", "longTerm"].includes(deliveryType);
  const validPrivacy = ["generic", "detailed"].includes(privacy);
  return {
    enabled: Boolean(templateId && map && validDeliveryType && validPrivacy),
    templateId,
    map,
    deliveryType: validDeliveryType ? deliveryType : null,
    privacy: validPrivacy ? privacy : null,
  };
}

function parseMap(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    const allowed = [
      "medicineName",
      "date",
      "message",
      "expiryDate",
      "doseTime",
      "dose",
      "productName",
    ];
    const result = {};
    for (const semantic of allowed) {
      const target = parsed[semantic];
      if (target === undefined) continue;
      if (
        typeof target !== "string" ||
        !/^(thing|short_thing|date|time|character_string|number|phrase)\d{1,3}$/.test(
          target,
        )
      )
        return null;
      result[semantic] = target;
    }
    return Object.keys(result).length >= 2 ? result : null;
  } catch (_) {
    return null;
  }
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { loadConfig, parseMap };
