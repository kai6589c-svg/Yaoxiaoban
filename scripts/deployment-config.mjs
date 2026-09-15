import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
export const root = fileURLToPath(new URL("../", import.meta.url));
export function validateDeployment(input) {
  if (!input || typeof input !== "object")
    throw new Error("Deployment configuration must be an object");
  const { deploymentMode, appId, cloudEnvId, subscriptionTemplates } = input;
  if (!["demo", "production"].includes(deploymentMode))
    throw new Error("Invalid deploymentMode");
  if (
    typeof appId !== "string" ||
    !(appId === "touristappid" || /^wx[0-9a-f]{16}$/.test(appId))
  )
    throw new Error("Invalid appId");
  if (
    typeof cloudEnvId !== "string" ||
    (cloudEnvId && !/^[a-zA-Z0-9-]+$/.test(cloudEnvId))
  )
    throw new Error("Invalid cloudEnvId");
  if (deploymentMode === "demo" && cloudEnvId !== "")
    throw new Error("Demo must not connect to a cloud environment");
  if (
    deploymentMode === "production" &&
    (appId === "touristappid" ||
      appId === "wx0000000000000000" ||
      !cloudEnvId ||
      cloudEnvId === "your-cloudbase-env")
  )
    throw new Error(
      "Production requires your real AppID and CloudBase environment",
    );
  const templates = {};
  for (const key of ["dose", "expiry", "lowStock"]) {
    const value = subscriptionTemplates?.[key] ?? "";
    if (typeof value !== "string" || (value && !/^[a-zA-Z0-9_-]+$/.test(value)))
      throw new Error(`Invalid template: ${key}`);
    templates[key] = value;
  }
  return {
    deploymentMode,
    appId,
    cloudEnvId,
    subscriptionTemplates: templates,
  };
}
export async function loadDeployment() {
  let text;
  try {
    text = await readFile(
      new URL("../deployment.local.json", import.meta.url),
      "utf8",
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    text = await readFile(
      new URL("../deployment.example.json", import.meta.url),
      "utf8",
    );
  }
  return validateDeployment(JSON.parse(text));
}
