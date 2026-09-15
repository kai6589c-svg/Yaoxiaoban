import { loadDeployment } from "./deployment-config.mjs";
const config = await loadDeployment();
if (config.deploymentMode !== "production")
  throw new Error(
    "Release blocked: configure production in deployment.local.json first. Use npm run check for demo/CI verification.",
  );
